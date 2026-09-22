/** Produce an offline Linux image payload without copying private state or unrelated plugins. */
import { cp, lstat, mkdir, readFile, readlink, realpath, writeFile, unlink, symlink, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const roots = new Set(['apps', 'packages', 'vendor', 'native', 'python', 'node_modules', 'patches'])
const rootFiles = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.base.client.json', 'tsconfig.host.json', 'tsconfig.client.json', 'tsdown.config.ts', 'vitest.config.ts', 'vitest.shared.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
const plugins = new Set(['web-portal', 'enterprise-auth', 'enterprise-tools'])
const excluded = new Set(['.git', '.dsh', '.codex', '.agents', '.claude', '.ssh', '.aws', '.secrets', 'usersecret', 'usersecrets', 'backups', 'screenshots', 'playwright-report', 'test-results', '.npmrc', '.DS_Store'])

async function verifyLinks(payload, directory = payload) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await verifyLinks(payload, path); continue }
    if (!entry.isSymbolicLink()) continue
    let current = payload
    let remaining = relative(payload, path).split(sep)
    let hops = 0
    while (remaining.length) {
      const next = join(current, remaining.shift())
      if (!(await lstat(next)).isSymbolicLink()) { current = next; continue }
      if (++hops > 40) throw new Error('Build symlink loop')
      const link = await readlink(next)
      const target = isAbsolute(link) ? link.startsWith('/app/') ? join(payload, link.slice(5)) : undefined : resolve(dirname(next), link)
      if (!target || !target.startsWith(`${payload}${sep}`)) throw new Error('Unapproved build symlink')
      remaining = [...relative(payload, target).split(sep), ...remaining]
      current = payload
    }
  }
}

function allowed(source, path, prepare = false) {
  const rel = relative(source, path)
  if (!rel) return true
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false
  const parts = rel.split(sep)
  if (parts.some(part => excluded.has(part) || /^\.env(?:\.|$)|\.env$|\.token(?:\.|$)|^\.credentials(?:\.|$)|\.log$|\.(?:pem|key)$/.test(part))) return false
  if (!prepare && !parts.includes('node_modules') && parts.some(part => ['tests', '__tests__', 'snapshots', 'docs'].includes(part))) return false
  const [root, plugin, child] = parts
  if (root === 'selfPlugin') return parts.length === 1 || (plugins.has(plugin) && !['runtime', 'data', 'control', 'backup', 'logs', '.cache'].includes(child))
  if (prepare && ['scripts', 'benchmarks', 'website'].includes(root)) return true
  return roots.has(root) || (parts.length === 1 && rootFiles.has(basename(path)))
}

/** @param sourcePath Built Linux Harness 0.1.7 checkout. @param targetPath New directory outside that checkout. */
export async function createBuildContext(sourcePath, targetPath, { prepare = false, hostSource } = {}) {
  const source = await realpath(sourcePath)
  const target = resolve(targetPath)
  if (hostSource !== undefined && (!isAbsolute(hostSource) || hostSource === sep)) throw new Error('Invalid host source alias')
  if (source === sep || target === source || target.startsWith(`${source}${sep}`)) throw new Error('Build context must be outside the source tree')
  const cli = JSON.parse(await readFile(join(source, 'apps/cli/package.json'), 'utf8'))
  if (!/^0\.1\.7(?:-|$)/.test(cli.version)) throw new Error('Built Harness 0.1.7 required')
  if (!prepare) for (const file of ['package.json', 'apps/cli/lib/bin.js', 'apps/web/dist/index.html', 'node_modules', 'selfPlugin/web-portal/dist/index.js', 'selfPlugin/web-portal/client/dist/index.html', 'selfPlugin/enterprise-auth/dist/http.js', 'selfPlugin/enterprise-tools/dist/index.js']) await lstat(join(source, file))
  await mkdir(target, { mode: 0o700 })
  const absoluteLinks = []
  await cp(source, join(target, 'payload'), { recursive: true, dereference: false, verbatimSymlinks: true, force: false, filter: async path => {
    if (!allowed(source, path, prepare)) return false
    if ((await lstat(path)).isSymbolicLink()) {
      const link = await readlink(path)
      const alias = isAbsolute(link) && ['/app', source, resolve(sourcePath), hostSource].find(root => root && link.startsWith(`${root}/`))
      const destination = alias ? join(source, link.slice(alias.length + 1)) : resolve(path, '..', link)
      const destinationRoot = relative(source, destination).split(sep)[0]
      if (!prepare && ['benchmarks', 'website', 'scripts'].includes(destinationRoot) && relative(source, path).split(sep).includes('node_modules')) return false
      if (!allowed(source, destination, prepare)) throw new Error('Unapproved build symlink')
      try { await lstat(destination) }
      catch (error) {
        // pnpm virtual roots may retain links to workspaces removed by a Harness upgrade.
        if (error.code === 'ENOENT' && relative(source, path).split(sep).includes('node_modules')) return false
        throw error
      }
      if (isAbsolute(link)) absoluteLinks.push({ path: relative(source, path), target: `/app/${relative(source, destination).split(sep).join('/')}` })
    }
    return true
  } })
  for (const link of absoluteLinks) { const path = join(target, 'payload', link.path); await unlink(path); await symlink(link.target, path) }
  await verifyLinks(join(target, 'payload'))
  for (const name of ['user.Dockerfile', 'user.Dockerfile.dockerignore']) await cp(join(source, 'selfPlugin/web-portal/deploy', name), join(target, name), { errorOnExist: true })
  await writeFile(join(target, '.portal-build-context.json'), `${JSON.stringify({ version: 1, harness: cli.version, plugins: [...plugins] })}\n`, { mode: 0o600, flag: 'wx' })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { prepare: { type: 'boolean' }, 'host-source': { type: 'string' } } })
    if (process.platform !== 'linux' || positionals.length !== 2) throw new Error('Linux source and new destination required')
    await createBuildContext(positionals[0], positionals[1], { prepare: values.prepare, hostSource: values['host-source'] })
    console.log('Prepared isolated Linux build context.')
  } catch (error) {
    console.error(error.message === 'Built Harness 0.1.7 required' ? error.message : 'Build context rejected; check built artifacts, symlinks, and a new destination outside the source tree.')
    process.exitCode = 1
  }
}
