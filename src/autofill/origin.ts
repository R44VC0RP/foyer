// Where credentials may go, decided from the browser's record of the sender.

/**
 * The sender's real origin. Sandboxed frames report the site's URL but have an
 * opaque origin ("null"); sites sandbox exactly the content they don't trust,
 * so those get nothing.
 */
export function senderOrigin(sender: chrome.runtime.MessageSender): URL | null {
  if (!sender.url || !sender.origin || sender.origin === "null") return null
  const url = new URL(sender.url)
  return url.origin === sender.origin ? url : null
}

/** Only https pages (and local development hosts) get credentials. */
export function fillableOrigin(url: URL): boolean {
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  const h = url.hostname
  return h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost") || h.endsWith(".test")
}
