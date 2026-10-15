import { parseDataset, toExport } from "./shared/dataset"
import { allSites, clearSites, deleteSite, importSites } from "./shared/store"
import type { SiteRecipe } from "./shared/types"
import { flowView, h, methodLabel, offersView } from "./ui"

const root = document.getElementById("app")!
const status = h("span", { class: "muted" })
let filter = ""

function flash(message: string) {
  status.textContent = message
  setTimeout(() => (status.textContent = ""), 4000)
}

async function exportDataset() {
  const data = toExport(await allSites())
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const a = h("a", { href: URL.createObjectURL(blob), download: `logins-${data.exportedAt}.foyer.json` })
  a.click()
  URL.revokeObjectURL(a.href)
}

async function importDataset(file: File) {
  try {
    const sites = parseDataset(JSON.parse(await file.text()))
    const count = await importSites(sites)
    flash(`Merged ${count} site${count === 1 ? "" : "s"}.`)
    render()
  } catch (err) {
    flash(`Import failed: ${(err as Error).message}`)
  }
}

function siteRow(site: SiteRecipe): HTMLElement {
  const methods = [...new Set(site.flows.map((f) => methodLabel(f.method)))].join(", ") || "—"
  const remove = h("button", { class: "ghost danger small" }, "Delete")
  remove.onclick = async (e) => {
    e.preventDefault()
    await deleteSite(site.domain)
    render()
  }
  const details = h(
    "details",
    { class: "site" },
    h(
      "summary",
      {},
      h("strong", {}, site.domain),
      offersView(site),
      h("span", { class: "muted" }, `used: ${methods}`),
      h("span", { class: "muted" }, site.updatedAt),
      remove,
    ),
    h("div", { class: "site-body" }, ...site.flows.map(flowView), h("pre", {}, JSON.stringify(site, null, 2))),
  )
  return details
}

async function render() {
  const sites = await allSites()
  const shown = filter ? sites.filter((s) => s.domain.includes(filter)) : sites
  const flows = sites.reduce((n, s) => n + s.flows.length, 0)

  const exportBtn = h("button", {}, "Export")
  exportBtn.onclick = exportDataset
  const fileInput = h("input", { type: "file", accept: ".json,application/json", hidden: "" })
  fileInput.onchange = () => fileInput.files?.[0] && importDataset(fileInput.files[0])
  const importBtn = h("button", { class: "ghost" }, "Import")
  importBtn.onclick = () => fileInput.click()
  const clearBtn = h("button", { class: "ghost danger" }, "Clear all")
  clearBtn.onclick = async () => {
    if (!confirm("Delete every recorded site? This can't be undone.")) return
    await clearSites()
    render()
  }
  const search = h("input", { type: "search", placeholder: "Filter domains", value: filter })
  search.oninput = () => {
    filter = search.value.trim().toLowerCase()
    render().then(() => {
      const next = document.querySelector<HTMLInputElement>("input[type=search]")
      next?.focus()
      next?.setSelectionRange(next.value.length, next.value.length)
    })
  }

  root.replaceChildren(
    h(
      "header",
      {},
      h("div", {}, h("h1", {}, "Foyer dataset"), h("div", { class: "muted" }, `${sites.length} sites · ${flows} login flows`)),
      h("div", { class: "row" }, status, search, importBtn, fileInput, exportBtn, clearBtn),
    ),
    h(
      "p",
      { class: "muted note" },
      "Only structure is stored: field roles, selectors, button kinds and the order you used them. Never values, page text, query strings or account names. Exports round dates to the month.",
    ),
    shown.length
      ? h("div", { class: "sites" }, ...shown.map(siteRow))
      : h("p", { class: "muted" }, sites.length ? "No matches." : "Nothing recorded yet. Log in somewhere as usual."),
  )
}

chrome.storage.onChanged.addListener((_, area) => {
  if (area === "local" && !document.querySelector("details[open]")) render()
})

render()
