import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"

import { Name, type NameKey } from "../src/shared/Name.js"
import { Crypto } from "../src/server/Crypto.js"
import { Keys } from "../src/server/Keys.js"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

const key = (label: string): NameKey => Name.key(Result.getOrThrow(Name.parse(label)))

// The fixed vectors (auth hash, token wrap key, every AAD) are in `vectors.ts`.

const integrity = (what: Keys.KeyOpenFailed["what"]) => new Keys.KeyOpenFailed({ what })

const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect)

describe("Keys envelopes, from the real Argon2id key-encryption key", () => {
  const location = { vaultId: 1, itemId: 1, fieldId: 1, kind: "login", labelKey: key("password") } as const
  const value = 'fictional-only-"credential"-\\-line\nsecond-line-é'

  // One Init's worth of keys: the master key under the Passphrase's key-encryption key, a Vault key under the
  // master key, a Token's Grant wrap and a sealed Field.
  const setup = Effect.gen(function* () {
    const { master } = yield* Keys.newMaster("correct horse battery staple")
    const underMaster = yield* Keys.newVault(master, 1)
    const issued = yield* Keys.newToken(master, 1, [{ vaultId: 1, access: "read+create", underMaster }])
    const [grant] = issued.wraps

    if (grant === undefined) return yield* Effect.die("newToken returned no wrap")
    const sealed = yield* Keys.sealField(yield* Keys.vaultKeyFromMaster(master, 1, underMaster), location, value)
    const holder = { id: 1, token: issued.token, wrapSalt: issued.salt }

    return { master, underMaster, issued, grant, sealed, holder }
  })

  it.effect("opens a Field sealed under the Vault key from the master key, and again from the Token's Grant wrap", () =>
    Effect.gen(function* () {
      const { master, underMaster, issued, grant, sealed, holder } = yield* setup
      assert.match(Redacted.value(issued.token), /^hush_[A-Za-z0-9_-]{43}$/)
      assert.strictEqual(hex(issued.hash), hex(Keys.authHash(Redacted.value(issued.token))))
      assert.strictEqual(issued.salt.length, 16)
      assert.strictEqual(grant.wrap.wrapped.length, 48)
      assert.strictEqual((sealed.wrapped.length - 16) % 64, 0)
      const fromMaster = yield* Keys.vaultKeyFromMaster(master, 1, underMaster)
      assert.strictEqual(yield* Keys.openField(fromMaster, location, sealed), value)
      const fromToken = yield* Keys.vaultKeyFromToken(holder, { vaultId: 1, access: "read+create", wrap: grant.wrap })
      assert.strictEqual(yield* Keys.openField(fromToken, location, sealed), value)
    }),
  )

  it.effect("fails a Vault-key wrap moved to another Vault id as KeyOpenFailed vault-key", () =>
    Effect.gen(function* () {
      const { master, underMaster, grant, holder } = yield* setup
      assert.deepStrictEqual(yield* failure(Keys.vaultKeyFromMaster(master, 2, underMaster)), integrity("vault-key"))
      assert.deepStrictEqual(
        yield* failure(Keys.vaultKeyFromToken(holder, { vaultId: 2, access: "read+create", wrap: grant.wrap })),
        integrity("vault-key"),
      )
    }),
  )

  it.effect("fails a Grant wrap moved to another Token id, or whose Access changed: its AAD binds both", () =>
    Effect.gen(function* () {
      const { grant, holder } = yield* setup
      assert.deepStrictEqual(
        yield* failure(
          Keys.vaultKeyFromToken({ ...holder, id: 2 }, { vaultId: 1, access: "read+create", wrap: grant.wrap }),
        ),
        integrity("vault-key"),
      )
      assert.deepStrictEqual(
        yield* failure(Keys.vaultKeyFromToken(holder, { vaultId: 1, access: "read", wrap: grant.wrap })),
        integrity("vault-key"),
      )
    }),
  )

  it.effect("fails a Field moved to another row, Kind or label key as KeyOpenFailed field", () =>
    Effect.gen(function* () {
      const { master, underMaster, sealed } = yield* setup
      const vaultKey = yield* Keys.vaultKeyFromMaster(master, 1, underMaster)

      for (const moved of [
        { ...location, fieldId: 2 },
        { ...location, itemId: 2 },
        { ...location, vaultId: 2 },
        { ...location, kind: "database" as const },
        { ...location, labelKey: key("username") },
      ])
        assert.deepStrictEqual(yield* failure(Keys.openField(vaultKey, moved, sealed)), integrity("field"))
    }),
  )

  it.effect("fails a sealed value whose padding is wrong, never returning an empty value", () =>
    Effect.gen(function* () {
      const { master, underMaster } = yield* setup
      const vaultKey = yield* Keys.vaultKeyFromMaster(master, 1, underMaster)
      // Sealed by hand without padding, under the right key and AAD.
      const raw = yield* Keys.sealField(vaultKey, location, "")

      const bare = yield* Crypto.seal(
        yield* Keys.vaultKeyFromMaster(master, 1, underMaster),
        Keys.fieldAad(location),
        new Uint8Array(64).fill(1),
      )

      assert.strictEqual(yield* Keys.openField(vaultKey, location, raw), "")
      assert.deepStrictEqual(yield* failure(Keys.openField(vaultKey, location, bare)), integrity("field"))
    }),
  )
})

