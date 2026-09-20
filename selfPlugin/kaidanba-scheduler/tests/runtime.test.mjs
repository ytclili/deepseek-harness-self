import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const runtime = await import('../src/runtime.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})

const draft = (extra = {}) => ({ name: '晚间商品', description: '', kind: 'daily', time: '19:00', platform: 'feishu', botId: 'bot-1', targetId: 'conversation:abc', enabled: true, ...extra })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const eventually = async predicate => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition did not become true')
}
async function fixture(context, overrides = {}, initial = '2026-09-19T10:59:00Z') {
  assert.equal(typeof runtime.openScheduler, 'function', 'openScheduler must be exported')
  const directory = await mkdtemp(join(tmpdir(), 'scheduler-test-'))
  const stateFile = join(directory, 'state.json')
  let clock = Date.parse(initial)
  const sent = []
  const dependencies = {
    resolveTarget: async () => ({ targetId: 'group-1', targetName: '商品群', route: 'must-not-persist' }),
    preview: async () => ({ text: '商品', itemCount: 1 }),
    send: async (task, text) => { sent.push({ task, text }) },
    ...overrides,
  }
  const options = { stateFile, dependencies, now: () => clock, autoStart: false }
  let service = await runtime.openScheduler(options)
  context.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, stateFile, sent, dependencies, options, get service() { return service },
    at: value => { clock = Date.parse(value) },
    restart: async () => { await service.close(); service = await runtime.openScheduler(options); return service },
  }
}

test('Shanghai 19:00, durable restart, repeated ticks and private files', async context => {
  const setup = await fixture(context)
  const saved = await setup.service.save(draft())
  assert.match(saved.id, /^[0-9a-f-]{36}$/)
  assert.equal(saved.targetId, 'group-1')
  assert.equal(saved.nextRunAt, '2026-09-19T11:00:00.000Z')
  assert.equal((await stat(setup.directory)).mode & 0o777, 0o700)
  assert.equal((await stat(setup.stateFile)).mode & 0o777, 0o600)
  assert.equal((await readFile(setup.stateFile, 'utf8')).includes('must-not-persist'), false)
  await setup.restart()
  setup.at('2026-09-19T11:00:00Z')
  await Promise.all([setup.service.tick(), setup.service.tick(), setup.service.tick()])
  assert.equal(setup.sent.length, 1)
  const view = await setup.service.list()
  assert.equal(view.runs[0].status, 'accepted')
  assert.equal(view.tasks[0].nextRunAt, '2026-09-20T11:00:00.000Z')
  view.tasks[0].targetId = 'mutated'
  assert.equal((await setup.service.list()).tasks[0].targetId, 'group-1')
  await setup.restart()
  await setup.service.tick()
  assert.equal(setup.sent.length, 1)
})

test('once completes and cannot execute automatically again', async context => {
  const setup = await fixture(context)
  await setup.service.save(draft({ kind: 'once', time: '2026-09-19 19:00' }))
  setup.at('2026-09-19T11:00:00Z')
  await setup.service.tick()
  const view = await setup.service.list()
  assert.equal(view.tasks[0].status, 'completed')
  assert.equal(view.tasks[0].enabled, false)
  assert.equal(view.tasks[0].nextRunAt, null)
  await setup.restart()
  await setup.service.tick()
  assert.equal(setup.sent.length, 1)
})

test('startup misses even a one-second overdue task, normal ticks allow 60 seconds', async context => {
  const setup = await fixture(context)
  await setup.service.save(draft())
  setup.at('2026-09-19T11:00:01Z')
  await setup.restart()
  await setup.service.tick()
  assert.equal(setup.sent.length, 0)
  assert.equal((await setup.service.list()).runs[0].status, 'missed')
  setup.at('2026-09-20T11:01:00Z')
  await setup.service.tick()
  assert.equal(setup.sent.length, 1)
  setup.at('2026-09-21T11:01:01Z')
  await setup.service.tick()
  assert.equal(setup.sent.length, 1)
  assert.equal((await setup.service.list()).runs.filter(run => run.status === 'missed').length, 2)
})

