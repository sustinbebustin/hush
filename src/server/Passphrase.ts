import { Clock, Context, Effect, Predicate, Redacted, Ref, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"

import type { PassphraseChangeReceipt, PassphraseChangeRequest } from "../shared/Api.js"
import {
  type ApiError,
  type AuditUnavailable,
  BackoffActive,
  InvalidValue,
  PassphraseIncorrect,
  type PassphraseInvalid,
} from "../shared/ApiError.js"
import { Passphrase as Policy } from "../shared/Passphrase.js"
import { Audit } from "./Audit.js"
import { Backoff } from "./Backoff.js"
import { Database } from "./Database.js"
import { Keys } from "./Keys.js"
import { Locks } from "./Locks.js"

// The Passphrase check of every human-only request: reserve a slot
// in the backoff, derive the KEK under the Argon2 permit outside any transaction, open MK; then the operation and
// its audit row in one transaction. Every evaluated Passphrase is one audit row, `denied` when wrong; an attempt
// refused by the backoff is neither evaluated nor audited.

// The server-wide backoff, in memory: a restart clears it. Never consulted for Tokens or Init codes.
export class Attempts extends Context.Service<Attempts, Ref.Ref<Backoff>>()("hush/Passphrase/Attempts") {}

export const makeAttempts: Effect.Effect<Ref.Ref<Backoff>> = Ref.make(Backoff.initial)

const MetaRow = Schema.Struct({
  kdf_memory_kib: Schema.Number,
  kdf_passes: Schema.Number,
  kdf_parallelism: Schema.Number,
  kdf_salt: Schema.Uint8Array,
  mk_nonce: Schema.Uint8Array,
  mk_wrapped: Schema.Uint8Array,
})

// MK as `meta` holds it. The gate lets Passphrase requests through only when Ready, so a missing row is a broken
// store, as is a read failure: both die.
const storedMaster: Effect.Effect<Keys.StoredMaster, never, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(MetaRow))(
    yield* sql`SELECT kdf_memory_kib, kdf_passes, kdf_parallelism, kdf_salt, mk_nonce, mk_wrapped FROM meta WHERE id = 1`,
  )

  if (row === undefined) return yield* Effect.die(new Error("a Passphrase request reached a Server without meta"))

  return {
    salt: new Uint8Array(row.kdf_salt),
    params: { memoryKib: row.kdf_memory_kib, passes: row.kdf_passes, parallelism: row.kdf_parallelism },
    wrap: { nonce: new Uint8Array(row.mk_nonce), wrapped: new Uint8Array(row.mk_wrapped) },
  }
}).pipe(Effect.orDie)

// What a Passphrase request's audit row names: Vaults, References (a Reveal's) and detail, never a value or the
// Passphrase.
export interface Scope {
  readonly vaults: ReadonlyArray<string>
  readonly references?: ReadonlyArray<string>
  readonly detail?: Audit.Detail
}

export type Refusal = PassphraseIncorrect | BackoffActive | InvalidValue | AuditUnavailable

