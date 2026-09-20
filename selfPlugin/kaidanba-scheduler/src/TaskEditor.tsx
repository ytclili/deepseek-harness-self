import React, { useEffect, useRef, useState } from 'react'
import { Alert, Button, DatePicker, Divider, Drawer, Form, Input, Radio, Select, Space, Switch, TimePicker, Typography } from 'antd'
import dayjs from 'dayjs'
import type { Platform, TaskDraft, TaskRecord } from './shared'
import type { BotOption, RecipientOption } from './im-directory'

type Props = { open: boolean; task?: TaskRecord; bots: BotOption[]; targets: RecipientOption[]; loading: boolean; errors: string[]; live: boolean; saving: boolean; disabled: boolean; saveError?: string; onRefresh: () => void; onClose: () => void; onSave: (task: TaskDraft) => void }

export function TaskEditor({ open, task, bots, targets, loading, errors, live, saving, disabled, saveError, onRefresh, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<TaskDraft>({ name: '', description: '', kind: 'daily', time: '09:00', platform: 'feishu', botId: '', targetId: '', enabled: true })
  const [creationError, setCreationError] = useState('')
  const formSession = useRef<{ taskId?: string }>()
  useEffect(() => {
    if (!open) { formSession.current = undefined; return }
    if (formSession.current && formSession.current.taskId === task?.id) return
    formSession.current = { taskId: task?.id }
    setCreationError('')
    if (task) {
      setDraft({ id: task.id, revision: task.revision, creationId: task.creationId, name: task.name, description: task.description, kind: task.kind, time: task.time, platform: task.platform, botId: task.botId, targetId: task.targetId, enabled: task.status === 'completed' ? false : task.enabled })
      return
    }
    let creationId: string | undefined
    try {
      if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('crypto.randomUUID unavailable')
      creationId = globalThis.crypto.randomUUID()
    } catch {
      setCreationError('无法生成安全的创建请求 ID，当前不能保存新任务。请使用支持 crypto.randomUUID 的安全 Harness 页面重新打开表单。')
    }
    setDraft({ creationId, name: '', description: '', kind: 'daily', time: '09:00', platform: 'feishu', botId: '', targetId: '', enabled: true })
  }, [open, task])
  const availableBots = bots.filter(bot => bot.platform === draft.platform)
  const availableTargets = targets.filter(target => target.botId === draft.botId && (!target.platform || target.platform === draft.platform))
  const update = (patch: Partial<TaskDraft>) => setDraft(previous => ({ ...previous, ...patch }))
  const changeKind = (kind: TaskDraft['kind']) => setDraft(previous => {
    if (kind === previous.kind) return previous
    const selectedTime = dayjs(previous.kind === 'daily' ? `2026-01-01 ${previous.time}` : previous.time)
    return { ...previous, kind, time: kind === 'daily'
      ? selectedTime.format('HH:mm')
      : dayjs().add(1, 'day').hour(selectedTime.hour()).minute(selectedTime.minute()).second(0).format('YYYY-MM-DD HH:mm') }
  })
  const changePlatform = (platform: Platform) => update({ platform, botId: bots.find(bot => bot.platform === platform)?.id ?? '', targetId: '' })
  const selectedBot = availableBots.find(bot => bot.id === draft.botId)
  const selectedTarget = availableTargets.find(target => target.id === draft.targetId)
  const ready = Boolean(!disabled && !saving && !loading && !creationError && (task || draft.creationId) && draft.name.trim() && draft.time && selectedBot && selectedTarget)

  return <Drawer title={task ? '编辑推送任务' : '新建推送任务'} open={open} onClose={() => { if (!saving) onClose() }} closable={!saving} maskClosable={!saving} keyboard={!saving} width={580} rootClassName="scheduler-drawer" destroyOnClose footer={
    <div className="editor-footer"><Typography.Text type="secondary">{live ? '北京时间 · 按计划执行' : '独立演示，仅本页生效'}</Typography.Text><Space><Button disabled={saving} onClick={onClose}>取消</Button><Button type="primary" loading={saving} disabled={!ready} onClick={() => { if (ready) onSave({ ...draft, name: draft.name.trim() }) }}>保存任务</Button></Space></div>
  }>
    {(creationError || saveError) && <Alert type="error" showIcon message={creationError || saveError} className="editor-notice" />}
    <Form layout="vertical" disabled={disabled || saving}>
      <div className="editor-section-label">01 / 任务信息</div>
      <Form.Item label="任务名称" required><Input aria-label="任务名称" placeholder="例如：每日商品清单" maxLength={80} value={draft.name} onChange={event => update({ name: event.target.value })} /></Form.Item>
      <Form.Item label="任务描述" extra="用于备注任务用途，不作为 AI 提示词。"><Input.TextArea aria-label="任务描述" placeholder="说明这次推送的用途" rows={2} maxLength={500} showCount value={draft.description} onChange={event => update({ description: event.target.value })} /></Form.Item>
      <Form.Item label="选择任务"><Select aria-label="选择任务" value="goods_push" options={[{ value: 'goods_push', label: '推送商品数据' }]} /></Form.Item>
      <Divider />
      <div className="editor-section-label">02 / 执行时间</div>
      <Form.Item label="重复方式"><Radio.Group value={draft.kind} optionType="button" buttonStyle="solid" onChange={event => changeKind(event.target.value)} options={[{ label: '指定时间，仅一次', value: 'once' }, { label: '每天', value: 'daily' }]} /></Form.Item>
      <Form.Item label={draft.kind === 'daily' ? '每天几点' : '执行日期和时间'} required extra="北京时间（Asia/Shanghai）">
        {draft.kind === 'daily'
          ? <TimePicker aria-label="每天几点" format="HH:mm" minuteStep={5} allowClear={false} needConfirm={false} value={dayjs(`2026-01-01 ${draft.time}`)} onCalendarChange={value => { if (value && !Array.isArray(value)) update({ time: value.format('HH:mm') }) }} onChange={value => update({ time: value?.format('HH:mm') ?? '' })} style={{ width: '100%' }} />
          : <DatePicker aria-label="执行日期和时间" showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" allowClear={false} needConfirm={false} value={dayjs(draft.time)} onCalendarChange={value => { if (value && !Array.isArray(value)) update({ time: value.format('YYYY-MM-DD HH:mm') }) }} onChange={value => update({ time: value?.format('YYYY-MM-DD HH:mm') ?? '' })} style={{ width: '100%' }} />}
      </Form.Item>
      <Divider />
      <div className="editor-section-label">03 / 发送给谁</div>
      {live && <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}><Button loading={loading} onClick={onRefresh}>刷新 IM 账号和会话</Button>{errors.map(error => <Alert key={error} type="warning" showIcon message={error} />)}</Space>}
      <Form.Item label="选择平台" required><Select aria-label="选择平台" value={draft.platform} onChange={changePlatform} options={[{ value: 'feishu', label: '飞书' }, { value: 'weixin', label: '微信' }]} /></Form.Item>
      <Form.Item label="机器人账号" required><Select aria-label="机器人账号" loading={loading} disabled={disabled || saving || loading} placeholder="请选择已接入的机器人" value={selectedBot?.id} onChange={botId => update({ botId, targetId: '' })} options={availableBots.map(bot => ({ value: bot.id, label: bot.label }))} /></Form.Item>
      <Form.Item label="选择客户 / 收件目标" required extra="来自该机器人的已保存目标与已聊会话，包含个人或群聊，不是完整通讯录。"><Select aria-label="选择客户 / 收件目标" loading={loading} value={selectedTarget?.id} placeholder="请选择客户或已聊会话" showSearch optionFilterProp="label" disabled={disabled || saving || loading || !selectedBot || !availableTargets.length} onChange={targetId => update({ targetId })} options={availableTargets.map(target => ({ value: target.id, label: `${target.name} · ${target.source === 'conversation' ? '已聊会话' : target.source === 'saved' ? '已保存目标' : target.kind}` }))} /></Form.Item>
      {!loading && !availableBots.length && <Alert type="warning" showIcon message="未读取到此平台的机器人" description="请先在「IM 机器人」接入账号；如上方有读取错误，请处理后刷新。" />}
      {!loading && selectedBot && !availableTargets.length && <Alert type="warning" showIcon message="未读取到该账号的收件人" description="可让客户与这个机器人聊天后刷新，或在 IM 的投递设置中保存目标。如上方有读取错误，请先处理。" />}
      {selectedTarget?.source === 'conversation' && <p className="editor-platform-note">此项来自 IM 已聊会话，保存任务时会自动存为正式投递目标。</p>}
      {draft.platform === 'weixin' && <p className="editor-platform-note">微信主动推送受平台规则与最近会话上下文限制，失败原因会记录在执行记录中。</p>}
      <Divider />
      <div className="editor-enable"><div><strong>{task?.status === 'completed' ? '任务已完成' : '保存后启用'}</strong><p>{task?.status === 'completed' ? '已完成的一次任务不会再次启用。' : '在设定时间执行，不会保存即发送。'}</p></div><Switch aria-label="保存后启用" disabled={disabled || saving || task?.status === 'completed'} checked={draft.enabled} onChange={enabled => update({ enabled })} /></div>
    </Form>
  </Drawer>
}
