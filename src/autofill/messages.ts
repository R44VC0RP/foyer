// Messages between the content script, the inline menu, the popup and the
// background for autofill. Secrets only ever appear in FillValues, sent by the
// background to the one frame the user chose to fill.

import type { AccountV2 as Account, ProviderInfoV2 as ProviderInfo } from "../shared/protocol"
import type { FieldRole } from "../shared/types"

export interface FillValues {
  username?: string
  password?: string
  totp?: string
  /** A generated password for sign-up / change-password fields (all "new password" boxes). */
  newPassword?: string
}

/** What the page has right now, so the background asks for the right secrets. */
export interface FieldPresence {
  roles: FieldRole[]
  /** Role of the field the menu is opening under. */
  focused?: FieldRole
}

export type AutofillMessage =
  // content -> background
  | { type: "af:query"; presence: FieldPresence }
  | { type: "af:menu-close"; token: string }
  // inline menu -> background
  | { type: "af:menu-load"; token: string }
  | { type: "af:menu-pick"; token: string; provider: string; ref: string }
  | { type: "af:menu-generate"; token: string }
  | { type: "af:menu-dismiss"; token: string }
  | { type: "af:menu-resize"; token: string; height: number }
  // popup / dashboard -> background
  | { type: "af:status" }
  | { type: "af:tab-accounts"; tabId: number }
  | { type: "af:tab-fill"; tabId: number; provider: string; ref: string }

export type ToContent =
  | { type: "af:fill"; values: FillValues; submit: boolean }
  | { type: "af:open-menu" }
  /** Use a saved sign-in method: press that provider's button on the page. */
  | { type: "af:sso"; provider: string }
  | { type: "af:close-menu"; token: string }
  | { type: "af:resize-menu"; token: string; height: number }

export interface QueryReply {
  token?: string
  count: number
}

export interface MenuLoadReply {
  /** Offer a generated password instead of accounts (new-password fields). */
  generate?: boolean
  domain: string
  /** Display names of the providers, by id ("1password" → "1Password"). */
  providerNames?: Record<string, string>
  accounts: Account[]
  errors: Array<{ provider: string; message: string }>
}

export interface StatusReply {
  connected: boolean
  error?: string
  providers: ProviderInfo[]
}

export interface TabAccountsReply extends StatusReply {
  domain?: string
  accounts: Account[]
  errors: Array<{ provider: string; message: string }>
}
