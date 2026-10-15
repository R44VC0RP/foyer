// Foyer bridge: Chrome native messaging host "dev.foyer.bridge".
//
// Framing: each message is a 4-byte little-endian length followed by that many
// bytes of UTF-8 JSON, on stdin (from Chrome) and stdout (to Chrome). One
// long-lived process serves many requests concurrently; every response echoes
// the request id. stdout is reserved for frames, so all logging goes to stderr.

import { createHash, timingSafeEqual } from "node:crypto"
import type {
  AccountV2,
  Capability,
  CheckResponse,
  ErrorResponse,
  FillResponse,
  ListResponse,
  PasskeyCreateResponse,
  PasskeyGetResponse,
  ProviderInfoV2,
  RequestV2,
  ResponseV2,
  SaveEntry,
  SaveResponse,
  Secret,
} from "../src/shared/protocol"
import { PROTOCOL_VERSION, hostMatchesDomain } from "../src/shared/protocol"
import { registrableDomain } from "../src/shared/domains"
import { createAdapters, type Adapter } from "./adapters"
import { loadConfig } from "./config"
import { BRIDGE_VERSION, ProviderError, killChildren, log, urlHost, urlsMatchDomain } from "./util"
import { ES256, assertPasskey, attestPasskey, newPasskeyRecord } from "./webauthn"

/** Chrome rejects host -> browser messages of 1 MB or more. */
const MAX_OUT = 1024 * 1024 - 1
/** Requests are tiny; anything bigger is a protocol error. */
const MAX_IN = 64 * 1024
const MAX_ACCOUNTS = 500
const HELLO_TIMEOUT_MS = 10_000
const SECRETS: readonly Secret[] = ["username", "password", "totp"]

const config = loadConfig()
const adapters = createAdapters(config)
log(`started v${BRIDGE_VERSION}; config ${config.source ?? "auto-detected"}; providers: ${adapters.map((a) => a.id).join(", ") || "none"}`)

// ---- Output -------------------------------------------------------------------

function encode(message: ResponseV2): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function fitList(message: ListResponse): Buffer {
  let frame = encode(message)
  while (frame.length - 4 > MAX_OUT && message.accounts.length > 0) {
    const keep = Math.floor(message.accounts.length / 2)
    message = {
      ...message,
      accounts: message.accounts.slice(0, keep),
      errors: [...(message.errors ?? []).slice(0, 20), { provider: "bridge", message: "too many accounts; list truncated" }],
    }
    frame = encode(message)
  }
  return frame
}

process.stdout.on("error", (err) => {
  log(`stdout closed (${(err as NodeJS.ErrnoException).code ?? err.message}); exiting`)
  shutdown(0)
})

function send(message: ResponseV2): void {
  let frame = message.type === "list" ? fitList(message) : encode(message)
  if (frame.length - 4 > MAX_OUT) {
    frame = encode({ id: message.id, type: "error", code: "provider_error", message: "response too large" })
  }
  process.stdout.write(frame)
}

function error(id: string, code: ErrorResponse["code"], message: string): ErrorResponse {
  return { id, type: "error", code, message }
}

// ---- Request validation -------------------------------------------------------

const isStr = (v: unknown, max = 2048): v is string => typeof v === "string" && v.length > 0 && v.length <= max
const isOptStr = (v: unknown, max = 2048): v is string | undefined => v === undefined || (typeof v === "string" && v.length <= max)
const isB64url = (v: unknown, max = 1024): v is string => isStr(v, max) && /^[A-Za-z0-9_-]+={0,2}$/.test(v)

/** Rejects empty, malformed or public-suffix "domains" (which would match everything under them). */
function validDomain(domain: string): boolean {
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false
  if (domain === "localhost") return true
  return registrableDomain(`x.${domain}`) !== `x.${domain}`
}

/** https URL (or http on localhost), returning its host. */
function webOrigin(url: string): string | undefined {
  try {
    const u = new URL(url)
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname.endsWith(".localhost")
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.hostname.toLowerCase()
  } catch {}
  return undefined
}

