import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { prepareUserHome } from '../scripts/user-entrypoint.mjs'

const require = createRequire(import.meta.url)
const harness = resolve(dirname(require.resolve('@deepseek-ai/dsh-tools')), '../../../..')
const portal = fileURLToPath(new URL('..', import.meta.url))
const fixtureCleanup = new WeakMap()
const backend = { baseUrl: 'http://127.0.0.1:9', loginPath: '/login', loginResponseMode: 'http-status', accountField: 'email', passwordField: 'password', tokenPath: 'token', userIdPath: 'user.id', tenantIdPath: 'tenant.id', codePath: 'code', successCode: 200, unauthorizedCode: 401, forbiddenCode: 403, allowedApiPrefixes: ['/api/'], maxResponseBytes: 1048576 }

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'portal-profile-'))
  const cleanup = []
  fixtureCleanup.set(t, cleanup)
  t.after(async () => {
    const errors = []
    for (const dispose of cleanup.reverse()) {
      try { await dispose() } catch (error) { errors.push(error) }
    }
    await rm(root, { recursive: true, force: true })
    if (errors.length) throw new AggregateError(errors, 'Profile fixture cleanup failed')
  })
  return root
}

async function launch(t, root, home, args, extra = {}) {
  const child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), ...args], {
    cwd: root, env: { HOME: root, DSH_HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_TELEMETRY_DISABLED: '1', ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const exited = once(child, 'exit')
  fixtureCleanup.get(t).push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timeout) }
  })
  const until = async predicate => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const value = predicate(output)
      if (value) return value
      if (child.exitCode !== null || child.signalCode !== null) break
      await delay(25)
    }
    throw new Error(`Profile readiness failed: ${output.replace(/token=[\w-]+/g, 'token=REDACTED')}`)
  }
  return { until, output: () => output }
}

