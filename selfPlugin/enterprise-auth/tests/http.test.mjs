import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHttpBackend } from '../dist/http.js'
import { Config } from '../dist/config.js'

const config = {
  baseUrl: 'https://business.example.test', loginPath: '/auth/login',
  accountField: 'account', passwordField: 'password', tokenPath: 'data.token',
  userIdPath: 'data.user.id', tenantIdPath: 'data.tenant.id',
  codePath: 'code', successCode: 200, unauthorizedCode: 401, forbiddenCode: 403,
  allowedApiPrefixes: ['/api/v1/'], maxResponseBytes: 65536,
}
const signal = new AbortController().signal
const success = { code: 200, data: { token: 'TOKEN_CANARY', user: { id: 42 }, tenant: { id: 'shop-a' }, password: 'PASSWORD_CANARY' } }

test('configured login maps fields and extracts only credential identity fields', async () => {
  const calls = []
  const backend = createHttpBackend(config, async (url, init) => { calls.push({ url: String(url), init }); return Response.json(success) })
  assert.deepEqual(await backend.login({ account: 'alice', password: 'PASSWORD_CANARY' }, signal), { token: 'TOKEN_CANARY', userId: '42', tenantId: 'shop-a', expiresAt: null })
  assert.deepEqual(JSON.parse(calls[0].init.body), { account: 'alice', password: 'PASSWORD_CANARY' })
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].url, 'https://business.example.test/auth/login')
})

test('business calls inject bearer into configured origin only and never follow redirects', async () => {
  const calls = []
  const backend = createHttpBackend(config, async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ code: 200, data: [] }) })
  await backend.request({ method: 'POST', path: '/api/v1/orders', body: { quantity: 2 }, idempotencyKey: 'operation-a' }, 'TOKEN_CANARY', signal)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN_CANARY')
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'operation-a')
  assert.equal(calls[0].init.redirect, 'manual')
  for (const path of ['https://evil.example/api/v1/orders', '//evil.example/api/v1/orders', '/auth/login', '/api/v1/../../auth/login', '/api/v1/%252e%252e/login', '/api/v1/\\evil.example']) {
    await assert.rejects(backend.request({ method: 'GET', path }, 'TOKEN_CANARY', signal), { code: 'INVALID_INPUT' })
  }
  assert.equal(calls.length, 1)
})

test('backend error bodies never become model-facing errors', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [500, 'SERVICE_UNAVAILABLE'], [302, 'SERVICE_UNAVAILABLE']]) {
    const backend = createHttpBackend(config, async () => new Response('TOKEN_CANARY PASSWORD_CANARY', { status, headers: { Location: 'https://evil.example' } }))
    await assert.rejects(backend.request({ method: 'GET', path: '/api/v1/goods' }, 'TOKEN_CANARY', signal), error => error.code === code && !/CANARY/.test(error.message))
  }
  const rejected = createHttpBackend(config, async () => Response.json({ code: 401, message: 'TOKEN_CANARY' }))
  await assert.rejects(rejected.login({ account: 'alice', password: 'PASSWORD_CANARY' }, signal), { code: 'AUTH_FAILED' })
  await assert.rejects(rejected.request({ method: 'GET', path: '/api/v1/goods' }, 'TOKEN_CANARY', signal), { code: 'AUTH_REQUIRED' })
})

test('malformed or oversized responses fail without persisting false credentials', async () => {
  for (const value of [{ code: 200, data: {} }, { ...success, data: { ...success.data, token: 'bad\ntoken' } }, { code: 200, data: 'x'.repeat(65536) }]) {
    const backend = createHttpBackend(config, async () => Response.json(value))
    await assert.rejects(backend.login({ account: 'alice', password: 'password' }, signal), { code: 'INVALID_RESPONSE' })
  }
  assert.throws(() => createHttpBackend({ ...config, baseUrl: 'http://remote.example' }), { code: 'INVALID_INPUT' })
})

test('write transport errors are uncertain and are never retried', async () => {
  let requests = 0
  const backend = createHttpBackend(config, async () => { requests++; throw new Error('PASSWORD_CANARY') })
  await assert.rejects(backend.request({ method: 'POST', path: '/api/v1/orders', body: {} }, 'TOKEN_CANARY', signal), { code: 'RESULT_UNKNOWN' })
  assert.equal(requests, 1)
})

test('encoded and trailing-slash login aliases cannot use the business request path', async () => {
  let calls = 0
  const backend = createHttpBackend({ ...config, loginPath: '/api/v1/login' }, async () => { calls++; return Response.json(success) })
  for (const path of ['/api/v1/%6cogin', '/api/v1/login/', '/api/v1/Login', '/api/v1/login;session=1']) {
    await assert.rejects(backend.request({ method: 'GET', path }, 'TOKEN_CANARY', signal), { code: 'INVALID_INPUT' })
  }
  assert.equal(calls, 0)
})

