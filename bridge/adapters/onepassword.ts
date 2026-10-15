// 1Password via the `op` CLI (v2). Relies on the desktop app integration, so
// the first call may wait on an approval prompt; hence the long timeout.

import type { Account, ProviderInfo, Secret } from "../../src/shared/protocol"
import { totpFromSecret } from "../totp"
import { ProviderError, findBinary, log, run, stderrSummary, urlsMatchDomain } from "../util"
import type { Adapter, Secrets } from "./types"

interface OpUrl {
  href?: string
}

interface OpListItem {
  id: string
  title?: string
  urls?: OpUrl[]
  url?: string
  additional_information?: string
}

interface OpField {
  type?: string
  purpose?: string
  value?: string
  totp?: string
}

interface OpItem extends OpListItem {
  fields?: OpField[]
}

const LIST_TTL_MS = 60_000
const LOCKED = /not (currently )?signed in|sign in|signin|authoriz|unlock|locked|session (has )?expired|no accounts? (configured|found)|connect to.*app/i
const NOT_FOUND = /isn't an item|not found|no item/i

function itemUrls(item: OpListItem): string[] {
  const urls = (item.urls ?? []).map((u) => u.href).filter((h): h is string => typeof h === "string")
  if (typeof item.url === "string") urls.push(item.url)
  return urls
}

export class OnePasswordAdapter implements Adapter {
  readonly name = "1Password"
  readonly timeoutMs = 45_000
  private cache?: { at: number; items: Promise<OpListItem[]> }

  constructor(
    readonly id: string,
    private account?: string,
    private path?: string,
  ) {}

  private bin(): string | undefined {
    return findBinary("op", this.path)
  }

  private async op(args: string[]): Promise<unknown> {
    const bin = this.bin()
    if (!bin) throw new ProviderError("provider_error", "op not found")
    const argv = [bin, ...args, "--format", "json"]
    if (this.account) argv.push("--account", this.account)
    const result = await run(argv, { timeoutMs: this.timeoutMs })
    if (result.timedOut) throw new ProviderError("provider_error", "op timed out (approval prompt not answered?)")
    if (result.code !== 0) {
      const message = stderrSummary(result.stderr)
      log(`${this.id}: op ${args[0]} ${args[1]} failed: ${message}`)
      if (LOCKED.test(result.stderr)) throw new ProviderError("locked", `1Password is locked or not signed in: ${message}`)
      if (NOT_FOUND.test(result.stderr)) throw new ProviderError("not_found", message)
      throw new ProviderError("provider_error", message)
    }
    try {
      return JSON.parse(result.stdout)
    } catch {
      throw new ProviderError("provider_error", "op returned invalid JSON")
    }
  }

  async info(): Promise<ProviderInfo> {
    // No `op whoami` preflight: it can itself trigger an approval prompt.
    return this.bin()
      ? { id: this.id, name: this.name, status: "ready" }
      : { id: this.id, name: this.name, status: "unavailable", detail: this.path ? `op not found at ${this.path}` : "op not found" }
  }

  private items(): Promise<OpListItem[]> {
    if (this.cache && Date.now() - this.cache.at < LIST_TTL_MS) return this.cache.items
    const items = this.op(["item", "list", "--categories", "Login"]).then((json) => {
      if (!Array.isArray(json)) throw new ProviderError("provider_error", "unexpected op item list output")
      return json.filter((i): i is OpListItem => i && typeof i.id === "string")
    })
    const entry = { at: Date.now(), items }
    this.cache = entry
    // Never cache failures.
    items.catch(() => {
      if (this.cache === entry) this.cache = undefined
    })
    return items
  }

  async list(domain: string): Promise<Account[]> {
    return (await this.items())
      .filter((item) => urlsMatchDomain(itemUrls(item), domain))
      .map((item) => ({
        provider: this.id,
        ref: item.id,
        title: item.title ?? "Untitled",
        username: item.additional_information || undefined,
        hasPassword: true,
        // Not knowable from `op item list`; fill still honours totp requests.
        hasTotp: false,
      }))
  }

  async fill(ref: string, domain: string, _origin: string, want: Secret[]): Promise<Secrets> {
    if (!/^[A-Za-z0-9]+$/.test(ref)) throw new ProviderError("bad_request", "invalid 1Password item id")
    const item = (await this.op(["item", "get", ref, "--reveal"])) as OpItem
    if (!item || typeof item !== "object") throw new ProviderError("provider_error", "unexpected op item get output")
    if (!urlsMatchDomain(itemUrls(item), domain)) throw new ProviderError("domain_mismatch", "item is not saved for this site")
    const fields = Array.isArray(item.fields) ? item.fields : []
    const out: Secrets = {}
    const byPurpose = (purpose: string) => fields.find((f) => f.purpose === purpose && typeof f.value === "string")?.value
    if (want.includes("username")) {
      const username = byPurpose("USERNAME")
      if (username) out.username = username
    }
    if (want.includes("password")) {
      const password = byPurpose("PASSWORD")
      if (password) out.password = password
    }
    if (want.includes("totp")) {
      const otp = fields.find((f) => f.type === "OTP")
      if (otp?.totp) out.totp = otp.totp
      else if (otp?.value) {
        try {
          out.totp = totpFromSecret(otp.value)
        } catch {
          log(`${this.id}: could not compute one-time code for item`)
        }
      }
    }
    return out
  }
}
