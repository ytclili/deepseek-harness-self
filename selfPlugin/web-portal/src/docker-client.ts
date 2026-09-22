import { request } from 'node:http'

export interface DockerRequestOptions {
  body?: unknown
  signal?: AbortSignal
  raw?: boolean
}

export interface DockerTransport {
  request<T = unknown>(method: string, path: string, options?: DockerRequestOptions): Promise<T>
}

export class DockerError extends Error {
  constructor(readonly statusCode: number) {
    super(`Docker request failed (${statusCode})`)
  }
}

/** Bounded Docker Engine requests; daemon response bodies never enter error messages. */
export class DockerClient implements DockerTransport {
  constructor(private readonly socketPath = '/var/run/docker.sock', private readonly timeoutMs = 10_000, private readonly maxBodyBytes = 1024 * 1024) {}

  request<T = unknown>(method: string, path: string, options: DockerRequestOptions = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
      if (body && body.length > this.maxBodyBytes) { reject(new Error('Docker request too large')); return }
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
      const req = request({ socketPath: this.socketPath, method, path: `/v1.45${path}`, signal, headers: body ? { 'content-type': 'application/json', 'content-length': body.length } : {} }, res => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > this.maxBodyBytes) { req.destroy(); reject(new Error('Docker response too large')); return }
          chunks.push(chunk)
        })
        res.on('error', () => reject(new Error('Docker response interrupted')))
        res.on('end', () => {
          const status = res.statusCode ?? 500
          if (status < 200 || status >= 300) { reject(new DockerError(status)); return }
          const data = Buffer.concat(chunks)
          if (options.raw) { resolve(data as T); return }
          try { resolve((data.length ? JSON.parse(data.toString('utf8')) : undefined) as T) }
          catch { reject(new Error('Docker response invalid')) }
        })
      })
      req.on('error', () => reject(new Error(signal.aborted ? 'Docker request cancelled or timed out' : 'Docker request unavailable')))
      req.end(body)
    })
  }
}
