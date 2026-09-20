import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

test('Harness entry mounts native RPC, persists tasks in the active profile and closes cleanly', async () => {
  const { apply } = await import('../src/index.ts')
  const directory = await mkdtemp(join(tmpdir(), 'kdb-host-'))
  let sends = 0
  const mount = async () => {
    let route
    const disposers = []
    const context = {
      root: { baseUrl: pathToFileURL(directory).href + '/' },
      tools: { execute: async () => { throw new Error('unused') } },
      dshIm: {
        listBots: async () => [{ botId: 'bot-1', channel: 'weixin' }],
        listTargets: async () => [{ targetId: 'target-1', name: '客户甲', kind: 'user' }],
        send: async () => { sends++; return { sent: true } },
      },
      effect: setup => disposers.push(setup()),
      connection: { fetch: { register: value => { route = value; return () => { route = undefined } } } },
    }
    await apply(context)
    assert.equal(route.path, '/api/kaidanba-scheduler')
    assert.deepEqual(route.methods, ['POST'])
    return {
      async call(method, payload) {
        const response = await route.fetch(new Request('http://localhost/api/kaidanba-scheduler', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'lifecycle-test', method: 'kaidanba-scheduler', payload: { method, payload } }) }))
        return (await response.json()).result
      },
      async close() { for (const dispose of disposers.reverse()) await dispose() },
    }
  }
  let host
  try {
    host = await mount()
    const draft = { creationId: randomUUID(), name: '晚间商品', description: '', kind: 'daily', time: '19:00', platform: 'weixin', botId: 'bot-1', targetId: 'target-1', enabled: false }
    const created = await host.call('save', { draft })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(created.value.time, '19:00')
    assert.equal(created.value.targetName, '客户甲')
    const stateFile = join(directory, 'data/kaidanba-scheduler/state.json')
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600)
    assert.match(await readFile(stateFile, 'utf8'), /晚间商品/)
    await host.close(); host = undefined
    host = await mount()
    const retried = await host.call('save', { draft })
    assert.equal(retried.ok, true, JSON.stringify(retried))
    assert.equal(retried.value.id, created.value.id)
    const listed = await host.call('list', {})
    assert.equal(listed.ok, true)
    assert.equal(listed.value.tasks.length, 1)
    assert.equal(listed.value.tasks[0].time, '19:00')
    assert.equal(listed.value.tasks[0].enabled, false)
    assert.equal(sends, 0)
  } finally {
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
