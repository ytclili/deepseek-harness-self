import type { SchedulerApi, TaskDraft } from './shared.ts'
import { IntegrationError } from './host-adapters.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function createSchedulerHandler(service: SchedulerApi) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return new Response('JSON required', { status: 415 })
    let rpcId = 'invalid-request'
    const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId, result })
    const failure = (message: string) => reply({ ok: false, error: { code: 'scheduler/error', message, details: {} } })
    let body: unknown
    try {
      const text = await request.text()
      if (Buffer.byteLength(text) > 16384) return new Response('request too large', { status: 413 })
      body = JSON.parse(text)
    } catch { return failure('请求不是有效 JSON。') }
    if (!isRecord(body) || body.type !== 'client-request' || body.method !== 'kaidanba-scheduler' || typeof body.rpcId !== 'string' || body.rpcId.length > 128 || !exact(body.payload, ['method', 'payload'])) return failure('请求格式不正确。')
    rpcId = body.rpcId
    const { method, payload } = body.payload
    const fields: Record<string, string[]> = { list: [], save: ['draft'], toggle: ['id', 'revision', 'enabled'], remove: ['id', 'revision'], preview: ['id'], run: ['id', 'revision', 'requestId'] }
    if (typeof method !== 'string' || !Object.hasOwn(fields, method) || !exact(payload, fields[method])) return failure('不支持的操作或参数。')
    if ('id' in payload && (typeof payload.id !== 'string' || payload.id.length > 128)) return failure('任务 ID 不正确。')
    if ('revision' in payload && (!Number.isSafeInteger(payload.revision) || Number(payload.revision) < 1)) return failure('任务版本不正确，请刷新。')
    if (method === 'toggle' && typeof payload.enabled !== 'boolean') return failure('任务状态不正确。')
    if (method === 'run' && (typeof payload.requestId !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(payload.requestId))) return failure('执行请求标识不正确。')
    if (method === 'save' && !isRecord(payload.draft)) return failure('任务内容不正确。')
    if (method === 'save' && isRecord(payload.draft) && payload.draft.id === undefined && (typeof payload.draft.creationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.draft.creationId))) return failure('新建任务缺少有效请求标识，请刷新页面后重新创建。')
    if (request.signal.aborted) return failure('请求已取消。')
    try {
      let value: unknown
      switch (method) {
        case 'list': value = await service.list(request.signal); break
        case 'save': value = await service.save(payload.draft as TaskDraft); break
        case 'toggle': value = await service.toggle(payload.id as string, payload.revision as number, payload.enabled as boolean); break
        case 'remove': await service.remove(payload.id as string, payload.revision as number); value = null; break
        case 'preview': value = await service.preview(payload.id as string); break
        case 'run': value = await service.run(payload.id as string, payload.revision as number, payload.requestId as string); break
      }
      return reply({ ok: true, value })
    } catch (error) {
      if (error instanceof IntegrationError || (error instanceof Error && error.name === 'SchedulerError')) return failure(error.message)
      return failure('操作失败，请检查插件运行状态和数据目录权限后刷新。')
    }
  }
}
