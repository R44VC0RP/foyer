import type { Action, FlowRecord, Method, SiteRecipe, Step } from "./shared/types"

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) if (v !== undefined) el.setAttribute(k, v)
  for (const c of children) if (c) el.append(c)
  return el
}

const METHOD_LABEL: Record<string, string> = {
  password: "Password",
  "identifier-first": "Email first",
  passkey: "Passkey",
  "passkey-autofill": "Passkey autofill",
  "magic-link": "Magic link",
  otp: "One-time code",
  unknown: "Unknown",
}

export function methodLabel(m: Method | "unknown"): string {
  if (m.startsWith("sso:")) {
    const p = m.slice(4)
    return p === "sso" ? "SSO" : p === "x" ? "X" : p[0].toUpperCase() + p.slice(1)
  }
  return METHOD_LABEL[m] ?? m
}

export function chip(text: string, tone: "default" | "accent" = "default") {
  return h("span", { class: `chip ${tone}` }, text)
}

function actionLabel(a: Action): string {
  switch (a.kind) {
    case "fill":
      return a.role
    case "provider":
      return `${methodLabel(`sso:${a.provider}`)}${a.via === "fedcm" ? " (One Tap)" : ""}`
    case "choose":
      return a.intent
    case "submit":
      return "submit"
    case "passkey":
      return `passkey ${a.op}${a.mediation === "conditional" ? " (autofill)" : ""}`
    case "redirect":
      return `→ ${a.host}`
  }
}

export function stepSummary(step: Step): string {
  return step.actions.map(actionLabel).join(" · ")
}

export function flowView(flow: FlowRecord): HTMLElement {
  return h(
    "div",
    { class: "flow" },
    h(
      "div",
      { class: "flow-head" },
      h("strong", {}, methodLabel(flow.method)),
      flow.mfa ? chip(`+ ${flow.mfa === "otp" ? "code" : "passkey"}`) : null,
      h("span", { class: "muted" }, `${flow.seen}× · ${flow.outcome}`),
    ),
    h(
      "ol",
      { class: "steps" },
      ...flow.steps.map((s) => h("li", {}, h("code", {}, `${s.host}${s.path}`), h("span", {}, stepSummary(s)))),
    ),
  )
}

export function offersView(site: SiteRecipe): HTMLElement {
  const offers = Object.entries(site.offers).sort((a, b) => (b[1]?.seen ?? 0) - (a[1]?.seen ?? 0))
  return h("div", { class: "chips" }, ...offers.map(([m]) => chip(methodLabel(m as Method))))
}
