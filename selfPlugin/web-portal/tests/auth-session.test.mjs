import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { identityKey } from '../dist/identity.js';
import { SessionStore } from '../dist/sessions.js';
import { createLoginController } from '../dist/login-controller.js';

const identity = (userId = 'alice') => ({ tenantId: 'tenant-test', userId, token: 'fake-test-token', expiresAt: null });

test('revoking an identity removes all of its sessions but preserves other identities', () => {
  const revoked = [];
  const sessions = new SessionStore({ onRevoke: session => revoked.push(session) });
  const a1 = sessions.create(identity());
  const a2 = sessions.create(identity());
  const b = sessions.create(identity('bob'));
  sessions.revokeKey(a1.session.key);
  assert.equal(sessions.get(a1.id), undefined);
  assert.equal(sessions.get(a2.id), undefined);
  assert.equal(sessions.hasKey(a1.session.key), false);
  assert.equal(sessions.get(b.id), b.session);
  assert.deepEqual(revoked, [a1.session, a2.session]);
  sessions.revokeKey(a1.session.key);
  assert.equal(revoked.length, 2);
  sessions.close();
});

test('opaque sessions isolate users, expire on a timer, revoke and enforce capacity', async () => {
  const revoked = [];
  const sessions = new SessionStore({ ttlMs: 1000, maxSessions: 2, onRevoke: session => revoked.push(session) });
  const a = sessions.create(identity());
  const b = sessions.create(identity('bob'));
  assert.match(a.id, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.session.key, b.session.key);
  assert.equal(sessions.get(a.id).identity.userId, 'alice');
  assert.equal(sessions.get('forged'), undefined);
  assert.equal(sessions.hasKey(a.session.key), true);
  assert.throws(() => sessions.create(identity('charlie')));
  sessions.revoke(a.id);
  assert.equal(sessions.get(a.id), undefined);
  assert.equal(sessions.hasKey(a.session.key), false);
  const c = sessions.create({ ...identity('charlie'), expiresAt: new Date(Date.now() + 40).toISOString() });
  await delay(80);
  assert.equal(sessions.get(c.id), undefined);
  assert.ok(revoked.includes(c.session));
  sessions.close();
  assert.equal(sessions.get(b.id), undefined);
  assert.equal(revoked.length, 3);
  assert.notEqual(identityKey({ ...identity('b:c'), tenantId: 'a' }), identityKey({ ...identity('c'), tenantId: 'a:b' }));
});