// One Passphrase request. `unlock` runs under the Argon2 permit with the entered Passphrase and MK as stored; its
// only failure, `KeyOpenFailed`, means the Passphrase is wrong. `operation` runs in one transaction with the `ok`
// row; a failure after the check is recorded `error` in a transaction of its own. With `exclusive`, the meta lock
// is held from the read of `meta` to the commit, so no other change interleaves; with `checkpoint`, the WAL is
// checkpointed after the commit. With `outsideTransaction`, for a statement SQLite refuses inside one (`VACUUM`),
// the operation runs on the bare connection and changes nothing, and its `ok` row follows in a transaction of its
// own; if that row cannot be written, the result is dropped, so nothing is returned unrecorded.
export const audited = <U, A, E extends ApiError = never, R = never>(request: {
  readonly passphrase: Redacted.Redacted<string>
  readonly action: Audit.Action
  readonly peer: string | null
  readonly scope: Scope
  readonly exclusive: boolean
  readonly checkpoint: boolean
  readonly outsideTransaction?: true
  readonly unlock: (passphrase: string, stored: Keys.StoredMaster) => Effect.Effect<U, Keys.KeyOpenFailed>
  readonly operation: (unlocked: U) => Effect.Effect<A, E, SqlClient.SqlClient | R>
  // The `ok` row's scope when only the result knows it (Token issue's merged Grants); `scope` otherwise.
  readonly recorded?: (result: A) => Scope
}) =>
  Effect.gen(function* () {
    const attempts = yield* Attempts
    const nowMs = yield* Clock.currentTimeMillis
    const entered = Redacted.value(request.passphrase)

    // JSON can carry a lone surrogate, which has no UTF-8 form; no stored Passphrase has one.
    if (!entered.isWellFormed()) return yield* new InvalidValue({ field: "passphrase", reason: "not-utf8" })

    // One synchronous step before any await, so concurrent attempts cannot all take a free slot.
    const reserved = yield* Ref.modify(
      attempts,
      (state): readonly [Result.Result<number, { readonly retryAfterSeconds: number }>, Backoff] =>
        Result.match(Backoff.reserve(state, nowMs), {
          onFailure: (refused) => [Result.fail(refused), state],
          onSuccess: (next) => [Result.succeed(next.failures), next],
        }),
    )

    if (Result.isFailure(reserved)) return yield* new BackoffActive(reserved.failure)
    const failures = reserved.success

    const locks = yield* Locks.Service
    const sql = yield* SqlClient.SqlClient
    const at = yield* Audit.now

    const record = (result: Audit.Outcome, scope: Scope = request.scope) =>
      Audit.write({
        at,
        actor: { type: "passphrase" },
        action: request.action,
        vaults: scope.vaults,
        references: scope.references ?? [],
        detail: scope.detail,
        result,
        peer: request.peer,
      })

    // A wrong Passphrase keeps its reservation and is recorded `denied`; any other outcome means MK opened, which
    // clears the backoff.
    const wrong = Effect.gen(function* () {
      const incorrect = new PassphraseIncorrect({ retryAfterSeconds: Backoff.delaySeconds(failures) })
      yield* sql.withTransaction(record({ outcome: "denied", error: incorrect._tag }))

      return yield* incorrect
    })

    // After the check: the operation and its `ok` row in one transaction, or the failure recorded `error`.
    const afterCheck = (unlocked: U) =>
      Effect.gen(function* () {
        const recordOk = (done: A) => record({ outcome: "ok" }, request.recorded?.(done))

        const result =
          request.outsideTransaction === true
            ? yield* Effect.tap(request.operation(unlocked), (done) => sql.withTransaction(recordOk(done)))
            : yield* sql.withTransaction(Effect.tap(request.operation(unlocked), recordOk))

        if (request.checkpoint) yield* Database.checkpointCommitted

        return result
      }).pipe(
        Effect.catchIf(
          (error): error is Exclude<E, AuditUnavailable> => !Predicate.isTagged(error, "AuditUnavailable"),
          (error) =>
            Effect.andThen(sql.withTransaction(record({ outcome: "error", error: error._tag })), Effect.fail(error)),
        ),
      )

    const checked = Effect.gen(function* () {
      const stored = yield* storedMaster

      const unlocked = yield* locks.argon2
        .withPermit(request.unlock(entered, stored))
        .pipe(Effect.catchTag("KeyOpenFailed", () => wrong))

      yield* Ref.set(attempts, Backoff.succeed())

      return yield* afterCheck(unlocked)
    })

    return yield* request.exclusive ? locks.meta.withPermit(checked) : checked
  }).pipe(Effect.catchTag("SqlError", Effect.die))

// `passphrase/change`: under the meta lock, the current Passphrase is checked under the backoff, then the new one
// against the policy, then the same MK is rewrapped and `meta` updated in one transaction, then checkpointed so the
// old wrap leaves the files. Vault keys, Token wraps and Fields
// are untouched.
export const change = (request: PassphraseChangeRequest, peer: string | null) =>
  audited({
    passphrase: request.passphrase,
    action: "passphrase.change",
    peer,
    scope: { vaults: [] },
    exclusive: true,
    checkpoint: true,
    // A new Passphrase the policy refuses is carried as a value, so the current one is still checked first: a
    // wrong one is `PassphraseIncorrect` whatever the new one is.
    unlock: (
      current,
      stored,
    ): Effect.Effect<Result.Result<Keys.StoredMaster, InvalidValue | PassphraseInvalid>, Keys.KeyOpenFailed> => {
      const next = Redacted.value(request.newPassphrase)

      const checked: Result.Result<string, InvalidValue | PassphraseInvalid> = next.isWellFormed()
        ? Policy.policy(next)
        : Result.fail(new InvalidValue({ field: "newPassphrase", reason: "not-utf8" }))

      return Result.match(checked, {
        onFailure: (refused) => Effect.as(Keys.fromPassphrase(current, stored), Result.fail(refused)),
        onSuccess: (nfc) => Effect.map(Keys.rewrapMaster(current, nfc, stored), Result.succeed),
      })
    },
    operation: (unlocked) =>
      Effect.gen(function* () {
        const rewrapped = yield* Effect.fromResult(unlocked)
        const sql = yield* SqlClient.SqlClient
        const at = yield* Audit.now
        yield* sql`
          UPDATE meta SET kdf_memory_kib = ${rewrapped.params.memoryKib}, kdf_passes = ${rewrapped.params.passes},
            kdf_parallelism = ${rewrapped.params.parallelism}, kdf_salt = ${rewrapped.salt},
            mk_nonce = ${rewrapped.wrap.nonce}, mk_wrapped = ${rewrapped.wrap.wrapped}, passphrase_changed_at = ${at}
          WHERE id = 1`.pipe(Effect.orDie)
        const receipt: PassphraseChangeReceipt = { changed: true }

        return receipt
      }),
  })

export * as Passphrase from "./Passphrase.js"
