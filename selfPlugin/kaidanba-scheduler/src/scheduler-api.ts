import { resolveConversationTarget, type ImConnection } from './im-directory'
import type { SchedulerApi } from './shared'

export class SchedulerApiError extends Error {}

export function schedulerError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '调度请求失败，请检查 Harness 连接后重试。'
}

export function createSchedulerApi(connection: ImConnection): SchedulerApi {
  async function call<Value>(method: string, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Value> {
    if (!connection?.rpc?.call) throw new Error('Scheduler API 不可用，请检查调度插件是否已加载并连接 Harness。')
    signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error(method === 'list' || method === 'preview'
      ? '调度请求超时，请检查 Harness 连接后重试。'
      : '调度请求超时，操作可能已生效，请刷新任务和执行记录确认后再操作。')), timeoutMs)
    let rejectAborted: () => void = () => undefined
    try {
      const aborted = new Promise<never>((_, reject) => {
        rejectAborted = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', rejectAborted, { once: true })
      })
      const response = await Promise.race([
        connection.rpc.call('/api', 'kaidanba-scheduler', { method, payload }, controller.signal),
        aborted,
      ])
      if (!response || typeof response !== 'object' || !('ok' in response)) {
        throw new Error('Scheduler API 响应无效，请确认调度插件已加载且版本匹配。')
      }
      if (response.ok !== true) {
        const error = 'error' in response ? response.error : undefined
        throw new SchedulerApiError(error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? error.message : 'Scheduler API 请求失败，请检查调度插件与 Harness 连接。')
      }
      if (method !== 'remove' && (!('value' in response) || response.value == null)) throw new Error('Scheduler API 响应缺少结果，请刷新确认操作状态。')
      return ('value' in response ? response.value : undefined) as Value
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', rejectAborted)
    }
  }

  return {
    list: async signal => {
      const value = await call<Awaited<ReturnType<SchedulerApi['list']>>>('list', {}, 15000, signal)
      if (!value || !Array.isArray(value.tasks) || !Array.isArray(value.runs)) throw new Error('Scheduler API 返回的任务或执行记录格式不正确。')
      return value
    },
    save: async draft => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('保存请求超时，操作可能已生效，请刷新任务和 IM 目标后确认。')), 30000)
      try {
        const targetId = await resolveConversationTarget(connection, draft, controller.signal)
        return await call('save', { draft: { ...draft, targetId } }, 30000, controller.signal)
      } finally {
        clearTimeout(timeout)
        controller.abort()
      }
    },
    toggle: (id, revision, enabled) => call('toggle', { id, revision, enabled }, 30000),
    remove: (id, revision) => call('remove', { id, revision }, 30000),
    preview: id => call('preview', { id }, 30000),
    run: (id, revision, requestId) => call('run', { id, revision, requestId }, 75000),
  }
}
