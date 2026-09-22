import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, readlink, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareUserHome, runUserEntrypoint, parseModelEnvironment } from '../scripts/user-entrypoint.mjs'

const capability = 'fake_model_capability_1234567890123456789012'
const settings = { 'llm-pi-ai': { providers: { portal: { displayName: 'NextBOS AI', api: 'openai-completions', apiKeyEnv: 'PORTAL_MODEL_KEY', baseURL: 'http://host.docker.internal:18091/v1', models: [{ id: 'test-model', name: 'test-model' }] } } }, 'agent-default-model': { provider: 'portal', model: 'test-model' }, 'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' } }
const patch = [{ id: 'webserver', config: { host: '0.0.0.0', port: 3080 } }, { insert: [{ id: 'portal-user-business', name: 'dsh-web-portal/user-business', config: { credentialFile: '/run/portal/business.json', identityKey: 'a'.repeat(64), backend: {}, timeoutMs: 10000 } }, { id: 'enterprise-tools', name: 'dsh-enterprise-tools', config: { tokenFile: '/run/portal/business.token', baseUrl: 'http://example.test', timeoutMs: 10000, maxResponseBytes: 1048576, maxItems: 100 } }] }]

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'portal-entrypoint-'))
  const config = { home: join(root, 'home'), control: join(root, 'control'), appRoot: join(root, 'app') }
  await Promise.all([mkdir(config.home), mkdir(config.control)])
  await Promise.all([writeFile(join(config.control, 'model.env'), `PORTAL_MODEL_KEY=${capability}\n`), writeFile(join(config.control, 'settings.json'), JSON.stringify(settings)), writeFile(join(config.control, 'user.patch.json'), JSON.stringify(patch)), writeFile(join(config.home, '.credentials.yaml'), 'native-credentials-must-survive')])
  t.after(() => rm(root, { recursive: true, force: true }))
  return config
}

test('model environment accepts exactly one bounded base64url capability without shell evaluation', () => {
  assert.equal(parseModelEnvironment(`PORTAL_MODEL_KEY=${capability}\n`), capability)
  for (const value of ['PORTAL_MODEL_KEY=short', `PORTAL_MODEL_KEY=${capability}\nADMIN_SECRET=leak`, `PORTAL_MODEL_KEY=$(touch /tmp/no)`, `PORTAL_MODEL_KEY="${capability}"`, `OTHER=${capability}`]) assert.throws(() => parseModelEnvironment(value), /Invalid/)
})

test('entrypoint creates only the approved profile and local links, preserving native credentials', async t => {
  const config = await fixture(t)
  const result = await prepareUserHome(config)
  assert.equal(result.modelKey, capability)
  assert.deepEqual(JSON.parse(await readFile(join(config.home, 'settings.yaml'), 'utf8')), settings)
  const profile = join(config.home, 'profiles/web')
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.equal(manifest.dsh.profile.patchReload, 'startup')
  assert.equal(manifest.dependencies['dsh-web-portal'], `link:${config.appRoot}/selfPlugin/web-portal`)
  assert.equal(await readlink(join(profile, 'node_modules/dsh-web-portal')), `${config.appRoot}/selfPlugin/web-portal`)
  assert.equal(await readlink(join(profile, 'node_modules/dsh-enterprise-tools')), `${config.appRoot}/selfPlugin/enterprise-tools`)
  assert.equal(await readFile(join(config.home, '.credentials.yaml'), 'utf8'), 'native-credentials-must-survive')
  assert.equal(await readFile(join(config.home, 'cordis.patch.yml'), 'utf8'), '[]\n')
})

test('entrypoint rejects extra providers, arbitrary plugins, unexpected paths, and symlinked profile directories', async t => {
  const config = await fixture(t)
  await writeFile(join(config.control, 'settings.json'), JSON.stringify({ ...settings, 'another-plugin': { apiKey: 'must-not-enter-home' } }))
  await assert.rejects(prepareUserHome(config), /Invalid/)
  await writeFile(join(config.control, 'settings.json'), JSON.stringify(settings))
  await writeFile(join(config.control, 'user.patch.json'), JSON.stringify([...patch, { insert: [{ name: 'dsh-enterprise-auth' }] }]))
  await assert.rejects(prepareUserHome(config), /Invalid/)
  await writeFile(join(config.control, 'user.patch.json'), JSON.stringify(patch))
  await symlink(config.control, join(config.home, 'profiles'))
  await assert.rejects(prepareUserHome(config), /directory|ELOOP|ENOTDIR/)
})

test('official CLI spawn receives controlled environment and forwards termination signals', async t => {
  const config = await fixture(t)
  const child = new EventEmitter()
  const signals = new EventEmitter()
  const sentSignals = []
  child.kill = value => { sentSignals.push(value); return true }
  let call
  const running = runUserEntrypoint({ ...config, processSignals: signals, spawnProcess: (...args) => { call = args; queueMicrotask(() => { signals.emit('SIGTERM'); child.emit('exit', 0, null) }); return child } })
  assert.equal(await running, 0)
  assert.equal(call[0], process.execPath)
  assert.deepEqual(call[1], ['--import', `${config.appRoot}/node_modules/tsx/dist/esm/index.mjs`, `${config.appRoot}/apps/cli/src/bin.ts`, 'web', '--patch', `${config.control}/user.patch.json`, '--port', '3080', '--no-open'])
  assert.equal(call[2].cwd, '/workspace')
  assert.equal(call[2].env.PORTAL_MODEL_KEY, capability)
  assert.equal(call[2].env.DSH_HOME, config.home)
  assert.equal(call[2].env.NODE_OPTIONS, undefined)
  assert.deepEqual(Object.keys(call[2].env).sort(), ['DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'PORTAL_MODEL_KEY'].sort())
  assert.deepEqual(sentSignals, ['SIGTERM'])
  assert.equal(signals.listenerCount('SIGTERM'), 0)
})
