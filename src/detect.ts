// Login-surface detection.
//
// Fields and forms are scored with weighted clues (see clues.ts): labels,
// placeholders, ids, autocomplete, input type, neighbouring fields and the
// text around the form all add or subtract points. Text is read only to be
// matched in memory; what leaves this file is the resulting role and a
// selector built from non-personal attributes.

import {
  bestRole,
  FIELD_THRESHOLD,
  FORM_KINDS,
  providerFromLabel,
  scoreField,
  scoreFormText,
  squash,
  words,
  type FieldFacts,
  type FormKind,
} from "./clues"
import { deepQueryAll, openRoots } from "./shadow"
import { safeToken } from "./shared/privacy"
import type { ControlSpec, FieldRole, FieldSpec, Provider, ProviderSpec, SurfaceKind } from "./shared/types"

export const LOGIN_URL = /log-?in|log_in|logon|sign-?in|sign_in|signon|auth|sso|saml|oauth|session|identifier|challenge|mfa|2fa|two-factor|verify|webauthn|passkey/i
const SIGNUP_URL = /sign-?up|sign_up|register|registration|join|create-account|onboard/i
const RESET_URL = /forgot|reset|recover/i
const CHANGE_PASSWORD_URL = /change-?password|password-?change|update-?password|settings\/security/i
const SUBMIT_TEXT = /^\s*(sign ?in|log ?in|login|sign ?on|continue|next|submit|verify|confirm|go)\b/i

const PASSKEY_TEXT = /\b(passkeys?|security key|face ?id|touch ?id|windows hello|biometrics?)\b/i
const MAGIC_LINK_TEXT =
  /\b(magic link|(email|send|text) me an? (sign[- ]?in |login |log[- ]?in )?link|(email|send) (an? )?(sign[- ]?in|login|log[- ]?in) link|sign in with (an )?email link)\b/i
const AUTH_HREF = /oauth|auth|login|signin|sign_in|sso|saml|connect/i

const CLICKABLE = "a[href], button, [role=button], input[type=submit], input[type=button], input[type=image]"
const SKIP_INPUT_TYPES = new Set([
  "hidden", "submit", "button", "image", "reset", "checkbox", "radio", "file", "range", "color", "date",
  "datetime-local", "month", "week", "time", "search",
])

/** Minimum score for the page to count as a given kind of form. */
const FORM_THRESHOLD = 3

export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const style = getComputedStyle(el)
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05
}

const innerText = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? "").trim()

/** Label of a button or link. Matched against vocabularies only, never stored. */
export function controlText(el: Element): string {
  const input = el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button") ? el.value : ""
  const text =
    el.getAttribute("aria-label") ||
    innerText(el) ||
    input ||
    el.getAttribute("title") ||
    el.querySelector("img[alt]")?.getAttribute("alt") ||
    ""
  return text.replace(/\s+/g, " ").trim().slice(0, 120)
}

// ---- Field facts ---------------------------------------------------------------

/** Closest preceding text when a field has no <label>, e.g. a <span> above it. */
function nearbyText(el: Element): string {
  let node: Element | null = el
  for (let depth = 0; node && depth < 3; depth++) {
    let sibling = node.previousElementSibling
    for (let i = 0; sibling && i < 2; i++, sibling = sibling.previousElementSibling) {
      if (sibling.matches("input, select, textarea") || sibling.querySelector("input, select, textarea")) return ""
      const text = innerText(sibling)
      if (text) return text.length <= 80 ? text : ""
    }
    node = node.parentElement
  }
  return ""
}

function labelText(el: HTMLInputElement): string {
  const parts: string[] = []
  for (const label of Array.from(el.labels ?? [])) parts.push(innerText(label))
  const labelledBy = el.getAttribute("aria-labelledby")
  if (labelledBy) for (const id of labelledBy.split(/\s+/)) parts.push(innerText(document.getElementById(id)))
  parts.push(el.getAttribute("aria-label") ?? "", el.placeholder ?? "", el.getAttribute("title") ?? "")
  if (!parts.some(Boolean)) parts.push(nearbyText(el))
  // "you@example.com" as a placeholder means an email box.
  if (el.placeholder?.includes("@")) parts.push("email")
  return parts.filter(Boolean).join(" ").slice(0, 300)
}

