import type { Platform, TaskDraft } from './shared'

export type ImConnection = {
  rpc: { call: (channel: string, method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> }
}
export type BotOption = { id: string; platform: Platform; label: string }
export type RecipientOption = {
  id: string
  botId: string
  platform?: Platform
  name: string
  kind: string
  source?: 'saved' | 'conversation'
}
export type ImDirectory = { bots: BotOption[]; targets: RecipientOption[]; errors: string[] }
export type DirectoryLoader = (signal: AbortSignal) => Promise<ImDirectory>

class ImRpcError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('IM 接口响应格式不正确')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function arrayField(value: unknown, key: string): unknown[] {
  const items = record(value)[key]
  if (!Array.isArray(items)) throw new Error('IM 接口响应缺少列表')
  return items
}

function masked(value: string): string {
  return value.length > 8 ? `${value.slice(0, 3)}…${value.slice(-4)}` : `${value.slice(0, 2)}…`
}

async function readRpc(connection: ImConnection, channel: string, method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('IM 请求超时，请检查连接后重试。')), 15000)
  let rejectAborted: () => void = () => undefined
  try {
    if (!connection?.rpc?.call) throw new Error('IM API 不可用，请检查 IM 插件和 Harness 连接。')
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', rejectAborted, { once: true })
    })
    const result = record(await Promise.race([connection.rpc.call('/api', `dsh-im/${channel}`, { method, payload }, controller.signal), aborted]))
    if (result.ok !== true) {
      const error = record(result.error)
      const code = text(error.code)
      const labels: Record<string, string> = {
        'target-conflict': 'IM 投递目标 ID 冲突，请刷新后重试。',
        'unknown-bot': 'IM 机器人不存在，请重新选择。',
        'unknown-target': 'IM 投递目标不存在，请重新选择。',
        'invalid-target': 'IM 投递目标无效，请重新选择。',
        'bot-not-connected': 'IM 机器人未连接，请先连接账号。',
        'delivery-failed': 'IM 目标操作失败，请检查连接后重试。',
        'bad-request': 'IM 请求参数无效，请刷新账号和会话后重试。',
      }
      throw new ImRpcError(code, labels[code] || text(error.message) || 'IM 请求失败，请检查连接后重试。')
    }
    return result.value
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', rejectAborted)
  }
}

export async function resolveConversationTarget(connection: ImConnection, draft: TaskDraft, signal: AbortSignal): Promise<string> {
  if (!draft.targetId.startsWith('conversation:')) return draft.targetId
  let identity: unknown
  try { identity = JSON.parse(decodeURIComponent(draft.targetId.slice('conversation:'.length))) } catch {
    throw new Error('会话目标格式无效，请刷新后重新选择收件人。')
  }
  if (!Array.isArray(identity) || identity.length !== 4 || !identity.every(value => typeof value === 'string' && value.trim() === value && value.length > 0)) {
    throw new Error('会话目标格式无效，请重新选择收件人。')
  }
  const [platform, botId, kind, routeId] = identity as string[]
  if (platform !== draft.platform || botId !== draft.botId || !['feishu', 'weixin'].includes(platform) || (kind !== 'user' && !(platform === 'feishu' && kind === 'group'))) {
    throw new Error('会话目标与所选平台或机器人不匹配，请重新选择。')
  }
  const routeKey = platform === 'weixin' ? 'toUserId' : kind === 'group' ? 'chatId' : 'openId'
  const matches = (value: unknown): boolean => {
    const item = record(value)
    const route = record(item.route)
    return item.kind === kind && route[routeKey] === routeId && Object.keys(route).length === 1
  }
  const readList = async (method: string, key: string) => {
    const value = record(await readRpc(connection, 'dsh-im-delivery', method, { botId }, signal))
    if (value.botId !== botId || value.channel !== platform) throw new Error('IM 返回的目标归属与所选账号不匹配。')
    return arrayField(value, key)
  }
  const [saved, suggestions] = await Promise.all([
    readList('target.list', 'targets'), readList('target.suggestion.list', 'suggestions'),
  ])
  const suggestion = suggestions.find(matches)
  if (!suggestion) throw new Error('所选会话已不存在，请刷新 IM 会话后重新选择。')
  const existing = saved.find(matches)
  if (existing) {
    const targetId = text(record(existing).targetId)
    if (!targetId || targetId.startsWith('conversation:')) throw new Error('IM 已保存目标的 ID 无效。')
    return targetId
  }
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持安全生成 IM 目标 ID，请在安全的 Harness 页面中保存。')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity)))
  signal.throwIfAborted()
  const targetId = `kdb-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}`
  const name = (text(record(suggestion).name) || (kind === 'group' ? '群聊' : '私聊')).slice(0, 80)
  try {
    const created = record(await readRpc(connection, 'dsh-im-delivery', 'target.create', {
      botId, target: { targetId, name, kind, route: { [routeKey]: routeId } },
    }, signal))
    if (created.targetId !== targetId || !matches(created)) throw new Error('IM 保存结果与所选目标不匹配，请刷新后确认。')
  } catch (error) {
    if (!(error instanceof ImRpcError) || error.code !== 'target-conflict') throw error
    const targets = await readList('target.list', 'targets')
    if (!targets.some(value => record(value).targetId === targetId && matches(value))) throw error
  }
  return targetId
}

