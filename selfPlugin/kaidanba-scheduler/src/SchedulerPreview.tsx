import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Card, ConfigProvider, Drawer, Empty, Input, List, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ClockCircleOutlined, HistoryOutlined, InboxOutlined, PlusOutlined, SearchOutlined, ShopOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { TaskEditor } from './TaskEditor'
import { bots as demoBots, targets as demoTargets, createDemoApi, platformNames, statusLabels } from './preview/fixtures'
import type { DirectoryLoader, ImDirectory } from './im-directory'
import type { Platform, Preview, RunRecord, SchedulerApi, TaskDraft, TaskRecord } from './shared'
import { SchedulerApiError, schedulerError } from './scheduler-api'

type Props = { embedded: true; api: SchedulerApi; loadDirectory: DirectoryLoader } | { embedded?: false; api?: SchedulerApi; loadDirectory?: DirectoryLoader }

function beijingTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function PreviewContent({ embedded = false, api: providedApi, loadDirectory }: Props) {
  const { message } = App.useApp()
  const [demoApi] = useState(() => embedded || providedApi ? undefined : createDemoApi())
  const api = embedded ? providedApi : providedApi ?? demoApi
  const live = embedded || Boolean(providedApi)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState('')
  const [pending, setPending] = useState('')
  const [saveError, setSaveError] = useState('')
  const busy = useRef(false)
  const writable = useRef(false)
  const lifetime = useRef(0)
  const mounted = useRef(false)
  const listRequest = useRef<AbortController>()
  const previewRequest = useRef(0)
  const uncertainExecutions = useRef(new Map<string, { task: TaskRecord; requestId: string }>())
  const refresh = useCallback(async (afterMutation = false): Promise<boolean> => {
    if (!mounted.current || (busy.current && !afterMutation)) return false
    listRequest.current?.abort()
    const controller = new AbortController()
    listRequest.current = controller
    setListLoading(true)
    try {
      if (!api) throw new Error('Scheduler API 未注入，请检查调度插件与 Harness 连接后重试。')
      const value = await api.list(controller.signal)
      if (!mounted.current || controller.signal.aborted || listRequest.current !== controller) return false
      setTasks(value.tasks.filter(task => task.status !== 'deleted'))
      setRuns(value.runs)
      setLoaded(true)
      setListError('')
      writable.current = true
      return true
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && listRequest.current === controller) {
        writable.current = false
        setListError(schedulerError(error))
      }
      return false
    } finally {
      if (mounted.current && listRequest.current === controller) {
        listRequest.current = undefined
        setListLoading(false)
      }
    }
  }, [api])
  useEffect(() => {
    mounted.current = true
    lifetime.current += 1
    writable.current = false
    busy.current = false
    setPending('')
    setLoaded(false)
    setEditorOpen(false)
    setPreviewTask(undefined)
    setHistoryTask(undefined)
    setExecution(undefined)
    uncertainExecutions.current.clear()
    const poll = () => {
      if (document.visibilityState === 'visible' && !busy.current && !listRequest.current) void refresh()
    }
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') poll()
      else {
        listRequest.current?.abort()
        listRequest.current = undefined
        setListLoading(false)
      }
    }
    poll()
    const interval = setInterval(poll, 30000)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      mounted.current = false
      lifetime.current += 1
      previewRequest.current += 1
      listRequest.current?.abort()
      listRequest.current = undefined
      clearInterval(interval)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [refresh])
  const [directory, setDirectory] = useState<ImDirectory>({ bots: live ? [] : demoBots, targets: live ? [] : demoTargets, errors: [] })
  const [directoryLoading, setDirectoryLoading] = useState(Boolean(loadDirectory))
  const [directoryRevision, setDirectoryRevision] = useState(0)
  const directoryRequest = useRef<AbortController>()
  const refreshDirectory = () => {
    directoryRequest.current?.abort()
    directoryRequest.current = undefined
    setDirectoryRevision(previous => previous + 1)
  }
  useEffect(() => {
    if (!loadDirectory) {
      if (live) setDirectory({ bots: [], targets: [], errors: ['IM 目录 API 未注入，请检查插件与 Harness 连接。'] })
      setDirectoryLoading(false)
      return
    }
    const controller = new AbortController()
    directoryRequest.current = controller
    setDirectoryLoading(true)
    void loadDirectory(controller.signal).then(value => {
      if (!controller.signal.aborted) setDirectory(value)
    }).catch(() => {
      if (!controller.signal.aborted) setDirectory(previous => ({ ...previous, errors: ['读取 IM 账号和会话失败，请检查连接后刷新。'] }))
    }).finally(() => {
      if (!controller.signal.aborted) setDirectoryLoading(false)
    })
    return () => {
      controller.abort()
      if (directoryRequest.current === controller) directoryRequest.current = undefined
    }
  }, [loadDirectory, directoryRevision, live])
  const { bots, targets } = directory
  const targetLabel = (task: TaskRecord) => task.targetName || targets.find(target => target.botId === task.botId && target.id === task.targetId && (!target.platform || target.platform === task.platform))?.name || '收件目标未读取或已失效'
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState<Platform | 'all'>('all')
  const [view, setView] = useState('全部任务')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TaskRecord>()
  const [previewTask, setPreviewTask] = useState<TaskRecord>()
  const [preview, setPreview] = useState<Preview>()
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [historyTask, setHistoryTask] = useState<TaskRecord | 'all'>()
  const [execution, setExecution] = useState<{ task: TaskRecord; requestId: string }>()
  const [runError, setRunError] = useState('')
  const disabled = !loaded || Boolean(listError) || Boolean(pending)
  const isRunning = (task: TaskRecord) => runs.some(run => run.taskId === task.id && (run.status === 'preparing' || run.status === 'sending'))
  const taskStatus = (task: TaskRecord) => task.status === 'completed' ? '已完成' : task.enabled ? '已启用' : '已暂停'
  const filtered = tasks.filter(task => (platform === 'all' || task.platform === platform) && `${task.name} ${task.description} ${targetLabel(task)}`.includes(search.trim()) && (view === '全部任务' || (view === '已完成' ? task.status === 'completed' : task.status !== 'completed' && (view === '已启用' ? task.enabled : !task.enabled))))
  const selectedRuns = historyTask === 'all' ? runs : runs.filter(run => run.taskId === historyTask?.id)

  const openEditor = (task?: TaskRecord) => {
    if (disabled) return
    setEditing(task)
    setSaveError('')
    setEditorOpen(true)
    if (loadDirectory) refreshDirectory()
  }
  const mutate = async <Value,>(label: string, operation: (service: SchedulerApi) => Promise<Value>, onSuccess: (value: Value) => void, onError?: (detail: string, error: unknown) => void) => {
    if (!api || busy.current || !writable.current) return
    const currentLifetime = lifetime.current
    busy.current = true
    setPending(label)
    listRequest.current?.abort()
    listRequest.current = undefined
    setListLoading(false)
    try {
      const value = await operation(api)
      if (!mounted.current || currentLifetime !== lifetime.current) return
      onSuccess(value)
      if (!await refresh(true) && mounted.current && currentLifetime === lifetime.current) {
        writable.current = false
        setListError(previous => previous || '操作已完成，尚未取得最新列表，请重试刷新。')
        message.warning('操作已完成，但列表刷新失败，请重试刷新以确认最新状态。')
      }
    } catch (error) {
      if (!mounted.current || currentLifetime !== lifetime.current) return
      const detail = schedulerError(error)
      onError?.(detail, error)
      message.error(detail)
    } finally {
      if (mounted.current && currentLifetime === lifetime.current) {
        busy.current = false
        setPending('')
      }
    }
  }
  const save = (draft: TaskDraft) => {
    setSaveError('')
    void mutate('save', service => service.save(draft), saved => {
      setTasks(previous => previous.some(task => task.id === saved.id) ? previous.map(task => task.id === saved.id ? saved : task) : [saved, ...previous])
      setEditorOpen(false)
      if (loadDirectory) {
        refreshDirectory()
        setDirectory(previous => {
          const selected = previous.targets.find(target => target.id === draft.targetId && target.botId === draft.botId && (!target.platform || target.platform === draft.platform))
          return { ...previous, targets: [
            ...previous.targets.filter(target => !(target.botId === saved.botId && (!target.platform || target.platform === saved.platform) && (target.id === saved.targetId || target.id === draft.targetId))),
            { id: saved.targetId, botId: saved.botId, platform: saved.platform, name: saved.targetName || selected?.name || '已保存目标', kind: selected?.kind ?? '收件目标', source: 'saved' },
          ] }
        })
      }
      message.success(live ? '任务已保存。' : '已保存到独立演示页。')
    }, setSaveError)
  }
  const toggle = (task: TaskRecord, enabled: boolean) => {
    if (task.status === 'completed') return
    void mutate(`toggle:${task.id}`, service => service.toggle(task.id, task.revision, enabled), saved => {
      setTasks(previous => previous.map(item => item.id === saved.id ? saved : item))
      message.success(enabled ? '任务已启用。' : '任务已暂停。')
    })
  }
  const remove = (task: TaskRecord) => mutate(`remove:${task.id}`, service => service.remove(task.id, task.revision), () => {
    setTasks(previous => previous.filter(item => item.id !== task.id))
    message.success('任务已删除。')
  })
  const openPreview = async (task: TaskRecord) => {
    if (!api) { message.error('Scheduler API 不可用，无法预览消息。'); return }
    const request = ++previewRequest.current
    setPreviewTask(task)
    setPreview(undefined)
    setPreviewError('')
    setPreviewLoading(true)
    try {
      const value = await api.preview(task.id)
      if (mounted.current && request === previewRequest.current) setPreview(value)
    } catch (error) {
      if (mounted.current && request === previewRequest.current) setPreviewError(schedulerError(error))
    } finally {
      if (mounted.current && request === previewRequest.current) setPreviewLoading(false)
    }
  }
  const openExecution = (task: TaskRecord) => {
    if (disabled || isRunning(task) || task.status !== 'active' || !live) return
    if (!globalThis.crypto?.randomUUID) { message.error('当前环境不支持生成执行请求 ID，请在安全的 Harness 页面中操作。'); return }
    const previous = uncertainExecutions.current.get(task.id)
    setRunError(previous ? '上次执行结果待确认，请先查看执行记录；重试会复用原请求 ID。' : '')
    setExecution(previous ?? { task, requestId: crypto.randomUUID() })
  }
  const execute = () => {
    if (!execution || isRunning(execution.task)) return
    const { task, requestId } = execution
    setRunError('')
    void mutate(`run:${task.id}`, service => service.run(task.id, task.revision, requestId), run => {
      uncertainExecutions.current.delete(task.id)
      setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)])
      setExecution(undefined)
      const detail = `${statusLabels[run.status].label}${run.detail ? `：${run.detail}` : ''}`
      if (run.status === 'accepted') message.success(detail)
      else if (run.status === 'query_failed' || run.status === 'send_failed') message.error(detail)
      else message.info(detail)
    }, (detail, error) => {
      if (error instanceof SchedulerApiError && !uncertainExecutions.current.has(task.id)) setRunError(detail)
      else {
        uncertainExecutions.current.set(task.id, { task, requestId })
        setRunError(`执行结果待确认：${detail} 请先查看执行记录；重试会复用原请求 ID，不会自动重发。`)
      }
    })
  }
  const actions = (task: TaskRecord) => <div className="row-actions"><Button type="link" size="small" disabled={!loaded || Boolean(pending)} onClick={() => void openPreview(task)}>预览消息</Button><Button type="link" size="small" disabled={disabled} onClick={() => openEditor(task)}>编辑</Button><Button type="link" size="small" onClick={() => setHistoryTask(task)}>记录</Button><Button type="link" size="small" disabled={disabled || isRunning(task) || task.status !== 'active' || !live} loading={pending === `run:${task.id}`} onClick={() => openExecution(task)}>{isRunning(task) ? '执行中' : '立即执行'}</Button><Popconfirm title="删除这个任务？" description="任务将停止调度，IM 投递目标会保留。" disabled={disabled} okText="删除" cancelText="取消" onConfirm={() => remove(task)}><Button type="link" size="small" disabled={disabled} danger>删除</Button></Popconfirm></div>
  const taskSwitch = (task: TaskRecord) => <Switch size="small" aria-label={`${task.name}启用状态`} disabled={disabled || task.status === 'completed'} loading={pending === `toggle:${task.id}`} checked={task.status !== 'completed' && task.enabled} onChange={enabled => toggle(task, enabled)} />
  const columns: ColumnsType<TaskRecord> = [
    { title: '任务', key: 'name', width: 255, render: (_, task) => <div className="task-name-cell"><span className="task-icon"><InboxOutlined /></span><div><button className="task-name-link" disabled={disabled} onClick={() => openEditor(task)}>{task.name}</button><p title={task.description}>{task.description || '暂无描述'}</p></div></div> },
    { title: '收件目标', key: 'target', width: 210, render: (_, task) => <div><div className="target-name">{targetLabel(task)}</div><span className={`platform-label ${task.platform}`}><span />{platformNames[task.platform]}</span></div> },
    { title: '执行计划 · 北京时间', key: 'time', width: 200, render: (_, task) => <div className="schedule-cell"><strong><ClockCircleOutlined /> {task.kind === 'daily' ? `每天 ${task.time}` : task.time}</strong><p>{task.status === 'completed' ? '已完成' : task.enabled ? task.kind === 'daily' ? '重复执行' : '仅执行一次' : '已暂停计划'}</p></div> },
    { title: '状态', key: 'status', width: 115, render: (_, task) => <Space size={7}>{taskSwitch(task)}<span className={task.enabled && task.status !== 'completed' ? 'enabled-text' : 'secondary-text'}>{taskStatus(task)}</span></Space> },
    { title: '操作', key: 'actions', width: 212, render: (_, task) => actions(task) },
  ]
  const runColumns: ColumnsType<RunRecord> = [
    { title: '时间 / 任务', key: 'task', render: (_, run) => <div><strong>{run.taskName}</strong><p className="secondary-text">{beijingTime(run.startedAt)} · {run.trigger === 'manual' ? '手动执行' : '定时执行'}</p></div> },
    { title: '结果', dataIndex: 'status', width: 128, render: (status: RunRecord['status']) => <Tag color={statusLabels[status].color}>{statusLabels[status].label}</Tag> },
    { title: '说明', dataIndex: 'detail' },
  ]

  return <div className={`scheduler-app${embedded ? ' scheduler-embedded' : ''}`}>
    {!embedded && <header className="brand-bar"><div className="brand"><span className="brand-mark"><ShopOutlined /></span><strong>开单吧</strong><span className="brand-divider" /><span>企业助手</span></div>{!live && <Tag bordered={false}>界面预览 · 示例数据</Tag>}</header>}
    <main className="scheduler-main">
      {!embedded && <div className="breadcrumb">设置 <span>/</span> 定时商品推送</div>}
      <div className="page-heading"><div><h1>定时商品推送</h1><p>选好时间与客户，让商品信息按计划送达。</p></div><Button type="primary" size="large" icon={<PlusOutlined />} disabled={disabled} onClick={() => openEditor()}>新建推送任务</Button></div>
      {!live && <Alert className="preview-alert" type="info" showIcon message="当前为独立演示：使用示例数据，不会发送消息；所有操作仅在本页生效，刷新后还原。" />}
      {live && <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}><Button loading={directoryLoading} onClick={refreshDirectory}>刷新 IM 账号和会话</Button>{directory.errors.map(error => <Alert key={error} type="warning" showIcon message={error} />)}</Space>}
      {listError && <Alert type="error" showIcon message={`任务与执行记录读取失败：${listError}`} description="已有任务保持显示；修改已禁用，请重试加载。" action={<Button disabled={Boolean(pending)} loading={listLoading} onClick={() => void refresh()}>重试</Button>} />}
      <div className="task-summary" aria-label="任务概览"><span>全部任务 <strong>{tasks.length}</strong></span><span>计划启用 <strong>{tasks.filter(task => task.enabled && task.status !== 'completed').length}</strong></span></div>
      <section className="tasks-panel">
        <div className="panel-heading"><div><h2>推送任务</h2><span>固定任务：推送商品数据</span></div><Space><Button disabled={Boolean(pending)} loading={listLoading} onClick={() => void refresh()}>刷新</Button><Button icon={<HistoryOutlined />} onClick={() => setHistoryTask('all')}>执行记录</Button></Space></div>
        <div className="table-toolbar"><Segmented value={view} options={['全部任务', '已启用', '已暂停', '已完成']} onChange={setView} /><div className="filters"><Input aria-label="搜索任务或客户" placeholder="搜索任务或客户" prefix={<SearchOutlined />} value={search} allowClear onChange={event => setSearch(event.target.value)} /><Select aria-label="筛选平台" value={platform} onChange={setPlatform} options={[{ value: 'all', label: '全部平台' }, { value: 'feishu', label: '飞书' }, { value: 'weixin', label: '微信' }]} /></div></div>
        {embedded ? <List className="embedded-task-list" loading={listLoading && !loaded} dataSource={filtered} locale={{ emptyText: listError ? '任务读取失败，请重试。' : !loaded ? '正在读取任务…' : '没有匹配的任务，可调整筛选或新建任务。' }} renderItem={task => <List.Item key={task.id}><Card size="small" title={<button className="task-name-link" disabled={disabled} onClick={() => openEditor(task)}>{task.name}</button>} extra={taskSwitch(task)}>
          <p className="secondary-text">{task.description || '暂无描述'}</p>
          <p><Tag>{platformNames[task.platform]}</Tag>{targetLabel(task)}</p>
          <p className="schedule-cell"><ClockCircleOutlined /> {task.kind === 'daily' ? `每天 ${task.time}` : task.time} · {taskStatus(task)}</p>
          {actions(task)}
        </Card></List.Item>} /> : <Table<TaskRecord> rowKey="id" loading={listLoading && !loaded} columns={columns} dataSource={filtered} pagination={false} scroll={{ x: 1000 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={listError ? '任务读取失败，请重试。' : tasks.length ? '没有匹配的任务，试试调整搜索或筛选。' : '还没有任务，点击「新建推送任务」开始。'} /> }} />}
        <div className="table-footer"><span>共 {filtered.length} 个任务</span><span><ClockCircleOutlined /> 北京时间 · Asia/Shanghai</span></div>
      </section>
      <footer className="page-footer">{live ? '所有时间均为北京时间；真实执行需要 Harness 保持运行。收件人来自 IM 已保存目标和已聊会话。' : '独立演示页，数据仅在当前页面保留，不会发送消息。'}</footer>
    </main>
    <TaskEditor open={editorOpen} task={editing} bots={bots} targets={targets} loading={directoryLoading} errors={directory.errors} live={live} saving={pending === 'save'} disabled={disabled} saveError={saveError} onRefresh={refreshDirectory} onClose={() => setEditorOpen(false)} onSave={save} />
    <Drawer title="消息预览" open={Boolean(previewTask)} onClose={() => { previewRequest.current += 1; setPreviewTask(undefined) }} width={500} rootClassName="scheduler-drawer">
      {previewTask && <><p className="editor-platform-note">{live ? '查询真实商品生成预览，不发送消息。' : '独立演示消息，不发送。'}</p><div className="preview-recipient"><span className="eyebrow">收件目标</span><h3>{targetLabel(previewTask)}</h3><p>{platformNames[previewTask.platform]} · {bots.find(bot => bot.platform === previewTask.platform && bot.id === previewTask.botId)?.label ?? previewTask.botId}</p></div>{previewLoading && <p>正在读取商品预览…</p>}{previewError && <Alert type="error" showIcon message={previewError} action={<Button onClick={() => void openPreview(previewTask)}>重试</Button>} />}{preview && <><div className="message-bubble"><pre>{preview.text}</pre></div><p className="editor-platform-note">共 {preview.itemCount} 件商品。</p></>}</>}
    </Drawer>
    <Drawer title={historyTask === 'all' ? '执行记录' : `${historyTask?.name ?? ''} · 执行记录`} open={Boolean(historyTask)} onClose={() => setHistoryTask(undefined)} width={780} rootClassName="scheduler-drawer">
      <p className="editor-platform-note">北京时间。平台已接受不代表客户已读，结果待确认时不会自动重发。</p><Button disabled={Boolean(pending)} loading={listLoading} onClick={() => void refresh()}>刷新记录</Button>{listError && <Alert type="error" message={`执行记录读取失败：${listError}`} />}<Table<RunRecord> rowKey="id" columns={runColumns} dataSource={selectedRuns} pagination={false} scroll={{ x: 590 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={listError ? '记录读取失败，请重试。' : '还没有执行记录。'} /> }} />
    </Drawer>
    <Modal title="确认立即执行" open={Boolean(execution)} onCancel={() => { if (!pending) setExecution(undefined) }} onOk={execute} confirmLoading={pending.startsWith('run:')} okButtonProps={{ disabled: disabled || Boolean(execution && isRunning(execution.task)) }} cancelButtonProps={{ disabled: Boolean(pending) }} closable={!pending} maskClosable={!pending} keyboard={!pending} okText="确认发送消息" cancelText="取消"><p>任务：{execution?.task.name}</p><p>收件目标：{execution ? targetLabel(execution.task) : ''}</p><p>平台：{execution ? platformNames[execution.task.platform] : ''} · 账号：{execution?.task.botId}</p><p>目标 ID：{execution?.task.targetId}</p><p>将立即查询商品并向上述真实目标发送消息，请确认收件人无误。</p>{runError && <Alert type="error" showIcon message={runError} action={<Button onClick={() => { setHistoryTask(execution?.task); setExecution(undefined); void refresh() }}>查看记录</Button>} />}</Modal>
  </div>
}

