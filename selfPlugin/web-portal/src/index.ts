import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHttpBackend } from 'dsh-enterprise-auth/http'
import { AuthError } from 'dsh-enterprise-auth/types'
import { readGatewayConfig } from './config.js'
import { installGateway } from './gateway.js'
import { ModelProxy } from './model-proxy.js'
import { DockerRuntimeManager } from './runtime-manager.js'
import { prepareRuntime } from './runtime-seed.js'

export const name = 'web-portal'
export const inject = ['webServer']
export interface Config { configFile: string }
export const Config: z<Config> = z.object({ configFile: z.string().required() })

/** Compose verified ERP login, private browser sessions and independent user runtimes. */
export async function apply(ctx: Context, options: Config): Promise<void> {
  const config = await readGatewayConfig(options.configFile)
  const backend = createHttpBackend(config.backend)
  const models = new ModelProxy(config.model)
  const manager = new DockerRuntimeManager(config.docker, {
    prepare: (identity, key, paths, signal) => prepareRuntime(config, models, identity, key, paths.control, signal),
  })
  try {
    await installGateway(ctx, config, { manager, models, backend: {
      async login(account, password, signal) {
        try { return await backend.login({ account, password }, signal) }
        catch (error) { if (error instanceof AuthError && error.code === 'AUTH_FAILED') return null; throw new Error('Login service unavailable') }
      },
    } })
  } catch (error) { models.close(); await manager.close(); throw error }
}
