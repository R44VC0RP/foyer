// Bridge config: ~/.config/foyer/bridge.json (or $XDG_CONFIG_HOME/foyer/bridge.json,
// or the file named by $FOYER_BRIDGE_CONFIG). Without a config file, providers
// are enabled automatically for whichever CLIs are installed.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { expandHome, findBinary, log } from "./util"

export type ProviderConfig =
  | { type: "1password"; id?: string; account?: string; path?: string; vault?: string }
  | { type: "bitwarden"; id?: string; path?: string; sessionFile?: string; userVerified?: boolean }
  | { type: "command"; id: string; name: string; command: string[] }
  | { type: "demo"; id?: string; file: string; userVerified?: boolean }

export interface BridgeConfig {
  providers: ProviderConfig[]
  /** File the config came from, or null when auto-detected. */
  source: string | null
}

export function configPath(): string {
  if (process.env.FOYER_BRIDGE_CONFIG) return expandHome(process.env.FOYER_BRIDGE_CONFIG)
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "foyer", "bridge.json")
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0
const optStr = (v: unknown) => v === undefined || str(v)

function parseProvider(raw: unknown, baseDir: string): ProviderConfig | string {
  if (!raw || typeof raw !== "object") return "provider entry is not an object"
  const p = raw as Record<string, unknown>
  switch (p.type) {
    case "1password":
      if (!optStr(p.id) || !optStr(p.account) || !optStr(p.path) || !optStr(p.vault)) return "1password: id/account/path/vault must be strings"
      return {
        type: "1password",
        id: p.id as string | undefined,
        account: p.account as string | undefined,
        path: p.path as string | undefined,
        vault: p.vault as string | undefined,
      }
    case "bitwarden":
      if (!optStr(p.id) || !optStr(p.path) || !optStr(p.sessionFile)) return "bitwarden: id/path/sessionFile must be strings"
      return {
        type: "bitwarden",
        id: p.id as string | undefined,
        path: p.path as string | undefined,
        sessionFile: p.sessionFile as string | undefined,
        userVerified: p.userVerified === true,
      }
    case "command":
      if (!str(p.id) || !str(p.name)) return "command: id and name are required"
      if (!Array.isArray(p.command) || p.command.length === 0 || !p.command.every(str)) return `command ${p.id}: command must be a non-empty string array`
      return { type: "command", id: p.id, name: p.name, command: (p.command as string[]).map(expandHome) }
    case "demo": {
      if (!str(p.file) || !optStr(p.id)) return "demo: file is required"
      const file = expandHome(p.file)
      return { type: "demo", id: p.id as string | undefined, file: isAbsolute(file) ? file : join(baseDir, file), userVerified: p.userVerified === true }
    }
    default:
      return `unknown provider type ${JSON.stringify(p.type)}`
  }
}

export function loadConfig(): BridgeConfig {
  const path = configPath()
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    // No config: enable whatever is installed.
    const providers: ProviderConfig[] = []
    if (findBinary("op")) providers.push({ type: "1password" })
    if (findBinary("bw")) providers.push({ type: "bitwarden" })
    return { providers, source: null }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    log(`config ${path} is not valid JSON; no providers enabled`)
    return { providers: [], source: path }
  }
  const list = (json as { providers?: unknown })?.providers
  if (!Array.isArray(list)) {
    log(`config ${path} has no "providers" array; no providers enabled`)
    return { providers: [], source: path }
  }
  const providers: ProviderConfig[] = []
  for (const raw of list) {
    const parsed = parseProvider(raw, dirname(path))
    if (typeof parsed === "string") log(`config: skipping provider: ${parsed}`)
    else providers.push(parsed)
  }
  return { providers, source: path }
}
