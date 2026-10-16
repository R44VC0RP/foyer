// Foyer dashboard: Logins (the learned dataset), Password managers, Privacy & data.

import type { StatusReply } from "./autofill/messages"
import { parseDataset, toExport } from "./shared/dataset"
import type { ProviderInfoV2 } from "./shared/protocol"
import { allSites, clearSites, deleteSite, getSettings, importSites, setSettings } from "./shared/store"
import type { Action, Settings, SiteRecipe } from "./shared/types"
import { h, icon, ICONS, mainFlow, methodIcon, offerLabel, otherOffers, providerName, svg, trailSteps, trailView, describeFlow } from "./ui"

const DOCS = "https://github.com/R44VC0RP/foyer/blob/main/docs/PROVIDERS.md"
type Page = "logins" | "managers" | "privacy"

const root = document.getElementById("app")!
const expanded = new Set<string>()
let filter = ""
let flashTimer: ReturnType<typeof setTimeout> | undefined

const page = (): Page => {
  const p = location.hash.slice(1)
  return p === "managers" || p === "privacy" ? p : "logins"
}

function flash(el: HTMLElement, message: string) {
  el.textContent = message
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (el.textContent = ""), 4000)
}

// ---- Data actions ---------------------------------------------------------------

async function exportDataset() {
  const data = toExport(await allSites())
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const a = h("a", { href: URL.createObjectURL(blob), download: `logins-${data.exportedAt}.foyer.json` })
  a.click()
  URL.revokeObjectURL(a.href)
}

function importButton(note: HTMLElement): HTMLElement[] {
  const input = h("input", { type: "file", accept: ".json,application/json", hidden: "" })
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const count = await importSites(parseDataset(JSON.parse(await file.text())))
      flash(note, `Merged ${count} site${count === 1 ? "" : "s"}.`)
      render()
    } catch (err) {
      flash(note, `Import failed: ${(err as Error).message}`)
    }
  }
  const button = h("button", { class: "btn" }, "Import")
  button.onclick = () => input.click()
  return [button, input]
}

// ---- Logins ----------------------------------------------------------------------

const ROLE_LABEL: Record<string, string> = { username: "Username", email: "Email", phone: "Phone", password: "Password", otp: "Code" }

function detailLines(site: SiteRecipe) {
  const flow = mainFlow(site)
  const lines: Array<{ path: string; role: string; selector: string }> = []
  for (const step of flow?.steps ?? [])
    for (const a of step.actions as Action[]) {
      if (a.kind === "fill") lines.push({ path: `${step.host}${step.path}`, role: ROLE_LABEL[a.role] ?? a.role, selector: a.selector })
      else if (a.kind === "provider") lines.push({ path: `${step.host}${step.path}`, role: providerName(a.provider), selector: a.selector ?? (a.via === "fedcm" ? "One Tap" : "button") })
      else if (a.kind === "passkey" && a.result !== "cancelled") lines.push({ path: `${step.host}${step.path}`, role: "Passkey", selector: a.mediation === "conditional" ? "autofill" : "dialog" })
      else if (a.kind === "choose") lines.push({ path: `${step.host}${step.path}`, role: a.intent === "magic-link" ? "Magic link" : "Passkey", selector: a.selector })
    }
  return { flow, lines: lines.slice(0, 10) }
}

