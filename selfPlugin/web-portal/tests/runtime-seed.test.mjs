import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { prepareRuntime } from '../dist/runtime-seed.js'
import { ModelProxy } from '../dist/model-proxy.js'
import { identityKey } from '../dist/identity.js'

const model = { baseUrl: 'https://model.example/v1', apiKeyFile: '/fixture/model.key', model: 'fixture-model', runtimeBaseUrl: 'http://host.docker.internal:3081/portal/model/v1', maxBodyBytes: 1024, timeoutMs: 1000, maxConcurrent: 1, sessionTtlMs: 60_000 }
const config = { backend: { baseUrl: 'https://business.example', maxResponseBytes: 1024 }, model, businessTimeoutMs: 1000, goodsMaxItems: 100 }
const first = { tenantId: 'tenant', userId: 'user', token: 'old-business-canary', expiresAt: null }
const second = { ...first, token: 'new-business-canary' }
const files = ['business.json', 'business.token', 'model.env', 'settings.json', 'user.patch.json']

test('cancelled file preparation cannot overwrite a newer login or revoke its model grant', async t => {
  for (const file of files) await t.test(file, async t => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'portal-seed-'))
    const models = new ModelProxy(model)
    const controller = new AbortController()
    let release
    let entered
    let blocked = false
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { entered = resolve })
    const open = fs.open
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args)
      // Production writes uid 1000 files; this fixture retains its current owner.
      handle.chown = async () => {}
      if (!blocked && basename(String(args[0])).startsWith(`.${file}.`)) {
        blocked = true
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { await sync(); entered(); await gate }
      }
      return handle
    })
    syncBuiltinESMExports()
    t.after(async () => {
      release()
      t.mock.restoreAll(); syncBuiltinESMExports()
      models.close()
      await fs.rm(directory, { recursive: true, force: true })
    })
    const previous = prepareRuntime(config, models, first, identityKey(first), directory, controller.signal)
    const outcome = previous.then(() => undefined, error => error)
    await started
    controller.abort(new Error('fixture cancellation'))
    // The gateway revokes the failed login before admitting the new one.
    models.revoke(identityKey(first))
    await prepareRuntime({ ...config, goodsMaxItems: 50, model: { ...model, model: 'new-model' } }, models, second, identityKey(second), directory, new AbortController().signal)
    const current = await Promise.all(files.map(name => fs.readFile(join(directory, name), 'utf8')))
    const capability = models.grant(second)
    release()
    assert.equal((await outcome)?.message, 'fixture cancellation')
    assert.deepEqual(await Promise.all(files.map(name => fs.readFile(join(directory, name), 'utf8'))), current)
    assert.equal(await fs.readFile(join(directory, 'business.token'), 'utf8'), second.token)
    assert.equal(await fs.readFile(join(directory, 'model.env'), 'utf8'), `PORTAL_MODEL_KEY=${capability}\n`)
    assert.equal(models.grant(second), capability)
    assert.deepEqual((await fs.readdir(directory)).sort(), [...files].sort())
  })
})

test('cancellation while checking the control directory does not issue a model grant', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'portal-seed-'))
  const controller = new AbortController()
  const lstat = fs.lstat
  let grants = 0
  t.mock.method(fs, 'lstat', async (...args) => {
    const value = await lstat(...args)
    controller.abort(new Error('fixture cancellation'))
    return value
  })
  syncBuiltinESMExports()
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(directory, { recursive: true, force: true }) })
  await assert.rejects(prepareRuntime(config, { grant() { grants++; return 'fake-capability' } }, first, identityKey(first), directory, controller.signal), /fixture cancellation/)
  assert.equal(grants, 0)
  assert.deepEqual(await fs.readdir(directory), [])
})