test('global concurrency is four, same-task calls do not overlap and request IDs deduplicate', async context => {
  const gate = deferred()
  let active = 0
  let peak = 0
  const setup = await fixture(context, { preview: async () => {
    active++
    peak = Math.max(peak, active)
    await gate.promise
    active--
    return { text: '商品', itemCount: 1 }
  } })
  const tasks = []
  for (let index = 0; index < 6; index++) tasks.push(await setup.service.save(draft({ name: `任务${index}` })))
  const first = setup.service.run(tasks[0].id, tasks[0].revision, 'request-1')
  const duplicate = setup.service.run(tasks[0].id, tasks[0].revision, 'request-1')
  await eventually(() => active === 1)
  await assert.rejects(setup.service.run(tasks[0].id, tasks[0].revision, 'other-request'), /busy/i)
  const others = tasks.slice(1, 4).map(task => setup.service.run(task.id, task.revision, task.id))
  await eventually(() => active === 4)
  await assert.rejects(setup.service.run(tasks[4].id, tasks[4].revision, 'overflow'), /busy/i)
  gate.resolve()
  const results = await Promise.all([first, duplicate, ...others])
  assert.equal(results[0].id, results[1].id)
  assert.equal(peak, 4)
  assert.equal(setup.sent.length, 4)
  await setup.restart()
  await setup.service.run(tasks[0].id, tasks[0].revision, 'request-1')
  assert.equal(setup.sent.length, 4)
})

for (const operation of ['pause', 'edit', 'delete', 'close']) {
  test(`${operation} cancels preparing work even when dependency ignores signal`, async context => {
    let entered = false
    const setup = await fixture(context, { preview: async () => { entered = true; return new Promise(() => {}) } })
    const task = await setup.service.save(draft())
    const running = setup.service.run(task.id, task.revision, 'cancel-request')
    await eventually(() => entered)
    if (operation === 'pause') await setup.service.toggle(task.id, task.revision, false)
    if (operation === 'edit') await setup.service.save({ ...task, name: '新版' })
    if (operation === 'delete') await setup.service.remove(task.id, task.revision)
    if (operation === 'close') await setup.service.close()
    assert.equal((await running).status, 'cancelled')
    assert.equal(setup.sent.length, 0)
  })
}

test('sending is durable first; uncertain failures are unknown and never retried', async context => {
  let setup
  let observedStatus
  setup = await fixture(context, { send: async () => {
    const disk = JSON.parse(await readFile(setup.stateFile, 'utf8'))
    observedStatus = disk.runs.at(-1).status
    throw new Error('secret-token-should-not-leak')
  } })
  await setup.service.save(draft())
  setup.at('2026-09-19T11:00:00Z')
  await setup.service.tick()
  assert.equal(observedStatus, 'sending')
  assert.equal((await setup.service.list()).runs[0].status, 'unknown')
  assert.equal((await readFile(setup.stateFile, 'utf8')).includes('secret-token'), false)
  let calls = 0
  setup.dependencies.send = async () => { calls++ }
  await setup.restart()
  await setup.service.tick()
  assert.equal(calls, 0)
})

test('exclusive lock rejects duplicate owners and ambiguous stale locks', async context => {
  const setup = await fixture(context)
  await assert.rejects(runtime.openScheduler(setup.options), /lock/i)
  await setup.restart()
  await setup.service.close()
  await mkdir(join(setup.directory, '.scheduler.lock'), { mode: 0o700 })
  await writeFile(join(setup.directory, '.scheduler.lock', 'owner.json'), JSON.stringify({ pid: 99999999 }))
  await assert.rejects(runtime.openScheduler(setup.options), /lock.*recover|lock.*manual/i)
})

test('malformed JSON and modified snapshots fail closed', async context => {
  const setup = await fixture(context)
  const task = await setup.service.save(draft())
  await setup.service.run(task.id, task.revision, 'audit')
  await setup.service.close()
  const data = JSON.parse(await readFile(setup.stateFile, 'utf8'))
  data.runs[0].snapshot.targetId = 'tampered'
  await writeFile(setup.stateFile, JSON.stringify(data))
  await assert.rejects(runtime.openScheduler(setup.options), /corrupt|digest/i)
  await writeFile(setup.stateFile, '{bad json')
  await assert.rejects(runtime.openScheduler(setup.options), /corrupt|json/i)
})