function siteRows(site: SiteRecipe): HTMLElement[] {
  const flow = mainFlow(site)
  const steps = flow ? trailSteps(flow) : []
  const open = expanded.has(site.domain)
  const row = h(
    "button",
    { class: "site-row", "aria-expanded": String(open) },
    h("span", { class: "c-site ellipsis" }, site.domain),
    h("span", { class: "c-trail" }, steps.length ? trailView(steps, true) : h("span", { class: "muted small" }, "Seen, not signed in yet")),
    h("span", { class: "c-offers" }, ...otherOffers(site, flow).slice(0, 4).map((m) => h("span", { class: "icon-box", title: offerLabel(m) }, methodIcon(m)))),
    h("span", { class: "c-seen" }, flow ? `${flow.seen}×` : "—"),
  )
  row.onclick = () => {
    if (open) expanded.delete(site.domain)
    else expanded.add(site.domain)
    render()
  }
  if (!open) return [row]

  const { lines } = detailLines(site)
  const copy = h("button", { class: "link" }, "Copy recipe")
  copy.onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(toExport([site]).sites[site.domain], null, 2))
    copy.textContent = "Copied"
    setTimeout(() => (copy.textContent = "Copy recipe"), 1500)
  }
  const remove = h("button", { class: "link danger" }, "Delete site")
  remove.onclick = async () => {
    if (!confirm(`Forget everything Foyer learned about ${site.domain}?`)) return
    expanded.delete(site.domain)
    await deleteSite(site.domain)
    render()
  }
  const detail = h(
    "div",
    { class: "detail" },
    ...(lines.length
      ? lines.map((l, i) =>
          h(
            "div",
            { class: "detail-step" },
            h("span", { class: "n" }, String(i + 1)),
            h("span", { class: "detail-path ellipsis" }, l.path),
            h("span", { class: "detail-role" }, l.role),
            h("span", { class: "detail-selector ellipsis" }, l.selector),
          ),
        )
      : [h("p", { class: "muted small" }, "Foyer has seen this site's login screen but not a sign-in yet.")]),
    h(
      "div",
      { class: "detail-foot" },
      h("span", {}, flow ? `${describeFlow(flow)} Last seen ${site.updatedAt.slice(0, 7)}.` : `Last seen ${site.updatedAt.slice(0, 7)}.`),
      h("span", { class: "actions" }, copy, remove),
    ),
  )
  return [row, detail]
}

async function loginsPage(): Promise<HTMLElement[]> {
  const sites = await allSites()
  const shown = filter ? sites.filter((s) => s.domain.includes(filter)) : sites
  const note = h("span", { class: "flash" })
  const search = h("input", { type: "search", placeholder: "Filter sites", value: filter, "aria-label": "Filter sites" })
  search.oninput = () => {
    filter = search.value.trim().toLowerCase()
    void render().then(() => {
      const next = document.querySelector<HTMLInputElement>(".search input")
      next?.focus()
      next?.setSelectionRange(next.value.length, next.value.length)
    })
  }
  const exportBtn = h("button", { class: "btn primary" }, "Export")
  exportBtn.onclick = exportDataset

  return [
    h(
      "div",
      { class: "page-head" },
      h("div", {}, h("h1", {}, "Logins"), h("p", { class: "muted" }, `How ${sites.length} site${sites.length === 1 ? "" : "s"} sign you in, learned as you go. Structure only: never what you type.`)),
      h("div", { class: "actions" }, note, h("label", { class: "search" }, icon("search"), search), ...importButton(note), exportBtn),
    ),
    h(
      "div",
      { class: "card table" },
      h("div", { class: "cols" }, h("span", { class: "c-site" }, "Site"), h("span", { class: "c-trail" }, "How you sign in"), h("span", { class: "c-offers" }, "Also offers"), h("span", { class: "c-seen" }, "Seen")),
      ...(shown.length
        ? shown.flatMap(siteRows)
        : [h("div", { class: "table-empty" }, sites.length ? "No sites match." : "Nothing learned yet. Sign in to a site as usual and it shows up here.")]),
    ),
  ]
}

// ---- Password managers --------------------------------------------------------------

const BEHAVIOUR: Array<[keyof Settings, string, string]> = [
  ["autofill", "Offer accounts on login fields", "Click into a login field to see your saved accounts for that site."],
  ["savePrompts", "Offer to save", "After you sign in or sign up, save the new login or the changed password."],
  ["passkeys", "Passkeys", "Create and use passkeys kept in your password manager. You can always use the browser instead."],
  ["autosubmit", "Press sign in after filling", "Submits the form for you. Off by default."],
]

function providerLogo(p: ProviderInfoV2): HTMLElement {
  if (p.id === "1password" || p.name === "1Password") return h("span", { class: "provider-logo", style: "background:#0572EC" }, "1")
  if (p.id.startsWith("bitwarden")) return h("span", { class: "provider-logo", style: "background:#175DDC" }, "B")
  if (p.id.startsWith("ext:")) return h("span", { class: "provider-logo any" }, "ext")
  if (p.id.startsWith("demo")) return h("span", { class: "provider-logo", style: "background:var(--moss)" }, svg(ICONS.foyer))
  return h("span", { class: "provider-logo any" }, "{ }")
}

const CAP_LABEL: Record<string, string> = { fill: "fills", save: "saves", passkeys: "passkeys", sso: "sign-in methods" }

