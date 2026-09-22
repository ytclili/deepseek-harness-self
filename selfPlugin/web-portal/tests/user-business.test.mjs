import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityKey } from '../dist/identity.js';
import { createUserBusinessService } from '../dist/user-business.js';
import { AuthError } from 'dsh-enterprise-auth/types';
import { createHttpBackend } from 'dsh-enterprise-auth/http';
import { createServer } from 'node:http';
import { once } from 'node:events';

const identity = userId => ({ tenantId: 'fake-tenant', userId, token: `fake-${userId}-token`, expiresAt: new Date(Date.now() + 60_000).toISOString() });
const input = { method: 'GET', path: '/api/v1/test' };
const exec = () => ({ signal: new AbortController().signal });

async function fixture(t, payload = identity('alice'), backend = { request: async (_input, token) => ({ marker: token }) }) {
  const directory = await mkdtemp(join(tmpdir(), 'portal-user-business-'));
  const credentialFile = join(directory, 'credential.json');
  await writeFile(credentialFile, JSON.stringify(payload), { mode: 0o600 });
  const service = createUserBusinessService({ credentialFile, identityKey: identityKey(payload), timeoutMs: 50, backend });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, credentialFile, service };
}

test('two isolated services use their own fresh file credentials and reject tool login/ingress', async t => {
  const a = await fixture(t);
  const b = await fixture(t, identity('bob'));
  assert.deepEqual(await a.service.request(exec(), input), { marker: 'fake-alice-token' });
  assert.deepEqual(await b.service.request(exec(), input), { marker: 'fake-bob-token' });
  await writeFile(a.credentialFile, JSON.stringify({ ...identity('alice'), token: 'fake-refreshed-token' }));
  assert.deepEqual(await a.service.request(exec(), input), { marker: 'fake-refreshed-token' });
  await assert.rejects(a.service.login(exec(), { account: 'bob', password: 'fake-password' }), error => error.code === 'AUTH_REQUIRED' && error.message.includes('网页'));
  assert.throws(() => a.service.registerIngress({ sessionId: 'test', rpcId: 'test', principal: {} }), error => error.code === 'AUTH_REQUIRED');
});

test('wrong identity and expired credentials fail before reaching backend', async t => {
  let calls = 0;
  const f = await fixture(t, identity('alice'), { request: async () => { calls++; return {}; } });
  await writeFile(f.credentialFile, JSON.stringify(identity('bob')));
  await assert.rejects(f.service.request(exec(), input), error => error.code === 'AUTH_REQUIRED');
  await writeFile(f.credentialFile, JSON.stringify({ ...identity('alice'), expiresAt: new Date(0).toISOString() }));
  await assert.rejects(f.service.request(exec(), input), error => error.code === 'AUTH_REQUIRED');
  assert.equal(calls, 0);
});

test('symlinks, public permissions and oversize credential files are rejected', async t => {
  const f = await fixture(t);
  await chmod(f.credentialFile, 0o644);
  await assert.rejects(f.service.request(exec(), input), error => error.code === 'STORAGE_UNAVAILABLE');
  await chmod(f.credentialFile, 0o600);
  await writeFile(f.credentialFile, 'x'.repeat(16_385));
  await assert.rejects(f.service.request(exec(), input), error => error.code === 'STORAGE_UNAVAILABLE');
  const actual = join(f.directory, 'actual.json');
  await writeFile(actual, JSON.stringify(identity('alice')), { mode: 0o600 });
  await rm(f.credentialFile);
  await symlink(actual, f.credentialFile);
  await assert.rejects(f.service.request(exec(), input), error => error.code === 'STORAGE_UNAVAILABLE');
});

test('backend errors only expose whitelisted codes and safe messages', async t => {
  const f = await fixture(t, identity('alice'), { request: async () => { throw new AuthError('FORBIDDEN', 'fake-alice-token password=canary'); } });
  await assert.rejects(f.service.request(exec(), input), error => error.code === 'FORBIDDEN' && !error.message.includes('canary') && !error.message.includes('token'));
  const g = await fixture(t, identity('bob'), { request: async () => { throw new Error('fake-bob-token'); } });
  await assert.rejects(g.service.request(exec(), input), error => error.code === 'SERVICE_UNAVAILABLE' && !error.message.includes('token'));
});

test('cancelled requests never reach backend; timed-out writes report uncertain outcome; close revokes service', async t => {
  let calls = 0;
  const f = await fixture(t, identity('alice'), { request: async () => { calls++; return new Promise(() => {}); } });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.service.request({ signal: aborted.signal }, input), error => error.code === 'CANCELLED');
  assert.equal(calls, 0);
  await assert.rejects(f.service.request(exec(), { ...input, method: 'POST' }), error => error.code === 'RESULT_UNKNOWN');
  await f.service.close();
  await assert.rejects(f.service.request(exec(), input), error => error.code === 'CLOSED');
});

test('real HTTP adapter sends the private user token only to the configured business endpoint', async t => {
  const received = [];
  const server = createServer((req, res) => {
    received.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { ok: true } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const backend = createHttpBackend({
    baseUrl: `http://127.0.0.1:${server.address().port}`, loginPath: '/login',
    accountField: 'account', passwordField: 'password', tokenPath: 'token', userIdPath: 'userId', tenantIdPath: 'tenantId',
    codePath: 'code', successCode: 0, unauthorizedCode: 401, forbiddenCode: 403,
    allowedApiPrefixes: ['/api/v1/'], maxResponseBytes: 1024,
  });
  const f = await fixture(t, identity('alice'), backend);
  assert.deepEqual(await f.service.request(exec(), input), { code: 0, data: { ok: true } });
  assert.deepEqual(received, [{ url: '/api/v1/test', authorization: 'Bearer fake-alice-token' }]);
  await assert.rejects(f.service.request(exec(), { method: 'GET', path: '//evil.test/token' }), error => error.code === 'INVALID_INPUT');
  assert.equal(received.length, 1);
});
