// Background autofill service: lists accounts from the bridge for the frame
// that asked, hands the inline menu a one-time token bound to that frame, and
// fills only into that frame after the user picks an account.
//
// The domain always comes from the browser's record of the sender frame
// (sender.url), never from anything the page or content script says.

import { registrableDomain } from "../shared/domains"
import type { AccountV2 as Account, FillResponse, ListResponse, Secret } from "../shared/protocol"
import { getSettings } from "../shared/store"
import type { FieldRole, Surface } from "../shared/types"
import { BridgeError, bridgeLastError } from "./bridge"
import { onProviderWrite, providersHello, request, resetProviders } from "./router"
import { fillableOrigin, senderOrigin } from "./origin"
import { conditionalAccounts, pickConditional } from "./vault"
import type {
  AutofillMessage,
  FieldPresence,
  FillValues,
  MenuLoadReply,
  QueryReply,
  StatusReply,
  TabAccountsReply,
  ToContent,
} from "./messages"

const TOKEN_TTL_MS = 2 * 60_000
const LIST_TTL_MS = 30_000
const CONTINUE_TTL_MS = 2 * 60_000

interface FrameTarget {
  tabId: number
  frameId: number
  /** The exact document that asked; fills are delivered to it and nothing else. */
  documentId?: string
  origin: string
  domain: string
}

interface MenuToken extends FrameTarget {
  roles: FieldRole[]
  createdAt: number
}

/** Identifier-first: after filling the email step, fill the password step too. */
interface Continuation {
  provider: string
  ref: string
  domain: string
  /** Only the same frame on the same origin continues, never another page of the site. */
  frameId: number
  origin: string
  at: number
  done: Secret[]
  hasTotp: boolean
}

const tokens = new Map<string, MenuToken>()
const listCache = new Map<string, { at: number; reply: ListResponse }>()

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function sweepTokens() {
  const now = Date.now()
  for (const [t, v] of tokens) if (now - v.createdAt > TOKEN_TTL_MS) tokens.delete(t)
}

async function targetFor(sender: chrome.runtime.MessageSender): Promise<FrameTarget | null> {
  const tabId = sender.tab?.id
  if (tabId === undefined || sender.tab?.incognito) return null
  const url = senderOrigin(sender)
  if (!url || !fillableOrigin(url)) return null
  const frameId = sender.frameId ?? 0
  const domain = registrableDomain(url.hostname)
  // Sub-frames only get credentials for the same site as the page around them.
  if (frameId !== 0) {
    const top = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null)
    if (!top?.url || registrableDomain(new URL(top.url).hostname) !== domain) return null
  }
  return { tabId, frameId, documentId: sender.documentId, origin: url.origin, domain }
}

async function listFor(domain: string, origin: string, fresh = false): Promise<ListResponse> {
  const cached = listCache.get(domain)
  if (!fresh && cached && Date.now() - cached.at < LIST_TTL_MS) return cached.reply
  const reply = await request<ListResponse>({ type: "list", domain, origin }, 60_000)
  listCache.set(domain, { at: Date.now(), reply })
  return reply
}

/**
 * What the inline menu offers for a frame: passwords and saved sign-in methods,
 * plus passkeys only while the page has an autofill passkey request waiting.
 */
async function menuAccounts(target: FrameTarget): Promise<{ accounts: Account[]; errors: ListResponse["errors"] }> {
  const reply = await listFor(target.domain, target.origin)
  const accounts = (reply.accounts as Account[]).filter((a) => (a.kind ?? "password") !== "passkey")
  return { accounts: [...conditionalAccounts(target.tabId, target.frameId), ...accounts], errors: reply.errors }
}

function wantFor(roles: FieldRole[], account?: Account): Secret[] {
  const want: Secret[] = []
  if (roles.some((r) => r === "username" || r === "email" || r === "phone")) want.push("username")
  if (roles.includes("password")) want.push("password")
  if (roles.includes("otp") && account?.hasTotp !== false) want.push("totp")
  return want
}

/**
 * Deliver to the exact document that was checked. The bridge can take seconds
 * (or wait on an approval prompt), and a frame can be navigated elsewhere in
 * the meantime; a frameId alone would follow it to the new page.
 */
async function sendToFrame(target: FrameTarget, message: ToContent): Promise<boolean> {
  const frame = await chrome.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId }).catch(() => null)
  if (!frame?.url) return false
  if (target.documentId && frame.documentId !== target.documentId) return false
  if (new URL(frame.url).origin !== target.origin) return false
  const options: chrome.tabs.MessageSendOptions = target.documentId ? { documentId: target.documentId } : { frameId: target.frameId }
  return chrome.tabs.sendMessage(target.tabId, message, options).then(
    () => true,
    () => false,
  )
}

