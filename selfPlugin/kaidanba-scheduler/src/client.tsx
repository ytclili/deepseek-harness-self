import React from 'react'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import SchedulerPreview from './SchedulerPreview'
import styles from './styles.css'
import { loadImDirectory, type ImConnection, type DirectoryLoader } from './im-directory'
import { createSchedulerApi } from './scheduler-api'
import type { SchedulerApi } from './shared'

type SettingsProps = { api: SchedulerApi; loadDirectory: DirectoryLoader }
type SettingsSection = { name: string; id: string; order: number; label: () => string; inject: () => SettingsProps }
type ClientContext = {
  connection: ImConnection
  effect: (setup: () => () => void) => unknown
  slots: {
    inject: (name: string, register: () => unknown) => unknown
    register: (section: SettingsSection, component: React.ComponentType<SettingsProps>) => unknown
  }
}

export const name = 'kaidanba-scheduler'
export const inject = ['slots', 'connection']

function SchedulerSettings({ api, loadDirectory }: SettingsProps) {
  return <SchedulerPreview embedded api={api} loadDirectory={loadDirectory} />
}

export function apply(ctx: ClientContext): void {
  dayjs.locale('zh-cn')
  ctx.effect(() => {
    const element = document.createElement('style')
    element.dataset.kaidanbaScheduler = 'true'
    element.textContent = styles
    document.head.append(element)
    return () => element.remove()
  })
  const loadDirectory: DirectoryLoader = signal => loadImDirectory(ctx.connection, signal)
  const api = createSchedulerApi(ctx.connection)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: name,
    order: 22,
    label: () => '定时商品推送',
    inject: () => ({ api, loadDirectory }),
  }, SchedulerSettings))
}