function parseEntry(raw: unknown): SaveEntry | string {
  if (!raw || typeof raw !== "object") return "entry is required"
  const e = raw as Record<string, unknown>
  if (!isStr(e.title, 200) || !isStr(e.url) || !urlHost(e.url)) return "entry needs a title and url"
  if (e.kind === "password") {
    if (typeof e.username !== "string" || e.username.length > 500 || !isStr(e.password, 4096)) return "entry needs a username and password"
    return { kind: "password", title: e.title, url: e.url, username: e.username, password: e.password }
  }
  if (e.kind === "sso") {
    if (!isStr(e.sso, 40) || !/^[a-z0-9._-]+$/.test(e.sso) || !isOptStr(e.username, 500)) return "entry needs a valid sso provider id"
    return { kind: "sso", title: e.title, url: e.url, sso: e.sso, ...(e.username ? { username: e.username } : {}) }
  }
  return "entry.kind must be password or sso"
}

function parseRequest(raw: unknown): RequestV2 | ErrorResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return error("", "protocol", "message is not a JSON object")
  const r = raw as Record<string, unknown>
  if (!isStr(r.id, 200)) return error("", "bad_request", "missing id")
  const id = r.id
  switch (r.type) {
    case "hello":
      return { id, type: "hello", protocol: typeof r.protocol === "number" ? r.protocol : 0, client: typeof r.client === "string" ? r.client : "" }
    case "list":
    case "fill":
    case "check":
    case "save": {
      if (!isStr(r.domain, 253) || !isStr(r.origin)) return error(id, "bad_request", "domain and origin are required")
      const domain = r.domain.toLowerCase()
      if (!validDomain(domain)) return error(id, "bad_request", "invalid domain")
      const origin = r.origin
      if (r.type === "list") return { id, type: "list", domain, origin }
      if (r.type === "check") {
        if (typeof r.username !== "string" || r.username.length > 500 || !isStr(r.password, 4096)) {
          return error(id, "bad_request", "username and password are required")
        }
        return { id, type: "check", domain, origin, username: r.username, password: r.password }
      }
      if (!isStr(r.provider, 100)) return error(id, "bad_request", "provider is required")
      if (r.type === "save") {
        const entry = parseEntry(r.entry)
        if (typeof entry === "string") return error(id, "bad_request", entry)
        if (!isOptStr(r.ref, 500)) return error(id, "bad_request", "invalid ref")
        return { id, type: "save", provider: r.provider, domain, origin, entry, ...(r.ref ? { ref: r.ref } : {}) }
      }
      if (!isStr(r.ref, 500)) return error(id, "bad_request", "ref is required")
      if (!Array.isArray(r.want) || r.want.length === 0 || !r.want.every((w) => SECRETS.includes(w as Secret))) {
        return error(id, "bad_request", "want must list username, password and/or totp")
      }
      const want = [...new Set(r.want as Secret[])]
      return { id, type: "fill", provider: r.provider, ref: r.ref, domain, origin, want }
    }
    case "passkey-create":
    case "passkey-get": {
      if (!isStr(r.provider, 100) || !isStr(r.rpId, 253) || !isStr(r.origin)) return error(id, "bad_request", "provider, rpId and origin are required")
      const rpId = r.rpId.toLowerCase()
      if (!validDomain(rpId)) return error(id, "bad_request", "invalid rpId")
      const host = webOrigin(r.origin)
      if (!host || !hostMatchesDomain(host, rpId)) return error(id, "bad_request", "rpId is not valid for this origin")
      if (!isB64url(r.clientDataHash, 64)) return error(id, "bad_request", "invalid clientDataHash")
      if (!isOptStr(r.userVerification, 20)) return error(id, "bad_request", "invalid userVerification")
      if (r.type === "passkey-get") {
        if (!isStr(r.ref, 500)) return error(id, "bad_request", "ref is required")
        return {
          id,
          type: "passkey-get",
          provider: r.provider,
          ref: r.ref,
          rpId,
          origin: r.origin,
          clientDataHash: r.clientDataHash,
          ...(r.userVerification ? { userVerification: r.userVerification } : {}),
        }
      }
      const user = r.user as Record<string, unknown> | undefined
      if (!user || !isB64url(user.id, 128) || typeof user.name !== "string" || typeof user.displayName !== "string" || user.name.length > 256 || user.displayName.length > 256) {
        return error(id, "bad_request", "invalid user")
      }
      const algorithms = Array.isArray(r.algorithms) ? r.algorithms : []
      const exclude = Array.isArray(r.excludeCredentialIds) ? r.excludeCredentialIds : []
      if (!algorithms.every((a) => Number.isInteger(a)) || !exclude.every((c) => typeof c === "string") || exclude.length > 100) {
        return error(id, "bad_request", "invalid algorithms or excludeCredentialIds")
      }
      return {
        id,
        type: "passkey-create",
        provider: r.provider,
        rpId,
        origin: r.origin,
        clientDataHash: r.clientDataHash,
        user: { id: user.id, name: user.name, displayName: user.displayName },
        algorithms: algorithms as number[],
        excludeCredentialIds: exclude as string[],
        ...(r.userVerification ? { userVerification: r.userVerification } : {}),
      }
    }
    default:
      return error(id, "bad_request", `unknown request type ${JSON.stringify(r.type)}`)
  }
}

