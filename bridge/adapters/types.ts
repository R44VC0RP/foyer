import type { AccountV2, ProviderInfoV2, SaveEntry, Secret } from "../../src/shared/protocol"
import type { PasskeyRecord } from "../webauthn"

export type Secrets = { username?: string; password?: string; totp?: string }

export interface SaveResult {
  ref: string
  created: boolean
}

export interface StoredPasskey {
  ref: string
  /** Whether this provider verified the user (biometrics, unlocked vault...). Sets the UV flag. */
  userVerified: boolean
}

export interface LoadedPasskey {
  record: PasskeyRecord
  userVerified: boolean
}

/**
 * Every password manager plugs in through this interface. Adapters must only
 * return accounts whose saved URLs (or passkey rpId) match `domain`, and must
 * refuse (throw ProviderError "domain_mismatch") a fill, update or passkey
 * load for an item that doesn't match.
 *
 * The optional methods are only called when info().capabilities includes the
 * matching capability ("save"/"sso" for save, "passkeys" for passkeys).
 */
export interface Adapter {
  readonly id: string
  readonly name: string
  /** Per-call timeout the bridge applies to each adapter call. */
  readonly timeoutMs: number
  /**
   * Whether this provider verifies the user before releasing a passkey
   * (biometrics, vault unlock). undefined = only known after the call (command
   * providers). Registrations that require user verification are refused up
   * front when this is false.
   */
  readonly verifiesUser?: boolean
  info(): Promise<ProviderInfoV2>
  list(domain: string, origin: string): Promise<AccountV2[]>
  fill(ref: string, domain: string, origin: string, want: Secret[]): Promise<Secrets>
  /** Create an item, or with `ref` update that item's password (after checking its URLs match `domain`). */
  save?(domain: string, origin: string, entry: SaveEntry, ref?: string): Promise<SaveResult>
  /** Store a new Foyer passkey. `domain` is the rpId. */
  storePasskey?(record: PasskeyRecord): Promise<StoredPasskey>
  /** Load a Foyer passkey; must refuse unless the stored rpId equals `rpId`. */
  loadPasskey?(ref: string, rpId: string): Promise<LoadedPasskey>
}
