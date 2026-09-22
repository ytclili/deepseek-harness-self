import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelProxy } from '../dist/model-proxy.js';
import { identityKey } from '../dist/identity.js';

const identity = (userId = 'alice', expiresAt = null) => ({ tenantId: 'fake-tenant', userId, token: 'fake-business-token', expiresAt });
const payload = { model: 'fixed-test-model', messages: [{ role: 'user', content: 'test' }] };

async function fixture(t, upstreamHandler, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'portal-model-'));
  const apiKeyFile = join(directory, 'key');
  await writeFile(apiKeyFile, 'fake-provider-secret', { mode: 0o600 });
  const seen = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (upstreamHandler) upstreamHandler(req, res);
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [] })); }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = new ModelProxy({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKeyFile, model: 'fixed-test-model', runtimeBaseUrl: 'http://host.docker.internal:4000/portal/model/v1', maxBodyBytes: 1024, timeoutMs: 2000, maxConcurrent: 1, sessionTtlMs: 10_000, ...config });
  const server = createServer((req, res) => void proxy.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    proxy.close();
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const request = (capability, init = {}, path = '/portal/model/v1/chat/completions') => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${capability}` }, body: JSON.stringify(payload), ...init });
  return { proxy, request, seen };
}

test('only a valid capability reaches fixed upstream with server key and model', async t => {
  const f = await fixture(t);
  const capability = f.proxy.grant(identity());
  assert.match(capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.request('fake-provider-secret')).status, 401);
  assert.equal((await f.request('x'.repeat(43))).status, 401);
  assert.equal((await f.request(capability, {}, '/portal/model/v1/models')).status, 404);
  assert.equal((await f.request(capability, { body: JSON.stringify({ ...payload, model: 'another-model' }) })).status, 400);
  const response = await f.request(capability, { headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json', Cookie: 'fake-cookie', 'X-Api-Key': 'fake-user-key' }, body: JSON.stringify({ ...payload, store: true }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { choices: [] });
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].url, '/v1/chat/completions');
  assert.equal(f.seen[0].headers.authorization, 'Bearer fake-provider-secret');
  assert.equal(f.seen[0].headers.cookie, undefined);
  assert.equal(f.seen[0].headers['x-api-key'], undefined);
  assert.equal(f.seen[0].body.model, 'fixed-test-model');
  assert.equal(f.seen[0].body.store, false);
});

test('malformed JSON is a client error without any upstream call', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.proxy.grant(identity()), { body: '{' })).status, 400);
  assert.equal(f.seen.length, 0);
});

test('shorter login cannot reduce capability lifetime and later login extends it', async t => {
  const f = await fixture(t);
  const first = identity('alice', new Date(Date.now() + 400).toISOString());
  const capability = f.proxy.grant(first);
  assert.equal(f.proxy.grant(identity('alice', new Date(Date.now() + 40).toISOString())), capability);
  await delay(80);
  assert.equal((await f.request(capability)).status, 200);
  assert.equal(f.proxy.grant(identity('alice', new Date(Date.now() + 500).toISOString())), capability);
  await delay(350);
  assert.equal((await f.request(capability)).status, 200);
  await delay(180);
  assert.equal((await f.request(capability)).status, 401);
});

test('per-user concurrency rejects excess request and revocation cancels upstream stream', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.once('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: fake-first-chunk\n\n');
  });
  const who = identity();
  const capability = f.proxy.grant(who);
  const response = await f.request(capability);
  const body = response.text();
  const rejectedBody = assert.rejects(body);
  assert.equal((await f.request(capability)).status, 429);
  f.proxy.revoke(identityKey(who));
  await rejectedBody;
  await Promise.race([closed, delay(1000).then(() => { throw new Error('Upstream was not cancelled'); })]);
  assert.equal((await f.request(capability)).status, 401);
});

test('capability expiry cancels an already active stream', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: fake-first-chunk\n\n'); });
  const capability = f.proxy.grant(identity('alice', new Date(Date.now() + 100).toISOString()));
  const response = await f.request(capability);
  const started = Date.now();
  await assert.rejects(response.text());
  assert.ok(Date.now() - started < 1000, 'expiry should cancel before the 2-second inference timeout');
});

test('oversize payload never reaches upstream and redirects are not followed', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { location: '/unapproved' }); res.end(); });
  const capability = f.proxy.grant(identity());
  assert.equal((await f.request(capability, { body: JSON.stringify({ ...payload, unused: 'x'.repeat(2000) }) })).status, 413);
  assert.equal(f.seen.length, 0);
  assert.equal((await f.request(capability)).status, 502);
  assert.equal(f.seen.length, 1);
  f.proxy.close();
  assert.equal((await f.request(capability)).status, 401);
  assert.throws(() => f.proxy.grant(identity()));
});
