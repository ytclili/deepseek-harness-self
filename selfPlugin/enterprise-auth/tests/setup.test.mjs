import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const packages = {
  '@deepseek-ai/cordis': ['vendor/cordis', '4.0.3'],
  '@deepseek-ai/schemastery': ['vendor/schemastery', '3.18.3'],
  '@deepseek-ai/dsh-tools': ['packages/core/tools', '0.1.7-alpha.1'],
  '@deepseek-ai/dsh-llm': ['packages/llm/llm', '0.1.7-alpha.1'],
  '@deepseek-ai/dsh-system-prompt': ['packages/core/system-prompt', '0.1.7-alpha.1'],
  '@types/node': ['node_modules/@types/node', '22.20.0'],
  typescript: ['node_modules/typescript', '6.0.3'],
}

async function fixture(t, mismatch) {
  const directory = await mkdtemp(join(tmpdir(), 'auth-setup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = join(directory, 'harness')
  const plugin = join(harness, 'selfPlugin/enterprise-auth')
  await mkdir(join(plugin, 'scripts'), { recursive: true })
  await copyFile(join(pluginRoot, 'package.json'), join(plugin, 'package.json'))
  await copyFile(join(pluginRoot, 'scripts/link-harness.mjs'), join(plugin, 'scripts/link-harness.mjs'))
  for (const [name, [relative, version]] of Object.entries(packages)) {
    const path = join(harness, relative, 'package.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ name, version: name === mismatch ? '0.0.0-incompatible' : version }))
  }
  const run = () => spawnSync(process.execPath, [join(plugin, 'scripts/link-harness.mjs'), harness], { encoding: 'utf8' })
  return { harness, plugin, run }
}

test('0.1.7 Harness setup links the fixture dependencies and is repeatable', async t => {
  const f = await fixture(t)
  for (let run = 0; run < 2; run++) {
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
  }
  for (const [name, [relative]] of Object.entries(packages)) {
    assert.equal((await lstat(join(f.plugin, 'node_modules', name))).isSymbolicLink(), true)
    assert.equal(await realpath(join(f.plugin, 'node_modules', name)), await realpath(join(f.harness, relative)))
  }
})

test('all declared Harness peer mismatches reject before creating dependency links', async t => {
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

test('guard follows the plugin manifest instead of a hard-coded historical version', async t => {
  const f = await fixture(t)
  const manifestPath = join(f.plugin, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.peerDependencies['@deepseek-ai/dsh-tools'] = '0.1.8-fixture'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(join(f.harness, 'packages/core/tools/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.1.8-fixture' }))
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
})
