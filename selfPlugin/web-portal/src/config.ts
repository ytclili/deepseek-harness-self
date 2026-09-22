import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { HttpConfig } from 'dsh-enterprise-auth/http'
import type { DockerRuntimeConfig } from './runtime-manager.js'
import type { ModelProxyConfig } from './model-proxy.js'

/** Private deployment configuration. Browser input never selects runtime destinations. */
export interface GatewayConfig {
  publicOrigin: string
  networkPolicyFile: string
  backend: HttpConfig
  docker: DockerRuntimeConfig
  model: ModelProxyConfig
  sessionTtlMs: number
  maxSessions: number
  proxyTimeoutMs: number
  maxProxyBodyBytes: number
  businessTimeoutMs: number
  goodsMaxItems: number
}

/** Read bounded administrator configuration and require the installed network policy. */
export async function readGatewayConfig(path: string): Promise<GatewayConfig> {
  if (!isAbsolute(path)) throw new Error('Portal configFile must be absolute')
  const raw = await readFile(path)
  if (raw.length > 65_536) throw new Error('Portal config too large')
  const input = JSON.parse(raw.toString('utf8')) as Partial<GatewayConfig>
  const config: GatewayConfig = {
    sessionTtlMs: 28_800_000, maxSessions: 1000, proxyTimeoutMs: 600_000,
    maxProxyBodyBytes: 67_108_864, businessTimeoutMs: 10_000, goodsMaxItems: 100,
    ...input,
    publicOrigin: input.publicOrigin ?? '', networkPolicyFile: input.networkPolicyFile ?? '',
    backend: input.backend!,
    docker: { maxInstances: 3, memoryBytes: 2_147_483_648, nanoCpus: 1_000_000_000, pidsLimit: 256, activationTimeoutMs: 120_000, ...input.docker } as DockerRuntimeConfig,
    model: { maxBodyBytes: 16_777_216, timeoutMs: 300_000, maxConcurrent: 2, ...input.model, sessionTtlMs: input.sessionTtlMs ?? 28_800_000 } as ModelProxyConfig,
  }
  const origin = new URL(config.publicOrigin)
  if (origin.origin !== config.publicOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('Invalid publicOrigin')
  for (const value of [config.sessionTtlMs, config.maxSessions, config.proxyTimeoutMs, config.maxProxyBodyBytes, config.businessTimeoutMs, config.goodsMaxItems, config.model.maxBodyBytes, config.model.timeoutMs, config.model.maxConcurrent]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('Invalid portal budget')
  }
  if (!isAbsolute(config.networkPolicyFile) || !isAbsolute(config.model.apiKeyFile)) throw new Error('Portal private file paths must be absolute')
  const internal = new URL(config.model.runtimeBaseUrl)
  if (internal.protocol !== 'http:' || internal.hostname !== 'host.docker.internal' || !internal.port || internal.username || internal.password || internal.search || internal.hash || internal.pathname !== '/portal/model/v1') throw new Error('Invalid runtime model route')
  const policy = JSON.parse(await readFile(config.networkPolicyFile, 'utf8')) as Record<string, unknown>
  if (policy.version !== 1 || policy.interfacePrefix !== 'dshp' || policy.gatewayPort !== Number(internal.port) || policy.denyPrivate !== true) throw new Error('Portal network policy must be installed first')
  return config
}
