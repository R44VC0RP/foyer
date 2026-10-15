// Foyer dialog: passkey sign-in, passkey creation and save prompts. Runs as an
// extension page in an iframe, so the site can't read it or click it.

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
      visible = e.isVisible ?? e.isIntersecting
    },
    { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  ).observe(document.body)
} catch {
  visible = true
}

function choose(choice: Choice) {
  if (!visible && choice.action !== "cancel" && choice.action !== "later") return
  void send({ type: "dg:choose", token, choice })
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string | null | false>) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const k of kids) if (k) e.append(k)
  return e
}

function button(label: string, kind: "primary" | "ghost", onClick: () => void) {
  const b = el("button", { class: kind, type: "button" }, label)
  b.addEventListener("click", (e) => e.isTrusted && onClick())
  return b
}

function providerPicker(providers: Prov[]): { node: HTMLElement | null; value: () => string | undefined } {
  if (providers.length <= 1) return { node: providers[0] ? el("p", { class: "muted" }, `Saves to ${providers[0].name}`) : null, value: () => providers[0]?.id }
  const select = el("select") as HTMLSelectElement
  for (const p of providers) select.append(el("option", { value: p.id }, p.name))
  return { node: el("label", { class: "picker" }, "Save to ", select), value: () => select.value }
}

const SSO_NAMES: Record<string, string> = { sso: "single sign-on", x: "X", github: "GitHub", gitlab: "GitLab", linkedin: "LinkedIn" }
const ssoName = (p: string) => SSO_NAMES[p] ?? p[0].toUpperCase() + p.slice(1)

function header(title: string, sub?: string) {
  return el("header", {}, el("img", { src: "icons/icon-48.png", alt: "" }), el("div", {}, el("h1", {}, title), sub ? el("p", { class: "muted" }, sub) : null))
}

function render(mode: string, data: any) {
  const body: HTMLElement[] = []
  if (mode === "passkey-get") {
    body.push(header("Sign in with a passkey", data.rpId))
    const list = el("div", { class: "list" })
    for (const a of data.accounts as Array<{ provider: string; ref: string; title: string; username?: string }>) {
      const row = el("button", { class: "account", type: "button" }, el("strong", {}, a.username || a.title), el("span", { class: "muted" }, a.provider))
      row.addEventListener("click", (e) => e.isTrusted && choose({ action: "use", provider: a.provider, ref: a.ref }))
      list.append(row)
    }
    body.push(list, el("footer", {}, button("Use another device", "ghost", () => choose({ action: "fallback" })), button("Cancel", "ghost", () => choose({ action: "cancel" }))))
  } else if (mode === "passkey-create") {
    body.push(header("Save a passkey", `${data.userName || "Your account"} on ${data.rpId}`))
    if (data.alreadyRegistered) body.push(el("p", { class: "warn" }, "You already have a passkey for this account in your password manager."))
    const picker = providerPicker(data.providers)
    if (picker.node) body.push(picker.node)
    body.push(
      el(
        "footer",
        {},
        button("Use browser instead", "ghost", () => choose({ action: "fallback" })),
        button("Cancel", "ghost", () => choose({ action: "cancel" })),
        data.alreadyRegistered ? null : button("Save passkey", "primary", () => choose({ action: "save", provider: picker.value() })),
      ),
    )
  } else if (mode === "save-login") {
    body.push(header(data.update ? "Update saved password?" : "Save this login?", `${data.username} on ${data.domain}`))
    const picker = providerPicker(data.providers)
    if (picker.node) body.push(picker.node)
    body.push(
      el(
        "footer",
        {},
        button("Never for this site", "ghost", () => choose({ action: "never" })),
        button("Not now", "ghost", () => choose({ action: "later" })),
        button(data.update ? "Update" : "Save", "primary", () => choose({ action: "save", provider: picker.value() })),
      ),
    )
  } else if (mode === "save-sso") {
    body.push(header(`Remember Sign in with ${ssoName(data.sso)}?`, `Next time on ${data.domain}, Foyer offers it in the login menu.`))
    const picker = providerPicker(data.providers)
    if (picker.node) body.push(picker.node)
    body.push(
      el(
        "footer",
        {},
        button("Never for this site", "ghost", () => choose({ action: "never" })),
        button("Not now", "ghost", () => choose({ action: "later" })),
        button("Remember", "primary", () => choose({ action: "save", provider: picker.value() })),
      ),
    )
  }
  root.replaceChildren(...body)
  void send({ type: "dg:size", token, height: document.documentElement.scrollHeight })
}

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
