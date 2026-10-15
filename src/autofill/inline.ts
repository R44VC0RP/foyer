// Content-script side of autofill: shows the account menu under a focused
// login field and applies fills sent by the background.
//
// The menu is an extension page in an iframe inside a closed shadow root. The
// page can't read the account list (cross-origin frame) and can't click it for
// the user (synthetic events don't cross into the frame). All it ever sees is
// the values written into its own fields after the user picks an account.

import type { FieldRole } from "../shared/types"
import { fillFields, type FillTarget } from "./fill"
import type { AutofillMessage, QueryReply, ToContent } from "./messages"

export interface PageState {
  targets(): FillTarget[]
  submit(): Element | undefined
  providerButton(provider: string): Element | undefined
}

const MENU_ROW = 52
const MENU_WIDTH = 320
const FILLABLE: FieldRole[] = ["username", "email", "phone", "password", "otp"]

let state: PageState
let host: HTMLElement | null = null
let frame: HTMLIFrameElement | null = null
let anchor: HTMLInputElement | null = null
let token: string | null = null
let raf = 0
let menuHeight = 0
let dismissedFor: HTMLInputElement | null = null
/**
 * The menu only opens right after a real click or keypress. A page can focus a
 * field from script (focus() fires a trusted focusin) and slide it under the
 * user's next click; it can't fake the user's own input event.
 */
let lastGestureAt = 0
const GESTURE_WINDOW_MS = 1000
const recentGesture = () => Date.now() - lastGestureAt < GESTURE_WINDOW_MS

function ask<T>(message: AutofillMessage): Promise<T | null> {
  try {
    return chrome.runtime.sendMessage(message).catch(() => null) as Promise<T | null>
  } catch {
    return Promise.resolve(null)
  }
}

function targetFor(el: Element): FillTarget | undefined {
  return state.targets().find((t) => t.el === el)
}

function position() {
  if (!host || !anchor) return
  if (!anchor.isConnected) return closeMenu()
  const r = anchor.getBoundingClientRect()
  const width = Math.max(MENU_WIDTH, Math.min(r.width, 420))
  const below = r.bottom + 4
  const fitsBelow = below + menuHeight < innerHeight
  const top = fitsBelow ? below : Math.max(4, r.top - menuHeight - 4)
  const left = Math.min(Math.max(4, r.left), innerWidth - width - 4)
  host.style.cssText = `position:fixed;top:${top}px;left:${left}px;width:${width}px;height:${menuHeight}px;z-index:2147483647;margin:0;padding:0;border:0;display:block;`
  raf = requestAnimationFrame(position)
}

function openMenu(el: HTMLInputElement, t: string, count: number) {
  closeMenu()
  anchor = el
  token = t
  menuHeight = Math.min(count, 5) * MENU_ROW + 44
  host = document.createElement("foyer-menu")
  const root = host.attachShadow({ mode: "closed" })
  frame = document.createElement("iframe")
  frame.src = chrome.runtime.getURL(`menu.html#${t}`)
  frame.setAttribute("allow", "")
  frame.style.cssText =
    "all:initial;width:100%;height:100%;border:0;border-radius:12px;box-shadow:0 8px 28px rgb(0 0 0 / 18%),0 0 0 1px rgb(0 0 0 / 8%);background:transparent;color-scheme:normal;"
  root.append(frame)
  document.documentElement.append(host)
  position()
}

export function closeMenu() {
  cancelAnimationFrame(raf)
  if (token) void ask({ type: "af:menu-close", token })
  host?.remove()
  host = frame = anchor = null
  token = null
}

let querying: Promise<void> | null = null
/** Fields recently found to have no accounts, so rescans don't re-ask. */
const emptyUntil = new WeakMap<Element, number>()

async function maybeOpen(el: HTMLInputElement, explicit = false) {
  if (querying || dismissedFor === el) return
  if (!explicit && !recentGesture()) return
  if ((emptyUntil.get(el) ?? 0) > Date.now()) return
  const t = targetFor(el)
  if (!t || !FILLABLE.includes(t.role)) return
  if (anchor === el && host) return
  querying = (async () => {
    const roles = [...new Set(state.targets().map((x) => x.role))]
    const reply = await ask<QueryReply>({ type: "af:query", presence: { roles } })
    if (reply?.token && reply.count > 0) {
      if (document.activeElement === el) openMenu(el, reply.token, reply.count)
    } else emptyUntil.set(el, Date.now() + 15_000)
  })().finally(() => (querying = null))
}

function onFocusIn(event: FocusEvent) {
  const el = event.composedPath()[0]
  if (el instanceof HTMLInputElement) void maybeOpen(el)
}

function onPointerDown(event: PointerEvent) {
  if (!event.isTrusted) return
  lastGestureAt = Date.now()
  const target = event.composedPath()[0]
  // Clicking a field that already has focus (e.g. autofocus) opens the menu too.
  if (target instanceof HTMLInputElement && target === document.activeElement && !host) void maybeOpen(target)
  if (!host) return
  const path = event.composedPath()
  if (path.includes(host) || path.includes(anchor as EventTarget)) return
  closeMenu()
}

function onKeyDown(event: KeyboardEvent) {
  if (!event.isTrusted) return
  lastGestureAt = Date.now()
  if (!host || event.composedPath()[0] !== anchor) return
  if (event.key === "Escape") {
    dismissedFor = anchor
    closeMenu()
  } else if (event.key === "ArrowDown") {
    event.preventDefault()
    frame?.contentWindow?.focus()
  }
}

async function applyFill(message: Extract<ToContent, { type: "af:fill" }>) {
  closeMenu()
  const { filled, last } = await fillFields(state.targets(), message.values)
  last?.focus({ preventScroll: true })
  if (message.submit && filled.length) {
    const submit = state.submit()
    if (submit instanceof HTMLElement) setTimeout(() => submit.click(), 150)
    else last?.form?.requestSubmit()
  }
}

export function initAutofill(page: PageState) {
  state = page
  document.addEventListener("focusin", onFocusIn, true)
  document.addEventListener("pointerdown", onPointerDown, true)
  document.addEventListener("keydown", onKeyDown, true)
  chrome.runtime.onMessage.addListener((message: ToContent) => {
    switch (message?.type) {
      case "af:fill":
        void applyFill(message)
        break
      case "af:sso": {
        closeMenu()
        const button = state.providerButton(message.provider)
        if (button instanceof HTMLElement) button.click()
        break
      }
      case "af:close-menu":
        if (message.token === token) closeMenu()
        break
      case "af:resize-menu":
        if (message.token === token) menuHeight = message.height
        break
      case "af:open-menu": {
        const first = state.targets().find((t) => FILLABLE.includes(t.role))
        if (first) {
          // The keyboard shortcut is the user's own request.
          dismissedFor = null
          first.el.focus()
          void maybeOpen(first.el, true)
        }
        break
      }
    }
  })
}

/** Called after each page scan: offer the menu on an already-focused field. */
export function refreshAutofill(focused: HTMLInputElement) {
  if (!host) void maybeOpen(focused)
}
