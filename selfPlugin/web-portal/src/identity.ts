import { createHash } from 'node:crypto'
import type { LoginIdentity } from './contracts.js'

export function identityKey(identity: Pick<LoginIdentity, 'tenantId' | 'userId'>): string {
  return createHash('sha256').update(JSON.stringify([identity.tenantId, identity.userId])).digest('hex')
}