test('disk failure before sending prevents delivery and keeps old state', async context => {
  const gate = deferred()
  let entered = false
  const setup = await fixture(context, { preview: async () => {
    entered = true
    await gate.promise
    return { text: '商品', itemCount: 1 }
  } })
  const task = await setup.service.save(draft())
  const running = setup.service.run(task.id, task.revision, 'disk-failure')
  const rejected = assert.rejects(running, /storage|disk|directory|EISDIR/i)
  await eventually(() => entered)
  await rename(setup.stateFile, `${setup.stateFile}.backup`)
  await mkdir(setup.stateFile)
  gate.resolve()
  await rejected
  assert.equal(setup.sent.length, 0)
  await rm(setup.stateFile, { recursive: true })
  await rename(`${setup.stateFile}.backup`, setup.stateFile)
})

test('server validates inputs, rejects conflicts and retains only approved fields', async context => {
  const setup = await fixture(context)
  for (const invalid of [
    { name: '' }, { name: 'a'.repeat(81) }, { description: 'a'.repeat(501) },
    { time: '24:00' }, { time: '9:00' }, { platform: 'slack' }, { botId: '' },
    { targetId: 'bad\nref' }, { enabled: 'true' }, { kind: 'weekly' },
    { kind: 'once', time: '2026-02-30 19:00' }, { kind: 'once', time: '2026-09-19 18:00' },
  ]) await assert.rejects(setup.service.save(draft(invalid)))
  const task = await setup.service.save(draft({ secret: 'never-store' }))
  await assert.rejects(setup.service.save({ ...task, revision: 0 }), /revision|conflict/i)
  await assert.rejects(setup.service.toggle(task.id, task.revision, 'yes'))
  const updated = await setup.service.toggle(task.id, task.revision, false)
  assert.equal(updated.revision, task.revision + 1)
  await assert.rejects(setup.service.remove(task.id, task.revision), /conflict/i)
  assert.equal((await readFile(setup.stateFile, 'utf8')).includes('never-store'), false)
})

test('saved target is revalidated before preview and run without accepting changed identity', async context => {
  let allow = true
  let queries = 0
  const setup = await fixture(context, {
    resolveTarget: async () => ({ targetId: allow ? 'group-1' : 'different-group', targetName: '群' }),
    preview: async () => { queries++; return { text: '商品', itemCount: 1 } },
  })
  const task = await setup.service.save(draft())
  allow = false
  await assert.rejects(setup.service.preview(task.id), /target/i)
  const result = await setup.service.run(task.id, task.revision, 'revalidate')
  assert.equal(result.status, 'query_failed')
  assert.equal(queries, 0)
  assert.equal(setup.sent.length, 0)
})

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
async function replaceState(setup, mutate) {
  const data = JSON.parse(await readFile(setup.stateFile, 'utf8'))
  delete data.checksum
  mutate(data)
  await writeFile(setup.stateFile, JSON.stringify({ ...data, checksum: hash(data) }))
}

test('startup converts interrupted preparing/sending and verifies snapshot digest independently', async context => {
  const setup = await fixture(context)
  const task = await setup.service.save(draft())
  await setup.service.run(task.id, task.revision, 'first')
  await setup.service.run(task.id, task.revision, 'second')
  await setup.service.close()
  await replaceState(setup, data => {
    data.runs[0].status = 'preparing'
    data.runs[0].finishedAt = null
    data.runs[0].sendStartedAt = null
    data.runs[0].payloadHash = null
    data.runs[0].itemCount = null
    data.runs[1].status = 'sending'
    data.runs[1].finishedAt = null
  })
  await setup.restart()
  assert.deepEqual((await setup.service.list()).runs.map(run => run.status), ['unknown', 'cancelled'])
  assert.equal(setup.sent.length, 2)
  await setup.service.close()
  await replaceState(setup, data => { data.runs[0].snapshot.targetId = 'tampered' })
  await assert.rejects(runtime.openScheduler(setup.options), /corrupt|digest/i)
})

test('log trimming preserves occurrence and manual-request deduplication', async context => {
  const setup = await fixture(context)
  const task = await setup.service.save(draft())
  await setup.service.run(task.id, task.revision, 'original')
  setup.at('2026-09-19T11:00:00Z')
  await setup.service.tick()
  await setup.service.close()
  await replaceState(setup, data => {
    const base = data.runs[0]
    data.runs = Array.from({ length: 1000 }, (_, index) => ({ ...base, id: randomUUID(), occurrenceKey: `manual:fixture-${index}` }))
  })
  await setup.restart()
  await setup.service.tick()
  assert.equal(setup.sent.length, 2)
  await assert.rejects(setup.service.run(task.id, task.revision, 'original'), /already executed/i)
  await setup.service.run(task.id, task.revision, 'new')
  assert.equal((await setup.service.list()).runs.length, 1000)
  assert.equal(setup.sent.length, 3)
})

