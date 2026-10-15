// Bitwarden via the `bw` CLI. Needs an unlocked session: BW_SESSION from the
// configured sessionFile or the environment (`bw unlock --raw > file`).

import { readFileSync } from "node:fs"
import type { Account, ProviderInfo, Secret } from "../../src/shared/protocol"
import { ProviderError, expandHome, findBinary, log, run, stderrSummary, urlsMatchDomain } from "../util"
import type { Adapter, Secrets } from "./types"

interface BwItem {
  id: string
  type?: number
  name?: string
  login?: {
    username?: string | null
    password?: string | null
    totp?: string | null
    uris?: Array<{ uri?: string | null }> | null
  } | null
}

const LOCKED = /locked|not logged in|unauthenticated|session/i
const NOT_FOUND = /not found/i
const STATUS_TTL_MS = 10_000

function itemUris(item: BwItem): string[] {
  return (item.login?.uris ?? []).map((u) => u.uri).filter((u): u is string => typeof u === "string")
}

export class BitwardenAdapter implements Adapter {
  readonly name = "Bitwarden"
  readonly timeoutMs = 20_000
  private status?: { at: number; info: Promise<ProviderInfo> }

  constructor(
    readonly id: string,
    private path?: string,
    private sessionFile?: string,
  ) {}

  private session(): string | undefined {
    if (this.sessionFile) {
      try {
        const value = readFileSync(expandHome(this.sessionFile), "utf8").trim()
        if (value) return value
      } catch {}
    }
    return process.env.BW_SESSION || undefined
  }

  private async bw(args: string[], timeoutMs = this.timeoutMs): Promise<string> {
    const bin = findBinary("bw", this.path)
    if (!bin) throw new ProviderError("provider_error", "bw not found")
    const session = this.session()
    if (!session) throw new ProviderError("locked", "no Bitwarden session (set sessionFile or BW_SESSION)")
    const result = await run([bin, ...args, "--nointeraction"], { timeoutMs, env: { BW_SESSION: session } })
    if (result.timedOut) throw new ProviderError("provider_error", "bw timed out")
    if (result.code !== 0) {
      const message = stderrSummary(result.stderr)
      log(`${this.id}: bw ${args[0]} ${args[1] ?? ""} failed: ${message}`)
      if (NOT_FOUND.test(result.stderr)) throw new ProviderError("not_found", message)
      if (LOCKED.test(result.stderr)) throw new ProviderError("locked", `Bitwarden is locked: ${message}`)
      throw new ProviderError("provider_error", message)
    }
    return result.stdout
  }

  private json(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      throw new ProviderError("provider_error", "bw returned invalid JSON")
    }
  }

  info(): Promise<ProviderInfo> {
    if (this.status && Date.now() - this.status.at < STATUS_TTL_MS) return this.status.info
    const info = this.computeInfo()
    this.status = { at: Date.now(), info }
    return info
  }

  private async computeInfo(): Promise<ProviderInfo> {
    const base = { id: this.id, name: this.name }
    if (!findBinary("bw", this.path)) return { ...base, status: "unavailable", detail: "bw not found" }
    if (!this.session()) return { ...base, status: "locked", detail: "no session: run `bw unlock --raw` into sessionFile or set BW_SESSION" }
    try {
      const status = (this.json(await this.bw(["status"], 10_000)) as { status?: string })?.status
      if (status === "unlocked") return { ...base, status: "ready" }
      return { ...base, status: "locked", detail: status === "unauthenticated" ? "not logged in (bw login)" : "vault is locked" }
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : "provider_error"
      return { ...base, status: code === "locked" ? "locked" : "unavailable", detail: (err as Error).message }
    }
  }

  async list(domain: string, origin: string): Promise<Account[]> {
    const json = this.json(await this.bw(["list", "items", "--url", origin]))
    if (!Array.isArray(json)) throw new ProviderError("provider_error", "unexpected bw list output")
    return (json as BwItem[])
      .filter((item) => item && typeof item.id === "string" && (item.type === undefined || item.type === 1))
      .filter((item) => urlsMatchDomain(itemUris(item), domain))
      .map((item) => ({
        provider: this.id,
        ref: item.id,
        title: item.name ?? "Untitled",
        username: item.login?.username || undefined,
        hasPassword: !!item.login?.password,
        hasTotp: !!item.login?.totp,
      }))
  }

  async fill(ref: string, domain: string, _origin: string, want: Secret[]): Promise<Secrets> {
    if (!/^[A-Za-z0-9-]+$/.test(ref)) throw new ProviderError("bad_request", "invalid Bitwarden item id")
    const item = this.json(await this.bw(["get", "item", ref])) as BwItem
    if (!item || typeof item !== "object") throw new ProviderError("provider_error", "unexpected bw get output")
    if (!urlsMatchDomain(itemUris(item), domain)) throw new ProviderError("domain_mismatch", "item is not saved for this site")
    const out: Secrets = {}
    if (want.includes("username") && item.login?.username) out.username = item.login.username
    if (want.includes("password") && item.login?.password) out.password = item.login.password
    if (want.includes("totp") && item.login?.totp) {
      const code = (await this.bw(["get", "totp", ref])).trim()
      if (/^\d{6,10}$/.test(code)) out.totp = code
    }
    return out
  }
}
