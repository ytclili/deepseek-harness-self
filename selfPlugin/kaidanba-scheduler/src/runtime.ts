import { randomUUID, createHash } from 'node:crypto'
import type { Preview, SchedulerApi, TaskDraft, TaskRecord } from './shared.ts'
import { advance, digest, identifier, invariant, makeRun, MAX_MANUAL_REQUESTS, nextTime, publicTask, SchedulerError, stringValue, validateDraft } from './runtime/model.ts'
import type { State, StoredRun, StoredTask } from './runtime/model.ts'
import { openStore } from './runtime/store.ts'

export type SchedulerDependencies = {
  resolveTarget: (draft: TaskDraft, signal: AbortSignal) => Promise<{ targetId: string; targetName: string }>
  preview: (task: TaskRecord, signal: AbortSignal) => Promise<Preview>
  send: (task: TaskRecord, text: string, signal: AbortSignal) => Promise<void>
}
export type SchedulerService = SchedulerApi & { tick: () => Promise<void>; close: () => Promise<void> }
export type SchedulerOptions = { stateFile: string; dependencies: SchedulerDependencies; now?: () => number; autoStart?: boolean }
const CALL_TIMEOUT = 10_000
const MAX_CONCURRENT = 4
type ActiveRun = { id: string; taskId: string; controller: AbortController; promise: Promise<StoredRun> }
export { SchedulerError } from './runtime/model.ts'
const INTEGRATION_ERRORS: Record<string, string> = {
  'unknown-bot': '机器人不存在或平台不匹配',
  'unknown-target': '收件目标不存在或不属于该机器人',
  'invalid-response': '服务返回的数据格式无效',
  'invalid-goods': '商品字段格式不正确，未发送消息',
  'incomplete-goods': '商品数据不完整',
  'message-too-long': '商品消息超过长度限制',
  'goods-query-failed': '商品查询失败',
  'delivery-unknown': '消息投递结果不明',
}

function safeError(error: unknown): SchedulerError {
  if (error instanceof SchedulerError) return error
  const integration = error as { name?: string; code?: string } | null
  if (integration?.name === 'IntegrationError' && integration.code && Object.hasOwn(INTEGRATION_ERRORS, integration.code)) {
    return new SchedulerError(INTEGRATION_ERRORS[integration.code], integration.code)
  }
  return new SchedulerError('外部服务调用失败，未记录敏感详情')
}

