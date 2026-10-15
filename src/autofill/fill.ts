// Writes credentials into the page so plain forms and framework-controlled
// inputs (React, Vue, Angular) both accept them.
//
// The value is set through the native HTMLInputElement setter from the
// extension's isolated world, then input/change events are dispatched. A
// framework's own value tracker lives in the page's world, so it sees the DOM
// value differ from what it last rendered and runs its change handler.

import { isVisible } from "../detect"
import type { FieldRole } from "../shared/types"
import type { FillValues } from "./messages"

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function setInputValue(el: HTMLInputElement, value: string) {
  el.focus({ preventScroll: true })
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "Unidentified" }))
  nativeValue.call(el, value)
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }))
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "Unidentified" }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
}

export interface FillTarget {
  el: HTMLInputElement
  role: FieldRole
  split?: number
}

const IDENTIFIER: FieldRole[] = ["username", "email", "phone"]

/** Opacity of the element and everything above it, multiplied. */
function effectiveOpacity(el: Element): number {
  let opacity = 1
  for (let node: Element | null = el, depth = 0; node && depth < 25; node = node.parentElement, depth++)
    opacity *= Number(getComputedStyle(node).opacity) || 0
  return opacity
}

/** The element the user would actually hit at the field's centre is the field. */
function onTop(el: HTMLInputElement): boolean {
  el.scrollIntoView({ block: "nearest", inline: "nearest" })
  const r = el.getBoundingClientRect()
  const root = el.getRootNode() as Document | ShadowRoot
  const hit = root.elementFromPoint?.(r.left + r.width / 2, r.top + r.height / 2)
  if (!hit) return false
  return hit === el || el.contains(hit) || (hit.closest("label") as HTMLLabelElement | null)?.control === el
}

/**
 * Never fill something the user can't see: hidden, transparent or covered
 * fields are how pages skim credentials.
 */
function fillable(el: HTMLInputElement): boolean {
  return el.isConnected && !el.disabled && !el.readOnly && isVisible(el) && effectiveOpacity(el) >= 0.1 && onTop(el)
}

export async function fillFields(targets: FillTarget[], values: FillValues): Promise<{ filled: FieldRole[]; last?: HTMLInputElement }> {
  const filled: FieldRole[] = []
  let last: HTMLInputElement | undefined

  const ident = targets.find((t) => IDENTIFIER.includes(t.role) && fillable(t.el))
  if (ident && values.username) {
    setInputValue(ident.el, values.username)
    filled.push(ident.role)
    last = ident.el
    await sleep(30)
  }

  const password = targets.find((t) => t.role === "password" && fillable(t.el))
  if (password && values.password) {
    setInputValue(password.el, values.password)
    filled.push("password")
    last = password.el
    await sleep(30)
  }

  if (values.totp) {
    const boxes = targets.filter((t) => t.role === "otp" && t.split && fillable(t.el)).map((t) => t.el)
    if (boxes.length >= values.totp.length) {
      // One digit per box, in document order.
      boxes.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      for (let i = 0; i < values.totp.length; i++) setInputValue(boxes[i], values.totp[i])
      filled.push("otp")
      last = boxes[values.totp.length - 1]
    } else {
      const otp = targets.find((t) => t.role === "otp" && fillable(t.el))
      if (otp) {
        setInputValue(otp.el, values.totp)
        filled.push("otp")
        last = otp.el
      }
    }
  }
  return { filled, last }
}
