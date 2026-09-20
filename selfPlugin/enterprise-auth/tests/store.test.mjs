import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, lstat, readdir, rm, rename, symlink, link, truncate, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const module = await import('../dist/store.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})

const principal = (senderId = 'sender-canary', botId = 'bot-canary', platform = 'weixin') => ({ platform, botId, senderId })
const credential = (overrides = {}) => ({
  version: randomUUID(), userId: 'employee-canary', tenantId: 'tenant-canary',
  token: 'FAKE_TOKEN_CANARY_0123456789', expiresAt: null,
  updatedAt: '2026-09-20T01:02:03.000Z', ...overrides,
})
const safeError = error => {
  assert.equal(error.name, 'EnterpriseAuthError')
  assert.match(error.code, /^[A-Z_]+$/)
  assert.match(error.message, /[\u4e00-\u9fff]/)
  assert.doesNotMatch(error.message, /canary|FAKE|\/|ENOENT|EACCES|password/i)
  assert.equal(error.cause, undefined)
  return true
}
async function fixture(context) {
  assert.equal(typeof module.openCredentialStore, 'function', 'openCredentialStore must be implemented')
  const root = await mkdtemp(join(tmpdir(), 'enterprise-store-test-'))
  const directory = join(root, 'vault')
  const stores = []
  context.after(async () => {
    await Promise.allSettled(stores.map(store => store.close()))
    await rm(root, { recursive: true, force: true })
  })
  return {
    root, directory,
    async open() {
      const store = await module.openCredentialStore({ directory })
      stores.push(store)
      return store
    },
  }
}

test('exports the credential store factory', () => {
  assert.equal(typeof module.openCredentialStore, 'function')
})

test('isolates users, bots and platforms, and returns independent clones', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const identities = [principal(), principal('other-user'), principal('sender-canary', 'other-bot'), principal('sender-canary', 'bot-canary', 'feishu')]
  const credentials = identities.map((_, index) => credential({ token: `FAKE_${index}` }))
  await Promise.all(identities.map((identity, index) => store.put(identity, credentials[index])))
  identities.forEach((identity, index) => assert.deepEqual(store.get(identity), credentials[index]))
  const copy = store.get(identities[0])
  copy.token = 'modified'
  assert.equal(store.get(identities[0]).token, 'FAKE_0')
  assert.equal(store.get(principal('missing')), undefined)
})

test('serializes concurrent writes, snapshots inputs and restores after restart', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const identity = principal()
  const original = credential()
  const expected = { ...original }
  const pending = store.put(identity, original)
  identity.senderId = 'mutated'
  original.token = 'mutated'
  assert.equal(store.get(principal()), undefined)
  await pending
  await Promise.all(Array.from({ length: 24 }, (_, index) => store.put(principal(`user-${index}`), credential())))
  await store.close()
  const restarted = await setup.open()
  assert.deepEqual(restarted.get(principal()), expected)
  for (let index = 0; index < 24; index++) assert.ok(restarted.get(principal(`user-${index}`)))
})

test('stores no identity, credential or password canaries in any files and uses private modes', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const value = credential()
  await store.put(principal(), value)
  assert.equal((await stat(setup.directory)).mode & 0o7777, 0o700)
  assert.equal((await readFile(join(setup.directory, 'key.bin'))).length, 32)
  for (const name of await readdir(setup.directory)) {
    assert.equal((await stat(join(setup.directory, name))).mode & 0o7777, 0o600)
    const contents = await readFile(join(setup.directory, name))
    for (const canary of ['sender-canary', 'bot-canary', value.userId, value.tenantId, value.token, value.version, 'PASSWORD_CANARY']) {
      assert.equal(contents.includes(Buffer.from(canary)), false, `plaintext leak in ${name}`)
    }
  }
  await assert.rejects(store.put(principal(), { ...value, password: 'PASSWORD_CANARY' }), safeError)
})

