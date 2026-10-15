// Runs in the page's own JS world (content_scripts world: MAIN), before any
// page script, so it can see and answer WebAuthn and FedCM calls.
//
// Two jobs:
// 1. Report the shape of each call (operation, mediation, rpId, provider host)
//    for the login-recipe dataset.
// 2. When Foyer is connected to a password manager with passkeys, answer
//    navigator.credentials.get/create itself. The request goes to the
//    extension, which checks the site, asks the user in its own dialog and has
//    the bridge sign. Private keys never enter the browser. If Foyer has no
//    passkey for the site, or the user prefers, the browser's own flow runs.
//
// Talking to the extension: the isolated content script hands this script a
// MessagePort at document_start, before page scripts exist; only the first
// port is accepted. Nothing secret crosses it: requests are the page's own
// options, answers are the credential the page asked for.

type Detail = Record<string, unknown>
type Reply = { id: number; ok: boolean; result?: any; error?: string }

const marker = Symbol.for("foyer.hooked")
const proto = (globalThis as any).CredentialsContainer?.prototype

let port: MessagePort | null = null
let seq = 0
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>()

window.addEventListener(
  "message",
  function accept(event) {
    if (event.source !== window || event.data?.foyer !== "port" || !event.ports?.[0] || port) return
    event.stopImmediatePropagation()
    window.removeEventListener("message", accept, true)
    port = event.ports[0]
    port.onmessage = (m: MessageEvent<Reply>) => {
      const w = waiting.get(m.data?.id)
      if (!w) return
      waiting.delete(m.data.id)
      if (m.data.ok) w.resolve(m.data.result)
      else w.reject(new DOMException(m.data.error || "The operation either timed out or was not allowed.", "NotAllowedError"))
    }
    port.postMessage({ op: "ack" })
  },
  true,
)
window.postMessage({ foyer: "hello" }, location.origin === "null" ? "*" : location.origin)

function emit(detail: Detail) {
  port?.postMessage({ op: "report", detail })
}

function ask(op: string, payload: unknown, signal?: AbortSignal): Promise<any> {
  if (!port) return Promise.reject(new Error("no port"))
  const id = ++seq
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    port!.postMessage({ id, op, payload })
    signal?.addEventListener("abort", () => {
      if (!waiting.has(id)) return
      waiting.delete(id)
      port?.postMessage({ id, op: "cancel" })
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
    })
  })
}

function resultOf(err: unknown): "cancelled" | "error" {
  const name = (err as { name?: string } | null)?.name
  return name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "error"
}

function track<T>(promise: Promise<T>, detail: Detail): Promise<T> {
  emit({ ...detail, phase: "start" })
  promise.then(
    () => emit({ ...detail, phase: "end", result: "ok" }),
    (err) => emit({ ...detail, phase: "end", result: resultOf(err) }),
  )
  return promise
}

function hostOf(url: unknown): string | undefined {
  try {
    return typeof url === "string" ? new URL(url, location.href).hostname : undefined
  } catch {
    return undefined
  }
}

// ---- Encoding -----------------------------------------------------------------

function bytes(source: unknown): Uint8Array | undefined {
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  return undefined
}

