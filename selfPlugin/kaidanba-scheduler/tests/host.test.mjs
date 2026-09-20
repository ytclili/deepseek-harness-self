import { test } from 'node:test'
import assert from 'node:assert/strict'

const signal = new AbortController().signal
const draft = { name: '每日商品', description: '', kind: 'daily', time: '19:00', platform: 'weixin', botId: 'bot-1', targetId: 'customer-1', enabled: true }
const goods = { items: [{ name: '茶叶', spec: '250g', unit: '袋', price: 18.5, inventory: 99, id: 'private-id', image_url: 'private-url' }], total: 1, returned_count: 1, has_more: false }

test('goods formatting shares goods_list and never exposes internal fields or invents currency', async () => {
  const { createDependencies } = await import('../src/host-adapters.ts')
  const calls = []
  const context = {
    tools: { execute: async value => { calls.push(value); return { isError: false, value: goods } } },
    dshIm: { listBots: async () => [{ botId: 'bot-1', channel: 'weixin' }], listTargets: async () => [{ targetId: 'customer-1', name: '客户甲', kind: 'user' }] },
  }
  const api = createDependencies(context)
  assert.deepEqual(await api.resolveTarget(draft, signal), { targetId: 'customer-1', targetName: '客户甲' })
  const preview = await api.preview(draft, signal)
  assert.equal(calls[0].name, 'goods_list')
  assert.deepEqual(calls[0].arguments, {})
  assert.match(preview.text, /茶叶/)
  assert.match(preview.text, /18.5/)
  assert.equal(preview.itemCount, 1)
  assert.doesNotMatch(preview.text, /inventory|库存|99|private-id|private-url|元|人民币|CNY/)
})

test('incomplete, malformed, oversized or failed goods responses fail closed', async () => {
  const { formatGoods } = await import('../src/host-adapters.ts')
  for (const value of [{ ...goods, has_more: true }, { ...goods, total: 2 }, { ...goods, items: [{ name: 'bad', price: NaN }] }, { ...goods, items: Array(100).fill({ name: '商品'.repeat(40), spec: '', unit: '', price: 1 }), total: 100, returned_count: 100 }]) {
    assert.throws(() => formatGoods(value))
  }
})

test('delivery rechecks platform and existing target and requires sent acknowledgement', async () => {
  const { createDependencies } = await import('../src/host-adapters.ts')
  let sent = 0
  let channel = 'feishu'
  let targets = [{ targetId: 'customer-1', kind: 'user' }]
  const dependencies = createDependencies({ tools: {}, dshIm: {
    listBots: async () => [{ botId: 'bot-1', channel }], listTargets: async () => targets,
    send: async () => { sent++; return { sent: true } },
  } })
  await assert.rejects(dependencies.send(draft, '商品', signal))
  channel = 'weixin'; targets = []
  await assert.rejects(dependencies.send(draft, '商品', signal))
  assert.equal(sent, 0)
  targets = [{ targetId: 'customer-1', kind: 'user' }]
  await dependencies.send(draft, '商品', signal)
  assert.equal(sent, 1)
})

test('management RPC accepts only its own envelope and bounded known methods', async () => {
  const { createSchedulerHandler } = await import('../src/host-rpc.ts')
  const mutations = []
  const handler = createSchedulerHandler({ list: async () => ({ tasks: [], runs: [] }), save: async value => { mutations.push(value); return { id: 'new' } } })
  const request = body => new Request('http://localhost/api/kaidanba-scheduler', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const envelope = { type: 'client-request', rpcId: 'test-1', method: 'kaidanba-scheduler', payload: { method: 'list', payload: {} } }
  const response = await handler(request(envelope))
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'test-1', result: { ok: true, value: { tasks: [], runs: [] } } })
  for (const body of [{ ...envelope, method: 'other' }, { ...envelope, payload: { method: 'shell', payload: {} } }, { ...envelope, payload: { method: 'save', payload: { draft, extra: true } } }, { ...envelope, payload: { method: 'save', payload: { draft } } }]) {
    const result = await (await handler(request(body))).json()
    assert.equal(result.result.ok, false)
  }
  assert.equal(mutations.length, 0)
  assert.equal((await handler(new Request('http://localhost/api/kaidanba-scheduler'))).status, 405)
})
