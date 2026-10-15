import { emptySite, mergeSite } from "./dataset"
import type { Settings, SiteRecipe } from "./types"

const SITE_PREFIX = "site:"

export const siteKey = (domain: string) => SITE_PREFIX + domain

export async function getSite(domain: string): Promise<SiteRecipe | undefined> {
  const key = siteKey(domain)
  const result = await chrome.storage.local.get(key)
  return result[key] as SiteRecipe | undefined
}

export async function putSite(site: SiteRecipe): Promise<void> {
  await chrome.storage.local.set({ [siteKey(site.domain)]: site })
}

export async function allSites(): Promise<SiteRecipe[]> {
  const all = await chrome.storage.local.get(null)
  return Object.entries(all)
    .filter(([key]) => key.startsWith(SITE_PREFIX))
    .map(([, value]) => value as SiteRecipe)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.domain.localeCompare(b.domain))
}

export async function deleteSite(domain: string): Promise<void> {
  await chrome.storage.local.remove(siteKey(domain))
}

export async function clearSites(): Promise<void> {
  const all = await chrome.storage.local.get(null)
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(SITE_PREFIX)))
}

export async function importSites(sites: SiteRecipe[]): Promise<number> {
  for (const incoming of sites) {
    const current = (await getSite(incoming.domain)) ?? emptySite(incoming.domain)
    await putSite(mergeSite(current, incoming))
  }
  return sites.length
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings")
  return { paused: false, ...(settings as Partial<Settings> | undefined) }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ settings: next })
  return next
}
