import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
// Existing checkout history is read-only: these tests never create commits or modify its index.
const actualHarness = resolve(await realpath(join(pluginRoot, 'node_modules/@deepseek-ai/dsh-tools')), '../../..')
const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: actualHarness, encoding: 'utf8' }).trim()
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: actualHarness, encoding: 'utf8' }).trim()
const packages = {
  '@deepseek-ai/cordis': ['vendor/cordis', '4.0.3'],
  '@deepseek-ai/schemastery': ['vendor/schemastery', '3.18.3'],
  '@deepseek-ai/dsh-tools': ['packages/core/tools', '0.1.7-alpha.1'],
  '@deepseek-ai/dsh-system-prompt': ['packages/core/system-prompt', '0.1.7-alpha.1'],
  '@deepseek-ai/dsh-llm': ['packages/llm/llm', '0.1.7-alpha.1'],
  '@types/node': ['node_modules/@types/node', '22.20.0'],
  typescript: ['node_modules/typescript', '6.0.3'],
  'js-yaml': ['packages/boot/app-boot/node_modules/js-yaml', '4.2.0'],
}

async function fixture(t, mismatch) {
  const directory = await mkdtemp(join(tmpdir(), 'tools-setup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = join(directory, 'harness')
  const plugin = join(harness, 'selfPlugin/enterprise-tools')
  await mkdir(join(plugin, 'scripts'), { recursive: true })
  await copyFile(join(pluginRoot, 'package.json'), join(plugin, 'package.json'))
  await copyFile(join(pluginRoot, 'scripts/link-harness.mjs'), join(plugin, 'scripts/link-harness.mjs'))
  await writeFile(join(plugin, 'harness-version.txt'), `${head}\n`)
  for (const [name, [relative, version]] of Object.entries(packages)) {
    const path = join(harness, relative, 'package.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ name, version: name === mismatch ? '0.0.0-incompatible' : version }))
  }
  const run = () => spawnSync(process.execPath, [join(plugin, 'scripts/link-harness.mjs'), harness], { encoding: 'utf8', env: { ...process.env, GIT_DIR: gitDirectory, GIT_WORK_TREE: harness, GIT_OPTIONAL_LOCKS: '0' } })
  return { harness, plugin, run }
}

test('0.1.7 Harness setup links dependencies and repeated setup preserves links', async t => {
  const f = await fixture(t)
  for (let run = 0; run < 2; run++) { const result = f.run(); assert.equal(result.status, 0, result.stderr) }
  for (const [name, [relative]] of Object.entries(packages)) assert.equal(await realpath(join(f.plugin, 'node_modules', name)), await realpath(join(f.harness, relative)))
})

test('wrong declared peer versions fail before any links are created', async t => {
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  for (const name of Object.keys(manifest.peerDependencies)) {
    await t.test(name, async t => {
      const f = await fixture(t, name)
      const result = f.run()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      await assert.rejects(lstat(join(f.plugin, 'node_modules')), { code: 'ENOENT' })
    })
  }
})

test('a changed committed Harness baseline is rejected without bypassing the Git guard', async t => {
  // A plugin-only HEAD (or its parent) can have the same Harness tree. Select
  // an ancestor by its actual diff instead of assuming HEAD~1 differs.
  const ancestors = execFileSync('git', ['rev-list', '--first-parent', head, '--', '.', ':(exclude)selfPlugin/**'], { cwd: actualHarness, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  let previous
  for (const candidate of ancestors) {
    const diff = spawnSync('git', ['diff', '--quiet', candidate, head, '--', '.', ':(exclude)selfPlugin/**'], { cwd: actualHarness, encoding: 'utf8' })
    assert.ok(diff.status === 0 || diff.status === 1, diff.stderr)
    if (diff.status === 1) { previous = candidate; break }
  }
  if (!previous) { t.skip('available history has no differing non-plugin Harness baseline'); return }
  const f = await fixture(t)
  await writeFile(join(f.plugin, 'harness-version.txt'), `${previous}\n`)
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Harness 基准不可用或 selfPlugin 外/)
  await assert.rejects(lstat(join(f.plugin, 'node_modules')), { code: 'ENOENT' })
})
