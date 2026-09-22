/** Private upstream proxy. Browser identity selects the destination before any bytes are forwarded. */
import { request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import type { Session } from './sessions.js'
import type { UserRuntime } from './contracts.js'
import { workspaceCopy } from './locale.js'

/** HTTP and upgrade forwarding with per-session cancellation. */
export class RuntimeProxy {
  private readonly active = new Map<Session, Set<() => void>>()
  private readonly revoked = new WeakSet<Session>()
  constructor(private readonly options: { timeoutMs: number; maxBodyBytes: number; maxPerUser?: number; maxTotal?: number }) {}

  /** Forward HTTP using the server-selected runtime, replacing all browser credentials. */
  http(session: Session, runtime: UserRuntime, req: IncomingMessage, res: ServerResponse): void {
    if (!this.accepts(session)) { res.writeHead(429); res.end(); return }
    const target = targetUrl(req, runtime)
    if (!target) { res.writeHead(400); res.end(); return }
    if (Number(req.headers['content-length']) > this.options.maxBodyBytes) { res.writeHead(413); res.end(); return }
    const upstream = request(target, { method: req.method, headers: upstreamHeaders(req, runtime) })
    const stop = () => { upstream.destroy(); res.destroy() }
    const remove = this.track(session, stop)
    let count = 0
    const onData = (chunk: Buffer) => {
      count += chunk.length
      if (count > this.options.maxBodyBytes) stop()
    }
    req.on('data', onData)
    req.once('aborted', stop)
    const timer = setTimeout(stop, this.options.timeoutMs)
    res.once('close', () => {
      clearTimeout(timer); remove(); req.off('data', onData); req.off('aborted', stop); upstream.destroy()
    })
    upstream.on('error', () => {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else { res.writeHead(502, { 'cache-control': 'no-store' }); res.end('Upstream unavailable') }
    })
    upstream.once('response', incoming => {
      const headers = cleanHeaders(incoming.headers)
      // Native browser authentication remains server-side; no upstream cookie reaches the client.
      delete headers['set-cookie']
      delete headers['www-authenticate']
      if (typeof headers.location === 'string') {
        let location: URL
        try {
          location = new URL(headers.location, runtime.origin)
          if (location.origin !== runtime.origin || location.searchParams.has('token')) throw new Error('Invalid redirect')
        } catch {
          incoming.destroy(); res.writeHead(502); res.end('Invalid upstream redirect'); return
        }
        headers.location = location.pathname + location.search + location.hash
      }
      headers['cache-control'] = 'no-store'
      if (req.method === 'GET' && target.pathname === '/' && incoming.statusCode === 200
        && /^text\/html(?:\s*;|\s*$)/i.test(incoming.headers['content-type'] ?? '')) {
        void homepageHtml(incoming).then(body => {
          if (res.destroyed || res.writableEnded) return
          for (const name of ['content-encoding', 'content-length', 'etag', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'last-modified', 'accept-ranges']) delete headers[name]
          headers['content-length'] = String(body.length)
          res.writeHead(200, headers); res.end(body)
        }).catch(() => {
          incoming.destroy()
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(502, { 'cache-control': 'no-store' }); res.end('Upstream unavailable')
          }
        })
        return
      }
      res.writeHead(incoming.statusCode ?? 502, headers)
      incoming.on('error', stop)
      incoming.pipe(res)
    })
    req.pipe(upstream)
  }

  /** Forward a native WebSocket upgrade; cancellation covers pending handshakes and open sockets. */
  upgrade(session: Session, runtime: UserRuntime, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.accepts(session)) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return }
    const target = targetUrl(req, runtime)
    if (!target) { socket.destroy(); return }
    const headers = upstreamHeaders(req, runtime)
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
    const upstream = request(target, { headers })
    let peer: Duplex | undefined
    const stop = () => { upstream.destroy(); peer?.destroy(); socket.destroy() }
    const remove = this.track(session, stop)
    const timer = setTimeout(stop, this.options.timeoutMs)
    socket.once('close', () => { clearTimeout(timer); remove(); upstream.destroy(); peer?.destroy() })
    socket.on('error', stop)
    upstream.on('error', stop)
    upstream.on('response', incoming => { incoming.resume(); stop() })
    upstream.once('upgrade', (response, backend, backendHead) => {
      peer = backend
      clearTimeout(timer)
      if (socket.destroyed) { backend.destroy(); return }
      const safeHeaders = cleanHeaders(response.headers)
      delete safeHeaders['set-cookie']
      const rows = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket']
      for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
        const value = safeHeaders[name]
        if (typeof value === 'string') rows.push(`${name}: ${value}`)
      }
      socket.write(rows.join('\r\n') + '\r\n\r\n')
      if (backendHead.length) socket.write(backendHead)
      if (head.length) backend.write(head)
      backend.on('error', stop)
      backend.once('close', () => socket.destroy())
      socket.pipe(backend).pipe(socket)
    })
    upstream.end()
  }

  /** End all pending and active requests owned by a revoked browser session. */
  revoke(session: Session): void {
    this.revoked.add(session)
    for (const stop of this.active.get(session) ?? []) stop()
    this.active.delete(session)
  }

  /** Synchronously cancel every tracked stream before the webserver closes. */
  close(): void { for (const session of this.active.keys()) this.revoke(session) }

  private accepts(session: Session): boolean {
    if (this.revoked.has(session) || session.expiresAt <= Date.now()) return false
    let total = 0; let owned = 0
    for (const [other, entries] of this.active) { total += entries.size; if (other.key === session.key) owned += entries.size }
    return owned < (this.options.maxPerUser ?? 64) && total < (this.options.maxTotal ?? 512)
  }

  private track(session: Session, stop: () => void): () => void {
    const entries = this.active.get(session) ?? new Set<() => void>()
    entries.add(stop); this.active.set(session, entries)
    return () => { entries.delete(stop); if (!entries.size) this.active.delete(session) }
  }
}

