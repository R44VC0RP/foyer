// Background side of everything that goes *to* a password manager or needs
// the user's say-so: passkey sign-in and creation, saving new or changed
// passwords, and remembering "this site uses Sign in with Google".
//
// Every passkey operation and every save goes through a Foyer dialog (an
// extension page the site can't script). The site's origin and rpId are taken
// from the browser's record of the requesting frame, and clientDataJSON is
// built here, so a page can't obtain a passkey response for another site.

import { registrableDomain } from "../shared/domains"
import type {
  AccountV2,
  CheckResponse,
  ListResponse,
  PasskeyCreateResponse,
  PasskeyGetResponse,
  ProviderInfoV2,
  SaveResponse,
} from "../shared/protocol"
import { getSettings } from "../shared/store"
import { BridgeError } from "./bridge"
import { providersHello, request } from "./router"
import type { DialogMessage, DialogPlacement } from "./dialog-host"
import { fillableOrigin, senderOrigin } from "./origin"

const DIALOG_TTL_MS = 5 * 60_000
const CAPTURE_TTL_MS = 3 * 60_000

// ---- Small helpers -----------------------------------------------------------

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
}

function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
}

function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith("chrome-extension://")
}

async function providers(capability: string): Promise<ProviderInfoV2[]> {
  try {
    const hello = await providersHello()
    return (hello.providers as ProviderInfoV2[]).filter((p) => p.status === "ready" && (p.capabilities ?? []).includes(capability as never))
  } catch {
    return []
  }
}

async function listAccounts(domain: string, origin: string): Promise<AccountV2[]> {
  const reply = await request<ListResponse>({ type: "list", domain, origin }, 60_000)
  return reply.accounts as AccountV2[]
}

// ---- Frames and rpId ---------------------------------------------------------

interface Frame {
  tabId: number
  frameId: number
  origin: string
  host: string
}

async function frameOf(sender: chrome.runtime.MessageSender): Promise<Frame | null> {
  const tabId = sender.tab?.id
  if (tabId === undefined || sender.tab?.incognito) return null
  // Sandboxed frames have an opaque origin; WebAuthn refuses them and so do we.
  const url = senderOrigin(sender)
  if (!url) return null
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null
  const frameId = sender.frameId ?? 0
  if (frameId !== 0) {
    // Passkeys in cross-site frames need the site's explicit permission; leave those to the browser.
    const top = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null)
    if (!top?.url || new URL(top.url).origin !== url.origin) return null
  }
  return { tabId, frameId, origin: url.origin, host: url.hostname }
}

/** WebAuthn rule: rpId is the host or a parent domain of it, but not a public suffix. */
function validRpId(host: string, rpId: string): boolean {
  const r = rpId.toLowerCase()
  if (host === r) return true
  return host.endsWith("." + r) && r.includes(".") && registrableDomain(r) === registrableDomain(host)
}

// ---- Dialogs -----------------------------------------------------------------

export type DialogMode = "passkey-get" | "passkey-create" | "save-login" | "save-sso"

export interface DialogChoice {
  action: "use" | "fallback" | "cancel" | "save" | "later" | "never"
  provider?: string
  ref?: string
}

interface Dialog {
  tabId: number
  mode: DialogMode
  data: Record<string, unknown>
  createdAt: number
  resolve: (choice: DialogChoice) => void
  key?: string
}

const dialogs = new Map<string, Dialog>()

