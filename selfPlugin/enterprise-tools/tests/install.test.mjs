import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('../scripts/install-local.mjs', import.meta.url))

test('local install preserves other plugins and expressions, backs up, and is idempotent', async t => {
  for (const original of ['# empty profile\n[]\n', '[] # empty profile\n', '[{id: existing, config: {secret: !!js process.env.FAKE_CANARY}}]\n', '- id: existing\n  config:\n    secret: !!js process.env.FAKE_CANARY\n']) {
    const directory = await mkdtemp(join(tmpdir(), 'enterprise-install-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const profile = join(directory, 'profiles/web')
    await mkdir(profile, { recursive: true })
    await mkdir(join(directory, 'secrets'))
    await writeFile(join(profile, 'package.json'), '{}')
    await writeFile(join(profile, 'cordis.patch.yml'), original)
    await writeFile(join(directory, 'secrets/enterprise-tools.token'), 'fake-token', { mode: 0o600 })
    const run = () => execFileSync(process.execPath, [script], { env: { PATH: process.env.PATH, DSH_HOME: directory }, encoding: 'utf8' })
    run()
    const installed = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(installed, /id: enterprise-tools/)
    assert.equal(installed.includes('fake-token'), false)
    if (original.startsWith('- id: existing')) assert.ok(installed.startsWith(original))
    if (original.includes('FAKE_CANARY')) assert.match(installed, /!!js process.env.FAKE_CANARY/)
    const backups = await readdir(join(directory, 'backups/enterprise-tools'))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(directory, 'backups/enterprise-tools', backups[0]), 'utf8'), original)
    run()
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), installed)
    assert.equal((await readdir(join(directory, 'backups/enterprise-tools'))).length, 1)
  }
})

test('reinstall leaves later disable overrides after the managed insert', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const profile = join(directory, 'profiles/web')
  await mkdir(profile, { recursive: true })
  await mkdir(join(directory, 'secrets'))
  await writeFile(join(profile, 'package.json'), '{}')
  const patchFile = join(profile, 'cordis.patch.yml')
  await writeFile(patchFile, '[]\n')
  await writeFile(join(directory, 'secrets/enterprise-tools.token'), 'fake-token', { mode: 0o600 })
  const run = () => execFileSync(process.execPath, [script], { env: { PATH: process.env.PATH, DSH_HOME: directory }, encoding: 'utf8' })
  run()
  const withOverride = `${await readFile(patchFile, 'utf8')}- id: enterprise-tools\n  disabled: true\n`
  await writeFile(patchFile, withOverride)
  run()
  assert.equal(await readFile(patchFile, 'utf8'), withOverride)
})

test('local install refuses unmanaged duplicate plugin and invalid YAML without overwriting', async t => {
  for (const original of ['- insert:\n    - id: enterprise-tools\n      name: custom\n', 'secret: [broken']) {
    const directory = await mkdtemp(join(tmpdir(), 'enterprise-install-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const profile = join(directory, 'profiles/web')
    await mkdir(profile, { recursive: true })
    await mkdir(join(directory, 'secrets'))
    await writeFile(join(profile, 'package.json'), '{}')
    await writeFile(join(profile, 'cordis.patch.yml'), original)
    await writeFile(join(directory, 'secrets/enterprise-tools.token'), 'fake-token', { mode: 0o600 })
    assert.throws(() => execFileSync(process.execPath, [script], { env: { PATH: process.env.PATH, DSH_HOME: directory }, stdio: 'pipe' }))
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), original)
  }
})
