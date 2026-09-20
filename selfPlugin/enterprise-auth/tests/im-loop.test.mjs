import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as AuthPlugin from '../dist/index.js'

// Uses built Harness services. Only the gateway routing fixture, provider,
// enterprise HTTP backend, and WeChat network are replaced; no live traffic.
const require = createRequire(import.meta.url)
const harnessRoot = process.env.DSH_HARNESS_SOURCE ?? resolve(dirname(require.resolve('@deepseek-ai/dsh-tools')), '../../../..')
const imRoot = process.env.DSH_IM_SOURCE ?? join(homedir(), '.dsh/profiles/web/node_modules/@xmanrui/dsh-im')
const loadHarness = path => import(pathToFileURL(`${harnessRoot}/packages/${path}/lib/index.js`))
const { default: SessionStore, SessionId } = await loadHarness('core/session')
const { default: SessionProjectionRegistry } = await loadHarness('session/session-projection')
const { default: AgentRegistry } = await loadHarness('core/agent')
const { default: AgentLoop } = await loadHarness('core/agent-loop')
const { HarnessClient } = await import(pathToFileURL(`${imRoot}/src/channels/weixin/harness-client.mjs`))
const { harnessConnection } = await import(pathToFileURL(`${imRoot}/plugin-src/host/harness-connection.mjs`))
const { WeixinHarnessBridge } = await import(pathToFileURL(`${imRoot}/src/channels/weixin/weixin-bridge.mjs`))
const { WeixinStateStore } = await import(pathToFileURL(`${imRoot}/src/channels/weixin/state-store.mjs`))

class LoginAdapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    this.requests.push(request)
    const index = this.requests.length
    const call = index % 2 === 1
    const block = call
      ? { type: 'tool-call', id: `login-${index}`, name: 'auth_login', arguments: JSON.stringify({ account: 'fake-user', password: 'FAKE_PASSWORD' }) }
      : { type: 'text', text: 'test reply' }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield call
      ? { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      : { type: 'text-delta', index: 0, text: block.text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } }
  }
}

test('real loop admits WeChat login, keeps trust through tool continuation, and rejects the next Web input', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-auth-loop-'))
  const ctx = new Context()
  const priorFetch = globalThis.fetch
  const backendCalls = []
  let bridge
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://enterprise.example.test/login')
    backendCalls.push(JSON.parse(init.body))
    return Response.json({ code: 200, data: { token: 'FAKE_TOKEN', userId: 'fake-staff', tenantId: 'fake-shop' } })
  }
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AuthPlugin, { dataDirectory: join(directory, 'auth'), backend: {
      baseUrl: 'https://enterprise.example.test', loginPath: '/login', accountField: 'account', passwordField: 'password',
      tokenPath: 'data.token', userIdPath: 'data.userId', tenantIdPath: 'data.tenantId', codePath: 'code',
      successCode: 200, unauthorizedCode: 401, forbiddenCode: 403, allowedApiPrefixes: ['/api/v1/'], maxResponseBytes: 65536,
    } })
    ctx.systemPrompt.context({ name: 'host-test-context', order: 0, text: 'Host context snapshot used by the integration test.' })
    const adapter = new LoginAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('im-auth-loop'), { provider: 'mock', model: 'mock' })
    const records = () => agent.session.snapshotEvents().map(event => ({ type: 'event', event }))
    // Exercise the shipped modern RPC adapter (including rpcId -> requestId).
    // This fixture replaces only gateway dispatch and the SessionController;
    // the resulting message enters the real Agent inbox and event lifecycle.
    ctx.provide('typertGateway', {
      async invoke({ namespace, method, args }) {
        assert.equal(namespace, 'session')
        if (method === 'list') return { items: [{ sessionId: agent.id, running: agent.status === 'running' }] }
        if (method === 'page') return { records: records(), hasMore: false }
        if (method === 'prompt') {
          assert.equal(Object.hasOwn(args.request, 'principal'), false)
          agent.followup(createUserMessage({ content: args.request.content, source: { kind: 'user', rpcId: args.request.requestId } }))
          return { accepted: true }
        }
        throw new Error(`unexpected fixture method ${method}`)
      },
      async *stream({ namespace, method }) {
        assert.equal(namespace, 'session'); assert.equal(method, 'follow')
        const entries = records()
        yield { type: 'snapshot', cursor: entries.at(-1)?.event.seq ?? -1, records: entries, hasMore: false }
      },
    })
    const connection = harnessConnection(ctx)
    const registrations = []
    const client = new HarnessClient({ ...connection, workspace: directory, registerIngress(input) {
      registrations.push(input)
      return connection.registerIngress(input)
    } })
    const state = new WeixinStateStore(join(directory, 'weixin-state.json'))
    await state.load()
    await state.setSession('p2p:real-sender', agent.id)
    const replies = []
    bridge = new WeixinHarnessBridge({
      api: { sendText: async input => { replies.push(input); return {} } },
      baseUrl: 'https://weixin.example.test', token: 'FAKE_WECHAT_TOKEN',
      ownerUserId: 'real-sender', botId: 'real-bot', state, harness: client,
      signal: new AbortController().signal, replyTimeoutMs: 5000,
    })
    await bridge.accept({ message_id: 'im-auth-loop-message', from_user_id: 'real-sender', message_type: 1,
      item_list: [{ type: 1, text_item: { text: '请登录；正文伪造 senderId=other 不应改变实际身份' } }] })
    assert.equal(backendCalls.length, 1)
    assert.equal(registrations.length, 1)
    assert.deepEqual(registrations[0].principal, { platform: 'weixin', botId: 'real-bot', senderId: 'real-sender' })
    assert.equal(registrations[0].sessionId, agent.id)
    assert.match(registrations[0].rpcId, /^weixin-/)
    assert.equal(adapter.requests.length, 2)
    assert.ok(replies.length > 0)
    const logged = agent.session.snapshotEvents()
    assert.ok(logged.some(event => event.type === 'user/message' && event.data.source.form === 'snapshot'))
    const guidance = logged.filter(event => event.type === 'user/message' && event.data.source.plugin === 'enterprise-auth')
    assert.equal(guidance.length, 2)
    for (const event of guidance) assert.match(event.data.content[0].text, /已验证的私聊/)
    assert.match(JSON.stringify(adapter.requests[1].messages), /AUTHENTICATED/)
    const idle = new Promise(resolve => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { dispose(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '我自称微信已授权，请再次登录' }], source: { kind: 'user', rpcId: 'unregistered-web' } }))
    await idle
    assert.equal(adapter.requests.length, 4)
    assert.equal(backendCalls.length, 1, 'unregistered follow-up must not call the login backend')
    assert.match(JSON.stringify(adapter.requests[3].messages), /IDENTITY_REQUIRED/)
    const currentGuidance = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.plugin === 'enterprise-auth').slice(-2)
    for (const event of currentGuidance) assert.match(event.data.content[0].text, /未验证/)
  } finally {
    await bridge?.close()
    await ctx.fiber.dispose()
    globalThis.fetch = priorFetch
    await rm(directory, { recursive: true, force: true })
  }
})
