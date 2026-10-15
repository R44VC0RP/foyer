// Service worker: stitches surfaces and actions from every frame and tab into
// login flows, then folds finished flows into the per-site recipe.

import { classifyFlow, emptySite, flowSignature, recordFlow, recordSurface, today } from "./shared/dataset"
import { idpForHost, isDedicatedIdpHost, registrableDomain } from "./shared/domains"
import { safeHost } from "./shared/privacy"
import { getSettings, getSite, putSite } from "./shared/store"
import type { Action, FlowRecord, Message, Step, Surface } from "./shared/types"

const IDLE_MS = 5 * 60_000
const IDP_LINGER_MS = 3 * 60_000
/** Navigations the person started themselves; they end whatever flow was open. */
const DIRECT_TRANSITIONS = new Set(["typed", "auto_bookmark", "generated", "keyword", "keyword_generated"])

interface ActiveFlow {
  id: string
  domain: string
  tabIds: number[]
  startedAt: number
  updatedAt: number
  steps: Step[]
  interacted: boolean
  committed: boolean
  idpAt?: number
}

interface Session {
  flows: Record<string, ActiveFlow>
  tabs: Record<string, string>
  /** Registrable domain of the last non-IdP page each tab was on. */
  lastSite: Record<string, string>
}

interface Context {
  tabId: number
  openerTabId?: number
  topFrame: boolean
}

let session: Session = { flows: {}, tabs: {}, lastSite: {} }
const ready = chrome.storage.session.get("session").then((r) => {
  const saved = r.session as Partial<Session> | undefined
  if (saved) session = { flows: saved.flows ?? {}, tabs: saved.tabs ?? {}, lastSite: saved.lastSite ?? {} }
})
const saveSession = () => chrome.storage.session.set({ session })

// Serialise every state change so concurrent messages can't interleave.
let chain: Promise<unknown> = Promise.resolve()
function serial(fn: () => Promise<void>) {
  chain = chain
    .then(() => ready)
    .then(fn)
    .then(saveSession)
    .catch((err) => console.error("[foyer]", err))
  return chain
}

const flowForTab = (tabId: number) => {
  const id = session.tabs[tabId]
  return id ? session.flows[id] : undefined
}

/** The tab's flow, or its opener's (sign-in popups opened as about:blank first). */
function resolveFlow(ctx: Context): ActiveFlow | undefined {
  const own = flowForTab(ctx.tabId)
  if (own || ctx.openerTabId === undefined) return own
  const opener = flowForTab(ctx.openerTabId)
  if (opener) {
    session.tabs[ctx.tabId] = opener.id
    if (!opener.tabIds.includes(ctx.tabId)) opener.tabIds.push(ctx.tabId)
  }
  return opener
}

/** Hosted login pages (Auth0, Okta, Microsoft) count for the site that sent you there. */
function originDomain(ctx: Context, host: string): string {
  if (isDedicatedIdpHost(host)) {
    const origin = session.lastSite[ctx.tabId] ?? (ctx.openerTabId !== undefined ? session.lastSite[ctx.openerTabId] : undefined)
    if (origin) return origin
  }
  return registrableDomain(host)
}

const lingering = (flow: ActiveFlow, now: number) => flow.idpAt !== undefined && now - flow.idpAt < IDP_LINGER_MS
const ownOrIdp = (flow: ActiveFlow, host: string) => registrableDomain(host) === flow.domain || !!idpForHost(host)

function belongs(flow: ActiveFlow, host: string, now: number): boolean {
  // After an IdP hop, corporate SSO pages on unknown hosts still belong.
  return ownOrIdp(flow, host) || lingering(flow, now)
}

/** Unknown hosts inside a flow (often an employer's SSO) are never stored by name. */
const flowHost = (flow: ActiveFlow, host: string) => (ownOrIdp(flow, host) ? host : "*")

const sameRoles = (a: Step, fields: Surface["fields"]) =>
  a.fields.map((f) => f.role).sort().join() === fields.map((f) => f.role).sort().join()

