import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDependencies, type Integrations } from './host-adapters.ts'
import { createSchedulerHandler } from './host-rpc.ts'
import { openScheduler } from './runtime.ts'

type HostContext = Integrations & {
  root: { baseUrl?: string }
  effect: (setup: () => (() => void | Promise<void>)) => unknown
  connection: { fetch: { register: (route: { path: string; methods: string[]; requestBody: 'buffered'; fetch: (request: Request) => Promise<Response> }) => (() => void | Promise<void>) } }
}

export const name = 'kaidanba-scheduler'
export const inject = ['connection', 'tools', 'dshIm']

export async function apply(ctx: HostContext, config: { stateFile?: string } = {}): Promise<void> {
  let stateFile = config.stateFile
  if (stateFile === undefined) {
    if (!ctx.root.baseUrl?.startsWith('file:')) throw new Error('Scheduler requires the Harness profile directory or an absolute stateFile configuration.')
    stateFile = join(fileURLToPath(ctx.root.baseUrl), 'data', name, 'state.json')
  }
  if (typeof stateFile !== 'string' || !isAbsolute(stateFile)) throw new Error('Scheduler stateFile must be an absolute path.')
  const scheduler = await openScheduler({ stateFile, dependencies: createDependencies(ctx) })
  ctx.effect(() => () => scheduler.close())
  try {
    const dispose = ctx.connection.fetch.register({ path: '/api/kaidanba-scheduler', methods: ['POST'], requestBody: 'buffered', fetch: createSchedulerHandler(scheduler) })
    ctx.effect(() => dispose)
  } catch (error) {
    await scheduler.close()
    throw error
  }
}