export default function SchedulerPreview(props: Props) {
  return <ConfigProvider prefixCls="kdb" locale={zhCN} theme={{
    token: {
      zIndexPopupBase: 2000,
      colorPrimary: '#1677ff',
      colorPrimaryHover: '#4096ff',
      colorPrimaryActive: '#0958d9',
      colorPrimaryBg: '#e6f4ff',
      colorPrimaryBgHover: '#bae0ff',
      colorPrimaryBorder: '#91caff',
      colorPrimaryBorderHover: '#69b1ff',
      colorInfo: '#737373',
      colorInfoBg: '#fafafa',
      colorInfoBorder: '#e5e5e5',
      colorText: '#262626',
      colorTextSecondary: '#737373',
      colorBgLayout: '#ffffff',
      colorBorder: '#e5e5e5',
      colorLink: '#1677ff',
      colorLinkHover: '#4096ff',
      colorLinkActive: '#0958d9',
      borderRadius: 8,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    },
    components: {
      Table: { headerBg: '#fafafa', headerColor: '#737373', cellPaddingBlock: 16 },
      Button: { primaryShadow: 'none', defaultShadow: 'none' },
      Input: { activeShadow: 'none' },
      Select: { optionSelectedBg: '#e6f4ff', activeOutlineColor: 'transparent' },
      Segmented: { itemSelectedBg: '#e6f4ff', itemSelectedColor: '#1677ff' },
      DatePicker: { activeShadow: 'none' },
    },
  }}><App><PreviewContent {...props} /></App></ConfigProvider>
}
