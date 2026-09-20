import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This is a local 4.21.2 integration patch, not an identity management API.
const root = fileURLToPath(new URL('..', import.meta.url))
const target = resolve(process.argv[2] ?? '')
const checkOnly = process.argv[3] === '--check'
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/patch-dsh-im.mjs <IM package directory> <build node_modules directory|--check>')
const manifest = JSON.parse(await readFile(join(root, 'patches/dsh-im-4.21.2.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
if (pkg.name !== '@xmanrui/dsh-im' || pkg.version !== manifest.version) throw new Error('Unsupported IM version; review the adapter before upgrading.')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = async path => hash(await readFile(path))
const hashes = await Promise.all(manifest.files.map(file => fileHash(join(target, file.path))))
const original = hashes.every((value, index) => value === manifest.files[index].before)
const patched = hashes.every((value, index) => value === manifest.files[index].after)
const previous = hashes.every((value, index) => value === manifest.files[index].previous)
const bundlePath = join(target, 'lib/index.js')
const receiptPath = join(target, '.enterprise-auth-patch.json')
const bundleHash = await fileHash(bundlePath)
if (patched) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt.version !== manifest.version || receipt.revision !== manifest.revision || receipt.bundleHash !== bundleHash) throw new Error('Patched sources do not match the recorded Host bundle. Restore the backup before retrying.')
  console.log('DSH-IM WeChat and Feishu identity patch verified (source and Host bundle).')
} else {
  const upgrading = previous && bundleHash === manifest.previousBundleHash
  if (upgrading) {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    if (receipt.version !== manifest.version || receipt.bundleHash !== bundleHash) throw new Error('Previous identity patch receipt mismatch.')
  } else if (!original || bundleHash !== manifest.originalBundleHash) throw new Error('IM files differ from the reviewed 4.21.2 package; refusing to overwrite local changes.')
  if (checkOnly) throw new Error('The WeChat and Feishu identity patch is not installed.')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-im-auth-build-'))
  try {
    for (const path of ['src', 'plugin-src', 'package.json']) await cp(join(target, path), join(temporary, path), { recursive: true })
    await symlink(resolve(process.argv[3]), join(temporary, 'node_modules'), 'dir')
    const patch = join(root, upgrading ? 'patches/dsh-im-4.21.2-feishu-upgrade.patch' : 'patches/dsh-im-4.21.2.patch')
    execFileSync('git', ['apply', '--check', patch], { cwd: temporary, stdio: 'inherit' })
    execFileSync('git', ['apply', patch], { cwd: temporary, stdio: 'inherit' })
    for (const file of manifest.files) {
      if (await fileHash(join(temporary, file.path)) !== file.after) throw new Error('Patched source digest mismatch.')
    }
    execFileSync(process.execPath, ['plugin-src/host/build.mjs'], { cwd: temporary, stdio: 'inherit' })
    const nextBundleHash = await fileHash(join(temporary, 'lib/index.js'))
    // Recheck after the build so concurrent package updates are not overwritten.
    for (const [index, file] of manifest.files.entries()) {
      if (await fileHash(join(target, file.path)) !== hashes[index]) throw new Error('IM source changed during build.')
    }
    if (await fileHash(bundlePath) !== bundleHash) throw new Error('IM bundle changed during build.')
    const backup = join(target, `.enterprise-auth-backup-${Date.now()}`)
    for (const path of [...manifest.files.map(file => file.path), 'lib/index.js', ...(upgrading ? ['.enterprise-auth-patch.json'] : [])]) {
      await mkdir(dirname(join(backup, path)), { recursive: true })
      await cp(join(target, path), join(backup, path))
    }
    for (const path of [...manifest.files.map(file => file.path), 'lib/index.js']) {
      const pending = join(target, `${path}.enterprise-auth-pending`)
      await cp(join(temporary, path), pending)
      await rename(pending, join(target, path))
    }
    await writeFile(receiptPath, JSON.stringify({ version: manifest.version, revision: manifest.revision, bundleHash: nextBundleHash, backup }, null, 2) + '\n')
    console.log(`DSH-IM WeChat and Feishu identity patch installed. Backup: ${backup}`)
    console.log('Restart the existing Harness process to load the new Host code.')
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
