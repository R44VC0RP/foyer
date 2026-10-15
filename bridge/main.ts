// Foyer bridge: Chrome native messaging host "dev.foyer.bridge".
//
// Framing: each message is a 4-byte little-endian length followed by that many
// bytes of UTF-8 JSON, on stdin (from Chrome) and stdout (to Chrome). One
// long-lived process serves many requests concurrently; every response echoes
// the request id. stdout is reserved for frames, so all logging goes to stderr.

import type { Account, ErrorResponse, FillResponse, ListResponse, ProviderInfo, Request, Response, Secret } from "../src/shared/protocol"
import { PROTOCOL_VERSION } from "../src/shared/protocol"
import { registrableDomain } from "../src/shared/domains"
import { createAdapters, type Adapter } from "./adapters"
import { loadConfig } from "./config"
import { BRIDGE_VERSION, ProviderError, killChildren, log } from "./util"

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

function encode(message: Response): Buffer {
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

function send(message: Response): void {
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

/** Rejects empty, malformed or public-suffix "domains" (which would match everything under them). */
function validDomain(domain: string): boolean {
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false
  if (domain === "localhost") return true
  return registrableDomain(`x.${domain}`) !== `x.${domain}`
}

function parseRequest(raw: unknown): Request | ErrorResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return error("", "protocol", "message is not a JSON object")
  const r = raw as Record<string, unknown>
  if (!isStr(r.id, 200)) return error("", "bad_request", "missing id")
  const id = r.id
  switch (r.type) {
    case "hello":
      return { id, type: "hello", protocol: typeof r.protocol === "number" ? r.protocol : 0, client: typeof r.client === "string" ? r.client : "" }
    case "list":
    case "fill": {
      if (!isStr(r.domain, 253) || !isStr(r.origin)) return error(id, "bad_request", "domain and origin are required")
      const domain = r.domain.toLowerCase()
      if (!validDomain(domain)) return error(id, "bad_request", "invalid domain")
      if (r.type === "list") return { id, type: "list", domain, origin: r.origin }
      if (!isStr(r.provider, 100) || !isStr(r.ref, 500)) return error(id, "bad_request", "provider and ref are required")
      if (!Array.isArray(r.want) || r.want.length === 0 || !r.want.every((w) => SECRETS.includes(w as Secret))) {
        return error(id, "bad_request", "want must list username, password and/or totp")
      }
      const want = [...new Set(r.want as Secret[])]
      return { id, type: "fill", provider: r.provider, ref: r.ref, domain, origin: r.origin, want }
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

async function providerInfo(adapter: Adapter): Promise<ProviderInfo> {
  try {
    const info = await withTimeout(adapter.info(), HELLO_TIMEOUT_MS, adapter.name)
    return { ...info, id: adapter.id }
  } catch (err) {
    return { id: adapter.id, name: adapter.name, status: "unavailable", detail: (err as Error).message }
  }
}

async function handleList(id: string, domain: string, origin: string): Promise<Response> {
  const accounts: Account[] = []
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
        for (const account of found) accounts.push({ ...account, provider: adapter.id })
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

async function handleFill(request: Extract<Request, { type: "fill" }>): Promise<Response> {
  const adapter = adapters.find((a) => a.id === request.provider)
  if (!adapter) return error(request.id, "unknown_provider", `no provider ${request.provider}`)
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

async function handle(raw: unknown): Promise<Response> {
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