export async function openScheduler({ stateFile, dependencies, now = Date.now, autoStart = true }: SchedulerOptions): Promise<SchedulerService> {
  invariant(dependencies && ['resolveTarget', 'preview', 'send'].every(key => typeof dependencies[key as keyof SchedulerDependencies] === 'function'), 'Invalid scheduler dependencies')
  invariant(typeof now === 'function' && typeof autoStart === 'boolean', 'Invalid scheduler options')
  const clock = () => {
    const value = now()
    invariant(Number.isFinite(value) && Math.abs(value) <= 8.64e15, 'Invalid scheduler clock')
    return value
  }
  clock()
  const store = await openStore(stateFile)
  const lifetime = new AbortController()
  const active = new Map<string, ActiveRun>()
  const operations = new Set<Promise<unknown>>()
  const pendingCalls = new Map<string, number>()
  let closing = false
  let closePromise: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<void> | undefined
  let externalCount = 0
  let reportedTickFailure = false

  const assertOpen = () => {
    invariant(!closing, 'Scheduler closed')
    if (store.failure) throw store.failure
  }
  const track = <Result>(operation: Promise<Result>): Promise<Result> => {
    operations.add(operation)
    void operation.then(() => operations.delete(operation), () => operations.delete(operation))
    return operation
  }
  async function external<Result>(invoke: (signal: AbortSignal) => Promise<Result>, parent = lifetime.signal, taskId?: string): Promise<Result> {
    if (store.failure) throw store.failure
    invariant(!parent.aborted, 'Operation cancelled')
    invariant(externalCount < MAX_CONCURRENT, 'Scheduler busy')
    const controller = new AbortController()
    externalCount++
    if (taskId) pendingCalls.set(taskId, (pendingCalls.get(taskId) ?? 0) + 1)
    const settled = () => {
      externalCount--
      if (taskId) {
        const remaining = pendingCalls.get(taskId)! - 1
        if (remaining) pendingCalls.set(taskId, remaining)
        else pendingCalls.delete(taskId)
      }
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abort: () => void = () => {}
    try {
      return await new Promise<Result>((resolve, reject) => {
        abort = () => { controller.abort(); reject(new SchedulerError('Operation cancelled')) }
        parent.addEventListener('abort', abort, { once: true })
        timeout = setTimeout(() => { controller.abort(); reject(new SchedulerError('Dependency timeout')) }, CALL_TIMEOUT)
        Promise.resolve().then(() => {
          invariant(!controller.signal.aborted, 'Operation cancelled')
          return invoke(controller.signal)
        }).then(value => { settled(); resolve(value) }, error => { settled(); reject(safeError(error)) })
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      parent.removeEventListener('abort', abort)
    }
  }
  function findTask(state: State, id: string, revision?: number): StoredTask {
    identifier(id)
    const task = state.tasks.find(entry => entry.id === id && entry.status !== 'deleted')
    invariant(task, 'Task not found')
    if (revision !== undefined) invariant(Number.isSafeInteger(revision) && revision === task.revision, 'Task revision conflict')
    return task
  }
  function findCreation(state: State, draft: TaskDraft, creationDigest: string | undefined): TaskRecord | undefined {
    if (draft.id || !draft.creationId) return
    const previous = state.tasks.find(task => task.creationId === draft.creationId)
    if (!previous) return
    invariant(previous.status !== 'deleted' && previous.creationDigest === creationDigest, 'Creation request conflict; refresh the task list before saving')
    return publicTask(previous)
  }
  function cancelPreparing(state: State, id: string): void {
    for (const run of state.runs) if (run.taskId === id && run.status === 'preparing') {
      run.status = 'cancelled'
      run.finishedAt = new Date(clock()).toISOString()
      run.detail = 'Task changed before sending'
    }
  }
  function abortPreparing(id: string): void {
    const running = active.get(id)
    if (running && store.value.runs.find(run => run.id === running.id)?.status !== 'sending') running.controller.abort()
  }
  function validatePreview(result: Preview): Preview {
    invariant(result && typeof result.text === 'string' && result.text.trim().length > 0 && result.text.length <= 1_000_000 && Number.isSafeInteger(result.itemCount) && result.itemCount >= 0, 'Invalid preview response')
    return { text: result.text, itemCount: result.itemCount }
  }
  async function verifyTarget(task: TaskRecord, signal = lifetime.signal): Promise<void> {
    const target = await external(abortSignal => dependencies.resolveTarget(Object.freeze(validateDraft(task, 0, false)), abortSignal), signal, task.id)
    invariant(target && target.targetId === task.targetId, 'Saved target identity changed; save the task again')
  }
  async function finish(id: string, status: StoredRun['status'], detail: string): Promise<StoredRun> {
    return store.change(state => {
      const run = state.runs.find(entry => entry.id === id)!
      invariant(run, 'Run missing')
      if (run.status !== 'preparing' && run.status !== 'sending') return run
      run.status = status
      run.finishedAt = new Date(clock()).toISOString()
      run.detail = detail
      return run
    })
  }
  async function execute(run: StoredRun, controller: AbortController): Promise<StoredRun> {
    const snapshot = Object.freeze(structuredClone(run.snapshot))
    invariant(digest(snapshot) === run.snapshotDigest, 'Corrupt snapshot digest')
    let preview: Preview
    try {
      await verifyTarget(snapshot, controller.signal)
      preview = validatePreview(await external(signal => dependencies.preview(snapshot, signal), controller.signal, snapshot.id))
    } catch (error) {
      return finish(run.id, controller.signal.aborted ? 'cancelled' : 'query_failed', controller.signal.aborted ? 'Cancelled before sending' : safeError(error).message)
    }
    const prepared = await store.change(state => {
      const current = state.runs.find(entry => entry.id === run.id)!
      const task = state.tasks.find(entry => entry.id === run.taskId)
      if (current.status !== 'preparing') return current
      if (closing || controller.signal.aborted || !task || task.revision !== snapshot.revision || task.status === 'deleted' || task.status === 'paused') {
        current.status = 'cancelled'
        current.finishedAt = new Date(clock()).toISOString()
        current.detail = 'Cancelled before sending'
      } else {
        invariant(digest(current.snapshot) === current.snapshotDigest, 'Corrupt snapshot digest')
        current.status = 'sending'
        current.sendStartedAt = new Date(clock()).toISOString()
        current.payloadHash = createHash('sha256').update(preview.text).digest('hex')
        current.itemCount = preview.itemCount
      }
      return current
    })
    if (prepared.status !== 'sending') return prepared
    let status: StoredRun['status'] = 'accepted'
    let detail = 'Delivery accepted'
    try {
      await external(signal => dependencies.send(snapshot, preview.text, signal), controller.signal, snapshot.id)
    } catch (error) {
      const failure = safeError(error)
      status = failure.code === 'unknown-bot' || failure.code === 'unknown-target' ? 'send_failed' : 'unknown'
      detail = `${failure.message}; automatic retry disabled`
    }
    return finish(run.id, status, detail)
  }
  function launch(run: StoredRun): Promise<StoredRun> {
    const controller = new AbortController()
    if (closing) controller.abort()
    const promise = Promise.resolve().then(() => execute(run, controller))
    active.set(run.taskId, { id: run.id, taskId: run.taskId, controller, promise })
    const result = promise.finally(() => { active.delete(run.taskId) })
    active.get(run.taskId)!.promise = result
    return track(result)
  }

  try {
    const startup = clock()
    await store.change(state => {
      for (const run of state.runs) if (run.status === 'preparing' || run.status === 'sending') {
        const uncertain = run.status === 'sending'
        run.status = uncertain ? 'unknown' : 'cancelled'
        run.finishedAt = new Date(startup).toISOString()
        run.detail = uncertain ? 'Interrupted sending; outcome unknown' : 'Interrupted preparation cancelled'
      }
      for (const task of state.tasks) if (task.status === 'active' && task.nextRunAt && Date.parse(task.nextRunAt) < startup) {
        const scheduledAt = task.nextRunAt
        const occurrence = `${task.revision}:${scheduledAt}`
        state.runs.push(makeRun(task, occurrence, 'scheduled', scheduledAt, startup, 'missed'))
        advance(task, scheduledAt, occurrence, startup)
      }
    })
  } catch (error) { await store.close(); throw error }

  const service: SchedulerService = {
    async list(signal) {
      assertOpen()
      invariant(!signal?.aborted, 'Operation cancelled')
      return { tasks: store.value.tasks.filter(task => task.status !== 'deleted').map(publicTask), runs: structuredClone(store.value.runs).reverse() }
    },
    save(input) {
      return track((async () => {
        assertOpen()
        const draft = validateDraft(input, clock(), false)
        const creationDigest = !draft.id && draft.creationId ? digest(draft) : undefined
        const existing = findCreation(store.value, draft, creationDigest)
        if (existing) return existing
        validateDraft(draft, clock())
        if (draft.id) findTask(store.value, draft.id, draft.revision)
        const target = await external(signal => dependencies.resolveTarget(Object.freeze({ ...draft }), signal))
        const targetId = identifier(target?.targetId, 'resolved targetId')
        const targetName = stringValue(target?.targetName, 'targetName', 200, true)
        assertOpen()
        const saved = await store.change(state => {
          assertOpen()
          const existing = findCreation(state, draft, creationDigest)
          if (existing) return existing
          validateDraft(draft, clock())
          const previous = draft.id ? findTask(state, draft.id, draft.revision) : undefined
          if (previous) invariant(draft.creationId === undefined || draft.creationId === previous.creationId, 'creationId is immutable; refresh the task list before saving')
          if (!previous) {
            state.tasks = state.tasks.filter(task => task.status !== 'deleted' || task.creationId !== undefined)
            invariant(state.tasks.length < 200, 'Task limit reached (200, including creation request tombstones)')
          }
          const timestamp = new Date(clock()).toISOString()
          const task: StoredTask = { ...draft, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1,
            ...(previous?.creationId ? { creationId: previous.creationId, creationDigest: previous.creationDigest } : creationDigest ? { creationDigest } : {}),
            targetId, targetName, status: draft.enabled ? 'active' : 'paused', nextRunAt: draft.enabled ? nextTime(draft, clock()) : null,
            lastOccurrence: previous?.lastOccurrence ?? null, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp,
            manualRequests: previous?.manualRequests ?? [] }
          if (previous) {
            cancelPreparing(state, previous.id)
            state.tasks[state.tasks.indexOf(previous)] = task
          } else state.tasks.push(task)
          return publicTask(task)
        })
        if (draft.id) abortPreparing(saved.id)
        return saved
      })())
    },
    toggle(id, revision, enabled) {
      return track((async () => {
        assertOpen()
        invariant(typeof enabled === 'boolean', 'Invalid enabled boolean')
        invariant(Number.isSafeInteger(revision) && revision > 0, 'Invalid revision')
        const task = await store.change(state => {
          assertOpen()
          const current = findTask(state, id, revision)
          if (enabled) validateDraft(current, clock())
          cancelPreparing(state, id)
          current.revision++
          current.enabled = enabled
          current.status = enabled ? 'active' : 'paused'
          current.nextRunAt = enabled ? nextTime(current, clock()) : null
          current.updatedAt = new Date(clock()).toISOString()
          return publicTask(current)
        })
        abortPreparing(id)
        return task
      })())
    },
    remove(id, revision) {
      return track((async () => {
        assertOpen()
        invariant(Number.isSafeInteger(revision) && revision > 0, 'Invalid revision')
        await store.change(state => {
          assertOpen()
          const task = findTask(state, id, revision)
          cancelPreparing(state, id)
          task.status = 'deleted'
          task.enabled = false
          task.nextRunAt = null
          task.revision++
          task.updatedAt = new Date(clock()).toISOString()
        })
        abortPreparing(id)
      })())
    },
    preview(id) {
      return track((async () => {
        assertOpen()
        const task = Object.freeze(publicTask(findTask(store.value, id)))
        await verifyTarget(task)
        return validatePreview(await external(signal => dependencies.preview(task, signal), lifetime.signal, task.id))
      })())
    },
    run(id, revision, requestId) {
      return track((async () => {
        assertOpen()
        const key = `manual:${digest(identifier(requestId, 'requestId'))}`
        const reservation = await store.change(state => {
          assertOpen()
          const task = findTask(state, id)
          const previous = state.runs.find(run => run.taskId === id && run.occurrenceKey === key)
          if (previous) return { run: previous, fresh: false }
          invariant(Number.isSafeInteger(revision) && revision > 0, 'Invalid revision')
          findTask(state, id, revision)
          invariant(!task.manualRequests.includes(key.slice(7)), 'Request already executed; audit record expired')
          invariant(task.manualRequests.length < MAX_MANUAL_REQUESTS, 'Manual request limit reached (1000); existing deduplication keys are retained')
          invariant(!active.has(id) && !pendingCalls.has(id) && externalCount < MAX_CONCURRENT && state.runs.filter(run => run.status === 'preparing' || run.status === 'sending').length < MAX_CONCURRENT && !state.runs.some(run => run.taskId === id && (run.status === 'preparing' || run.status === 'sending')), 'Scheduler busy')
          invariant(task.status === 'active', 'Task is not active')
          const timestamp = clock()
          const run = makeRun(task, key, 'manual', new Date(timestamp).toISOString(), timestamp, 'preparing')
          task.manualRequests.push(key.slice(7))
          state.runs.push(run)
          return { run, fresh: true }
        })
        if (reservation.fresh) return launch(reservation.run)
        return active.get(id)?.id === reservation.run.id ? active.get(id)!.promise : reservation.run
      })())
    },
    tick() {
      if (ticking) return ticking
      ticking = track((async () => {
        assertOpen()
        const timestamp = clock()
        if (!store.value.tasks.some(task => task.status === 'active' && task.nextRunAt && Date.parse(task.nextRunAt) <= timestamp)) return
        const runs = await store.change(state => {
          assertOpen()
          const reserved: StoredRun[] = []
          for (const task of state.tasks) {
            if (task.status !== 'active' || !task.nextRunAt || Date.parse(task.nextRunAt) > timestamp) continue
            const scheduledAt = task.nextRunAt
            const occurrence = `${task.revision}:${scheduledAt}`
            if (task.lastOccurrence === occurrence) {
              advance(task, scheduledAt, occurrence, timestamp)
              continue
            }
            const busy = active.has(task.id) || pendingCalls.has(task.id) || externalCount >= MAX_CONCURRENT || state.runs.filter(run => run.status === 'preparing' || run.status === 'sending').length >= MAX_CONCURRENT || state.runs.some(run => run.taskId === task.id && (run.status === 'preparing' || run.status === 'sending'))
            const run = makeRun(task, occurrence, 'scheduled', scheduledAt, timestamp, busy || timestamp - Date.parse(scheduledAt) > 60_000 ? 'missed' : 'preparing')
            state.runs.push(run)
            advance(task, scheduledAt, occurrence, timestamp)
            if (run.status === 'preparing') reserved.push(run)
          }
          return reserved
        })
        await Promise.all(runs.map(launch))
      })()).catch(error => {
        if (!reportedTickFailure && (!closing || store.failure)) {
          reportedTickFailure = true
          console.error('level=error event=scheduler.tick_failed message="定时器执行失败，请检查存储与服务配置后重启；未记录敏感详情"')
        }
        if (store.failure && timer) clearInterval(timer)
        throw error
      }).finally(() => { ticking = undefined })
      return ticking
    },
    close() {
      if (closePromise) return closePromise
      closing = true
      if (timer) clearInterval(timer)
      lifetime.abort()
      for (const running of active.values()) running.controller.abort()
      closePromise = (async () => {
        await Promise.allSettled([...operations])
        await store.close()
      })()
      return closePromise
    },
  }
  if (autoStart) {
    timer = setInterval(() => { void service.tick().catch(() => {}) }, 1000)
    timer.unref()
  }
  return service
}
