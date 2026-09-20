import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { AuthError, validatePrincipal } from './types.js'
import type { Credential, CredentialStore, Principal } from './types.js'

const MAX_BINDINGS = 10_000
const MAX_STATE_BYTES = 192 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 24 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

type Binding = { principal: Principal; credential: Credential }
type Encrypted = { iv: string; tag: string; payload: string }
type DiskRecord = Encrypted & { id: string }
type State = { format: 1; records: DiskRecord[]; seal: Encrypted }

function failure(code: 'STORE_INVALID' | 'STORE_IO' | 'STORE_LOCKED' | 'STORE_CLOSED' | 'STORE_LIMIT' | 'CREDENTIAL_INVALID'): AuthError {
  const messages = {
    STORE_INVALID: '凭据存储校验失败，请联系管理员。',
    STORE_IO: '凭据存储操作失败，请稍后重试。',
    STORE_LOCKED: '凭据存储已被占用，请联系管理员。',
    STORE_CLOSED: '凭据存储已关闭。',
    STORE_LIMIT: '凭据绑定数量已达上限。',
    CREDENTIAL_INVALID: '凭据格式无效，请重新登录。',
  }
  return new AuthError(code, messages[code])
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code
}

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  const date = new Date(value)
  const calendar = value.slice(0, 10)
  return Number.isFinite(date.getTime()) && new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) === calendar
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60
}

function snapshotPrincipal(value: Principal): Principal {
  try {
    validatePrincipal(value)
    const result = { platform: value.platform, botId: value.botId, senderId: value.senderId }
    validatePrincipal(result)
    return result
  } catch {
    throw new AuthError('IDENTITY_REQUIRED', '无法确认消息发送者，请通过已接入的机器人私聊操作。')
  }
}

function snapshotCredential(value: unknown): Credential {
  try {
    if (!objectWithKeys(value, ['version', 'userId', 'tenantId', 'token', 'expiresAt', 'updatedAt'])) throw failure('CREDENTIAL_INVALID')
    const result = { ...value }
    if (typeof result.version !== 'string' || !UUID.test(result.version)
      || !validIdentifier(result.userId) || !validIdentifier(result.tenantId)
      || typeof result.token !== 'string' || result.token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(result.token)
      || !validDate(result.updatedAt) || !(result.expiresAt === null || validDate(result.expiresAt))) throw failure('CREDENTIAL_INVALID')
    return result as Credential
  } catch {
    throw failure('CREDENTIAL_INVALID')
  }
}

function bindingId(principal: Principal): string {
  return createHash('sha256').update(JSON.stringify([principal.platform, principal.botId, principal.senderId])).digest('hex')
}

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Encrypted {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const payload = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), payload: payload.toString('base64') }
}

function decode(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4) throw failure('STORE_INVALID')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw failure('STORE_INVALID')
  return bytes
}

function decrypt(key: Buffer, encrypted: Record<string, unknown>, aad: Buffer): Buffer {
  const iv = decode(encrypted.iv, 12)
  const tag = decode(encrypted.tag, 16)
  if (iv.length !== 12 || tag.length !== 16) throw failure('STORE_INVALID')
  const cipher = createDecipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  cipher.setAuthTag(tag)
  return Buffer.concat([cipher.update(decode(encrypted.payload, MAX_PAYLOAD_BYTES)), cipher.final()])
}

function manifest(records: DiskRecord[]): Buffer {
  return Buffer.from(JSON.stringify(['enterprise-auth-state', 1, records]))
}

function encodeState(key: Buffer, bindings: Map<string, Binding>): Buffer {
  const records = Array.from(bindings, ([id, binding]) => ({
    id, ...encrypt(key, Buffer.from(JSON.stringify(binding)), Buffer.from(id)),
  }))
  const state: State = { format: 1, records, seal: encrypt(key, Buffer.alloc(0), manifest(records)) }
  const bytes = Buffer.from(JSON.stringify(state))
  if (bytes.length > MAX_STATE_BYTES) throw failure('STORE_LIMIT')
  return bytes
}

