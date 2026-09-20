import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as EnterpriseTools from '../dist/index.js'

test('real Cordis plugin exposes schema, executes, renders failures and unregisters on dispose', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-registry-'))
  const tokenFile = join(directory, 'test.token')
  const canary = 'registry-secret-canary'
  await writeFile(tokenFile, canary, { mode: 0o600 })
  let unauthorized = false
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${canary}`)
    if (unauthorized) {
      response.writeHead(401)
      response.end(canary)
    } else {
      response.end(JSON.stringify({ code: 200, data: { items: [], total: 0 } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ctx = new Context()
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = ctx.plugin(EnterpriseTools, { baseUrl: `http://127.0.0.1:${server.address().port}`, tokenFile })
  await fiber
  const assembly = await ctx.systemPrompt.assemble()
  assert.equal(assembly.tools.filter(tool => tool.name === 'goods_list').length, 1)
  assert.equal(JSON.stringify(assembly).includes(canary), false)
  assert.equal(JSON.stringify(assembly.tools).includes(tokenFile), false)
  const execute = argumentsValue => ctx.tools.execute({ callId: ToolCallId('goods-test'), name: 'goods_list', arguments: argumentsValue, signal: new AbortController().signal })
  const success = await execute({})
  assert.equal(success.isError, false)
  assert.deepEqual(success.value, { items: [], total: 0, returned_count: 0, has_more: false })
  assert.deepEqual(JSON.parse(success.content[0].text), success.value)
  unauthorized = true
  const failure = await execute({})
  assert.equal(failure.isError, true)
  assert.match(JSON.stringify(failure.content), /401/)
  assert.equal(JSON.stringify(failure).includes(canary), false)
  const invalid = await execute({ token: canary })
  assert.equal(invalid.isError, true)
  assert.equal(JSON.stringify(invalid).includes(canary), false)
  await fiber.dispose()
  assert.equal(ctx.tools.schemas().some(tool => tool.name === 'goods_list'), false)
})