function stepFor(flow: ActiveFlow, surface: Pick<Surface, "host" | "path" | "kind" | "fields">): Step {
  const last = flow.steps[flow.steps.length - 1]
  if (last && last.host === surface.host && last.path === surface.path && last.kind === surface.kind && sameRoles(last, surface.fields)) {
    if (surface.fields.length) last.fields = surface.fields
    return last
  }
  const step: Step = { host: surface.host, path: surface.path, kind: surface.kind, fields: surface.fields, actions: [] }
  flow.steps.push(step)
  if (flow.steps.length > 12) flow.steps.shift()
  return step
}

function startFlow(tabId: number, domain: string, now: number): ActiveFlow {
  const flow: ActiveFlow = {
    id: `${tabId}-${now}`,
    domain,
    tabIds: [tabId],
    startedAt: now,
    updatedAt: now,
    steps: [],
    interacted: false,
    committed: false,
  }
  session.flows[flow.id] = flow
  session.tabs[tabId] = flow.id
  return flow
}

async function finalize(flow: ActiveFlow, outcome: FlowRecord["outcome"]) {
  delete session.flows[flow.id]
  for (const [tab, id] of Object.entries(session.tabs)) if (id === flow.id) delete session.tabs[tab]
  if (!flow.interacted) return
  const steps = flow.steps.filter((s) => s.actions.length > 0)
  if (!steps.length) return
  const { method, mfa } = classifyFlow(steps)
  const date = today()
  const site = (await getSite(flow.domain)) ?? emptySite(flow.domain)
  recordFlow(site, { signature: flowSignature(steps), method, mfa, outcome, steps, seen: 1, firstSeen: date, lastSeen: date })
  await putSite(site)
}

async function onSurface(ctx: Context, surface: Surface) {
  const now = Date.now()
  const domain = registrableDomain(surface.host)
  let flow = resolveFlow(ctx)

  // A login widget in a third-party sub-frame doesn't take over the tab's flow.
  const foreignFrame = !ctx.topFrame && !idpForHost(surface.host) && domain !== (flow?.domain ?? session.lastSite[ctx.tabId] ?? domain)
  // Pages on unknown hosts mid-SSO (an employer's IdP) aren't recorded as sites.
  const corporateIdp = !!flow && !ownOrIdp(flow, surface.host) && lingering(flow, now)
  if (!corporateIdp) {
    // Tenant-hosted login pages (acme.auth0.com -> *.auth0.com) are the site's
    // own login screen; shared ones (accounts.google.com) belong to the IdP.
    const owner = surface.host.startsWith("*.") ? (flow?.domain ?? originDomain(ctx, surface.host)) : domain
    const site = (await getSite(owner)) ?? emptySite(owner)
    recordSurface(site, surface)
    await putSite(site)
  }

  // Sign-up, reset and change-password screens are recorded as surfaces but don't drive flows.
  if (foreignFrame || surface.kind === "signup" || surface.kind === "reset" || surface.kind === "change-password") return

  if (flow && !belongs(flow, surface.host, now)) {
    await finalize(flow, flow.committed ? "completed" : "unknown")
    flow = undefined
  }
  if (!flow) flow = startFlow(ctx.tabId, originDomain(ctx, surface.host), now)
  if (idpForHost(surface.host) && domain !== flow.domain) flow.idpAt = now
  stepFor(flow, { ...surface, host: flowHost(flow, surface.host) })
  flow.updatedAt = now
}

const COMMIT_KINDS = new Set<Action["kind"]>(["submit", "provider", "passkey", "choose"])
const actionKey = (a: Action) => JSON.stringify(a)

