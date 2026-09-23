import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { request } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LoginIdentity, RuntimeManager, UserRuntime } from './contracts.js'
import { DockerClient, type DockerTransport } from './docker-client.js'
import { identityKey } from './identity.js'

const OWNER_LABEL = 'io.dsh.portal.owner'
const IDENTITY_LABEL = 'io.dsh.portal.identity'

/** Existing sessions must be revoked even while Docker cleanup is still pending. */
export class RuntimeInvalidatedError extends Error {
  readonly code = 'RUNTIME_INVALIDATED'
  constructor() { super('Runtime invalidated; sign in again') }
}

export interface DockerRuntimeConfig {
  hostDataRoot: string
  dataRoot: string
  image: string
  maxInstances: number
  memoryBytes: number
  nanoCpus: number
  pidsLimit: number
  activationTimeoutMs: number
  requestTimeoutMs: number
  socketPath?: string
  containerPrefix?: string
}

export interface RuntimePaths { home: string; workspace: string; control: string }
export interface RuntimeDependencies {
  docker?: DockerTransport
  prepare?: (identity: LoginIdentity, key: string, paths: RuntimePaths, signal: AbortSignal) => Promise<void>
  prepareDirectories?: (paths: RuntimePaths) => Promise<void>
  exchangeToken?: (origin: string, token: string, signal: AbortSignal) => Promise<string>
}

interface OwnedResource {
  Id?: string
  Name?: string
  Names?: string[]
  Labels?: Record<string, string>
  Config?: { Labels?: Record<string, string> }
  State?: { Running?: boolean; StartedAt?: string }
  NetworkSettings?: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> }
}
interface Entry {
  controller: AbortController
  promise: Promise<UserRuntime>
  refresh: Promise<void>
  credential: string
  waiters: number
  active: boolean
  stopping: boolean
  containerVersion: string
  stopPromise: Promise<void> | undefined
}

async function prepareDirectories(paths: RuntimePaths): Promise<void> {
  for (const path of [resolve(paths.home, '..'), paths.home, paths.workspace, paths.control]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await directory.chmod(0o700)
      // The parent stays gateway-owned so the container cannot replace sibling mounts.
      if (path === paths.home || path === paths.workspace || path === paths.control) await directory.chown(1000, 1000)
    } finally { await directory.close() }
  }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Runtime activation cancelled'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Runtime activation cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Exchange the native launch token internally; neither token nor cookie leaves this module. */
export function exchangeNativeToken(origin: string, token: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL('/', origin)
    url.searchParams.set('token', token)
    const req = request(url, { signal, headers: { host: url.host } }, res => {
      res.resume()
      if (res.statusCode !== 303) { reject(new Error('Runtime authentication unavailable')); return }
      const cookie = res.headers['set-cookie']?.map(value => value.split(';')[0]).filter(Boolean).join('; ')
      if (!cookie || /[\r\n]/.test(cookie)) { reject(new Error('Runtime authentication unavailable')); return }
      resolve(cookie)
    })
    req.on('error', () => reject(new Error('Runtime authentication unavailable')))
    req.end()
  })
}

export class DockerRuntimeManager implements RuntimeManager {
  private readonly docker: DockerTransport
  private readonly prefix: string
  private readonly owner: string
  private readonly entries = new Map<string, Entry>()
  private initialized: Promise<void> | undefined
  private closed = false

