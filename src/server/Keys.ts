import { Brand, Effect, Redacted, Result, Schema } from "effect"

import type { Access } from "../shared/Access.js"
import type { Kind } from "../shared/Kind.js"
import type { NameKey } from "../shared/Name.js"
import { Token } from "../shared/Token.js"
import { Crypto } from "./Crypto.js"
import { Padding } from "./Padding.js"

// The key hierarchy. The KEK (key-encryption key) is Argon2id of the Passphrase; it wraps MK, the master key. Each
// Vault's key K_v is wrapped under MK and again under TW, the token wrap key (HKDF of the Token's secret), of every
// Token with a Grant on that Vault; each Field is sealed under its Vault's K_v. Raw key bytes are zeroed once
// imported or wrapped; every key is a non-extractable `CryptoKey` that lives for one request.

// `meta.kdf_version`: Argon2id with the parameters stored beside it.
export const kdfVersion = 1

// Both are plain AES-GCM `CryptoKey`s to WebCrypto; the brands keep MK (which wraps K_v) from being passed where a
// K_v (which seals Fields) is expected, and the reverse.
export type MasterKey = CryptoKey & Brand.Brand<"MasterKey">

export type VaultKey = CryptoKey & Brand.Brand<"VaultKey">

const masterKey = Brand.nominal<MasterKey>()
const vaultKey = Brand.nominal<VaultKey>()

// Where a Field is stored: its AAD binds the row ids and the immutable columns that give it meaning, so a sealed value
// moved to another row or Field does not open.
export interface FieldLocation {
  readonly vaultId: number
  readonly itemId: number
  readonly fieldId: number
  readonly kind: Kind
  readonly labelKey: NameKey
}

// The AAD of the master key's wrap under the KEK.
export const masterAad = (version: number): Crypto.Bytes => Crypto.lp("hush", "v1", "mk", version)

// The AAD of K_v's wrap under MK.
export const vaultAad = (vaultId: number): Crypto.Bytes => Crypto.lp("hush", "v1", "vaultkey", vaultId, "mk")

// The AAD of K_v's wrap under a Token's TW: a Read Grant turned into Read+Create no longer opens.
export const grantAad = (vaultId: number, tokenId: number, access: Access): Crypto.Bytes =>
  Crypto.lp("hush", "v1", "vaultkey", vaultId, tokenId, access)

export const fieldAad = (at: FieldLocation): Crypto.Bytes =>
  Crypto.lp("hush", "v1", "field", at.vaultId, at.itemId, at.fieldId, at.kind, at.labelKey)

// `tokens.hash`: SHA-256 of the Token string as presented.
export const authHash = (token: Token): Crypto.Bytes => Crypto.sha256(new TextEncoder().encode(token))

// MK as `meta` stores it: wrapped under the KEK derived with this salt and these parameters.
export interface StoredMaster {
  readonly salt: Crypto.Bytes
  readonly params: Crypto.KdfParams
  readonly wrap: Crypto.Wrap
}

export interface NewMaster extends StoredMaster {
  // For the rest of the Init request only: Init with `first` wraps the first K_v under it and unwraps it again for
  // the first Token.
  readonly master: MasterKey
}

// A ciphertext did not open under a key that must be right. The caller knows which Reference or Vault it
// was and reports it as `IntegrityCheckFailed`.
export class KeyOpenFailed extends Schema.TaggedError<KeyOpenFailed>()("KeyOpenFailed", {
  what: Schema.Literals(["field", "vault-key", "master-key"]),
}) {}

// Opens `wrap` under `key` to raw key bytes, mapping a failed tag to `KeyOpenFailed` naming `what`.
const unwrap = (key: CryptoKey, aad: Crypto.Bytes, wrap: Crypto.Wrap, what: KeyOpenFailed["what"]) =>
  Crypto.open(key, aad, wrap).pipe(Effect.mapError(() => new KeyOpenFailed({ what })))

// Seals fresh random key bytes under `key`, zeroing them afterwards.
const sealRandomKey = (key: CryptoKey, aad: Crypto.Bytes): Effect.Effect<Crypto.Wrap> =>
  Effect.suspend(() => {
    const raw = Crypto.randomBytes(32)

    return Crypto.seal(key, aad, raw).pipe(Effect.ensuring(Effect.sync(() => raw.fill(0))))
  })

