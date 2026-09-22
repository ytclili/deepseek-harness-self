/** Dedicated dsh profile for the gateway, without agent/IM/admin bundles. */
import { mkdir, writeFile, symlink, lstat, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const home = '/srv/portal/gateway/.dsh'
const profile = join(home, 'profiles/portal')
await mkdir(join(profile, 'node_modules'), { recursive: true, mode: 0o700 })
await writeFile(join(home, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-portal', private: true, type: 'module',
  dependencies: { 'dsh-web-portal': 'link:/app/selfPlugin/web-portal' },
  dsh: { profile: { bundles: ['dsh-web-portal'], patchReload: 'startup' } },
}), { mode: 0o600 })
const link = join(profile, 'node_modules/dsh-web-portal')
try { const stat = await lstat(link); if (!stat.isSymbolicLink()) throw new Error('Invalid gateway dependency'); await unlink(link) }
catch (error) { if (error.code !== 'ENOENT') throw error }
await symlink('/app/selfPlugin/web-portal', link)
const child = spawn(process.execPath, ['--import', '/app/node_modules/tsx/dist/esm/index.mjs', '/app/apps/cli/src/bin.ts', '--profile', 'portal'], {
  cwd: '/srv/portal/gateway', stdio: 'inherit', env: {
    HOME: '/srv/portal/gateway', DSH_HOME: home, NODE_ENV: 'production', DSH_TELEMETRY_DISABLED: '1',
    PORTAL_PORT: process.env.PORTAL_PORT ?? '23080', PORTAL_CONFIG_FILE: '/srv/portal/gateway/config.json',
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
  },
})
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.on('SIGINT', () => child.kill('SIGINT'))
child.once('error', () => { console.error('Gateway process unavailable'); process.exitCode = 1 })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143) })
