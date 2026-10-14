import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as fc from "fast-check"
import { argon2 } from "node:crypto"

import { Crypto } from "../src/server/Crypto.js"
import { Keys } from "../src/server/Keys.js"
import { COMPOSED_CAFE, DECOMPOSED_CAFE } from "./arbitraries.js"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "hex"))

const nodeArgon2id = (parameters: Parameters<typeof argon2>[1]) =>
  Effect.callback<Buffer>((resume) =>
    argon2("argon2id", parameters, (error, key) => resume(error === null ? Effect.succeed(key) : Effect.die(error))),
  )

const rawKey = (raw: Uint8Array) =>
  Effect.promise(() => crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, ["decrypt"]))

// The fixed vectors (lp, every AAD, RFC 9106) are in `vectors.ts`.

describe("Crypto.lp", () => {
  it("keeps parts that a `/` join would merge apart", () => {
    assert.notStrictEqual(hex(Crypto.lp("a/b", "c")), hex(Crypto.lp("a", "b/c")))
  })

  it("never encodes two different part lists the same", () => {
    const parts = fc.array(fc.string({ unit: "grapheme" }), { maxLength: 5 })
    fc.assert(
      fc.property(parts, parts, (left, right) => {
        fc.pre(JSON.stringify(left) !== JSON.stringify(right))
        assert.notStrictEqual(hex(Crypto.lp(...left)), hex(Crypto.lp(...right)))
      }),
    )
  })
})

describe("Argon2id", () => {
  it.effect(
    "derives the key-encryption key with m = 65536 KiB, t = 3, p = 4 over the NFC Passphrase, in under 2 s",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(Crypto.kdfDefaults, { memoryKib: 65536, passes: 3, parallelism: 4 })
        const salt = Crypto.randomBytes(16)
        const rssBefore = process.memoryUsage().rss
        const started = performance.now()
        const kek = yield* Crypto.deriveKek(`${DECOMPOSED_CAFE} passphrase`, salt, Crypto.kdfDefaults, "encrypt")
        const elapsed = performance.now() - started
        console.info(
          `Argon2id derivation: ${elapsed.toFixed(0)} ms, rss +${((process.memoryUsage().rss - rssBefore) / 2 ** 20).toFixed(1)} MiB`,
        )
        assert.isBelow(elapsed, 2000)
        const expected = yield* nodeArgon2id({
          // The composed form: deriveKek hashes the NFC Passphrase.
          message: Buffer.from(`${COMPOSED_CAFE} passphrase`),
          nonce: salt,
          memory: 65536,
          passes: 3,
          parallelism: 4,
          tagLength: 32,
        })
        const sealed = yield* Crypto.seal(kek, Crypto.lp("aad"), bytes("00".repeat(32)))
        const opened = yield* Crypto.open(yield* rawKey(expected), Crypto.lp("aad"), sealed)
        assert.strictEqual(hex(opened), "00".repeat(32))
      }),
  )
})

describe("Crypto.seal and Crypto.open", () => {
  const key = Effect.promise(() =>
    crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["encrypt", "decrypt"]),
  )

  it.effect("wraps a 32-byte key into a fresh 12-byte nonce and 48 bytes, and opens it with the same AAD", () =>
    Effect.gen(function* () {
      const k = yield* key
      const first = yield* Crypto.seal(k, Crypto.lp("x"), bytes("11".repeat(32)))
      const second = yield* Crypto.seal(k, Crypto.lp("x"), bytes("11".repeat(32)))
      assert.strictEqual(first.nonce.length, 12)
      assert.strictEqual(first.wrapped.length, 48)
      assert.notStrictEqual(hex(first.nonce), hex(second.nonce))
      assert.strictEqual(hex(yield* Crypto.open(k, Crypto.lp("x"), first)), "11".repeat(32))
    }),
  )

  it.effect("fails to open under another AAD", () =>
    Effect.gen(function* () {
      const k = yield* key
      const sealed = yield* Crypto.seal(k, Crypto.lp("x"), bytes("11".repeat(32)))
      const exit = yield* Effect.exit(Crypto.open(k, Crypto.lp("y"), sealed))
      assert.isTrue(Exit.isFailure(exit))
    }),
  )
})

describe("Keys.newMaster", () => {
  it.effect(
    "wraps a random master key under the Passphrase's key-encryption key with the master-key AAD; another Passphrase fails",
    () =>
      Effect.gen(function* () {
        const master = yield* Keys.newMaster("correct horse battery staple")
        assert.strictEqual(master.salt.length, 16)
        assert.deepStrictEqual(master.params, Crypto.kdfDefaults)
        assert.strictEqual(master.wrap.wrapped.length, 48)
        const aad = Keys.masterAad(Keys.kdfVersion)
        const kek = yield* Crypto.deriveKek("correct horse battery staple", master.salt, master.params, "decrypt")
        const mk = yield* Crypto.open(kek, aad, master.wrap)
        assert.strictEqual(mk.length, 32)
        assert.notStrictEqual(hex(mk), "00".repeat(32))
        const wrong = yield* Crypto.deriveKek("incorrect horse battery", master.salt, master.params, "decrypt")
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Crypto.open(wrong, aad, master.wrap))))
      }),
  )
})