// Init: a random 32-byte master key wrapped under the KEK of `passphrase` with a fresh salt and
// the default parameters. The caller holds the Argon2 permit.
export const newMaster = (passphrase: string): Effect.Effect<NewMaster> =>
  Effect.gen(function* () {
    const salt = Crypto.randomBytes(16)
    const params = Crypto.kdfDefaults
    const kek = yield* Crypto.deriveKek(passphrase, salt, params, "encrypt")

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => Crypto.randomBytes(32)),
      (raw) =>
        Effect.gen(function* () {
          const wrap = yield* Crypto.seal(kek, masterAad(kdfVersion), raw)
          const master = masterKey(yield* Crypto.importKey(raw, ["encrypt", "decrypt"]))

          return { salt, params, wrap, master }
        }),
      (raw) => Effect.sync(() => raw.fill(0)),
    )
  })

// The Passphrase check: MK's raw bytes, opened under the KEK of `passphrase`. A failed tag is the
// only sign of a wrong Passphrase (no separate verifier). The caller holds the Argon2 permit and zeroes the bytes.
const openMaster = (passphrase: string, stored: StoredMaster): Effect.Effect<Crypto.Bytes, KeyOpenFailed> =>
  Effect.flatMap(Crypto.deriveKek(passphrase, stored.salt, stored.params, "decrypt"), (kek) =>
    unwrap(kek, masterAad(kdfVersion), stored.wrap, "master-key"),
  )

// MK for one request, from the Passphrase. The caller holds the Argon2 permit.
export const fromPassphrase = (passphrase: string, stored: StoredMaster): Effect.Effect<MasterKey, KeyOpenFailed> =>
  Effect.map(
    Effect.flatMap(openMaster(passphrase, stored), (raw) => Crypto.importKey(raw, ["encrypt", "decrypt"])),
    masterKey,
  )

// Passphrase change: the same raw MK, opened under the current KEK and sealed under the KEK of
// `next` with a new salt and nonce, each parameter raised to at least the default. `next` has passed the policy.
// Two derivations; the caller holds the Argon2 permit.
export const rewrapMaster = (
  current: string,
  next: string,
  stored: StoredMaster,
): Effect.Effect<StoredMaster, KeyOpenFailed> =>
  Effect.acquireUseRelease(
    openMaster(current, stored),
    (raw) =>
      Effect.gen(function* () {
        const salt = Crypto.randomBytes(16)

        const params: Crypto.KdfParams = {
          memoryKib: Math.max(stored.params.memoryKib, Crypto.kdfDefaults.memoryKib),
          passes: Math.max(stored.params.passes, Crypto.kdfDefaults.passes),
          parallelism: Math.max(stored.params.parallelism, Crypto.kdfDefaults.parallelism),
        }

        const kek = yield* Crypto.deriveKek(next, salt, params, "encrypt")
        const wrap = yield* Crypto.seal(kek, masterAad(kdfVersion), raw)

        return { salt, params, wrap }
      }),
    (raw) => Effect.sync(() => raw.fill(0)),
  )

// Vault create: a random K_v wrapped under MK. Nothing is sealed under it yet.
export const newVault = (master: MasterKey, vaultId: number): Effect.Effect<Crypto.Wrap> =>
  sealRandomKey(master, vaultAad(vaultId))

export const vaultKeyFromMaster = (
  master: MasterKey,
  vaultId: number,
  wrap: Crypto.Wrap,
): Effect.Effect<VaultKey, KeyOpenFailed> =>
  unwrap(master, vaultAad(vaultId), wrap, "vault-key").pipe(
    Effect.flatMap((raw) => Crypto.importKey(raw, ["encrypt", "decrypt"])),
    Effect.map(vaultKey),
  )

// A Grant to issue: the Vault, its Access and K_v's wrap under MK (`vaults.key_wrapped`).
export interface GrantWrapInput {
  readonly vaultId: number
  readonly access: Access
  readonly underMaster: Crypto.Wrap
}

// K_v of one Grant, wrapped under the Token's TW (`token_vaults.key_wrapped`).
export interface GrantWrap {
  readonly vaultId: number
  readonly access: Access
  readonly wrap: Crypto.Wrap
}

