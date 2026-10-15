// Offer-to-save support. When the user submits a login form, hand what they
// typed to the background so it can offer to save it to their password
// manager once the login succeeds.
//
// This is the one place Foyer reads field values, and only when saving is on
// and a password manager that accepts saves is connected. Values go straight
// to the background's memory, never to storage, and are dropped after a few
// minutes or as soon as the user answers the prompt.

import type { FillTarget } from "./fill"

let enabled: { value: boolean; at: number } | null = null

async function savingEnabled(): Promise<boolean> {
  if (enabled && Date.now() - enabled.at < 30_000) return enabled.value
  const reply = (await chrome.runtime.sendMessage({ type: "sv:enabled" }).catch(() => null)) as { enabled?: boolean } | null
  enabled = { value: !!reply?.enabled, at: Date.now() }
  return enabled.value
}

const IDENTIFIER = new Set(["username", "email", "phone"])

export function captureOnSubmit(targets: FillTarget[]) {
  const ident = targets.find((t) => IDENTIFIER.has(t.role) && t.el.value)?.el.value
  const password = targets.find((t) => t.role === "password" && t.el.value)?.el.value
  if (!ident && !password) return
  const send = () => void chrome.runtime.sendMessage({ type: "sv:capture", username: ident, password }).catch(() => {})
  // Send synchronously when we already know saving is on: the page may be
  // navigating away this very moment.
  if (enabled?.value) send()
  else if (!enabled) void savingEnabled().then((on) => on && send())
}

/** Warm the cache on login pages so the submit handler doesn't race navigation. */
export function primeCapture() {
  void savingEnabled()
}
