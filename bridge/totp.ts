// RFC 6238 TOTP (and RFC 4648 base32) with node:crypto.

import { createHmac } from "node:crypto"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "")
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error("invalid base32 secret")
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export interface TotpOptions {
  /** Unix time in milliseconds. */
  now?: number
  period?: number
  digits?: number
  algorithm?: "sha1" | "sha256" | "sha512"
}

export function totp(key: Buffer, options: TotpOptions = {}): string {
  const { now = Date.now(), period = 30, digits = 6, algorithm = "sha1" } = options
  const counter = Math.floor(now / 1000 / period)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac(algorithm, key).update(message).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return code.toString().padStart(digits, "0")
}

/** Accepts a bare base32 secret or an otpauth:// URI and returns the current code. */
export function totpFromSecret(secretOrUri: string, now?: number): string {
  if (secretOrUri.startsWith("otpauth://")) {
    const params = new URL(secretOrUri).searchParams
    const algorithm = (params.get("algorithm") ?? "SHA1").toLowerCase()
    return totp(base32Decode(params.get("secret") ?? ""), {
      now,
      period: Number(params.get("period")) || 30,
      digits: Number(params.get("digits")) || 6,
      algorithm: algorithm === "sha256" || algorithm === "sha512" ? algorithm : "sha1",
    })
  }
  return totp(base32Decode(secretOrUri), { now })
}
