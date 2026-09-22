import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LoginIdentity, RuntimeManager } from './contracts.js'
import { SessionStore, type Session } from './sessions.js'

export interface LoginControllerOptions {
  backend: { login(account: string, password: string, signal: AbortSignal): Promise<LoginIdentity | null> }
  manager: RuntimeManager
  sessions: SessionStore
  publicOrigin: string
  loginTimeoutMs?: number
  runtimeTimeoutMs?: number
  bodyTimeoutMs?: number
  maxBodyBytes?: number
  maxConcurrent?: number
  rateWindowMs?: number
  maxAttempts?: number
  maxGlobalAttempts?: number
  maxRateEntries?: number
}

export interface LoginController {
  readonly cookieName: string
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  getSession(req: IncomingMessage): Session | undefined
  close(): void
}

function respond(res: ServerResponse, status: number, body: object): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = () => { cleanup(); req.pause(); reject(new Error('Invalid request')) }
    const onAbort = () => fail()
    const onError = () => fail()
    const onData = (chunk: Buffer) => {
      length += chunk.length
      if (length > maxBytes) { fail(); return }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) } catch { reject(new Error('Invalid request')) }
    }
    const timer = setTimeout(fail, timeoutMs)
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) fail()
  })
}

async function bounded<T>(controller: AbortController, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  try {
    if (controller.signal.aborted) throw new Error('Aborted')
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Aborted'))
        controller.signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => controller.abort(), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (abort) controller.signal.removeEventListener('abort', abort)
  }
}