async function openDialog(tabId: number, mode: DialogMode, data: Record<string, unknown>, placement: DialogPlacement, key?: string): Promise<DialogChoice> {
  const token = newToken()
  // Show it in the exact top-level document that's there now, not whatever loads next.
  const top = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null)
  const target: chrome.tabs.MessageSendOptions = top?.documentId ? { documentId: top.documentId } : { frameId: 0 }
  return new Promise<DialogChoice>((resolve) => {
    const finish = (choice: DialogChoice) => {
      if (!dialogs.has(token)) return
      dialogs.delete(token)
      clearTimeout(timer)
      void chrome.tabs.sendMessage(tabId, { type: "dg:close", token } satisfies DialogMessage, target).catch(() => {})
      resolve(choice)
    }
    const timer = setTimeout(() => finish({ action: "cancel" }), DIALOG_TTL_MS)
    dialogs.set(token, { tabId, mode, data, createdAt: Date.now(), resolve: finish, key })
    chrome.tabs
      .sendMessage(tabId, { type: "dg:open", token, placement } satisfies DialogMessage, target)
      .catch(() => finish({ action: "fallback" }))
  })
}

function cancelDialogs(predicate: (d: Dialog) => boolean) {
  for (const d of [...dialogs.values()]) if (predicate(d)) d.resolve({ action: "cancel" })
}

// ---- Passkeys ------------------------------------------------------------------

interface GetOptions {
  challenge?: string
  rpId?: string
  allowCredentials?: string[]
  userVerification?: string
  mediation?: string
}

interface CreateOptions {
  challenge?: string
  rp?: { id?: string; name?: string }
  user?: { id?: string; name?: string; displayName?: string }
  algorithms?: number[]
  excludeCredentials?: string[]
  userVerification?: string
}

type PasskeyReply = Record<string, unknown> | { fallback: true } | { error: string }

/** Conditional (autofill) requests wait for the user to pick a passkey in the inline menu. */
interface Conditional {
  requestId: number
  frame: Frame
  rpId: string
  candidates: AccountV2[]
  clientDataJSON: string
  userVerification?: string
  resolve: (reply: PasskeyReply) => void
}

const conditionals = new Map<string, Conditional>()
const frameKey = (tabId: number, frameId: number) => `${tabId}:${frameId}`

export function conditionalAccounts(tabId: number, frameId: number): AccountV2[] {
  return conditionals.get(frameKey(tabId, frameId))?.candidates ?? []
}

async function assert(frame: Frame, rpId: string, account: AccountV2, clientDataJSON: string, userVerification?: string): Promise<PasskeyReply> {
  const r = await request<PasskeyGetResponse>(
    {
      type: "passkey-get",
      provider: account.provider,
      ref: account.ref,
      rpId,
      origin: frame.origin,
      clientDataHash: await sha256(clientDataJSON),
      userVerification,
    },
    90_000,
  )
  return {
    credentialId: r.credentialId,
    clientDataJSON: b64url(new TextEncoder().encode(clientDataJSON)),
    authenticatorData: r.authenticatorData,
    signature: r.signature,
    userHandle: r.userHandle,
  }
}

/** Called by the inline menu when the user picks a passkey for a waiting autofill request. */
export async function pickConditional(tabId: number, frameId: number, provider: string, ref: string): Promise<boolean> {
  const c = conditionals.get(frameKey(tabId, frameId))
  const account = c?.candidates.find((a) => a.provider === provider && a.ref === ref)
  if (!c || !account) return false
  conditionals.delete(frameKey(tabId, frameId))
  try {
    c.resolve(await assert(c.frame, c.rpId, account, c.clientDataJSON, c.userVerification))
  } catch (err) {
    c.resolve({ error: (err as Error).message })
  }
  return true
}