function b64url(source: unknown): string | undefined {
  const b = bytes(source)
  if (!b) return undefined
  let s = ""
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromB64url(s: string): ArrayBuffer {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

const descriptorIds = (list: unknown) =>
  Array.isArray(list) ? (list.map((c: any) => b64url(c?.id)).filter(Boolean) as string[]) : []

function serializeGet(options: any) {
  const pk = options.publicKey
  return {
    challenge: b64url(pk.challenge),
    rpId: typeof pk.rpId === "string" ? pk.rpId : undefined,
    allowCredentials: descriptorIds(pk.allowCredentials),
    userVerification: typeof pk.userVerification === "string" ? pk.userVerification : undefined,
    mediation: typeof options.mediation === "string" ? options.mediation : undefined,
    timeout: typeof pk.timeout === "number" ? pk.timeout : undefined,
  }
}

function serializeCreate(options: any) {
  const pk = options.publicKey
  return {
    challenge: b64url(pk.challenge),
    rp: { id: typeof pk.rp?.id === "string" ? pk.rp.id : undefined, name: String(pk.rp?.name ?? "") },
    user: { id: b64url(pk.user?.id), name: String(pk.user?.name ?? ""), displayName: String(pk.user?.displayName ?? "") },
    algorithms: Array.isArray(pk.pubKeyCredParams) ? pk.pubKeyCredParams.map((p: any) => p?.alg).filter((a: unknown) => typeof a === "number") : [],
    excludeCredentials: descriptorIds(pk.excludeCredentials),
    residentKey: pk.authenticatorSelection?.residentKey,
    userVerification: pk.authenticatorSelection?.userVerification,
    attestation: typeof pk.attestation === "string" ? pk.attestation : undefined,
    timeout: typeof pk.timeout === "number" ? pk.timeout : undefined,
  }
}

// ---- Credential objects ---------------------------------------------------------

const define = (target: object, props: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(props)) Object.defineProperty(target, key, { value, enumerable: true, configurable: true })
  return target
}

function credential(kind: "create" | "get", r: any): PublicKeyCredential {
  const PKC = (globalThis as any).PublicKeyCredential
  const rawId = fromB64url(r.credentialId)
  const clientDataJSON = fromB64url(r.clientDataJSON)
  let response: object
  let json: Record<string, unknown>
  if (kind === "create") {
    const attestationObject = fromB64url(r.attestationObject)
    const authenticatorData = fromB64url(r.authenticatorData)
    const publicKey = fromB64url(r.publicKey)
    response = Object.create((globalThis as any).AuthenticatorAttestationResponse?.prototype ?? Object.prototype)
    define(response, {
      clientDataJSON,
      attestationObject,
      getTransports: () => ["internal", "hybrid"],
      getAuthenticatorData: () => authenticatorData.slice(0),
      getPublicKey: () => publicKey.slice(0),
      getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
    })
    json = {
      clientDataJSON: r.clientDataJSON,
      attestationObject: r.attestationObject,
      authenticatorData: r.authenticatorData,
      publicKey: r.publicKey,
      publicKeyAlgorithm: r.publicKeyAlgorithm,
      transports: ["internal", "hybrid"],
    }
  } else {
    response = Object.create((globalThis as any).AuthenticatorAssertionResponse?.prototype ?? Object.prototype)
    define(response, {
      clientDataJSON,
      authenticatorData: fromB64url(r.authenticatorData),
      signature: fromB64url(r.signature),
      userHandle: r.userHandle ? fromB64url(r.userHandle) : null,
    })
    json = { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle ?? null }
  }
  const extensions = kind === "create" ? { credProps: { rk: true } } : {}
  const cred = Object.create(PKC?.prototype ?? Object.prototype)
  define(cred, {
    id: r.credentialId,
    rawId,
    type: "public-key",
    response,
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => extensions,
    toJSON: () => ({
      id: r.credentialId,
      rawId: r.credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: extensions,
      response: json,
    }),
  })
  return cred
}

// ---- Hooks -------------------------------------------------------------------------

if (proto && !proto[marker]) {
  proto[marker] = true
  const originalGet = proto.get
  const originalCreate = proto.create

  proto.get = function (this: CredentialsContainer, options?: any) {
    if (options?.publicKey) {
      const pk = options.publicKey
      const detail = {
        kind: "passkey",
        op: "get",
        mediation: typeof options.mediation === "string" ? options.mediation : undefined,
        userVerification: typeof pk.userVerification === "string" ? pk.userVerification : undefined,
        rpId: typeof pk.rpId === "string" ? pk.rpId : undefined,
        hasAllowList: Array.isArray(pk.allowCredentials) ? pk.allowCredentials.length > 0 : false,
      }
      const native = () => originalGet.call(this, options)
      if (!port || !window.isSecureContext) return track(native(), detail)
      const answer = (async () => {
        const r = await ask("get", serializeGet(options), options.signal)
        if (r?.fallback) return native()
        return credential("get", r)
      })()
      return track(answer, detail)
    }
    if (options?.identity?.providers) {
      // FedCM, e.g. Google One Tap. Only the provider's host is kept.
      const hosts = (options.identity.providers as any[]).map((p) => hostOf(p?.configURL)).filter(Boolean)
      return track(originalGet.call(this, options), { kind: "fedcm", hosts })
    }
    return originalGet.call(this, options)
  }

  proto.create = function (this: CredentialsContainer, options?: any) {
    if (options?.publicKey) {
      const pk = options.publicKey
      const detail = {
        kind: "passkey",
        op: "create",
        userVerification: typeof pk.authenticatorSelection?.userVerification === "string" ? pk.authenticatorSelection.userVerification : undefined,
        rpId: typeof pk.rp?.id === "string" ? pk.rp.id : undefined,
      }
      const native = () => originalCreate.call(this, options)
      if (!port || !window.isSecureContext) return track(native(), detail)
      const answer = (async () => {
        const r = await ask("create", serializeCreate(options), options.signal)
        if (r?.fallback) return native()
        return credential("create", r)
      })()
      return track(answer, detail)
    }
    return originalCreate.call(this, options)
  }
}