test('close aborts a hanging send and persists unknown before releasing the lock', async context => {
  let entered = false
  const setup = await fixture(context, { send: async () => { entered = true; return new Promise(() => {}) } })
  const task = await setup.service.save(draft())
  const running = setup.service.run(task.id, task.revision, 'hanging-send')
  await eventually(() => entered)
  await setup.service.close()
  assert.equal((await running).status, 'unknown')
  await setup.restart()
  assert.equal((await setup.service.list()).runs[0].status, 'unknown')
})

test('dependencies cannot mutate the immutable run snapshot', async context => {
  let immutable = false
  const setup = await fixture(context, { preview: async task => {
    try { task.targetId = 'wrong' } catch { immutable = true }
    return { text: 'sensitive product body', itemCount: 1 }
  } })
  const task = await setup.service.save(draft())
  await setup.service.run(task.id, task.revision, 'snapshot')
  assert.equal(immutable, true)
  assert.equal(setup.sent[0].task.targetId, 'group-1')
  assert.equal((await readFile(setup.stateFile, 'utf8')).includes('sensitive product body'), false)
})

test('preview and send time out without cooperation; late completion does not send or change unknown', async context => {
  const gate = deferred()
  let entered = false
  const setup = await fixture(context, { send: async () => { entered = true; return gate.promise } })
  const task = await setup.service.save(draft())
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const running = setup.service.run(task.id, task.revision, 'timeout')
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  context.mock.timers.tick(10_001)
  assert.equal((await running).status, 'unknown')
  const next = setup.service.run(task.id, task.revision, 'still-in-flight')
  const check = assert.rejects(next, /busy/i)
  await new Promise(resolve => setImmediate(resolve))
  gate.resolve()
  await check
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await setup.service.list()).runs[0].status, 'unknown')
  context.mock.timers.reset()
})

test('public errors are SchedulerError and known pre-delivery failures are explicit', async context => {
  const setup = await fixture(context, { send: async () => {
    const error = new Error('机器人不存在')
    error.name = 'IntegrationError'
    error.code = 'unknown-bot'
    throw error
  } })
  await assert.rejects(setup.service.save(draft({ enabled: 'wrong' })), { name: 'SchedulerError' })
  const task = await setup.service.save(draft())
  assert.equal((await setup.service.run(task.id, task.revision, 'known-failure')).status, 'send_failed')
})

test('timer polls at one second and stops on close', async context => {
  const setup = await fixture(context)
  await setup.service.save(draft())
  await setup.service.close()
  const service = await runtime.openScheduler({ ...setup.options, autoStart: true })
  context.after(() => service.close())
  setup.at('2026-09-19T11:00:00Z')
  await eventually(() => setup.sent.length === 1)
  await service.close()
  setup.at('2026-09-20T11:00:00Z')
  assert.equal(setup.sent.length, 1)
})

test('capacity is 200 live tasks; deleting frees capacity and retains run audit', async context => {
  const setup = await fixture(context)
  const task = await setup.service.save(draft())
  await setup.service.run(task.id, task.revision, 'audit')
  await setup.service.close()
  await replaceState(setup, data => {
    data.tasks.push(...Array.from({ length: 199 }, () => ({ ...data.tasks[0], id: randomUUID(), manualRequests: [] })))
  })
  await setup.restart()
  await assert.rejects(setup.service.save(draft()), /limit/i)
  await setup.service.remove(task.id, task.revision)
  await setup.service.save(draft())
  const view = await setup.service.list()
  assert.equal(view.tasks.length, 200)
  assert.equal(view.runs[0].taskId, task.id)
  await setup.restart()
  assert.equal((await setup.service.list()).runs.length, 1)
})

test('receipt write failure leaves durable sending and recovers to unknown', async context => {
  let setup
  let calls = 0
  setup = await fixture(context, { send: async () => {
    calls++
    await rename(setup.stateFile, `${setup.stateFile}.backup`)
    await mkdir(setup.stateFile)
  } })
  const task = await setup.service.save(draft())
  await assert.rejects(setup.service.run(task.id, task.revision, 'receipt-failure'), /storage/i)
  assert.equal(calls, 1)
  await rm(setup.stateFile, { recursive: true })
  await rename(`${setup.stateFile}.backup`, setup.stateFile)
  await setup.restart()
  const result = await setup.service.run(task.id, task.revision, 'receipt-failure')
  assert.equal(result.status, 'unknown')
  assert.equal(calls, 1)
})