test('compare-and-remove cannot delete newer credentials and survives restart', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const oldValue = credential()
  const newValue = credential({ token: 'NEW_FAKE_TOKEN' })
  await store.put(principal(), oldValue)
  await Promise.all([store.put(principal(), newValue), store.remove(principal(), oldValue.version)])
  assert.deepEqual(store.get(principal()), newValue)
  await store.remove(principal('unknown'), newValue.version)
  await store.remove(principal(), newValue.version)
  assert.equal(store.get(principal()), undefined)
  await store.close()
  assert.equal((await setup.open()).get(principal()), undefined)
})

test('close drains queued writes, is idempotent and rejects subsequent operations', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const value = credential()
  const pending = store.put(principal(), value)
  const closing = store.close()
  await assert.rejects(store.put(principal('late'), value), safeError)
  assert.throws(() => store.get(principal()), safeError)
  await Promise.all([pending, closing, store.close()])
  await assert.rejects(store.remove(principal(), value.version), safeError)
  assert.deepEqual((await setup.open()).get(principal()), value)
})

test('validates every principal including get and remove', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  for (const identity of [null, {}, principal('', 'bot'), principal('x'.repeat(257)), principal('bad\n'), principal('ok', 'bot', 'slack')]) {
    assert.throws(() => store.get(identity), safeError)
    await assert.rejects(store.put(identity, credential()), safeError)
    await assert.rejects(store.remove(identity, randomUUID()), safeError)
  }
})

test('validates UUID, ISO timestamps, bounded identifiers and RFC bearer tokens', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const invalid = [
    { version: 'not-a-uuid' }, { userId: '' }, { tenantId: ' ' }, { userId: 'x'.repeat(257) },
    { token: '' }, { token: 'x'.repeat(8193) }, { token: 'Bearer abc' }, { token: '中文' },
    { token: 'abc\r\n' }, { token: 'abc=def' }, { updatedAt: 'yesterday' },
    { updatedAt: '2026-02-30T00:00:00.000Z' }, { expiresAt: '2026-13-01T00:00:00Z' },
    { expiresAt: 123 }, { tenantId: 'bad\u0000id' }, { unknown: 'PASSWORD_CANARY' },
  ]
  for (const patch of invalid) await assert.rejects(store.put(principal(), credential(patch)), safeError)
  await assert.rejects(store.put(principal(), null), safeError)
  await assert.rejects(store.remove(principal(), 'invalid'), safeError)
  const value = credential({ token: 'x'.repeat(8192), expiresAt: '2026-09-30T12:30:00+08:00' })
  await store.put(principal(), value)
  assert.deepEqual(store.get(principal()), value)
})

for (const damage of ['tamper', 'wrong-key', 'missing-key', 'short-key', 'malformed-state', 'empty-state']) {
  test(`rejects ${damage}, preserves existing files and releases its own lock`, async context => {
    const setup = await fixture(context)
    const store = await setup.open()
    await store.put(principal(), credential())
    await store.close()
    const statePath = join(setup.directory, 'state.json')
    const keyPath = join(setup.directory, 'key.bin')
    const state = await readFile(statePath)
    const key = await readFile(keyPath)
    if (damage === 'tamper') {
      const text = state.toString()
      const offset = Math.floor(text.length / 2)
      await writeFile(statePath, text.slice(0, offset) + (text[offset] === 'A' ? 'B' : 'A') + text.slice(offset + 1))
    }
    if (damage === 'wrong-key') await writeFile(keyPath, randomBytes(32))
    if (damage === 'missing-key') await rm(keyPath)
    if (damage === 'short-key') await writeFile(keyPath, Buffer.alloc(31))
    if (damage === 'malformed-state') await writeFile(statePath, 'FAKE_TOKEN_CANARY_0123456789')
    if (damage === 'empty-state') await writeFile(statePath, '')
    const damagedState = await readFile(statePath)
    await assert.rejects(setup.open(), safeError)
    assert.deepEqual(await readFile(statePath), damagedState)
    if (damage === 'missing-key') await assert.rejects(lstat(keyPath), { code: 'ENOENT' })
    await writeFile(keyPath, key, { mode: 0o600 })
    await writeFile(statePath, state)
    assert.ok((await setup.open()).get(principal()))
  })
}