export interface NewToken {
  // Returned to the caller once and never stored, logged or audited.
  readonly token: Redacted.Redacted<Token>
  readonly hash: Crypto.Bytes
  readonly salt: Crypto.Bytes
  readonly wraps: ReadonlyArray<GrantWrap>
}

// Imports TW for `usage`, zeroing the secret bytes and TW's raw bytes.
const tokenWrapKey = (token: Token, salt: Crypto.Bytes, usage: Crypto.KeyUsage): Effect.Effect<CryptoKey> =>
  Effect.acquireUseRelease(
    Effect.sync(() => Token.secret(token)),
    (secret) => Effect.flatMap(Crypto.tokenWrapBits(secret, salt), (bits) => Crypto.importKey(bits, [usage])),
    (secret) => Effect.sync(() => secret.fill(0)),
  )

// A Vault's K_v wrap under MK did not open while issuing a Token: that Vault's row was modified.
export class GrantKeyOpenFailed extends Schema.TaggedError<GrantKeyOpenFailed>()("GrantKeyOpenFailed", {
  vaultId: Schema.Number,
}) {}

// Token issue: a new Token and salt, and per Grant K_v decrypted from its wrap under MK and
// encrypted under TW with the Grant AAD. `tokenId` comes from `Database.nextIds`.
export const newToken = (
  master: MasterKey,
  tokenId: number,
  grants: ReadonlyArray<GrantWrapInput>,
): Effect.Effect<NewToken, GrantKeyOpenFailed> =>
  Effect.gen(function* () {
    const token = Token.format(Crypto.randomBytes(32))
    const salt = Crypto.randomBytes(16)
    const wrapKey = yield* tokenWrapKey(token, salt, "encrypt")

    const wraps = yield* Effect.forEach(grants, ({ vaultId, access, underMaster }) =>
      Effect.acquireUseRelease(
        unwrap(master, vaultAad(vaultId), underMaster, "vault-key").pipe(
          Effect.mapError(() => new GrantKeyOpenFailed({ vaultId })),
        ),
        (raw) => Crypto.seal(wrapKey, grantAad(vaultId, tokenId, access), raw),
        (raw) => Effect.sync(() => raw.fill(0)),
      ).pipe(Effect.map((wrap) => ({ vaultId, access, wrap }))),
    )

    return { token: Redacted.make(token), hash: authHash(token), salt, wraps }
  })

// What a Token request carries to open its Grants' wraps; an `AuthenticatedToken` is one.
export interface TokenHolder {
  readonly id: number
  readonly token: Redacted.Redacted<Token>
  readonly wrapSalt: Crypto.Bytes
}

// After a hash match TW must be right, so a failed unwrap means the wrap, its Access or its ids were changed.
export const vaultKeyFromToken = (holder: TokenHolder, grant: GrantWrap): Effect.Effect<VaultKey, KeyOpenFailed> =>
  Effect.gen(function* () {
    const wrapKey = yield* tokenWrapKey(Redacted.value(holder.token), holder.wrapSalt, "decrypt")
    const raw = yield* unwrap(wrapKey, grantAad(grant.vaultId, holder.id, grant.access), grant.wrap, "vault-key")

    return vaultKey(yield* Crypto.importKey(raw, ["encrypt", "decrypt"]))
  })

// Pads and seals a value under K_v with the Field AAD: `wrapped` is the padded ciphertext and tag.
export const sealField = (key: VaultKey, at: FieldLocation, value: string): Effect.Effect<Crypto.Wrap> =>
  Effect.suspend(() => {
    const padded = Padding.pad(value)

    return Crypto.seal(key, fieldAad(at), padded).pipe(Effect.ensuring(Effect.sync(() => padded.fill(0))))
  })

// Any failure here, with a K_v that opened, is `KeyOpenFailed` naming `field`: never an empty value.
export const openField = (
  key: VaultKey,
  at: FieldLocation,
  sealed: Crypto.Wrap,
): Effect.Effect<string, KeyOpenFailed> =>
  unwrap(key, fieldAad(at), sealed, "field").pipe(
    Effect.flatMap((padded) =>
      Result.match(Padding.unpad(padded), {
        onSuccess: (value) => Effect.succeed(value),
        onFailure: () => Effect.fail(new KeyOpenFailed({ what: "field" })),
      }).pipe(Effect.ensuring(Effect.sync(() => padded.fill(0)))),
    ),
  )

export * as Keys from "./Keys.js"
