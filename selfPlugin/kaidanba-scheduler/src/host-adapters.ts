import { randomUUID } from 'node:crypto'
import type { Preview, TaskDraft, TaskRecord } from './shared.ts'

export type Integrations = {
  tools: { execute: (input: { callId: string; name: string; arguments: Record<string, never>; signal: AbortSignal }) => Promise<unknown> }
  dshIm: {
    listBots: () => Promise<unknown>
    listTargets: (botId: string) => Promise<unknown>
    send: (botId: string, targetId: string, text: string, options: { signal: AbortSignal }) => Promise<unknown>
  }
}

export class IntegrationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IntegrationError'
    this.code = code
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntegrationError('invalid-response', '接口返回格式不正确，未发送消息。')
  return value as Record<string, unknown>
}

function displayText(value: unknown, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new IntegrationError('invalid-goods', '商品字段格式不正确，未发送消息。')
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
}

export function formatGoods(value: unknown): Preview {
  const result = record(value)
  if (!Array.isArray(result.items) || result.items.length > 100 || result.returned_count !== result.items.length || result.total !== result.items.length || result.has_more !== false) {
    throw new IntegrationError('incomplete-goods', '商品列表不完整或格式有误，请缩小商品范围后重试。')
  }
  const lines = result.items.map((value, index) => {
    const item = record(value)
    const title = displayText(item.name, 512, true)
    const spec = displayText(item.spec, 1024)
    const unit = displayText(item.unit, 64)
    if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0 || item.price > Number.MAX_SAFE_INTEGER) throw new IntegrationError('invalid-goods', '商品价格格式不正确，未发送消息。')
    return `${index + 1}. ${title}\n规格：${spec || '未提供'}｜单位：${unit || '未提供'}｜价格：${item.price}`
  })
  const text = lines.length ? `商品清单\n\n${lines.join('\n\n')}\n\n共 ${lines.length} 件商品。` : '商品清单\n\n当前没有商品数据。'
  if (Buffer.byteLength(text, 'utf8') > 3500) throw new IntegrationError('message-too-long', '商品清单超过单条消息长度限制，请缩小商品范围后重试。')
  return { text, itemCount: lines.length }
}

export function createDependencies(context: Integrations) {
  const resolveTarget = async (task: TaskDraft, signal: AbortSignal) => {
    signal.throwIfAborted()
    const bots = await context.dshIm.listBots()
    if (!Array.isArray(bots) || !bots.some(value => record(value).botId === task.botId && record(value).channel === task.platform)) {
      throw new IntegrationError('unknown-bot', '机器人不存在或平台不匹配，请重新选择。')
    }
    const targets = await context.dshIm.listTargets(task.botId)
    if (!Array.isArray(targets)) throw new IntegrationError('invalid-response', 'IM 收件目标读取失败。')
    const candidate = targets.find(value => record(value).targetId === task.targetId)
    if (!candidate) throw new IntegrationError('unknown-target', '收件目标不存在，请刷新并重新选择。')
    const target = record(candidate)
    signal.throwIfAborted()
    return { targetId: task.targetId, targetName: typeof target.name === 'string' && target.name.trim() ? target.name.slice(0, 80) : target.kind === 'group' ? '已保存群聊' : '已保存私聊' }
  }
  return {
    resolveTarget,
    async preview(task: TaskRecord, signal: AbortSignal): Promise<Preview> {
      await resolveTarget(task, signal)
      signal.throwIfAborted()
      const result = record(await context.tools.execute({ callId: `scheduler-${randomUUID()}`, name: 'goods_list', arguments: {}, signal }))
      if (result.isError !== false) throw new IntegrationError('goods-query-failed', '商品查询失败，请检查企业工具、接口地址和授权配置。')
      signal.throwIfAborted()
      return formatGoods(result.value)
    },
    async send(task: TaskRecord, text: string, signal: AbortSignal): Promise<void> {
      await resolveTarget(task, signal)
      signal.throwIfAborted()
      try {
        const result = record(await context.dshIm.send(task.botId, task.targetId, text, { signal }))
        if (result.sent !== true) throw new Error('No acknowledgement')
      } catch {
        throw new IntegrationError('delivery-unknown', 'IM 未返回成功确认，结果待确认；不会自动重发。')
      }
    },
  }
}
