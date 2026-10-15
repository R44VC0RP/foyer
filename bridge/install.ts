// Installs the Foyer bridge as a Chrome native messaging host.
//
//   bun bridge/install.ts [--uninstall] [--extension-id <id>]... [--dir <NativeMessagingHosts dir>]...
//                         [--only-dir] [--install-dir <dir>] [--dry-run]
//
// --dir           extra NativeMessagingHosts directory (repeatable)
// --only-dir      write only to the --dir directories, never to browser profiles
// --install-dir   where the compiled binary goes (default: per-OS app data dir)
// --dry-run       print what would happen without compiling or writing anything

import { existsSync } from "node:fs"
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join, resolve } from "node:path"
import { NATIVE_HOST } from "../src/shared/protocol"

const DEFAULT_EXTENSION_ID = "gpjhllicgakephbnmkoibbigebmdhfoi"
const BINARY_NAME = "foyer-bridge"
const MANIFEST_NAME = `${NATIVE_HOST}.json`

interface Args {
  uninstall: boolean
  dryRun: boolean
  onlyDir: boolean
  dirs: string[]
  extensionIds: string[]
  installDir?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { uninstall: false, dryRun: false, onlyDir: false, dirs: [], extensionIds: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = () => {
      const v = argv[++i]
      if (!v) fail(`${arg} needs a value`)
      return v
    }
    if (arg === "--uninstall") args.uninstall = true
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--only-dir") args.onlyDir = true
    else if (arg === "--dir") args.dirs.push(resolve(value()))
    else if (arg === "--install-dir") args.installDir = resolve(value())
    else if (arg === "--extension-id") args.extensionIds.push(...value().split(",").map((s) => s.trim()).filter(Boolean))
    else fail(`unknown argument ${arg}`)
  }
  for (const id of args.extensionIds) if (!/^[a-p]{32}$/.test(id)) fail(`invalid extension id ${id}`)
  if (args.extensionIds.length === 0) args.extensionIds.push(DEFAULT_EXTENSION_ID)
  if (args.onlyDir && args.dirs.length === 0) fail("--only-dir needs at least one --dir")
  return args
}

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

/** [browser name, profile root]; the host dir is <root>/NativeMessagingHosts. */
function browsers(): Array<[string, string]> {
  const home = homedir()
  if (platform() === "darwin") {
    const base = join(home, "Library", "Application Support")
    return [
      ["Google Chrome", "Google/Chrome"],
      ["Google Chrome Beta", "Google/Chrome Beta"],
      ["Google Chrome Canary", "Google/Chrome Canary"],
      ["Chromium", "Chromium"],
      ["Brave", "BraveSoftware/Brave-Browser"],
      ["Microsoft Edge", "Microsoft Edge"],
      ["Arc", "Arc/User Data"],
      ["Vivaldi", "Vivaldi"],
      ["Helium", "net.imput.helium"],
    ].map(([name, rel]) => [name!, join(base, rel!)])
  }
  if (platform() === "linux") {
    const base = process.env.XDG_CONFIG_HOME || join(home, ".config")
    return [
      ["Google Chrome", "google-chrome"],
      ["Google Chrome Beta", "google-chrome-beta"],
      ["Chromium", "chromium"],
      ["Brave", "BraveSoftware/Brave-Browser"],
      ["Microsoft Edge", "microsoft-edge"],
      ["Vivaldi", "vivaldi"],
    ].map(([name, rel]) => [name!, join(base, rel!)])
  }
  fail(`unsupported platform ${platform()} (macOS and Linux only)`)
}

function defaultInstallDir(): string {
  return platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "Foyer")
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "foyer")
}

/** Host directories to touch: existing browser profiles (unless --only-dir) plus every --dir. */
function targets(args: Args, forUninstall: boolean): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (!args.onlyDir) {
    for (const [name, root] of browsers()) {
      const dir = join(root, "NativeMessagingHosts")
      if (forUninstall ? existsSync(join(dir, MANIFEST_NAME)) : existsSync(root)) out.push([name, dir])
    }
  }
  for (const dir of args.dirs) out.push([dir, dir])
  return out
}

async function install(args: Args): Promise<void> {
  const installDir = args.installDir ?? defaultInstallDir()
  const binary = join(installDir, BINARY_NAME)
  const entry = join(import.meta.dir, "main.ts")
  const prefix = args.dryRun ? "[dry run] would " : ""

  console.log(`${prefix}compile ${entry} -> ${binary}`)
  if (!args.dryRun) {
    await mkdir(installDir, { recursive: true })
    // argv array, no shell: paths with spaces ("Application Support") are safe.
    const proc = Bun.spawn([process.execPath, "build", "--compile", entry, "--outfile", binary], {
      stdout: "inherit",
      stderr: "inherit",
    })
    if ((await proc.exited) !== 0) fail("bun build --compile failed")
  }

  const manifest = {
    name: NATIVE_HOST,
    description: "Foyer password manager bridge",
    path: binary,
    type: "stdio",
    allowed_origins: args.extensionIds.map((id) => `chrome-extension://${id}/`),
  }
  const json = JSON.stringify(manifest, null, 2) + "\n"
  const dirs = targets(args, false)
  if (dirs.length === 0) console.log("No supported browser profiles found; pass --dir <NativeMessagingHosts dir>.")
  for (const [name, dir] of dirs) {
    const file = join(dir, MANIFEST_NAME)
    console.log(`${prefix}write ${file}`)
    if (!args.dryRun) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, json)
    }
    console.log(`  configured: ${name}`)
  }
  console.log(`Allowed extension ids: ${args.extensionIds.join(", ")}`)
  if (!args.dryRun) console.log("Done. Reload Foyer in chrome://extensions to connect.")
}

async function uninstall(args: Args): Promise<void> {
  const installDir = args.installDir ?? defaultInstallDir()
  const binary = join(installDir, BINARY_NAME)
  const prefix = args.dryRun ? "[dry run] would " : ""
  for (const [name, dir] of targets(args, true)) {
    const file = join(dir, MANIFEST_NAME)
    if (!existsSync(file)) continue
    console.log(`${prefix}remove ${file} (${name})`)
    if (!args.dryRun) await rm(file, { force: true })
  }
  if (existsSync(binary)) {
    console.log(`${prefix}remove ${binary}`)
    if (!args.dryRun) {
      await rm(binary, { force: true })
      // Remove the install dir only if we emptied it.
      if ((await readdir(installDir).catch(() => ["?"])).length === 0) await rmdir(installDir).catch(() => {})
    }
  } else {
    console.log(`No binary at ${binary}`)
  }
}

const args = parseArgs(process.argv.slice(2))
await (args.uninstall ? uninstall(args) : install(args))
