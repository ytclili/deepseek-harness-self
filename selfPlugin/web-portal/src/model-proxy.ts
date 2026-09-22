/** Fixed OpenAI-compatible model upstream; shared provider credentials never enter user containers. */
import { randomBytes, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LoginIdentity } from './contracts.js'
import { identityKey } from './identity.js'

/** Model route and request budgets owned by the deployment. */
export interface ModelProxyConfig {
  baseUrl: string
  apiKeyFile: string
  model: string
  runtimeBaseUrl: string
  maxBodyBytes: number
  timeoutMs: number
  maxConcurrent: number
  sessionTtlMs: number
}

/** Per-runtime bearer grants authorize only the configured inference endpoint. */
export class ModelProxy {
  private readonly grants = new Map<string, { token: string; hash: string; expiresAt: number; timer: NodeJS.Timeout }>()
  private readonly active = new Map<string, Set<AbortController>>()
  private closed = false
  constructor(private readonly config: ModelProxyConfig) {
    const url = new URL(config.baseUrl)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid model upstream')
  }

  /** Issue or renew a capability scoped to the verified user and login lifetime. */
  grant(identity: LoginIdentity): string {
    const key = identityKey(identity)
    const now = Date.now()
    const requestedExpiry = Math.min(now + this.config.sessionTtlMs, identity.expiresAt === null ? Infinity : Date.parse(identity.expiresAt))
    if (this.closed || !(requestedExpiry > now)) throw new Error('Model capability unavailable')
    const previous = this.grants.get(key)
    const token = previous?.token ?? randomBytes(32).toString('base64url')
    const expiresAt = Math.max(previous?.expiresAt ?? 0, requestedExpiry)
    if (previous) clearTimeout(previous.timer)
    // The runtime reads its capability at startup. Keep the token while a
    // re-login is pending; expiry denies new calls and cancels existing work.
    // Only lifecycle revocation removes it permanently.
    const timer = setTimeout(() => {
      for (const controller of this.active.get(key) ?? []) controller.abort()
    }, expiresAt - now)
    timer.unref()
    this.grants.set(key, { token, hash: hash(token), expiresAt, timer })
    return token
  }

  /** Cancel inference when the last login for an identity ends. */
  revoke(key: string): void {
    clearTimeout(this.grants.get(key)?.timer)
    this.grants.delete(key)
    for (const controller of this.active.get(key) ?? []) controller.abort()
  }

  /** Cancel every request during gateway teardown. */
  close(): void { this.closed = true; for (const key of this.grants.keys()) this.revoke(key) }

  /** Proxy only stateless chat completions, never arbitrary URLs or response retrieval. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reject = (status: number) => { if (!res.destroyed && !res.headersSent) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { message: 'Model request unavailable' } })) } }
    if (req.method !== 'POST' || req.url !== '/portal/model/v1/chat/completions') { reject(404); return }
    const supplied = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
    const digest = supplied ? hash(supplied) : ''
    const entry = [...this.grants].find(([, grant]) => grant.hash === digest && grant.expiresAt > Date.now())
    if (!entry) { reject(401); return }
    const [key] = entry
    const active = this.active.get(key) ?? new Set<AbortController>()
    if (active.size >= this.config.maxConcurrent) { reject(429); return }
    const controller = new AbortController()
    active.add(controller); this.active.set(key, active)
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const cancel = () => controller.abort()
    res.once('close', cancel)
    const abortRequest = () => { req.destroy(); res.destroy() }
    controller.signal.addEventListener('abort', abortRequest, { once: true })
    try {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > this.config.maxBodyBytes) { reject(413); return }
        chunks.push(chunk as Buffer)
      }
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
      catch { reject(400); return }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { reject(400); return }
      const body = parsed as Record<string, unknown>
      if (body.model !== this.config.model || !Array.isArray(body.messages)) { reject(400); return }
      body.store = false
      // Only this server-owned file supplies the upstream credential.
      const token = (await readFile(this.config.apiKeyFile, 'utf8')).trim()
      if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new Error('Invalid model key')
      const response = await fetch(this.config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: controller.signal, redirect: 'manual',
      })
      if (!response.ok || !response.body) { await response.body?.cancel(); reject(response.status === 429 ? 429 : 502); return }
      res.writeHead(200, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
      for await (const chunk of response.body) {
        if (controller.signal.aborted) break
        if (!res.write(chunk)) await new Promise<void>(resolve => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve() }
          res.once('drain', done); res.once('close', done)
        })
      }
      res.end()
    } catch {
      if (res.headersSent) res.destroy()
      else reject(502)
    } finally {
      clearTimeout(timer); res.off('close', cancel); controller.signal.removeEventListener('abort', abortRequest)
      active.delete(controller); if (!active.size) this.active.delete(key)
    }
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