async function passkeyGet(sender: chrome.runtime.MessageSender, requestId: number, o: GetOptions): Promise<PasskeyReply> {
  if (!(await getSettings()).passkeys || typeof o?.challenge !== "string") return { fallback: true }
  const frame = await frameOf(sender)
  if (!frame) return { fallback: true }
  const rpId = (o.rpId ?? frame.host).toLowerCase()
  if (!validRpId(frame.host, rpId)) return { error: "The relying party ID is not valid for this site." }
  if (!(await providers("passkeys")).length) return { fallback: true }

  const allow = Array.isArray(o.allowCredentials) ? o.allowCredentials : []
  const candidates = (await listAccounts(rpId, frame.origin).catch(() => [] as AccountV2[])).filter(
    (a) => a.kind === "passkey" && a.rpId === rpId && (!allow.length || (a.credentialId && allow.includes(a.credentialId))),
  )
  if (!candidates.length) return { fallback: true }

  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin: frame.origin, crossOrigin: false })

  if (o.mediation === "conditional") {
    return new Promise<PasskeyReply>((resolve) => {
      const key = frameKey(frame.tabId, frame.frameId)
      conditionals.get(key)?.resolve({ error: "superseded" })
      conditionals.set(key, { requestId, frame, rpId, candidates, clientDataJSON, userVerification: o.userVerification, resolve })
    })
  }

  const choice = await openDialog(
    frame.tabId,
    "passkey-get",
    { rpId, accounts: candidates.map(({ provider, ref, title, username }) => ({ provider, ref, title, username })) },
    "center",
    `${frame.tabId}:${frame.frameId}:${requestId}`,
  )
  if (choice.action === "fallback") return { fallback: true }
  const account = candidates.find((a) => a.provider === choice.provider && a.ref === choice.ref)
  if (choice.action !== "use" || !account) return { error: "cancelled" }
  return assert(frame, rpId, account, clientDataJSON, o.userVerification)
}

async function passkeyCreate(sender: chrome.runtime.MessageSender, requestId: number, o: CreateOptions): Promise<PasskeyReply> {
  if (!(await getSettings()).passkeys || typeof o?.challenge !== "string" || typeof o.user?.id !== "string") return { fallback: true }
  const frame = await frameOf(sender)
  if (!frame) return { fallback: true }
  const rpId = (o.rp?.id ?? frame.host).toLowerCase()
  if (!validRpId(frame.host, rpId)) return { error: "The relying party ID is not valid for this site." }
  // The bridge signs with ES256 (P-256); sites that don't accept it get the browser.
  if (Array.isArray(o.algorithms) && o.algorithms.length && !o.algorithms.includes(-7)) return { fallback: true }
  const writable = await providers("passkeys")
  if (!writable.length) return { fallback: true }

  const exclude = Array.isArray(o.excludeCredentials) ? o.excludeCredentials : []
  const existing = (await listAccounts(rpId, frame.origin).catch(() => [] as AccountV2[])).filter(
    (a) => a.kind === "passkey" && a.rpId === rpId,
  )
  const alreadyRegistered = existing.some((a) => a.credentialId && exclude.includes(a.credentialId))

  const choice = await openDialog(
    frame.tabId,
    "passkey-create",
    {
      rpId,
      userName: String(o.user.name ?? ""),
      providers: writable.map((p) => ({ id: p.id, name: p.name })),
      alreadyRegistered,
    },
    "center",
    `${frame.tabId}:${frame.frameId}:${requestId}`,
  )
  if (choice.action === "fallback") return { fallback: true }
  if (choice.action !== "save" || !choice.provider || alreadyRegistered) return { error: "cancelled" }

  const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin: frame.origin, crossOrigin: false })
  const r = await request<PasskeyCreateResponse>(
    {
      type: "passkey-create",
      provider: choice.provider,
      rpId,
      origin: frame.origin,
      clientDataHash: await sha256(clientDataJSON),
      user: { id: o.user.id, name: String(o.user.name ?? ""), displayName: String(o.user.displayName ?? "") },
      algorithms: o.algorithms ?? [-7],
      excludeCredentialIds: exclude,
      userVerification: o.userVerification,
    },
    90_000,
  )
  return {
    credentialId: r.credentialId,
    clientDataJSON: b64url(new TextEncoder().encode(clientDataJSON)),
    attestationObject: r.attestationObject,
    authenticatorData: r.authenticatorData,
    publicKey: r.publicKey,
    publicKeyAlgorithm: r.publicKeyAlgorithm,
  }
}

