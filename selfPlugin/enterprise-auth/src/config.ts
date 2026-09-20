import Schema from '@deepseek-ai/schemastery'
import type { HttpConfig } from './http.js'

export interface Config {
  dataDirectory?: string
  backend?: HttpConfig | null
  timeoutMs: number
  maxLoginAttempts: number
  loginWindowMs: number
  ingressTtlMs: number
  maxPendingIngress: number
}

export const Config: Schema<Config> = Schema.object({
  dataDirectory: Schema.string(),
  backend: Schema.union([Schema.object({
    baseUrl: Schema.string().required(),
    loginPath: Schema.string().required(),
    loginResponseMode: Schema.union(['business-code', 'http-status']).default('business-code'),
    accountField: Schema.string().required(),
    passwordField: Schema.string().required(),
    tokenPath: Schema.string().required(),
    userIdPath: Schema.string().required(),
    tenantIdPath: Schema.string().required(),
    expiresAtPath: Schema.string(),
    codePath: Schema.string().required(),
    successCode: Schema.number().required(),
    unauthorizedCode: Schema.number().required(),
    forbiddenCode: Schema.number().required(),
    allowedApiPrefixes: Schema.array(Schema.string()).required(),
    maxResponseBytes: Schema.number().default(1048576),
  }), Schema.const(null)]).default(null),
  timeoutMs: Schema.number().default(10000),
  maxLoginAttempts: Schema.number().default(5),
  loginWindowMs: Schema.number().default(60000),
  ingressTtlMs: Schema.number().default(1800000),
  maxPendingIngress: Schema.number().default(1000),
})

export function validateRuntimeConfig(config: Config): void {
  for (const [key, minimum, maximum] of [
    ['timeoutMs', 1, 60000], ['maxLoginAttempts', 1, 20], ['loginWindowMs', 1000, 3600000],
    ['ingressTtlMs', 1000, 3600000], ['maxPendingIngress', 1, 10000],
  ] as const) {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`企业身份插件配置错误：${key} 超出有效范围。`)
  }
}