function decodeState(key: Buffer, bytes: Buffer): Map<string, Binding> {
  try {
    const state: unknown = JSON.parse(bytes.toString('utf8'))
    if (!objectWithKeys(state, ['format', 'records', 'seal']) || state.format !== 1
      || !Array.isArray(state.records) || state.records.length > MAX_BINDINGS
      || !objectWithKeys(state.seal, ['iv', 'tag', 'payload']) || state.seal.payload !== '') throw failure('STORE_INVALID')
    decrypt(key, state.seal, manifest(state.records))
    const bindings = new Map<string, Binding>()
    for (const record of state.records) {
      if (!objectWithKeys(record, ['id', 'iv', 'tag', 'payload']) || typeof record.id !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.id) || bindings.has(record.id)) throw failure('STORE_INVALID')
      const plaintext = decrypt(key, record, Buffer.from(record.id))
      let binding: unknown
      try {
        binding = JSON.parse(plaintext.toString('utf8'))
      } finally {
        plaintext.fill(0)
      }
      if (!objectWithKeys(binding, ['principal', 'credential']) || !objectWithKeys(binding.principal, ['platform', 'botId', 'senderId'])) throw failure('STORE_INVALID')
      const principal = snapshotPrincipal(binding.principal as Principal)
      const credential = snapshotCredential(binding.credential)
      if (bindingId(principal) !== record.id) throw failure('STORE_INVALID')
      bindings.set(record.id, { principal, credential })
    }
    return bindings
  } catch {
    throw failure('STORE_INVALID')
  }
}

function validateStat(info: Stats, directory = false): void {
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    || (info.mode & 0o7777) !== (directory ? 0o700 : 0o600)
    || (process.getuid && info.uid !== process.getuid())) throw failure('STORE_INVALID')
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

