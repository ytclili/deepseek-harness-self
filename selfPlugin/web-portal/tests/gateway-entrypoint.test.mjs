import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runGatewayEntrypoint } from '../scripts/gateway-entrypoint.mjs'

test('gateway uses built dsh profile with only explicit proxy environment and disposes signal handlers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'portal-gateway-entry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const child = new EventEmitter(), signals = new EventEmitter()
  child.kill = () => true
  let call
  const code = await runGatewayEntrypoint({ root, appRoot: '/fixture/app', processSignals: signals,
    environment: { PORTAL_PORT: '23080', HTTPS_PROXY: 'http://127.0.0.1:8080', NO_PROXY: 'localhost,127.0.0.1', PRIVATE_KEY: 'never-inherit', NODE_OPTIONS: '--inspect' },
    spawnProcess: (...args) => { call = args; queueMicrotask(() => child.emit('exit', 0, null)); return child },
  })
  assert.equal(code, 0)
  assert.deepEqual(call[1], ['/fixture/app/apps/cli/lib/bin.js', '--profile', 'portal'])
  assert.equal(call[2].env.HTTPS_PROXY, 'http://127.0.0.1:8080')
  assert.equal(call[2].env.NO_PROXY, 'localhost,127.0.0.1')
  assert.equal(call[2].env.NODE_USE_ENV_PROXY, '1')
  assert.equal(call[2].env.PRIVATE_KEY, undefined)
  assert.equal(call[2].env.NODE_OPTIONS, undefined)
  assert.equal(call[2].env.PORTAL_CONFIG_FILE, join(root, 'config.json'))
  const manifest = JSON.parse(await readFile(join(root, '.dsh/profiles/portal/package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['dsh-web-portal'])
  assert.equal(signals.listenerCount('SIGTERM'), 0)
})
