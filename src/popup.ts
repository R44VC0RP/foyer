// Toolbar popup: this site's accounts first, then how the site signs you in.

import type { TabAccountsReply } from "./autofill/messages"
import { registrableDomain } from "./shared/domains"
import type { AccountV2 } from "./shared/protocol"
import { getSettings, getSite, setSettings } from "./shared/store"
import { describeFlow, h, icon, mainFlow, methodIcon, offerLabel, otherOffers, providerName, svg, ICONS, trailSteps, trailView } from "./ui"

const root = document.getElementById("app")!

function badgeFor(a: AccountV2): HTMLElement {
  if (a.kind === "passkey") return h("span", { class: "badge soft" }, icon("key"))
  if (a.kind === "sso") return h("span", { class: "badge plain" }, a.sso === "google" ? icon("google") : a.sso === "apple" ? icon("apple") : providerName(a.sso ?? "").slice(0, 1))
  return h("span", { class: "badge" }, (a.title || a.username || "?").trim().slice(0, 1).toUpperCase())
}

function accountRow(a: AccountV2, tabId: number, primary: boolean): HTMLElement {
  const kind = a.kind ?? "password"
  const title = kind === "sso" ? `Sign in with ${providerName(a.sso ?? "")}` : kind === "passkey" ? "Passkey" : a.title
  const detail =
    kind === "passkey"
      ? `${a.username ?? a.title} · used when the site asks`
      : kind === "sso"
        ? "Saved sign-in method"
        : [a.username, a.hasTotp ? "2FA code" : ""].filter(Boolean).join(" · ")
  const row = h(
    "div",
    { class: `account${primary ? " selected" : ""}` },
    badgeFor(a),
    h("div", { class: "account-text" }, h("div", { class: "account-title ellipsis" }, title), h("div", { class: "account-sub ellipsis" }, detail)),
  )
  if (kind !== "passkey") {
    const button = h("button", { class: `btn${primary ? " primary" : ""}` }, kind === "sso" ? "Use" : "Fill")
    button.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "af:tab-fill", tabId, provider: a.provider, ref: a.ref })
      window.close()
    }
    row.append(button)
  }
  return row
}

async function accountsSection(tabId: number): Promise<{ section: HTMLElement; status: string }> {
  const reply = (await chrome.runtime.sendMessage({ type: "af:tab-accounts", tabId }).catch(() => null)) as TabAccountsReply | null
  const head = (right?: string) => h("div", { class: "section-head" }, h("div", { class: "label" }, "Accounts"), right ? h("div", { class: "muted small" }, right) : null)
  if (!reply?.connected) {
    const setup = h("button", { class: "link" }, "Connect a password manager →")
    setup.onclick = () => openDashboard("managers")
    return {
      status: "No password manager connected",
      section: h("section", { class: "section" }, head(), h("div", { class: "card empty" }, h("p", {}, "Foyer fills and saves logins with your own password manager."), setup)),
    }
  }
  const ready = reply.providers.filter((p) => p.status === "ready").map((p) => p.name)
  const status = ready.length ? `${ready.join(", ")} connected` : "Password manager locked"
  if (!reply.accounts.length) {
    const msg = reply.errors.length ? reply.errors.map((e) => e.message).join(" · ") : "No saved logins for this site yet. Sign in and Foyer will offer to save it."
    return { status, section: h("section", { class: "section" }, head(), h("div", { class: "card empty" }, h("p", {}, msg))) }
  }
  const firstFillable = reply.accounts.findIndex((a) => (a.kind ?? "password") !== "passkey")
  return {
    status,
    section: h(
      "section",
      { class: "section" },
      head("⌥⇧F fills the first"),
      h("div", { class: "card list" }, ...reply.accounts.map((a, i) => accountRow(a, tabId, i === firstFillable))),
    ),
  }
}

function openDashboard(page = "") {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${page ? `#${page}` : ""}`) })
  window.close()
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url) : undefined
  const domain = url ? registrableDomain(url.hostname) : undefined
  const settings = await getSettings()

  const settingsButton = h("button", { class: "icon-button", title: "Open Foyer", "aria-label": "Open Foyer" }, icon("gear"))
  settingsButton.onclick = () => openDashboard()

  const sections: HTMLElement[] = []
  let status = "Open a website to see its sign-in"
  if (domain && tab?.id !== undefined) {
    if (settings.autofill) {
      const accounts = await accountsSection(tab.id)
      status = accounts.status
      sections.push(accounts.section)
    }
    const site = await getSite(domain)
    const flow = site && mainFlow(site)
    if (flow) {
      const steps = trailSteps(flow)
      if (steps.length)
        sections.push(h("section", { class: "section" }, h("div", { class: "label" }, "How you sign in here"), trailView(steps), h("p", { class: "muted small" }, describeFlow(flow))))
    }
    const offers = site ? otherOffers(site, flow) : []
    if (offers.length)
      sections.push(
        h("section", { class: "section" }, h("div", { class: "label" }, "Also offers"), h("div", { class: "chips" }, ...offers.map((m) => h("span", { class: "chip" }, methodIcon(m), offerLabel(m))))),
      )
    if (!site && !settings.autofill)
      sections.push(h("section", { class: "section" }, h("p", { class: "muted" }, "Nothing learned here yet. Sign in as usual and Foyer remembers how.")))
  } else {
    sections.push(h("section", { class: "section" }, h("p", { class: "muted" }, "Open a website's sign-in page to see your accounts and how it signs you in.")))
  }

  const learning = h("input", { type: "checkbox", class: "switch", id: "learning" })
  learning.checked = !settings.paused
  learning.onchange = () => setSettings({ paused: !learning.checked })
  const open = h("button", { class: "link" }, "Open Foyer →")
  open.onclick = () => openDashboard()

  root.replaceChildren(
    h(
      "header",
      { class: "popup-header" },
      h(
        "div",
        { class: "site" },
        h("span", { class: "site-icon" }, svg(ICONS.foyer)),
        h("div", { class: "site-text" }, h("div", { class: "site-domain mono ellipsis" }, domain ?? "Foyer"), h("div", { class: "muted small ellipsis" }, status)),
      ),
      settingsButton,
    ),
    ...sections,
    h("footer", { class: "popup-footer" }, h("label", { class: "toggle", for: "learning" }, learning, "Learning how sites sign in"), open),
  )
}

render()
