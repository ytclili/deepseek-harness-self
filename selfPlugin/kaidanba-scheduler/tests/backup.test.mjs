import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openScheduler } from '../src/runtime.ts'
import { backupState, restoreState } from '../scripts/state-backup.mjs'

test('offline backup refuses live owners and restores active tasks paused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kdb-backup-'))
  const stateFile = join(directory, 'source', 'state.json')
  const backupFile = join(directory, 'backup.json')
  const restoredFile = join(directory, 'restored', 'state.json')
  const dependencies = {
    resolveTarget: async task => ({ targetId: task.targetId, targetName: '客户' }),
    preview: async () => { throw new Error('must not query') },
    send: async () => { throw new Error('must not send') },
  }
  let scheduler
  try {
    scheduler = await openScheduler({ stateFile, dependencies, autoStart: false })
    await scheduler.save({ name: '每日商品', description: '', kind: 'daily', time: '19:00', platform: 'feishu', botId: 'bot', targetId: 'customer', enabled: true })
    await assert.rejects(backupState(stateFile, backupFile), /lock/)
    await scheduler.close()
    scheduler = undefined
    await backupState(stateFile, backupFile)
    await restoreState(backupFile, restoredFile)
    scheduler = await openScheduler({ stateFile: restoredFile, dependencies, autoStart: false })
    const view = await scheduler.list()
    assert.equal(view.tasks[0].time, '19:00')
    assert.equal(view.tasks[0].status, 'paused')
    assert.equal(view.tasks[0].enabled, false)
    assert.equal(view.tasks[0].nextRunAt, null)
    const persisted = JSON.parse(await readFile(restoredFile, 'utf8'))
    assert.equal(persisted.tasks[0].revision, 2)
  } finally {
    await scheduler?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