test('detects a wrong key even for an empty store', async context => {
  const setup = await fixture(context)
  await (await setup.open()).close()
  await writeFile(join(setup.directory, 'key.bin'), randomBytes(32))
  await assert.rejects(setup.open(), safeError)
})

test('rejects duplicate instances and conservatively retains stale locks', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  await assert.rejects(setup.open(), safeError)
  await store.put(principal(), credential())
  const names = await readdir(setup.directory)
  const lockName = names.find(name => name !== 'key.bin' && name !== 'state.json')
  assert.ok(lockName)
  const lockContents = await readFile(join(setup.directory, lockName))
  await store.close()
  await writeFile(join(setup.directory, lockName), lockContents, { mode: 0o600 })
  await assert.rejects(setup.open(), safeError)
  assert.deepEqual(await readFile(join(setup.directory, lockName)), lockContents)
})

for (const target of ['directory', 'key.bin', 'state.json']) {
  test(`rejects unsafe permissions on ${target}`, async context => {
    const setup = await fixture(context)
    await (await setup.open()).close()
    const targetPath = target === 'directory' ? setup.directory : join(setup.directory, target)
    await chmod(targetPath, target === 'directory' ? 0o755 : 0o644)
    await assert.rejects(setup.open(), safeError)
    await chmod(targetPath, target === 'directory' ? 0o700 : 0o600)
    await (await setup.open()).close()
  })
  test(`rejects symlinks on ${target}`, async context => {
    const setup = await fixture(context)
    await (await setup.open()).close()
    const targetPath = target === 'directory' ? setup.directory : join(setup.directory, target)
    const movedPath = join(setup.root, `moved-${target}`)
    await rename(targetPath, movedPath)
    await symlink(movedPath, targetPath)
    await assert.rejects(setup.open(), safeError)
    await rm(targetPath)
    await rename(movedPath, targetPath)
    await (await setup.open()).close()
  })
}

test('failed writes cannot update memory or report success; queue remains usable', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const oldValue = credential()
  await store.put(principal(), oldValue)
  const statePath = join(setup.directory, 'state.json')
  const backup = join(setup.root, 'state-backup')
  await rename(statePath, backup)
  await mkdir(statePath, { mode: 0o700 })
  await assert.rejects(store.put(principal(), credential()), safeError)
  await assert.rejects(store.remove(principal(), oldValue.version), safeError)
  assert.deepEqual(store.get(principal()), oldValue)
  await rm(statePath, { recursive: true })
  await rename(backup, statePath)
  const nextValue = credential()
  await store.put(principal(), nextValue)
  await store.close()
  assert.deepEqual((await setup.open()).get(principal()), nextValue)
})

test('rejects oversized state files without allocating or parsing their contents', async context => {
  const setup = await fixture(context)
  await (await setup.open()).close()
  await truncate(join(setup.directory, 'state.json'), 512 * 1024 * 1024)
  await assert.rejects(setup.open(), safeError)
})

test('initialization failure retains durable key and releases lock for retry', async context => {
  const setup = await fixture(context)
  await mkdir(setup.directory, { mode: 0o700 })
  await writeFile(join(setup.directory, 'key.bin'), randomBytes(32), { mode: 0o600 })
  await mkdir(join(setup.directory, 'state.json'), { mode: 0o700 })
  const key = await readFile(join(setup.directory, 'key.bin'))
  await assert.rejects(setup.open(), safeError)
  assert.deepEqual(await readFile(join(setup.directory, 'key.bin')), key)
  await rm(join(setup.directory, 'state.json'), { recursive: true })
  await (await setup.open()).close()
  assert.deepEqual(await readFile(join(setup.directory, 'key.bin')), key)
})