test('formal dsh user profiles load the portal model and keep two native sessions separate', { timeout: 75000 }, async t => {
  const root = await temp(t)
  const users = []
  for (const name of ['alice', 'bob']) {
    const workspace = join(root, name)
    const home = join(workspace, 'home')
    const control = join(workspace, 'control')
    await mkdir(control, { recursive: true })
    const settings = { 'llm-pi-ai': { providers: { portal: { displayName: 'Fixture', api: 'openai-completions', apiKeyEnv: 'PORTAL_MODEL_KEY', baseURL: 'http://host.docker.internal:23080/portal/model/v1', models: [{ id: 'fixture-model', name: 'Fixture' }] } } }, 'agent-default-model': { provider: 'portal', model: 'fixture-model' }, 'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' } }
    const patch = [{ id: 'webserver', config: { host: '0.0.0.0', port: 3080 } }, { insert: [
      { id: 'portal-user-business', name: 'dsh-web-portal/user-business', config: { credentialFile: '/run/portal/business.json', identityKey: 'a'.repeat(64), backend, timeoutMs: 10000 } },
      { id: 'enterprise-tools', name: 'dsh-enterprise-tools', config: { tokenFile: '/run/portal/business.token', baseUrl: backend.baseUrl, timeoutMs: 10000, maxResponseBytes: 1048576, maxItems: 100 } },
    ] }]
    await writeFile(join(control, 'settings.json'), JSON.stringify(settings))
    await writeFile(join(control, 'model.env'), 'PORTAL_MODEL_KEY=fake_capability_123456789012345678901234567890\n')
    await writeFile(join(control, 'user.patch.json'), JSON.stringify(patch))
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'settings.yaml'), JSON.stringify({ 'agent-default-model': { provider: 'obsolete-provider', model: 'obsolete-model' } }))
    const { modelKey } = await prepareUserHome({ home, control, appRoot: harness })
    const portalLink = join(home, 'profiles/web/node_modules/dsh-web-portal')
    await unlink(portalLink); await symlink(portal, portalLink)
    // The same composition, with an OS-allocated loopback listener for parallel tests.
    patch[0].config = { host: '127.0.0.1', port: 0 }
    await writeFile(join(control, 'user.patch.json'), JSON.stringify(patch))
    const running = await launch(t, workspace, home, ['web', '--patch', join(control, 'user.patch.json'), '--no-open', '--port', '0'], { PORTAL_MODEL_KEY: modelKey })
    const match = await running.until(output => output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/))
    const url = new URL(match[1])
    const login = await fetch(url, { redirect: 'manual' })
    assert.equal(login.status, 303)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const rpc = async (method, value = {}) => {
      const response = await fetch(`${url.origin}/api/${method}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `fixture-${method}`, method, payload: { args: value } }) })
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json()
      assert.equal(body.result.ok, true, JSON.stringify(body))
      return body.result.value
    }
    const catalog = await rpc('session/modelCatalog')
    assert.match(JSON.stringify(catalog), /fixture-model/)
    assert.match(JSON.stringify(catalog), /portal/)
    assert.doesNotMatch(JSON.stringify(catalog), /obsolete-provider|obsolete-model/)
    assert.doesNotMatch(running.output(), /did not activate|failed to load|rejected.*settings/)
    await assert.rejects(readFile(join(home, 'settings.yaml')), { code: 'ENOENT' })
    users.push({ origin: url.origin, cookie, rpc })
  }
  const created = await users[0].rpc('session/create', { request: {} })
  assert.ok(created.sessionId)
  const aliceList = await users[0].rpc('session/list', { _request: {} })
  const bobList = await users[1].rpc('session/list', { _request: {} })
  assert.ok(aliceList.items.some(item => item.sessionId === created.sessionId))
  assert.ok(!bobList.items.some(item => item.sessionId === created.sessionId))
  assert.notEqual(users[0].cookie, users[1].cookie)
  for (const [index, user] of users.entries()) {
    const response = await fetch(user.origin, { headers: { Cookie: users[1 - index].cookie }, redirect: 'manual' })
    assert.equal(response.status, 401)
  }
})

test('formal standalone dsh gateway serves login and uses the enterprise HTTP adapter for rejection', { timeout: 45000 }, async t => {
  const root = await temp(t)
  let attempts = 0
  const fakeBackend = createServer((req, res) => {
    assert.equal(req.url, '/login'); attempts++
    req.resume(); res.writeHead(401); res.end('wrong credentials')
  })
  fakeBackend.listen(0, '127.0.0.1'); await once(fakeBackend, 'listening')
  fixtureCleanup.get(t).push(() => new Promise(resolve => { fakeBackend.closeAllConnections(); fakeBackend.close(resolve) }))
  const home = join(root, '.dsh')
  const profile = join(home, 'profiles/portal')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await symlink(portal, join(profile, 'node_modules/dsh-web-portal'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'fixture-portal', private: true, type: 'module', dependencies: { 'dsh-web-portal': `link:${portal}` }, dsh: { profile: { bundles: ['dsh-web-portal'], patchReload: 'startup' } } }))
  await writeFile(join(root, 'model.key'), 'fake-upstream-model-key', { mode: 0o600 })
  await writeFile(join(root, 'network-policy.json'), JSON.stringify({ version: 1, interfacePrefix: 'dshp', gatewayPort: 23080, denyPrivate: true }))
  const config = { publicOrigin: 'http://localhost', networkPolicyFile: join(root, 'network-policy.json'), backend: { ...backend, baseUrl: `http://127.0.0.1:${fakeBackend.address().port}` }, docker: { dataRoot: root, hostDataRoot: root, image: 'unused-fixture' }, model: { baseUrl: 'http://127.0.0.1:9/v1', apiKeyFile: join(root, 'model.key'), model: 'fixture', runtimeBaseUrl: 'http://host.docker.internal:23080/portal/model/v1' } }
  await writeFile(join(root, 'config.json'), JSON.stringify(config))
  // Test-only observer reports the OS-bound port, without replacing the gateway.
  await writeFile(join(root, 'ready.mjs'), 'export const inject=["webServer"]; export function apply(ctx){ console.log("PORTAL_READY="+ctx.webServer.port) }\n')
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'fixture-ready', name: join(root, 'ready.mjs') }] }]))
  const running = await launch(t, root, home, ['--profile', 'portal'], { PORTAL_PORT: '0', PORTAL_CONFIG_FILE: join(root, 'config.json') })
  const match = await running.until(output => output.match(/PORTAL_READY=(\d+)/))
  const base = `http://127.0.0.1:${match[1]}`
  const request = (path, data) => new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method: data ? 'POST' : 'GET', headers: { Host: 'localhost', Origin: 'http://localhost', 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })))
    })
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data))
  })
  let response
  for (let i = 0; i < 100; i++) {
    response = await request('/login')
    if (response.status === 200) break
    await delay(25)
  }
  assert.equal(response.status, 200)
  assert.match(await response.text(), /NextBOS Agent/)
  const login = await request('/portal/login', { account: 'fixture@example.test', password: 'fake-wrong' })
  assert.equal(login.status, 401)
  assert.equal(login.headers.get('set-cookie'), null)
  assert.equal(attempts, 1)
  assert.doesNotMatch(running.output(), /failed to load|did not activate/)
})
