import { mkdir, lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { digest, invariant, SchedulerError, validateState } from './model.ts'
import type { State } from './model.ts'

export async function openStore(filename: string) {
  invariant(typeof filename === 'string' && filename.length > 0, 'Invalid stateFile')
  const stateFile = resolve(filename)
  const directory = dirname(stateFile)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await lstat(directory)
  invariant(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && (directoryStat.mode & 0o777) === 0o700, 'State directory must be private (0700), not a symlink')
  const lock = join(directory, '.scheduler.lock')
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new SchedulerError(`Scheduler lock exists: ${lock}. Manual recovery: stop all scheduler owners, verify owner.json PID/host is no longer running, back up state, then remove this lock directory. Never remove a live owner's lock.`)
    }
    throw error
  }
  const token = randomUUID()
  let released = false
  const release = async () => {
    if (released) return
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
    invariant(owner.token === token, 'Scheduler lock ownership changed; refusing removal')
    await rm(lock, { recursive: true })
    released = true
  }
  let state: State = { schemaVersion: 1, revision: 0, tasks: [], runs: [] }
  let failure: Error | undefined
  let queue: Promise<unknown> = Promise.resolve()
  async function persist(candidate: State): Promise<void> {
    const temporary = join(directory, `.scheduler-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ ...candidate, checksum: digest(candidate) }))
        await file.sync()
      } finally { await file.close() }
      await rename(temporary, stateFile)
      const parent = await open(directory, 'r')
      try { await parent.sync() } finally { await parent.close() }
    } finally { await rm(temporary, { force: true }) }
  }
  try {
    const owner = await open(join(lock, 'owner.json'), 'wx', 0o600)
    try {
      await owner.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token, createdAt: new Date().toISOString() }))
      await owner.sync()
    } finally { await owner.close() }
    let exists = true
    try {
      const stats = await lstat(stateFile)
      invariant(stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o777) === 0o600, 'Corrupt or insecure state file (0600 required)')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') exists = false
      else throw error
    }
    if (exists) {
      try {
        const { checksum, ...loaded } = JSON.parse(await readFile(stateFile, 'utf8'))
        invariant(typeof checksum === 'string' && checksum === digest(loaded), 'Corrupt state checksum')
        validateState(loaded)
        state = loaded
      } catch (error) {
        throw new SchedulerError('Corrupt scheduler JSON, schema, or snapshot digest; refusing to start', undefined, { cause: error })
      }
    } else await persist(state)
  } catch (error) {
    await rm(lock, { recursive: true, force: true })
    throw error
  }
  return {
    get value(): State { return state },
    get failure(): Error | undefined { return failure },
    change<Result>(update: (candidate: State) => Result): Promise<Result> {
      const operation = queue.then(async () => {
        if (failure) throw failure
        invariant(!released, 'Scheduler store closed')
        const candidate = structuredClone(state)
        const result = update(candidate)
        candidate.revision++
        if (candidate.runs.length > 1000) {
          const terminal = candidate.runs.filter(run => run.status !== 'preparing' && run.status !== 'sending')
          const discard = new Set(terminal.slice(0, candidate.runs.length - 1000).map(run => run.id))
          candidate.runs = candidate.runs.filter(run => !discard.has(run.id))
        }
        validateState(candidate)
        try { await persist(candidate) } catch (error) {
          failure = new SchedulerError('Scheduler storage failure; restart required before further execution', undefined, { cause: error })
          throw failure
        }
        state = candidate
        return structuredClone(result)
      })
      queue = operation.catch(() => {})
      return operation
    },
    async close() { await queue; await release() },
  }
}
