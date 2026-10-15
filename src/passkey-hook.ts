// Runs in the page's own JS world (content_scripts world: MAIN) so it can see
// WebAuthn and FedCM calls. It reports only the shape of each call (operation,
// mediation, rpId, provider host). Challenges, credential IDs, user handles and
// responses are never read.

type Detail = Record<string, unknown>

const EVENT = "foyer:credentials"
const marker = Symbol.for("foyer.hooked")

function emit(detail: Detail) {
  document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify(detail) }))
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

const proto = (globalThis as any).CredentialsContainer?.prototype
if (proto && !proto[marker]) {
  proto[marker] = true
  const originalGet = proto.get
  const originalCreate = proto.create

  proto.get = function (this: CredentialsContainer, options?: any) {
    const promise = originalGet.call(this, options)
    if (options?.publicKey) {
      const pk = options.publicKey
      return track(promise, {
        kind: "passkey",
        op: "get",
        mediation: typeof options.mediation === "string" ? options.mediation : undefined,
        userVerification: typeof pk.userVerification === "string" ? pk.userVerification : undefined,
        rpId: typeof pk.rpId === "string" ? pk.rpId : undefined,
        hasAllowList: Array.isArray(pk.allowCredentials) ? pk.allowCredentials.length > 0 : false,
      })
    }
    if (options?.identity?.providers) {
      // FedCM, e.g. Google One Tap. Only the provider's host is kept.
      const hosts = (options.identity.providers as any[]).map((p) => hostOf(p?.configURL)).filter(Boolean)
      return track(promise, { kind: "fedcm", hosts })
    }
    return promise
  }

  proto.create = function (this: CredentialsContainer, options?: any) {
    const promise = originalCreate.call(this, options)
    if (options?.publicKey) {
      const pk = options.publicKey
      return track(promise, {
        kind: "passkey",
        op: "create",
        userVerification: typeof pk.authenticatorSelection?.userVerification === "string" ? pk.authenticatorSelection.userVerification : undefined,
        rpId: typeof pk.rp?.id === "string" ? pk.rp.id : undefined,
      })
    }
    return promise
  }
}
