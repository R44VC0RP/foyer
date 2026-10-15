// Inline account menu. Runs as an extension page inside an iframe on the
// login page, so the page can neither read nor click it.

import type { MenuLoadReply } from "./autofill/messages"
import type { AccountV2 as Account } from "./shared/protocol"

const SSO_NAMES: Record<string, string> = { sso: "single sign-on", x: "X", github: "GitHub", gitlab: "GitLab", linkedin: "LinkedIn" }
const ssoName = (p: string) => SSO_NAMES[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : "provider")

const token = location.hash.slice(1)
const list = document.getElementById("list")!
const note = document.getElementById("note")!
let accounts: Account[] = []
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
      visible = e.isVisible ?? e.isIntersecting
    },
    { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  )
  observer.observe(document.body)
} catch {
  visible = true
}

function initials(account: Account) {
  const source = account.kind === "sso" ? ssoName(account.sso ?? "") : account.title || account.username || "?"
  return source.trim().slice(0, 1).toUpperCase()
}

function render() {
  list.replaceChildren(
    ...accounts.map((a, i) => {
      const row = document.createElement("button")
      row.className = `row${i === active ? " active" : ""}`
      row.type = "button"
      const badge = document.createElement("span")
      badge.className = "badge"
      badge.textContent = initials(a)
      const text = document.createElement("span")
      text.className = "text"
      const title = document.createElement("span")
      title.className = "title"
      const kind = a.kind ?? "password"
      title.textContent = kind === "sso" ? `Sign in with ${ssoName(a.sso ?? "")}` : kind === "passkey" ? a.username || a.title : a.title
      const sub = document.createElement("span")
      sub.className = "sub"
      sub.textContent = [kind === "passkey" ? "Passkey" : kind === "sso" ? a.title : a.username, a.provider].filter(Boolean).join(" · ")
      text.append(title, sub)
      row.append(badge, text)
      row.addEventListener("click", (e) => {
        if (e.isTrusted) pick(i)
      })
      row.addEventListener("mouseenter", () => {
        active = i
        highlight()
      })
      return row
    }),
  )
}

function highlight() {
  Array.from(list.children).forEach((el, i) => el.classList.toggle("active", i === active))
  ;(list.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" })
}

function renderGenerate() {
  const row = document.createElement("button")
  row.className = "row active"
  row.type = "button"
  const badge = document.createElement("span")
  badge.className = "badge"
  badge.textContent = "✱"
  const text = document.createElement("span")
  text.className = "text"
  const title = document.createElement("span")
  title.className = "title"
  title.textContent = "Use a strong password"
  const sub = document.createElement("span")
  sub.className = "sub"
  sub.textContent = "20 characters · Foyer offers to save it after you sign up"
  text.append(title, sub)
  row.append(badge, text)
  row.addEventListener("click", (e) => {
    if (e.isTrusted) pick(0)
  })
  list.replaceChildren(row)
}

async function pick(i: number) {
  if (!visible) return
  if (generate) {
    note.textContent = "Filling…"
    const reply = await send<{ ok: boolean }>({ type: "af:menu-generate", token })
    if (!reply?.ok) note.textContent = "Couldn't fill. Try again."
    return
  }
  const a = accounts[i]
  if (!a) return
  note.textContent = "Filling…"
  const reply = await send<{ ok: boolean }>({ type: "af:menu-pick", token, provider: a.provider, ref: a.ref })
  if (!reply?.ok) note.textContent = "Couldn't fill. Try again from the toolbar."
}

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") active = Math.min(active + 1, accounts.length - 1)
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
    note.textContent = "Session expired."
    return
  }
  accounts = reply.accounts
  generate = !!reply.generate
  if (generate) {
    note.textContent = `Foyer · ${reply.domain}`
    renderGenerate()
  } else {
    note.textContent = accounts.length ? `Foyer · ${reply.domain}` : `No logins for ${reply.domain}`
    render()
  }
  await send({ type: "af:menu-resize", token, height: document.documentElement.scrollHeight })
}

void load()
