import { AuthError } from './types.js'
import type { ApiRequest, AuthBackend, LoginInput } from './types.js'

export type HttpConfig = {
  baseUrl: string
  loginPath: string
  loginResponseMode?: 'business-code' | 'http-status'
  accountField: string
  passwordField: string
  tokenPath: string
  userIdPath: string
  tenantIdPath: string
  expiresAtPath?: string
  codePath: string
  successCode: number
  unauthorizedCode: number
  forbiddenCode: number
  allowedApiPrefixes: string[]
  maxResponseBytes: number
}

function invalid(): never { throw new AuthError('INVALID_INPUT', '接口配置或请求参数不正确。') }
function malformed(): never { throw new AuthError('INVALID_RESPONSE', '接口返回格式不正确。') }

function jsonField(body: unknown, path: string): unknown {
  let value = body
  for (const field of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) return undefined
    value = (value as Record<string, unknown>)[field]
  }
  return value
}

function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)) return value
  return malformed()
}

function validatePath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 4096 || /[\\\x00-\x20\x7f#]/.test(path) || /[%;]/.test(path.split('?')[0]!) || path.split('?')[0]!.includes('//') || path.split('?')[0]!.split('/').some(part => part === '..' || part === '.')) invalid()
}

function routeIdentity(url: URL): string { return url.pathname.replace(/\/+$/, '').toLowerCase() }

export function validateHttpConfig(config: HttpConfig): URL {
  let base: URL
  try { base = new URL(config.baseUrl) } catch { return invalid() }
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) invalid()
  validatePath(config.loginPath)
  if (config.loginResponseMode !== undefined && !['business-code', 'http-status'].includes(config.loginResponseMode)) invalid()
  if (config.loginPath.includes('?')) invalid()
  if (!Array.isArray(config.allowedApiPrefixes) || !config.allowedApiPrefixes.length || config.allowedApiPrefixes.length > 20) invalid()
  for (const prefix of config.allowedApiPrefixes) {
    validatePath(prefix)
    if (prefix === '/' || !prefix.endsWith('/') || prefix.includes('?')) invalid()
  }
  for (const field of [config.accountField, config.passwordField]) if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) || ['constructor', 'prototype', '__proto__'].includes(field)) invalid()
  if (config.accountField === config.passwordField) invalid()
  for (const path of [config.tokenPath, config.userIdPath, config.tenantIdPath, config.codePath, ...(config.expiresAtPath ? [config.expiresAtPath] : [])]) {
    if (typeof path !== 'string' || path.length > 256 || !path.split('.').every(field => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) && !['__proto__', 'prototype', 'constructor'].includes(field))) invalid()
  }
  const codes = [config.successCode, config.unauthorizedCode, config.forbiddenCode]
  if (!codes.every(Number.isSafeInteger) || new Set(codes).size !== 3 || !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1024 || config.maxResponseBytes > 1048576) invalid()
  return base
}

async function readJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maximum || !response.body) {
    await response.body?.cancel()
    return malformed()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maximum) {
        await reader.cancel()
        return malformed()
      }
      chunks.push(result.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { return malformed() }
}

export function createHttpBackend(input: HttpConfig, fetcher: typeof fetch = fetch): AuthBackend {
  const config = structuredClone(input)
  const base = validateHttpConfig(config)
  async function request(path: string, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal, login = false): Promise<unknown> {
    signal.throwIfAborted()
    let response: Response
    try {
      response = await fetcher(new URL(path, base), { method, headers, ...(body === undefined ? {} : { body }), signal, redirect: 'manual' })
    } catch {
      throw new AuthError(!login && method !== 'GET' ? 'RESULT_UNKNOWN' : 'SERVICE_UNAVAILABLE', '业务接口请求未完成。')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      const code = response.status === 401 ? login ? 'AUTH_FAILED' : 'AUTH_REQUIRED' : response.status === 403 ? login ? 'AUTH_FAILED' : 'FORBIDDEN' : response.status === 429 ? 'RATE_LIMITED' : !login && method !== 'GET' ? 'RESULT_UNKNOWN' : 'SERVICE_UNAVAILABLE'
      throw new AuthError(code, '业务接口未接受请求。')
    }
    let value: unknown
    try { value = await readJson(response, config.maxResponseBytes, signal) } catch (error) {
      if (!login && method !== 'GET') throw new AuthError('RESULT_UNKNOWN', '无法确认业务操作结果。')
      if (error instanceof AuthError) throw error
      return malformed()
    }
    if (login && config.loginResponseMode === 'http-status') return value
    const code = jsonField(value, config.codePath)
    if (!Number.isSafeInteger(code)) throw new AuthError(!login && method !== 'GET' ? 'RESULT_UNKNOWN' : 'INVALID_RESPONSE', '无法按接口约定确认业务结果。')
    if (code === config.unauthorizedCode) throw new AuthError(login ? 'AUTH_FAILED' : 'AUTH_REQUIRED', '登录凭据无效。')
    if (code === config.forbiddenCode) throw new AuthError(login ? 'AUTH_FAILED' : 'FORBIDDEN', '当前账号无权操作。')
    if (code !== config.successCode) throw new AuthError(login ? 'AUTH_FAILED' : method !== 'GET' ? 'RESULT_UNKNOWN' : 'BUSINESS_REJECTED', '业务接口未接受请求。')
    return value
  }
  return {
    async login(input: LoginInput, signal: AbortSignal) {
      const body = JSON.stringify({ [config.accountField]: input.account, [config.passwordField]: input.password })
      const value = await request(config.loginPath, 'POST', { 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal, true)
      const token = jsonField(value, config.tokenPath)
      if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) return malformed()
      let expiresAt: string | null = null
      if (config.expiresAtPath) {
        const expiry = jsonField(value, config.expiresAtPath)
        if (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()) return malformed()
        expiresAt = new Date(expiry).toISOString()
      }
      return { token, userId: identifier(jsonField(value, config.userIdPath)), tenantId: identifier(jsonField(value, config.tenantIdPath)), expiresAt }
    },
    async request(input: ApiRequest, token: string, signal: AbortSignal) {
      if (!input || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)) return invalid()
      validatePath(input.path)
      const url = new URL(input.path, base)
      if (url.origin !== base.origin || routeIdentity(url) === routeIdentity(new URL(config.loginPath, base)) || !config.allowedApiPrefixes.some(prefix => url.pathname.startsWith(prefix))) return invalid()
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token) || token.length > 8192) return invalid()
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      if (input.idempotencyKey !== undefined) {
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) return invalid()
        headers['Idempotency-Key'] = input.idempotencyKey
      }
      let body: string | undefined
      if (input.body !== undefined) {
        if (input.method === 'GET') return invalid()
        try { body = JSON.stringify(input.body) } catch { return invalid() }
        if (!body || Buffer.byteLength(body) > 1048576) return invalid()
        headers['Content-Type'] = 'application/json'
      }
      return request(input.path, input.method, headers, body, signal)
    },
  }
}
