// WebAuthn authenticator crypto for Foyer passkeys: ES256 (P-256) keys,
// "none" attestation, and a minimal canonical CBOR encoder. Adapters only
// store the resulting PasskeyRecord; all signing happens here.
//
// Private keys must never be logged.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto"

export const ES256 = -7

/** Fixed AAGUID identifying Foyer-created passkeys (random, generated once). */
export const FOYER_AAGUID = Buffer.from("8f3c6b1e5a2d4c7f9e0b1a6d3c5e7f92", "hex")

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40

/** What adapters store for one passkey. Binary values are base64url. */
export interface PasskeyRecord {
  rpId: string
  credentialId: string
  userHandle: string
  userName: string
  displayName: string
  /** PKCS#8 DER, base64url. Secret. */
  privateKey: string
  createdAt: string
}

// ---- base64url ----------------------------------------------------------------

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

export function fromB64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("invalid base64url")
  return Buffer.from(value.replace(/=+$/, ""), "base64url")
}

// ---- CBOR (RFC 8949 core deterministic encoding, the subset WebAuthn needs) ---

export type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue> | { [key: string]: CborValue }

function head(major: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("CBOR: invalid length/integer")
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value])
  if (value < 0x10000) {
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(value, 1)
    return b
  }
  if (value < 0x100000000) {
    const b = Buffer.alloc(5)
    b[0] = (major << 5) | 26
    b.writeUInt32BE(value, 1)
    return b
  }
  const b = Buffer.alloc(9)
  b[0] = (major << 5) | 27
  b.writeBigUInt64BE(BigInt(value), 1)
  return b
}

export function cborEncode(value: CborValue): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("CBOR: only integers are supported")
    return value >= 0 ? head(0, value) : head(1, -1 - value)
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8")
    return Buffer.concat([head(3, bytes.length), bytes])
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)])
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cborEncode)])
  const entries: Array<[CborValue, CborValue]> = value instanceof Map ? [...value.entries()] : Object.entries(value)
  // Deterministic order: shorter encoded key first, then bytewise.
  const encoded = entries
    .map(([k, v]) => [cborEncode(k), cborEncode(v)] as const)
    .sort(([a], [b]) => a.length - b.length || Buffer.compare(a, b))
  for (let i = 1; i < encoded.length; i++) if (Buffer.compare(encoded[i - 1]![0], encoded[i]![0]) === 0) throw new Error("CBOR: duplicate key")
  return Buffer.concat([head(5, encoded.length), ...encoded.flat()])
}

// ---- Authenticator ------------------------------------------------------------

function rpIdHash(rpId: string): Buffer {
  return createHash("sha256").update(rpId, "utf8").digest()
}

function flags(userVerified: boolean, attested: boolean): number {
  return FLAG_UP | (userVerified ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | (attested ? FLAG_AT : 0)
}

function clientDataHashBytes(clientDataHash: string): Buffer {
  const hash = fromB64url(clientDataHash)
  if (hash.length !== 32) throw new Error("clientDataHash must be 32 bytes")
  return hash
}

/** Generates a new P-256 key and the record an adapter stores for it. */
export function newPasskeyRecord(input: { rpId: string; user: { id: string; name: string; displayName: string }; now?: Date }): PasskeyRecord {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  return {
    rpId: input.rpId,
    credentialId: b64url(randomBytes(16)),
    userHandle: input.user.id,
    userName: input.user.name,
    displayName: input.user.displayName,
    privateKey: b64url(privateKey.export({ format: "der", type: "pkcs8" })),
    createdAt: (input.now ?? new Date()).toISOString(),
  }
}

function loadPrivateKey(record: PasskeyRecord) {
  try {
    return createPrivateKey({ key: fromB64url(record.privateKey), format: "der", type: "pkcs8" })
  } catch {
    throw new Error("stored passkey key is unreadable")
  }
}

export interface Attestation {
  authenticatorData: string
  attestationObject: string
  /** SPKI DER, base64url. */
  publicKey: string
  publicKeyAlgorithm: number
}

/** Registration response for a freshly stored record ("none" attestation). */
export function attestPasskey(input: { record: PasskeyRecord; clientDataHash: string; userVerified: boolean }): Attestation {
  // "none" attestation doesn't sign clientDataHash, but reject malformed input anyway.
  clientDataHashBytes(input.clientDataHash)
  const publicKey = createPublicKey(loadPrivateKey(input.record))
  const jwk = publicKey.export({ format: "jwk" })
  if (jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("passkey key is not P-256")
  const credentialId = fromB64url(input.record.credentialId)
  const coseKey = cborEncode(
    new Map<CborValue, CborValue>([
      [1, 2], // kty: EC2
      [3, ES256], // alg
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]),
  )
  const credIdLength = Buffer.alloc(2)
  credIdLength.writeUInt16BE(credentialId.length)
  const authData = Buffer.concat([
    rpIdHash(input.record.rpId),
    Buffer.from([flags(input.userVerified, true)]),
    Buffer.alloc(4), // signCount 0: synced passkeys don't keep a counter
    FOYER_AAGUID,
    credIdLength,
    credentialId,
    coseKey,
  ])
  return {
    authenticatorData: b64url(authData),
    attestationObject: b64url(cborEncode({ fmt: "none", attStmt: {}, authData })),
    publicKey: b64url(publicKey.export({ format: "der", type: "spki" })),
    publicKeyAlgorithm: ES256,
  }
}

export function assertPasskey(input: {
  record: PasskeyRecord
  rpId: string
  clientDataHash: string
  userVerified: boolean
}): { authenticatorData: string; signature: string } {
  const hash = clientDataHashBytes(input.clientDataHash)
  const authData = Buffer.concat([rpIdHash(input.rpId), Buffer.from([flags(input.userVerified, false)]), Buffer.alloc(4)])
  const signature = sign("sha256", Buffer.concat([authData, hash]), { key: loadPrivateKey(input.record), dsaEncoding: "der" })
  return { authenticatorData: b64url(authData), signature: b64url(signature) }
}

/** Validates an untrusted record loaded from storage. */
export function parseRecord(raw: unknown): PasskeyRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const keys = ["rpId", "credentialId", "userHandle", "privateKey"] as const
  if (!keys.every((k) => typeof r[k] === "string" && (r[k] as string).length > 0)) return undefined
  return {
    rpId: r.rpId as string,
    credentialId: r.credentialId as string,
    userHandle: r.userHandle as string,
    userName: typeof r.userName === "string" ? r.userName : "",
    displayName: typeof r.displayName === "string" ? r.displayName : "",
    privateKey: r.privateKey as string,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
  }
}