function cancelPasskey(sender: chrome.runtime.MessageSender, requestId: number) {
  const tabId = sender.tab?.id
  const frameId = sender.frameId ?? 0
  if (tabId === undefined) return
  const key = frameKey(tabId, frameId)
  const c = conditionals.get(key)
  if (c?.requestId === requestId) {
    conditionals.delete(key)
    c.resolve({ error: "aborted" })
  }
  cancelDialogs((d) => d.key === `${tabId}:${frameId}:${requestId}`)
}

// ---- Saving logins and sign-in methods ------------------------------------------

interface Capture {
  domain: string
  origin: string
  username?: string
  password?: string
  at: number
}

/** Submitted credentials, in memory only, until the login completes or they expire. */
const captures = new Map<number, Capture>()

async function neverSave(): Promise<string[]> {
  const { neverSave } = await chrome.storage.local.get("neverSave")
  return Array.isArray(neverSave) ? neverSave : []
}

async function addNeverSave(domain: string) {
  const list = await neverSave()
  if (!list.includes(domain)) await chrome.storage.local.set({ neverSave: [...list, domain] })
}

async function savingEnabled(domain?: string): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.savePrompts) return false
  if (domain && (await neverSave()).includes(domain)) return false
  return (await providers("save")).length > 0
}

async function capture(sender: chrome.runtime.MessageSender, username?: string, password?: string) {
  const tabId = sender.tab?.id
  if (tabId === undefined || sender.tab?.incognito) return
  const url = senderOrigin(sender)
  if (!url || !fillableOrigin(url)) return
  const domain = registrableDomain(url.hostname)
  if (!(await savingEnabled(domain))) return
  const prev = captures.get(tabId)
  const merged: Capture =
    prev && prev.domain === domain && Date.now() - prev.at < CAPTURE_TTL_MS
      ? { ...prev, username: username || prev.username, password: password || prev.password, at: Date.now() }
      : { domain, origin: url.origin, username, password, at: Date.now() }
  captures.set(tabId, merged)
}

async function offerSaveLogin(tabId: number, c: Capture) {
  if (!c.password || !c.username) return
  const check = await request<CheckResponse>(
    { type: "check", domain: c.domain, origin: c.origin, username: c.username, password: c.password },
    60_000,
  ).catch(() => null)
  if (!check || check.status === "same") return
  const writable = await providers("save")
  if (!writable.length) return
  const update = check.status === "update" ? check.matches[0] : undefined
  const choice = await openDialog(
    tabId,
    "save-login",
    {
      domain: c.domain,
      username: c.username,
      update: !!update,
      providers: update ? writable.filter((p) => p.id === update.provider).map((p) => ({ id: p.id, name: p.name })) : writable.map((p) => ({ id: p.id, name: p.name })),
    },
    "corner",
  )
  if (choice.action === "never") return addNeverSave(c.domain)
  if (choice.action !== "save" || !choice.provider) return
  await request<SaveResponse>(
    {
      type: "save",
      provider: choice.provider,
      domain: c.domain,
      origin: c.origin,
      entry: { kind: "password", title: c.domain, url: c.origin, username: c.username, password: c.password },
      ref: update && update.provider === choice.provider ? update.ref : undefined,
    },
    90_000,
  ).catch(() => {})
}

async function offerSaveSso(tabId: number, domain: string, origin: string, sso: string) {
  if (!(await savingEnabled(domain))) return
  const writable = await providers("sso")
  if (!writable.length) return
  const accounts = await listAccounts(domain, origin).catch(() => [] as AccountV2[])
  if (accounts.some((a) => a.kind === "sso" && a.sso === sso)) return
  const choice = await openDialog(
    tabId,
    "save-sso",
    { domain, sso, providers: writable.map((p) => ({ id: p.id, name: p.name })) },
    "corner",
  )
  if (choice.action === "never") return addNeverSave(domain)
  if (choice.action !== "save" || !choice.provider) return
  await request<SaveResponse>(
    { type: "save", provider: choice.provider, domain, origin, entry: { kind: "sso", title: domain, url: origin, sso } },
    90_000,
  ).catch(() => {})
}

