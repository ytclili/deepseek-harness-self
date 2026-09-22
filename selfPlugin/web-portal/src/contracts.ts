/** Identity returned by the enterprise login adapter; never accepted from browser input. */
export interface LoginIdentity {
  tenantId: string
  userId: string
  token: string
  expiresAt: string | null
}

/** Internal destination reachable only by the gateway. Never serialize it to clients. */
export interface UserRuntime {
  origin: string
  cookie: string
}

/** One isolated environment per verified tenant/user pair. */
export interface RuntimeManager {
  ensure(identity: LoginIdentity, signal: AbortSignal): Promise<UserRuntime>
  stop(identityKey: string): Promise<void>
  close(): Promise<void>
}
