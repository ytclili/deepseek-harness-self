import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { installGateway } from '../dist/gateway.js';
import { identityKey } from '../dist/identity.js';

async function mounted(t, options = {}) {
  const ctx = new Context();
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${ctx.webServer.port}`;
  const ensured = [], stopped = [], granted = [], revoked = [], received = [];
  const runtimes = new Map();
  let managerClosed = 0, modelsClosed = 0;
  const manager = {
    async ensure(identity, signal) {
      ensured.push(identity);
      await options.beforeEnsure?.(identity, signal, ensured.length);
      signal.throwIfAborted();
      const key = identityKey(identity);
      if (runtimes.has(key)) return runtimes.get(key).runtime;
      const server = createServer((req, res) => {
        received.push({ userId: identity.userId, url: req.url, headers: req.headers });
        if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: fake-private-stream\n\n'); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'native-secret=fake-internal; HttpOnly' });
        res.end(JSON.stringify({ userId: identity.userId, tenantId: identity.tenantId }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const runtime = { origin: `http://127.0.0.1:${server.address().port}`, cookie: `native-session=fake-${identity.userId}` };
      runtimes.set(key, { server, runtime });
      return runtime;
    },
    async stop(key) {
      stopped.push(key);
      const entry = runtimes.get(key);
      if (entry) { runtimes.delete(key); entry.server.closeAllConnections(); await new Promise(resolve => entry.server.close(resolve)); }
    },
    async close() {
      managerClosed++;
      await Promise.all([...runtimes.values()].map(({ server }) => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }));
      runtimes.clear();
    },
  };
  const models = {
    async handle(_req, res) { res.writeHead(401); res.end(); },
    grant(identity) { granted.push(identity); return 'fake-per-user-model-capability'; },
    revoke(key) { revoked.push(key); },
    close() { modelsClosed++; },
  };
  const backend = { async login(account, password) {
    if (password !== 'fake-correct') return null;
    return { tenantId: 'fake-tenant', userId: account, token: 'fake-unchanged-business-token', expiresAt: null };
  } };
  const config = { publicOrigin: base, sessionTtlMs: options.sessionTtlMs ?? 60_000, maxSessions: 20, proxyTimeoutMs: 3000, maxProxyBodyBytes: 4096, docker: { activationTimeoutMs: 2000 } };
  const plugin = { name: 'test-portal-gateway', inject: ['webServer'], apply: scope => installGateway(scope, config, { backend, manager, models }) };
  const fiber = ctx.plugin(plugin);
  await fiber;
  t.after(() => ctx.fiber.dispose());
  const request = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  const login = (account, password = 'fake-correct', init = {}) => request('/portal/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password }), ...init });
  return { ctx, fiber, plugin, base, request, login, ensured, stopped, granted, revoked, received, runtimes, closed: () => ({ manager: managerClosed, models: modelsClosed }) };
}
function cookie(response) { return response.headers.get('set-cookie').split(';')[0]; }

test('real Cordis gateway serves public page and built assets without private native credentials', async t => {
  const f = await mounted(t);
  for (const path of ['/', '/login']) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    const html = await response.text();
    assert.match(html, /NextBOS Agent/);
    assert.doesNotMatch(html, /fake-unchanged-business-token|native-secret/);
    const script = html.match(/src="([^\"]+\.js)"/)[1];
    const asset = await f.request(script);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.ok((await asset.text()).length > 100);
  }
  for (const path of ['/web-portal/src/main.jsx', '/web-portal/package.json', '/web-portal/.env', '/web-portal/assets/absent.js', '/web-portal/%2e%2e%2fpackage.json', '/web-portal/%ZZ', '/web-portal/index.html']) assert.equal((await f.request(path)).status, 404, path);
  for (const path of ['/login', '/web-portal/mark.svg']) {
    assert.equal(await (await f.request(path, { method: 'HEAD' })).text(), '');
    assert.equal((await f.request(path, { method: 'POST' })).status, 405);
  }
  assert.equal((await f.request('/api/session.list')).status, 401);
});

test('wrong credentials and forged browser identity never create a runtime', async t => {
  const f = await mounted(t);
  const failed = await f.login('alice', 'fake-wrong');
  assert.equal(failed.status, 401);
  assert.equal(failed.headers.get('set-cookie'), null);
  assert.equal((await f.login('alice', 'fake-correct', { body: JSON.stringify({ account: 'alice', password: 'fake-correct', tenantId: 'admin', userId: 'root' }) })).status, 400);
  assert.equal(f.ensured.length, 0);
  assert.equal(f.granted.length, 0);
  assert.equal(f.runtimes.size, 0);
});

