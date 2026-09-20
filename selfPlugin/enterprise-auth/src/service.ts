import { randomUUID } from 'node:crypto'
import { AuthError, validatePrincipal } from './types.js'
import type { ApiRequest, AuthBackend, AuthService, CredentialStore, LoginInput, LoginResult, Principal } from './types.js'

const messages: Record<string, string> = {
  IDENTITY_REQUIRED: '无法确认消息发送者，请通过已接入的机器人私聊操作。',
  AUTH_REQUIRED: '请先在机器人私聊中提供 nextbos ERP 系统的邮箱账号和密码，登录后继续操作。',
  AUTH_FAILED: '登录失败，请检查账号和密码。',
  FORBIDDEN: '当前账号没有执行此操作的权限。',
  BUSINESS_REJECTED: '业务接口未接受此操作，请检查业务参数。',
  INVALID_INPUT: '请求参数不正确，请检查后重试。',
  INVALID_RESPONSE: '业务接口返回格式不正确，请联系管理员检查接口配置。',
  NOT_CONFIGURED: '企业登录接口尚未配置，请联系管理员。',
  STORAGE_UNAVAILABLE: '身份凭据存储不可用，请联系管理员检查。',
  SERVICE_UNAVAILABLE: '无法完成业务接口请求，请稍后重试。',
  RATE_LIMITED: '登录请求过于频繁，请稍后重试。',
  LOGIN_BUSY: '当前用户正在登录，请等待本次登录完成。',
  CANCELLED: '操作已取消。',
  TIMEOUT: '接口请求超时，请稍后重试。',
  RESULT_UNKNOWN: '操作结果尚未确认，请先查询业务结果，不要直接重复提交。',
  CLOSED: '企业身份服务已停止。',
}

export function publicError(error: unknown): AuthError {
  const code = error instanceof AuthError && Object.hasOwn(messages, error.code) ? error.code : 'SERVICE_UNAVAILABLE'
  return new AuthError(code, messages[code]!)
}

function failure(code: string): AuthError {
  return new AuthError(code, messages[code]!)
}

export function createAuthService(options: { store: CredentialStore; backend: AuthBackend; timeoutMs: number; maxLoginAttempts: number; loginWindowMs: number }): AuthService {
  const { store, backend, timeoutMs, maxLoginAttempts, loginWindowMs } = options
  if (![timeoutMs, maxLoginAttempts, loginWindowMs].every(value => Number.isSafeInteger(value) && value > 0)) throw failure('INVALID_INPUT')
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  const loggingIn = new Set<string>()
  const attempts = new Map<string, { count: number; until: number }>()
  let closed = false
  let closePromise: Promise<void> | undefined

  function track<Result>(operation: Promise<Result>): Promise<Result> {
    active.add(operation)
    void operation.then(() => active.delete(operation), () => active.delete(operation))
    return operation
  }
  function current(principal: Principal, signal: AbortSignal): Principal {
    if (closed) throw failure('CLOSED')
    if (signal.aborted) throw failure('CANCELLED')
    validatePrincipal(principal)
    return Object.freeze({ platform: principal.platform, botId: principal.botId, senderId: principal.senderId })
  }
  async function bounded<Result>(signal: AbortSignal, invoke: (signal: AbortSignal) => Promise<Result>, write = false): Promise<Result> {
    const deadline = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal, deadline.signal])
    const timeout = setTimeout(() => deadline.abort(), timeoutMs)
    let abort: () => void = () => {}
    try {
      return await new Promise<Result>((resolve, reject) => {
        abort = () => reject(failure(write ? 'RESULT_UNKNOWN' : deadline.signal.aborted ? 'TIMEOUT' : 'CANCELLED'))
        combined.addEventListener('abort', abort, { once: true })
        if (combined.aborted) { abort(); return }
        Promise.resolve().then(() => {
          if (combined.aborted) throw failure('CANCELLED')
          return invoke(combined)
        }).then(resolve, error => reject(publicError(error)))
      })
    } finally {
      clearTimeout(timeout)
      combined.removeEventListener('abort', abort)
    }
  }

  return {
    login(principal, input, signal) {
      return track((async (): Promise<LoginResult> => {
        const identity = current(principal, signal)
        if (!input || typeof input !== 'object' || Object.keys(input).length !== 2 || typeof input.account !== 'string' || !input.account.trim() || input.account.length > 256 || typeof input.password !== 'string' || !input.password || input.password.length > 1024 || input.password.includes('\0')) throw failure('INVALID_INPUT')
        const credentials: LoginInput = { account: input.account.trim(), password: input.password }
        const key = JSON.stringify(identity)
        if (loggingIn.has(key)) throw failure('LOGIN_BUSY')
        const timestamp = Date.now()
        for (const [entry, limit] of attempts) if (limit.until <= timestamp) attempts.delete(entry)
        const limit = attempts.get(key)
        if ((limit && limit.count >= maxLoginAttempts) || (!limit && attempts.size >= 10000) || loggingIn.size >= 128) throw failure('RATE_LIMITED')
        attempts.set(key, { count: (limit?.count ?? 0) + 1, until: limit?.until ?? timestamp + loginWindowMs })
        loggingIn.add(key)
        try {
          const result = await bounded(signal, activeSignal => backend.login(credentials, activeSignal))
          current(identity, signal)
          const saved = { ...result, version: randomUUID(), updatedAt: new Date().toISOString() }
          try { await store.put(identity, saved) } catch { throw failure('STORAGE_UNAVAILABLE') }
          return { status: 'authenticated', message: '登录成功，可以继续操作。' }
        } finally {
          credentials.password = ''
          loggingIn.delete(key)
        }
      })())
    },
    request(principal: Principal, input: ApiRequest, signal: AbortSignal) {
      return track((async () => {
        const identity = current(principal, signal)
        let credential
        try { credential = store.get(identity) } catch { throw failure('STORAGE_UNAVAILABLE') }
        if (!credential) throw failure('AUTH_REQUIRED')
        if (credential.expiresAt !== null && Date.parse(credential.expiresAt) <= Date.now()) {
          try { await store.remove(identity, credential.version) } catch { throw failure('STORAGE_UNAVAILABLE') }
          throw failure('AUTH_REQUIRED')
        }
        try {
          return await bounded(signal, activeSignal => backend.request(input, credential.token, activeSignal), input.method !== 'GET')
        } catch (error) {
          const safe = publicError(error)
          if (safe.code === 'AUTH_REQUIRED') {
            try { await store.remove(identity, credential.version) } catch { throw failure('STORAGE_UNAVAILABLE') }
          }
          throw safe
        }
      })())
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      lifetime.abort()
      closePromise = (async () => {
        await Promise.allSettled([...active])
        await store.close()
      })()
      return closePromise
    },
  }
}
