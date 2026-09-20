import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { Config } from './config.js'

export class EnterpriseApiError extends Error {}

async function readToken(path: string, signal: AbortSignal): Promise<string> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      signal.throwIfAborted()
      const stat = await handle.stat()
      signal.throwIfAborted()
      if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0) throw new Error('invalid credential file')
      const buffer = Buffer.alloc(8193)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      signal.throwIfAborted()
      const token = buffer.subarray(0, bytesRead).toString('utf8').trim()
      if (bytesRead > 8192 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new Error('invalid bearer token')
      return token
    } finally {
      await handle.close()
    }
  } catch {
    throw new EnterpriseApiError('企业工具凭证不可用：请检查 tokenFile、文件权限（600）和 Token 内容。')
  }
}

async function cancellable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel)
      reject(new EnterpriseApiError('商品查询已取消。'))
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    task.then(value => {
      signal.removeEventListener('abort', cancel)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', cancel)
      reject(error)
    })
  })
}

export function statusError(status: number): EnterpriseApiError {
  if (status === 401) return new EnterpriseApiError('商品接口认证失败（401），请更新业务 Token。')
  if (status === 403) return new EnterpriseApiError('商品接口拒绝访问（403），当前账号没有查询权限。')
  if (status === 429) return new EnterpriseApiError('商品接口请求过于频繁（429），请稍后重试。')
  return new EnterpriseApiError(`商品接口请求失败（状态码 ${status}），请联系管理员检查服务。`)
}

export async function requestGoods(config: Config, callerSignal: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const signal = AbortSignal.any([callerSignal, timeout])
  try {
    signal.throwIfAborted()
    const token = await cancellable(readToken(config.tokenFile, signal), signal)
    signal.throwIfAborted()
    const response = await fetch(new URL('/api/v1/shop/goods', config.baseUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual',
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw statusError(response.status)
    }
    if (Number(response.headers.get('content-length')) > config.maxResponseBytes) {
      await response.body?.cancel()
      throw new EnterpriseApiError('商品接口响应过大，请联系管理员缩小查询范围。')
    }
    if (!response.body) throw new EnterpriseApiError('商品接口返回格式错误：响应为空。')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > config.maxResponseBytes) {
          await reader.cancel()
          throw new EnterpriseApiError('商品接口响应过大，请联系管理员缩小查询范围。')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    signal.throwIfAborted()
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new EnterpriseApiError('商品接口返回格式错误：不是有效 JSON。')
    }
  } catch (error) {
    if (callerSignal.aborted) throw new EnterpriseApiError('商品查询已取消。')
    if (timeout.aborted) throw new EnterpriseApiError('商品查询超时，请稍后重试。')
    if (error instanceof EnterpriseApiError) throw error
    throw new EnterpriseApiError('无法连接商品服务，请检查服务状态和网络配置。')
  }
}
