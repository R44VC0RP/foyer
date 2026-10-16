// Foyer dialog: passkey sign-in, passkey creation and save prompts. Runs as an
// extension page in an iframe, so the site can't read it or click it.

import { h, icon, ICONS, providerName, svg } from "./ui"

const token = location.hash.slice(1)
const root = document.getElementById("app")!
let visible = false

type Choice = { action: string; provider?: string; ref?: string }
type Prov = { id: string; name: string }

function send<T>(message: object): Promise<T | null> {
  return chrome.runtime.sendMessage(message).catch(() => null) as Promise<T | null>
}

// Only accept clicks while the dialog is actually visible and unobscured.
try {
  new IntersectionObserver(
    (entries) => {
      const e = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean }
      // Unobscured (v2 visibility) and essentially all on screen.
      visible = (e.isVisible ?? e.isIntersecting) && e.intersectionRatio >= 0.9
    },
    { threshold: [0, 0.5, 0.9, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  ).observe(document.body)
} catch {
  visible = true
}

function choose(choice: Choice) {
  if (!visible && choice.action !== "cancel" && choice.action !== "later") return
  void send({ type: "dg:choose", token, choice })
}

function button(label: string, kind: "primary" | "plain" | "link", onClick: () => void) {
  const b = h("button", { class: kind === "primary" ? "btn primary" : kind === "plain" ? "btn" : "link quiet", type: "button" }, label)
  b.addEventListener("click", (e) => e.isTrusted && onClick())
  return b
}

function header(title: string, sub: string, closable = false) {
  const close = closable ? button("×", "link", () => choose({ action: "later" })) : null
  close?.classList.add("close")
  close?.setAttribute("aria-label", "Close")
  return h("header", {}, svg(ICONS.foyer), h("div", { class: "head-text" }, h("h1", {}, title), h("p", { class: "muted" }, sub)), close)
}

/** "Save to" row: a select when there's a choice, plain text otherwise. */
function saveTo(providers: Prov[]): { node: HTMLElement | null; value: () => string | undefined } {
  if (!providers.length) return { node: null, value: () => undefined }
  if (providers.length === 1)
    return { node: h("div", { class: "box line" }, h("span", { class: "muted" }, "Save to"), h("span", { class: "strong" }, providers[0].name)), value: () => providers[0].id }
  const select = h("select", { "aria-label": "Save to" }) as HTMLSelectElement
  for (const p of providers) select.append(h("option", { value: p.id }, p.name))
  return { node: h("label", { class: "box line" }, h("span", { class: "muted" }, "Save to"), select), value: () => select.value }
}

function footer(left: HTMLElement | null, ...right: HTMLElement[]) {
  return h("footer", {}, left ?? h("span"), h("div", { class: "buttons" }, ...right))
}

function render(mode: string, data: any) {
  const body: Array<HTMLElement | null> = []
  if (mode === "passkey-get") {
    body.push(header("Sign in with a passkey", `${data.rpId} is asking`))
    const list = h("div", { class: "accounts" })
    ;(data.accounts as Array<{ provider: string; ref: string; title: string; username?: string }>).forEach((a, i) => {
      const row = h(
        "button",
        { class: `account${i === 0 ? " active" : ""}`, type: "button" },
        h("span", { class: "badge soft" }, icon("key")),
        h("span", { class: "account-text" }, h("span", { class: "strong" }, a.username || a.title), h("span", { class: "muted" }, a.title && a.username ? a.title : "Passkey")),
        h("span", { class: "go" }, "Sign in"),
      )
      row.addEventListener("click", (e) => e.isTrusted && choose({ action: "use", provider: a.provider, ref: a.ref }))
      list.append(row)
    })
    body.push(list, footer(button("Use a phone or security key", "link", () => choose({ action: "fallback" })), button("Cancel", "plain", () => choose({ action: "cancel" }))))
  } else if (mode === "passkey-create") {
    body.push(header("Save a passkey", `for ${data.userName || "your account"} on ${data.rpId}`))
    if (data.alreadyRegistered) body.push(h("p", { class: "warn" }, "You already have a passkey for this account in your password manager."))
    else body.push(h("p", {}, "Next time, sign in with one click. The private key is kept in your password manager, never in the browser."))
    const to = saveTo(data.providers)
    body.push(to.node)
    body.push(
      footer(
        button("Use the browser instead", "link", () => choose({ action: "fallback" })),
        button("Cancel", "plain", () => choose({ action: "cancel" })),
        ...(data.alreadyRegistered ? [] : [button("Save passkey", "primary", () => choose({ action: "save", provider: to.value() }))]),
      ),
    )
  } else if (mode === "save-login") {
    body.push(header(data.update ? "Update saved password?" : "Save this login?", data.update ? `Your password for ${data.domain} changed` : `You just signed in to ${data.domain}`, true))
    body.push(
      h(
        "div",
        { class: "box" },
        h("div", { class: "line" }, h("span", { class: "muted" }, "Username"), h("span", { class: "strong ellipsis" }, data.username)),
        h("div", { class: "line" }, h("span", { class: "muted" }, data.update ? "New password" : "Password"), h("span", { class: "mono dots" }, "••••••••••••")),
      ),
    )
    const to = saveTo(data.providers)
    body.push(to.node)
    body.push(
      footer(
        button("Never for this site", "link", () => choose({ action: "never" })),
        button("Not now", "plain", () => choose({ action: "later" })),
        button(data.update ? "Update" : "Save", "primary", () => choose({ action: "save", provider: to.value() })),
      ),
    )
  } else if (mode === "save-sso") {
    const name = providerName(data.sso)
    body.push(header(`Remember Sign in with ${name}?`, `Next time on ${data.domain}, Foyer offers it in the login menu`, true))
    const to = saveTo(data.providers)
    body.push(to.node)
    body.push(
      footer(
        button("Never for this site", "link", () => choose({ action: "never" })),
        button("Not now", "plain", () => choose({ action: "later" })),
        button("Remember", "primary", () => choose({ action: "save", provider: to.value() })),
      ),
    )
  }
  root.replaceChildren(...(body.filter(Boolean) as HTMLElement[]))
}

// Keep the frame exactly as tall as the content (fonts load late and change
// heights): clicks only count while the dialog is fully visible.
new ResizeObserver(() => void send({ type: "dg:size", token, height: Math.ceil(document.body.getBoundingClientRect().height) })).observe(document.body)

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") choose({ action: "cancel" })
})

void (async () => {
  const reply = await send<{ mode: string; data: unknown }>({ type: "dg:load", token })
  if (!reply) {
    root.textContent = "This request has expired."
    return
  }
  render(reply.mode, reply.data)
})()
