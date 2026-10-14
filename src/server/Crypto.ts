import { Effect, Schema } from "effect"
import { argon2, createHash } from "node:crypto"

// Crypto primitives only (the key hierarchy built on them is in Keys.ts): Argon2id, AES-256-GCM seal and open,
// HKDF, SHA-256, `lp` and random bytes. No crypto dependency, no `wrapKey`/`exportKey`, no `Bun.password`. Raw key
// bytes are imported non-extractable for the one operation they serve and zeroed right after.

// Bytes WebCrypto accepts: backed by an `ArrayBuffer`, never a `SharedArrayBuffer`.
export type Bytes = Uint8Array<ArrayBuffer>

export interface KdfParams {
  readonly memoryKib: number
  readonly passes: number
  readonly parallelism: number
}

// RFC 9106's second recommended option: 64 MiB, about 0.15 s per derivation.
export const kdfDefaults: KdfParams = { memoryKib: 65536, passes: 3, parallelism: 4 }

// A key wrapped by `seal`: 12-byte nonce, and for a 32-byte key 48 bytes of ciphertext and tag.
export interface Wrap {
  readonly nonce: Bytes
  readonly wrapped: Bytes
}

export type KeyUsage = "encrypt" | "decrypt"

// The AEAD tag did not verify: wrong key, wrong AAD or modified bytes. Callers decide which it means.
export class OpenFailed extends Schema.TaggedError<OpenFailed>()("OpenFailed", {}) {}

export const randomBytes = (length: number): Bytes => crypto.getRandomValues(new Uint8Array(length))

export const sha256 = (bytes: Uint8Array): Bytes => new Uint8Array(createHash("sha256").update(bytes).digest())

const utf8 = new TextEncoder()

// Per part a 4-byte big-endian byte length, then its UTF-8 bytes; integers as decimal strings.
// Every AAD uses it, since a `/` join lets `("a/b", "c")` and `("a", "b/c")` collide.
export const lp = (...parts: ReadonlyArray<string | number>): Bytes => {
  const encoded = parts.map((part) => utf8.encode(String(part)))
  const out = new Uint8Array(encoded.reduce((total, part) => total + 4 + part.length, 0))
  const view = new DataView(out.buffer)
  let offset = 0
  for (const part of encoded) {
    view.setUint32(offset, part.length)
    out.set(part, offset + 4)
    offset += 4 + part.length
  }
  return out
}

// Imports raw AES-256 key bytes non-extractable for the usages of the one operation they serve, then zeroes them
// and the copy WebCrypto read.
export const importKey = (raw: Uint8Array, usages: ReadonlyArray<KeyUsage>): Effect.Effect<CryptoKey> =>
  Effect.suspend(() => {
    const copy = new Uint8Array(raw)
    return Effect.promise(() => crypto.subtle.importKey("raw", copy, "AES-GCM", false, [...usages])).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          raw.fill(0)
          copy.fill(0)
        }),
      ),
    )
  })

// The KEK (key-encryption key): Argon2id over the UTF-8 of the NFC Passphrase, 32 bytes out, imported for `usage`.
// The caller holds the Argon2 permit (one derivation at a time); the async `argon2` runs off the event loop.
export const deriveKek = (
  passphrase: string,
  salt: Bytes,
  params: KdfParams,
  usage: KeyUsage,
): Effect.Effect<CryptoKey> =>
  Effect.acquireUseRelease(
    Effect.sync(() => Buffer.from(passphrase.normalize("NFC"), "utf8")),
    (message) =>
      Effect.callback<Buffer>((resume) =>
        argon2(
          "argon2id",
          {
            message,
            nonce: salt,
            memory: params.memoryKib,
            passes: params.passes,
            parallelism: params.parallelism,
            tagLength: 32,
          },
          (error, key) => resume(error === null ? Effect.succeed(key) : Effect.die(error)),
        ),
      ).pipe(Effect.flatMap((raw) => importKey(raw, [usage]))),
    (message) => Effect.sync(() => message.fill(0)),
  )

const tokenWrapInfo = utf8.encode("hush-token-wrap-v1")

// The token wrap key's (TW) 32 raw bytes: WebCrypto HKDF-SHA256 over the Token's secret bytes with the per-Token
// salt. The caller imports and zeroes them.
export const tokenWrapBits = (secret: Bytes, salt: Bytes): Effect.Effect<Bytes> =>
  Effect.promise(async () => {
    const ikm = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"])
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: tokenWrapInfo }, ikm, 256)
    return new Uint8Array(bits)
  })

// AES-256-GCM with a fresh 12-byte random nonce.
export const seal = (key: CryptoKey, aad: Bytes, plaintext: Bytes): Effect.Effect<Wrap> =>
  Effect.gen(function* () {
    const nonce = randomBytes(12)
    const wrapped = yield* Effect.promise(() =>
      crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext),
    )
    return { nonce, wrapped: new Uint8Array(wrapped) }
  })

// WebCrypto rejects every failed open with the same `OperationError`, so any rejection is `OpenFailed`.
export const open = (key: CryptoKey, aad: Bytes, sealed: Wrap): Effect.Effect<Bytes, OpenFailed> =>
  Effect.tryPromise({
    try: () => crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.nonce, additionalData: aad }, key, sealed.wrapped),
    catch: () => new OpenFailed(),
  }).pipe(Effect.map((plain) => new Uint8Array(plain)))

export * as Crypto from "./Crypto.js"
