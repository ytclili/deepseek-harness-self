/** Dedicated dsh profile for the gateway, without agent/IM/admin bundles. */
import { mkdir, writeFile, symlink, lstat, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Injectable paths and process operations support keyless entrypoint tests. */
export async function runGatewayEntrypoint({ root = '/srv/portal/gateway', appRoot = '/app', environment = process.env, spawnProcess = spawn, processSignals = process } = {}) {
  const home = join(root, '.dsh')
  const profile = join(home, 'profiles/portal')
  await mkdir(join(profile, 'node_modules'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-portal', private: true, type: 'module',
    dependencies: { 'dsh-web-portal': `link:${appRoot}/selfPlugin/web-portal` },
    dsh: { profile: { bundles: ['dsh-web-portal'], patchReload: 'startup' } },
  }), { mode: 0o600 })
  const link = join(profile, 'node_modules/dsh-web-portal')
  try { const stat = await lstat(link); if (!stat.isSymbolicLink()) throw new Error('Invalid gateway dependency'); await unlink(link) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(join(appRoot, 'selfPlugin/web-portal'), link)
  const proxy = {}
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (environment[name]) proxy[name] = environment[name]
  }
  const child = spawnProcess(process.execPath, [join(appRoot, 'apps/cli/lib/bin.js'), '--profile', 'portal'], {
    cwd: root, stdio: 'inherit', env: {
      HOME: root, DSH_HOME: home, NODE_ENV: 'production', DSH_TELEMETRY_DISABLED: '1',
      PORTAL_PORT: environment.PORTAL_PORT ?? '23080', PORTAL_CONFIG_FILE: join(root, 'config.json'),
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', NODE_USE_ENV_PROXY: '1', NARB_DISABLE_NATIVE_CACHE: '1', ...proxy,
    },
  })
  const term = () => child.kill('SIGTERM')
  const interrupt = () => child.kill('SIGINT')
  processSignals.on('SIGTERM', term); processSignals.on('SIGINT', interrupt)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Gateway process unavailable')))
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
    })
  } finally { processSignals.removeListener('SIGTERM', term); processSignals.removeListener('SIGINT', interrupt) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = await runGatewayEntrypoint() }
  catch { console.error('Gateway startup failed'); process.exitCode = 1 }
}
