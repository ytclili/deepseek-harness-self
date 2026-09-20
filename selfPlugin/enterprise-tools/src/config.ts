import { isAbsolute } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  baseUrl: string
  tokenFile: string
  timeoutMs: number
  maxResponseBytes: number
  maxItems: number
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default('http://127.0.0.1:5002'),
  tokenFile: Schema.string().required(),
  timeoutMs: Schema.number().default(10000),
  maxResponseBytes: Schema.number().default(1048576),
  maxItems: Schema.number().default(100),
})

export function validateConfig(config: Config): void {
  let base: URL
  try {
    base = new URL(config.baseUrl)
  } catch {
    throw new Error('企业工具配置错误：baseUrl 必须是 HTTP(S) 服务地址。')
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('企业工具配置错误：仅本机允许 HTTP；远端须用 HTTPS，地址不得包含账号、路径或查询参数。')
  }
  if (!isAbsolute(config.tokenFile)) throw new Error('企业工具配置错误：tokenFile 必须是绝对路径。')
  for (const [key, minimum, maximum] of [['timeoutMs', 1, 60000], ['maxResponseBytes', 1, 1048576], ['maxItems', 1, 100]] as const) {
    if (!Number.isInteger(config[key]) || config[key] < minimum || config[key] > maximum) {
      throw new Error(`企业工具配置错误：${key} 必须是 ${minimum} 到 ${maximum} 之间的整数。`)
    }
  }
}