async function getContinuation(tabId: number): Promise<Continuation | undefined> {
  const key = `af:cont:${tabId}`
  const stored = (await chrome.storage.session.get(key))[key] as Continuation | undefined
  if (stored && Date.now() - stored.at < CONTINUE_TTL_MS) return stored
  if (stored) await chrome.storage.session.remove(key)
  return undefined
}

async function setContinuation(tabId: number, c: Continuation | undefined) {
  const key = `af:cont:${tabId}`
  if (c) await chrome.storage.session.set({ [key]: c })
  else await chrome.storage.session.remove(key)
}

async function fill(target: FrameTarget, provider: string, ref: string, roles: FieldRole[], account?: Account, continued = false) {
  const want = wantFor(roles, account)
  if (!want.length) return
  const settings = await getSettings()
  const response = await request<FillResponse>({ type: "fill", provider, ref, domain: target.domain, origin: target.origin, want }, 60_000)
  const values: FillValues = {}
  if (want.includes("username") && response.username) values.username = response.username
  if (want.includes("password") && response.password) values.password = response.password
  if (want.includes("totp") && response.totp) values.totp = response.totp
  // Never auto-submit a step the user didn't pick themselves.
  if (!(await sendToFrame(target, { type: "af:fill", values, submit: settings.autosubmit && !continued }))) return

  // Email-first sign-in: remember which account so the next steps (password,
  // then one-time code) in this same frame and origin fill too.
  const hasTotp = account?.hasTotp ?? false
  const finished = want.includes("totp") || (want.includes("password") && !hasTotp)
  await setContinuation(
    target.tabId,
    finished
      ? undefined
      : { provider, ref, domain: target.domain, frameId: target.frameId, origin: target.origin, at: Date.now(), done: want, hasTotp },
  )
}

/** Called by the recorder for every login screen; continues an email-first fill. */
export async function onSurfaceForAutofill(sender: chrome.runtime.MessageSender, surface: Surface) {
  const tabId = sender.tab?.id
  if (tabId === undefined) return
  const cont = await getContinuation(tabId)
  if (!cont) return
  const target = await targetFor(sender)
  if (!target || target.domain !== cont.domain || target.frameId !== cont.frameId || target.origin !== cont.origin) return
  const roles = surface.fields.map((f) => f.role)
  const needed = wantFor(roles).filter((s) => !cont.done.includes(s) || s === "totp")
  if (!needed.some((s) => s === "password" || s === "totp")) return
  const settings = await getSettings()
  if (!settings.autofill) return
  await fill(
    target,
    cont.provider,
    cont.ref,
    roles.filter((r) => r === "password" || r === "otp"),
    { provider: cont.provider, ref: cont.ref, title: "", hasPassword: true, hasTotp: cont.hasTotp },
    true,
  ).catch(() => {})
}

async function status(): Promise<StatusReply> {
  try {
    const hello = await providersHello()
    return { connected: true, providers: hello.providers }
  } catch (err) {
    return { connected: false, error: (err as Error).message || bridgeLastError(), providers: [] }
  }
}

async function handle(message: AutofillMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "af:query": {
      const settings = await getSettings()
      if (!settings.autofill) return { count: 0 } satisfies QueryReply
      const target = await targetFor(sender)
      if (!target) return { count: 0 } satisfies QueryReply
      const reply = await menuAccounts(target).catch(() => null)
      const count = reply?.accounts.length ?? 0
      if (!count) return { count: 0 } satisfies QueryReply
      sweepTokens()
      const token = newToken()
      tokens.set(token, { ...target, roles: sanitizeRoles(message.presence), createdAt: Date.now() })
      return { token, count } satisfies QueryReply
    }
    case "af:menu-load": {
      const t = tokenFrom(message.token, sender)
      if (!t) return null
      const reply = await menuAccounts(t)
      return { domain: t.domain, accounts: reply.accounts, errors: reply.errors ?? [] } satisfies MenuLoadReply
    }
    case "af:menu-pick": {
      const t = tokenFrom(message.token, sender)
      if (!t) return { ok: false }
      tokens.delete(message.token)
      const { accounts } = await menuAccounts(t)
      const account = accounts.find((a) => a.provider === message.provider && a.ref === message.ref)
      if (!account) return { ok: false }
      await sendToFrame(t, { type: "af:close-menu", token: message.token })
      if (account.kind === "passkey") return { ok: await pickConditional(t.tabId, t.frameId, account.provider, account.ref) }
      if (account.kind === "sso" && account.sso) {
        await sendToFrame(t, { type: "af:sso", provider: account.sso })
        return { ok: true }
      }
      await fill(t, account.provider, account.ref, t.roles, account)
      return { ok: true }
    }
    case "af:menu-dismiss": {
      const t = tokenFrom(message.token, sender)
      if (t) await sendToFrame(t, { type: "af:close-menu", token: message.token })
      return { ok: true }
    }
    case "af:menu-resize": {
      const t = tokenFrom(message.token, sender)
      if (t) await sendToFrame(t, { type: "af:resize-menu", token: message.token, height: Math.min(Math.max(message.height, 40), 400) })
      return { ok: true }
    }
    case "af:menu-close": {
      tokens.delete(message.token)
      return { ok: true }
    }
    case "af:status":
      return status()
    case "af:tab-accounts": {
      if (!fromExtensionPage(sender)) return null
      return tabAccounts(message.tabId)
    }
    case "af:tab-fill": {
      if (!fromExtensionPage(sender)) return { ok: false }
      return tabFill(message.tabId, message.provider, message.ref)
    }
  }
}

