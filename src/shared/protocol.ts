// Foyer Provider Protocol, version 1.
//
// How Foyer talks to password managers. The extension sends requests to the
// local bridge (native messaging host "dev.foyer.bridge"), which fans out to
// provider adapters (1Password CLI, Bitwarden CLI, any command that speaks
// this protocol, a demo vault). See docs/PROVIDERS.md.
//
// Rules every side follows:
// - Account lists carry metadata only. Secrets travel only in a FillResponse,
//   only for an account the user picked, and are never written to disk.
// - The extension decides the domain from the browser's own record of the
//   frame URL, never from page content. Providers must only return accounts
//   whose saved URLs match that domain, and must refuse a fill for an account
//   that doesn't match it.

export const PROTOCOL_VERSION = 1
export const NATIVE_HOST = "dev.foyer.bridge"

export interface ProviderInfo {
  /** Stable id from bridge config, e.g. "1password", "bitwarden", "demo". */
  id: string
  name: string
  status: "ready" | "locked" | "unavailable"
  /** Human-readable reason when not ready, e.g. "op not found". */
  detail?: string
}

export interface Account {
  provider: string
  /** Opaque reference understood only by that provider (item id). */
  ref: string
  title: string
  /** Shown in the menu so the user can tell accounts apart. Never stored by Foyer. */
  username?: string
  hasPassword: boolean
  hasTotp: boolean
}

export type Secret = "username" | "password" | "totp"

// ---- Requests (extension -> bridge -> adapter) -------------------------------

export type Request =
  | { id: string; type: "hello"; protocol: number; client: string }
  | { id: string; type: "list"; domain: string; origin: string }
  | { id: string; type: "fill"; provider: string; ref: string; domain: string; origin: string; want: Secret[] }

// ---- Responses ----------------------------------------------------------------

export interface HelloResponse {
  id: string
  type: "hello"
  protocol: number
  bridge: string
  providers: ProviderInfo[]
}

export interface ListResponse {
  id: string
  type: "list"
  accounts: Account[]
  /** Providers that failed or are locked, so the UI can say why a list is short. */
  errors?: Array<{ provider: string; message: string }>
}

export interface FillResponse {
  id: string
  type: "fill"
  username?: string
  password?: string
  totp?: string
}

export interface ErrorResponse {
  id: string
  type: "error"
  code: "bad_request" | "unknown_provider" | "not_found" | "domain_mismatch" | "locked" | "provider_error" | "protocol"
  message: string
}

export type Response = HelloResponse | ListResponse | FillResponse | ErrorResponse

// ---- Version 1, part 2: writing back, passkeys and sign-in methods -----------
//
// Providers advertise what they support in ProviderInfo.capabilities. Account
// lists may include passkeys and saved sign-in methods next to passwords.

export type Capability = "list" | "fill" | "save" | "passkeys" | "sso"

export type AccountKind = "password" | "passkey" | "sso"

export interface AccountV2 extends Account {
  /** Defaults to "password" when absent. */
  kind?: AccountKind
  /** Passkeys: relying party id and base64url credential id. */
  rpId?: string
  credentialId?: string
  /** Sign-in methods: which provider button to use, e.g. "google". */
  sso?: string
}

export interface ProviderInfoV2 extends ProviderInfo {
  capabilities?: Capability[]
}

export type SaveEntry =
  | { kind: "password"; title: string; url: string; username: string; password: string }
  | { kind: "sso"; title: string; url: string; sso: string; username?: string }

export type RequestV2 =
  | Request
  /** Compare a submitted login with saved ones without revealing anything. */
  | { id: string; type: "check"; domain: string; origin: string; username: string; password: string }
  /** Create a new item, or update the password of `ref`. */
  | { id: string; type: "save"; provider: string; domain: string; origin: string; entry: SaveEntry; ref?: string }
  | {
      id: string
      type: "passkey-create"
      provider: string
      rpId: string
      origin: string
      /** base64url SHA-256 of clientDataJSON, built by the extension. */
      clientDataHash: string
      user: { id: string; name: string; displayName: string }
      /** COSE algorithms the site accepts, in preference order. */
      algorithms: number[]
      excludeCredentialIds: string[]
      /** The site's authenticatorSelection.userVerification; "required" is refused by providers that can't verify the user. */
      userVerification?: string
    }
  | {
      id: string
      type: "passkey-get"
      provider: string
      ref: string
      rpId: string
      origin: string
      clientDataHash: string
      userVerification?: string
    }

/**
 * Command providers only: storage calls the bridge makes while it does the
 * passkey cryptography itself. Records hold the private key (PKCS#8, base64url).
 */
export interface PasskeyRecord {
  rpId: string
  credentialId: string
  userHandle: string
  userName: string
  displayName: string
  privateKey: string
  createdAt: string
}

export type CommandStorageRequest =
  | { id: string; type: "store-passkey"; record: PasskeyRecord }
  | { id: string; type: "load-passkey"; ref: string }

export type CommandStorageResponse =
  | { id: string; type: "store-passkey"; ref: string; userVerified?: boolean }
  | { id: string; type: "load-passkey"; record: PasskeyRecord; userVerified?: boolean }

export interface CheckResponse {
  id: string
  type: "check"
  /** new: no saved login for this username; update: saved but password differs; same: nothing to do. */
  status: "new" | "update" | "same"
  matches: Array<{ provider: string; ref: string }>
}

export interface SaveResponse {
  id: string
  type: "save"
  provider: string
  ref: string
  created: boolean
}

export interface PasskeyCreateResponse {
  id: string
  type: "passkey-create"
  ref: string
  credentialId: string
  /** base64url fields, ready for AuthenticatorAttestationResponse. */
  authenticatorData: string
  attestationObject: string
  publicKey: string
  publicKeyAlgorithm: number
  userVerified: boolean
}

export interface PasskeyGetResponse {
  id: string
  type: "passkey-get"
  credentialId: string
  authenticatorData: string
  signature: string
  userHandle?: string
  userVerified: boolean
}

export type ResponseV2 = Response | CheckResponse | SaveResponse | PasskeyCreateResponse | PasskeyGetResponse

/** Registrable-domain match used by both sides: same domain or a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "")
  const d = domain.toLowerCase().replace(/\.$/, "")
  return h === d || h.endsWith("." + d)
}