async function fixture(t, options = {}) {
  const ensured = [];
  const sessions = new SessionStore({ ttlMs: 1000 });
  const controller = createLoginController({
    publicOrigin: 'http://127.0.0.1:9911', sessions,
    backend: { login: async (account, password) => password === 'fake-correct' ? identity(account) : null },
    manager: { ensure: async value => { ensured.push(value); return { origin: 'http://127.0.0.1:9999', cookie: 'internal=fake' }; }, stop: async () => {}, close: async () => {} },
    ...options,
  });
  const server = createServer((req, res) => void controller.handle(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { controller.close(); sessions.close(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const address = server.address();
  const request = (path, init = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, init);
  const login = (account, password = 'fake-correct', extra = {}) => request('/portal/login', { method: 'POST', headers: { Origin: 'http://127.0.0.1:9911', 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password }), ...extra });
  return { request, login, sessions, controller, ensured };
}

test('wrong login never creates runtime or cookie; two successful accounts get distinct sessions', async t => {
  const f = await fixture(t);
  const invalid = await f.login('alice', 'fake-wrong');
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get('set-cookie'), null);
  assert.deepEqual(f.ensured, []);
  const a = await f.login('alice');
  const b = await f.login('bob');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const cookieA = a.headers.get('set-cookie');
  const cookieB = b.headers.get('set-cookie');
  assert.match(cookieA, /HttpOnly; SameSite=Strict/);
  assert.notEqual(cookieA, cookieB);
  assert.equal(f.ensured.length, 2);
  const status = await f.request('/portal/session', { headers: { Cookie: cookieA.split(';')[0] } });
  const body = await status.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.token, undefined);
  assert.equal(body.identity, undefined);
  const logout = await f.request('/portal/logout', { method: 'POST', headers: { Origin: 'http://127.0.0.1:9911', Cookie: cookieA.split(';')[0] } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/portal/session', { headers: { Cookie: cookieA.split(';')[0] } })).status, 401);
  assert.equal((await f.request('/portal/session', { headers: { Cookie: cookieB.split(';')[0] } })).status, 200);
});

test('mutations reject missing/cross-site Origin and browser identity claims', async t => {
  const f = await fixture(t);
  assert.equal((await f.login('alice', 'fake-correct', { headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await f.login('alice', 'fake-correct', { headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await f.login('alice', 'fake-correct', { body: JSON.stringify({ account: 'alice', password: 'fake-correct', userId: 'admin' }) })).status, 400);
  assert.deepEqual(f.ensured, []);
});

test('service errors and timeout are bounded and do not leak backend messages', async t => {
  const f = await fixture(t, { loginTimeoutMs: 20, backend: { login: async () => new Promise(() => {}) } });
  const response = await f.login('alice');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(f.ensured, []);
});

test('runtime failure cannot issue a session and rate limits bound attempts', async t => {
  const f = await fixture(t, { maxAttempts: 1, manager: { ensure: async () => { throw new Error('fake-secret-error'); }, stop: async () => {}, close: async () => {} } });
  const response = await f.login('alice');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await f.login('alice')).status, 429);
});

test('https uses secure host-only cookies and nonlocal http config is rejected', async t => {
  const f = await fixture(t, { publicOrigin: 'https://portal.test' });
  const response = await f.login('alice', 'fake-correct', { headers: { Origin: 'https://portal.test', 'Content-Type': 'application/json' } });
  assert.match(response.headers.get('set-cookie'), /^__Host-dsh-portal=/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.throws(() => createLoginController({ publicOrigin: 'http://portal.test', sessions: f.sessions, backend: { login: async () => null }, manager: {} }));
});

test('runtime preparation completes before cookie issuance; same-user relogin revokes old session', async t => {
  let finish;
  let started;
  const activated = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { manager: { ensure: async () => { started(); await pending; return { origin: 'http://127.0.0.1:9999', cookie: 'internal=fake' }; }, stop: async () => {}, close: async () => {} } });
  let responded = false;
  const first = f.login('alice').then(value => { responded = true; return value; });
  await activated;
  await delay(10);
  assert.equal(responded, false);
  finish();
  const response = await first;
  const oldCookie = response.headers.get('set-cookie').split(';')[0];
  const replacement = await f.login('alice', 'fake-correct', { headers: { Origin: 'http://127.0.0.1:9911', 'Content-Type': 'application/json', Cookie: oldCookie } });
  assert.equal(replacement.status, 200);
  const newCookie = replacement.headers.get('set-cookie').split(';')[0];
  assert.notEqual(newCookie, oldCookie);
  assert.equal((await f.request('/portal/session', { headers: { Cookie: oldCookie } })).status, 401);
  assert.equal((await f.request('/portal/session', { headers: { Cookie: newCookie } })).status, 200);
});

test('oversize input, invalid JSON and expired backend credentials cannot launch a runtime', async t => {
  const f = await fixture(t, { backend: { login: async () => ({ ...identity(), expiresAt: new Date(0).toISOString() }) } });
  assert.equal((await f.login('alice', 'fake-correct', { body: 'x'.repeat(5000) })).status, 400);
  assert.equal((await f.login('alice', 'fake-correct', { body: '{' })).status, 400);
  assert.equal((await f.login('alice')).status, 503);
  assert.deepEqual(f.ensured, []);
});

test('concurrent admission is bounded and backend expiry invalidates browser session', async t => {
  let release;
  let started;
  const activated = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { maxConcurrent: 1, backend: { login: async () => { started(); await pending; return { ...identity(), expiresAt: new Date(Date.now() + 200).toISOString() }; } } });
  const first = f.login('alice');
  await activated;
  assert.equal((await f.login('bob')).status, 429);
  release();
  const response = await first;
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/portal/session', { headers: { Cookie: cookie } })).status, 200);
  await delay(230);
  assert.equal((await f.request('/portal/session', { headers: { Cookie: cookie } })).status, 401);
});
