import type { Context } from '@deepseek-ai/cordis'
import type { Config as EnterpriseConfig } from './config.js'
import { createGoodsListTool } from './tools/goods-list.js'

export { Config } from './config.js'
export const name = 'enterprise-tools'
export const inject = ['tools']

export function apply(ctx: Context, config: EnterpriseConfig) {
  const tool = createGoodsListTool(config)
  const lifetime = new AbortController()
  const pending = new Set<ReturnType<typeof tool.execute>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
  })
  ctx.tools.register({
    ...tool,
    async execute(args, exec) {
      const task = tool.execute(args, { ...exec, signal: AbortSignal.any([exec.signal, lifetime.signal]) })
      pending.add(task)
      try {
        return await task
      } finally {
        pending.delete(task)
      }
    },
  })
}
