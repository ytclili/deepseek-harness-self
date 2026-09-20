import { createHash, randomUUID } from 'node:crypto'
import type { RunRecord, RunStatus, TaskDraft, TaskRecord } from '../shared.ts'

export type StoredTask = TaskRecord & { manualRequests: string[]; creationDigest?: string }
export type StoredRun = RunRecord & {
  occurrenceKey: string
  snapshot: TaskRecord
  snapshotDigest: string
  sendStartedAt: string | null
  payloadHash: string | null
  itemCount: number | null
}
export type State = { schemaVersion: 1; revision: number; tasks: StoredTask[]; runs: StoredRun[] }
export const DAY = 86_400_000
export const MAX_MANUAL_REQUESTS = 1000
const OFFSET = 8 * 3_600_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUSES: RunStatus[] = ['preparing', 'query_failed', 'sending', 'accepted', 'send_failed', 'unknown', 'missed', 'cancelled']

export class SchedulerError extends Error {
  code?: string
  constructor(message: string, code?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SchedulerError'
    this.code = code
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SchedulerError(message)
}

export function stringValue(value: unknown, label: string, limit: number, empty = false): string {
  invariant(typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value), `Invalid ${label}`)
  return value
}

export function identifier(value: unknown, label = 'id'): string {
  return stringValue(value, label, 512)
}

export function onceTime(value: string): number {
  invariant(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(value), 'Invalid once time: YYYY-MM-DD HH:mm required')
  const result = Date.parse(`${value.replace(' ', 'T')}:00+08:00`)
  invariant(Number.isFinite(result) && new Date(result + OFFSET).toISOString().slice(0, 16).replace('T', ' ') === value, 'Invalid calendar date')
  return result
}

export function validateDraft(input: TaskDraft, now: number, future = true): TaskDraft {
  invariant(input !== null && typeof input === 'object', 'Invalid draft')
  const name = stringValue(input.name, 'name', 80).trim()
  invariant(typeof input.description === 'string' && input.description.length <= 500 && !input.description.includes('\0'), 'Invalid description')
  invariant(input.kind === 'once' || input.kind === 'daily', 'Invalid schedule kind')
  invariant(typeof input.time === 'string', 'Invalid time')
  if (input.kind === 'daily') invariant(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time), 'Invalid daily time: HH:mm required')
  else invariant(!future || onceTime(input.time) > now, 'Once time must be in the future')
  if (input.kind === 'once') onceTime(input.time)
  invariant(input.platform === 'feishu' || input.platform === 'weixin', 'Invalid platform')
  invariant(typeof input.enabled === 'boolean', 'Invalid enabled boolean')
  if (input.creationId !== undefined) invariant(typeof input.creationId === 'string' && UUID.test(input.creationId), 'Invalid creationId UUID')
  if (input.id !== undefined) invariant(typeof input.id === 'string' && UUID.test(input.id), 'Invalid task id')
  if (input.id !== undefined || input.revision !== undefined) invariant(Number.isSafeInteger(input.revision) && input.revision! > 0 && input.id !== undefined, 'Invalid revision')
  return { ...(input.id === undefined ? {} : { id: input.id, revision: input.revision }),
    ...(input.creationId === undefined ? {} : { creationId: input.creationId.toLowerCase() }), name, description: input.description,
    kind: input.kind, time: input.time, platform: input.platform, botId: identifier(input.botId, 'botId'), targetId: identifier(input.targetId, 'targetId'), enabled: input.enabled }
}

export function nextTime(task: TaskDraft, now: number): string {
  if (task.kind === 'once') return new Date(onceTime(task.time)).toISOString()
  const date = new Date(now + OFFSET).toISOString().slice(0, 10)
  let result = Date.parse(`${date}T${task.time}:00+08:00`)
  if (result <= now) result += DAY
  return new Date(result).toISOString()
}

