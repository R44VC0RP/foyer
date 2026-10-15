import { isHostname, isSafeSelector, safeHost, safeToken, templatePath } from "./privacy"
import { registrableDomain } from "./domains"
import {
  DATASET_FORMAT,
  SCHEMA_VERSION,
  type Action,
  type Dataset,
  type FieldSpec,
  type FlowRecord,
  type Method,
  type SiteRecipe,
  type Step,
  type Surface,
  type SurfaceRecord,
} from "./types"

const MAX_SURFACES = 12
const MAX_FLOWS = 24

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** FNV-1a, 32-bit, as 8 hex chars. Only used for dedupe keys. */
export function hash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

const fieldKey = (f: FieldSpec) => `${f.role}:${f.selector}${f.split ? `x${f.split}` : ""}`

export function surfaceSignature(s: Surface): string {
  return hash(
    [
      s.host,
      s.path,
      s.kind,
      s.fields.map(fieldKey).join(","),
      s.providers.map((p) => p.provider).sort().join(","),
      s.passkeyButton ? "pk" : "",
      s.magicLinkButton ? "ml" : "",
      s.passkeyAutofill ? "pka" : "",
    ].join("|"),
  )
}

function actionKey(a: Action): string {
  switch (a.kind) {
    case "fill":
      return `fill:${a.role}`
    case "provider":
      return `provider:${a.provider}`
    case "choose":
      return `choose:${a.intent}`
    case "submit":
      return "submit"
    case "passkey":
      return `passkey:${a.op}:${a.mediation ?? "optional"}`
    case "redirect":
      return `redirect:${a.provider ?? a.host}`
  }
}

export function flowSignature(steps: Step[]): string {
  return hash(steps.map((s) => `${s.host}${s.path}#${s.kind}[${s.actions.map(actionKey).join(",")}]`).join(">"))
}

export function methodsOffered(s: Surface): Method[] {
  const out = new Set<Method>()
  const roles = new Set(s.fields.map((f) => f.role))
  if (s.kind === "login" || s.kind === "idp") {
    if (roles.has("password")) out.add("password")
    else if (roles.has("username") || roles.has("email") || roles.has("phone")) out.add("identifier-first")
  }
  if (s.kind === "mfa" || roles.has("otp")) out.add("otp")
  if (s.passkeyButton) out.add("passkey")
  if (s.passkeyAutofill || s.fields.some((f) => f.autocomplete?.includes("webauthn"))) out.add("passkey-autofill")
  if (s.magicLinkButton) out.add("magic-link")
  for (const p of s.providers) out.add(`sso:${p.provider}`)
  return [...out]
}

/** Work out the primary method and second factor from what the person did. */
export function classifyFlow(steps: Step[]): Pick<FlowRecord, "method" | "mfa"> {
  const actions = steps.flatMap((s, i) => s.actions.map((a) => ({ a, step: i })))
  const provider = actions.find(({ a }) => a.kind === "provider" || (a.kind === "redirect" && a.provider))
  const passwordAt = actions.find(({ a }) => a.kind === "fill" && a.role === "password")?.step
  const identAt = actions.find(
    ({ a }) => a.kind === "fill" && (a.role === "username" || a.role === "email" || a.role === "phone"),
  )?.step
  const otpAt = actions.find(({ a }) => a.kind === "fill" && a.role === "otp")?.step
  const passkeyGet = actions.find(({ a }) => a.kind === "passkey" && a.op === "get" && a.result !== "cancelled")
  const chosePasskey = actions.some(({ a }) => a.kind === "choose" && a.intent === "passkey")
  const choseMagic = actions.some(({ a }) => a.kind === "choose" && a.intent === "magic-link")

  let method: FlowRecord["method"] = "unknown"
  let primaryEnd = -1
  if (provider) {
    const p = provider.a.kind === "provider" ? provider.a.provider : provider.a.kind === "redirect" ? provider.a.provider : undefined
    if (p) method = `sso:${p}`
    primaryEnd = provider.step
  } else if (passwordAt !== undefined) {
    method = identAt !== undefined && identAt < passwordAt ? "identifier-first" : "password"
    primaryEnd = passwordAt
  } else if (passkeyGet || chosePasskey) {
    const conditional = passkeyGet?.a.kind === "passkey" && passkeyGet.a.mediation === "conditional"
    method = conditional ? "passkey-autofill" : "passkey"
    primaryEnd = passkeyGet?.step ?? 0
  } else if (choseMagic) {
    method = "magic-link"
  } else if (otpAt !== undefined) {
    method = "otp"
    primaryEnd = otpAt
  } else if (identAt !== undefined) {
    // Identifier entered, then nothing we could see (interstitial, email sent,
    // unsupported screen). Don't guess beyond what was observed.
    method = "identifier-first"
  }

  let mfa: FlowRecord["mfa"]
  if (method !== "otp" && otpAt !== undefined && otpAt >= primaryEnd) mfa = "otp"
  else if (method !== "passkey" && method !== "passkey-autofill" && passkeyGet && passkeyGet.step > primaryEnd && primaryEnd >= 0)
    mfa = "passkey"
  return { method, mfa }
}