/**
 * The recorder calls this when a login flow completes. Offer to save what was
 * typed (or update a changed password), or the sign-in method that was used.
 */
export async function onLoginCompleted(tabIds: number[], domain: string, method: string) {
  for (const tabId of tabIds) {
    const c = captures.get(tabId)
    captures.delete(tabId)
    if (c && c.domain === domain && Date.now() - c.at < CAPTURE_TTL_MS) {
      await offerSaveLogin(tabId, c).catch(() => {})
      return
    }
    if (method.startsWith("sso:")) {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null)
      if (!frame?.url) continue
      const url = new URL(frame.url)
      if (registrableDomain(url.hostname) !== domain || url.protocol !== "https:") continue
      await offerSaveSso(tabId, domain, url.origin, method.slice(4)).catch(() => {})
      return
    }
  }
}

// ---- Messages ----------------------------------------------------------------------

type VaultMessage =
  | { type: "pk:get"; requestId: number; options: GetOptions }
  | { type: "pk:create"; requestId: number; options: CreateOptions }
  | { type: "pk:cancel"; requestId: number }
  | { type: "sv:enabled" }
  | { type: "sv:capture"; username?: string; password?: string }
  | { type: "dg:load"; token: string }
  | { type: "dg:choose"; token: string; choice: DialogChoice }
  | { type: "dg:size"; token: string; height: number }

async function handle(message: VaultMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "pk:get":
      return passkeyGet(sender, message.requestId, message.options)
    case "pk:create":
      return passkeyCreate(sender, message.requestId, message.options)
    case "pk:cancel":
      cancelPasskey(sender, message.requestId)
      return null
    case "sv:enabled": {
      const url = sender.url ? new URL(sender.url) : null
      return { enabled: !!url && (await savingEnabled(registrableDomain(url.hostname))) }
    }
    case "sv:capture":
      await capture(
        sender,
        typeof message.username === "string" ? message.username.slice(0, 512) : undefined,
        typeof message.password === "string" ? message.password.slice(0, 1024) : undefined,
      )
      return null
    case "dg:load": {
      if (!fromExtensionPage(sender)) return null
      const d = dialogs.get(message.token)
      return d ? { mode: d.mode, data: d.data } : null
    }
    case "dg:choose": {
      if (!fromExtensionPage(sender)) return null
      dialogs.get(message.token)?.resolve(message.choice)
      return { ok: true }
    }
    case "dg:size": {
      if (!fromExtensionPage(sender)) return null
      const d = dialogs.get(message.token)
      if (d) await chrome.tabs.sendMessage(d.tabId, { type: "dg:resize", token: message.token, height: message.height } satisfies DialogMessage, { frameId: 0 }).catch(() => {})
      return null
    }
  }
}

export function registerVault() {
  chrome.runtime.onMessage.addListener((message: VaultMessage, sender, sendResponse) => {
    const t = message?.type
    if (typeof t !== "string" || !(t.startsWith("pk:") || t.startsWith("sv:") || t.startsWith("dg:"))) return
    handle(message, sender).then(
      (reply) => sendResponse(reply),
      (err) => sendResponse(t.startsWith("pk:") ? (err instanceof BridgeError && err.code === "unavailable" ? { fallback: true } : { error: (err as Error).message }) : null),
    )
    return true
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    captures.delete(tabId)
    cancelDialogs((d) => d.tabId === tabId)
    for (const [key, c] of conditionals) if (c.frame.tabId === tabId) conditionals.delete(key)
  })
  // A new page in the frame abandons any waiting autofill passkey request.
  chrome.webNavigation.onCommitted.addListener((d) => {
    const key = frameKey(d.tabId, d.frameId)
    conditionals.delete(key)
  })
}