test('query timeout never sends later even when ignored signal eventually resolves', async context => {
  const gate = deferred()
  let entered = false
  const setup = await fixture(context, { preview: async () => { entered = true; return gate.promise } })
  const task = await setup.service.save(draft())
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const running = setup.service.run(task.id, task.revision, 'query-timeout')
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  context.mock.timers.tick(10_001)
  assert.equal((await running).status, 'query_failed')
  gate.resolve({ text: 'late products', itemCount: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(setup.sent.length, 0)
  context.mock.timers.reset()
})

test('scheduled saturation records missed work and never queues backlog', async context => {
  const gate = deferred()
  let count = 0
  const setup = await fixture(context, { preview: async () => {
    count++
    await gate.promise
    return { text: '商品', itemCount: 1 }
  } })
  for (let index = 0; index < 6; index++) await setup.service.save(draft({ name: `任务${index}` }))
  setup.at('2026-09-19T11:00:00Z')
  const ticking = setup.service.tick()
  await eventually(() => count === 4)
  assert.equal((await setup.service.list()).runs.filter(run => run.status === 'missed').length, 2)
  gate.resolve()
  await ticking
  await setup.service.tick()
  assert.equal(setup.sent.length, 4)
})

test('concurrent stale edits cannot both commit and lookup does not hold the write queue', async context => {
  const setup = await fixture(context)
  const task = await setup.service.save(draft())
  const gate = deferred()
  let resolving = false
  setup.dependencies.resolveTarget = async () => { resolving = true; await gate.promise; return { targetId: 'group-1', targetName: '群' } }
  const editing = setup.service.save({ ...task, name: 'stale edit' })
  await eventually(() => resolving)
  const paused = await setup.service.toggle(task.id, task.revision, false)
  gate.resolve()
  await assert.rejects(editing, /conflict/i)
  assert.equal((await setup.service.list()).tasks[0].revision, paused.revision)
})

test('manual request ledger has a hard limit without evicting old deduplication keys', async context => {
  const setup = await fixture(context)
  const task = await setup.service.save(draft())
  await setup.service.run(task.id, task.revision, 'original')
  await setup.service.close()
  await replaceState(setup, data => {
    data.tasks[0].manualRequests.push(...Array.from({ length: 999 }, (_, index) => hash(`old-${index}`)))
  })
  await setup.restart()
  await setup.service.run(task.id, task.revision, 'original')
  await assert.rejects(setup.service.run(task.id, task.revision, 'overflow'), /limit/i)
  assert.equal(setup.sent.length, 1)
  const disk = JSON.parse(await readFile(setup.stateFile, 'utf8'))
  assert.equal(disk.tasks[0].manualRequests.length, 1000)
})

test('tick storage failure emits one fixed safe error instead of silently retrying forever', async context => {
  const setup = await fixture(context)
  await setup.service.save(draft())
  const log = context.mock.method(console, 'error', () => {})
  await rename(setup.stateFile, `${setup.stateFile}.backup`)
  await mkdir(setup.stateFile)
  setup.at('2026-09-19T11:00:00Z')
  await assert.rejects(setup.service.tick(), /storage/i)
  await assert.rejects(setup.service.tick(), /storage/i)
  assert.equal(log.mock.callCount(), 1)
  const output = JSON.stringify(log.mock.calls[0].arguments)
  assert.match(output, /scheduler.tick_failed/)
  assert.equal(output.includes(setup.stateFile), false)
  assert.equal(setup.sent.length, 0)
  await rm(setup.stateFile, { recursive: true })
  await rename(`${setup.stateFile}.backup`, setup.stateFile)
})

test('creationId deduplicates a lost save response across restart and only sends once', async context => {
  const setup = await fixture(context)
  const input = draft({ creationId: randomUUID() })
  const first = await setup.service.save(input)
  assert.equal(first.creationId, input.creationId)
  assert.deepEqual(await setup.service.save(input), first)
  await setup.restart()
  assert.deepEqual(await setup.service.save(input), first)
  assert.equal((await setup.service.list()).tasks.length, 1)
  setup.at('2026-09-19T11:00:00Z')
  await setup.service.tick()
  assert.equal(setup.sent.length, 1)
})

test('concurrent creation retries reserve a single task and mismatched content conflicts', async context => {
  const gate = deferred()
  let entered = 0
  const setup = await fixture(context, { resolveTarget: async () => {
    entered++
    await gate.promise
    return { targetId: 'group-1', targetName: '群' }
  } })
  const input = draft({ creationId: randomUUID() })
  const first = setup.service.save(input)
  const second = setup.service.save(input)
  await eventually(() => entered === 2)
  gate.resolve()
  const saved = await Promise.all([first, second])
  assert.equal(saved[0].id, saved[1].id)
  assert.equal((await setup.service.list()).tasks.length, 1)
  await assert.rejects(setup.service.save({ ...input, description: 'different retry' }), /conflict.*refresh/i)
})

test('creation retries remain idempotent after a once task has completed', async context => {
  const setup = await fixture(context)
  const input = draft({ creationId: randomUUID(), kind: 'once', time: '2026-09-19 19:00' })
  const first = await setup.service.save(input)
  setup.at('2026-09-19T11:00:01Z')
  await setup.service.tick()
  await setup.restart()
  const repeated = await setup.service.save(input)
  assert.equal(repeated.id, first.id)
  assert.equal(repeated.status, 'completed')
  assert.equal(setup.sent.length, 1)
})

test('deleted creation tombstones survive cleanup, edits and restart', async context => {
  const setup = await fixture(context)
  const input = draft({ creationId: randomUUID() })
  const first = await setup.service.save(input)
  const { creationId, ...withoutCreationId } = first
  const edited = await setup.service.save({ ...withoutCreationId, name: 'edited' })
  assert.equal(edited.creationId, input.creationId)
  await assert.rejects(setup.service.save({ ...edited, creationId: randomUUID() }), /creationId|conflict/i)
  await setup.service.remove(edited.id, edited.revision)
  await setup.service.save(draft())
  await setup.restart()
  await assert.rejects(setup.service.save(input), /conflict.*refresh/i)
  assert.equal((await setup.service.list()).tasks.length, 1)
  await assert.rejects(setup.service.save(draft({ creationId: 'invalid' })), /creationId/i)
})

test('creation tombstones count toward the bounded task limit', async context => {
  const setup = await fixture(context)
  const first = await setup.service.save(draft({ creationId: randomUUID() }))
  await setup.service.remove(first.id, first.revision)
  await setup.service.close()
  await replaceState(setup, data => {
    data.tasks.push(...Array.from({ length: 199 }, () => ({ ...data.tasks[0], id: randomUUID(), creationId: randomUUID() })))
  })
  await setup.restart()
  await assert.rejects(setup.service.save(draft({ creationId: randomUUID() })), /limit/i)
})

test('manual retry returns the original result after edit and pause despite an old revision', async context => {
  const setup = await fixture(context)
  const task = await setup.service.save(draft())
  const first = await setup.service.run(task.id, task.revision, 'lost-response')
  const edited = await setup.service.save({ ...task, name: 'edited' })
  assert.deepEqual(await setup.service.run(task.id, task.revision, 'lost-response'), first)
  const paused = await setup.service.toggle(task.id, edited.revision, false)
  await setup.restart()
  assert.deepEqual(await setup.service.run(task.id, task.revision, 'lost-response'), first)
  await assert.rejects(setup.service.run(task.id, task.revision, 'new-request'), /revision|conflict/i)
  assert.equal(setup.sent.length, 1)
  await setup.service.remove(task.id, paused.revision)
  await assert.rejects(setup.service.run(task.id, task.revision, 'lost-response'), /not found/i)
})

test('a queued creation retry does not cancel a run started after the first save', async context => {
  const lookupGate = deferred()
  const previewGate = deferred()
  let lookups = 0
  let previewStarted = false
  const setup = await fixture(context, {
    resolveTarget: async () => {
      lookups++
      if (lookups === 2) await lookupGate.promise
      return { targetId: 'group-1', targetName: '群' }
    },
    preview: async () => { previewStarted = true; await previewGate.promise; return { text: '商品', itemCount: 1 } },
  })
  const input = draft({ creationId: randomUUID() })
  const first = setup.service.save(input)
  const repeated = setup.service.save(input)
  const task = await first
  const running = setup.service.run(task.id, task.revision, 'concurrent-run')
  await eventually(() => previewStarted)
  lookupGate.resolve()
  assert.equal((await repeated).id, task.id)
  previewGate.resolve()
  assert.equal((await running).status, 'accepted')
  assert.equal(setup.sent.length, 1)
})
