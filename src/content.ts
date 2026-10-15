// Isolated-world content script: finds login screens, watches how the person
// uses them (which field, which button, never what was typed) and reports the
// structure to the background worker.

import type { FillTarget } from "./autofill/fill"
import { captureOnSubmit, primeCapture } from "./autofill/capture"
import { initPasskeyChannel } from "./autofill/channel"
import { initDialogs } from "./autofill/dialog-host"
import { initAutofill, refreshAutofill } from "./autofill/inline"
import { classifyInput, fieldSpec, LOGIN_URL, scanPage, type ControlRole } from "./detect"
import { MEDIATIONS, USER_VERIFICATIONS } from "./shared/dataset"
import { idpForHost, isDedicatedIdpHost } from "./shared/domains"
import { isHostname, safeHost, templatePath } from "./shared/privacy"
import type { Action, FieldSpec, Message, Provider, ProviderSpec, Surface } from "./shared/types"

const isTop = window === window.top
const SCAN_INTERVAL_MS = 750
const QUIET_AFTER_MS = 2500

let fields = new WeakMap<Element, FieldSpec>()
let controls = new WeakMap<Element, ControlRole>()
let filled = new WeakSet<Element>()
let lastSignature = ""
let lastUrl = location.href
let currentSurface: Surface | null = null
let passkeyAutofill = false
const fedcmProviders = new Set<Provider>()
let quietTimer: number | undefined
let quietSentFor = ""
let lastSubmitAt = 0

function send(message: Message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    // Extension was reloaded; this page's script is orphaned.
  }
}

const where = () => ({ host: safeHost(location.hostname), path: templatePath(location.pathname) })

function action(a: Action) {
  send({ type: "foyer:action", ...where(), action: a })
}

// Live elements of the current login form, for autofill. Never sent anywhere.
let fillTargets: FillTarget[] = []
let submitControl: Element | undefined
let providerButtons = new Map<string, Element>()

function buildSurface(): Surface | null {
  const scan = scanPage()
  fillTargets = []
  submitControl = undefined
  fields = new WeakMap()
  controls = new WeakMap()
  for (const f of scan.fields) fields.set(f.el, f.spec)
  for (const p of scan.providers) controls.set(p.el, { type: "provider", provider: p.spec.provider, via: p.spec.via })
  if (scan.passkey) controls.set(scan.passkey.el, { type: "passkey" })
  if (scan.magicLink) controls.set(scan.magicLink.el, { type: "magic-link" })
  if (scan.submit) controls.set(scan.submit.el, { type: "submit" })

  const providers: ProviderSpec[] = scan.providers.map((p) => p.spec)
  for (const provider of fedcmProviders)
    if (!providers.some((p) => p.provider === provider)) providers.push({ provider, selector: "", via: "widget" })

  let kind = scan.kind
  if (!kind && (providers.length || passkeyAutofill) && scan.fields.length) kind = "login"
  if (!kind) return null
  if (kind === "login" && isDedicatedIdpHost(location.hostname)) kind = "idp"
  if (kind === "login" || kind === "idp" || kind === "mfa") {
    fillTargets = scan.fields.map((f) => ({ el: f.el, role: f.spec.role, split: f.spec.split }))
    submitControl = scan.submit?.el
    primeCapture()
  }
  providerButtons = new Map(scan.providers.map((p) => [p.spec.provider, p.el]))

  const unique = new Map<string, FieldSpec>()
  for (const f of scan.fields) unique.set(`${f.spec.role}:${f.spec.selector}`, f.spec)

  return {
    ...where(),
    frame: isTop ? "top" : "sub",
    kind,
    fields: [...unique.values()],
    providers,
    submit: scan.submit?.spec,
    passkeyButton: scan.passkey?.spec,
    magicLinkButton: scan.magicLink?.spec,
    passkeyAutofill: passkeyAutofill || undefined,
  }
}

