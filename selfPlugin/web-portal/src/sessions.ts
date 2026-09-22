import { createHash, randomBytes } from 'node:crypto'
import type { LoginIdentity } from './contracts.js'
import { identityKey } from './identity.js'

export interface Session {
  readonly identity: LoginIdentity
  readonly key: string
  readonly expiresAt: number
}

export interface SessionStoreOptions {
  ttlMs?: number
  maxSessions?: number
  onRevoke?: (session: Session) => void
}

export class SessionStore {
  private readonly entries = new Map<string, { session: Session; timer: NodeJS.Timeout }>()
  private readonly ttlMs: number
  private readonly maxSessions: number
  private readonly onRevoke: ((session: Session) => void) | undefined
  private closed = false

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1000
    this.maxSessions = options.maxSessions ?? 1000
    this.onRevoke = options.onRevoke
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 2_147_483_647 || !Number.isSafeInteger(this.maxSessions) || this.maxSessions <= 0) throw new Error('Invalid session limits')
  }

  create(identity: LoginIdentity): { id: string; session: Session } {
    this.prune()
    if (this.closed || this.entries.size >= this.maxSessions) throw new Error('Session capacity unavailable')
    const now = Date.now()
    const backendExpiry = identity.expiresAt === null ? Infinity : Date.parse(identity.expiresAt)
    const expiresAt = Math.min(now + this.ttlMs, backendExpiry)
    if (!identity.tenantId || !identity.userId || !identity.token || !(expiresAt > now)) throw new Error('Invalid identity')
    const id = randomBytes(32).toString('base64url')
    const hash = this.hash(id)
    const session: Session = Object.freeze({ identity: Object.freeze({ ...identity }), key: identityKey(identity), expiresAt })
    const timer = setTimeout(() => this.remove(hash), expiresAt - now)
    timer.unref()
    this.entries.set(hash, { session, timer })
    return { id, session }
  }

  get(id: string): Session | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined
    const hash = this.hash(id)
    const entry = this.entries.get(hash)
    if (entry && entry.session.expiresAt <= Date.now()) { this.remove(hash); return undefined }
    return entry?.session
  }

  hasKey(key: string): boolean {
    this.prune()
    return [...this.entries.values()].some(entry => entry.session.key === key)
  }

  revoke(id: string): void { this.remove(this.hash(id)) }

  revokeKey(key: string): void {
    for (const [hash, entry] of this.entries) if (entry.session.key === key) this.remove(hash)
  }

  close(): void {
    this.closed = true
    for (const hash of this.entries.keys()) this.remove(hash)
  }

  private hash(id: string): string { return createHash('sha256').update(id).digest('hex') }

  private prune(): void {
    for (const [hash, entry] of this.entries) if (entry.session.expiresAt <= Date.now()) this.remove(hash)
  }

  private remove(hash: string): void {
    const entry = this.entries.get(hash)
    if (!entry) return
    this.entries.delete(hash)
    clearTimeout(entry.timer)
    this.onRevoke?.(entry.session)
  }
}
