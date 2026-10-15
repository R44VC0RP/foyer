// Shared helpers for the bridge: logging, process spawning, binary lookup,
// URL/domain matching and the error type adapters throw.

import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import type { ErrorResponse } from "../src/shared/protocol"
import { hostMatchesDomain } from "../src/shared/protocol"
import { registrableDomain } from "../src/shared/domains"

export const BRIDGE_VERSION = "0.1.0"

/** Logs go to stderr only (stdout is the native messaging channel). Never pass secrets here. */
export function log(message: string): void {
  process.stderr.write(`[foyer-bridge] ${message}\n`)
}

export type ErrorCode = ErrorResponse["code"]

export class ProviderError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

// ---- Binary lookup ------------------------------------------------------------

/** Chrome starts native hosts with a minimal PATH, so look in the usual places too. */
export function searchDirs(): string[] {
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun/bin"), "/usr/bin", "/bin"]
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir && !dirs.includes(dir)) dirs.push(dir)
  return dirs
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Finds an executable. An explicitly configured path is authoritative: if it
 * is set but missing we report "not found" rather than silently running a
 * different binary from PATH. A configured directory is searched for `name`.
 */
export function findBinary(name: string, configured?: string): string | undefined {
  if (configured) {
    const path = expandHome(configured)
    if (isFile(path)) return path
    if (existsSync(path) && isFile(join(path, name))) return join(path, name)
    return undefined
  }
  for (const dir of searchDirs()) {
    const candidate = join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

// ---- Process spawning ---------------------------------------------------------

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const live = new Set<{ kill(): void }>()

/** Kills every child still running (used on shutdown). */
export function killChildren(): void {
  for (const proc of live) {
    try {
      proc.kill()
    } catch {}
  }
  live.clear()
}

export async function run(
  argv: string[],
  options: { timeoutMs: number; input?: string; env?: Record<string, string | undefined> },
): Promise<RunResult> {
  let proc
  try {
    proc = Bun.spawn(argv, {
      stdin: options.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: searchDirs().join(delimiter), ...options.env },
    })
  } catch (err) {
    throw new ProviderError("provider_error", `could not start ${argv[0]}: ${(err as Error).message}`)
  }
  live.add(proc)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, options.timeoutMs)
  try {
    if (options.input !== undefined && proc.stdin) {
      proc.stdin.write(options.input)
      await proc.stdin.end()
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    live.delete(proc)
  }
}

/** First meaningful stderr line, trimmed, for error messages. Never use stdout here (it may hold secrets). */
export function stderrSummary(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.replace(/^\[ERROR\]\s*\S+\s+\S+\s*/, "").trim())
    .find((l) => l.length > 0)
  return (line ?? "no error output").slice(0, 200)
}

// ---- Domain matching ----------------------------------------------------------

export function urlHost(url: string): string | undefined {
  const raw = url.trim()
  if (!raw) return undefined
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname
    return host ? host.toLowerCase().replace(/^\[|\]$/g, "") : undefined
  } catch {
    return undefined
  }
}

export function hostMatches(host: string, domain: string): boolean {
  return hostMatchesDomain(host, domain) || registrableDomain(host) === domain.toLowerCase()
}

/** True when any saved URL belongs to `domain`. */
export function urlsMatchDomain(urls: readonly string[], domain: string): boolean {
  return urls.some((url) => {
    const host = urlHost(url)
    return host !== undefined && hostMatches(host, domain)
  })
}