async function onAction(ctx: Context, host: string, path: string, action: Action) {
  const now = Date.now()
  let flow = resolveFlow(ctx)
  if (flow && !belongs(flow, host, now)) return
  if (!flow) {
    // One Tap (FedCM) and passkey autofill can sign you in with no visible form.
    const standalone = (action.kind === "passkey" && action.op === "get" && action.result === "ok") || action.kind === "provider"
    if (!standalone) return
    flow = startFlow(ctx.tabId, originDomain(ctx, host), now)
  }
  if (action.kind === "passkey" && action.rpId && !ownOrIdp(flow, action.rpId)) action = { ...action, rpId: undefined }
  const stepHost = flowHost(flow, host)
  const step =
    flow.steps.findLast((s) => s.host === stepHost && s.path === path) ?? stepFor(flow, { host: stepHost, path, kind: "login", fields: [] })
  const key = actionKey(action)
  if (!step.actions.some((a) => actionKey(a) === key)) step.actions.push(action)
  if (step.actions.length > 40) step.actions.shift()
  flow.interacted = true
  if (COMMIT_KINDS.has(action.kind) && !(action.kind === "passkey" && action.result !== "ok")) flow.committed = true
  flow.updatedAt = now
}

async function onQuiet(ctx: Context, host: string, loginish: boolean) {
  const flow = flowForTab(ctx.tabId)
  if (!flow) return
  const now = Date.now()
  // "Completed" only once we land somewhere that isn't an IdP, an auth-looking
  // URL, or an unknown host mid-SSO. Interstitials keep the flow open.
  const landed = !loginish && !idpForHost(host) && (registrableDomain(host) === flow.domain || !lingering(flow, now))
  if (flow.committed && landed) await finalize(flow, "completed")
  else if (!flow.interacted && !belongs(flow, host, now)) await finalize(flow, "unknown")
}

chrome.runtime.onMessage.addListener((message: Message, sender) => {
  const tabId = sender.tab?.id
  if (tabId === undefined || sender.tab?.incognito) return
  const ctx: Context = { tabId, openerTabId: sender.tab?.openerTabId, topFrame: sender.frameId === 0 }
  serial(async () => {
    if ((await getSettings()).paused) return
    if (message.type === "foyer:surface") await onSurface(ctx, message.surface)
    else if (message.type === "foyer:action") await onAction(ctx, message.host, message.path, message.action)
    else if (message.type === "foyer:quiet" && ctx.topFrame) await onQuiet(ctx, message.host, message.loginish)
  })
})

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || !/^https?:/.test(details.url)) return
  serial(async () => {
    const host = safeHost(new URL(details.url).hostname)
    const direct = DIRECT_TRANSITIONS.has(details.transitionType)
    if (!isDedicatedIdpHost(host)) session.lastSite[details.tabId] = registrableDomain(host)
    else if (direct) delete session.lastSite[details.tabId]

    const flow = flowForTab(details.tabId)
    if (!flow) return
    if (direct) {
      await finalize(flow, "unknown")
      return
    }
    // Top-level hops between hosts become redirect actions on the flow.
    if (!flow.interacted) return
    const last = flow.steps[flow.steps.length - 1]
    const to = flowHost(flow, host)
    if (!last || last.host === to) return
    const previous = last.actions[last.actions.length - 1]
    if (previous?.kind === "redirect" && previous.host === to) return
    const provider = idpForHost(host)
    const viaIdp = provider && registrableDomain(host) !== flow.domain
    last.actions.push({ kind: "redirect", host: to, provider: viaIdp ? provider : undefined })
    if (viaIdp) flow.idpAt = Date.now()
    flow.updatedAt = Date.now()
  })
})

// "Sign in with X" popups: the new window joins the opener's flow.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  serial(async () => {
    const origin = session.lastSite[details.sourceTabId]
    if (origin) session.lastSite[details.tabId] = origin
    const flow = flowForTab(details.sourceTabId)
    if (!flow) return
    session.tabs[details.tabId] = flow.id
    if (!flow.tabIds.includes(details.tabId)) flow.tabIds.push(details.tabId)
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    delete session.lastSite[tabId]
    const flow = flowForTab(tabId)
    if (!flow) return
    delete session.tabs[tabId]
    flow.tabIds = flow.tabIds.filter((t) => t !== tabId)
    if (!flow.tabIds.length) await finalize(flow, "unknown")
  })
})

chrome.alarms.create("foyer:sweep", { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "foyer:sweep") return
  serial(async () => {
    const now = Date.now()
    for (const flow of Object.values(session.flows)) if (now - flow.updatedAt > IDLE_MS) await finalize(flow, "unknown")
  })
})
