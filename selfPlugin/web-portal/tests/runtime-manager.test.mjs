import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DockerRuntimeManager, exchangeNativeToken } from '../dist/runtime-manager.js'
import { DockerClient } from '../dist/docker-client.js'

const identity = (userId = 'a', token = 'fake-business-secret') => ({ tenantId: 'tenant', userId, token, expiresAt: null })
const key = id => createHash('sha256').update(JSON.stringify([id.tenantId, id.userId])).digest('hex')
const config = { hostDataRoot: '/mnt/sata4-2/portal', dataRoot: '/gateway/data', image: 'test-image', maxInstances: 2, memoryBytes: 512 * 1024 ** 2, nanoCpus: 1e9, pidsLimit: 64, activationTimeoutMs: 200, containerPrefix: 'portal-test' }

class FakeDocker {
  calls = []
  containers = new Map()
  networks = new Map()
  logs = 'Open http://127.0.0.1:3080/?token=fake-native-secret'
  async request(method, path, options = {}) {
    this.calls.push({ method, path, ...options })
    const [pathname] = path.split('?')
    if (pathname === '/containers/json') return [...this.containers].map(([name, value]) => ({ ...value, Names: [`/${name}`], Labels: value.Config.Labels }))
    if (pathname === '/networks') return [...this.networks.values()]
    if (pathname === '/networks/create') { this.networks.set(options.body.Name, { Id: options.body.Name, ...options.body }); return { Id: options.body.Name } }
    if (pathname === '/containers/create') {
      const name = new URL(`http://docker${path}`).searchParams.get('name')
      this.containers.set(name, { Id: name, Config: options.body, State: { Running: true }, NetworkSettings: { Ports: { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(40000 + this.containers.size) }] } } })
      return { Id: name }
    }
    const [, kind, name, action] = pathname.split('/')
    const objects = kind === 'containers' ? this.containers : this.networks
    if (!objects.has(name)) throw Object.assign(new Error('Docker request failed (404)'), { statusCode: 404 })
    if (method === 'DELETE') { objects.delete(name); return undefined }
    if (action === 'logs') return Buffer.from(this.logs)
    if (action === 'start') return undefined
    return objects.get(name)
  }
}

function fixture(overrides = {}, dependencies = {}) {
  const docker = new FakeDocker()
  const prepared = []
  const manager = new DockerRuntimeManager({ ...config, ...overrides }, { docker, prepareDirectories: async () => {}, prepare: async (id, hash, paths) => { prepared.push({ id, hash, paths }) }, exchangeToken: async (origin, token) => { assert.equal(token, 'fake-native-secret'); return `native=${origin.slice(-5)}` }, ...dependencies })
  return { manager, docker, prepared }
}
const signal = () => new AbortController().signal

