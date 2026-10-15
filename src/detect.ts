// Login-surface detection. Pure DOM reads of structure and attributes; the only
// text read is the label of buttons and links, which is matched against fixed
// vocabularies and never stored.

import { safeToken } from "./shared/privacy"
import type { ControlSpec, FieldRole, FieldSpec, Provider, ProviderSpec, SurfaceKind } from "./shared/types"

export const LOGIN_URL = /log-?in|log_in|logon|sign-?in|sign_in|signon|auth|sso|saml|oauth|session|identifier|challenge|mfa|2fa|two-factor|verify|webauthn|passkey/i
const SIGNUP_URL = /sign-?up|sign_up|register|registration|join|create-account|onboard/i
const RESET_URL = /forgot|reset|recover/i
const SIGN_IN_TEXT = /\b(sign ?in|log ?in|login|sign ?on)\b/i
const SUBMIT_TEXT = /^\s*(sign ?in|log ?in|login|sign ?on|continue|next|submit|verify|confirm|go)\b/i
const SIGNUP_TEXT = /\b(sign ?up|register|create (an |your )?account|join now)\b/i

const PROVIDER_TEXT: Array<[Provider, RegExp]> = [
  ["google", /\bgoogle\b/i],
  ["apple", /\bapple\b/i],
  ["microsoft", /\b(microsoft|outlook|office ?365|azure ad|entra id)\b/i],
  ["github", /\bgithub\b/i],
  ["facebook", /\bfacebook\b/i],
  ["x", /\b(twitter|(with|continue with|sign in with|log in with) x)\b/i],
  ["linkedin", /\blinkedin\b/i],
  ["gitlab", /\bgitlab\b/i],
  ["slack", /\bslack\b/i],
  ["discord", /\bdiscord\b/i],
  ["amazon", /\bamazon\b/i],
  ["okta", /\bokta\b/i],
  ["sso", /\b(sso|single sign[- ]?on|saml|enterprise (login|log in|sign[- ]?in)|work account|company account|organi[sz]ation account)\b/i],
]
const PASSKEY_TEXT = /\b(passkeys?|security key|face ?id|touch ?id|windows hello|biometrics?)\b/i
const MAGIC_LINK_TEXT =
  /\b(magic link|(email|send|text) me an? (sign[- ]?in |login |log[- ]?in )?link|(email|send) (an? )?(sign[- ]?in|login|log[- ]?in) link|sign in with (an )?email link)\b/i
const AUTH_HREF = /oauth|auth|login|signin|sign_in|sso|saml|connect/i

const CLICKABLE = "a[href], button, [role=button], input[type=submit], input[type=button], input[type=image]"
const SKIP_INPUT_TYPES = new Set([
  "hidden", "submit", "button", "image", "reset", "checkbox", "radio", "file", "range", "color", "date",
  "datetime-local", "month", "week", "time", "search",
])

export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const style = getComputedStyle(el)
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05
}

/** Label of a button or link. Matched against vocabularies only, never stored. */
export function controlText(el: Element): string {
  const input = el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button") ? el.value : ""
  const text =
    el.getAttribute("aria-label") ||
    (el as HTMLElement).innerText ||
    input ||
    el.getAttribute("title") ||
    el.querySelector("img[alt]")?.getAttribute("alt") ||
    ""
  return text.replace(/\s+/g, " ").trim().slice(0, 120)
}