function switchRow(key: keyof Settings, title: string, sub: string, settings: Settings, invert = false): HTMLElement {
  const box = h("input", { type: "checkbox", class: "switch", id: `s-${key}`, "aria-label": title })
  box.checked = invert ? !settings[key] : settings[key]
  box.onchange = () => setSettings({ [key]: invert ? !box.checked : box.checked })
  return h("label", { class: "row", for: `s-${key}` }, h("span", { class: "row-text" }, h("span", { class: "row-title" }, title), h("span", { class: "row-sub" }, sub)), box)
}

async function managersPage(): Promise<HTMLElement[]> {
  const [settings, status] = await Promise.all([
    getSettings(),
    chrome.runtime.sendMessage({ type: "af:status" }).catch(() => null) as Promise<StatusReply | null>,
  ])
  const providers = (status?.providers ?? []) as ProviderInfoV2[]
  const providerRows = providers.map((p) => {
    const caps = (p.capabilities ?? []).filter((c) => CAP_LABEL[c]).map((c) => CAP_LABEL[c])
    const sub = p.status === "ready" ? (caps.length ? `Ready · ${caps.join(", ")}` : "Ready") : p.detail ?? (p.status === "locked" ? "Locked: unlock it to connect" : "Not available")
    const label = p.status === "ready" ? "Connected" : p.status === "locked" ? "Locked" : "Not set up"
    return h("div", { class: "row" }, providerLogo(p), h("div", { class: "row-text" }, h("div", { class: "row-title" }, p.name), h("div", { class: "row-sub" }, sub)), h("span", { class: `status${p.status === "ready" ? " on" : ""}` }, label))
  })
  if (!status?.connected)
    providerRows.unshift(
      h(
        "div",
        { class: "row" },
        h("span", { class: "provider-logo any" }, "!"),
        h("div", { class: "row-text" }, h("div", { class: "row-title" }, "Bridge not installed"), h("div", { class: "row-sub" }, "Run ", h("code", { class: "mono" }, "bun run bridge:install"), " in the Foyer folder, then reload Foyer.")),
        h("span", { class: "status" }, "Not connected"),
      ),
    )
  const guide = h("a", { class: "link", href: DOCS, target: "_blank", rel: "noreferrer" }, "Read the guide →")
  providerRows.push(
    h("div", { class: "row" }, h("span", { class: "provider-logo any" }, "{ }"), h("div", { class: "row-text" }, h("div", { class: "row-title" }, "Bring your own"), h("div", { class: "row-sub" }, "Any program or browser extension that speaks the Foyer protocol")), guide),
  )

  const { extensionProviders = [] } = (await chrome.storage.local.get("extensionProviders")) as { extensionProviders?: string[] }
  const note = h("span", { class: "flash" })
  const extInput = h("input", { type: "text", placeholder: "Paste an extension id (32 letters, a–p)", spellcheck: "false", "aria-label": "Extension id" })
  const allow = h("button", { class: "btn" }, "Allow")
  allow.onclick = async () => {
    const id = extInput.value.trim()
    if (!/^[a-p]{32}$/.test(id)) return flash(note, "That isn't an extension id.")
    await chrome.storage.local.set({ extensionProviders: [...new Set([...extensionProviders, id])] })
    render()
  }
  const extRows = extensionProviders.map((id) => {
    const remove = h("button", { class: "link danger" }, "Remove")
    remove.onclick = async () => {
      await chrome.storage.local.set({ extensionProviders: extensionProviders.filter((x) => x !== id) })
      render()
    }
    return h("div", { class: "row" }, h("span", { class: "row-text mono" }, id), remove)
  })

  return [
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Password managers"), h("p", { class: "muted" }, "Foyer fills, saves and signs in with these. It never keeps a password itself."))),
    h("div", { class: "card rows" }, ...providerRows),
    h("div", { class: "group" }, h("div", { class: "label" }, "What Foyer does"), h("div", { class: "card rows" }, ...BEHAVIOUR.map(([k, t, s]) => switchRow(k, t, s, settings)))),
    h(
      "div",
      { class: "group" },
      h("div", { class: "group-head" }, h("div", { class: "label" }, "Allowed extensions"), h("span", { class: "muted small" }, "Can act as a password manager and read a page's login recipe")),
      h("div", { class: "card rows" }, ...extRows, h("div", { class: "input-row" }, extInput, note, allow)),
    ),
  ]
}

// ---- Privacy & data ------------------------------------------------------------------

