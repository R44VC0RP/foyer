// Small DOM helpers and shared pieces for the popup and dashboard.
// Design source: Paper file "Foyer — Extension UI".

import type { Action, FlowRecord, Method, SiteRecipe } from "./shared/types"

type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) if (v !== undefined) el.setAttribute(k, v)
  for (const c of children) if (c) el.append(c)
  return el
}

/** Static, trusted SVG markup (never built from page or vault data). */
export function svg(markup: string): Element {
  const t = document.createElement("template")
  t.innerHTML = markup.trim()
  return t.content.firstElementChild!
}

export const ICONS = {
  foyer: `<svg viewBox="0 0 512 512"><rect width="512" height="512" rx="114" fill="#3E5A2C"/><path d="M162 512V218a94 94 0 0 1 188 0v294Z" fill="#EEE7D6"/><circle cx="256" cy="300" r="32" fill="#3E5A2C"/><path d="M242 318h28l10 66h-48Z" fill="#3E5A2C"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/></svg>`,
  google: `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7H2.1a11 11 0 0 0 0 10l3.7-2.9z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z"/></svg>`,
  apple: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7a4.6 4.6 0 0 0-3.6-2c-1.5-.2-3 .9-3.7.9-.8 0-2-.9-3.2-.9a4.8 4.8 0 0 0-4 2.5c-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8s1.9.8 3.2.8c1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7 0 0-2.4-1-2.3-3.9zM14 5.4c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`,
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 9h2v6M10 9h3.5L10 15h4M18 9h2.5l-2 3a2 2 0 1 1-1.5 3"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
} as const

export const icon = (name: keyof typeof ICONS) => svg(ICONS[name])

const PROVIDER_NAMES: Record<string, string> = {
  sso: "SSO",
  x: "X",
  github: "GitHub",
  gitlab: "GitLab",
  linkedin: "LinkedIn",
  okta: "Okta",
}

export const providerName = (p: string) => PROVIDER_NAMES[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : "")

const METHOD_LABEL: Record<string, string> = {
  password: "Password",
  "identifier-first": "Email first",
  passkey: "Passkey",
  "passkey-autofill": "Passkey",
  "magic-link": "Magic link",
  otp: "One-time code",
  unknown: "Unknown",
}

export function methodLabel(m: Method | "unknown"): string {
  if (m.startsWith("sso:")) return providerName(m.slice(4))
  return METHOD_LABEL[m] ?? m
}

/** Icon for a sign-in method, for "also offers". */
export function methodIcon(m: string): Element {
  if (m === "sso:google") return icon("google")
  if (m === "sso:apple") return icon("apple")
  if (m === "passkey" || m === "passkey-autofill") return icon("key")
  if (m === "magic-link") return icon("mail")
  if (m === "otp") return icon("code")
  if (m.startsWith("sso:")) return h("span", { class: "mono", style: "font-size:9px;font-weight:600" }, providerName(m.slice(4)).slice(0, 2))
  return icon("lock")
}

function actionStep(a: Action): string | null {
  switch (a.kind) {
    case "fill":
      return a.role === "username" ? "Username" : a.role === "email" ? "Email" : a.role === "phone" ? "Phone" : a.role === "password" ? "Password" : a.role === "otp" ? "Code" : null
    case "provider":
      return providerName(a.provider)
    case "passkey":
      return a.result === "ok" || a.result === undefined ? "Passkey" : null
    case "choose":
      return a.intent === "magic-link" ? "Magic link" : "Passkey"
    default:
      return null
  }
}

/** The steps a person took in a flow, e.g. ["Email", "Password", "Code"]. */
export function trailSteps(flow: FlowRecord): string[] {
  const out: string[] = []
  for (const step of flow.steps)
    for (const a of step.actions) {
      const label = actionStep(a)
      if (label && out[out.length - 1] !== label) out.push(label)
    }
  return out
}

/** Numbered steps joined by dots (popup) or arrows (compact table). */
export function trailView(steps: string[], compact = false): HTMLElement {
  const parts: Node[] = []
  steps.forEach((s, i) => {
    if (i) parts.push(compact ? h("span", { class: "arrow" }, "→") : h("span", { class: "dots" }, h("i"), h("i"), h("i")))
    parts.push(compact ? h("span", { class: "step compact" }, s) : h("span", { class: "step" }, h("span", { class: "n" }, String(i + 1)), s))
  })
  return h("div", { class: "trail" }, ...parts)
}

export function describeFlow(flow: FlowRecord): string {
  if (flow.method === "identifier-first" && flow.mfa === "otp") return `Email first, then a one-time code. Seen ${flow.seen} ${flow.seen === 1 ? "time" : "times"}.`
  const base =
    flow.method === "identifier-first"
      ? "Email first, then password"
      : flow.method.startsWith("sso:")
        ? `Continue with ${providerName(flow.method.slice(4))}`
        : flow.method === "passkey" || flow.method === "passkey-autofill"
          ? "Signs in with a passkey"
          : flow.method === "magic-link"
            ? "Email, then a sign-in link"
            : "Username and password"
  const mfa = flow.mfa === "otp" ? ", then a one-time code" : flow.mfa === "passkey" ? ", then a passkey" : ""
  return `${base}${mfa}. Seen ${flow.seen} ${flow.seen === 1 ? "time" : "times"}.`
}

/** Best flow to show for a site: most seen, completed first. */
export function mainFlow(site: SiteRecipe): FlowRecord | undefined {
  return [...site.flows].sort((a, b) => Number(b.outcome === "completed") - Number(a.outcome === "completed") || b.seen - a.seen)[0]
}

/** Methods the site offers beyond the one the person uses. */
export function otherOffers(site: SiteRecipe, flow?: FlowRecord): string[] {
  const used = new Set<string>()
  if (flow) {
    used.add(flow.method)
    if (flow.method === "identifier-first") used.add("password")
    if (flow.mfa) used.add(flow.mfa)
  }
  return (Object.keys(site.offers) as string[])
    .filter((m) => !used.has(m) && !(m === "passkey-autofill" && used.has("passkey")) && m !== "identifier-first")
    .filter((m, i, all) => !(m === "passkey-autofill" && all.includes("passkey")))
}

export function offerLabel(m: string): string {
  if (m.startsWith("sso:")) return `Sign in with ${providerName(m.slice(4))}`
  return METHOD_LABEL[m] ?? m
}
