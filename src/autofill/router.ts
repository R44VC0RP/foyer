// Routes provider requests to where password managers live:
// - the native bridge (1Password, Bitwarden, command providers, demo vault)
// - browser extensions the user allowlisted, which implement the same
//   protocol over chrome.runtime.sendMessage (see docs/PROVIDERS.md)
//
// list/check/hello fan out to every source and merge; requests aimed at one
// account (fill, save, passkey-*) go to the source that owns that provider id.
// Extension providers are namespaced "ext:<extension id>:<their id>" so a
// provider can't impersonate another.

import type {
  AccountV2,
  CheckResponse,
  HelloResponse,
  ListResponse,
  ProviderInfoV2,
  RequestV2,
  ResponseV2,
} from "../shared/protocol"
import { PROTOCOL_VERSION } from "../shared/protocol"
import { BridgeError, request as bridgeRequest, type RequestBody } from "./bridge"

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never
type Body = DistributiveOmit<RequestV2, "id">

export async function extensionProviders(): Promise<string[]> {
  const { extensionProviders } = await chrome.storage.local.get("extensionProviders")
  return Array.isArray(extensionProviders) ? extensionProviders.filter((id) => typeof id === "string" && /^[a-p]{32}$/.test(id)) : []
}

const EXT_PREFIX = "ext:"
const extId = (provider: string) => (provider.startsWith(EXT_PREFIX) ? provider.split(":")[1] : undefined)
const innerProvider = (provider: string) => provider.split(":").slice(2).join(":")

async function askExtension<T>(extensionId: string, body: Body, timeoutMs: number): Promise<T> {
  const id = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const reply = await Promise.race([
    chrome.runtime.sendMessage(extensionId, { foyer: PROTOCOL_VERSION, ...body, id }),
    new Promise((_, reject) => setTimeout(() => reject(new BridgeError("timeout", `${extensionId} did not answer`)), timeoutMs)),
  ])
  const r = reply as ResponseV2 | undefined
  if (!r || typeof r !== "object") throw new BridgeError("provider_error", `${extensionId} sent no answer`)
  if (r.type === "error") throw new BridgeError(r.code, r.message)
  return r as T
}

const namespaced = (extensionId: string, provider: string) => `${EXT_PREFIX}${extensionId}:${provider}`

async function helloAll(timeoutMs: number): Promise<HelloResponse> {
  const exts = await extensionProviders()
  const [bridge, ...fromExts] = await Promise.allSettled([
    bridgeRequest<HelloResponse>({ type: "hello", protocol: PROTOCOL_VERSION, client: "foyer-extension" }, timeoutMs),
    ...exts.map((e) => askExtension<HelloResponse>(e, { type: "hello", protocol: PROTOCOL_VERSION, client: "foyer-extension" }, timeoutMs)),
  ])
  const providers: ProviderInfoV2[] = bridge.status === "fulfilled" ? (bridge.value.providers as ProviderInfoV2[]) : []
  fromExts.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      providers.push({ id: namespaced(exts[i], "?"), name: exts[i], status: "unavailable", detail: (r.reason as Error).message })
      return
    }
    for (const p of r.value.providers as ProviderInfoV2[]) providers.push({ ...p, id: namespaced(exts[i], p.id) })
  })
  if (bridge.status === "rejected" && !providers.length) throw bridge.reason
  return { id: "", type: "hello", protocol: PROTOCOL_VERSION, bridge: bridge.status === "fulfilled" ? bridge.value.bridge : "none", providers }
}

async function listAll(body: Extract<Body, { type: "list" }>, timeoutMs: number): Promise<ListResponse> {
  const exts = await extensionProviders()
  const [bridge, ...fromExts] = await Promise.allSettled([
    bridgeRequest<ListResponse>(body as RequestBody, timeoutMs),
    ...exts.map((e) => askExtension<ListResponse>(e, body, timeoutMs)),
  ])
  const accounts: AccountV2[] = []
  const errors: NonNullable<ListResponse["errors"]> = []
  if (bridge.status === "fulfilled") {
    accounts.push(...(bridge.value.accounts as AccountV2[]))
    errors.push(...(bridge.value.errors ?? []))
  } else if (!exts.length) throw bridge.reason
  else errors.push({ provider: "bridge", message: (bridge.reason as Error).message })
  fromExts.forEach((r, i) => {
    if (r.status !== "fulfilled") return void errors.push({ provider: exts[i], message: (r.reason as Error).message })
    for (const a of (r.value.accounts ?? []) as AccountV2[]) {
      if (typeof a?.ref !== "string" || typeof a.title !== "string") continue
      // Extensions are trusted only as far as their own answers; keep the shape tight.
      accounts.push({
        provider: namespaced(exts[i], String(a.provider ?? "default")),
        ref: a.ref,
        title: a.title.slice(0, 200),
        username: typeof a.username === "string" ? a.username.slice(0, 200) : undefined,
        hasPassword: !!a.hasPassword,
        hasTotp: !!a.hasTotp,
        kind: a.kind === "passkey" || a.kind === "sso" ? a.kind : "password",
        rpId: typeof a.rpId === "string" ? a.rpId : undefined,
        credentialId: typeof a.credentialId === "string" ? a.credentialId : undefined,
        sso: typeof a.sso === "string" ? a.sso : undefined,
      })
    }
  })
  return { id: "", type: "list", accounts, errors }
}

