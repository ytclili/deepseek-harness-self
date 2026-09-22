import { execFileSync } from 'node:child_process'
import { readFile, mkdir, lstat, realpath, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const harness = resolve(process.argv[2] ?? join(root, '../..'))
const expected = (await readFile(join(root, 'harness-version.txt'), 'utf8')).trim()
// Plugin-only commits do not change the Harness version being checked.
try {
  execFileSync('git', ['diff', '--quiet', `${expected}^{commit}`, 'HEAD', '--', '.', ':(exclude)selfPlugin/**'], { cwd: harness, stdio: 'pipe' })
} catch (error) {
  throw new Error('Harness 基准不可用或 selfPlugin 外的已提交文件发生变化，请先验证兼容性再更新 harness-version.txt。', { cause: error })
}
const packages = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@types/node': 'node_modules/@types/node',
  typescript: 'node_modules/typescript',
  'js-yaml': 'packages/boot/app-boot/node_modules/js-yaml',
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
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
    if (!stat.isSymbolicLink() || await realpath(target) !== source) throw new Error(`依赖 ${name} 已存在且不是当前 Harness 链接。`)
  } else {
    await symlink(source, target, 'dir')
  }
}
console.log('企业工具开发依赖已链接到指定 Harness；未下载依赖或修改 Harness。')