function factsFor(el: HTMLInputElement): FieldFacts {
  const code = [el.id, el.name, el.className, el.getAttribute("data-testid"), el.getAttribute("data-test")]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
  return {
    type: (el.getAttribute("type") || "text").toLowerCase(),
    autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).filter(Boolean),
    display: words(labelText(el)),
    code: squash(words(code.slice(0, 300))),
    maxLength: el.maxLength > 0 ? el.maxLength : 0,
    inputMode: (el.getAttribute("inputmode") || "").toLowerCase(),
  }
}

function eligible(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && !SKIP_INPUT_TYPES.has((el.getAttribute("type") || "text").toLowerCase())
}

/** Role of a single field on its own, without page context. */
export function classifyInput(el: Element): FieldRole | null {
  if (!eligible(el)) return null
  return bestRole(scoreField(factsFor(el)))
}

// ---- Selectors -----------------------------------------------------------------

// Only ids and attribute values that need no escaping are used, so selectors
// stay in a small grammar that imports can validate (see isSafeSelector).
const PLAIN_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/
const plainId = (v: string | null | undefined) => {
  const id = safeToken(v)
  return id && PLAIN_ID.test(id) ? id : undefined
}

function unique(selector: string, el: Element, root: Document | ShadowRoot): boolean {
  try {
    const found = root.querySelectorAll(selector)
    return found.length === 1 && found[0] === el
  } catch {
    return false
  }
}

/**
 * Selector from stable, non-personal attributes; falls back to a short tag
 * path. Inside a shadow root it is "<host selector> >>> <inner selector>",
 * read as: find the host, then look inside its shadow root.
 */
export function selectorFor(el: Element): string {
  const root = el.getRootNode()
  if (root instanceof ShadowRoot) return `${selectorFor(root.host)} >>> ${selectorIn(el, root)}`
  return selectorIn(el, document)
}

