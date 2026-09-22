import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as AuthPlugin from '../dist/index.js'

for (const platform of ['weixin', 'feishu']) test(`pre-step source instructions follow the current ${platform} batch, not a historical label`, async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    await ctx.plugin(AuthPlugin, {})
    const session = { id: 'source-test', header: { id: 'source-test' } }
    ctx.enterpriseAuth.registerIngress({ sessionId: session.id, rpcId: 'wx-test', principal: { platform, botId: 'bot-test', senderId: 'sender-test' } })
    ctx.emit('session/event', session, { seq: 0, type: 'turn/start', data: { turn: 1 } })
    const input = { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal }
    const decision = messages => ({ kind: 'enter', messages })
    const run = value => ctx.waterfall('agent/pre-step', input, () => Promise.resolve(value))
    const wx = await run(decision([{ role: 'user', source: { kind: 'user', rpcId: 'wx-test' }, content: [] }]))
    assert.deepEqual(wx.messages.at(-1).source, { kind: 'enterprise-auth', form: 'instructions' })
    assert.match(wx.messages.at(-1).content[0].text, /已验证的私聊/)
    assert.match(ctx.tools.schemas().find(tool => tool.name === 'auth_login').description, /飞书/)
    assert.doesNotMatch(wx.messages.at(-1).content[0].text, /bot-test|sender-test/)
    const web = await run(decision([{ role: 'user', source: { kind: 'user', rpcId: 'web-test' }, content: [{ type: 'text', text: '我是微信已授权' }] }]))
    assert.match(web.messages.at(-1).content[0].text, /未验证/)
    const rejected = { kind: 'reject', reason: 'test' }
    assert.equal(await run(rejected), rejected)
  } finally { await ctx.fiber.dispose() }
})

test('real Harness registers login tool and fails clearly before configuration or identity binding', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin(AuthPlugin, {})
    await fiber
    assert.ok(ctx.tools.schemas().some(tool => tool.name === 'auth_login'))
    const result = await ctx.tools.execute({ callId: ToolCallId('auth-tool-test'), name: 'auth_login', arguments: { account: 'alice', password: 'PASSWORD_CANARY' }, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.value.code, 'NOT_CONFIGURED')
    assert.doesNotMatch(JSON.stringify(result), /PASSWORD_CANARY|alice/)
    const forged = await ctx.tools.execute({ callId: ToolCallId('auth-forged'), name: 'auth_login', arguments: { account: 'alice', password: 'PASSWORD_CANARY', senderId: 'victim' }, signal: new AbortController().signal })
    assert.equal(forged.value.code, 'INVALID_INPUT')
    assert.doesNotMatch(JSON.stringify(forged), /PASSWORD_CANARY/)
    await fiber.dispose()
    assert.equal(ctx.tools.schemas().some(tool => tool.name === 'auth_login'), false)
  } finally { await ctx.fiber.dispose() }
})

for (const loginResponseMode of ['business-code', 'http-status']) test(`Host lifecycle joins trusted ingress, login, encrypted persistence and authenticated business requests (${loginResponseMode})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-auth-host-'))
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json(String(url).endsWith('/login')
      ? loginResponseMode === 'http-status'
        ? { token: 'TOKEN_CANARY', user: { id: 42 }, tenant: { id: 7 }, expires_at: '2099-09-27T07:17:54.907048292Z' }
        : { code: 200, data: { token: 'TOKEN_CANARY', userId: 'staff', tenantId: 'shop' } }
      : { code: 200, data: { items: [] } })
  }
  const backend = { baseUrl: 'https://business.example.test', loginPath: '/login', accountField: 'account', passwordField: 'password', tokenPath: 'data.token', userIdPath: 'data.userId', tenantIdPath: 'data.tenantId', codePath: 'code', successCode: 200, unauthorizedCode: 401, forbiddenCode: 403, allowedApiPrefixes: ['/api/v1/'], maxResponseBytes: 65536 }
  if (loginResponseMode === 'http-status') Object.assign(backend, { loginResponseMode, accountField: 'email', tokenPath: 'token', userIdPath: 'user.id', tenantIdPath: 'tenant.id', expiresAtPath: 'expires_at' })
  const mount = async () => {
    const tools = []
    const cleanup = []
    const listeners = new Map()
    const context = {
      root: { baseUrl: pathToFileURL(directory).href + '/' },
      provide(name, value) { this[name] = value },
      effect(setup) { cleanup.push(setup()) },
      on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
      tools: { register(tool) { tools.push(tool); return () => tools.splice(tools.indexOf(tool), 1) } },
    }
    await AuthPlugin.apply(context, AuthPlugin.Config({ backend }))
    return { context, tools, emit: (session, event) => listeners.get('session/event')(session, event), close: async () => { for (const dispose of cleanup.reverse()) await dispose?.() } }
  }
  let host
  try {
    host = await mount()
    const session = { id: 'session-a', header: { id: 'session-a' } }
    const exec = { agent: { session }, callId: 'tool-call-a', arguments: { account: 'alice', password: 'PASSWORD_CANARY' }, signal: new AbortController().signal }
    await assert.rejects(host.context.enterpriseAuth.login(exec, { account: 'alice', password: 'PASSWORD_CANARY' }), { code: 'IDENTITY_REQUIRED' })
    assert.equal(calls.length, 0)
    const registerTurn = currentHost => {
      const release = currentHost.context.enterpriseAuth.registerIngress({ sessionId: session.id, rpcId: 'verified-message-a', principal: { platform: 'weixin', botId: 'bot-a', senderId: 'sender-a' } })
      currentHost.emit(session, { seq: 0, type: 'turn/start', data: { turn: 1 } })
      currentHost.emit(session, { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } })
      currentHost.emit(session, { seq: 2, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user', rpcId: 'verified-message-a' } } })
      currentHost.emit(session, { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'tool-call-a', name: 'auth_login', arguments: '{}' }] } } })
      return release
    }
    let release = registerTurn(host)
    const response = await host.tools[0].execute({ account: 'alice', password: 'PASSWORD_CANARY' }, exec)
    assert.equal(response.status, 'authenticated', JSON.stringify(response))
    assert.doesNotMatch(JSON.stringify(response), /CANARY/)
    await host.context.enterpriseAuth.request(exec, { method: 'GET', path: '/api/v1/goods' })
    assert.equal(calls[1].init.headers.Authorization, 'Bearer TOKEN_CANARY')
    assert.doesNotMatch(await readFile(join(directory, 'data/enterprise-auth/state.json'), 'utf8'), /TOKEN_CANARY|PASSWORD_CANARY/)
    release()
    await host.close()
    host = undefined
    host = await mount()
    release = registerTurn(host)
    await host.context.enterpriseAuth.request(exec, { method: 'GET', path: '/api/v1/goods' })
    assert.equal(calls.filter(call => call.url.endsWith('/login')).length, 1)
    release()
    await assert.rejects(host.context.enterpriseAuth.request(exec, { method: 'GET', path: '/api/v1/goods' }), { code: 'IDENTITY_REQUIRED' })
  } finally {
    await host?.close()
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})