  constructor(private readonly config: DockerRuntimeConfig, private readonly dependencies: RuntimeDependencies = {}) {
    this.prefix = config.containerPrefix ?? 'dsh-portal'
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,50}$/.test(this.prefix)) throw new Error('Invalid runtime prefix')
    if (![config.hostDataRoot, config.dataRoot].every(path => isAbsolute(path) && !/[\r\n:,]/.test(path))) throw new Error('Invalid runtime data root')
    if (!config.image || /[\r\n]/.test(config.image)) throw new Error('Invalid runtime image')
    for (const value of [config.maxInstances, config.memoryBytes, config.nanoCpus, config.pidsLimit, config.activationTimeoutMs, config.requestTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid runtime resource limit')
    }
    this.owner = createHash('sha256').update(JSON.stringify([this.prefix, resolve(config.hostDataRoot)])).digest('hex')
    this.docker = dependencies.docker ?? new DockerClient(config.socketPath, config.requestTimeoutMs)
  }

  async ensure(identity: LoginIdentity, signal: AbortSignal): Promise<UserRuntime> {
    if (this.closed) throw new Error('Runtime manager closed')
    if (signal.aborted) throw new Error('Runtime activation cancelled')
    const key = identityKey(identity)
    let entry = this.entries.get(key)
    if (entry?.stopping) throw new RuntimeInvalidatedError()
    if (entry?.active) {
      let current: OwnedResource | undefined
      try { current = await this.docker.request<OwnedResource>('GET', `/containers/${this.prefix}-${key}/json`, { signal }) }
      catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw new Error('Runtime health check failed') }
      if (this.entries.get(key) !== entry) return this.ensure(identity, signal)
      if (current && (current.Config?.Labels?.[OWNER_LABEL] !== this.owner || current.Config.Labels[IDENTITY_LABEL] !== key)) throw new RuntimeInvalidatedError()
      if (!current?.State?.Running || JSON.stringify([current.Id, current.State.StartedAt]) !== entry.containerVersion) {
        try {
          await this.stop(key)
          return await this.ensure(identity, signal)
        } catch { throw new RuntimeInvalidatedError() }
      }
    }
    if (!entry) {
      if (this.entries.size >= this.config.maxInstances) throw new Error('Runtime capacity reached')
      entry = { controller: new AbortController(), promise: Promise.resolve({ origin: '', cookie: '' }), refresh: Promise.resolve(), credential: JSON.stringify([identity.token, identity.expiresAt]), waiters: 0, active: false, stopping: false, containerVersion: '', stopPromise: undefined }
      this.entries.set(key, entry)
      entry.promise = this.activate(identity, key, entry)
    }
    const selected = entry
    selected.waiters++
    try {
      const runtime = await waitFor(selected.promise, signal)
      if (selected.stopping || this.closed) throw new RuntimeInvalidatedError()
      // Serialize refreshed login credentials so a re-login cannot reuse an old backend token.
      const refresh = selected.refresh.then(async () => {
        try {
          if (selected.stopping || this.closed) throw new Error('Runtime stopping')
          const credential = JSON.stringify([identity.token, identity.expiresAt])
          if (selected.credential !== credential) {
            const refreshSignal = AbortSignal.any([signal, selected.controller.signal, AbortSignal.timeout(this.config.activationTimeoutMs)])
            refreshSignal.throwIfAborted()
            await waitFor(this.dependencies.prepare?.(identity, key, this.paths(key), refreshSignal) ?? Promise.resolve(), refreshSignal)
            refreshSignal.throwIfAborted()
            selected.credential = credential
          }
        } catch {
          // Preparation may already have replaced some credentials. Revoke the
          // runtime immediately; stop waits for this refresh outside its callback.
          if (this.entries.get(key) === selected) void this.stop(key).catch(() => {})
          throw new RuntimeInvalidatedError()
        }
      })
      selected.refresh = refresh.catch(() => {})
      try { await waitFor(refresh, signal) }
      catch (error) {
        if (selected.stopping) throw new RuntimeInvalidatedError()
        if (signal.aborted && selected.credential !== JSON.stringify([identity.token, identity.expiresAt])) {
          if (this.entries.get(key) === selected) void this.stop(key).catch(() => {})
          throw new RuntimeInvalidatedError()
        }
        throw error
      }
      if (selected.stopping || this.closed) throw new RuntimeInvalidatedError()
      return runtime
    } finally {
      selected.waiters--
      if (!selected.active && selected.waiters === 0) selected.controller.abort()
    }
  }

  async stop(key: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid runtime identity')
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.stopPromise) return entry.stopPromise
    entry.stopping = true
    entry.controller.abort()
    entry.stopPromise = (async () => {
      await entry.promise.catch(() => {})
      await entry.refresh
      await this.cleanup(key)
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })().catch(error => {
      entry.stopPromise = undefined
      throw error
    })
    return entry.stopPromise
  }

  async close(): Promise<void> {
    this.closed = true
    const results = await Promise.allSettled([...this.entries.keys()].map(key => this.stop(key)))
    await this.initialized?.catch(() => {})
    if (results.some(result => result.status === 'rejected')) throw new Error('Runtime cleanup failed')
  }

  private paths(key: string): RuntimePaths {
    return { home: join(this.config.dataRoot, 'users', key, 'home'), workspace: join(this.config.dataRoot, 'users', key, 'workspace'), control: join(this.config.dataRoot, 'users', key, 'control') }
  }

  private labels(key: string): Record<string, string> { return { [OWNER_LABEL]: this.owner, [IDENTITY_LABEL]: key } }

  private async remove(kind: 'containers' | 'networks', name: string, key: string): Promise<void> {
    let resource: OwnedResource
    try { resource = await this.docker.request('GET', `/${kind}/${name}${kind === 'containers' ? '/json' : ''}`) }
    catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return; throw error }
    const labels = kind === 'containers' ? resource.Config?.Labels : resource.Labels
    if (labels?.[OWNER_LABEL] !== this.owner || labels[IDENTITY_LABEL] !== key) throw new Error('Runtime ownership conflict')
    try { await this.docker.request('DELETE', `/${kind}/${name}${kind === 'containers' ? '?force=true' : ''}`) }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error }
  }

  private async cleanup(key: string): Promise<void> {
    await this.remove('containers', `${this.prefix}-${key}`, key)
    await this.remove('networks', `${this.prefix}-${key}-net`, key)
  }

  private async recover(): Promise<void> {
    // A gateway restart invalidates all native trusted-token state. Recreate only labelled resources.
    const filter = encodeURIComponent(JSON.stringify({ label: [`${OWNER_LABEL}=${this.owner}`] }))
    for (const kind of ['containers', 'networks'] as const) {
      const resources = await this.docker.request<OwnedResource[]>('GET', kind === 'containers' ? `/containers/json?all=true&filters=${filter}` : `/networks?filters=${filter}`)
      for (const resource of resources) {
        const key = resource.Labels?.[IDENTITY_LABEL]
        if (resource.Labels?.[OWNER_LABEL] !== this.owner || !key || !/^[a-f0-9]{64}$/.test(key)) continue
        const name = `${this.prefix}-${key}${kind === 'networks' ? '-net' : ''}`
        if (resource.Name !== name && !resource.Names?.includes(`/${name}`)) continue
        await this.remove(kind, name, key)
      }
    }
  }

  private async activate(identity: LoginIdentity, key: string, entry: Entry): Promise<UserRuntime> {
    const timer = setTimeout(() => entry.controller.abort(), this.config.activationTimeoutMs)
    const signal = entry.controller.signal
    const name = `${this.prefix}-${key}`
    const network = `${name}-net`
    try {
      this.initialized ??= this.recover().catch(() => { this.initialized = undefined; throw new Error('Runtime recovery failed') })
      await waitFor(this.initialized, signal)
      await this.cleanup(key)
      signal.throwIfAborted()
      await waitFor((this.dependencies.prepareDirectories ?? prepareDirectories)(this.paths(key)), signal)
      await waitFor(this.dependencies.prepare?.(identity, key, this.paths(key), signal) ?? Promise.resolve(), signal)
      signal.throwIfAborted()
      await this.docker.request('POST', '/networks/create', { signal, body: { Name: network, Driver: 'bridge', CheckDuplicate: true, EnableIPv6: false, Labels: this.labels(key), Options: { 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.name': `dshp${key.slice(0, 10)}` } } })
      await this.docker.request('POST', `/containers/create?name=${name}`, { signal, body: {
        Image: this.config.image, User: '1000:1000', WorkingDir: '/workspace', Env: ['HOME=/home/node'], Labels: this.labels(key), ExposedPorts: { '3080/tcp': {} },
        HostConfig: {
          Binds: [`${join(this.config.hostDataRoot, 'users', key, 'home')}:/home/node/.dsh:rw`, `${join(this.config.hostDataRoot, 'users', key, 'workspace')}:/workspace:rw`, `${join(this.config.hostDataRoot, 'users', key, 'control')}:/run/portal:ro`],
          NetworkMode: network, Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], ExtraHosts: ['host.docker.internal:host-gateway'],
          Memory: this.config.memoryBytes, MemorySwap: this.config.memoryBytes, NanoCpus: this.config.nanoCpus, PidsLimit: this.config.pidsLimit,
          PortBindings: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] }, RestartPolicy: { Name: 'no' },
          LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=1777' },
        },
      } })
      await this.docker.request('POST', `/containers/${name}/start`, { signal })
      while (!signal.aborted) {
        const inspect = await this.docker.request<OwnedResource>('GET', `/containers/${name}/json`, { signal })
        if (!inspect.State?.Running) throw new Error('Runtime stopped during activation')
        const binding = inspect.NetworkSettings?.Ports?.['3080/tcp']?.[0]
        if (binding?.HostIp !== '127.0.0.1' || !/^\d{1,5}$/.test(binding.HostPort) || Number(binding.HostPort) < 1 || Number(binding.HostPort) > 65535) throw new Error('Runtime port invalid')
        const origin = `http://127.0.0.1:${binding.HostPort}`
        const logs = await this.docker.request<Buffer>('GET', `/containers/${name}/logs?stdout=true&stderr=true&tail=100`, { signal, raw: true })
        // The token is generated by the trusted native webserver; do not retain or log its launch URL.
        const token = logs.toString('utf8').match(/https?:\/\/[^\s\x00-\x20]+[?&]token=([a-zA-Z0-9_-]{8,512})(?=[&#\s\x00-\x20]|$)/)?.[1]
        if (token) {
          const cookie = await (this.dependencies.exchangeToken ?? exchangeNativeToken)(origin, token, signal)
          signal.throwIfAborted()
          entry.containerVersion = JSON.stringify([inspect.Id, inspect.State.StartedAt])
          entry.active = true
          return { origin, cookie }
        }
        await delay(50, undefined, { signal })
      }
      throw new Error('Runtime activation timed out')
    } catch (error) {
      if ((error as Error).message === 'Runtime ownership conflict') {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        throw new Error('Runtime ownership conflict')
      }
      let cleanupFailed = false
      try { await this.cleanup(key) } catch { cleanupFailed = true }
      if (!cleanupFailed && this.entries.get(key) === entry) this.entries.delete(key)
      throw new Error(signal.aborted ? 'Runtime activation cancelled or timed out' : cleanupFailed ? 'Runtime activation and cleanup failed' : 'Runtime activation failed')
    } finally {
      clearTimeout(timer)
    }
  }
}