function attrHaystack(el: HTMLInputElement): string {
  return [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.getAttribute("data-testid")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

export function classifyInput(el: Element): FieldRole | null {
  if (!(el instanceof HTMLInputElement)) return null
  const type = (el.getAttribute("type") || "text").toLowerCase()
  if (SKIP_INPUT_TYPES.has(type)) return null
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase()
  const tokens = new Set(ac.split(/\s+/))
  const hay = attrHaystack(el)

  if (tokens.has("one-time-code")) return "otp"
  if (type === "password") {
    if (tokens.has("new-password")) return "new-password"
    if (/\b(otp|pin|totp|2fa|mfa)\b/.test(hay)) return "otp"
    return "password"
  }
  if (/(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verification.?code|security.?code|auth.?code|sms.?code|passcode)([^a-z]|$)/.test(hay))
    return "otp"
  if (/captcha/.test(hay)) return "captcha"
  if (type === "email" || tokens.has("email") || /e-?mail/.test(hay)) return "email"
  if (type === "tel" || tokens.has("tel") || tokens.has("tel-national") || /phone|mobile/.test(hay)) return "phone"
  if (tokens.has("username") || tokens.has("webauthn") || /user.?name|userid|user.?id|login|account|identifier|signin|sign-in/.test(hay))
    return "username"
  return null
}

// Only ids and attribute values that need no escaping are used, so selectors
// stay in a small grammar that imports can validate (see isSafeSelector).
const PLAIN_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/
const plainId = (v: string | null | undefined) => {
  const id = safeToken(v)
  return id && PLAIN_ID.test(id) ? id : undefined
}

function unique(selector: string, el: Element): boolean {
  try {
    const found = document.querySelectorAll(selector)
    return found.length === 1 && found[0] === el
  } catch {
    return false
  }
}

/** Selector from stable, non-personal attributes; falls back to a short tag path. */
export function selectorFor(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const id = plainId(el.id)
  if (id && unique(`#${id}`, el)) return `#${id}`
  for (const attr of ["data-testid", "data-test", "data-qa", "name", "autocomplete", "aria-label", "type"]) {
    const value = safeToken(el.getAttribute(attr), 48)
    if (!value || /["\\]/.test(value)) continue
    const sel = `${tag}[${attr}="${value}"]`
    if (unique(sel, el)) return sel
  }
  const parts: string[] = []
  let node: Element | null = el
  while (node && node !== document.documentElement && parts.length < 5) {
    const nodeTag = node.tagName.toLowerCase()
    const nodeId = plainId(node.id)
    if (nodeId && node !== el) {
      parts.unshift(`#${nodeId}`)
      break
    }
    const parent: Element | null = node.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      parts.unshift(siblings.length > 1 ? `${nodeTag}:nth-of-type(${siblings.indexOf(node) + 1})` : nodeTag)
    } else parts.unshift(nodeTag)
    node = parent
  }
  return parts.join(" > ")
}

export function fieldSpec(el: HTMLInputElement, role: FieldRole): FieldSpec {
  const spec: FieldSpec = { role, selector: selectorFor(el), type: (el.getAttribute("type") || "text").toLowerCase() }
  const ac = el.getAttribute("autocomplete")
  if (ac && ac.length <= 60 && /^[a-z0-9 -]+$/i.test(ac)) spec.autocomplete = ac.toLowerCase()
  const im = safeToken(el.getAttribute("inputmode"), 20)
  if (im) spec.inputMode = im
  if (el.maxLength > 0 && el.maxLength < 1000) spec.maxLength = el.maxLength
  return spec
}

export function providerForControl(el: Element, text: string): Provider | null {
  if (!text || text.length > 60) return null
  const isLink = el instanceof HTMLAnchorElement
  if (isLink) {
    const href = el.getAttribute("href") || ""
    const authish = SIGN_IN_TEXT.test(text) || /\b(with|continue|connect)\b/i.test(text) || AUTH_HREF.test(href)
    if (!authish) return null
  }
  for (const [provider, pattern] of PROVIDER_TEXT) if (pattern.test(text)) return provider
  return null
}

export type ControlRole =
  | { type: "provider"; provider: Provider; via: "button" | "widget" }
  | { type: "passkey" }
  | { type: "magic-link" }
  | { type: "submit" }

export interface ScanResult {
  kind: SurfaceKind | null
  fields: Array<{ el: HTMLInputElement; spec: FieldSpec }>
  providers: Array<{ el: Element; spec: ProviderSpec }>
  submit?: { el: Element; spec: ControlSpec }
  passkey?: { el: Element; spec: ControlSpec }
  magicLink?: { el: Element; spec: ControlSpec }
}

function collectFields(): ScanResult["fields"] {
  const out: ScanResult["fields"] = []
  const inputs = Array.from(document.querySelectorAll("input")).slice(0, 200)
  const otpBoxes: HTMLInputElement[] = []
  for (const el of inputs) {
    if (!isVisible(el)) continue
    const role = classifyInput(el)
    // One-character boxes for codes: group into a single split OTP field.
    if (el.maxLength === 1 && (role === "otp" || role === null || el.inputMode === "numeric")) {
      otpBoxes.push(el)
      continue
    }
    if (role) out.push({ el, spec: fieldSpec(el, role) })
  }
  if (otpBoxes.length >= 4) {
    const spec = fieldSpec(otpBoxes[0], "otp")
    spec.split = otpBoxes.length
    out.push({ el: otpBoxes[0], spec })
    for (const box of otpBoxes.slice(1)) out.push({ el: box, spec: { ...spec } })
  }
  return out
}

function collectControls(fields: ScanResult["fields"]) {
  const providers: ScanResult["providers"] = []
  let passkey: ScanResult["passkey"]
  let magicLink: ScanResult["magicLink"]
  let submit: ScanResult["submit"]
  let signInText = false
  let signUpText = false
  const seen = new Set<Provider>()
  const formScope = fields[0]?.el.form ?? fields[0]?.el.closest("form") ?? null

  const controls = Array.from(document.querySelectorAll(CLICKABLE)).slice(0, 400)
  for (const el of controls) {
    if (!isVisible(el)) continue
    const text = controlText(el)
    if (!text) continue
    const provider = providerForControl(el, text)
    if (provider) {
      if (SIGN_IN_TEXT.test(text) || /\b(continue|with)\b/i.test(text)) signInText = true
      if (!seen.has(provider)) {
        seen.add(provider)
        providers.push({ el, spec: { provider, selector: selectorFor(el), via: "button" } })
      }
      continue
    }
    if (text.length <= 60 && PASSKEY_TEXT.test(text) && !passkey) {
      passkey = { el, spec: { selector: selectorFor(el) } }
      continue
    }
    if (text.length <= 80 && MAGIC_LINK_TEXT.test(text) && !magicLink) {
      magicLink = { el, spec: { selector: selectorFor(el) } }
      continue
    }
    const inScope = formScope ? formScope.contains(el) : true
    if (inScope && !(el instanceof HTMLAnchorElement)) {
      if (SIGN_IN_TEXT.test(text) && text.length <= 40) signInText = true
      if (SIGNUP_TEXT.test(text) && text.length <= 40) signUpText = true
      const isSubmitType = (el as HTMLButtonElement).type === "submit"
      if (!submit && (SUBMIT_TEXT.test(text) || (isSubmitType && formScope)) && text.length <= 40)
        submit = { el, spec: { selector: selectorFor(el) } }
    }
  }

  // Embedded provider widgets: Google Identity Services and Sign in with Apple.
  const widgets: Array<[Provider, string]> = [
    ["google", ".g_id_signin, #g_id_onload, iframe[src*='accounts.google.com/gsi']"],
    ["apple", "#appleid-signin, iframe[src*='appleid.apple.com']"],
  ]
  for (const [provider, selector] of widgets) {
    if (seen.has(provider)) continue
    const el = document.querySelector(selector)
    if (el) {
      seen.add(provider)
      providers.push({ el, spec: { provider, selector: selectorFor(el), via: "widget" } })
    }
  }

  return { providers, passkey, magicLink, submit, signInText, signUpText }
}

export function scanPage(): ScanResult {
  const fields = collectFields()
  const { providers, passkey, magicLink, submit, signInText, signUpText } = collectControls(fields)
  const roles = fields.map((f) => f.spec.role)
  const has = (r: FieldRole) => roles.includes(r)
  const url = location.hostname + location.pathname
  const loginUrl = LOGIN_URL.test(url)
  const identifier = has("username") || has("email") || has("phone")
  const identifierHint = fields.some((f) => /\b(username|webauthn)\b/.test(f.spec.autocomplete ?? ""))
  const passwords = roles.filter((r) => r === "password").length

  let kind: SurfaceKind | null = null
  if (has("new-password") || (signUpText && !signInText) || (SIGNUP_URL.test(url) && !loginUrl)) {
    if (has("new-password") || passwords > 0 || identifier) kind = "signup"
  } else if (passwords > 0) {
    kind = passwords > 1 ? "signup" : "login"
  } else if (has("otp")) {
    kind = "mfa"
  } else if (identifier && RESET_URL.test(url)) {
    kind = "reset"
  } else if (identifier && (signInText || loginUrl || identifierHint)) {
    kind = "login"
  } else if ((providers.length || passkey || magicLink) && (loginUrl || signInText)) {
    kind = "login"
  }

  return { kind, fields, providers, submit, passkey, magicLink }
}
