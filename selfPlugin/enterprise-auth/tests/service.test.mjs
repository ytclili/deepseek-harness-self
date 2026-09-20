import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAuthService } from '../dist/service.js'
import { AuthError } from '../dist/types.js'

const principal = { platform: 'weixin', botId: 'bot-a', senderId: 'sender-a' }
const signal = () => new AbortController().signal
const identity = { userId: 'staff-a', tenantId: 'company-a', token: 'TOKEN_CANARY_A', expiresAt: null }
function fixture(backend = {}) {
  const data = new Map()
  const key = value => JSON.stringify(value)
  const store = {
    get: value => structuredClone(data.get(key(value))),
    put: async (value, credential) => { data.set(key(value), structuredClone(credential)) },
    remove: async (value, version) => { if (data.get(key(value))?.version === version) data.delete(key(value)) },
    close: async () => {},
  }
  const calls = []
  const service = createAuthService({ store, backend: {
    login: async input => { calls.push(input); return identity },
    request: async (input, token) => { calls.push({ input, token }); return { code: 200 } },
    ...backend,
  }, timeoutMs: 1000, maxLoginAttempts: 5, loginWindowMs: 60000 })
  return { service, store, calls }
}

test('login persists identity and request injects only the current principal token', async () => {
  const { service, store, calls } = fixture()
  try {
    await assert.rejects(service.request(principal, { method: 'GET', path: '/goods' }, signal()), { code: 'AUTH_REQUIRED' })
    const result = await service.login(principal, { account: 'alice', password: 'PASSWORD_CANARY' }, signal())
    assert.deepEqual(result, { status: 'authenticated', message: '登录成功，可以继续操作。' })
    assert.doesNotMatch(JSON.stringify(result), /TOKEN_CANARY|PASSWORD_CANARY|alice/)
    assert.equal(store.get(principal).userId, 'staff-a')
    await service.request(principal, { method: 'GET', path: '/goods' }, signal())
    assert.equal(calls[1].token, 'TOKEN_CANARY_A')
    await assert.rejects(service.request({ ...principal, senderId: 'sender-b' }, { method: 'GET', path: '/goods' }, signal()), { code: 'AUTH_REQUIRED' })
  } finally { await service.close() }
})

test('failed login never saves a credential or returns backend secrets', async () => {
  const { service, store } = fixture({ login: async () => { throw new Error('PASSWORD_CANARY TOKEN_CANARY') } })
  try {
    await assert.rejects(service.login(principal, { account: 'alice', password: 'PASSWORD_CANARY' }, signal()), error => error.code === 'SERVICE_UNAVAILABLE' && !/CANARY/.test(error.message))
    assert.equal(store.get(principal), undefined)
  } finally { await service.close() }
})

test('401 invalidates the used credential but 403 keeps the binding; writes never retry', async () => {
  let attempts = 0
  let code = 'FORBIDDEN'
  const { service, store } = fixture({ request: async () => { attempts++; throw new AuthError(code, 'upstream secret') } })
  try {
    await service.login(principal, { account: 'alice', password: 'password' }, signal())
    await assert.rejects(service.request(principal, { method: 'POST', path: '/orders', body: {} }, signal()), { code: 'FORBIDDEN' })
    assert.ok(store.get(principal))
    code = 'AUTH_REQUIRED'
    await assert.rejects(service.request(principal, { method: 'POST', path: '/orders', body: {} }, signal()), { code: 'AUTH_REQUIRED' })
    assert.equal(store.get(principal), undefined)
    assert.equal(attempts, 2)
  } finally { await service.close() }
})

test('an old request 401 cannot erase a newer successful login', async () => {
  let rejectRequest
  const { service, store } = fixture({ request: async () => new Promise((_, reject) => { rejectRequest = reject }) })
  try {
    await service.login(principal, { account: 'alice', password: 'password' }, signal())
    const pending = service.request(principal, { method: 'GET', path: '/goods' }, signal())
    const checked = assert.rejects(pending, { code: 'AUTH_REQUIRED' })
    while (!rejectRequest) await new Promise(resolve => setImmediate(resolve))
    await service.login(principal, { account: 'alice', password: 'password-new' }, signal())
    const newVersion = store.get(principal).version
    rejectRequest(new AuthError('AUTH_REQUIRED', 'expired'))
    await checked
    assert.equal(store.get(principal).version, newVersion)
  } finally { await service.close() }
})

test('missing identity and unexpected login arguments are rejected before network', async () => {
  const { service, calls } = fixture()
  try {
    await assert.rejects(service.login(undefined, { account: 'alice', password: 'password' }, signal()), { code: 'IDENTITY_REQUIRED' })
    await assert.rejects(service.login(principal, { account: 'alice', password: 'password', senderId: 'victim' }, signal()), { code: 'INVALID_INPUT' })
    assert.equal(calls.length, 0)
  } finally { await service.close() }
})

test('login is rate limited and storage failure is not reported as login success', async () => {
  const { service, store, calls } = fixture()
  try {
    store.put = async () => { throw new Error('disk secret') }
    for (let count = 0; count < 5; count++) {
      await assert.rejects(service.login(principal, { account: 'alice', password: 'password' }, signal()), { code: 'STORAGE_UNAVAILABLE' })
    }
    await assert.rejects(service.login(principal, { account: 'alice', password: 'password' }, signal()), { code: 'RATE_LIMITED' })
    assert.equal(calls.length, 5)
  } finally { await service.close() }
})

test('closing cancels a pending login and late completion never saves credentials', async () => {
  let completeLogin
  const { service, store } = fixture({ login: () => new Promise(resolve => { completeLogin = resolve }) })
  const pending = service.login(principal, { account: 'alice', password: 'password' }, signal())
  const rejected = assert.rejects(pending, { code: 'CANCELLED' })
  while (!completeLogin) await new Promise(resolve => setImmediate(resolve))
  await service.close()
  await rejected
  completeLogin(identity)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.get(principal), undefined)
})

test('same-principal parallel login is rejected and another principal can log in', async () => {
  let completeLogin
  let started = 0
  const { service } = fixture({ login: async () => {
    started++
    if (started === 1) return new Promise(resolve => { completeLogin = resolve })
    return identity
  } })
  try {
    const first = service.login(principal, { account: 'alice', password: 'password' }, signal())
    while (!completeLogin) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(service.login(principal, { account: 'alice', password: 'password' }, signal()), { code: 'LOGIN_BUSY' })
    assert.equal((await service.login({ ...principal, senderId: 'sender-b' }, { account: 'bob', password: 'password' }, signal())).status, 'authenticated')
    completeLogin(identity)
    await first
  } finally { await service.close() }
})