function selectorIn(el: Element, root: Document | ShadowRoot): string {
  const tag = el.tagName.toLowerCase()
  const id = plainId(el.id)
  if (id && unique(`#${id}`, el, root)) return `#${id}`
  for (const attr of ["data-testid", "data-test", "data-qa", "name", "autocomplete", "aria-label", "type"]) {
    const value = safeToken(el.getAttribute(attr), 48)
    if (!value || /["\\]/.test(value)) continue
    const sel = `${tag}[${attr}="${value}"]`
    if (unique(sel, el, root)) return sel
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

// ---- Controls ------------------------------------------------------------------

const PROVIDER_ATTR = /\b(google|apple|microsoft|github|facebook|twitter|linkedin|gitlab|slack|discord|amazon|okta)\b/i

export function providerForControl(el: Element, text: string): Provider | null {
  // Some sites label provider buttons explicitly; trust that over the text.
  const attr = el.getAttribute("data-provider") || el.getAttribute("data-social") || ""
  const fromAttr = PROVIDER_ATTR.exec(attr)?.[1]?.toLowerCase()
  if (fromAttr) return (fromAttr === "twitter" ? "x" : fromAttr) as Provider
  const match = text ? providerFromLabel(text) : null
  if (!match) return null
  // A footer "GitHub" link is not a sign-in button; links need a connector
  // ("Continue with GitHub") or an auth-looking destination.
  if (el instanceof HTMLAnchorElement && !match.connector && !AUTH_HREF.test(el.getAttribute("href") || "")) return null
  return match.provider
}

export type ControlRole =
  | { type: "provider"; provider: Provider; via: "button" | "widget" }
  | { type: "passkey" }
  | { type: "magic-link" }
  | { type: "submit" }

interface ScannedField {
  el: HTMLInputElement
  facts: FieldFacts
  score: Record<FieldRole, number>
  role: FieldRole | null
}

export interface ScanResult {
  kind: SurfaceKind | null
  fields: Array<{ el: HTMLInputElement; spec: FieldSpec }>
  providers: Array<{ el: Element; spec: ProviderSpec }>
  submit?: { el: Element; spec: ControlSpec }
  passkey?: { el: Element; spec: ControlSpec }
  magicLink?: { el: Element; spec: ControlSpec }
}

function collectFields(roots: Array<Document | ShadowRoot>): { fields: ScannedField[]; otpBoxes: HTMLInputElement[] } {
  const fields: ScannedField[] = []
  const otpBoxes: HTMLInputElement[] = []
  for (const el of deepQueryAll<HTMLInputElement>("input", roots).slice(0, 200)) {
    if (!eligible(el) || !isVisible(el)) continue
    // One-character boxes for codes are grouped into a single split OTP field.
    if (el.maxLength === 1) {
      otpBoxes.push(el)
      continue
    }
    const facts = factsFor(el)
    fields.push({ el, facts, score: scoreField(facts), role: null })
  }

  // Context: a password field right after another one is a confirmation,
  // unless it's really a PIN or token box.
  let previousPassword: HTMLInputElement | null = null
  for (const f of fields) {
    if (f.facts.type !== "password" || f.score.otp >= FIELD_THRESHOLD) continue
    if (previousPassword && previousPassword.form === f.el.form) {
      f.score["new-password"] += 4
      f.score.password -= 4
    }
    previousPassword = f.el
  }
  for (const f of fields) f.role = bestRole(f.score)
  return { fields, otpBoxes: otpBoxes.length >= 4 && otpBoxes.length <= 8 ? otpBoxes : [] }
}

/** The form that holds the most important field, if the page uses <form>. */
function primaryForm(fields: ScannedField[]): HTMLFormElement | null {
  const anchor =
    fields.find((f) => f.role === "password" || f.role === "new-password") ??
    fields.find((f) => f.role === "username" || f.role === "email" || f.role === "phone") ??
    fields.find((f) => f.role === "otp")
  return anchor ? (anchor.el.form ?? anchor.el.closest("form")) : null
}

function contextText(form: HTMLFormElement | null): string {
  const parts = [document.title]
  for (const h of Array.from(document.querySelectorAll("h1, h2, h3, [role=heading]")).slice(0, 6)) parts.push(innerText(h))
  if (form) {
    parts.push(innerText(form).slice(0, 3000))
    for (const input of Array.from(form.querySelectorAll<HTMLInputElement>("input[type=submit], input[type=button]")))
      parts.push(input.value)
  }
  return words(parts.join(" \n "))
}

function collectControls(form: HTMLFormElement | null, roots: Array<Document | ShadowRoot>) {
  const providers: ScanResult["providers"] = []
  let passkey: ScanResult["passkey"]
  let magicLink: ScanResult["magicLink"]
  let submit: ScanResult["submit"]
  const buttonText: string[] = []
  const seen = new Set<Provider>()

  // The login form's own buttons first, so a huge nav can't push them past the cap.
  const candidates = new Set<Element>(form ? Array.from(form.querySelectorAll(CLICKABLE)) : [])
  for (const el of deepQueryAll(CLICKABLE, roots)) {
    if (candidates.size >= 500) break
    candidates.add(el)
  }
  for (const el of candidates) {
    if (!isVisible(el)) continue
    const text = controlText(el)
    const provider = providerForControl(el, text)
    if (provider) {
      if (!seen.has(provider)) {
        seen.add(provider)
        providers.push({ el, spec: { provider, selector: selectorFor(el), via: "button" } })
      }
      continue
    }
    if (!text) continue
    if (text.length <= 60 && PASSKEY_TEXT.test(text) && !passkey) {
      passkey = { el, spec: { selector: selectorFor(el) } }
      continue
    }
    if (text.length <= 80 && MAGIC_LINK_TEXT.test(text) && !magicLink) {
      magicLink = { el, spec: { selector: selectorFor(el) } }
      continue
    }
    const inScope = form ? form.contains(el) : true
    if (inScope && !(el instanceof HTMLAnchorElement) && text.length <= 40) {
      buttonText.push(text)
      const isSubmitType = (el as HTMLButtonElement).type === "submit"
      if (!submit && (SUBMIT_TEXT.test(text) || (isSubmitType && form))) submit = { el, spec: { selector: selectorFor(el) } }
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

  return { providers, passkey, magicLink, submit, buttonText }
}

function decideKind(
  fields: ScannedField[],
  otpBoxes: number,
  text: string,
  controls: ReturnType<typeof collectControls>,
): FormKind | null {
  const count = (...roles: FieldRole[]) => fields.filter((f) => f.role && roles.includes(f.role)).length
  const pw = count("password")
  const npw = count("new-password")
  const ident = count("username", "email", "phone")
  const otp = count("otp") + (otpBoxes ? 1 : 0)
  const ac = new Set(fields.flatMap((f) => f.facts.autocomplete))
  const hasProviders = controls.providers.length > 0
  const url = location.hostname + location.pathname

  const score = scoreFormText(text + words(controls.buttonText.join(" ")))
  // Shape of the form.
  if (pw === 1 && npw === 0) score.login += 5
  if (pw === 0 && npw === 0 && ident > 0) score.login += 1
  if (pw >= 2) score.login -= 3
  if (npw > 0 && !ac.has("current-password")) score.login -= 3
  if (hasProviders) score.login += 2
  if (controls.passkey || ac.has("webauthn")) score.login += 3
  if (ac.has("current-password")) score.login += 3
  if (ac.has("username") && pw === 0) score.login += 2

  // With a single password box, autocomplete=new-password is a weak hint
  // (sites use it to block autofill on logins); wording has to confirm it.
  const single = pw + npw === 1
  if (npw > 0 && pw === 0) score.signup += single ? 1 : 3
  if (pw + npw >= 2) score.signup += 3
  if (ac.has("new-password")) score.signup += single ? 1 : 3
  if (single && npw === 1) score.login += 2
  if (pw === 1 && npw === 0) score.signup -= 2
  // A "Create account" link next to an email-first sign-in doesn't make it a sign-up.
  if (pw + npw === 0 && !SIGNUP_URL.test(url)) score.signup = Math.min(score.signup, 2)

  // Shape alone is weak here (two password boxes can be password + PIN); the
  // "current / new password" wording does most of the work.
  if ((pw >= 1 && npw >= 1) || pw + npw >= 3) score["change-password"] += 2
  if (ac.has("current-password") && ac.has("new-password")) score["change-password"] += 4

  if (ident > 0 && pw + npw === 0) score.reset += 1
  if (pw + npw > 0) score.reset -= 6

  if (otp > 0 && pw === 0) score.mfa += 6
  if (otp > 0 && pw > 0) score.mfa += 1

  if (ident > 0 && pw + npw === 0 && !hasProviders) score.newsletter += 1
  if (pw + npw > 0) score.newsletter -= 8
  if (hasProviders) score.newsletter -= 5

  // Where we are.
  if (LOGIN_URL.test(url)) {
    score.login += 2
    score.mfa += 1
  }
  if (SIGNUP_URL.test(url)) score.signup += 2
  if (RESET_URL.test(url)) score.reset += 2
  if (CHANGE_PASSWORD_URL.test(url)) score["change-password"] += 2

  let best: FormKind | null = null
  for (const kind of FORM_KINDS) if (score[kind] >= FORM_THRESHOLD && (!best || score[kind] > score[best])) best = kind
  return best
}

/** Once the form's kind is known, settle password roles that depend on it. */
function adjustRoles(fields: ScannedField[], kind: FormKind) {
  const passwords = fields.filter((f) => f.facts.type === "password" && (f.role === "password" || f.role === "new-password"))
  if (kind === "signup") {
    for (const f of passwords) if (!f.facts.autocomplete.includes("current-password")) f.role = "new-password"
  } else if (kind === "change-password") {
    passwords.forEach((f, i) => {
      if (f.facts.autocomplete.includes("new-password")) f.role = "new-password"
      else if (f.facts.autocomplete.includes("current-password")) f.role = "password"
      else f.role = i === 0 ? "password" : "new-password"
    })
  } else if (kind === "login") {
    // Sites sometimes set autocomplete=new-password on a login box to block autofill.
    if (passwords.length === 1) passwords[0].role = "password"
    else for (const f of passwords) if (f.role === "new-password" && !f.facts.autocomplete.includes("new-password")) f.role = "password"
  }
}

const SURFACE_KIND: Record<FormKind, SurfaceKind | null> = {
  login: "login",
  signup: "signup",
  "change-password": "change-password",
  reset: "reset",
  mfa: "mfa",
  newsletter: null,
}

export function scanPage(): ScanResult {
  const roots = openRoots()
  const { fields: all, otpBoxes } = collectFields(roots)
  const form = primaryForm(all)
  // Judge and report the primary form only, so a sign-up form or newsletter
  // box elsewhere on the page doesn't change what the login form is.
  const inScope = (el: Element) => !form || form.contains(el)
  const scanned = all.filter((f) => inScope(f.el))
  const controls = collectControls(form, roots)
  const formKind = decideKind(scanned, otpBoxes.length, contextText(form), controls)
  if (formKind) adjustRoles(scanned, formKind)

  const fields: ScanResult["fields"] = scanned
    .filter((f) => f.role)
    .map((f) => ({ el: f.el, spec: fieldSpec(f.el, f.role!) }))
  if (otpBoxes.length && inScope(otpBoxes[0])) {
    const spec = fieldSpec(otpBoxes[0], "otp")
    spec.split = otpBoxes.length
    for (const box of otpBoxes) fields.push({ el: box, spec: { ...spec } })
  }

  return {
    kind: formKind ? SURFACE_KIND[formKind] : null,
    fields,
    providers: controls.providers,
    submit: controls.submit,
    passkey: controls.passkey,
    magicLink: controls.magicLink,
  }
}
