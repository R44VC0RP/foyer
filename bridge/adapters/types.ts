import type { Account, ProviderInfo, Secret } from "../../src/shared/protocol"

export type Secrets = { username?: string; password?: string; totp?: string }

/**
 * Every password manager plugs in through this interface. Adapters must only
 * return accounts whose saved URLs match `domain`, and must refuse (throw
 * ProviderError "domain_mismatch") a fill for an item that doesn't match.
 */
export interface Adapter {
  readonly id: string
  readonly name: string
  /** Per-call timeout the bridge applies to list/fill. */
  readonly timeoutMs: number
  info(): Promise<ProviderInfo>
  list(domain: string, origin: string): Promise<Account[]>
  fill(ref: string, domain: string, origin: string, want: Secret[]): Promise<Secrets>
}