// ---- Handlers -----------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: Timer | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError("provider_error", `${what} timed out`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function providerInfo(adapter: Adapter): Promise<ProviderInfoV2> {
  try {
    const info = await withTimeout(adapter.info(), HELLO_TIMEOUT_MS, adapter.name)
    return { ...info, id: adapter.id }
  } catch (err) {
    return { id: adapter.id, name: adapter.name, status: "unavailable", detail: (err as Error).message, capabilities: [] }
  }
}

/** The adapter for `provider`, checked to be usable for `capability`. */
async function adapterFor(provider: string, capability: Capability): Promise<Adapter> {
  const adapter = adapters.find((a) => a.id === provider)
  if (!adapter) throw new ProviderError("unknown_provider", `no provider ${provider}`)
  const info = await providerInfo(adapter)
  if (!(info.capabilities ?? ["list", "fill"]).includes(capability)) {
    throw new ProviderError("bad_request", `${adapter.name} does not support ${capability}`)
  }
  if (info.status === "unavailable") throw new ProviderError("provider_error", `${adapter.name} is unavailable${info.detail ? `: ${info.detail}` : ""}`)
  return adapter
}

async function handleList(id: string, domain: string, origin: string): Promise<ListResponse> {
  const accounts: AccountV2[] = []
  const errors: Array<{ provider: string; message: string }> = []
  await Promise.all(
    adapters.map(async (adapter) => {
      const info = await providerInfo(adapter)
      if (info.status === "unavailable") return
      if (info.status === "locked") {
        errors.push({ provider: adapter.id, message: info.detail ? `locked: ${info.detail}` : "locked" })
        return
      }
      try {
        const found = await withTimeout(adapter.list(domain, origin), adapter.timeoutMs, adapter.name)
        for (const account of found) accounts.push({ ...account, kind: account.kind ?? "password", provider: adapter.id })
      } catch (err) {
        const message = (err as Error).message
        const locked = err instanceof ProviderError && err.code === "locked" && !/locked/i.test(message)
        errors.push({ provider: adapter.id, message: locked ? `locked: ${message}` : message })
      }
    }),
  )
  const response: ListResponse = { id, type: "list", accounts: accounts.slice(0, MAX_ACCOUNTS) }
  if (errors.length) response.errors = errors
  return response
}

