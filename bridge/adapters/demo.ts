// Demo vault: a plain JSON file. For testing and as a reference adapter.
//
// {
//   "accounts": [ { "id", "title", "username"?, "password"?, "totpSecret"?: base32, "sso"?: "google", "urls": string[] } ],
//   "passkeys": [ { "ref", ...PasskeyRecord } ]
// }
//
// Writes go to a temp file that is renamed over the vault, so a crash never
// leaves a half-written file.

import { randomBytes } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import type { AccountV2, Capability, ProviderInfoV2, SaveEntry, Secret } from "../../src/shared/protocol"
import { totpFromSecret } from "../totp"
import { ProviderError, hostMatches, urlsMatchDomain } from "../util"
import { parseRecord, type PasskeyRecord } from "../webauthn"
import type { Adapter, LoadedPasskey, SaveResult, Secrets, StoredPasskey } from "./types"

interface DemoAccount {
  id: string
  title: string
  username?: string
  password?: string
  totpSecret?: string
  sso?: string
  urls: string[]
}

interface DemoVault {
  accounts: DemoAccount[]
  passkeys: Array<PasskeyRecord & { ref: string }>
  [key: string]: unknown
}

const CAPABILITIES: Capability[] = ["list", "fill", "save", "passkeys", "sso"]

export class DemoAdapter implements Adapter {
  readonly name = "Demo vault"
  readonly timeoutMs = 20_000
  /** Serialises read-modify-write cycles within this process. */
  private writing: Promise<unknown> = Promise.resolve()

  constructor(
    readonly id: string,
    private file: string,
    /** A JSON file verifies nobody; only claim UV when configured to (testing). */
    readonly verifiesUser = false,
  ) {}

  private async load(): Promise<DemoVault> {
    let json: unknown
    try {
      json = JSON.parse(await readFile(this.file, "utf8"))
    } catch (err) {
      throw new ProviderError("provider_error", `cannot read demo vault: ${(err as NodeJS.ErrnoException).code ?? "invalid JSON"}`)
    }
    const vault = json as Partial<DemoVault> | null
    if (!vault || !Array.isArray(vault.accounts)) throw new ProviderError("provider_error", "demo vault has no accounts array")
    return {
      ...vault,
      accounts: vault.accounts.filter(
        (a): a is DemoAccount => a && typeof a.id === "string" && typeof a.title === "string" && Array.isArray(a.urls),
      ),
      passkeys: (Array.isArray(vault.passkeys) ? vault.passkeys : []).filter((p) => p && typeof p.ref === "string" && parseRecord(p)),
    }
  }

  private update<T>(change: (vault: DemoVault) => T): Promise<T> {
    const run = this.writing.then(async () => {
      const vault = await this.load()
      const result = change(vault)
      const temp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
      await writeFile(temp, JSON.stringify(vault, null, 2) + "\n", { mode: 0o600 })
      await rename(temp, this.file)
      return result
    })
    this.writing = run.catch(() => {})
    return run
  }

  async info(): Promise<ProviderInfoV2> {
    try {
      await this.load()
      return { id: this.id, name: this.name, status: "ready", capabilities: CAPABILITIES }
    } catch (err) {
      return { id: this.id, name: this.name, status: "unavailable", detail: (err as Error).message, capabilities: CAPABILITIES }
    }
  }

  async list(domain: string): Promise<AccountV2[]> {
    const vault = await this.load()
    const accounts: AccountV2[] = vault.accounts
      .filter((a) => urlsMatchDomain(a.urls, domain))
      .map((a) =>
        a.sso
          ? { provider: this.id, ref: a.id, kind: "sso", sso: a.sso, title: a.title, username: a.username, hasPassword: false, hasTotp: false }
          : {
              provider: this.id,
              ref: a.id,
              kind: "password",
              title: a.title,
              username: a.username,
              hasPassword: !!a.password,
              hasTotp: !!a.totpSecret,
            },
      )
    for (const p of vault.passkeys) {
      if (!hostMatches(p.rpId, domain)) continue
      accounts.push({
        provider: this.id,
        ref: p.ref,
        kind: "passkey",
        title: `${p.rpId} passkey`,
        username: p.userName || undefined,
        rpId: p.rpId,
        credentialId: p.credentialId,
        hasPassword: false,
        hasTotp: false,
      })
    }
    return accounts
  }

  async fill(ref: string, domain: string, _origin: string, want: Secret[]): Promise<Secrets> {
    const account = (await this.load()).accounts.find((a) => a.id === ref)
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

  save(domain: string, _origin: string, entry: SaveEntry, ref?: string): Promise<SaveResult> {
    return this.update((vault) => {
      if (ref) {
        const account = vault.accounts.find((a) => a.id === ref)
        if (!account) throw new ProviderError("not_found", "no such account")
        if (!urlsMatchDomain(account.urls, domain)) throw new ProviderError("domain_mismatch", "account is not saved for this site")
        if (entry.kind !== "password") throw new ProviderError("bad_request", "only passwords can be updated")
        account.password = entry.password
        return { ref, created: false }
      }
      const id = `demo-${randomBytes(6).toString("hex")}`
      vault.accounts.push(
        entry.kind === "password"
          ? { id, title: entry.title, username: entry.username, password: entry.password, urls: [entry.url] }
          : { id, title: entry.title, ...(entry.username ? { username: entry.username } : {}), sso: entry.sso, urls: [entry.url] },
      )
      return { ref: id, created: true }
    })
  }

  storePasskey(record: PasskeyRecord): Promise<StoredPasskey> {
    return this.update((vault) => {
      const ref = `pk-${randomBytes(6).toString("hex")}`
      vault.passkeys.push({ ref, ...record })
      return { ref, userVerified: this.verifiesUser }
    })
  }

  async loadPasskey(ref: string, rpId: string): Promise<LoadedPasskey> {
    const stored = (await this.load()).passkeys.find((p) => p.ref === ref)
    const record = parseRecord(stored)
    if (!record) throw new ProviderError("not_found", "no such passkey")
    if (record.rpId !== rpId) throw new ProviderError("domain_mismatch", "passkey belongs to another site")
    return { record, userVerified: this.verifiesUser }
  }
}
