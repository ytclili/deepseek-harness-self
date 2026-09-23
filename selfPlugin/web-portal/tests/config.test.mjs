import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readGatewayConfig } from '../dist/config.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'portal-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.json')
  const policy = join(directory, 'policy.json')
  await writeFile(policy, JSON.stringify({ version: 1, interfacePrefix: 'dshp', gatewayPort: 3081, denyPrivate: true }))
  return async overrides => {
    await writeFile(path, JSON.stringify({ publicOrigin: 'http://127.0.0.1:3081', networkPolicyFile: policy, backend: {}, docker: {}, model: { apiKeyFile: join(directory, 'model.key'), runtimeBaseUrl: 'http://host.docker.internal:3081/portal/model/v1' }, ...overrides }))
    return readGatewayConfig(path)
  }
}

test('business limits accept both supported endpoints and retain defaults', async t => {
  const read = await fixture(t)
  const defaults = await read({})
  assert.equal(defaults.businessTimeoutMs, 10_000)
  assert.equal(defaults.goodsMaxItems, 100)
  assert.equal(defaults.docker.requestTimeoutMs, defaults.docker.activationTimeoutMs)
  const slowStorage = await read({ docker: { activationTimeoutMs: 600_000, requestTimeoutMs: 300_000 } })
  assert.equal(slowStorage.docker.activationTimeoutMs, 600_000)
  assert.equal(slowStorage.docker.requestTimeoutMs, 300_000)
  for (const [businessTimeoutMs, goodsMaxItems] of [[1, 1], [60_000, 100]]) {
    const config = await read({ businessTimeoutMs, goodsMaxItems })
    assert.equal(config.businessTimeoutMs, businessTimeoutMs)
    assert.equal(config.goodsMaxItems, goodsMaxItems)
  }
})

test('business limits reject values the isolated tools cannot accept', async t => {
  const read = await fixture(t)
  for (const [field, values] of [['businessTimeoutMs', [0, -1, 1.5, 60_001]], ['goodsMaxItems', [0, -1, 1.5, 101]]]) {
    await t.test(field, async () => {
      for (const value of values) await assert.rejects(read({ [field]: value }), /Invalid .*budget|Invalid business tool limits/, `${field}=${value}`)
    })
  }
})
