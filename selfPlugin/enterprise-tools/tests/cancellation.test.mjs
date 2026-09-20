import assert from 'node:assert/strict'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as EnterpriseTools from '../dist/index.js'

test('credential read timeout and plugin unload settle before filesystem resumes, then close handles without HTTP', { timeout: 5000 }, async t => {
  for (const reason of ['timeout', 'unload']) {
    await t.test(reason, async subtest => {
      const directory = await fsPromises.mkdtemp(join(tmpdir(), 'enterprise-cancel-'))
      const tokenFile = join(directory, 'test.token')
      await fsPromises.writeFile(tokenFile, 'fake-token', { mode: 0o600 })
      const ctx = new Context()
      let release
      const blocked = new Promise(resolve => { release = resolve })
      let started
      const reading = new Promise(resolve => { started = resolve })
      let closed
      const cleanup = new Promise(resolve => { closed = resolve })
      const originalOpen = fsPromises.open
      subtest.mock.method(fsPromises, 'open', async (...args) => {
        started()
        await blocked
        const handle = await originalOpen(...args)
        const originalClose = handle.close.bind(handle)
        handle.close = async () => { await originalClose(); closed() }
        return handle
      })
      syncBuiltinESMExports()
      const fetchMock = subtest.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 200, data: { items: [], total: 0 } })))
      subtest.after(async () => {
        release()
        subtest.mock.restoreAll()
        syncBuiltinESMExports()
        await ctx.fiber.dispose()
        await fsPromises.rm(directory, { recursive: true, force: true })
      })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const fiber = ctx.plugin(EnterpriseTools, { tokenFile, timeoutMs: reason === 'timeout' ? 30 : 10000 })
      await fiber
      const pending = ctx.tools.execute({ callId: ToolCallId('cancel-test'), name: 'goods_list', arguments: {}, signal: new AbortController().signal })
      await reading
      const stopped = reason === 'unload' ? fiber.dispose() : Promise.resolve()
      const outcome = await Promise.race([
        Promise.all([pending, stopped]).then(([result]) => result),
        delay(250).then(() => 'did-not-cancel'),
      ])
      release()
      await pending
      await cleanup
      assert.notEqual(outcome, 'did-not-cancel')
      assert.equal(outcome.isError, true)
      assert.match(JSON.stringify(outcome.content), reason === 'timeout' ? /超时/ : /取消/)
      assert.equal(fetchMock.mock.callCount(), 0)
    })
  }
})