function signatureOf(s: Surface | null): string {
  if (!s) return ""
  return JSON.stringify([s.host, s.path, s.kind, s.fields.map((f) => f.role + f.selector), s.providers.map((p) => p.provider), !!s.passkeyButton, !!s.magicLinkButton, !!s.passkeyAutofill])
}

function scan() {
  if (document.hidden || !document.body) return
  if (location.href !== lastUrl) {
    lastUrl = location.href
    lastSignature = ""
    filled = new WeakSet()
  }
  const surface = buildSurface()
  currentSurface = surface
  const sig = signatureOf(surface)
  if (surface && sig !== lastSignature) {
    lastSignature = sig
    filled = new WeakSet()
    send({ type: "foyer:surface", surface })
  }
  if (!surface) lastSignature = ""
  // Autofocused login fields get the menu once the form is recognised.
  const active = document.activeElement
  if (active instanceof HTMLInputElement && fillTargets.some((t) => t.el === active)) refreshAutofill(active)

  if (!isTop) return
  window.clearTimeout(quietTimer)
  if (!surface && quietSentFor !== location.href) {
    const url = location.href
    quietTimer = window.setTimeout(() => {
      if (!currentSurface && location.href === url) {
        quietSentFor = url
        send({ type: "foyer:quiet", ...where(), loginish: LOGIN_URL.test(location.pathname) })
      }
    }, QUIET_AFTER_MS)
  }
}

// ---- Scheduling -------------------------------------------------------------

let scheduled = false
let lastScanAt = 0
function scheduleScan() {
  if (scheduled) return
  scheduled = true
  const wait = Math.max(0, SCAN_INTERVAL_MS - (Date.now() - lastScanAt))
  window.setTimeout(() => {
    scheduled = false
    lastScanAt = Date.now()
    scan()
  }, wait)
}

function start() {
  scheduleScan()
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "class", "hidden", "autocomplete", "aria-hidden"],
  })
  // SPA navigations that don't touch the DOM much.
  window.setInterval(() => {
    if (location.href !== lastUrl) scheduleScan()
  }, 1000)
  document.addEventListener("visibilitychange", scheduleScan)
}

// ---- Interaction tracking ---------------------------------------------------

function onInput(event: Event) {
  const el = event.target
  if (!(el instanceof HTMLInputElement) || filled.has(el)) return
  let spec = fields.get(el)
  if (!spec) {
    const role = classifyInput(el)
    if (!role || !currentSurface) return
    spec = fieldSpec(el, role)
  }
  filled.add(el)
  // Split OTP boxes report once for the whole group.
  if (spec.split) filledGroup(spec)
  action({ kind: "fill", role: spec.role, selector: spec.selector })
}

function filledGroup(spec: FieldSpec) {
  for (const input of Array.from(document.querySelectorAll("input"))) {
    if (fields.get(input)?.selector === spec.selector) filled.add(input)
  }
}

function submitted(via: "form" | "button" | "enter", selector?: string) {
  const now = Date.now()
  if (now - lastSubmitAt < 800) return
  lastSubmitAt = now
  action({ kind: "submit", via, selector })
  if (fillTargets.length) captureOnSubmit(fillTargets)
}

// Only the user's own clicks and keypresses count: pages can dispatch synthetic
// ones, which would pollute the dataset and could trigger a save capture.
function onClick(event: MouseEvent) {
  if (!event.isTrusted || !currentSurface) return
  let node = event.target instanceof Element ? event.target : null
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const role = controls.get(node)
    if (!role) continue
    if (role.type === "provider") {
      const selector = currentSurface.providers.find((p) => p.provider === role.provider)?.selector
      action({ kind: "provider", provider: role.provider, via: role.via, selector })
    }
    else if (role.type === "passkey") action({ kind: "choose", intent: "passkey", selector: currentSurface.passkeyButton?.selector ?? "" })
    else if (role.type === "magic-link") action({ kind: "choose", intent: "magic-link", selector: currentSurface.magicLinkButton?.selector ?? "" })
    else if (role.type === "submit") submitted("button", currentSurface.submit?.selector)
    return
  }
}

