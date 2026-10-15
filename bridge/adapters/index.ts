import type { BridgeConfig } from "../config"
import { log } from "../util"
import { BitwardenAdapter } from "./bitwarden"
import { CommandAdapter } from "./command"
import { DemoAdapter } from "./demo"
import { OnePasswordAdapter } from "./onepassword"
import type { Adapter } from "./types"

export type { Adapter, LoadedPasskey, SaveResult, Secrets, StoredPasskey } from "./types"

export function createAdapters(config: BridgeConfig): Adapter[] {
  const adapters: Adapter[] = []
  for (const p of config.providers) {
    let adapter: Adapter
    switch (p.type) {
      case "1password":
        adapter = new OnePasswordAdapter(p.id ?? "1password", p.account, p.path, p.vault)
        break
      case "bitwarden":
        adapter = new BitwardenAdapter(p.id ?? "bitwarden", p.path, p.sessionFile, p.userVerified === true)
        break
      case "command":
        adapter = new CommandAdapter(p.id, p.name, p.command)
        break
      case "demo":
        adapter = new DemoAdapter(p.id ?? "demo", p.file, p.userVerified === true)
        break
    }
    if (adapters.some((a) => a.id === adapter.id)) {
      log(`config: duplicate provider id ${adapter.id}; give each provider a unique "id"`)
      continue
    }
    adapters.push(adapter)
  }
  return adapters
}