async function readPrivate(file: string, limit: number): Promise<Buffer | undefined> {
  let handle: FileHandle
  try {
    handle = await open(file, READ_FLAGS)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined
    throw failure('STORE_INVALID')
  }
  try {
    const info = await handle.stat()
    validateStat(info)
    if (info.size > limit || info.size === 0) throw failure('STORE_INVALID')
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset !== info.size || (await handle.stat()).size !== info.size) throw failure('STORE_INVALID')
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

export async function openCredentialStore(options: { directory: string }): Promise<CredentialStore> {
  let directoryHandle: FileHandle | undefined
  let lockHandle: FileHandle | undefined
  let key: Buffer | undefined
  let directory = ''
  let lockPath = ''
  let directoryInfo: Stats

  async function checkDirectory(): Promise<void> {
    const current = await lstat(directory)
    validateStat(current, true)
    if (!sameFile(current, directoryInfo)) throw failure('STORE_INVALID')
  }

  async function release(): Promise<void> {
    let failed = false
    if (lockHandle) {
      try {
        await checkDirectory()
        const owned = await lockHandle.stat()
        const current = await lstat(lockPath)
        if (!sameFile(owned, current) || !current.isFile()) throw failure('STORE_INVALID')
        await unlink(lockPath)
        await directoryHandle!.sync()
      } catch {
        failed = true
      } finally {
        await lockHandle.close().catch(() => { failed = true })
        lockHandle = undefined
      }
    }
    if (directoryHandle) {
      await directoryHandle.close().catch(() => { failed = true })
      directoryHandle = undefined
    }
    key?.fill(0)
    if (failed) throw failure('STORE_IO')
  }

  let uncertain = false
  async function atomicWrite(name: string, bytes: Buffer): Promise<void> {
    await checkDirectory()
    const temporary = join(directory, `.tmp-${randomBytes(16).toString('hex')}`)
    const destination = join(directory, name)
    let handle: FileHandle | undefined
    let created = false
    let renamed = false
    try {
      handle = await open(temporary, CREATE_FLAGS, 0o600)
      created = true
      await handle.chmod(0o600)
      validateStat(await handle.stat())
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      await checkDirectory()
      try {
        const existing = await lstat(destination)
        validateStat(existing)
        if (name === 'key.bin') throw failure('STORE_INVALID')
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error
      }
      await rename(temporary, destination)
      renamed = true
      await directoryHandle!.sync()
    } catch {
      if (renamed) uncertain = true
      throw failure('STORE_IO')
    } finally {
      await handle?.close().catch(() => {})
      if (created && !renamed) await unlink(temporary).catch(() => {})
    }
  }

  try {
    if (!options || typeof options.directory !== 'string' || !options.directory.trim() || options.directory.includes('\0')) throw failure('STORE_INVALID')
    directory = resolve(options.directory)
    lockPath = join(directory, 'store.lock')
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error
    }
    directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    directoryInfo = await directoryHandle.stat()
    validateStat(directoryInfo, true)
    await checkDirectory()
    const parentHandle = await open(await realpath(dirname(directory)), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await parentHandle.sync()
    } finally {
      await parentHandle.close()
    }
    try {
      lockHandle = await open(lockPath, CREATE_FLAGS, 0o600)
    } catch (error) {
      if (isCode(error, 'EEXIST')) throw failure('STORE_LOCKED')
      throw error
    }
    await lockHandle.chmod(0o600)
    validateStat(await lockHandle.stat())
    await lockHandle.sync()
    await directoryHandle.sync()
    const state = await readPrivate(join(directory, 'state.json'), MAX_STATE_BYTES)
    key = await readPrivate(join(directory, 'key.bin'), 32)
    if (key && key.length !== 32) throw failure('STORE_INVALID')
    if (!key) {
      if (state) throw failure('STORE_INVALID')
      key = randomBytes(32)
      await atomicWrite('key.bin', key)
    }
    const encryptionKey = key
    let bindings = state ? decodeState(encryptionKey, state) : new Map<string, Binding>()
    if (!state) await atomicWrite('state.json', encodeState(encryptionKey, bindings))
    let tail: Promise<void> = Promise.resolve()
    let closing: Promise<void> | undefined

    function assertOpen(): void {
      if (closing) throw failure('STORE_CLOSED')
      if (uncertain) throw failure('STORE_IO')
    }

    function enqueue(change: () => Promise<void>): Promise<void> {
      assertOpen()
      const pending = tail.then(async () => {
        if (uncertain) throw failure('STORE_IO')
        await change()
      })
      tail = pending.catch(() => {})
      return pending
    }

    return {
      get(principal) {
        assertOpen()
        const identity = snapshotPrincipal(principal)
        const credential = bindings.get(bindingId(identity))?.credential
        return credential ? { ...credential } : undefined
      },
      async put(principal, credential) {
        assertOpen()
        const identity = snapshotPrincipal(principal)
        const value = snapshotCredential(credential)
        const id = bindingId(identity)
        return enqueue(async () => {
          if (!bindings.has(id) && bindings.size >= MAX_BINDINGS) throw failure('STORE_LIMIT')
          const next = new Map(bindings)
          next.set(id, { principal: identity, credential: value })
          try {
            await atomicWrite('state.json', encodeState(encryptionKey, next))
          } catch {
            throw failure('STORE_IO')
          }
          bindings = next
        })
      },
      async remove(principal, version) {
        assertOpen()
        const identity = snapshotPrincipal(principal)
        if (typeof version !== 'string' || !UUID.test(version)) throw failure('CREDENTIAL_INVALID')
        const id = bindingId(identity)
        return enqueue(async () => {
          if (bindings.get(id)?.credential.version !== version) return
          const next = new Map(bindings)
          next.delete(id)
          try {
            await atomicWrite('state.json', encodeState(encryptionKey, next))
          } catch {
            throw failure('STORE_IO')
          }
          bindings = next
        })
      },
      close() {
        if (!closing) closing = tail.then(async () => {
          bindings.clear()
          await release()
        })
        return closing
      },
    }
  } catch (error) {
    await release().catch(() => {})
    if (error instanceof AuthError) throw error
    throw failure('STORE_IO')
  }
}