test('same business token with renewed expiry refreshes the private credential file', async t => {
  const { manager, prepared } = fixture()
  t.after(() => manager.close())
  const first = { ...identity(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
  await manager.ensure(first, signal())
  const second = { ...first, expiresAt: new Date(Date.now() + 120_000).toISOString() }
  await manager.ensure(second, signal())
  assert.equal(prepared.length, 2)
  assert.equal(prepared[1].id.expiresAt, second.expiresAt)
})

test('failed refresh destroys the old runtime and queued callers cannot reuse its credentials', async t => {
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const { manager, docker } = fixture({}, { prepare: async id => {
    if (id.token === 'rotated') { entered(); await gate; throw new Error('refresh-secret-canary') }
  } })
  t.after(() => manager.close())
  await manager.ensure(identity(), signal())
  const changed = manager.ensure(identity('a', 'rotated'), signal())
  await started
  const queued = manager.ensure(identity(), signal())
  await new Promise(resolve => setImmediate(resolve))
  release()
  const outcomes = await Promise.allSettled([changed, queued])
  assert(outcomes.every(outcome => outcome.status === 'rejected'))
  assert(outcomes.every(outcome => outcome.reason.code === 'RUNTIME_INVALIDATED'))
  assert(!JSON.stringify(outcomes.map(outcome => outcome.reason?.message)).includes('refresh-secret-canary'))
  await manager.stop(key(identity()))
  assert.equal(docker.containers.size, 0)
  assert.equal(docker.networks.size, 0)
  await manager.ensure(identity('a', 'fresh'), signal())
  assert.equal(docker.calls.filter(call => call.path.startsWith('/containers/create')).length, 2)
})

test('stop during credential preparation cannot return an already removed runtime', async t => {
  let entered
  let release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const { manager, docker } = fixture({}, { prepare: async id => {
    if (id.token === 'rotated') { entered(); await gate }
  } })
  t.after(() => manager.close())
  await manager.ensure(identity(), signal())
  const changed = manager.ensure(identity('a', 'rotated'), signal())
  await started
  const queued = manager.ensure(identity(), signal())
  await new Promise(resolve => setImmediate(resolve))
  const stopped = manager.stop(key(identity()))
  release()
  const outcomes = await Promise.allSettled([changed, queued])
  await stopped
  assert(outcomes.every(outcome => outcome.status === 'rejected'))
  assert.equal(docker.containers.size, 0)
})

test('cleanup can retry after a transient Docker delete failure without releasing capacity early', async t => {
  const { manager, docker } = fixture({ maxInstances: 1 })
  t.after(() => manager.close())
  await manager.ensure(identity(), signal())
  const request = docker.request.bind(docker)
  let fail = true
  docker.request = async (method, path, options) => {
    if (method === 'DELETE' && path.startsWith('/containers/') && fail) {
      fail = false
      throw new Error('fixture delete failed')
    }
    return request(method, path, options)
  }
  await assert.rejects(manager.stop(key(identity())), /failed/)
  await assert.rejects(manager.ensure(identity('b'), signal()), /capacity/)
  await manager.stop(key(identity()))
  assert.equal(docker.containers.size, 0)
  assert.equal(docker.networks.size, 0)
  await manager.ensure(identity('b'), signal())
})

test('oversized or malformed logged tokens are never truncated and exchanged', async t => {
  for (const token of ['a'.repeat(513), 'validtoken%bad', 'validtoken!bad']) {
    let exchanges = 0
    const { manager, docker } = fixture({ activationTimeoutMs: 30 }, { exchangeToken: async () => { exchanges++; return 'native=fake' } })
    t.after(() => manager.close())
    docker.logs = `http://127.0.0.1:3080/?token=${token}`
    await assert.rejects(manager.ensure(identity(), signal()), /activation|timeout/i)
    assert.equal(exchanges, 0)
    assert.equal(docker.containers.size, 0)
    assert.equal(docker.networks.size, 0)
  }
})

test('refresh invalidation is reported before delayed Docker cleanup finishes', async t => {
  const { manager, docker } = fixture({}, { prepare: async id => {
    if (id.token === 'rotated') throw new Error('fixture refresh failure')
  } })
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(async () => { release(); await manager.close() })
  await manager.ensure(identity(), signal())
  const request = docker.request.bind(docker)
  docker.request = async (method, path, options) => {
    if (method === 'DELETE' && path.startsWith('/containers/')) await gate
    return request(method, path, options)
  }
  const outcome = await Promise.race([
    manager.ensure(identity('a', 'rotated'), signal()).then(() => 'success', error => error.code),
    new Promise(resolve => setTimeout(() => resolve('cleanup-blocked'), 30)),
  ])
  assert.equal(outcome, 'RUNTIME_INVALIDATED')
})

test('failed recreation of a previously running container invalidates existing sessions', async t => {
  const { manager, docker } = fixture()
  t.after(() => manager.close())
  await manager.ensure(identity(), signal())
  docker.containers.get(`${config.containerPrefix}-${key(identity())}`).State.Running = false
  const request = docker.request.bind(docker)
  docker.request = async (method, path, options) => {
    if (path.startsWith('/containers/create')) throw new Error('fixture create failure')
    return request(method, path, options)
  }
  await assert.rejects(manager.ensure(identity(), signal()), { code: 'RUNTIME_INVALIDATED' })
})

test('two users have distinct private mounts and networks with restricted Docker configuration', async () => {
  const { manager, docker, prepared } = fixture()
  const [a, b] = await Promise.all([manager.ensure(identity('a'), signal()), manager.ensure(identity('b'), signal())])
  assert.notEqual(a.origin, b.origin)
  const creates = docker.calls.filter(c => c.path.startsWith('/containers/create'))
  assert.equal(creates.length, 2)
  for (const { body } of creates) {
    assert.equal(body.User, '1000:1000')
    assert.equal(body.HostConfig.ReadonlyRootfs, true)
    assert.equal(body.HostConfig.Privileged, false)
    assert.deepEqual(body.HostConfig.CapDrop, ['ALL'])
    assert.deepEqual(body.HostConfig.SecurityOpt, ['no-new-privileges:true'])
    assert.deepEqual(body.HostConfig.ExtraHosts, ['host.docker.internal:host-gateway'])
    assert.equal(body.HostConfig.Memory, config.memoryBytes)
    assert.equal(body.HostConfig.NanoCpus, config.nanoCpus)
    assert.equal(body.HostConfig.PidsLimit, config.pidsLimit)
    assert.equal(body.HostConfig.Binds.length, 3)
    assert(body.HostConfig.Binds.some(m => m.endsWith('/control:/run/portal:ro')))
    assert(!JSON.stringify(body).includes('fake-business-secret'))
    assert(body.HostConfig.Binds.every(m => m.startsWith(config.hostDataRoot) && !m.includes('docker.sock')))
    assert.deepEqual(body.HostConfig.PortBindings, { '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] })
  }
  assert.notEqual(creates[0].body.HostConfig.NetworkMode, creates[1].body.HostConfig.NetworkMode)
  assert.notDeepEqual(creates[0].body.HostConfig.Binds, creates[1].body.HostConfig.Binds)
  assert(docker.calls.filter(c => c.path === '/networks/create').every(c => c.body.Options['com.docker.network.bridge.enable_icc'] === 'false'))
  for (const create of docker.calls.filter(c => c.path === '/networks/create')) {
    assert.match(create.body.Options['com.docker.network.bridge.name'], /^dshp[a-f0-9]{10}$/)
    assert.equal(create.body.EnableIPv6, false)
  }
  assert.equal(prepared[0].paths.home, `${config.dataRoot}/users/${prepared[0].hash}/home`)
  assert.equal(prepared[0].paths.control, `${config.dataRoot}/users/${prepared[0].hash}/control`)
  await manager.close()
  assert.equal(docker.containers.size, 0)
  assert.equal(docker.networks.size, 0)
})

test('same user singleflight, credentials refreshed on subsequent login, capacity reserved before awaits', async () => {
  const { manager, docker, prepared } = fixture({ maxInstances: 1 })
  const first = manager.ensure(identity(), signal())
  const second = manager.ensure(identity(), signal())
  await assert.rejects(manager.ensure(identity('b'), signal()), /capacity/i)
  assert.deepEqual(await first, await second)
  await manager.ensure(identity('a', 'rotated-fake-secret'), signal())
  assert.equal(docker.calls.filter(c => c.path.startsWith('/containers/create')).length, 1)
  assert.equal(prepared.at(-1).id.token, 'rotated-fake-secret')
  await manager.stop(key(identity()))
  await manager.ensure(identity('b'), signal())
  await manager.close()
})

test('startup timeout cleans resources and allows retry without deleting persistent data', async () => {
  const { manager, docker } = fixture({ activationTimeoutMs: 30 })
  docker.logs = ''
  await assert.rejects(manager.ensure(identity(), signal()), /activation|timeout/i)
  assert.equal(docker.containers.size, 0)
  assert.equal(docker.networks.size, 0)
  docker.logs = 'http://127.0.0.1:3080/?token=fake-native-secret'
  await manager.ensure(identity(), signal())
  await manager.close()
})

test('cancellation cleans an activation and close prevents future activation', async () => {
  const { manager, docker } = fixture()
  docker.logs = ''
  const controller = new AbortController()
  const activating = manager.ensure(identity(), controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(activating, /cancel|abort/i)
  await manager.close()
  assert.equal(docker.containers.size, 0)
  assert.equal(docker.networks.size, 0)
  await assert.rejects(manager.ensure(identity(), signal()), /closed/i)
})

test('same-name foreign Docker resources are never removed', async () => {
  const { manager, docker } = fixture()
  const name = `${config.containerPrefix}-${key(identity())}`
  docker.containers.set(name, { Config: { Labels: { unrelated: 'owner' } } })
  await assert.rejects(manager.ensure(identity(), signal()), /ownership/i)
  assert(docker.containers.has(name))
  assert.equal(docker.calls.filter(c => c.method === 'DELETE').length, 0)
  await manager.close()
})

test('one cancelled waiter does not cancel another login for the same user', async () => {
  const { manager, docker } = fixture()
  docker.logs = ''
  const controller = new AbortController()
  const first = manager.ensure(identity(), controller.signal)
  const second = manager.ensure(identity(), signal())
  controller.abort()
  await assert.rejects(first, /cancel/i)
  docker.logs = 'http://127.0.0.1:3080/?token=fake-native-secret'
  await second
  await manager.close()
})

test('prepare timeout is bounded and returned errors do not expose preparation secrets', { timeout: 1000 }, async () => {
  const { manager } = fixture({ activationTimeoutMs: 30 }, { prepare: async () => { throw new Error('fake-secret-must-not-leak') } })
  await assert.rejects(manager.ensure(identity(), signal()), error => !error.message.includes('fake-secret-must-not-leak'))
  await manager.close()
  const pending = fixture({ activationTimeoutMs: 30 }, { prepare: () => new Promise(() => {}) })
  await assert.rejects(pending.manager.ensure(identity(), signal()), /cancel|timeout|timed out/i)
  await pending.manager.close()
})

test('Docker client uses API 1.45, bounds bodies and deadlines, and redacts daemon error bodies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'portal-docker-'))
  const socketPath = join(directory, 'docker.sock')
  const server = createServer((req, res) => {
    if (req.url === '/v1.45/error') { res.writeHead(500); res.end('fake-daemon-secret') }
    else if (req.url === '/v1.45/large') res.end('x'.repeat(300))
    else if (req.url === '/v1.45/stall') { /* Deadline must close this request. */ }
    else res.end(JSON.stringify({ api: req.url }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  const docker = new DockerClient(socketPath, 30, 128)
  assert.deepEqual(await docker.request('GET', '/ping'), { api: '/v1.45/ping' })
  await assert.rejects(docker.request('GET', '/error'), error => error.statusCode === 500 && !error.message.includes('fake-daemon-secret'))
  await assert.rejects(docker.request('GET', '/large'), /too large/)
  await assert.rejects(docker.request('POST', '/ping', { body: 'x'.repeat(200) }), /too large/)
  await assert.rejects(docker.request('GET', '/stall'), /timed out/)
})

test('gateway recovery deletes only objects with both its names and ownership labels', async () => {
  const { manager, docker } = fixture()
  await manager.ensure(identity(), signal())
  const own = [...docker.containers.values()][0]
  docker.containers.set('foreign-container', { ...own, Config: { Labels: { unrelated: 'owner' } } })
  docker.networks.set('foreign-network', { Name: 'foreign-network', Labels: { unrelated: 'owner' } })
  const restarted = new DockerRuntimeManager(config, { docker, prepareDirectories: async () => {}, exchangeToken: async () => 'native=fake' })
  await restarted.ensure(identity('b'), signal())
  assert(!docker.containers.has(`${config.containerPrefix}-${key(identity())}`))
  assert(docker.containers.has('foreign-container'))
  assert(docker.networks.has('foreign-network'))
  await restarted.close()
})

test('refresh is serialized and does not return before new credentials are prepared', async () => {
  let finish
  let calls = 0
  const { manager } = fixture({}, { prepare: async () => { calls++; if (calls === 2) await new Promise(resolve => { finish = resolve }) } })
  await manager.ensure(identity(), signal())
  let completed = false
  const changed = manager.ensure(identity('a', 'rotated'), signal()).then(() => { completed = true })
  const again = manager.ensure(identity('a', 'rotated'), signal())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  finish()
  await Promise.all([changed, again])
  assert.equal(calls, 2)
  await manager.close()
})

test('native bootstrap sends exact loopback host and token, consumes 303 cookie internally', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.host, `127.0.0.1:${server.address().port}`)
    assert.equal(req.url, '/?token=fake-native-token')
    res.writeHead(303, { 'set-cookie': 'dsh-token=fake-native-cookie; HttpOnly; Path=/', location: '/' })
    res.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  assert.equal(await exchangeNativeToken(`http://127.0.0.1:${server.address().port}`, 'fake-native-token', AbortSignal.timeout(1000)), 'dsh-token=fake-native-cookie')
})

test('a stopped or externally restarted container is recreated before returning a native session', async () => {
  const { manager, docker } = fixture()
  await Promise.all(Array.from({ length: 5 }, () => manager.ensure(identity(), signal())))
  const name = `${config.containerPrefix}-${key(identity())}`
  docker.containers.get(name).State.StartedAt = 'later-restart'
  const request = docker.request.bind(docker)
  let deletions = 0
  docker.request = async (method, path, options) => {
    if (method === 'DELETE' && path.startsWith('/containers/') && ++deletions > 1) await new Promise(resolve => setTimeout(resolve, 20))
    return request(method, path, options)
  }
  await Promise.all(Array.from({ length: 5 }, () => manager.ensure(identity(), signal())))
  assert.equal(docker.calls.filter(c => c.path.startsWith('/containers/create')).length, 2)
  docker.containers.get(name).State.Running = false
  await manager.ensure(identity(), signal())
  assert.equal(docker.calls.filter(c => c.path.startsWith('/containers/create')).length, 3)
  await manager.close()
})
