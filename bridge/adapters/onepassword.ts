// 1Password via the `op` CLI (v2). Relies on the desktop app integration, so
// the first call may wait on an approval prompt; hence the long timeout.
//
// Secrets never go in argv (other processes can read it): new items and
// password updates are piped to `op item create -` / `op item edit <id>` as a
// JSON template on stdin.
//
// Foyer-specific items:
// - Sign-in methods: Login item tagged "foyer-sso" with a text field "foyer.sso" = provider id.
// - Passkeys: Login item tagged "foyer-passkey" with a concealed field
//   "foyer.passkey.privateKey" and text fields foyer.passkey.{credentialId,userHandle,rpId,displayName}.

import type { AccountV2, Capability, ProviderInfoV2, SaveEntry, Secret } from "../../src/shared/protocol"
import { totpFromSecret } from "../totp"
import { ProviderError, findBinary, hostMatches, log, run, stderrSummary, urlsMatchDomain } from "../util"
import { parseRecord, type PasskeyRecord } from "../webauthn"
import type { Adapter, LoadedPasskey, SaveResult, Secrets, StoredPasskey } from "./types"

interface OpUrl {
  href?: string
  primary?: boolean
}

interface OpListItem {
  id: string
  title?: string
  urls?: OpUrl[]
  url?: string
  tags?: string[]
  additional_information?: string
}

interface OpField {
  id?: string
  type?: string
  purpose?: string
  label?: string
  value?: string
  totp?: string
  [key: string]: unknown
}

interface OpItem extends OpListItem {
  fields?: OpField[]
  [key: string]: unknown
}

const CAPABILITIES: Capability[] = ["list", "fill", "save", "passkeys", "sso"]
const LIST_TTL_MS = 60_000
const LOCKED = /not (currently )?signed in|sign in|signin|authoriz|unlock|locked|session (has )?expired|no accounts? (configured|found)|connect to.*app/i
const NOT_FOUND = /isn't an item|not found|no item/i
const TAG_SSO = "foyer-sso"
const TAG_PASSKEY = "foyer-passkey"
const F = {
  sso: "foyer.sso",
  privateKey: "foyer.passkey.privateKey",
  credentialId: "foyer.passkey.credentialId",
  userHandle: "foyer.passkey.userHandle",
  rpId: "foyer.passkey.rpId",
  displayName: "foyer.passkey.displayName",
}

function itemUrls(item: OpListItem): string[] {
  const urls = (item.urls ?? []).map((u) => u.href).filter((h): h is string => typeof h === "string")
  if (typeof item.url === "string") urls.push(item.url)
  return urls
}

const hasTag = (item: OpListItem, tag: string) => Array.isArray(item.tags) && item.tags.includes(tag)

function fieldValue(fields: OpField[], label: string): string | undefined {
  const value = fields.find((f) => f.label === label)?.value
  return typeof value === "string" && value ? value : undefined
}

const text = (id: string, label: string, value: string): OpField => ({ id, type: "STRING", label, value })

export class OnePasswordAdapter implements Adapter {
  readonly name = "1Password"
  /** 1Password unlocks with the desktop app (biometrics or account password). */
  readonly verifiesUser = true
  readonly timeoutMs = 45_000
  private cache?: { at: number; items: Promise<OpListItem[]> }
  /** Non-secret metadata of Foyer passkey / sso items, by item id. These fields never change. */
  private meta = new Map<string, Record<string, string>>()

  constructor(
    readonly id: string,
    private account?: string,
    private path?: string,
    private vault?: string,
  ) {}

  private bin(): string | undefined {
    return findBinary("op", this.path)
  }