/** Allowlisted extensions that said they accept saves; only they see typed passwords. */
async function savingExtensions(timeoutMs: number): Promise<string[]> {
  const hello = await providersHello().catch(() => null)
  const exts = await extensionProviders()
  if (!hello) return []
  return exts.filter((e) =>
    (hello.providers as ProviderInfoV2[]).some((p) => p.id.startsWith(`${EXT_PREFIX}${e}:`) && p.status === "ready" && (p.capabilities ?? []).includes("save")),
  )
}

async function checkAll(body: Extract<Body, { type: "check" }>, timeoutMs: number): Promise<CheckResponse> {
  const exts = await savingExtensions(timeoutMs)
  const results = await Promise.allSettled([
    bridgeRequest<CheckResponse>(body as RequestBody, timeoutMs),
    ...exts.map((e) => askExtension<CheckResponse>(e, body, timeoutMs).then((r) => ({ ...r, matches: r.matches.map((m) => ({ ...m, provider: namespaced(e, m.provider) })) }))),
  ])
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
  if (!ok.length) throw (results[0] as PromiseRejectedResult).reason
  if (ok.some((r) => r.status === "same")) return { id: "", type: "check", status: "same", matches: [] }
  const updates = ok.filter((r) => r.status === "update")
  if (updates.length) return { id: "", type: "check", status: "update", matches: updates.flatMap((r) => r.matches) }
  return { id: "", type: "check", status: "new", matches: [] }
}

const writeListeners: Array<() => void> = []
/** Called after anything that changes what `list` returns (saves, new passkeys). */
export function onProviderWrite(listener: () => void) {
  writeListeners.push(listener)
}

/** Same signature as the bridge client; every caller goes through here. */
export async function request<T extends ResponseV2>(body: Body, timeoutMs = 60_000): Promise<T> {
  const reply = await route<T>(body, timeoutMs)
  if (body.type === "save" || body.type === "passkey-create") for (const l of writeListeners) l()
  return reply
}

async function route<T extends ResponseV2>(body: Body, timeoutMs: number): Promise<T> {
  switch (body.type) {
    case "hello":
      return (await helloAll(timeoutMs)) as T
    case "list":
      return (await listAll(body, timeoutMs)) as T
    case "check":
      return (await checkAll(body, timeoutMs)) as T
    default: {
      const ext = extId(body.provider)
      if (!ext) return bridgeRequest<T>(body as RequestBody, timeoutMs)
      if (!(await extensionProviders()).includes(ext)) throw new BridgeError("unknown_provider", "extension provider not allowed")
      const reply = await askExtension<T>(ext, { ...body, provider: innerProvider(body.provider) } as Body, timeoutMs)
      if (reply.type !== body.type) throw new BridgeError("provider_error", `${ext} answered ${reply.type} to ${body.type}`)
      if (reply.type === "save") return { ...reply, provider: body.provider } as T
      if (reply.type === "fill") {
        // Only strings, only what was asked for.
        const want = body.type === "fill" ? body.want : []
        const pick = (k: "username" | "password" | "totp") =>
          want.includes(k) && typeof (reply as any)[k] === "string" ? ((reply as any)[k] as string).slice(0, 4096) : undefined
        return { id: reply.id, type: "fill", username: pick("username"), password: pick("password"), totp: pick("totp") } as T
      }
      return reply
    }
  }
}

let hello: Promise<HelloResponse> | null = null
let helloAt = 0
/** Cached for a minute; the provider list rarely changes. */
export function providersHello(): Promise<HelloResponse> {
  if (!hello || Date.now() - helloAt > 60_000) {
    helloAt = Date.now()
    hello = request<HelloResponse>({ type: "hello", protocol: PROTOCOL_VERSION, client: "foyer-extension" }, 10_000)
    hello.catch(() => (hello = null))
  }
  return hello
}

export function resetProviders() {
  hello = null
}
