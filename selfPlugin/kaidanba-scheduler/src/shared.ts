export type Platform = 'feishu' | 'weixin'
export type TaskDraft = {
  id?: string
  revision?: number
  creationId?: string
  name: string
  description: string
  kind: 'once' | 'daily'
  time: string
  platform: Platform
  botId: string
  targetId: string
  enabled: boolean
}
export type TaskRecord = TaskDraft & {
  id: string
  revision: number
  status: 'active' | 'paused' | 'completed' | 'deleted'
  targetName: string
  nextRunAt: string | null
  lastOccurrence: string | null
  createdAt: string
  updatedAt: string
}
export type RunStatus = 'preparing' | 'query_failed' | 'sending' | 'accepted' | 'send_failed' | 'unknown' | 'missed' | 'cancelled'
export type RunRecord = {
  id: string
  taskId: string
  taskName: string
  status: RunStatus
  trigger: 'scheduled' | 'manual'
  scheduledAt: string
  startedAt: string
  finishedAt: string | null
  detail: string
}
export type StateView = { tasks: TaskRecord[]; runs: RunRecord[] }
export type Preview = { text: string; itemCount: number }
export type SchedulerApi = {
  list: (signal?: AbortSignal) => Promise<StateView>
  save: (draft: TaskDraft) => Promise<TaskRecord>
  toggle: (id: string, revision: number, enabled: boolean) => Promise<TaskRecord>
  remove: (id: string, revision: number) => Promise<void>
  preview: (id: string) => Promise<Preview>
  run: (id: string, revision: number, requestId: string) => Promise<RunRecord>
}
