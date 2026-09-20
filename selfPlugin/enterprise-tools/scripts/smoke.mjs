import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as EnterpriseTools from '../dist/index.js'

if (!process.env.ENTERPRISE_TOKEN_FILE) throw new Error('请配置 ENTERPRISE_TOKEN_FILE（凭证文件的绝对路径）。')
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(EnterpriseTools, {
    baseUrl: process.env.ENTERPRISE_API_BASE_URL ?? 'http://127.0.0.1:5002',
    tokenFile: process.env.ENTERPRISE_TOKEN_FILE,
  })
  const assembly = await ctx.systemPrompt.assemble()
  if (!assembly.tools.some(tool => tool.name === 'goods_list')) throw new Error('goods_list 未出现在模型工具列表中。')
  const result = await ctx.tools.execute({ callId: ToolCallId('enterprise-smoke'), name: 'goods_list', arguments: {}, signal: new AbortController().signal })
  if (result.isError) {
    console.error(JSON.stringify({ ok: false, content: result.content }))
    process.exitCode = 1
  } else {
    console.log(JSON.stringify({ ok: true, tool: 'goods_list', total: result.value.total, returned_count: result.value.returned_count, has_more: result.value.has_more }))
  }
} finally {
  await ctx.fiber.dispose()
}
