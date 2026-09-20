import { lstat, open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digest, invariant, validateState } from '../src/runtime/model.ts'
import { openStore } from '../src/runtime/store.ts'

export async function backupState(stateFile, backupFile) {
  await lstat(stateFile)
  const store = await openStore(stateFile)
  try {
    const snapshot = structuredClone(store.value)
    const output = await open(backupFile, 'wx', 0o600)
    try {
      await output.writeFile(JSON.stringify({ ...snapshot, checksum: digest(snapshot) }))
      await output.sync()
    } finally { await output.close() }
  } finally { await store.close() }
}

export async function restoreState(backupFile, stateFile) {
  const stats = await lstat(backupFile)
  invariant(stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o777) === 0o600, 'Backup must be a regular private file (0600)')
  const { checksum, ...snapshot } = JSON.parse(await readFile(backupFile, 'utf8'))
  invariant(checksum === digest(snapshot), 'Corrupt backup checksum')
  validateState(snapshot)
  const store = await openStore(stateFile)
  try {
    await store.change(candidate => {
      const timestamp = new Date().toISOString()
      for (const task of snapshot.tasks) {
        if (task.status !== 'deleted' && task.status !== 'completed') {
          task.status = 'paused'
          task.enabled = false
          task.nextRunAt = null
          task.revision++
          task.updatedAt = timestamp
        }
      }
      for (const run of snapshot.runs) {
        if (run.status === 'sending' || run.status === 'preparing') {
          run.status = run.status === 'sending' ? 'unknown' : 'cancelled'
          run.finishedAt = timestamp
          run.detail = '从备份恢复，未完成的执行不会自动重发'
        }
      }
      candidate.tasks = snapshot.tasks
      candidate.runs = snapshot.runs
      candidate.revision = Math.max(candidate.revision, snapshot.revision)
    })
  } finally { await store.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, first, second, ...extra] = process.argv.slice(2)
  if (!['backup', 'restore'].includes(mode) || !first || !second || extra.length) {
    console.error('Usage: node --experimental-strip-types scripts/state-backup.mjs backup STATE BACKUP | restore BACKUP STATE')
    process.exitCode = 1
  } else {
    try {
      await (mode === 'backup' ? backupState(first, second) : restoreState(first, second))
      console.log(mode === 'backup' ? '备份完成' : '恢复完成；恢复的未结束任务均已暂停，请在页面核对后启用')
    } catch {
      console.error('操作失败：请确认 Harness 已停止、没有存活的文件锁，并核对文件路径、权限和备份完整性。')
      process.exitCode = 1
    }
  }
}
