// Shows Foyer dialogs (passkey consent, save prompts) as an extension page in
// an iframe, inside a closed shadow root, so the page can't read or click them.

export type DialogPlacement = "center" | "corner"

export type DialogMessage =
  | { type: "dg:open"; token: string; placement: DialogPlacement }
  | { type: "dg:close"; token: string }
  | { type: "dg:resize"; token: string; height: number }

const open = new Map<string, { host: HTMLElement; frame: HTMLIFrameElement; placement: DialogPlacement }>()

function place(entry: { host: HTMLElement; placement: DialogPlacement }, height: number) {
  const width = 360
  const base = `position:fixed;z-index:2147483647;width:${width}px;height:${height}px;margin:0;padding:0;border:0;display:block;`
  entry.host.style.cssText =
    entry.placement === "center"
      ? `${base}top:${Math.max(16, innerHeight * 0.18)}px;left:calc(50% - ${width / 2}px);`
      : `${base}top:16px;right:16px;`
}

function openDialog(token: string, placement: DialogPlacement) {
  if (open.has(token)) return
  const host = document.createElement("foyer-dialog")
  const root = host.attachShadow({ mode: "closed" })
  const frame = document.createElement("iframe")
  frame.src = chrome.runtime.getURL(`dialog.html#${token}`)
  frame.style.cssText =
    "all:initial;width:100%;height:100%;border:0;border-radius:16px;box-shadow:0 24px 60px rgb(30 33 25 / 20%),0 2px 6px rgb(30 33 25 / 8%),0 0 0 1px rgb(30 33 25 / 10%);background:transparent;color-scheme:normal;"
  root.append(frame)
  const entry = { host, frame, placement }
  place(entry, 200)
  document.documentElement.append(host)
  open.set(token, entry)
  if (placement === "center") frame.focus()
}

export function initDialogs() {
  chrome.runtime.onMessage.addListener((message: DialogMessage) => {
    if (message?.type === "dg:open" && window === window.top) openDialog(message.token, message.placement)
    else if (message?.type === "dg:close") {
      open.get(message.token)?.host.remove()
      open.delete(message.token)
    } else if (message?.type === "dg:resize") {
      const entry = open.get(message.token)
      if (entry) place(entry, Math.min(Math.max(message.height, 80), 520))
    }
  })
}