export function emptySite(domain: string): SiteRecipe {
  return { domain, hosts: [], offers: {}, surfaces: [], flows: [], updatedAt: today() }
}

function addHost(site: SiteRecipe, host: string) {
  if (!site.hosts.includes(host)) site.hosts.push(host)
}

function maxDate(a: string, b: string) {
  return a > b ? a : b
}
function minDate(a: string, b: string) {
  return a < b ? a : b
}

export function recordSurface(site: SiteRecipe, surface: Surface, date = today()): void {
  addHost(site, surface.host)
  for (const m of methodsOffered(surface)) {
    const stat = site.offers[m] ?? { seen: 0, lastSeen: date }
    stat.seen += 1
    stat.lastSeen = maxDate(stat.lastSeen, date)
    site.offers[m] = stat
  }
  const signature = surfaceSignature(surface)
  const existing = site.surfaces.find((s) => s.signature === signature)
  if (existing) {
    existing.seen += 1
    existing.lastSeen = maxDate(existing.lastSeen, date)
  } else {
    site.surfaces.push({ signature, surface, seen: 1, lastSeen: date })
    site.surfaces.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.seen - a.seen)
    site.surfaces.length = Math.min(site.surfaces.length, MAX_SURFACES)
  }
  site.updatedAt = maxDate(site.updatedAt, date)
}

export function recordFlow(site: SiteRecipe, flow: FlowRecord): void {
  for (const s of flow.steps) if (registrableDomain(s.host) === site.domain) addHost(site, s.host)
  const existing = site.flows.find((f) => f.signature === flow.signature)
  if (existing) {
    existing.seen += flow.seen
    existing.firstSeen = minDate(existing.firstSeen, flow.firstSeen)
    existing.lastSeen = maxDate(existing.lastSeen, flow.lastSeen)
    if (flow.outcome === "completed") existing.outcome = "completed"
  } else {
    site.flows.push(flow)
    site.flows.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.seen - a.seen)
    site.flows.length = Math.min(site.flows.length, MAX_FLOWS)
  }
  site.updatedAt = maxDate(site.updatedAt, flow.lastSeen)
}

export function mergeSite(into: SiteRecipe, from: SiteRecipe): SiteRecipe {
  for (const h of from.hosts) addHost(into, h)
  for (const [m, stat] of Object.entries(from.offers) as [Method, { seen: number; lastSeen: string }][]) {
    const cur = into.offers[m]
    into.offers[m] = cur ? { seen: cur.seen + stat.seen, lastSeen: maxDate(cur.lastSeen, stat.lastSeen) } : { ...stat }
  }
  for (const s of from.surfaces) {
    const cur = into.surfaces.find((x) => x.signature === s.signature)
    if (cur) {
      cur.seen += s.seen
      cur.lastSeen = maxDate(cur.lastSeen, s.lastSeen)
    } else into.surfaces.push(s)
  }
  into.surfaces.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.seen - a.seen)
  into.surfaces.length = Math.min(into.surfaces.length, MAX_SURFACES)
  for (const f of from.flows) recordFlow(into, { ...f })
  into.updatedAt = maxDate(into.updatedAt, from.updatedAt)
  return into
}