function normalizeRecipient(value: unknown, bot: BotOption, source: 'saved' | 'conversation'): RecipientOption & { identity: string } {
  const item = record(value)
  const kind = text(item.kind)
  if (kind !== 'user' && !(bot.platform === 'feishu' && kind === 'group')) throw new Error('不支持的 IM 目标类型')
  const route = record(item.route)
  const routeId = text(route[bot.platform === 'weixin' ? 'toUserId' : kind === 'group' ? 'chatId' : 'openId'])
  if (!routeId) throw new Error('IM 收件目标缺少标识')
  const identity = JSON.stringify([bot.platform, bot.id, kind, routeId])
  const id = source === 'saved' ? text(item.targetId) : `conversation:${encodeURIComponent(identity)}`
  if (!id) throw new Error('IM 收件目标缺少 ID')
  const kindLabel = kind === 'group' ? '群聊' : '私聊'
  return { id, identity, botId: bot.id, platform: bot.platform, source, kind: kindLabel,
    name: text(item.name) || `${kindLabel} · ${masked(routeId)}` }
}

export async function loadImDirectory(connection: ImConnection, signal: AbortSignal): Promise<ImDirectory> {
  const platforms: Platform[] = ['feishu', 'weixin']
  const names = { feishu: '飞书', weixin: '微信' }
  const directory: ImDirectory = { bots: [], targets: [], errors: [] }
  const snapshots = await Promise.allSettled(platforms.map(async platform => {
    const value = await readRpc(connection, platform, 'connection.status', {}, signal)
    return arrayField(value, 'bots').map(value => {
      const item = record(value)
      const bot = record(item.bot)
      const id = text(item.botId)
      if (!id) throw new Error('IM 机器人缺少 ID')
      return { id, platform, label: `${text(bot.name) || `${names[platform]}机器人`} · ${text(bot.accountIdMasked) || text(bot.appIdMasked) || masked(id)}${item.connected === true ? '' : ' · 未连接'}` }
    })
  }))
  snapshots.forEach((result, index) => {
    if (result.status === 'fulfilled') directory.bots.push(...result.value)
    else directory.errors.push(`${names[platforms[index]]}账号读取失败，请检查 IM 插件和 Harness 连接后刷新。`)
  })
  const lists = await Promise.all(directory.bots.map(async bot => {
    const results = await Promise.allSettled([
      readRpc(connection, 'dsh-im-delivery', 'target.list', { botId: bot.id }, signal)
        .then(value => arrayField(value, 'targets').map(item => normalizeRecipient(item, bot, 'saved'))),
      readRpc(connection, 'dsh-im-delivery', 'target.suggestion.list', { botId: bot.id }, signal)
        .then(value => arrayField(value, 'suggestions').map(item => normalizeRecipient(item, bot, 'conversation'))),
    ])
    const targets: RecipientOption[] = []
    const errors: string[] = []
    const seen = new Set<string>()
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        errors.push(`${bot.label}：${index === 0 ? '已保存目标' : '已聊会话'}读取失败，请刷新重试。`)
        return
      }
      for (const { identity, ...target } of result.value) {
        if (seen.has(identity)) continue
        seen.add(identity)
        targets.push(target)
      }
    })
    return { targets, errors }
  }))
  signal.throwIfAborted()
  for (const result of lists) {
    directory.targets.push(...result.targets)
    directory.errors.push(...result.errors)
  }
  return directory
}
