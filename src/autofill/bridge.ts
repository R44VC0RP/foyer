// Background-side client for the local bridge (native messaging host).
// One long-lived port; requests are matched to responses by id.

import { NATIVE_HOST, PROTOCOL_VERSION, type HelloResponse, type RequestV2 as Request, type ResponseV2 as Response } from "../shared/protocol"

type Pending = { resolve: (r: Response) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never
export type RequestBody = DistributiveOmit<Request, "id">

export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

let port: chrome.runtime.Port | null = null
let hello: Promise<HelloResponse> | null = null
let lastError = ""
const pending = new Map<string, Pending>()
let counter = 0

function connect(): chrome.runtime.Port {
  if (port) return port
  const p = chrome.runtime.connectNative(NATIVE_HOST)
  p.onMessage.addListener((message: Response) => {
    const entry = pending.get(message?.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message)
  })
  p.onDisconnect.addListener(() => {
    lastError = chrome.runtime.lastError?.message ?? "bridge disconnected"
    port = null
    hello = null
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new BridgeError("disconnected", lastError))
      pending.delete(id)
    }
  })
  port = p
  return p
}

export function request<T extends Response>(body: RequestBody, timeoutMs = 60_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let p: chrome.runtime.Port
    try {
      p = connect()
    } catch (err) {
      reject(new BridgeError("unavailable", (err as Error).message))
      return
    }
    const id = `r${Date.now().toString(36)}${(counter++).toString(36)}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new BridgeError("timeout", `bridge did not answer ${body.type} in time`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (r) => (r.type === "error" ? reject(new BridgeError(r.code, r.message)) : resolve(r as T)),
      reject,
      timer,
    })
    try {
      p.postMessage({ ...body, id })
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(new BridgeError("unavailable", (err as Error).message))
    }
  })
}

/** Cached handshake; rejects when the bridge isn't installed. */
export function bridgeHello(): Promise<HelloResponse> {
  if (!hello) {
    hello = request<HelloResponse>({ type: "hello", protocol: PROTOCOL_VERSION, client: "foyer-extension" }, 10_000)
    hello.catch(() => (hello = null))
  }
  return hello
}

export function bridgeLastError(): string {
  return lastError
}
