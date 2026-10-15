// Lets password-manager extensions the user allowlisted use what Foyer knows.
// Same allowlist as extension providers (dashboard → Password managers).
//
//   chrome.runtime.sendMessage(FOYER_ID, { type: "foyer.recipe", url: location.href })
//   → { type: "foyer.recipe", recipe: SiteRecipe | null }
//
// Recipes hold no personal data, but which sites have one does say where the
// user logs in, so only allowlisted extensions get answers, one URL at a time.

import { registrableDomain } from "../shared/domains"
import { PROTOCOL_VERSION } from "../shared/protocol"
import { getSite } from "../shared/store"
import { extensionProviders } from "./router"

type External = { type: "foyer.hello" } | { type: "foyer.recipe"; url: string }

async function handle(message: External, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!sender.id || !(await extensionProviders()).includes(sender.id)) return { type: "error", code: "forbidden", message: "Not allowlisted in Foyer" }
  switch (message?.type) {
    case "foyer.hello":
      return { type: "foyer.hello", protocol: PROTOCOL_VERSION, version: chrome.runtime.getManifest().version }
    case "foyer.recipe": {
      let host: string
      try {
        host = new URL(message.url).hostname
      } catch {
        return { type: "error", code: "bad_request", message: "url must be a URL" }
      }
      return { type: "foyer.recipe", recipe: (await getSite(registrableDomain(host))) ?? null }
    }
    default:
      return { type: "error", code: "bad_request", message: "unknown request" }
  }
}

export function registerExternal() {
  chrome.runtime.onMessageExternal.addListener((message: External, sender, sendResponse) => {
    handle(message, sender).then(sendResponse, () => sendResponse({ type: "error", code: "error" }))
    return true
  })
}