describe("Keys.fromPassphrase and Keys.rewrapMaster, from the real Argon2id key-encryption key", () => {
  const passphrase = "correct horse battery staple"
  const next = "another fictional passphrase"

  it.effect(
    "opens the master key with the right Passphrase, and fails the tag with a wrong one as KeyOpenFailed master-key",
    () =>
      Effect.gen(function* () {
        const stored = yield* Keys.newMaster(passphrase)
        const underMaster = yield* Keys.newVault(stored.master, 1)
        const master = yield* Keys.fromPassphrase(passphrase, stored)
        // The opened master key is the one Init made: it opens a Vault key wrapped under the original.
        yield* Keys.vaultKeyFromMaster(master, 1, underMaster)
        assert.deepStrictEqual(yield* failure(Keys.fromPassphrase(`${passphrase}x`, stored)), integrity("master-key"))
      }),
  )

  it.effect(
    "derives the key-encryption key from the NFC Passphrase, so a decomposed form opens the master key too",
    () =>
      Effect.gen(function* () {
        const stored = yield* Keys.newMaster("café fictional passphrase")
        yield* Keys.fromPassphrase("café fictional passphrase", stored)
      }),
  )

  it.effect(
    "rewraps the same master key under the new Passphrase with a new salt and nonce; the old one no longer opens it",
    () =>
      Effect.gen(function* () {
        const stored = yield* Keys.newMaster(passphrase)
        const underMaster = yield* Keys.newVault(stored.master, 1)
        const rewrapped = yield* Keys.rewrapMaster(passphrase, next, stored)
        assert.notStrictEqual(hex(rewrapped.salt), hex(stored.salt))
        assert.notStrictEqual(hex(rewrapped.wrap.nonce), hex(stored.wrap.nonce))
        assert.strictEqual(rewrapped.salt.length, 16)
        assert.strictEqual(rewrapped.wrap.wrapped.length, 48)
        const master = yield* Keys.fromPassphrase(next, rewrapped)
        yield* Keys.vaultKeyFromMaster(master, 1, underMaster)
        assert.deepStrictEqual(yield* failure(Keys.fromPassphrase(passphrase, rewrapped)), integrity("master-key"))
      }),
  )

  it.effect("refuses to rewrap under a wrong current Passphrase as KeyOpenFailed master-key", () =>
    Effect.gen(function* () {
      const stored = yield* Keys.newMaster(passphrase)
      assert.deepStrictEqual(yield* failure(Keys.rewrapMaster(`${passphrase}x`, next, stored)), integrity("master-key"))
    }),
  )

  it.effect("raises each KDF parameter to at least the default at a rewrap, keeping a higher stored one", () =>
    Effect.gen(function* () {
      // A master key wrapped by hand under weaker parameters than today's defaults, and more passes.
      const params = { memoryKib: 1024, passes: 5, parallelism: 1 }
      const salt = Crypto.randomBytes(16)
      const raw = Crypto.randomBytes(32)
      const kek = yield* Crypto.deriveKek(passphrase, salt, params, "encrypt")
      const wrap = yield* Crypto.seal(kek, Keys.masterAad(Keys.kdfVersion), new Uint8Array(raw))
      const rewrapped = yield* Keys.rewrapMaster(passphrase, next, { salt, params, wrap })
      assert.deepStrictEqual(rewrapped.params, { memoryKib: 65536, passes: 5, parallelism: 4 })
      yield* Keys.fromPassphrase(next, rewrapped)
    }),
  )

  it.effect("checks a Passphrase with 64 MiB of Argon2 memory in about 150 ms (timing logged)", () =>
    Effect.gen(function* () {
      const stored = yield* Keys.newMaster(passphrase)
      assert.strictEqual(stored.params.memoryKib * 1024, 64 * 1024 * 1024)
      const started = performance.now()
      yield* Keys.fromPassphrase(passphrase, stored)
      const elapsed = performance.now() - started
      console.log(`one Passphrase check: ${elapsed.toFixed(0)} ms, ${stored.params.memoryKib} KiB of Argon2 memory`)
    }),
  )
})