const idFor = identity => createHash('sha256').update(JSON.stringify([identity.platform, identity.botId, identity.senderId])).digest('hex')
function sealed(key, payload, aad) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), payload: encrypted.toString('base64') }
}
function diskRecord(key, identity, value) {
  const id = idFor(identity)
  return { id, ...sealed(key, Buffer.from(JSON.stringify({ principal: identity, credential: value })), id) }
}
async function writeState(directory, key, records) {
  const seal = sealed(key, Buffer.alloc(0), JSON.stringify(['enterprise-auth-state', 1, records]))
  await writeFile(join(directory, 'state.json'), JSON.stringify({ format: 1, records, seal }), { mode: 0o600 })
}

test('encrypts identity and credentials together with the identity hash as authenticated data', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const identity = principal()
  const value = credential()
  await store.put(identity, value)
  const key = await readFile(join(setup.directory, 'key.bin'))
  const state = JSON.parse(await readFile(join(setup.directory, 'state.json'), 'utf8'))
  const record = state.records[0]
  assert.equal(record.id, idFor(identity))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
  decipher.setAAD(Buffer.from(record.id))
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(record.payload, 'base64')), decipher.final()])
  assert.deepEqual(JSON.parse(plaintext), { principal: identity, credential: value })
})

for (const damage of ['swapped-aad', 'identity-mismatch', 'invalid-credential', 'deleted-record', 'duplicate-record']) {
  test(`rejects authenticated state with ${damage}`, async context => {
    const setup = await fixture(context)
    const store = await setup.open()
    await store.put(principal(), credential())
    await store.close()
    const key = await readFile(join(setup.directory, 'key.bin'))
    const state = JSON.parse(await readFile(join(setup.directory, 'state.json'), 'utf8'))
    if (damage === 'deleted-record') {
      state.records = []
      await writeFile(join(setup.directory, 'state.json'), JSON.stringify(state))
    } else {
      const records = state.records
      if (damage === 'swapped-aad') records[0].id = idFor(principal('other'))
      if (damage === 'identity-mismatch') {
        const identity = principal('other')
        records[0] = { id: idFor(principal()), ...sealed(key, Buffer.from(JSON.stringify({ principal: identity, credential: credential() })), idFor(principal())) }
      }
      if (damage === 'invalid-credential') records[0] = diskRecord(key, principal(), credential({ token: 'invalid\n' }))
      if (damage === 'duplicate-record') records.push(records[0])
      await writeState(setup.directory, key, records)
    }
    await assert.rejects(setup.open(), safeError)
  })
}

test('allows 10000 bindings, permits replacement at capacity and rejects additional bindings on disk or put', async context => {
  const setup = await fixture(context)
  await (await setup.open()).close()
  const key = await readFile(join(setup.directory, 'key.bin'))
  const value = credential()
  const records = Array.from({ length: 10_000 }, (_, index) => diskRecord(key, principal(`capacity-${index}`), value))
  await writeState(setup.directory, key, records)
  const full = await setup.open()
  const replacement = credential()
  await full.put(principal('capacity-0'), replacement)
  assert.deepEqual(full.get(principal('capacity-0')), replacement)
  await assert.rejects(full.put(principal('overflow'), value), error => safeError(error) && error.code === 'STORE_LIMIT')
  assert.equal(full.get(principal('overflow')), undefined)
  await full.close()
  const restarted = await setup.open()
  assert.deepEqual(restarted.get(principal('capacity-0')), replacement)
  await restarted.close()
  records.push(diskRecord(key, principal('overflow'), value))
  await writeState(setup.directory, key, records)
  await assert.rejects(setup.open(), safeError)
})

test('concurrent open grants exactly one lock without deleting the winner lock', async context => {
  const setup = await fixture(context)
  const results = await Promise.allSettled([setup.open(), setup.open(), setup.open()])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  for (const result of results) if (result.status === 'rejected') safeError(result.reason)
  await assert.rejects(setup.open(), safeError)
})

