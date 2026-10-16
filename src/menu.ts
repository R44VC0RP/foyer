// Inline account menu. Runs as an extension page inside an iframe on the
// login page, so the page can neither read nor click it.

import type { MenuLoadReply } from "./autofill/messages"
import type { AccountV2 as Account } from "./shared/protocol"
import { h, icon, ICONS, providerName, svg } from "./ui"

const token = location.hash.slice(1)
const list = document.getElementById("list")!
const foot = document.getElementById("foot")!
let accounts: Account[] = []
let names: Record<string, string> = {}
let active = 0
let visible = false
let generate = false

function send<T>(message: object): Promise<T | null> {
  return chrome.runtime.sendMessage(message).catch(() => null) as Promise<T | null>
}

// Only accept picks while the menu is actually visible and unobscured, so a
// page can't hide it under something and trick a click into it.
try {
  const observer = new IntersectionObserver(
    (entries) => {
      const e = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean }
      // Unobscured (v2 visibility) and essentially all on screen; sub-pixel
      // heights mean a strict 100% can be unreachable.
      visible = (e.isVisible ?? e.isIntersecting) && e.intersectionRatio >= 0.9
    },
    { threshold: [0, 0.5, 0.9, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  )
  observer.observe(document.body)
} catch {
  visible = true
}

function badge(a: Account): HTMLElement {
  if (a.kind === "passkey") return h("span", { class: "badge soft" }, icon("key"))
  if (a.kind === "sso") {
    const p = a.sso ?? ""
    return h("span", { class: "badge plain" }, p === "google" ? icon("google") : p === "apple" ? icon("apple") : providerName(p).slice(0, 1))
  }
  return h("span", { class: "badge" }, (a.title || a.username || "?").trim().slice(0, 1).toUpperCase())
}

function row(b: HTMLElement, title: string, sub: string, i: number, onPick: () => void): HTMLElement {
  const r = h(
    "button",
    { class: `row${i === active ? " active" : ""}`, type: "button", role: "option" },
    b,
    h("span", { class: "text" }, h("span", { class: "title" }, title), h("span", { class: "sub" }, sub)),
    h("span", { class: "enter", "aria-hidden": "true" }, "↵"),
  )
  r.addEventListener("click", (e) => e.isTrusted && onPick())
  r.addEventListener("mouseenter", () => {
    active = i
    highlight()
  })
  return r
}

function render() {
  list.replaceChildren(
    ...accounts.map((a, i) => {
      const kind = a.kind ?? "password"
      const title = kind === "sso" ? `Sign in with ${providerName(a.sso ?? "")}` : kind === "passkey" ? a.username || a.title : a.title
      const sub = kind === "passkey" ? "Passkey" : kind === "sso" ? "Saved sign-in method" : a.username ?? ""
      return row(badge(a), title, sub, i, () => pick(i))
    }),
  )
}

function renderGenerate() {
  list.replaceChildren(row(h("span", { class: "badge" }, "✱"), "Use a strong password", "20 characters · saved after you sign up", 0, () => pick(0)))
}

function highlight() {
  Array.from(list.children).forEach((el, i) => el.classList.toggle("active", i === active))
  ;(list.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" })
}

function footer(domain: string, right: string) {
  foot.replaceChildren(h("span", { class: "foot-site" }, svg(ICONS.foyer), h("span", { class: "mono" }, domain)), h("span", {}, right))
}

async function pick(i: number) {
  if (!visible) return
  if (generate) {
    footer("", "Filling…")
    const reply = await send<{ ok: boolean }>({ type: "af:menu-generate", token })
    if (!reply?.ok) footer("", "Couldn't fill. Try again.")
    return
  }
  const a = accounts[i]
  if (!a) return
  footer("", "Filling…")
  const reply = await send<{ ok: boolean }>({ type: "af:menu-pick", token, provider: a.provider, ref: a.ref })
  if (!reply?.ok) footer("", "Couldn't fill. Try again from the toolbar.")
}

document.addEventListener("keydown", (e) => {
  const count = generate ? 1 : accounts.length
  if (e.key === "ArrowDown") active = Math.min(active + 1, count - 1)
  else if (e.key === "ArrowUp") active = Math.max(active - 1, 0)
  else if (e.key === "Enter") return void pick(active)
  else if (e.key === "Escape") return void send({ type: "af:menu-dismiss", token })
  else return
  e.preventDefault()
  highlight()
})

async function load() {
  const reply = await send<MenuLoadReply>({ type: "af:menu-load", token })
  if (!reply) {
    footer("", "This menu has expired.")
    return
  }
  accounts = reply.accounts
  names = reply.providerNames ?? {}
  generate = !!reply.generate
  const sources = [...new Set(accounts.map((a) => names[a.provider] ?? a.provider))]
  if (generate) renderGenerate()
  else render()
  footer(reply.domain, generate ? "Foyer" : accounts.length ? `from ${sources.join(", ")}` : "No logins saved here")
  // Keep the frame exactly as tall as the content (fonts load late and change
  // heights): the click guard above only trusts a fully visible menu.
  new ResizeObserver(() => void send({ type: "af:menu-resize", token, height: Math.ceil(document.body.getBoundingClientRect().height) })).observe(document.body)
}

void load()