async function privacyPage(): Promise<HTMLElement[]> {
  const settings = await getSettings()
  const { neverSave = [] } = (await chrome.storage.local.get("neverSave")) as { neverSave?: string[] }
  const note = h("span", { class: "flash" })
  const exportBtn = h("button", { class: "btn" }, "Export")
  exportBtn.onclick = exportDataset
  const clear = h("button", { class: "btn", style: "color:var(--rust)" }, "Clear all")
  clear.onclick = async () => {
    if (!confirm("Delete every site Foyer has learned? This can't be undone.")) return
    await clearSites()
    flash(note, "Cleared.")
    render()
  }
  const neverRows = neverSave.map((d) => {
    const remove = h("button", { class: "link" }, "Allow again")
    remove.onclick = async () => {
      await chrome.storage.local.set({ neverSave: neverSave.filter((x) => x !== d) })
      render()
    }
    return h("div", { class: "row" }, h("span", { class: "row-text mono" }, d), remove)
  })

  return [
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Privacy & data"), h("p", { class: "muted" }, "What Foyer keeps, and what it never does."))),
    h(
      "div",
      { class: "card rows" },
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "prose" },
          h("p", {}, h("strong", {}, "Learned logins are structure only. "), "Field roles, selectors, button kinds and the order you used them. Never what you type, page text, query strings or account names. Exports round dates to the month."),
          h("p", {}, h("strong", {}, "Passwords never stay in Foyer. "), "They pass between your password manager and the page only when you pick an account or agree to save, and live in memory only."),
          h("p", {}, h("strong", {}, "Everything is local. "), "Nothing is sent anywhere unless you export it. Incognito windows are never recorded."),
        ),
      ),
    ),
    h("div", { class: "group" }, h("div", { class: "label" }, "Learning"), h("div", { class: "card rows" }, switchRow("paused", "Learn how sites sign in", "Add sign-in structure to your logins as you browse. Autofill keeps working either way.", settings, true))),
    ...(neverRows.length ? [h("div", { class: "group" }, h("div", { class: "label" }, "Never offer to save on"), h("div", { class: "card rows" }, ...neverRows))] : []),
    h(
      "div",
      { class: "group" },
      h("div", { class: "label" }, "Your data"),
      h(
        "div",
        { class: "card rows" },
        h(
          "div",
          { class: "row" },
          h("div", { class: "row-text" }, h("div", { class: "row-title" }, "Learned logins"), h("div", { class: "row-sub" }, "Export to share with others, import theirs to merge, or start over.")),
          note,
          ...importButton(note),
          exportBtn,
          clear,
        ),
      ),
    ),
  ]
}

// ---- Shell --------------------------------------------------------------------------------

async function render() {
  const [sites, settings, status] = await Promise.all([
    allSites(),
    getSettings(),
    chrome.runtime.sendMessage({ type: "af:status" }).catch(() => null) as Promise<StatusReply | null>,
  ])
  const ready = (status?.providers ?? []).filter((p) => p.status === "ready").length
  const current = page()
  const link = (id: Page, label: string, count?: number) =>
    h("a", { href: `#${id}`, ...(current === id ? { "aria-current": "page" } : {}) }, h("span", {}, label), count !== undefined ? h("span", { class: "count" }, String(count)) : null)
  const content = current === "managers" ? await managersPage() : current === "privacy" ? await privacyPage() : await loginsPage()

  root.replaceChildren(
    h(
      "div",
      { class: "shell" },
      h(
        "nav",
        { class: "sidebar" },
        h("div", { class: "brand" }, svg(ICONS.foyer), "Foyer"),
        h("div", { class: "nav" }, link("logins", "Logins", sites.length), link("managers", "Password managers", ready), link("privacy", "Privacy & data")),
        h("div", { class: "sidebar-foot" }, h("span", { class: `dot-status${settings.paused ? " off" : ""}` }, settings.paused ? "Learning paused" : "Learning on"), h("span", { class: "mono muted", style: "font-size:11px" }, `v${chrome.runtime.getManifest().version}`)),
      ),
      h("main", { class: "page" }, ...content),
    ),
  )
}

window.addEventListener("hashchange", () => void render())
chrome.storage.onChanged.addListener((changes, area) => {
  // Don't yank the page while someone is typing in it.
  if (area === "local" && !(document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "checkbox")) void render()
})

void render()
