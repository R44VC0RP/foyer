import { registrableDomain } from "./shared/domains"
import { deleteSite, getSettings, getSite, setSettings } from "./shared/store"
import { flowView, h, offersView } from "./ui"

const root = document.getElementById("app")!

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url) : undefined
  const domain = url ? registrableDomain(url.hostname) : undefined
  const site = domain ? await getSite(domain) : undefined
  const settings = await getSettings()

  const toggle = h("button", { class: "ghost" }, settings.paused ? "Resume" : "Pause")
  toggle.onclick = async () => {
    await setSettings({ paused: !settings.paused })
    render()
  }
  const open = h("button", {}, "Dataset")
  open.onclick = () => chrome.runtime.openOptionsPage()

  const body: HTMLElement[] = []
  if (!domain) body.push(h("p", { class: "muted" }, "Open a website to see what Foyer knows about its login."))
  else if (!site) body.push(h("p", { class: "muted" }, "No login seen here yet. Visit the sign-in page and log in as usual."))
  else {
    body.push(h("h2", {}, "Offers"), offersView(site))
    body.push(h("h2", {}, `Logins seen (${site.flows.length})`))
    if (site.flows.length) body.push(...site.flows.slice(0, 4).map(flowView))
    else body.push(h("p", { class: "muted" }, "Log in once and the steps you take will show up here."))
    const forget = h("button", { class: "ghost danger" }, "Forget this site")
    forget.onclick = async () => {
      await deleteSite(site.domain)
      render()
    }
    body.push(h("div", { class: "row end" }, forget))
  }

  root.replaceChildren(
    h(
      "header",
      {},
      h("div", {}, h("h1", {}, "Foyer"), h("div", { class: "muted" }, domain ?? "")),
      h("div", { class: "row" }, h("span", { class: `dot ${settings.paused ? "off" : "on"}` }), toggle, open),
    ),
    ...body,
  )
}

render()
