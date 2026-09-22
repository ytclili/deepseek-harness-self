/** Runs only inside a user's container. Never read an administrator home or inherit its environment. */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, symlink, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaults = { home: '/home/node/.dsh', control: '/run/portal', appRoot: '/app' }
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

function invalid() { throw new Error('Invalid user runtime configuration') }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
}
function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value) }

export function parseModelEnvironment(content) {
  const match = /^PORTAL_MODEL_KEY=([A-Za-z0-9_-]{32,128})\n?$/.exec(content)
  if (!match) invalid()
  return match[1]
}

async function readControl(path, maxBytes) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) invalid()
    const value = await file.readFile('utf8')
    if (Buffer.byteLength(value) > maxBytes) invalid()
    return value
  } finally { await file.close() }
}

function parseJson(value) { try { return JSON.parse(value) } catch { invalid() } }

function validateSettings(settings) {
  keys(settings, ['llm-pi-ai', 'agent-default-model', 'ui-onboarding'])
  keys(settings['llm-pi-ai'], ['providers'])
  keys(settings['llm-pi-ai'].providers, ['portal'])
  const provider = settings['llm-pi-ai'].providers.portal
  keys(provider, ['displayName', 'api', 'apiKeyEnv', 'baseURL', 'models'])
  if (provider.api !== 'openai-completions' || provider.apiKeyEnv !== 'PORTAL_MODEL_KEY' || !text(provider.displayName)) invalid()
  let destination
  try { destination = new URL(provider.baseURL) } catch { invalid() }
  if (destination.protocol !== 'http:' || destination.hostname !== 'host.docker.internal' || !destination.port || destination.username || destination.password || destination.search || destination.hash) invalid()
  if (!Array.isArray(provider.models) || provider.models.length !== 1) invalid()
  keys(provider.models[0], ['id', 'name'])
  if (!text(provider.models[0].id) || !text(provider.models[0].name)) invalid()
  keys(settings['agent-default-model'], ['provider', 'model'])
  if (settings['agent-default-model'].provider !== 'portal' || settings['agent-default-model'].model !== provider.models[0].id) invalid()
  keys(settings['ui-onboarding'], ['welcomeNoticeVersion'])
  if (!text(settings['ui-onboarding'].welcomeNoticeVersion)) invalid()
}

function validatePatch(patch) {
  if (!Array.isArray(patch) || patch.length !== 2) invalid()
  keys(patch[0], ['id', 'config'])
  keys(patch[0].config, ['host', 'port'])
  if (patch[0].id !== 'webserver' || patch[0].config.host !== '0.0.0.0' || patch[0].config.port !== 3080) invalid()
  keys(patch[1], ['insert'])
  if (!Array.isArray(patch[1].insert) || patch[1].insert.length !== 2) invalid()
  const [business, tools] = patch[1].insert
  keys(business, ['id', 'name', 'config'])
  keys(business.config, ['credentialFile', 'identityKey', 'backend', 'timeoutMs'])
  if (business.id !== 'portal-user-business' || business.name !== 'dsh-web-portal/user-business' || business.config.credentialFile !== '/run/portal/business.json' || !/^[a-f0-9]{64}$/.test(business.config.identityKey) || !object(business.config.backend)) invalid()
  keys(tools, ['id', 'name', 'config'])
  keys(tools.config, ['baseUrl', 'tokenFile', 'timeoutMs', 'maxResponseBytes', 'maxItems'])
  if (tools.id !== 'enterprise-tools' || tools.name !== 'dsh-enterprise-tools' || tools.config.tokenFile !== '/run/portal/business.token') invalid()
}

async function directory(path) {
  await mkdir(path, { mode: 0o700, recursive: true })
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.chmod(0o700) } finally { await handle.close() }
}

async function writePrivate(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
  try { await handle.chmod(0o600); await handle.writeFile(value) } finally { await handle.close() }
}

async function localLink(path, target) {
  let stat
  try { stat = await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (stat) {
    if (!stat.isSymbolicLink()) throw new Error('Invalid user runtime module directory')
    await unlink(path)
  }
  await symlink(target, path, 'dir')
}

/** Injectable paths support fixture tests; the executable entry always uses the fixed container paths. */
export async function prepareUserHome({ home, control, appRoot } = defaults) {
  if (![home, control, appRoot].every(value => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f]/.test(value))) invalid()
  const [environment, settingsText, patchText] = await Promise.all([
    readControl(join(control, 'model.env'), 256), readControl(join(control, 'settings.json'), 65536), readControl(join(control, 'user.patch.json'), 65536),
  ])
  const modelKey = parseModelEnvironment(environment)
  const settings = parseJson(settingsText)
  validateSettings(settings)
  validatePatch(parseJson(patchText))
  const profile = join(home, 'profiles/web')
  for (const path of [home, join(home, 'profiles'), profile, join(profile, 'node_modules')]) await directory(path)
  const dependencies = { 'dsh-web-portal': `link:${appRoot}/selfPlugin/web-portal`, 'dsh-enterprise-tools': `link:${appRoot}/selfPlugin/enterprise-tools` }
  await writePrivate(join(home, 'settings.yaml'), `${JSON.stringify(settings)}\n`)
  await writePrivate(join(profile, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, type: 'module', dependencies, dsh: { profile: { bundles, patchReload: 'startup' } } })}\n`)
  // The approved profile is rebuilt at startup; persisted custom patch files cannot add another surface.
  await writePrivate(join(home, 'cordis.patch.yml'), '[]\n')
  await writePrivate(join(profile, 'cordis.patch.yml'), '[]\n')
  for (const [name, target] of Object.entries(dependencies)) await localLink(join(profile, 'node_modules', name), target.slice(5))
  return { modelKey }
}

export async function runUserEntrypoint({ home = defaults.home, control = defaults.control, appRoot = defaults.appRoot, spawnProcess = spawn, processSignals = process } = {}) {
  const { modelKey } = await prepareUserHome({ home, control, appRoot })
  const child = spawnProcess(process.execPath, ['--import', join(appRoot, 'node_modules/tsx/dist/esm/index.mjs'), join(appRoot, 'apps/cli/src/bin.ts'), 'web', '--patch', join(control, 'user.patch.json'), '--port', '3080', '--no-open'], {
    cwd: '/workspace', stdio: 'inherit', env: {
      HOME: '/home/node', DSH_HOME: home, PORTAL_MODEL_KEY: modelKey, NODE_ENV: 'production', DSH_TELEMETRY_DISABLED: '1',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8',
    },
  })
  const term = () => child.kill('SIGTERM')
  const interrupt = () => child.kill('SIGINT')
  processSignals.on('SIGTERM', term)
  processSignals.on('SIGINT', interrupt)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('User runtime process unavailable')))
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
    })
  } finally {
    processSignals.removeListener('SIGTERM', term)
    processSignals.removeListener('SIGINT', interrupt)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = await runUserEntrypoint() }
  catch { console.error('User runtime startup failed'); process.exitCode = 1 }
}
