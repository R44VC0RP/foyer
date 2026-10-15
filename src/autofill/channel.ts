// Isolated-world end of the private channel to passkey-hook.ts (MAIN world).
// Hands the hook a MessagePort before page scripts run, relays WebAuthn
// requests to the background and returns its answers.

type HookMessage = { id?: number; op: "ack" | "report" | "get" | "create" | "cancel"; payload?: unknown; detail?: unknown }

export function initPasskeyChannel(onReport: (detail: unknown) => void) {
  let current: MessagePort | null = null
  const offered: MessagePort[] = []

  function offer() {
    // Pages can post {foyer:"hello"} too; a handful of offers is plenty.
    if (current || offered.length >= 3) return
    const channel = new MessageChannel()
    offered.push(channel.port1)
    channel.port1.onmessage = (event: MessageEvent<HookMessage>) => handle(channel.port1, event.data)
    window.postMessage({ foyer: "port" }, "*", [channel.port2])
  }

  function handle(port: MessagePort, message: HookMessage) {
    if (!message || typeof message.op !== "string") return
    // The hook keeps the first port it receives; whichever one it acknowledges
    // is the live channel, and any other offers are closed.
    if (message.op === "ack") {
      if (current) return
      current = port
      for (const p of offered) if (p !== port) p.close()
      offered.length = 0
      return
    }
    if (port !== current) return
    if (message.op === "report") return onReport(message.detail)
    if (typeof message.id !== "number") return
    const id = message.id
    if (message.op === "cancel") {
      void chrome.runtime.sendMessage({ type: "pk:cancel", requestId: id }).catch(() => {})
      return
    }
    if (message.op !== "get" && message.op !== "create") return
    chrome.runtime
      .sendMessage({ type: message.op === "get" ? "pk:get" : "pk:create", requestId: id, options: message.payload })
      .then(
        (reply: any) => {
          if (reply?.error) port.postMessage({ id, ok: false, error: reply.error })
          else port.postMessage({ id, ok: true, result: reply ?? { fallback: true } })
        },
        () => port.postMessage({ id, ok: true, result: { fallback: true } }),
      )
  }

  // The hook may have loaded first (it then said hello) or after us; cover both.
  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.foyer === "hello") offer()
  })
  offer()
}