function sanitizeRoles(presence: FieldPresence): FieldRole[] {
  const allowed: FieldRole[] = ["username", "email", "phone", "password", "otp"]
  return Array.isArray(presence?.roles) ? presence.roles.filter((r) => allowed.includes(r)) : []
}

/** Tokens may only be used by the extension's own menu page. */
function tokenFrom(token: string, sender: chrome.runtime.MessageSender): MenuToken | undefined {
  if (!fromExtensionPage(sender)) return undefined
  const t = tokens.get(token)
  if (!t || Date.now() - t.createdAt > TOKEN_TTL_MS) return undefined
  return t
}

function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  // Content scripts share the extension id but report the web page's URL.
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith("chrome-extension://")
}

async function topTarget(tabId: number): Promise<FrameTarget | null> {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null)
  if (!frame?.url) return null
  const url = new URL(frame.url)
  if (!fillableOrigin(url)) return null
  return { tabId, frameId: 0, documentId: frame.documentId, origin: url.origin, domain: registrableDomain(url.hostname) }
}

async function tabAccounts(tabId: number): Promise<TabAccountsReply> {
  const s = await status()
  const target = await topTarget(tabId)
  if (!s.connected || !target) return { ...s, accounts: [], errors: [] }
  try {
    const reply = await listFor(target.domain, target.origin, true)
    return { ...s, domain: target.domain, accounts: reply.accounts, errors: reply.errors ?? [] }
  } catch (err) {
    return { ...s, domain: target.domain, accounts: [], errors: [{ provider: "bridge", message: (err as Error).message }] }
  }
}

async function tabFill(tabId: number, provider: string, ref: string) {
  const target = await topTarget(tabId)
  if (!target) return { ok: false }
  const reply = await listFor(target.domain, target.origin)
  const account = (reply.accounts as Account[]).find((a) => a.provider === provider && a.ref === ref)
  if (!account || account.kind === "passkey") return { ok: false }
  if (account.kind === "sso" && account.sso) {
    await sendToFrame(target, { type: "af:sso", provider: account.sso })
    return { ok: true }
  }
  await fill(target, provider, ref, ["username", "password", "otp"], account)
  return { ok: true }
}

/** Keyboard shortcut: fill the only account, or open the menu to choose. */
async function onCommand(command: string, tab?: chrome.tabs.Tab) {
  if (command !== "fill-login" || tab?.id === undefined) return
  const target = await topTarget(tab.id)
  if (!target) return
  const reply = await listFor(target.domain, target.origin).catch(() => null)
  const passwords = ((reply?.accounts ?? []) as Account[]).filter((a) => (a.kind ?? "password") === "password")
  if (passwords.length === 1) await fill(target, passwords[0].provider, passwords[0].ref, ["username", "password", "otp"], passwords[0])
  else if (reply?.accounts.length) await sendToFrame(target, { type: "af:open-menu" })
}

export function registerAutofill() {
  onProviderWrite(() => listCache.clear())
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.extensionProviders) {
      resetProviders()
      listCache.clear()
    }
  })
  chrome.runtime.onMessage.addListener((message: AutofillMessage, sender, sendResponse) => {
    if (typeof message?.type !== "string" || !message.type.startsWith("af:")) return
    handle(message, sender).then(
      (reply) => sendResponse(reply),
      (err) => sendResponse({ error: err instanceof BridgeError ? err.code : "error", message: (err as Error).message }),
    )
    return true
  })
  chrome.commands?.onCommand.addListener((command, tab) => void onCommand(command, tab))
  chrome.tabs.onRemoved.addListener((tabId) => void setContinuation(tabId, undefined))
}