export function createLoginController(options: LoginControllerOptions): LoginController {
  const origin = new URL(options.publicOrigin)
  const secure = origin.protocol === 'https:'
  if (origin.origin !== options.publicOrigin || (!secure && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('publicOrigin must be HTTPS or loopback HTTP')
  const cookieName = secure ? '__Host-dsh-portal' : 'dsh-portal'
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  const limits = {
    loginTimeoutMs: options.loginTimeoutMs ?? 10_000,
    runtimeTimeoutMs: options.runtimeTimeoutMs ?? 120_000,
    bodyTimeoutMs: options.bodyTimeoutMs ?? 10_000,
    maxBodyBytes: options.maxBodyBytes ?? 4096,
    maxConcurrent: options.maxConcurrent ?? 8,
    rateWindowMs: options.rateWindowMs ?? 60_000,
    maxAttempts: options.maxAttempts ?? 10,
    maxGlobalAttempts: options.maxGlobalAttempts ?? 100,
    maxRateEntries: options.maxRateEntries ?? 2000,
  }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('Invalid login limits')
  const requests = new Set<AbortController>()
  const rates = new Map<string, { count: number; expiresAt: number }>()
  let closed = false
  const cookieId = (req: IncomingMessage): string | undefined => {
    const matches = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`))
    return matches.length === 1 ? matches[0]?.slice(cookieName.length + 1) : undefined
  }
  const getSession = (req: IncomingMessage): Session | undefined => {
    const id = cookieId(req)
    return id ? options.sessions.get(id) : undefined
  }
  const allowAttempt = (ip: string, account?: string): boolean => {
    const now = Date.now()
    for (const [key, rate] of rates) if (rate.expiresAt <= now) rates.delete(key)
    const key = account === undefined ? `ip:${ip}` : `account:${createHash('sha256').update(JSON.stringify([ip, account])).digest('hex')}`
    const keys = account === undefined ? [key, 'global'] : [key]
    if (rates.size + keys.filter(item => !rates.has(item)).length > limits.maxRateEntries) return false
    for (const item of keys) if ((rates.get(item)?.count ?? 0) >= (item === 'global' ? limits.maxGlobalAttempts : limits.maxAttempts)) return false
    for (const item of keys) {
      const rate = rates.get(item) ?? { count: 0, expiresAt: now + limits.rateWindowMs }
      rate.count++
      rates.set(item, rate)
    }
    return true
  }

  return {
    cookieName,
    getSession,
    close() { closed = true; for (const request of requests) request.abort(); rates.clear() },
    async handle(req, res) {
      const path = req.url?.split('?')[0]
      if (!['/portal/session', '/portal/login', '/portal/logout'].includes(path ?? '')) return false
      if (closed) { respond(res, 503, { error: 'service_unavailable' }); return true }
      if (path === '/portal/session') {
        if (req.method !== 'GET') { respond(res, 405, { error: 'invalid_request' }); return true }
        const session = getSession(req)
        respond(res, session ? 200 : 401, session ? { authenticated: true, expiresAt: session.expiresAt } : { authenticated: false })
        return true
      }
      if (req.method !== 'POST') { respond(res, 405, { error: 'invalid_request' }); return true }
      if (req.headers.origin !== origin.origin) { respond(res, 403, { error: 'forbidden' }); return true }
      if (path === '/portal/logout') {
        const id = cookieId(req)
        if (id) options.sessions.revoke(id)
        res.setHeader('Set-Cookie', `${cookieName}=; ${cookieFlags}; Max-Age=0`)
        respond(res, 200, { authenticated: false })
        return true
      }
      if (requests.size >= limits.maxConcurrent || !allowAttempt(req.socket.remoteAddress ?? 'unknown')) {
        res.setHeader('Retry-After', Math.ceil(limits.rateWindowMs / 1000))
        respond(res, 429, { error: 'too_many_requests' }); return true
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { respond(res, 400, { error: 'invalid_request' }); return true }
      const controller = new AbortController()
      const disconnected = () => { if (!res.writableEnded) controller.abort() }
      requests.add(controller)
      req.once('aborted', disconnected)
      res.once('close', disconnected)
      try {
        let input: unknown
        try { input = await readBody(req, limits.maxBodyBytes, limits.bodyTimeoutMs, controller.signal) }
        catch { res.setHeader('Connection', 'close'); respond(res, 400, { error: 'invalid_request' }); return true }
        if (!input || typeof input !== 'object' || Array.isArray(input)) { respond(res, 400, { error: 'invalid_request' }); return true }
        const fields = input as Record<string, unknown>
        if (Object.keys(fields).length !== 2 || typeof fields.account !== 'string' || typeof fields.password !== 'string' || !fields.account.trim() || fields.account.length > 254 || !fields.password || fields.password.length > 1024) { respond(res, 400, { error: 'invalid_request' }); return true }
        const account = fields.account.trim()
        if (!allowAttempt(req.socket.remoteAddress ?? 'unknown', account)) { respond(res, 429, { error: 'too_many_requests' }); return true }
        const identity = await bounded(controller, limits.loginTimeoutMs, () => options.backend.login(account, fields.password as string, controller.signal))
        fields.password = ''
        if (!identity) { respond(res, 401, { error: 'invalid_credentials' }); return true }
        if (!identity.tenantId || !identity.userId || !identity.token || (identity.expiresAt !== null && !(Date.parse(identity.expiresAt) > Date.now()))) throw new Error('Invalid identity')
        await bounded(controller, limits.runtimeTimeoutMs, () => options.manager.ensure(identity, controller.signal))
        if (controller.signal.aborted || res.destroyed || closed) throw new Error('Aborted')
        const created = options.sessions.create(identity)
        const previous = cookieId(req)
        if (previous) options.sessions.revoke(previous)
        res.setHeader('Set-Cookie', `${cookieName}=${created.id}; ${cookieFlags}; Max-Age=${Math.max(0, Math.floor((created.session.expiresAt - Date.now()) / 1000))}`)
        respond(res, 200, { authenticated: true, expiresAt: created.session.expiresAt })
      } catch { respond(res, 503, { error: 'service_unavailable' }) }
      finally {
        requests.delete(controller)
        req.off('aborted', disconnected)
        res.off('close', disconnected)
      }
      return true
    },
  }
}