/** Shareable copy: dates coarsened to the month, nothing else added. */
export function toExport(sites: SiteRecipe[]): Dataset {
  const month = (d: string) => d.slice(0, 7)
  const out: Dataset = { format: DATASET_FORMAT, version: SCHEMA_VERSION, exportedAt: month(today()), sites: {} }
  for (const site of sites) {
    const copy: SiteRecipe = structuredClone(site)
    copy.updatedAt = month(copy.updatedAt)
    for (const stat of Object.values(copy.offers)) if (stat) stat.lastSeen = month(stat.lastSeen)
    for (const s of copy.surfaces) s.lastSeen = month(s.lastSeen)
    for (const f of copy.flows) {
      f.firstSeen = month(f.firstSeen)
      f.lastSeen = month(f.lastSeen)
    }
    out.sites[copy.domain] = copy
  }
  return out
}

// ---- Import validation -----------------------------------------------------
// Imported files are untrusted: rebuild every record from known fields and run
// strings back through the privacy filters.

const ROLES = new Set(["username", "email", "phone", "password", "new-password", "otp", "captcha"])
const KINDS = new Set(["login", "signup", "change-password", "mfa", "reset", "idp"])
const PROVIDERS = new Set([
  "google", "apple", "microsoft", "github", "facebook", "x", "linkedin", "gitlab", "slack", "discord", "amazon", "okta", "sso",
])

const str = (v: unknown, max = 200) => (typeof v === "string" && v.length <= max ? v : undefined)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined)
const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(v) ? v : today().slice(0, 7))
const selector = (v: unknown) => (typeof v === "string" && isSafeSelector(v) ? v : undefined)
const host = (v: unknown) => (typeof v === "string" && isHostname(v.toLowerCase()) ? safeHost(v) : undefined)
const autocomplete = (v: unknown) => (typeof v === "string" && v.length <= 60 && /^[a-z0-9 -]+$/.test(v) ? v : undefined)
const oneOf = <T extends string>(v: unknown, values: readonly T[]) => (values.includes(v as T) ? (v as T) : undefined)
export const MEDIATIONS = ["silent", "optional", "conditional", "required", "immediate"] as const
export const USER_VERIFICATIONS = ["required", "preferred", "discouraged"] as const

function cleanField(v: any): FieldSpec | undefined {
  const sel = selector(v?.selector)
  if (!v || !ROLES.has(v.role) || !sel) return undefined
  return {
    role: v.role,
    selector: sel,
    type: safeToken(v.type, 20) ?? "text",
    autocomplete: autocomplete(v.autocomplete),
    inputMode: safeToken(v.inputMode, 20),
    maxLength: num(v.maxLength),
    split: num(v.split),
  }
}

function cleanAction(v: any): Action | undefined {
  switch (v?.kind) {
    case "fill":
      return ROLES.has(v.role) && selector(v.selector) ? { kind: "fill", role: v.role, selector: selector(v.selector)! } : undefined
    case "provider":
      return PROVIDERS.has(v.provider)
        ? { kind: "provider", provider: v.provider, selector: selector(v.selector), via: v.via === "widget" || v.via === "fedcm" ? v.via : "button" }
        : undefined
    case "choose":
      return (v.intent === "passkey" || v.intent === "magic-link") && selector(v.selector)
        ? { kind: "choose", intent: v.intent, selector: selector(v.selector)! }
        : undefined
    case "submit":
      return { kind: "submit", via: v.via === "form" || v.via === "enter" ? v.via : "button", selector: selector(v.selector) }
    case "passkey":
      return {
        kind: "passkey",
        op: v.op === "create" ? "create" : "get",
        mediation: oneOf(v.mediation, MEDIATIONS),
        userVerification: oneOf(v.userVerification, USER_VERIFICATIONS),
        rpId: host(v.rpId),
        hasAllowList: typeof v.hasAllowList === "boolean" ? v.hasAllowList : undefined,
        result: v.result === "ok" || v.result === "cancelled" || v.result === "error" ? v.result : undefined,
      }
    case "redirect": {
      const to = v.host === "*" ? "*" : host(v.host)
      return to ? { kind: "redirect", host: to, provider: PROVIDERS.has(v.provider) ? v.provider : undefined } : undefined
    }
  }
  return undefined
}

