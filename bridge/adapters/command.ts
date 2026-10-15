// Generic adapter: any program that speaks the Foyer protocol over one
// request/response per run. The bridge writes a single JSON request to its
// stdin and reads a single JSON response from its stdout. See docs/PROVIDERS.md.
//
// - hello: reply { type: "hello", providers: [{ status, detail?, capabilities? }] }
//   (or top-level status/detail/capabilities). Capabilities default to list, fill.
// - list: accounts carry `urls: string[]`; the bridge filters by them (passkeys:
//   by rpId) and strips them before forwarding.
// - fill / save: forwarded as-is. Fills, password updates and passkey loads are
//   only forwarded for refs seen in a recent list that matched the domain.
// - store-passkey { record } -> { ref, userVerified? }
//   load-passkey { ref } -> { record, userVerified? }
//   The bridge does all WebAuthn crypto; the command only stores key material.

import type { AccountKind, AccountV2, Capability, ErrorResponse, ProviderInfoV2, RequestV2, SaveEntry, Secret } from "../../src/shared/protocol"
import { PROTOCOL_VERSION } from "../../src/shared/protocol"
import { ProviderError, hostMatches, log, run, stderrSummary, urlsMatchDomain } from "../util"
import { parseRecord, type PasskeyRecord } from "../webauthn"
import type { Adapter, LoadedPasskey, SaveResult, Secrets, StoredPasskey } from "./types"

type CommandRequest =
  | RequestV2
  | { id: string; type: "store-passkey"; record: PasskeyRecord }
  | { id: string; type: "load-passkey"; ref: string }

const TIMEOUT_MS = 30_000
const HELLO_TTL_MS = 60_000
const SEEN_TTL_MS = 10 * 60_000
const ERROR_CODES = new Set<ErrorResponse["code"]>(["bad_request", "unknown_provider", "not_found", "domain_mismatch", "locked", "provider_error", "protocol"])
const ALL_CAPABILITIES: Capability[] = ["list", "fill", "save", "passkeys", "sso"]
const DEFAULT_CAPABILITIES: Capability[] = ["list", "fill"]
const KINDS: AccountKind[] = ["password", "passkey", "sso"]

interface Seen {
  at: number
  kind: AccountKind
  urls: string[]
  rpId?: string
}

let counter = 0

export class CommandAdapter implements Adapter {
  readonly timeoutMs = TIMEOUT_MS
  private hello?: { at: number; info: Promise<ProviderInfoV2> }
  /** ref -> what the most recent list (or our own save) said about it. */
  private seen = new Map<string, Seen>()

  constructor(
    readonly id: string,
    readonly name: string,
    private command: string[],
  ) {}

  private async call(request: CommandRequest): Promise<Record<string, unknown>> {
    const result = await run(this.command, { timeoutMs: TIMEOUT_MS, input: JSON.stringify(request) })
    if (result.timedOut) throw new ProviderError("provider_error", `${this.name} timed out`)
    if (result.code !== 0) {
      const message = stderrSummary(result.stderr)
      log(`${this.id}: command exited ${result.code}: ${message}`)
      throw new ProviderError("provider_error", `${this.name} failed: ${message}`)
    }
    let json: unknown
    try {
      json = JSON.parse(result.stdout)
    } catch {
      throw new ProviderError("provider_error", `${this.name} returned invalid JSON`)
    }
    if (!json || typeof json !== "object") throw new ProviderError("provider_error", `${this.name} returned invalid JSON`)
    const response = json as Record<string, unknown>
    if (response.type === "error") {
      const code = ERROR_CODES.has(response.code as ErrorResponse["code"]) ? (response.code as ErrorResponse["code"]) : "provider_error"
      throw new ProviderError(code, typeof response.message === "string" ? response.message.slice(0, 200) : `${this.name} error`)
    }
    if (response.type !== request.type) throw new ProviderError("provider_error", `${this.name} replied with the wrong type`)
    return response
  }

  private requestId(): string {
    return `bridge-${++counter}`
  }

  private remember(ref: string, entry: Omit<Seen, "at">): void {
    const now = Date.now()
    for (const [key, value] of this.seen) if (now - value.at > SEEN_TTL_MS) this.seen.delete(key)
    this.seen.set(ref, { ...entry, at: now })
  }

  private recent(ref: string): Seen | undefined {
    const seen = this.seen.get(ref)
    return seen && Date.now() - seen.at <= SEEN_TTL_MS ? seen : undefined
  }

  info(): Promise<ProviderInfoV2> {
    if (this.hello && Date.now() - this.hello.at < HELLO_TTL_MS) return this.hello.info
    const info = this.computeInfo()
    this.hello = { at: Date.now(), info }
    return info
  }