export function publicTask(task: StoredTask): TaskRecord {
  const { manualRequests, creationDigest, ...record } = task
  return structuredClone(record)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function makeRun(task: StoredTask, occurrenceKey: string, trigger: 'manual' | 'scheduled', scheduledAt: string, now: number, status: RunStatus): StoredRun {
  const snapshot = publicTask(task)
  return { id: randomUUID(), taskId: task.id, taskName: task.name, occurrenceKey, trigger, scheduledAt,
    startedAt: new Date(now).toISOString(), finishedAt: status === 'missed' ? new Date(now).toISOString() : null,
    status, detail: status === 'missed' ? 'Occurrence missed; no automatic replay' : '', snapshot,
    snapshotDigest: digest(snapshot), sendStartedAt: null, payloadHash: null, itemCount: null }
}

export function advance(task: StoredTask, scheduledAt: string, occurrenceKey: string, now: number): void {
  task.lastOccurrence = occurrenceKey
  task.updatedAt = new Date(now).toISOString()
  if (task.kind === 'once') {
    task.status = 'completed'
    task.enabled = false
    task.nextRunAt = null
  } else task.nextRunAt = nextTime(task, Math.max(now, Date.parse(scheduledAt)))
}

function iso(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function validateTask(task: TaskRecord): void {
  validateDraft(task, 0, false)
  invariant(UUID.test(task.id) && Number.isSafeInteger(task.revision) && task.revision > 0, 'Corrupt task identity')
  stringValue(task.targetName, 'targetName', 200, true)
  invariant(['active', 'paused', 'completed', 'deleted'].includes(task.status), 'Corrupt task status')
  invariant(iso(task.createdAt) && iso(task.updatedAt), 'Corrupt task timestamps')
  invariant(task.lastOccurrence === null || typeof task.lastOccurrence === 'string', 'Corrupt lastOccurrence')
  invariant(task.enabled === (task.status === 'active'), 'Corrupt enabled status')
  invariant(task.status === 'active' ? iso(task.nextRunAt) : task.nextRunAt === null, 'Corrupt nextRunAt')
  if (task.nextRunAt !== null) {
    if (task.kind === 'once') invariant(Date.parse(task.nextRunAt) === onceTime(task.time), 'Corrupt once schedule')
    else invariant(new Date(Date.parse(task.nextRunAt) + OFFSET).toISOString().slice(11, 19) === `${task.time}:00`, 'Corrupt daily schedule')
  }
}

export function validateState(input: unknown): asserts input is State {
  const state = input as State
  invariant(state && state.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0, 'Corrupt or unsupported scheduler schema')
  invariant(Array.isArray(state.tasks) && state.tasks.length <= 200 && Array.isArray(state.runs) && state.runs.length <= 1000, 'Corrupt state limits')
  const ids = new Set<string>()
  const creationIds = new Set<string>()
  for (const task of state.tasks) {
    validateTask(task)
    invariant(!ids.has(task.id), 'Corrupt duplicate task')
    ids.add(task.id)
    if (task.creationId !== undefined) {
      invariant(task.creationId === task.creationId.toLowerCase() && !creationIds.has(task.creationId) && typeof task.creationDigest === 'string' && /^[a-f0-9]{64}$/.test(task.creationDigest), 'Corrupt creation request identity or digest')
      creationIds.add(task.creationId)
    } else invariant(task.creationDigest === undefined, 'Corrupt orphan creation digest')
    invariant(Array.isArray(task.manualRequests) && task.manualRequests.length <= MAX_MANUAL_REQUESTS && task.manualRequests.every(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) && new Set(task.manualRequests).size === task.manualRequests.length, 'Corrupt manual deduplication')
  }
  const runs = new Set<string>()
  const occurrences = new Set<string>()
  for (const run of state.runs) {
    invariant(run && UUID.test(run.id) && UUID.test(run.taskId) && !runs.has(run.id), 'Corrupt run identity')
    runs.add(run.id)
    invariant(typeof run.occurrenceKey === 'string' && !occurrences.has(`${run.taskId}/${run.occurrenceKey}`), 'Corrupt duplicate occurrence')
    occurrences.add(`${run.taskId}/${run.occurrenceKey}`)
    invariant(STATUSES.includes(run.status) && ['manual', 'scheduled'].includes(run.trigger), 'Corrupt run status')
    invariant(iso(run.startedAt) && iso(run.scheduledAt) && (run.finishedAt === null || iso(run.finishedAt)) && (run.sendStartedAt === null || iso(run.sendStartedAt)), 'Corrupt run timestamps')
    invariant(typeof run.detail === 'string' && typeof run.taskName === 'string', 'Corrupt run detail')
    invariant(run.payloadHash === null || /^[a-f0-9]{64}$/.test(run.payloadHash), 'Corrupt payload hash')
    invariant(run.itemCount === null || (Number.isSafeInteger(run.itemCount) && run.itemCount >= 0), 'Corrupt item count')
    validateTask(run.snapshot)
    invariant(run.snapshot.id === run.taskId && run.snapshot.name === run.taskName && digest(run.snapshot) === run.snapshotDigest, 'Corrupt snapshot digest')
  }
}
