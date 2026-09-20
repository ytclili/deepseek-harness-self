import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createGoodsListTool } from '../dist/tools/goods-list.js'

const canary = 'enterprise-test-secret-canary'
const goods = { id: 7, name: '测试商品', unit: '瓶', price: 2.5, inventory: 12, spec: '500ml', image_url: '' }
const envelope = (items = [goods], total = items.length) => ({ code: 200, message: 'success', data: { items, total } })

async function fixture(t, handler, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-test-'))
  const tokenFile = join(directory, 'test.token')
  await writeFile(tokenFile, canary, { mode: 0o600 })
  let calls = 0
  const server = createServer((request, response) => { calls++; handler(request, response) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, tokenFile, timeoutMs: 500, maxResponseBytes: 8192, maxItems: 100, ...overrides }
  const tool = createGoodsListTool(config)
  const invoke = (args = {}, signal = new AbortController().signal) => tool.execute(args, { signal })
  return { invoke, config, tool, calls: () => calls }
}

test('GET sends bearer, no browser headers, returns only allowlisted fields and truthful counts', async t => {
  const { invoke, tool } = await fixture(t, (request, response) => {
    assert.equal(request.url, '/api/v1/shop/goods')
    assert.equal(request.method, 'GET')
    assert.equal(request.headers.authorization, `Bearer ${canary}`)
    assert.equal(request.headers.referer, undefined)
    response.end(JSON.stringify(envelope([{ ...goods, private_token: canary, internal: 'hidden' }])))
  })
  const result = await invoke()
  assert.deepEqual(result, { items: [goods], total: 1, returned_count: 1, has_more: false })
  assert.equal(JSON.stringify(tool.output.render({}, result)).includes(canary), false)
  assert.equal(tool.presentCall({}).title, '企业工具 · 商品列表')
})

test('empty response is valid; truncation reports more results', async t => {
  const empty = await fixture(t, (_request, response) => response.end(JSON.stringify(envelope([]))))
  assert.deepEqual(await empty.invoke(), { items: [], total: 0, returned_count: 0, has_more: false })
  const limited = await fixture(t, (_request, response) => response.end(JSON.stringify(envelope([goods, { ...goods, id: 8 }], 20))), { maxItems: 1 })
  assert.deepEqual(await limited.invoke(), { items: [goods], total: 20, returned_count: 1, has_more: true })
})

test('rejects model supplied URL, token or arbitrary extra arguments before requesting', async t => {
  const { invoke, calls } = await fixture(t, (_request, response) => response.end('{}'))
  await assert.rejects(invoke({ url: 'https://example.com', token: canary }), /不接受参数/)
  assert.equal(calls(), 0)
})

test('HTTP and business errors never echo body, headers or credentials', async t => {
  for (const status of [401, 403, 429, 500]) {
    const { invoke, calls } = await fixture(t, (_request, response) => {
      response.writeHead(status)
      response.end(canary)
    })
    await assert.rejects(invoke(), error => !error.message.includes(canary) && error.message.includes(String(status)))
    assert.equal(calls(), 1)
  }
  const failed = await fixture(t, (_request, response) => response.end(JSON.stringify({ code: 401, message: canary, data: { items: [goods], total: 1 } })))
  await assert.rejects(failed.invoke(), error => !error.message.includes(canary) && /认证/.test(error.message))
})

test('redirects are not followed and do not transmit bearer to their target', async t => {
  let redirected = false
  const { invoke } = await fixture(t, (request, response) => {
    if (request.url !== '/api/v1/shop/goods') redirected = true
    response.writeHead(302, { location: '/steal-token' })
    response.end()
  })
  await assert.rejects(invoke(), /302/)
  assert.equal(redirected, false)
})

test('malformed JSON, wrong envelope, invalid goods and inconsistent totals fail closed', async t => {
  for (const body of [canary, '{}', JSON.stringify({ data: { items: [], total: 0 } }), JSON.stringify(envelope([{ ...goods, name: 42 }])), JSON.stringify(envelope([goods], 0)), JSON.stringify(envelope([{ ...goods, inventory: null }])), JSON.stringify(envelope([{ ...goods, name: 'x'.repeat(3000) }]))]) {
    const { invoke } = await fixture(t, (_request, response) => response.end(body))
    await assert.rejects(invoke(), error => !error.message.includes(canary) && /格式|字段/.test(error.message))
  }
})

test('stream size and declared length are bounded', async t => {
  for (const lengthHeader of [false, true]) {
    const { invoke } = await fixture(t, (_request, response) => {
      if (lengthHeader) response.setHeader('content-length', 9000)
      response.end('x'.repeat(9000))
    })
    await assert.rejects(invoke(), /过大/)
  }
})

test('timeout includes body read; user cancellation aborts in-flight HTTP', async t => {
  const slow = await fixture(t, (_request, response) => { response.writeHead(200); response.write('{') }, { timeoutMs: 30 })
  await assert.rejects(slow.invoke(), /超时/)
  const cancelled = new AbortController()
  cancelled.abort(new Error(canary))
  await assert.rejects(slow.invoke({}, cancelled.signal), error => /取消/.test(error.message) && !error.message.includes(canary))
  const active = new AbortController()
  const pending = slow.invoke({}, active.signal)
  active.abort(new Error(canary))
  await assert.rejects(pending, /取消/)
})

test('missing, oversized and malformed token files never cause an HTTP request', async t => {
  const fixtureResult = await fixture(t, (_request, response) => response.end('{}'))
  for (const token of ['', `prefix\n${canary}`, 'x'.repeat(9000)]) {
    await writeFile(fixtureResult.config.tokenFile, token)
    await assert.rejects(fixtureResult.invoke(), error => /凭证/.test(error.message) && !error.message.includes(canary))
  }
  await rm(fixtureResult.config.tokenFile)
  await assert.rejects(fixtureResult.invoke(), /凭证/)
  assert.equal(fixtureResult.calls(), 0)
})

test('non-HTTPS remote base URLs and URLs carrying credentials or paths are rejected', () => {
  for (const baseUrl of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/prefix', 'https://example.com?q=1', 'file:///tmp/a']) {
    assert.throws(() => createGoodsListTool({ baseUrl, tokenFile: '/tmp/test.token', timeoutMs: 500, maxResponseBytes: 8192, maxItems: 100 }), /配置/)
  }
})
