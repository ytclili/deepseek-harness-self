import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { EnterpriseAuth } from 'dsh-enterprise-auth'
import { createHttpBackend, type HttpConfig } from 'dsh-enterprise-auth/http'
import { AuthError, type AuthBackend, type LoginIdentity } from 'dsh-enterprise-auth/types'
import { identityKey } from './identity.js'

export const name = 'portal-user-business'
export const inject = ['tools']

export interface Config {
  credentialFile: string
  identityKey: string
  backend: HttpConfig
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  credentialFile: Schema.string().required(),
  identityKey: Schema.string().required(),
  timeoutMs: Schema.number().default(10_000),
  backend: Schema.object({
    baseUrl: Schema.string().required(), loginPath: Schema.string().required(),
    loginResponseMode: Schema.union(['business-code', 'http-status']).default('business-code'),
    accountField: Schema.string().required(), passwordField: Schema.string().required(),
    tokenPath: Schema.string().required(), userIdPath: Schema.string().required(), tenantIdPath: Schema.string().required(),
    expiresAtPath: Schema.string(), codePath: Schema.string().required(),
    successCode: Schema.number().required(), unauthorizedCode: Schema.number().required(), forbiddenCode: Schema.number().required(),
    allowedApiPrefixes: Schema.array(Schema.string()).required(), maxResponseBytes: Schema.number().default(1_048_576),
  }).required(),
})

const messages = {
  AUTH_REQUIRED: '登录已失效，请通过网页重新登录。',
  AUTH_FAILED: '企业授权已失效，请通过网页重新登录。',
  FORBIDDEN: '当前账号没有执行此操作的权限。',
  BUSINESS_REJECTED: '业务接口未接受此操作，请检查业务参数。',
  INVALID_INPUT: '请求参数不正确，请检查后重试。',
  INVALID_RESPONSE: '业务接口返回格式不正确，请联系管理员。',
  NOT_CONFIGURED: '企业业务接口尚未配置，请联系管理员。',
  STORAGE_UNAVAILABLE: '授权凭据不可用，请通过网页重新登录或联系管理员。',
  SERVICE_UNAVAILABLE: '业务接口暂时不可用，请稍后重试。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  CANCELLED: '操作已取消。',
  TIMEOUT: '接口请求超时，请稍后重试。',
  RESULT_UNKNOWN: '操作结果尚未确认，请先核对业务结果，不要直接重复提交。',
  CLOSED: '企业身份服务已停止。',
} as const
type ErrorCode = keyof typeof messages
function failure(code: ErrorCode): AuthError { return new AuthError(code, messages[code]) }
function sanitized(error: unknown): AuthError {
  const code = error instanceof AuthError && Object.hasOwn(messages, error.code) ? error.code as ErrorCode : 'SERVICE_UNAVAILABLE'
  return failure(code)
}

async function readCredential(path: string, expectedKey: string, signal: AbortSignal): Promise<LoginIdentity> {
  if (signal.aborted) throw failure('CANCELLED')
  let value: unknown
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size <= 0 || stat.size > 16_384) throw failure('STORAGE_UNAVAILABLE')
      const buffer = Buffer.alloc(16_385)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 16_384) throw failure('STORAGE_UNAVAILABLE')
      try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown }
      finally { buffer.fill(0) }
    } finally { await file.close() }
  } catch { throw failure('STORAGE_UNAVAILABLE') }
  if (signal.aborted) throw failure('CANCELLED')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('AUTH_REQUIRED')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).length !== 4 || typeof fields.tenantId !== 'string' || !fields.tenantId || fields.tenantId.length > 256 || typeof fields.userId !== 'string' || !fields.userId || fields.userId.length > 256 || typeof fields.token !== 'string' || !fields.token || fields.token.length > 8192 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(fields.token) || !(fields.expiresAt === null || (typeof fields.expiresAt === 'string' && Date.parse(fields.expiresAt) > Date.now()))) throw failure('AUTH_REQUIRED')
  const credential: LoginIdentity = { tenantId: fields.tenantId, userId: fields.userId, token: fields.token, expiresAt: fields.expiresAt }
  if (identityKey(credential) !== expectedKey) throw failure('AUTH_REQUIRED')
  return credential
}

export function createUserBusinessService(options: {
  credentialFile: string
  identityKey: string
  timeoutMs: number
  backend: Pick<AuthBackend, 'request'>
}): EnterpriseAuth & { close(): Promise<void> } {
  if (!isAbsolute(options.credentialFile) || !/^[a-f0-9]{64}$/.test(options.identityKey) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 60_000) throw failure('INVALID_INPUT')
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  let closed = false
  return Object.freeze({
    registerIngress() { throw failure('AUTH_REQUIRED') },
    async login() { throw failure('AUTH_REQUIRED') },
    request(exec, input) {
      const operation = (async () => {
        if (closed) throw failure('CLOSED')
        if (exec.signal.aborted) throw failure('CANCELLED')
        if (active.size >= 32) throw failure('RATE_LIMITED')
        const deadline = new AbortController()
        const signal = AbortSignal.any([exec.signal, lifetime.signal, deadline.signal])
        const timeout = setTimeout(() => deadline.abort(), options.timeoutMs)
        let dispatched = false
        let onAbort: () => void = () => {}
        try {
          return await new Promise<unknown>((resolve, reject) => {
            onAbort = () => reject(failure(dispatched && input.method !== 'GET' ? 'RESULT_UNKNOWN' : deadline.signal.aborted ? 'TIMEOUT' : 'CANCELLED'))
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) { onAbort(); return }
            void (async () => {
              const credential = await readCredential(options.credentialFile, options.identityKey, signal)
              if (signal.aborted) throw failure('CANCELLED')
              dispatched = true
              return options.backend.request(input, credential.token, signal)
            })().then(resolve, error => reject(sanitized(error)))
          })
        } finally { clearTimeout(timeout); signal.removeEventListener('abort', onAbort) }
      })()
      active.add(operation)
      void operation.then(() => active.delete(operation), () => active.delete(operation))
      return operation
    },
    async close() {
      closed = true
      lifetime.abort()
      await Promise.allSettled(active)
    },
  } satisfies EnterpriseAuth & { close(): Promise<void> })
}

/** Load only inside one isolated, verified user's runtime; never in a shared IM profile. */
export function apply(ctx: Context, config: Config): void {
  const service = createUserBusinessService({ ...config, backend: createHttpBackend(config.backend) })
  ctx.provide('enterpriseAuth', service)
  ctx.effect(() => () => service.close())
}
