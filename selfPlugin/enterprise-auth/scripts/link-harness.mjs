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
const manifest = JSON.parse(await readFile(join(harness, 'packages/core/tools/package.json'), 'utf8'))
if (manifest.version !== '0.1.6-alpha.1') throw new Error('请先核对该 Harness 版本与插件接口兼容性。')
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
