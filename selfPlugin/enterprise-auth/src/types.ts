export type Principal = {
  platform: 'weixin' | 'feishu'
  botId: string
  senderId: string
}

export type Credential = {
  version: string
  userId: string
  tenantId: string
  token: string
  expiresAt: string | null
  updatedAt: string
}

export type CredentialStore = {
  get(principal: Principal): Credential | undefined
  put(principal: Principal, credential: Credential): Promise<void>
  remove(principal: Principal, version: string): Promise<void>
  close(): Promise<void>
}

export type LoginInput = { account: string; password: string }
export type LoginIdentity = Pick<Credential, 'userId' | 'tenantId' | 'token' | 'expiresAt'>
export type ApiRequest = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body?: unknown; idempotencyKey?: string }
export type AuthBackend = {
  login(input: LoginInput, signal: AbortSignal): Promise<LoginIdentity>
  request(input: ApiRequest, token: string, signal: AbortSignal): Promise<unknown>
}

export type LoginResult = { status: 'authenticated'; message: string }
export type AuthService = {
  login(principal: Principal, input: LoginInput, signal: AbortSignal): Promise<LoginResult>
  request(principal: Principal, input: ApiRequest, signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

export class AuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EnterpriseAuthError'
  }
}

export function validatePrincipal(value: Principal): void {
  if (!value || !['weixin', 'feishu'].includes(value.platform) || [value.botId, value.senderId].some(item => typeof item !== 'string' || !item.trim() || item.length > 256 || /[\x00-\x1f\x7f]/.test(item))) {
    throw new AuthError('IDENTITY_REQUIRED', '无法确认消息发送者，请通过已接入的机器人私聊操作。')
  }
}