test('writes with redirects or unrecognizable result codes remain unknown', async () => {
  for (const response of [new Response('', { status: 303 }), Response.json({ data: {} }), Response.json({ code: '200' })]) {
    const backend = createHttpBackend(config, async () => response)
    await assert.rejects(backend.request({ method: 'POST', path: '/api/v1/orders', body: {} }, 'TOKEN_CANARY', signal), { code: 'RESULT_UNKNOWN' })
  }
})

test('response cleanup failures preserve the HTTP result classification', async () => {
  for (const [status, code] of [[303, 'RESULT_UNKNOWN'], [500, 'RESULT_UNKNOWN'], [401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED']]) {
    const backend = createHttpBackend(config, async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('PASSWORD_CANARY')) },
    }), { status }))
    await assert.rejects(backend.request({ method: 'POST', path: '/api/v1/orders', body: {} }, 'TOKEN_CANARY', signal), error => error.code === code && !/CANARY/.test(error.message))
  }
})

const nextbosConfig = {
  ...config, baseUrl: 'https://api.nextbos.cn', loginPath: '/api/v1/auth/login',
  loginResponseMode: 'http-status', accountField: 'email', tokenPath: 'token',
  userIdPath: 'user.id', tenantIdPath: 'tenant.id', expiresAtPath: 'expires_at',
}
const nextbosSuccess = {
  user: { id: 42, tenant_id: 7, email: 'fixture@example.test', role: 'admin', status: 'active' },
  tenant: { id: 7, name: 'fixture' }, token: 'TOKEN_CANARY',
  expires_at: '2099-09-27T07:17:54.907048292Z',
}

test('nextbos login maps email and accepts a top-level credential without a business code', async () => {
  const calls = []
  const backendConfig = JSON.parse(await readFile(new URL('../examples/backend.example.json', import.meta.url), 'utf8'))
  const parsed = Config({ backend: backendConfig })
  assert.equal(parsed.backend.loginResponseMode, 'http-status')
  const backend = createHttpBackend(parsed.backend, async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json(nextbosSuccess)
  })
  assert.deepEqual(await backend.login({ account: 'fixture@example.test', password: 'PASSWORD_CANARY' }, signal), {
    token: 'TOKEN_CANARY', userId: '42', tenantId: '7', expiresAt: '2099-09-27T07:17:54.907Z',
  })
  assert.equal(calls[0].url, 'https://api.nextbos.cn/api/v1/auth/login')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'fixture@example.test', password: 'PASSWORD_CANARY' })
  assert.equal(calls[0].init.redirect, 'manual')
})

test('nextbos login validates required identity and expiry even when HTTP status is successful', async () => {
  for (const value of [
    { message: 'PASSWORD_CANARY' },
    { ...nextbosSuccess, token: undefined },
    { ...nextbosSuccess, user: {} },
    { ...nextbosSuccess, tenant: {} },
    { ...nextbosSuccess, expires_at: undefined },
    { ...nextbosSuccess, expires_at: '2000-01-01T00:00:00Z' },
  ]) {
    const backend = createHttpBackend(nextbosConfig, async () => Response.json(value))
    await assert.rejects(backend.login({ account: 'fixture@example.test', password: 'PASSWORD_CANARY' }, signal), { code: 'INVALID_RESPONSE' })
  }
})

test('nextbos login handles HTTP failures and never follows redirects', async () => {
  for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [429, 'RATE_LIMITED'], [500, 'SERVICE_UNAVAILABLE'], [302, 'SERVICE_UNAVAILABLE']]) {
    let calls = 0
    const backend = createHttpBackend(nextbosConfig, async () => {
      calls++
      return new Response('PASSWORD_CANARY', { status, headers: { Location: 'https://elsewhere.example.test' } })
    })
    await assert.rejects(backend.login({ account: 'fixture@example.test', password: 'PASSWORD_CANARY' }, signal), error => error.code === code && !/CANARY/.test(error.message))
    assert.equal(calls, 1)
  }
})

test('HTTP-status login mode does not relax business response validation or allow login through request', async () => {
  const backend = createHttpBackend(nextbosConfig, async () => Response.json({ data: {} }))
  await assert.rejects(backend.request({ method: 'POST', path: '/api/v1/orders', body: {} }, 'TOKEN_CANARY', signal), { code: 'RESULT_UNKNOWN' })
  await assert.rejects(backend.request({ method: 'GET', path: '/api/v1/goods' }, 'TOKEN_CANARY', signal), { code: 'INVALID_RESPONSE' })
  await assert.rejects(backend.request({ method: 'POST', path: '/api/v1/auth/login', body: {} }, 'TOKEN_CANARY', signal), { code: 'INVALID_INPUT' })
  assert.throws(() => createHttpBackend({ ...nextbosConfig, loginResponseMode: 'invalid' }), { code: 'INVALID_INPUT' })
})
