import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { GatewayConfig } from './config.js'
import type { LoginIdentity, RuntimeManager, UserRuntime } from './contracts.js'
import type { ModelProxy } from './model-proxy.js'
import { createLoginController } from './login-controller.js'
import { SessionStore } from './sessions.js'
import { identityKey } from './identity.js'
import { RuntimeProxy } from './proxy.js'

interface Dependencies {
  backend: { login(account: string, password: string, signal: AbortSignal): Promise<LoginIdentity | null> }
  manager: RuntimeManager
  models: Pick<ModelProxy, 'handle' | 'grant' | 'revoke' | 'close'>
}
type Asset = { body: Buffer; type: string }
const MIME: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }

async function loadAssets(root: string, prefix = '/web-portal'): Promise<Map<string, Asset>> {
  const assets = new Map<string, Asset>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    const url = `${prefix}/${entry.name}`
    if (entry.isDirectory()) for (const [key, value] of await loadAssets(path, url)) assets.set(key, value)
    else if (entry.isFile() && MIME[extname(entry.name)]) assets.set(url, { body: await readFile(path), type: MIME[extname(entry.name)]! })
  }
  return assets
}
function respond(req: IncomingMessage, res: ServerResponse, status: number, body: string | Buffer, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/** Install an independent gateway; no shared native Harness instance is exposed here. */
export async function installGateway(ctx: Context, config: GatewayConfig, dependencies: Dependencies): Promise<void> {
  if (ctx.get('connection')) throw new Error('web-portal requires a dedicated gateway profile without native connection')
  const clientRoot = fileURLToPath(new URL('../client/dist/', import.meta.url))
  const html = await readFile(join(clientRoot, 'index.html'))
  const assets = await loadAssets(clientRoot)
  const origin = new URL(config.publicOrigin)
  const proxy = new RuntimeProxy({ timeoutMs: config.proxyTimeoutMs, maxBodyBytes: config.maxProxyBodyBytes })
  const ready = new Map<string, UserRuntime>()
  const pending = new Map<string, number>()
  const stops = new Map<string, Promise<void>>()
  let closed = false
  const stopUnused = (key: string) => {
    if (closed || pending.has(key) || sessions.hasKey(key) || stops.has(key)) return
    ready.delete(key)
    dependencies.models.revoke(key)
    const stop = dependencies.manager.stop(key).catch(() => { ctx.logger.warn('Portal runtime cleanup failed') }).finally(() => stops.delete(key))
    stops.set(key, stop)
  }
  const sessions = new SessionStore({ ttlMs: config.sessionTtlMs, maxSessions: config.maxSessions, onRevoke(session) {
    proxy.revoke(session)
    setImmediate(() => stopUnused(session.key))
  } })
  const manager: RuntimeManager = {
    async ensure(identity, signal) {
      const key = identityKey(identity)
      pending.set(key, (pending.get(key) ?? 0) + 1)
      try {
        await stops.get(key)
        signal.throwIfAborted()
        const runtime = await dependencies.manager.ensure(identity, signal)
        signal.throwIfAborted()
        dependencies.models.grant(identity)
        ready.set(key, runtime)
        return runtime
      } finally {
        const count = (pending.get(key) ?? 1) - 1
        if (count) pending.set(key, count); else pending.delete(key)
        setImmediate(() => stopUnused(key))
      }
    },
    stop: key => dependencies.manager.stop(key), close: () => dependencies.manager.close(),
  }
  const controller = createLoginController({ backend: dependencies.backend, manager, sessions, publicOrigin: config.publicOrigin, runtimeTimeoutMs: config.docker.activationTimeoutMs })
  ctx.effect(() => async () => {
    closed = true
    controller.close(); sessions.close(); proxy.close(); dependencies.models.close()
    await Promise.all([...stops.values(), dependencies.manager.close()])
  }, 'web-portal: gateway lifecycle')
  const trusted = (req: IncomingMessage) => req.headers.host === origin.host && req.headers['sec-fetch-site'] !== 'cross-site' && (!req.headers.origin || req.headers.origin === config.publicOrigin)
  const publicRead = (req: IncomingMessage, res: ServerResponse) => {
    if (!trusted(req)) { respond(req, res, 403, '{"error":"forbidden"}'); return false }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('allow', 'GET, HEAD'); respond(req, res, 405, '{"error":"method_not_allowed"}'); return false }
    return true
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/login', handler(req, res) {
    if (publicRead(req, res)) respond(req, res, 200, html, 'text/html; charset=utf-8')
  } }), 'web-portal: login page')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/web-portal', handler(req, res) {
    if (!publicRead(req, res)) return
    const asset = assets.get(new URL(req.url ?? '/', config.publicOrigin).pathname)
    if (asset) respond(req, res, 200, asset.body, asset.type)
    else respond(req, res, 404, '{"error":"not_found"}')
  } }), 'web-portal: assets')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/portal/model/v1/chat/completions', handler: (req, res) => dependencies.models.handle(req, res) }), 'web-portal: model inference')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/portal', async handler(req, res) {
    if (!trusted(req)) { respond(req, res, 403, '{"error":"forbidden"}'); return }
    if (!await controller.handle(req, res)) respond(req, res, 404, '{"error":"not_found"}')
  } }), 'web-portal: account session')
  ctx.effect(() => ctx.webServer.registerFallback((req, res) => {
    if (!trusted(req)) { respond(req, res, 403, '{"error":"forbidden"}'); return }
    const session = controller.getSession(req)
    if (!session) {
      if (new URL(req.url ?? '/', config.publicOrigin).pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) respond(req, res, 200, html, 'text/html; charset=utf-8')
      else respond(req, res, 401, '{"error":"authentication_required"}')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== config.publicOrigin) { respond(req, res, 403, '{"error":"forbidden"}'); return }
    const runtime = ready.get(session.key)
    if (!runtime) { respond(req, res, 503, '{"error":"login_required"}'); return }
    proxy.http(session, runtime, req, res)
  }), 'web-portal: private HTTP')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/api/remote.mux', handler(req, socket, head) {
    const session = trusted(req) && req.headers.origin === config.publicOrigin ? controller.getSession(req) : undefined
    const runtime = session && ready.get(session.key)
    if (!session || !runtime) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    proxy.upgrade(session, runtime, req, socket, head)
  } }), 'web-portal: private realtime')
}