  private async computeInfo(): Promise<ProviderInfoV2> {
    const base = { id: this.id, name: this.name }
    try {
      const reply = await this.call({ id: this.requestId(), type: "hello", protocol: PROTOCOL_VERSION, client: "foyer-bridge" })
      const first = Array.isArray(reply.providers) ? (reply.providers[0] as Record<string, unknown> | undefined) : undefined
      const status = (first?.status ?? reply.status ?? "ready") as string
      const detail = (first?.detail ?? reply.detail) as unknown
      const declared = first?.capabilities ?? reply.capabilities
      const capabilities = Array.isArray(declared)
        ? ALL_CAPABILITIES.filter((c) => declared.includes(c))
        : DEFAULT_CAPABILITIES
      return {
        ...base,
        status: status === "locked" || status === "unavailable" ? status : "ready",
        ...(typeof detail === "string" ? { detail: detail.slice(0, 200) } : {}),
        capabilities,
      }
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : "provider_error"
      return { ...base, status: code === "locked" ? "locked" : "unavailable", detail: (err as Error).message, capabilities: DEFAULT_CAPABILITIES }
    }
  }

  async list(domain: string, origin: string): Promise<AccountV2[]> {
    const reply = await this.call({ id: this.requestId(), type: "list", domain, origin })
    if (!Array.isArray(reply.accounts)) throw new ProviderError("provider_error", `${this.name} returned no accounts array`)
    const accounts: AccountV2[] = []
    for (const raw of reply.accounts as Array<Record<string, unknown>>) {
      if (!raw || typeof raw.ref !== "string" || typeof raw.title !== "string") continue
      const kind: AccountKind = KINDS.includes(raw.kind as AccountKind) ? (raw.kind as AccountKind) : "password"
      const urls = Array.isArray(raw.urls) ? raw.urls.filter((u): u is string => typeof u === "string") : []
      const base = {
        provider: this.id,
        ref: raw.ref,
        title: raw.title,
        ...(typeof raw.username === "string" ? { username: raw.username } : {}),
      }
      if (kind === "passkey") {
        const rpId = typeof raw.rpId === "string" ? raw.rpId.toLowerCase() : ""
        if (!rpId || typeof raw.credentialId !== "string" || !hostMatches(rpId, domain)) continue
        this.remember(raw.ref, { kind, urls, rpId })
        accounts.push({ ...base, kind, rpId, credentialId: raw.credentialId, hasPassword: false, hasTotp: false })
        continue
      }
      if (!urlsMatchDomain(urls, domain)) continue
      this.remember(raw.ref, { kind, urls })
      if (kind === "sso") {
        if (typeof raw.sso !== "string") continue
        accounts.push({ ...base, kind, sso: raw.sso, hasPassword: false, hasTotp: false })
      } else {
        accounts.push({ ...base, kind, hasPassword: raw.hasPassword === true, hasTotp: raw.hasTotp === true })
      }
    }
    return accounts
  }

  async fill(ref: string, domain: string, origin: string, want: Secret[]): Promise<Secrets> {
    const seen = this.recent(ref)
    if (!seen || seen.kind === "passkey" || !urlsMatchDomain(seen.urls, domain)) {
      throw new ProviderError("domain_mismatch", "account was not listed for this site")
    }
    const reply = await this.call({ id: this.requestId(), type: "fill", provider: this.id, ref, domain, origin, want })
    const out: Secrets = {}
    for (const key of want) if (typeof reply[key] === "string") out[key] = reply[key] as string
    return out
  }

  async save(domain: string, origin: string, entry: SaveEntry, ref?: string): Promise<SaveResult> {
    if (ref) {
      const seen = this.recent(ref)
      if (!seen || seen.kind !== "password" || !urlsMatchDomain(seen.urls, domain)) {
        throw new ProviderError("domain_mismatch", "account was not listed for this site")
      }
    }
    const reply = await this.call({ id: this.requestId(), type: "save", provider: this.id, domain, origin, entry, ...(ref ? { ref } : {}) })
    if (typeof reply.ref !== "string" || !reply.ref) throw new ProviderError("provider_error", `${this.name} returned no ref`)
    this.remember(reply.ref, { kind: entry.kind, urls: [entry.url] })
    return { ref: reply.ref, created: reply.created === true }
  }

  async storePasskey(record: PasskeyRecord): Promise<StoredPasskey> {
    const reply = await this.call({ id: this.requestId(), type: "store-passkey", record })
    if (typeof reply.ref !== "string" || !reply.ref) throw new ProviderError("provider_error", `${this.name} returned no ref`)
    this.remember(reply.ref, { kind: "passkey", urls: [`https://${record.rpId}`], rpId: record.rpId })
    return { ref: reply.ref, userVerified: reply.userVerified === true }
  }

  async loadPasskey(ref: string, rpId: string): Promise<LoadedPasskey> {
    const seen = this.recent(ref)
    if (!seen || seen.kind !== "passkey" || seen.rpId !== rpId) {
      throw new ProviderError("domain_mismatch", "passkey was not listed for this site")
    }
    const reply = await this.call({ id: this.requestId(), type: "load-passkey", ref })
    const record = parseRecord(reply.record)
    if (!record) throw new ProviderError("provider_error", `${this.name} returned an invalid passkey record`)
    if (record.rpId !== rpId) throw new ProviderError("domain_mismatch", "passkey belongs to another site")
    return { record, userVerified: reply.userVerified === true }
  }
}
