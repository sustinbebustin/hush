import { Result } from "effect"

import type { Crypto } from "./Crypto.js"

// Value padding before sealing:`u32be(byteLength) || UTF-8 || zero bytes` up to the next multiple of 64,
// so a copy of the database does not tell a PIN from a 40-character key.

const block = 64
const prefix = 4

const utf8 = new TextEncoder()
// Fatal, so bytes that are not UTF-8 fail instead of opening as U+FFFD.
const decoder = new TextDecoder("utf-8", { fatal: true })

export const pad = (value: string): Crypto.Bytes => {
  const encoded = utf8.encode(value)
  const out = new Uint8Array(Math.ceil((prefix + encoded.length) / block) * block)
  new DataView(out.buffer).setUint32(0, encoded.length)
  out.set(encoded, prefix)
  return out
}

// The value inside `padded`, or a failure when the length prefix does not fit, the padding is not zero or the
// bytes are not UTF-8. Callers that obtained the key correctly report any failure as `IntegrityCheckFailed`.
export const unpad = (padded: Uint8Array): Result.Result<string, "invalid-padding"> => {
  if (padded.length < block || padded.length % block !== 0) return Result.fail("invalid-padding")
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0)
  if (Math.ceil((prefix + length) / block) * block !== padded.length) return Result.fail("invalid-padding")
  if (padded.subarray(prefix + length).some((byte) => byte !== 0)) return Result.fail("invalid-padding")
  try {
    return Result.succeed(decoder.decode(padded.subarray(prefix, prefix + length)))
  } catch {
    return Result.fail("invalid-padding")
  }
}

export * as Padding from "./Padding.js"