function onSubmit(event: Event) {
  if (!currentSurface || !(event.target instanceof HTMLFormElement)) return
  const hasField = Array.from(event.target.elements).some((el) => fields.has(el))
  if (hasField) submitted("form", currentSurface.submit?.selector)
}

function onKeydown(event: KeyboardEvent) {
  if (!event.isTrusted || event.key !== "Enter" || !currentSurface) return
  if (event.target instanceof Element && fields.has(event.target)) submitted("enter")
}

// Clicks inside cross-origin widgets (Google's GSI button iframe) are invisible
// to the page, but focus moving into the iframe is not.
function onBlur() {
  window.setTimeout(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLIFrameElement) || !currentSurface) return
    let node: Element | null = active
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const role = controls.get(node)
      if (role?.type === "provider") {
        action({ kind: "provider", provider: role.provider, via: "widget" })
        return
      }
    }
    if (/accounts\.google\.com\/gsi/.test(active.src)) action({ kind: "provider", provider: "google", via: "widget" })
  }, 0)
}

// ---- WebAuthn / FedCM reports from the MAIN-world hook ------------------------

// Reports arrive over the private MessagePort from passkey-hook.ts, so pages
// can't inject fake ones the way they could with DOM events.
function onCredentials(raw: unknown) {
  const detail = raw as any
  if (!detail || typeof detail !== "object") return
  if (detail?.kind === "passkey") {
    const conditional = detail.mediation === "conditional"
    if (detail.phase === "start") {
      if (conditional && !passkeyAutofill) {
        passkeyAutofill = true
        lastSignature = ""
        scheduleScan()
      }
      return
    }
    // A conditional request is aborted whenever the person types a password instead.
    if (conditional && detail.result !== "ok") return
    // These events can be forged by the page, so every field is checked against
    // what WebAuthn itself allows. The rpId must be this host or a parent of it.
    const rpId = typeof detail.rpId === "string" ? detail.rpId.toLowerCase() : undefined
    const host = location.hostname.toLowerCase()
    const validRp = rpId && isHostname(rpId) && (host === rpId || host.endsWith("." + rpId))
    action({
      kind: "passkey",
      op: detail.op === "create" ? "create" : "get",
      mediation: MEDIATIONS.includes(detail.mediation) ? detail.mediation : undefined,
      userVerification: USER_VERIFICATIONS.includes(detail.userVerification) ? detail.userVerification : undefined,
      rpId: validRp ? safeHost(rpId) : undefined,
      hasAllowList: typeof detail.hasAllowList === "boolean" ? detail.hasAllowList : undefined,
      result: detail.result === "ok" ? "ok" : detail.result === "cancelled" ? "cancelled" : "error",
    })
  } else if (detail?.kind === "fedcm" && Array.isArray(detail.hosts)) {
    const providers = detail.hosts.map((h: unknown) => (typeof h === "string" ? idpForHost(h) : undefined)).filter(Boolean) as Provider[]
    if (detail.phase === "start") {
      for (const p of providers) fedcmProviders.add(p)
      lastSignature = ""
      scheduleScan()
    } else if (detail.result === "ok" && providers[0]) {
      action({ kind: "provider", provider: providers[0], via: "fedcm" })
    }
  }
}

// ---- Boot ---------------------------------------------------------------------

// Embedded IdP widgets (Google's GSI button, Sign in with Apple) live in iframes
// on other sites. The parent page reports them; the iframe itself stays silent.
const embeddedIdp = !isTop && isDedicatedIdpHost(location.hostname)

if (!embeddedIdp) {
  initAutofill({ targets: () => fillTargets, submit: () => submitControl, providerButton: (p) => providerButtons.get(p) })
  initDialogs()
  initPasskeyChannel(onCredentials)
  document.addEventListener("input", onInput, true)
  document.addEventListener("change", onInput, true)
  document.addEventListener("click", onClick, true)
  document.addEventListener("submit", onSubmit, true)
  document.addEventListener("keydown", onKeydown, true)
  window.addEventListener("blur", onBlur)

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true })
  else start()
}
