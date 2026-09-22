/** Generate only per-user control files; never copy an administrator home or write through a user home. */
import { randomBytes } from 'node:crypto'
import { open, rename, unlink, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { HttpConfig } from 'dsh-enterprise-auth/http'
import type { LoginIdentity } from './contracts.js'
import type { ModelProxy, ModelProxyConfig } from './model-proxy.js'

/** Deployment-owned settings needed by the isolated runtime. */
export interface SeedConfig {
  backend: HttpConfig
  model: ModelProxyConfig
  businessTimeoutMs: number
  goodsMaxItems: number
}

/** Create/rotate files in the read-only per-user control mount, not inside the user-writable home. */
export async function prepareRuntime(config: SeedConfig, models: ModelProxy, identity: LoginIdentity, key: string, control: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const stat = await lstat(control)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid runtime control directory')
  signal.throwIfAborted()
  const capability = models.grant(identity)
  const provider = {
    displayName: 'NextBOS AI', api: 'openai-completions', apiKeyEnv: 'PORTAL_MODEL_KEY',
    baseURL: config.model.runtimeBaseUrl, models: [{ id: config.model.model, name: config.model.model }],
  }
  const patch = [
    { id: 'webserver', config: { host: '0.0.0.0', port: 3080 } },
    { insert: [
      { id: 'portal-user-business', name: 'dsh-web-portal/user-business', config: { credentialFile: '/run/portal/business.json', identityKey: key, backend: config.backend, timeoutMs: config.businessTimeoutMs } },
      { id: 'enterprise-tools', name: 'dsh-enterprise-tools', config: { baseUrl: config.backend.baseUrl, tokenFile: '/run/portal/business.token', timeoutMs: config.businessTimeoutMs, maxResponseBytes: config.backend.maxResponseBytes, maxItems: config.goodsMaxItems } },
    ] },
  ]
  const files: Record<string, string> = {
    'business.json': JSON.stringify(identity),
    'business.token': identity.token,
    'model.env': `PORTAL_MODEL_KEY=${capability}\n`,
    'settings.json': JSON.stringify({ 'llm-pi-ai': { providers: { portal: provider } }, 'agent-default-model': { provider: 'portal', model: config.model.model }, 'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' } }),
    'user.patch.json': JSON.stringify(patch),
  }
  for (const [name, value] of Object.entries(files)) {
    signal.throwIfAborted()
    await atomicControlFile(control, name, value, signal)
  }
}

async function atomicControlFile(directory: string, name: string, content: string, signal: AbortSignal): Promise<void> {
  const temporary = join(directory, `.${name}.${randomBytes(12).toString('hex')}`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { await handle.writeFile(content); await handle.chown(1000, 1000); await handle.sync() }
    finally { await handle.close() }
    signal.throwIfAborted()
    await rename(temporary, join(directory, name))
  }
  catch (error) { await unlink(temporary); throw error }
}
