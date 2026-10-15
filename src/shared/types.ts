// The Foyer data model. Everything here is structural: which kinds of fields a
// login page has, how to find them, what order a person used them in. No field
// values, page text, query strings or account identifiers ever appear in it.

export const DATASET_FORMAT = "foyer.dataset"
export const SCHEMA_VERSION = 1

export type FieldRole =
  | "username"
  | "email"
  | "phone"
  | "password"
  | "new-password"
  | "otp"
  | "captcha"

export type Provider =
  | "google"
  | "apple"
  | "microsoft"
  | "github"
  | "facebook"
  | "x"
  | "linkedin"
  | "gitlab"
  | "slack"
  | "discord"
  | "amazon"
  | "okta"
  | "sso"

/** Ways a site lets you in. `sso:*` is "Continue with <provider>". */
export type Method =
  | "password"
  | "identifier-first"
  | "passkey"
  | "passkey-autofill"
  | "magic-link"
  | "otp"
  | `sso:${Provider}`

export type SurfaceKind = "login" | "signup" | "change-password" | "mfa" | "reset" | "idp"

export interface FieldSpec {
  role: FieldRole
  /** CSS selector built only from stable, non-personal attributes. */
  selector: string
  type: string
  autocomplete?: string
  inputMode?: string
  maxLength?: number
  /** For one-character-per-box OTP inputs: how many boxes. */
  split?: number
}

export interface ControlSpec {
  selector: string
}

export interface ProviderSpec extends ControlSpec {
  provider: Provider
  /** "button" for an on-page button, "widget" for GSI / Sign in with Apple embeds. */
  via: "button" | "widget"
}

/** A login screen as seen on the page, before anyone touches it. */
export interface Surface {
  host: string
  path: string
  frame: "top" | "sub"
  kind: SurfaceKind
  fields: FieldSpec[]
  providers: ProviderSpec[]
  submit?: ControlSpec
  passkeyButton?: ControlSpec
  magicLinkButton?: ControlSpec
  /** The page asked the browser for passkey autofill (mediation: conditional). */
  passkeyAutofill?: boolean
}

export type Action =
  | { kind: "fill"; role: FieldRole; selector: string }
  | { kind: "provider"; provider: Provider; selector?: string; via: "button" | "widget" | "fedcm" }
  | { kind: "choose"; intent: "passkey" | "magic-link"; selector: string }
  | { kind: "submit"; via: "form" | "button" | "enter"; selector?: string }
  | {
      kind: "passkey"
      op: "get" | "create"
      mediation?: string
      userVerification?: string
      rpId?: string
      hasAllowList?: boolean
      result?: "ok" | "cancelled" | "error"
    }
  | { kind: "redirect"; host: string; provider?: Provider }

export interface Step {
  host: string
  path: string
  kind: SurfaceKind
  fields: FieldSpec[]
  actions: Action[]
}

export interface FlowRecord {
  /** Stable hash of the step/action shape, used to dedupe and merge. */
  signature: string
  method: Method | "unknown"
  /** Second factor seen after the primary method, if any. */
  mfa?: "otp" | "passkey"
  outcome: "completed" | "unknown"
  steps: Step[]
  seen: number
  firstSeen: string
  lastSeen: string
}

export interface SurfaceRecord {
  signature: string
  surface: Surface
  seen: number
  lastSeen: string
}

export interface MethodStat {
  seen: number
  lastSeen: string
}

export interface SiteRecipe {
  /** Registrable domain, e.g. github.com. */
  domain: string
  hosts: string[]
  /** Methods the login screens advertised. */
  offers: Partial<Record<Method, MethodStat>>
  /** Login screens observed, deduped. */
  surfaces: SurfaceRecord[]
  /** Logins actually performed, deduped by shape. */
  flows: FlowRecord[]
  updatedAt: string
}

export interface Dataset {
  format: typeof DATASET_FORMAT
  version: typeof SCHEMA_VERSION
  exportedAt?: string
  sites: Record<string, SiteRecipe>
}

export interface Settings {
  paused: boolean
}

// Content/page -> background messages.
export type Message =
  | { type: "foyer:surface"; surface: Surface }
  | { type: "foyer:action"; host: string; path: string; action: Action }
  /** Top frame has shown no login screen for a while. `loginish`: URL still looks like auth. */
  | { type: "foyer:quiet"; host: string; path: string; loginish: boolean }