  private async op(args: string[], input?: unknown): Promise<unknown> {
    const bin = this.bin()
    if (!bin) throw new ProviderError("provider_error", "op not found")
    const argv = [bin, ...args, "--format", "json"]
    if (this.account) argv.push("--account", this.account)
    const result = await run(argv, { timeoutMs: this.timeoutMs, input: input === undefined ? undefined : JSON.stringify(input) })
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

  async info(): Promise<ProviderInfoV2> {
    // No `op whoami` preflight: it can itself trigger an approval prompt.
    return this.bin()
      ? { id: this.id, name: this.name, status: "ready", capabilities: CAPABILITIES }
      : {
          id: this.id,
          name: this.name,
          status: "unavailable",
          detail: this.path ? `op not found at ${this.path}` : "op not found",
          capabilities: CAPABILITIES,
        }
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

  /** Reads only the named non-secret fields of an item (never --reveal). */
  private async fields(id: string, labels: string[]): Promise<Record<string, string>> {
    const cached = this.meta.get(id)
    if (cached) return cached
    const json = await this.op(["item", "get", id, "--fields", labels.map((l) => `label=${l}`).join(",")])
    const list = (Array.isArray(json) ? json : [json]) as OpField[]
    const out: Record<string, string> = {}
    for (const label of labels) {
      const value = fieldValue(list, label)
      if (value) out[label] = value
    }
    this.meta.set(id, out)
    return out
  }

  async list(domain: string): Promise<AccountV2[]> {
    const matching = (await this.items()).filter((item) => urlsMatchDomain(itemUrls(item), domain))
    const accounts = await Promise.all(
      matching.map(async (item): Promise<AccountV2 | undefined> => {
        const base = { provider: this.id, ref: item.id, title: item.title ?? "Untitled", username: item.additional_information || undefined }
        if (hasTag(item, TAG_PASSKEY)) {
          const meta = await this.fields(item.id, [F.rpId, F.credentialId]).catch(() => ({}) as Record<string, string>)
          const rpId = meta[F.rpId]
          if (!rpId || !meta[F.credentialId] || !hostMatches(rpId, domain)) return undefined
          return { ...base, kind: "passkey", rpId, credentialId: meta[F.credentialId], hasPassword: false, hasTotp: false }
        }
        if (hasTag(item, TAG_SSO)) {
          const sso = (await this.fields(item.id, [F.sso]).catch(() => ({}) as Record<string, string>))[F.sso]
          if (!sso) return undefined
          return { ...base, kind: "sso", sso, hasPassword: false, hasTotp: false }
        }
        // hasTotp is not knowable from `op item list`; fill still honours totp requests.
        return { ...base, kind: "password", hasPassword: true, hasTotp: false }
      }),
    )
    return accounts.filter((a): a is AccountV2 => a !== undefined)
  }

  private async getItem(ref: string): Promise<OpItem> {
    if (!/^[A-Za-z0-9]+$/.test(ref)) throw new ProviderError("bad_request", "invalid 1Password item id")
    const item = (await this.op(["item", "get", ref, "--reveal"])) as OpItem
    if (!item || typeof item !== "object") throw new ProviderError("provider_error", "unexpected op item get output")
    return item
  }

  async fill(ref: string, domain: string, _origin: string, want: Secret[]): Promise<Secrets> {
    const item = await this.getItem(ref)
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

  /** Pipes a template to `op item create -`; title, url and tags (not secret) also go as flags. */
  private async create(template: { title: string; url: string; tags: string[]; fields: OpField[] }): Promise<string> {
    const args = ["item", "create", "--category", "Login", "--title", template.title, "--url", template.url]
    if (template.tags.length) args.push("--tags", template.tags.join(","))
    if (this.vault) args.push("--vault", this.vault)
    args.push("-")
    const created = (await this.op(args, {
      title: template.title,
      category: "LOGIN",
      tags: template.tags,
      urls: [{ href: template.url, primary: true }],
      fields: template.fields,
    })) as OpItem
    this.cache = undefined
    if (!created || typeof created.id !== "string") throw new ProviderError("provider_error", "op item create returned no id")
    return created.id
  }

  async save(domain: string, _origin: string, entry: SaveEntry, ref?: string): Promise<SaveResult> {
    if (ref) {
      if (entry.kind !== "password") throw new ProviderError("bad_request", "only passwords can be updated")
      const item = await this.getItem(ref)
      if (!urlsMatchDomain(itemUrls(item), domain)) throw new ProviderError("domain_mismatch", "item is not saved for this site")
      // `op item edit` with a template overwrites 1Password's own passkeys, which templates can't express.
      if (Object.keys(item).some((k) => /passkey/i.test(k)) || item.fields?.some((f) => /passkey/i.test(String(f.type)))) {
        throw new ProviderError("provider_error", "this item has a 1Password passkey; update its password in 1Password")
      }
      const fields = (item.fields ?? []).map(({ totp: _totp, ...f }) => f)
      const password = fields.find((f) => f.purpose === "PASSWORD")
      if (password) password.value = entry.password
      else fields.push({ id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: entry.password })
      await this.op(["item", "edit", ref], { ...item, fields })
      this.cache = undefined
      return { ref, created: false }
    }
    if (entry.kind === "password") {
      const id = await this.create({
        title: entry.title,
        url: entry.url,
        tags: [],
        fields: [
          { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: entry.username },
          { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: entry.password },
        ],
      })
      return { ref: id, created: true }
    }
    const fields: OpField[] = [text("foyer_sso", F.sso, entry.sso)]
    if (entry.username) fields.unshift({ id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: entry.username })
    const id = await this.create({ title: entry.title, url: entry.url, tags: [TAG_SSO], fields })
    return { ref: id, created: true }
  }

  async storePasskey(record: PasskeyRecord): Promise<StoredPasskey> {
    const id = await this.create({
      title: `${record.rpId} passkey`,
      url: `https://${record.rpId}`,
      tags: [TAG_PASSKEY],
      fields: [
        { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: record.userName },
        { id: "foyer_passkey_privateKey", type: "CONCEALED", label: F.privateKey, value: record.privateKey },
        text("foyer_passkey_credentialId", F.credentialId, record.credentialId),
        text("foyer_passkey_userHandle", F.userHandle, record.userHandle),
        text("foyer_passkey_rpId", F.rpId, record.rpId),
        text("foyer_passkey_displayName", F.displayName, record.displayName),
      ],
    })
    // Biometric / desktop-app unlock counts as user verification.
    return { ref: id, userVerified: this.verifiesUser }
  }

  async loadPasskey(ref: string, rpId: string): Promise<LoadedPasskey> {
    const item = await this.getItem(ref)
    if (!hasTag(item, TAG_PASSKEY)) throw new ProviderError("not_found", "item is not a Foyer passkey")
    const fields = Array.isArray(item.fields) ? item.fields : []
    const record = parseRecord({
      rpId: fieldValue(fields, F.rpId),
      credentialId: fieldValue(fields, F.credentialId),
      userHandle: fieldValue(fields, F.userHandle),
      userName: fields.find((f) => f.purpose === "USERNAME")?.value ?? "",
      displayName: fieldValue(fields, F.displayName) ?? "",
      privateKey: fieldValue(fields, F.privateKey),
    })
    if (!record) throw new ProviderError("provider_error", "passkey item is incomplete")
    if (record.rpId !== rpId) throw new ProviderError("domain_mismatch", "passkey belongs to another site")
    return { record, userVerified: this.verifiesUser }
  }
}