async function handleFill(request: Extract<RequestV2, { type: "fill" }>): Promise<FillResponse> {
  const adapter = await adapterFor(request.provider, "fill")
  const secrets = await withTimeout(
    adapter.fill(request.ref, request.domain, request.origin, request.want),
    adapter.timeoutMs,
    adapter.name,
  )
  const response: FillResponse = { id: request.id, type: "fill" }
  // Only ever return what was asked for.
  for (const key of request.want) if (typeof secrets[key] === "string" && secrets[key]) response[key] = secrets[key]
  log(`fill ${adapter.id} for ${request.domain}: returned ${request.want.filter((k) => response[k]).join(", ") || "nothing"}`)
  return response
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()
const normalizeUser = (value: string) => value.trim().toLowerCase()

/** Compares a submitted login with saved ones. Never returns or logs secrets. */
async function handleCheck(request: Extract<RequestV2, { type: "check" }>): Promise<CheckResponse> {
  const username = normalizeUser(request.username)
  const submitted = digest(request.password)
  const same: CheckResponse["matches"] = []
  const differs: CheckResponse["matches"] = []
  await Promise.all(
    adapters.map(async (adapter) => {
      const info = await providerInfo(adapter)
      if (info.status !== "ready" || !info.capabilities?.includes("save")) return
      try {
        await withTimeout(
          (async () => {
            const accounts = (await adapter.list(request.domain, request.origin)).filter(
              (a) => (a.kind ?? "password") === "password" && a.username !== undefined && normalizeUser(a.username) === username,
            )
            for (const account of accounts) {
              const { password } = await adapter.fill(account.ref, request.domain, request.origin, ["password"])
              const match = { provider: adapter.id, ref: account.ref }
              if (password !== undefined && timingSafeEqual(digest(password), submitted)) same.push(match)
              else differs.push(match)
            }
          })(),
          adapter.timeoutMs,
          adapter.name,
        )
      } catch (err) {
        log(`check: ${adapter.id} skipped: ${(err as Error).message}`)
      }
    }),
  )
  if (same.length) return { id: request.id, type: "check", status: "same", matches: same }
  if (differs.length) return { id: request.id, type: "check", status: "update", matches: differs }
  return { id: request.id, type: "check", status: "new", matches: [] }
}

async function handleSave(request: Extract<RequestV2, { type: "save" }>): Promise<SaveResponse> {
  const adapter = await adapterFor(request.provider, request.entry.kind === "sso" ? "sso" : "save")
  if (!adapter.save) throw new ProviderError("bad_request", `${adapter.name} does not support saving`)
  if (request.ref && request.entry.kind !== "password") throw new ProviderError("bad_request", "only passwords can be updated")
  if (!urlsMatchDomain([request.entry.url], request.domain)) throw new ProviderError("domain_mismatch", "entry url is not on this site")
  const result = await withTimeout(adapter.save(request.domain, request.origin, request.entry, request.ref), adapter.timeoutMs, adapter.name)
  log(`save ${adapter.id} ${request.entry.kind} for ${request.domain}: ${result.created ? "created" : "updated"}`)
  return { id: request.id, type: "save", provider: adapter.id, ref: result.ref, created: result.created }
}

async function handlePasskeyCreate(request: Extract<RequestV2, { type: "passkey-create" }>): Promise<PasskeyCreateResponse> {
  if (request.algorithms.length && !request.algorithms.includes(ES256)) throw new ProviderError("bad_request", "only ES256 (-7) is supported")
  const adapter = await adapterFor(request.provider, "passkeys")
  if (!adapter.storePasskey) throw new ProviderError("bad_request", `${adapter.name} does not support passkeys`)
  // Don't store a passkey the site will reject for lack of user verification.
  const uvRequired = request.userVerification === "required"
  if (uvRequired && adapter.verifiesUser === false)
    throw new ProviderError("provider_error", `${adapter.name} can't verify the user, which this site requires`)
  return withTimeout(
    (async () => {
      if (request.excludeCredentialIds.length) {
        const existing = await adapter.list(request.rpId, request.origin)
        const excluded = existing.some(
          (a) => a.kind === "passkey" && a.rpId === request.rpId && a.credentialId && request.excludeCredentialIds.includes(a.credentialId),
        )
        if (excluded) throw new ProviderError("provider_error", "excluded")
      }
      const record = newPasskeyRecord({ rpId: request.rpId, user: request.user })
      const stored = await adapter.storePasskey!(record)
      if (uvRequired && !stored.userVerified) throw new ProviderError("provider_error", `${adapter.name} didn't verify the user, which this site requires`)
      const attestation = attestPasskey({ record, clientDataHash: request.clientDataHash, userVerified: stored.userVerified })
      log(`passkey-create ${adapter.id} for ${request.rpId}`)
      return {
        id: request.id,
        type: "passkey-create" as const,
        ref: stored.ref,
        credentialId: record.credentialId,
        ...attestation,
        userVerified: stored.userVerified,
      }
    })(),
    adapter.timeoutMs,
    adapter.name,
  )
}

async function handlePasskeyGet(request: Extract<RequestV2, { type: "passkey-get" }>): Promise<PasskeyGetResponse> {
  const adapter = await adapterFor(request.provider, "passkeys")
  if (!adapter.loadPasskey) throw new ProviderError("bad_request", `${adapter.name} does not support passkeys`)
  const { record, userVerified } = await withTimeout(adapter.loadPasskey(request.ref, request.rpId), adapter.timeoutMs, adapter.name)
  if (record.rpId !== request.rpId) throw new ProviderError("domain_mismatch", "passkey belongs to another site")
  if (request.userVerification === "required" && !userVerified) {
    throw new ProviderError("provider_error", `${adapter.name} cannot verify the user`)
  }
  let assertion
  try {
    assertion = assertPasskey({ record, rpId: request.rpId, clientDataHash: request.clientDataHash, userVerified })
  } catch (err) {
    throw new ProviderError("provider_error", (err as Error).message)
  }
  log(`passkey-get ${adapter.id} for ${request.rpId}`)
  return {
    id: request.id,
    type: "passkey-get",
    credentialId: record.credentialId,
    ...assertion,
    userHandle: record.userHandle,
    userVerified,
  }
}

async function handle(raw: unknown): Promise<ResponseV2> {
  const request = parseRequest(raw)
  if (request.type === "error") return request
  try {
    switch (request.type) {
      case "hello":
        return {
          id: request.id,
          type: "hello",
          protocol: PROTOCOL_VERSION,
          bridge: BRIDGE_VERSION,
          providers: await Promise.all(adapters.map(providerInfo)),
        }
      case "list":
        return await handleList(request.id, request.domain, request.origin)
      case "fill":
        return await handleFill(request)
      case "check":
        return await handleCheck(request)
      case "save":
        return await handleSave(request)
      case "passkey-create":
        return await handlePasskeyCreate(request)
      case "passkey-get":
        return await handlePasskeyGet(request)
    }
  } catch (err) {
    if (err instanceof ProviderError) return error(request.id, err.code, err.message)
    log(`unexpected error handling ${request.type}: ${(err as Error).message}`)
    return error(request.id, "provider_error", "internal bridge error")
  }
}

// ---- Input loop ---------------------------------------------------------------

const inFlight = new Set<Promise<void>>()

function dispatch(body: Buffer): void {
  let raw: unknown
  try {
    raw = JSON.parse(body.toString("utf8"))
  } catch {
    send(error("", "protocol", "message is not valid JSON"))
    return
  }
  const task = handle(raw)
    .then(send, (err) => {
      log(`handler crashed: ${(err as Error).message}`)
      const id = (raw as { id?: unknown })?.id
      send(error(typeof id === "string" ? id : "", "provider_error", "internal bridge error"))
    })
    .finally(() => inFlight.delete(task))
  inFlight.add(task)
}

let stopping = false
function shutdown(code: number): void {
  if (stopping) return
  stopping = true
  killChildren()
  process.exit(code)
}

process.on("uncaughtException", (err) => log(`uncaught: ${err.message}`))
process.on("unhandledRejection", (err) => log(`unhandled rejection: ${(err as Error)?.message ?? String(err)}`))

async function main(): Promise<void> {
  let buffer = Buffer.alloc(0)
  let skip = 0
  for await (const chunk of Bun.stdin.stream()) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)])
    while (true) {
      if (skip > 0) {
        const n = Math.min(skip, buffer.length)
        buffer = buffer.subarray(n)
        skip -= n
        if (skip > 0) break
      }
      if (buffer.length < 4) break
      const length = buffer.readUInt32LE(0)
      if (length > MAX_IN) {
        // Drop the oversized frame and resynchronise after it.
        send(error("", "protocol", "message too large"))
        buffer = buffer.subarray(4)
        skip = length
        continue
      }
      if (buffer.length < 4 + length) break
      const body = Buffer.from(buffer.subarray(4, 4 + length))
      buffer = buffer.subarray(4 + length)
      dispatch(body)
    }
  }
  // stdin closed: Chrome disconnected. Let in-flight work finish briefly, then exit.
  await Promise.race([Promise.allSettled([...inFlight]), Bun.sleep(5_000)])
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
  shutdown(0)
}

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`)
  shutdown(1)
})