test('close refuses to remove a replacement lock belonging to someone else', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const lockPath = join(setup.directory, 'store.lock')
  await rename(lockPath, join(setup.root, 'original-lock'))
  await writeFile(lockPath, 'replacement', { mode: 0o600 })
  await assert.rejects(store.close(), safeError)
  assert.equal(await readFile(lockPath, 'utf8'), 'replacement')
})

for (const target of ['key.bin', 'state.json']) {
  test(`rejects nonregular files and hard links at ${target}`, async context => {
    const setup = await fixture(context)
    await (await setup.open()).close()
    const targetPath = join(setup.directory, target)
    const backup = join(setup.root, `backup-${target}`)
    await rename(targetPath, backup)
    await mkdir(targetPath, { mode: 0o600 })
    await assert.rejects(setup.open(), safeError)
    await rm(targetPath, { recursive: true })
    await link(backup, targetPath)
    await assert.rejects(setup.open(), safeError)
  })
}

async function handlePrototype(root) {
  const handle = await open(join(root, 'probe'), 'w', 0o600)
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  return prototype
}

test('write and fsync failures before rename preserve memory, disk and recoverable queue', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  const oldValue = credential()
  await store.put(principal(), oldValue)
  const before = await readFile(join(setup.directory, 'state.json'))
  const prototype = await handlePrototype(setup.root)
  for (const method of ['writeFile', 'sync']) {
    const fault = context.mock.method(prototype, method, async function () {
      throw new Error('FAKE_TOKEN_CANARY_0123456789 /password/path')
    })
    try {
      await assert.rejects(store.put(principal(), credential()), safeError)
      await assert.rejects(store.remove(principal(), oldValue.version), safeError)
      assert.deepEqual(store.get(principal()), oldValue)
      assert.deepEqual(await readFile(join(setup.directory, 'state.json')), before)
      assert.deepEqual((await readdir(setup.directory)).sort(), ['key.bin', 'state.json', 'store.lock'])
    } finally {
      fault.mock.restore()
    }
  }
  await store.put(principal(), credential())
})

test('directory fsync failure after rename rejects and disables access until close', async context => {
  const setup = await fixture(context)
  const store = await setup.open()
  await store.put(principal(), credential())
  const prototype = await handlePrototype(setup.root)
  const original = prototype.sync
  const fault = context.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isDirectory()) throw new Error('FAKE_TOKEN_CANARY')
    return original.call(this)
  })
  try {
    await assert.rejects(store.put(principal(), credential()), safeError)
    assert.throws(() => store.get(principal()), safeError)
    await assert.rejects(store.put(principal('next'), credential()), safeError)
  } finally {
    fault.mock.restore()
  }
  await store.close()
  await (await setup.open()).close()
})

test('failed initial key sync never publishes state and releases its own lock', async context => {
  const setup = await fixture(context)
  const prototype = await handlePrototype(setup.root)
  const original = prototype.sync
  const fault = context.mock.method(prototype, 'sync', async function () {
    const info = await this.stat()
    if (info.isFile() && info.size === 32) throw new Error('FAKE_TOKEN_CANARY')
    return original.call(this)
  })
  try {
    await assert.rejects(setup.open(), safeError)
    assert.deepEqual(await readdir(setup.directory), [])
  } finally {
    fault.mock.restore()
  }
  await (await setup.open()).close()
})

test('syncs the parent directory before the key and syncs the key before the initial state', async context => {
  const setup = await fixture(context)
  const rootInfo = await stat(setup.root)
  const prototype = await handlePrototype(setup.root)
  const original = prototype.sync
  const events = []
  const tracing = context.mock.method(prototype, 'sync', async function () {
    const info = await this.stat()
    if (info.isDirectory() && info.ino === rootInfo.ino && info.dev === rootInfo.dev) events.push('parent')
    if (info.isFile() && info.size === 32) events.push('key')
    if (info.isFile() && info.size > 32) events.push('state')
    return original.call(this)
  })
  try {
    await setup.open()
    assert.deepEqual(events, ['parent', 'key', 'state'])
  } finally {
    tracing.mock.restore()
  }
})