test('two verified browser sessions route exclusively to their own runtime despite forged headers and query', async t => {
  const f = await mounted(t);
  const a = cookie(await f.login('alice'));
  const b = cookie(await f.login('bob'));
  assert.notEqual(a, b);
  for (const [value, expected] of [[a, 'alice'], [b, 'bob']]) {
    const response = await f.request('/api/test?userId=admin&tenantId=other&token=fake-admin-token', { headers: { Cookie: `${value}; native-session=fake-admin`, Authorization: 'Bearer fake-admin-token', 'X-Forwarded-Host': 'attacker.invalid', 'X-User-Id': 'admin' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { userId: expected, tenantId: 'fake-tenant' });
    const upstream = f.received.at(-1);
    assert.equal(upstream.headers.cookie, `native-session=fake-${expected}`);
    assert.equal(upstream.headers.authorization, undefined);
    assert.equal(upstream.headers['x-forwarded-host'], undefined);
    assert.doesNotMatch(upstream.url, /token=/);
  }
  assert.equal((await f.request('/api/test', { headers: { Cookie: `${a}forged` } })).status, 401);
  assert.equal(f.ensured.length, 2);
});

test('Host/Origin checks protect login, logout and private reads', async t => {
  const f = await mounted(t);
  const sessionCookie = cookie(await f.login('alice'));
  assert.equal((await f.login('bob', 'fake-correct', { headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await f.request('/portal/logout', { method: 'POST', headers: { Cookie: sessionCookie } })).status, 403);
  assert.equal((await f.request('/api/test', { headers: { Cookie: sessionCookie, Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/api/test', { headers: { Cookie: sessionCookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/login', { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHost, 403);
  assert.equal((await f.request('/portal/session', { headers: { Cookie: sessionCookie } })).status, 200);
});

test('logout revokes only that browser session and closes its active HTTP stream', async t => {
  const f = await mounted(t);
  const a = cookie(await f.login('alice'));
  const b = cookie(await f.login('bob'));
  const stream = await f.request('/stream', { headers: { Cookie: a } });
  const interrupted = assert.rejects(stream.text());
  assert.equal((await f.request('/portal/logout', { method: 'POST', headers: { Origin: f.base, Cookie: a } })).status, 200);
  await interrupted;
  await nextTurn();
  assert.equal((await f.request('/portal/session', { headers: { Cookie: a } })).status, 401);
  assert.deepEqual(await (await f.request('/api/test', { headers: { Cookie: b } })).json(), { userId: 'bob', tenantId: 'fake-tenant' });
  assert.deepEqual(f.stopped, [identityKey({ tenantId: 'fake-tenant', userId: 'alice' })]);
  assert.deepEqual(f.revoked, f.stopped);
});

test('same-token relogin renews the model grant and replaces the old browser session without stopping runtime', async t => {
  const f = await mounted(t);
  const oldCookie = cookie(await f.login('alice'));
  const renewed = await f.login('alice', 'fake-correct', { headers: { Origin: f.base, 'Content-Type': 'application/json', Cookie: oldCookie } });
  const newCookie = cookie(renewed);
  assert.notEqual(newCookie, oldCookie);
  assert.equal(f.granted.length, 2);
  assert.equal(f.granted[0].token, f.granted[1].token);
  await nextTurn();
  assert.deepEqual(f.stopped, []);
  assert.equal((await f.request('/portal/session', { headers: { Cookie: oldCookie } })).status, 401);
  assert.equal((await f.request('/api/test', { headers: { Cookie: newCookie } })).status, 200);
});

test('last-session expiry does not stop a runtime while same-user login preparation is pending', async t => {
  let release;
  let entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await mounted(t, { sessionTtlMs: 120, beforeEnsure: async (_identity, _signal, count) => { if (count === 2) { entered(); await waiting; } } });
  const oldCookie = cookie(await f.login('alice'));
  const renewed = f.login('alice');
  await started;
  await delay(170);
  assert.equal((await f.request('/portal/session', { headers: { Cookie: oldCookie } })).status, 401);
  assert.deepEqual(f.stopped, []);
  assert.deepEqual(f.revoked, []);
  release();
  const newCookie = cookie(await renewed);
  assert.equal(f.granted.length, 2);
  assert.equal((await f.request('/api/test', { headers: { Cookie: newCookie } })).status, 200);
  await f.request('/portal/logout', { method: 'POST', headers: { Origin: f.base, Cookie: newCookie } });
  await nextTurn();
  assert.equal(f.stopped.length, 1);
});

test('disposing the Cordis plugin closes dependencies and unregisters public and private routes', async t => {
  const f = await mounted(t);
  await f.login('alice');
  await f.fiber.dispose();
  assert.deepEqual(f.closed(), { manager: 1, models: 1 });
  assert.equal((await f.request('/login')).status, 404);
  assert.equal((await f.request('/web-portal/mark.svg')).status, 404);
  assert.equal((await f.request('/portal/session')).status, 404);
  assert.equal((await f.request('/api/test')).status, 404);
});
