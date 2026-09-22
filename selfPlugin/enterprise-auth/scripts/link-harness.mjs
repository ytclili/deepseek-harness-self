import { mkdir, lstat, realpath, symlink, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const harness = resolve(process.argv[2] ?? join(root, '../..'))
const packages = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@types/node': 'node_modules/@types/node',
  typescript: 'node_modules/typescript',
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
// Exact pins are the reviewed compatibility contract; validate before creating any links.
for (const [name, expected] of Object.entries(manifest.peerDependencies)) {
  if (!name.startsWith('@deepseek-ai/')) continue
  const relative = packages[name]
  if (!relative) throw new Error(`Harness peer ${name} 尚未配置本地链接。`)
  const actual = JSON.parse(await readFile(join(harness, relative, 'package.json'), 'utf8'))
  if (actual.name !== name || actual.version !== expected) throw new Error(`Harness peer ${name} 需要 ${expected}，请先核对接口兼容性。`)
}
for (const [name, relative] of Object.entries(packages)) {
  const source = await realpath(join(harness, relative))
  const target = join(root, 'node_modules', name)
  await mkdir(dirname(target), { recursive: true })
  let stat
  try { stat = await lstat(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (stat) {
    if (!stat.isSymbolicLink() || await realpath(target) !== source) throw new Error('已有依赖与指定 Harness 不匹配。')
  } else await symlink(source, target, 'dir')
}
console.log('开发依赖已链接；未修改 Harness。')
