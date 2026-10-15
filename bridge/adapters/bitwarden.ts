// Bitwarden via the `bw` CLI. Needs an unlocked session: BW_SESSION from the
// configured sessionFile or the environment (`bw unlock --raw > file`).
//
// Secrets never go in argv: new and edited items are base64-encoded JSON (what
// `bw encode` produces) piped to `bw create item` / `bw edit item <id>` on stdin.
//
// Foyer-specific items are Login items with custom fields:
// - Sign-in methods: text field "foyer.sso" = provider id.
// - Passkeys: hidden field "foyer.passkey.privateKey" and text fields
//   foyer.passkey.{credentialId,userHandle,rpId,displayName}.

import { readFileSync } from "node:fs"
import type { AccountV2, Capability, ProviderInfoV2, SaveEntry, Secret } from "../../src/shared/protocol"
import { ProviderError, expandHome, findBinary, hostMatches, log, run, stderrSummary, urlsMatchDomain } from "../util"
import { parseRecord, type PasskeyRecord } from "../webauthn"
import type { Adapter, LoadedPasskey, SaveResult, Secrets, StoredPasskey } from "./types"

interface BwField {
  name?: string | null
  value?: string | null
  type?: number
}

interface BwItem {
  id: string
  type?: number
  name?: string
  fields?: BwField[] | null
  login?: {
    username?: string | null
    password?: string | null
    totp?: string | null
    uris?: Array<{ uri?: string | null; match?: number | null }> | null
  } | null
  [key: string]: unknown
}

const CAPABILITIES: Capability[] = ["list", "fill", "save", "passkeys", "sso"]
const LOCKED = /locked|not logged in|unauthenticated|session/i
const NOT_FOUND = /not found/i
const STATUS_TTL_MS = 10_000
const FIELD_TEXT = 0
const FIELD_HIDDEN = 1
const F = {
  sso: "foyer.sso",
  privateKey: "foyer.passkey.privateKey",
  credentialId: "foyer.passkey.credentialId",
  userHandle: "foyer.passkey.userHandle",
  rpId: "foyer.passkey.rpId",
  displayName: "foyer.passkey.displayName",
}

function itemUris(item: BwItem): string[] {
  return (item.login?.uris ?? []).map((u) => u.uri).filter((u): u is string => typeof u === "string")
}

function field(item: BwItem, name: string): string | undefined {
  const value = (item.fields ?? []).find((f) => f.name === name)?.value
  return typeof value === "string" && value ? value : undefined
}

function newItem(name: string, url: string, login: { username?: string; password?: string }, fields: BwField[]) {
  return {
    organizationId: null,
    collectionIds: null,
    folderId: null,
    type: 1,
    name,
    notes: null,
    favorite: false,
    reprompt: 0,
    fields,
    login: { uris: [{ match: null, uri: url }], username: login.username ?? null, password: login.password ?? null, totp: null },
  }
}

export class BitwardenAdapter implements Adapter {
  readonly name = "Bitwarden"
  readonly timeoutMs = 20_000
  private status?: { at: number; info: Promise<ProviderInfoV2> }

