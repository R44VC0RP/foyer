// Generic adapter: any program that speaks the Foyer protocol over one
// request/response per run. The bridge writes a single JSON Request to its
// stdin and reads a single JSON Response from its stdout.
//
// - hello: reply { type: "hello", status?: "ready"|"locked"|"unavailable", detail? }
//   (or { providers: [ProviderInfo] }).
// - list: reply { type: "list", accounts: [{ ref, title, username?, hasPassword,
//   hasTotp, urls: string[] }] }. The bridge filters by `urls` itself and strips
//   them before forwarding.
// - fill: reply { type: "fill", username?, password?, totp? } or an ErrorResponse.
//   The bridge only forwards fills for refs it saw in a recent list with URLs
//   matching the domain.

import type { Account, ErrorResponse, ProviderInfo, Request, Secret } from "../../src/shared/protocol"
import { PROTOCOL_VERSION } from "../../src/shared/protocol"
import { ProviderError, log, run, stderrSummary, urlsMatchDomain } from "../util"
import type { Adapter, Secrets } from "./types"

const TIMEOUT_MS = 30_000
const HELLO_TTL_MS = 60_000
const SEEN_TTL_MS = 10 * 60_000
const ERROR_CODES = new Set<ErrorResponse["code"]>(["bad_request", "unknown_provider", "not_found", "domain_mismatch", "locked", "provider_error", "protocol"])

let counter = 0

export class CommandAdapter implements Adapter {
  readonly timeoutMs = TIMEOUT_MS
  private hello?: { at: number; info: Promise<ProviderInfo> }
  /** ref -> saved URLs from the most recent list calls. */
  private seen = new Map<string, { at: number; urls: string[] }>()

  constructor(
    readonly id: string,
    readonly name: string,
    private command: string[],
  ) {}

  private async call(request: Request): Promise<Record<string, unknown>> {
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

  info(): Promise<ProviderInfo> {
    if (this.hello && Date.now() - this.hello.at < HELLO_TTL_MS) return this.hello.info
    const info = this.computeInfo()
    this.hello = { at: Date.now(), info }
    return info
  }

  private async computeInfo(): Promise<ProviderInfo> {
    const base = { id: this.id, name: this.name }
    try {
      const reply = await this.call({ id: this.requestId(), type: "hello", protocol: PROTOCOL_VERSION, client: "foyer-bridge" })
      const first = Array.isArray(reply.providers) ? (reply.providers[0] as Record<string, unknown> | undefined) : undefined
      const status = (first?.status ?? reply.status ?? "ready") as string
      const detail = (first?.detail ?? reply.detail) as unknown
      return {
        ...base,
        status: status === "locked" || status === "unavailable" ? status : "ready",
        ...(typeof detail === "string" ? { detail: detail.slice(0, 200) } : {}),
      }
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : "provider_error"
      return { ...base, status: code === "locked" ? "locked" : "unavailable", detail: (err as Error).message }
    }
  }

  async list(domain: string, origin: string): Promise<Account[]> {
    const reply = await this.call({ id: this.requestId(), type: "list", domain, origin })
    if (!Array.isArray(reply.accounts)) throw new ProviderError("provider_error", `${this.name} returned no accounts array`)
    const now = Date.now()
    for (const [ref, entry] of this.seen) if (now - entry.at > SEEN_TTL_MS) this.seen.delete(ref)
    const accounts: Account[] = []
    for (const raw of reply.accounts as Array<Record<string, unknown>>) {
      if (!raw || typeof raw.ref !== "string" || typeof raw.title !== "string") continue
      const urls = Array.isArray(raw.urls) ? raw.urls.filter((u): u is string => typeof u === "string") : []
      if (!urlsMatchDomain(urls, domain)) continue
      this.seen.set(raw.ref, { at: now, urls })
      accounts.push({
        provider: this.id,
        ref: raw.ref,
        title: raw.title,
        ...(typeof raw.username === "string" ? { username: raw.username } : {}),
        hasPassword: raw.hasPassword === true,
        hasTotp: raw.hasTotp === true,
      })
    }
    return accounts
  }

  async fill(ref: string, domain: string, origin: string, want: Secret[]): Promise<Secrets> {
    const seen = this.seen.get(ref)
    if (!seen || Date.now() - seen.at > SEEN_TTL_MS || !urlsMatchDomain(seen.urls, domain)) {
      throw new ProviderError("domain_mismatch", "account was not listed for this site")
    }
    const reply = await this.call({ id: this.requestId(), type: "fill", provider: this.id, ref, domain, origin, want })
    const out: Secrets = {}
    for (const key of want) if (typeof reply[key] === "string") out[key] = reply[key] as string
    return out
  }
}
