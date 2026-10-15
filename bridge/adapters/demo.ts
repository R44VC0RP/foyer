// Demo vault: a plain JSON file. For testing and as a reference adapter.
//
// { "accounts": [ { "id", "title", "username", "password", "totpSecret"?: base32, "urls": string[] } ] }

import { readFile } from "node:fs/promises"
import type { Account, ProviderInfo, Secret } from "../../src/shared/protocol"
import { totpFromSecret } from "../totp"
import { ProviderError, urlsMatchDomain } from "../util"
import type { Adapter, Secrets } from "./types"

interface DemoAccount {
  id: string
  title: string
  username?: string
  password?: string
  totpSecret?: string
  urls: string[]
}

export class DemoAdapter implements Adapter {
  readonly name = "Demo vault"
  readonly timeoutMs = 20_000

  constructor(
    readonly id: string,
    private file: string,
  ) {}

  private async load(): Promise<DemoAccount[]> {
    let json: unknown
    try {
      json = JSON.parse(await readFile(this.file, "utf8"))
    } catch (err) {
      throw new ProviderError("provider_error", `cannot read demo vault: ${(err as NodeJS.ErrnoException).code ?? "invalid JSON"}`)
    }
    const accounts = (json as { accounts?: unknown })?.accounts
    if (!Array.isArray(accounts)) throw new ProviderError("provider_error", "demo vault has no accounts array")
    return accounts.filter(
      (a): a is DemoAccount => a && typeof a.id === "string" && typeof a.title === "string" && Array.isArray(a.urls),
    )
  }

  async info(): Promise<ProviderInfo> {
    try {
      await this.load()
      return { id: this.id, name: this.name, status: "ready" }
    } catch (err) {
      return { id: this.id, name: this.name, status: "unavailable", detail: (err as Error).message }
    }
  }

  async list(domain: string): Promise<Account[]> {
    return (await this.load())
      .filter((a) => urlsMatchDomain(a.urls, domain))
      .map((a) => ({
        provider: this.id,
        ref: a.id,
        title: a.title,
        username: a.username,
        hasPassword: !!a.password,
        hasTotp: !!a.totpSecret,
      }))
  }

  async fill(ref: string, domain: string, _origin: string, want: Secret[]): Promise<Secrets> {
    const account = (await this.load()).find((a) => a.id === ref)
    if (!account) throw new ProviderError("not_found", "no such account")
    if (!urlsMatchDomain(account.urls, domain)) throw new ProviderError("domain_mismatch", "account is not saved for this site")
    const out: Secrets = {}
    if (want.includes("username") && account.username) out.username = account.username
    if (want.includes("password") && account.password) out.password = account.password
    if (want.includes("totp") && account.totpSecret) {
      try {
        out.totp = totpFromSecret(account.totpSecret)
      } catch {
        throw new ProviderError("provider_error", "invalid totpSecret")
      }
    }
    return out
  }
}
