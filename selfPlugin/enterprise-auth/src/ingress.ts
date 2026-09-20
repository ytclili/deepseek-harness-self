import { AuthError, validatePrincipal } from './types.js'
import type { Principal } from './types.js'

export type IngressRegistry = {
  register(input: { sessionId: string; rpcId: string; principal: Principal }): () => void
  observe(session: unknown, event: unknown): void
  resolve(exec: unknown): Principal
  isVerifiedStep(session: unknown, turn: number, step: number, messages: readonly unknown[]): boolean
  close(): void
}

type Registration = {
  key: string
  sessionId: string
  principal: Principal
  createdAt: number
  expiresAt: number
  revoked: boolean
  owner: TurnState | undefined
}

type TurnState = {
  sessionId: string
  seq: number
  turn: number | undefined
  lastTurn: number
  step: number
  lastStep: number
  acceptingInput: boolean
  blocked: boolean
  calls: Set<string>
  registrations: Set<Registration>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function sessionIdentity(session: Record<string, unknown>): string | undefined {
  const header = record(session.header)
  if (!header || !identifier(header.id)
    || (session.id !== undefined && session.id !== header.id)
    || (header.isSeeded !== undefined && header.isSeeded !== false)
    || header.parentSession !== undefined || header.origin !== undefined
    || (header.delegationDepth !== undefined && header.delegationDepth !== 0)
    || (session.inheritedEventCount !== undefined && session.inheritedEventCount !== 0)
    || (session.firstLiveSeq !== undefined && !integer(session.firstLiveSeq))) return undefined
  return header.id
}

function identityRequired(): AuthError {
  return new AuthError('IDENTITY_REQUIRED', '无法确认本轮工具调用的可信私聊身份。')
}

function samePrincipal(left: Principal, right: Principal): boolean {
  return left.platform === right.platform && left.botId === right.botId && left.senderId === right.senderId
}

function isHostContext(source: Record<string, unknown>): boolean {
  return source.kind === 'plugin' && identifier(source.plugin)
    && (source.form === 'instructions' || source.form === 'notice' || source.form === 'snapshot')
}

export function createIngressRegistry(options: { ttlMs: number; maxPending: number }): IngressRegistry {
  if (!options || !integer(options.ttlMs, 1) || !integer(options.maxPending, 1)) {
    throw new AuthError('INVALID_INPUT', '身份登记有效期和数量上限必须为正整数。')
  }
  const { ttlMs, maxPending } = options
  const registrations = new Map<string, Registration>()
  let sessions = new WeakMap<object, TurnState>()
  let closed = false
  let lastTime = Date.now()

  function invalidate(state: TurnState): void {
    state.blocked = true
    state.acceptingInput = false
    state.calls.clear()
    for (const registration of state.registrations) {
      registration.revoked = true
      registration.owner = undefined
      if (registrations.get(registration.key) === registration) registrations.delete(registration.key)
    }
    state.registrations.clear()
  }

  function release(registration: Registration): void {
    if (registration.revoked) return
    registration.revoked = true
    if (registrations.get(registration.key) === registration) registrations.delete(registration.key)
    if (registration.owner) invalidate(registration.owner)
  }

  function loseSession(state: TurnState): void {
    invalidate(state)
    for (const registration of registrations.values()) {
      if (registration.sessionId === state.sessionId) release(registration)
    }
  }

  function prune(): number {
    const now = Date.now()
    for (const registration of registrations.values()) {
      if (now < lastTime || now < registration.createdAt || now >= registration.expiresAt) release(registration)
    }
    lastTime = now
    return now
  }

  function assertOpen(): void {
    if (closed) throw new AuthError('CLOSED', '身份接入服务已停止。')
  }

  function observeSessionEvent(sessionValue: unknown, eventValue: unknown): void {
    if (closed) return
    prune()
    const session = record(sessionValue)
    if (!session) return
    let state = sessions.get(session)
    const sessionId = sessionIdentity(session)
    const event = record(eventValue)
    if (!sessionId || !event || !integer(event.seq) || typeof event.type !== 'string'
      || (integer(session.firstLiveSeq) && event.seq < session.firstLiveSeq)) {
      if (state) loseSession(state)
      return
    }
    if (!state) {
      state = {
        sessionId, seq: event.seq - 1, turn: undefined, lastTurn: 0, step: 0, lastStep: 0,
        blocked: true, acceptingInput: false, calls: new Set(), registrations: new Set(),
      }
      sessions.set(session, state)
    }
    if (state.sessionId !== sessionId || event.seq !== state.seq + 1) {
      loseSession(state)
      state.seq = Math.max(state.seq, event.seq)
      return
    }
    state.seq = event.seq
    const data = record(event.data)
    switch (event.type) {
      case 'turn/start': {
        if (!data || !integer(data.turn, 1) || state.turn !== undefined || data.turn <= state.lastTurn) {
          invalidate(state)
          return
        }
        invalidate(state)
        state.turn = data.turn
        state.lastTurn = data.turn
        state.step = 0
        state.lastStep = 0
        state.blocked = false
        return
      }
      case 'turn/end': {
        invalidate(state)
        state.turn = undefined
        state.step = 0
        return
      }
      case 'step/start': {
        state.calls.clear()
        if (!data || state.turn === undefined || data.turn !== state.turn
          || !integer(data.step, 1) || state.step !== 0 || data.step !== state.lastStep + 1) {
          invalidate(state)
          return
        }
        state.step = data.step
        state.lastStep = data.step
        state.acceptingInput = true
        return
      }
      case 'step/end': {
        state.calls.clear()
        state.acceptingInput = false
        if (!data || state.turn === undefined || data.turn !== state.turn || state.step === 0 || data.step !== state.step) {
          invalidate(state)
        }
        state.step = 0
        return
      }
      case 'user/message': {
        const source = record(data?.source)
        const registration = source?.kind === 'user' && identifier(source.rpcId)
          ? registrations.get(JSON.stringify([sessionId, source.rpcId]))
          : undefined
        if (!data || data.role !== 'user' || !source || state.turn === undefined || state.step === 0
          || !state.acceptingInput || event.surfaceOp !== 'append') {
          if (registration) release(registration)
          invalidate(state)
          return
        }
        if (isHostContext(source)) return
        if (!registration || registration.revoked || registration.owner) {
          invalidate(state)
          return
        }
        const existing = state.registrations.values().next().value
        if (state.blocked || (existing && !samePrincipal(existing.principal, registration.principal))) {
          release(registration)
          invalidate(state)
          return
        }
        registration.owner = state
        state.registrations.add(registration)
        return
      }
      case 'assistant/message': {
        state.calls.clear()
        state.acceptingInput = false
        const message = record(data?.message)
        if (!data || state.turn === undefined || data.turn !== state.turn || state.step === 0
          || data.step !== state.step || data.interrupted === true || message?.role !== 'assistant'
          || !Array.isArray(message.content) || event.surfaceOp !== 'append') {
          invalidate(state)
          return
        }
        if (state.blocked) return
        for (const value of message.content) {
          const block = record(value)
          if (block?.type !== 'tool-call') continue
          if (!identifier(block.id) || state.calls.has(block.id)) {
            invalidate(state)
            return
          }
          state.calls.add(block.id)
        }
        return
      }
    }
  }

  return {
    register(input) {
      assertOpen()
      const now = prune()
      if (!input || !identifier(input.sessionId) || !identifier(input.rpcId) || !Number.isSafeInteger(now + ttlMs)) {
        throw new AuthError('INVALID_INPUT', '身份登记需要有效的会话和请求标识。')
      }
      validatePrincipal(input.principal)
      const key = JSON.stringify([input.sessionId, input.rpcId])
      if (registrations.has(key)) throw new AuthError('INVALID_INPUT', '该身份请求已登记。')
      if (registrations.size >= maxPending) throw new AuthError('RATE_LIMITED', '身份登记数量已达到上限。')
      const registration: Registration = {
        key, sessionId: input.sessionId,
        principal: Object.freeze({ platform: input.principal.platform, botId: input.principal.botId, senderId: input.principal.senderId }),
        createdAt: now, expiresAt: now + ttlMs, revoked: false, owner: undefined,
      }
      registrations.set(key, registration)
      return () => release(registration)
    },
    observe: observeSessionEvent,
    // Preview the next batch for model guidance only. Authorization still
    // requires the durable input and assistant tool-call events in resolve().
    isVerifiedStep(sessionValue, turn, step, messages) {
      if (closed) return false
      prune()
      const session = record(sessionValue)
      const state = session && sessions.get(session)
      if (!session || !state || state.sessionId !== sessionIdentity(session)
        || state.blocked || state.turn !== turn || state.step !== 0
        || step !== state.lastStep + 1) return false
      let principal = state.registrations.values().next().value?.principal
      const seen = new Set<Registration>()
      for (const value of messages) {
        const message = record(value)
        const source = record(message?.source)
        if (message?.role !== 'user' || !source) return false
        if (isHostContext(source)) continue
        const registration = source.kind === 'user' && identifier(source.rpcId)
          ? registrations.get(JSON.stringify([state.sessionId, source.rpcId])) : undefined
        if (!registration || registration.revoked || registration.owner || seen.has(registration)
          || (principal && !samePrincipal(principal, registration.principal))) return false
        seen.add(registration)
        principal = registration.principal
      }
      return principal !== undefined
    },
    resolve(execValue) {
      assertOpen()
      prune()
      const exec = record(execValue)
      const session = record(record(exec?.agent)?.session)
      const state = session && sessions.get(session)
      const rootCallId = exec?.rootCallId ?? exec?.callId
      if (!session || !state || state.sessionId !== sessionIdentity(session)
        || state.blocked || state.turn === undefined || state.step === 0
        || !identifier(rootCallId) || !state.calls.has(rootCallId)
        || record(exec?.signal)?.aborted === true) throw identityRequired()
      const registration = state.registrations.values().next().value
      if (!registration || registration.revoked || registration.owner !== state) throw identityRequired()
      return registration.principal
    },
    close() {
      if (closed) return
      closed = true
      for (const registration of registrations.values()) release(registration)
      registrations.clear()
      sessions = new WeakMap()
    },
  }
}