function cleanSurface(v: any): Surface | undefined {
  if (!v || !host(v.host) || typeof v.path !== "string" || !KINDS.has(v.kind)) return undefined
  const control = (c: any) => (selector(c?.selector) ? { selector: selector(c.selector)! } : undefined)
  return {
    host: host(v.host)!,
    path: templatePath(v.path),
    frame: v.frame === "sub" ? "sub" : "top",
    kind: v.kind,
    fields: (Array.isArray(v.fields) ? v.fields : []).map(cleanField).filter(Boolean).slice(0, 20) as FieldSpec[],
    providers: (Array.isArray(v.providers) ? v.providers : [])
      .filter((p: any) => PROVIDERS.has(p?.provider))
      .map((p: any) => ({ provider: p.provider, selector: selector(p.selector) ?? "", via: p.via === "widget" ? "widget" : "button" }))
      .slice(0, 20),
    submit: control(v.submit),
    passkeyButton: control(v.passkeyButton),
    magicLinkButton: control(v.magicLinkButton),
    passkeyAutofill: v.passkeyAutofill === true ? true : undefined,
  }
}

function cleanStep(v: any): Step | undefined {
  if (!v || !(v.host === "*" || host(v.host)) || typeof v.path !== "string" || !KINDS.has(v.kind)) return undefined
  return {
    host: v.host === "*" ? "*" : host(v.host)!,
    path: templatePath(v.path),
    kind: v.kind,
    fields: (Array.isArray(v.fields) ? v.fields : []).map(cleanField).filter(Boolean).slice(0, 20) as FieldSpec[],
    actions: (Array.isArray(v.actions) ? v.actions : []).map(cleanAction).filter(Boolean).slice(0, 40) as Action[],
  }
}

function cleanSite(domain: string, v: any): SiteRecipe | undefined {
  if (!v || typeof v !== "object" || !host(domain)) return undefined
  const site = emptySite(registrableDomain(host(domain)!))
  site.updatedAt = date(v.updatedAt)
  site.hosts = (Array.isArray(v.hosts) ? v.hosts : []).map(host).filter(Boolean).slice(0, 20) as string[]
  for (const [m, stat] of Object.entries(v.offers ?? {})) {
    const s = stat as any
    if (/^(password|identifier-first|passkey|passkey-autofill|magic-link|otp|sso:[a-z]+)$/.test(m) && num(s?.seen))
      site.offers[m as Method] = { seen: num(s.seen)!, lastSeen: date(s.lastSeen) }
  }
  for (const rec of Array.isArray(v.surfaces) ? v.surfaces.slice(0, MAX_SURFACES) : []) {
    const surface = cleanSurface(rec?.surface)
    if (surface) site.surfaces.push({ signature: surfaceSignature(surface), surface, seen: num(rec.seen) || 1, lastSeen: date(rec.lastSeen) })
  }
  for (const rec of Array.isArray(v.flows) ? v.flows.slice(0, MAX_FLOWS) : []) {
    const steps = (Array.isArray(rec?.steps) ? rec.steps : []).map(cleanStep).filter(Boolean).slice(0, 12) as Step[]
    if (!steps.length) continue
    const { method, mfa } = classifyFlow(steps)
    recordFlow(site, {
      signature: flowSignature(steps),
      method,
      mfa,
      outcome: rec.outcome === "completed" ? "completed" : "unknown",
      steps,
      seen: num(rec.seen) || 1,
      firstSeen: date(rec.firstSeen),
      lastSeen: date(rec.lastSeen),
    })
  }
  return site
}

export function parseDataset(json: unknown): SiteRecipe[] {
  const data = json as any
  if (!data || data.format !== DATASET_FORMAT) throw new Error("Not a Foyer dataset (missing format: foyer.dataset)")
  if (data.version !== SCHEMA_VERSION) throw new Error(`Unsupported dataset version ${data.version}`)
  if (!data.sites || typeof data.sites !== "object") throw new Error("Dataset has no sites")
  return Object.entries(data.sites)
    .map(([domain, site]) => cleanSite(domain, site))
    .filter((s): s is SiteRecipe => !!s)
}

export type { SurfaceRecord }
