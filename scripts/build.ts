import { cp, mkdir, rm } from "node:fs/promises"
import { watch } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const outdir = join(root, "dist")

const entries = ["background", "content", "passkey-hook", "popup", "dashboard", "menu", "dialog"].map((name) =>
  join(root, "src", `${name}.ts`),
)

async function build() {
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })
  const result = await Bun.build({
    entrypoints: entries,
    outdir,
    target: "browser",
    // Content scripts cannot be ES modules, so every entry is a self-contained IIFE.
    format: "iife",
    // Keep identifiers readable for debugging; strip whitespace (content.js runs on every page).
    minify: { whitespace: true, syntax: true, identifiers: false },
    sourcemap: "none",
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("build failed")
  }
  await cp(join(root, "static"), outdir, { recursive: true })
  console.log(`built ${entries.length} entries -> dist/`)
}

await build()

if (process.argv.includes("--watch")) {
  let timer: Timer | undefined
  const rebuild = () => {
    clearTimeout(timer)
    timer = setTimeout(() => build().catch((err) => console.error(err)), 100)
  }
  watch(join(root, "src"), { recursive: true }, rebuild)
  watch(join(root, "static"), { recursive: true }, rebuild)
  console.log("watching src/ and static/")
}