  constructor(
    readonly id: string,
    private path?: string,
    private sessionFile?: string,
    /**
     * A saved session file never re-asks the user, so passkeys don't claim user
     * verification unless the config opts in (userVerified: true).
     */
    readonly verifiesUser = false,
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

  private async bw(args: string[], options: { timeoutMs?: number; input?: string } = {}): Promise<string> {
    const bin = findBinary("bw", this.path)
    if (!bin) throw new ProviderError("provider_error", "bw not found")
    const session = this.session()
    if (!session) throw new ProviderError("locked", "no Bitwarden session (set sessionFile or BW_SESSION)")
    const result = await run([bin, ...args, "--nointeraction"], {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      input: options.input,
      env: { BW_SESSION: session },
    })
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

  /** Same as `bw encode`, done in-process so the JSON never touches argv. */
  private async write(args: string[], item: unknown): Promise<BwItem> {
    const encoded = Buffer.from(JSON.stringify(item), "utf8").toString("base64")
    const result = this.json(await this.bw(args, { input: encoded })) as BwItem
    if (!result || typeof result.id !== "string") throw new ProviderError("provider_error", `bw ${args.join(" ")} returned no id`)
    return result
  }

  info(): Promise<ProviderInfoV2> {
    if (this.status && Date.now() - this.status.at < STATUS_TTL_MS) return this.status.info
    const info = this.computeInfo()
    this.status = { at: Date.now(), info }
    return info
  }

  private async computeInfo(): Promise<ProviderInfoV2> {
    const base = { id: this.id, name: this.name, capabilities: CAPABILITIES }
    if (!findBinary("bw", this.path)) return { ...base, status: "unavailable", detail: "bw not found" }
    if (!this.session()) return { ...base, status: "locked", detail: "no session: run `bw unlock --raw` into sessionFile or set BW_SESSION" }
    try {
      const status = (this.json(await this.bw(["status"], { timeoutMs: 10_000 })) as { status?: string })?.status
      if (status === "unlocked") return { ...base, status: "ready" }
      return { ...base, status: "locked", detail: status === "unauthenticated" ? "not logged in (bw login)" : "vault is locked" }
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : "provider_error"
      return { ...base, status: code === "locked" ? "locked" : "unavailable", detail: (err as Error).message }
    }
  }

  async list(domain: string, origin: string): Promise<AccountV2[]> {
    const json = this.json(await this.bw(["list", "items", "--url", origin]))
    if (!Array.isArray(json)) throw new ProviderError("provider_error", "unexpected bw list output")
    const accounts: AccountV2[] = []
    for (const item of json as BwItem[]) {
      if (!item || typeof item.id !== "string" || (item.type !== undefined && item.type !== 1)) continue
      const base = { provider: this.id, ref: item.id, title: item.name ?? "Untitled", username: item.login?.username || undefined }
      const rpId = field(item, F.rpId)
      const credentialId = field(item, F.credentialId)
      if (rpId && credentialId) {
        if (hostMatches(rpId, domain)) accounts.push({ ...base, kind: "passkey", rpId, credentialId, hasPassword: false, hasTotp: false })
        continue
      }
      if (!urlsMatchDomain(itemUris(item), domain)) continue
      const sso = field(item, F.sso)
      if (sso) accounts.push({ ...base, kind: "sso", sso, hasPassword: false, hasTotp: false })
      else accounts.push({ ...base, kind: "password", hasPassword: !!item.login?.password, hasTotp: !!item.login?.totp })
    }
    return accounts
  }

  private async getItem(ref: string): Promise<BwItem> {
    if (!/^[A-Za-z0-9-]+$/.test(ref)) throw new ProviderError("bad_request", "invalid Bitwarden item id")
    const item = this.json(await this.bw(["get", "item", ref])) as BwItem
    if (!item || typeof item !== "object") throw new ProviderError("provider_error", "unexpected bw get output")
    return item
  }

  async fill(ref: string, domain: string, _origin: string, want: Secret[]): Promise<Secrets> {
    const item = await this.getItem(ref)
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

  async save(domain: string, _origin: string, entry: SaveEntry, ref?: string): Promise<SaveResult> {
    if (ref) {
      if (entry.kind !== "password") throw new ProviderError("bad_request", "only passwords can be updated")
      const item = await this.getItem(ref)
      if (!urlsMatchDomain(itemUris(item), domain)) throw new ProviderError("domain_mismatch", "item is not saved for this site")
      if (!item.login) throw new ProviderError("bad_request", "item is not a login")
      await this.write(["edit", "item", ref], { ...item, login: { ...item.login, password: entry.password } })
      return { ref, created: false }
    }
    const created =
      entry.kind === "password"
        ? await this.write(["create", "item"], newItem(entry.title, entry.url, { username: entry.username, password: entry.password }, []))
        : await this.write(
            ["create", "item"],
            newItem(entry.title, entry.url, { username: entry.username }, [{ name: F.sso, value: entry.sso, type: FIELD_TEXT }]),
          )
    return { ref: created.id, created: true }
  }

  async storePasskey(record: PasskeyRecord): Promise<StoredPasskey> {
    const created = await this.write(
      ["create", "item"],
      newItem(`${record.rpId} passkey`, `https://${record.rpId}`, { username: record.userName }, [
        { name: F.privateKey, value: record.privateKey, type: FIELD_HIDDEN },
        { name: F.credentialId, value: record.credentialId, type: FIELD_TEXT },
        { name: F.userHandle, value: record.userHandle, type: FIELD_TEXT },
        { name: F.rpId, value: record.rpId, type: FIELD_TEXT },
        { name: F.displayName, value: record.displayName, type: FIELD_TEXT },
      ]),
    )
    // An unlocked session counts as user verification.
    return { ref: created.id, userVerified: this.verifiesUser }
  }

  async loadPasskey(ref: string, rpId: string): Promise<LoadedPasskey> {
    const item = await this.getItem(ref)
    const record = parseRecord({
      rpId: field(item, F.rpId),
      credentialId: field(item, F.credentialId),
      userHandle: field(item, F.userHandle),
      userName: item.login?.username ?? "",
      displayName: field(item, F.displayName) ?? "",
      privateKey: field(item, F.privateKey),
    })
    if (!record) throw new ProviderError("not_found", "item is not a Foyer passkey")
    if (record.rpId !== rpId) throw new ProviderError("domain_mismatch", "passkey belongs to another site")
    return { record, userVerified: this.verifiesUser }
  }
}
