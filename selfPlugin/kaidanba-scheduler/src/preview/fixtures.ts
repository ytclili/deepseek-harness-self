import type { Platform, RunStatus, SchedulerApi, TaskDraft, TaskRecord } from '../shared'

export const platformNames: Record<Platform, string> = { feishu: '飞书', weixin: '微信' }
export const bots: { id: string; platform: Platform; label: string }[] = [
  { id: 'feishu-demo', platform: 'feishu', label: '飞书商品助手（示例）' },
  { id: 'weixin-demo', platform: 'weixin', label: '微信商品助手（示例）' },
  { id: 'weixin-empty', platform: 'weixin', label: '微信新账号 · 暂无目标（示例）' },
]
export const targets = [
  { id: 'store-a', botId: 'feishu-demo', name: '客户 A（示例）', kind: '个人' },
  { id: 'store-group', botId: 'feishu-demo', name: '采购群（示例）', kind: '群聊' },
  { id: 'store-b', botId: 'weixin-demo', name: '客户 B（示例）', kind: '个人' },
  { id: 'store-c', botId: 'weixin-demo', name: '客户 C（示例）', kind: '个人' },
]
const initialTasks: TaskDraft[] = [
  { id: 'task-a', name: '每日商品清单', description: '每天给客户 A 发送最新商品信息。', kind: 'daily', time: '09:00', platform: 'feishu', botId: 'feishu-demo', targetId: 'store-a', enabled: true },
  { id: 'task-b', name: '客户 B 商品资料', description: '按约定时间发送一次商品清单。', kind: 'once', time: '2026-09-19 14:00', platform: 'weixin', botId: 'weixin-demo', targetId: 'store-b', enabled: true },
  { id: 'task-c', name: '采购群商品更新', description: '暂停期间不会自动发送。', kind: 'daily', time: '16:30', platform: 'feishu', botId: 'feishu-demo', targetId: 'store-group', enabled: false },
]
export const statusLabels: Record<RunStatus, { label: string; color: string }> = {
  preparing: { label: '准备中', color: 'default' },
  query_failed: { label: '商品查询失败', color: 'default' },
  sending: { label: '发送中', color: 'default' },
  accepted: { label: '平台已接受', color: 'default' },
  send_failed: { label: '发送失败', color: 'default' },
  unknown: { label: '结果待确认', color: 'default' },
  missed: { label: '已错过', color: 'default' },
  cancelled: { label: '已取消', color: 'default' },
}
export const sampleMessage = '商品清单（示例数据）\n\n1. 茉莉花茶\n规格：250g｜单位：袋｜价格：18.50\n\n2. 原味燕麦片\n规格：500g｜单位：袋｜价格：12.80\n\n3. 即饮咖啡\n规格：250ml × 12｜单位：箱｜价格：48.00\n\n共 3 件商品。此处仅演示消息格式，未查询实际商品。'

export function createDemoApi(): SchedulerApi {
  const toRecord = (draft: TaskDraft): TaskRecord => ({
    ...draft, id: draft.id || crypto.randomUUID(), revision: (draft.revision ?? 0) + 1,
    status: draft.enabled ? 'active' : 'paused', targetName: targets.find(target => target.id === draft.targetId)?.name ?? '',
    nextRunAt: null, lastOccurrence: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
  let tasks = initialTasks.map(toRecord)
  return {
    list: async () => ({ tasks: [...tasks], runs: [] }),
    save: async draft => {
      const task = toRecord(draft)
      tasks = [task, ...tasks.filter(item => item.id !== task.id)]
      return task
    },
    toggle: async (id, revision, enabled) => {
      const task = tasks.find(item => item.id === id)
      if (!task) throw new Error('任务不存在')
      const updated = toRecord({ ...task, revision, enabled })
      tasks = tasks.map(item => item.id === id ? updated : item)
      return updated
    },
    remove: async id => { tasks = tasks.filter(task => task.id !== id) },
    preview: async () => ({ text: sampleMessage, itemCount: 3 }),
    run: async () => { throw new Error('独立演示页不支持真实执行，请在 Harness 设置中操作。') },
  }
}