/** Bound both transfer and decoded size; only the native document is buffered. */
async function homepageHtml(incoming: IncomingMessage): Promise<Buffer> {
  const limit = 2 * 1024 * 1024
  const encoding = (incoming.headers['content-encoding'] ?? 'identity').trim().toLowerCase()
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
    : encoding === 'br' ? createBrotliDecompress() : undefined
  if (!decoder && encoding !== 'identity') throw new Error('Unsupported HTML encoding')
  let transferred = 0; let decoded = 0
  const chunks: Buffer[] = []
  const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    transferred += chunk.length
    callback(transferred > limit ? new Error('HTML transfer too large') : null, chunk)
  } })
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
    decoded += chunk.length
    if (decoded > limit) { callback(new Error('HTML document too large')); return }
    chunks.push(chunk); callback()
  } })
  if (decoder) await pipeline(incoming, bound, decoder, sink)
  else await pipeline(incoming, bound, sink)
  let html = Buffer.concat(chunks).toString('utf8')
  const stylesheet = '<link rel="stylesheet" href="/web-portal/account.css">'
  const account = `<a class="portal-account-link" href="/login">${workspaceCopy.account}</a>`
  html = /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, stylesheet + '$&') : stylesheet + html
  html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, account + '$&') : html + account
  return Buffer.from(html)
}

function cleanHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...(headers.connection ?? '').toLowerCase().split(',').map(x => x.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)))
}

function upstreamHeaders(req: IncomingMessage, runtime: UserRuntime): IncomingHttpHeaders {
  const headers = cleanHeaders(req.headers)
  for (const name of Object.keys(headers)) {
    if (name.startsWith('x-forwarded-') || ['authorization', 'cookie', 'forwarded', 'referer', 'origin', 'host'].includes(name)) delete headers[name]
  }
  headers.host = new URL(runtime.origin).host
  headers.origin = runtime.origin
  headers.cookie = runtime.cookie
  return headers
}

function targetUrl(req: IncomingMessage, runtime: UserRuntime): URL | undefined {
  const path = req.url ?? '/'
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) return undefined
  const url = new URL(path, runtime.origin)
  if (url.origin !== runtime.origin) return undefined
  // Harness combo routes use a raw ??module-list query; URLSearchParams
  // serialization would escape that syntax even when no token is present.
  if (url.searchParams.has('token')) {
    const query = url.search.slice(1).split('&').filter(part => !new URLSearchParams(part).has('token')).join('&')
    url.search = query ? '?' + query : ''
  }
  return url
}
