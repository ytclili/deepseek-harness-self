import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { publicError } from './service.js'
import { AuthError } from './types.js'
import type { LoginInput, LoginResult } from './types.js'

export function createLoginTool(login: (exec: ToolRunContext, input: LoginInput) => Promise<LoginResult>) {
  return defineTool({
    name: 'auth_login',
    description: '登录 nextbos ERP 系统并为当前已验证的微信或飞书私聊用户保存业务授权。将用户提供的邮箱填入 account。仅使用用户明确提供的账号和密码，禁止猜测或使用历史他人凭据。不同平台的登录状态互不继承。未验证消息来源时不能登录。账号密码只传给本工具，不复述密码；工具不返回 Token。登录成功后可继续原业务操作，无权限不等于未登录。暂不支持 Token 刷新。',
    parameters: {
      account: { type: 'string', description: '用户提供的 nextbos ERP 系统邮箱账号，对应登录接口 email 字段', required: true },
      password: { type: 'string', description: '用户提供的 nextbos ERP 系统密码，不在回复中复述', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          code: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    presentCall: () => ({ card: 'generic', title: 'nextbos ERP 系统登录', kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'nextbos ERP 系统登录结果', content: result.content }),
    async execute(args, exec) {
      try {
        if (!exec.arguments || typeof exec.arguments !== 'object' || Object.keys(exec.arguments).length !== 2 || !Object.hasOwn(exec.arguments, 'account') || !Object.hasOwn(exec.arguments, 'password')) throw new AuthError('INVALID_INPUT', '登录只接受账号和密码。')
        const result = await login(exec, args)
        return { status: result.status, code: 'AUTHENTICATED', message: result.message }
      } catch (error) {
        const safe = publicError(error)
        return { status: 'failed', code: safe.code, message: safe.message }
      }
    },
  })
}
