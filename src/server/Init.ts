import { Effect, Redacted, Ref } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import type { InitReceipt, InitRequest } from "../shared/Api.js"
import { AlreadyInitialised, InitCodeInvalid, InvalidValue, parseName } from "../shared/ApiError.js"
import { Name } from "../shared/Name.js"
import { Passphrase } from "../shared/Passphrase.js"
import { Audit } from "./Audit.js"
import { Database } from "./Database.js"
import { InitCode } from "./InitCode.js"
import { Keys } from "./Keys.js"
import { Locks } from "./Locks.js"
import { Log } from "./Log.js"
import { ServerState } from "./ServerState.js"

// `POST /v1/admin/init`. Under the meta lock: refuse when Ready without looking
// at the code; check the code in constant time (wrong codes are neither audited nor counted); apply the
// Passphrase policy and, with `first`, the name rules; derive the KEK and wrap a new master key outside any
// transaction; then commit `meta`, the first Vault and Token if asked, and the audit row in one transaction; then
// become Ready and delete the code file.

const parse = (what: string, input: string) => Effect.fromResult(parseName(what, input))

export const run = (request: InitRequest, peer: string | null) =>
  Effect.gen(function* () {
    const locks = yield* Locks.Service
    const current = yield* ServerState.Current
    const sql = yield* SqlClient.SqlClient
    return yield* locks.meta.withPermit(
      Effect.gen(function* () {
        const state = yield* Ref.get(current)
        if (state._tag === "Ready") return yield* new AlreadyInitialised()
        if (!InitCode.matches(Redacted.value(request.initCode), state.initCodeDigest))
          return yield* new InitCodeInvalid()
        const entered = Redacted.value(request.passphrase)
        // JSON can carry a lone surrogate, which has no UTF-8 form to derive the KEK from.
        if (!entered.isWellFormed()) return yield* new InvalidValue({ field: "passphrase", reason: "not-utf8" })
        const passphrase = yield* Effect.fromResult(Passphrase.policy(entered))
        const first =
          request.first === undefined
            ? undefined
            : {
                vault: yield* parse("vault", request.first.vault),
                label: yield* parse("label", request.first.label),
              }
        const master = yield* locks.argon2.withPermit(Keys.newMaster(passphrase))
        const at = yield* Audit.now
        const issued = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO meta (id, format, kdf_version, kdf_memory_kib, kdf_passes, kdf_parallelism, kdf_salt,
                  mk_nonce, mk_wrapped, initialised_at, passphrase_changed_at)
                VALUES (1, 1, ${Keys.kdfVersion}, ${master.params.memoryKib}, ${master.params.passes},
                  ${master.params.parallelism}, ${master.salt}, ${master.wrap.nonce}, ${master.wrap.wrapped},
                  ${at}, ${at})`
              const created = first === undefined ? undefined : yield* createFirst(master.master, first, at)
              yield* Audit.write({
                at,
                actor: { type: "init" },
                action: "init",
                vaults: first === undefined ? [] : [first.vault],
                references: [],
                ...(first === undefined
                  ? {}
                  : { detail: { label: first.label, grants: [{ vault: first.vault, access: "read+create" }] } }),
                result: { outcome: "ok" },
                peer,
              })
              return created
            }),
          )
          // BEGIN, COMMIT or an insert failing is not an expected outcome: an empty 500, nothing committed. The
          // master key opens the wrap it just made, so `GrantKeyOpenFailed` cannot happen here either.
          .pipe(Effect.catchTag(["SqlError", "GrantKeyOpenFailed"], Effect.die))
        yield* Ref.set(current, { _tag: "Ready" })
        // Init has committed, so a file that cannot be deleted is logged, not reported; a Ready start retries.
        yield* InitCode.remove(state.initCodeFile).pipe(
          Effect.catch((error) => Log.write({ event: "init-code-delete-failed", path: error.path, code: error.code })),
        )
        const receipt: InitReceipt = issued === undefined ? { state: "ready" } : { state: "ready", first: issued }
        return receipt
      }),
    )
  })

// The first Vault, its K_v wrap under MK, a Token with a Read+Create Grant on it and the Grant's wrap, with ids
// from `nextIds`. Runs inside Init's transaction; returns the receipt's `first`, the only place the
// plaintext Token appears.
const createFirst = (
  master: Keys.MasterKey,
  first: { readonly vault: Name; readonly label: Name },
  at: string,
): Effect.Effect<NonNullable<InitReceipt["first"]>, SqlError.SqlError | Keys.GrantKeyOpenFailed, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const vaultId = yield* Database.nextId("vaults")
    const tokenId = yield* Database.nextId("tokens")
    const underMaster = yield* Keys.newVault(master, vaultId)
    yield* sql`
      INSERT INTO vaults (id, name, name_key, key_nonce, key_wrapped, created_at)
      VALUES (${vaultId}, ${first.vault}, ${Name.key(first.vault)}, ${underMaster.nonce}, ${underMaster.wrapped}, ${at})`
    const issued = yield* Keys.newToken(master, tokenId, [{ vaultId, access: "read+create", underMaster }])
    yield* sql`
      INSERT INTO tokens (id, hash, wrap_salt, label, label_key, created_at)
      VALUES (${tokenId}, ${issued.hash}, ${issued.salt}, ${first.label}, ${Name.key(first.label)}, ${at})`
    for (const grant of issued.wraps)
      yield* sql`
        INSERT INTO token_vaults (token_id, vault_id, access, key_nonce, key_wrapped)
        VALUES (${tokenId}, ${grant.vaultId}, ${grant.access}, ${grant.wrap.nonce}, ${grant.wrap.wrapped})`
    return {
      vault: first.vault,
      label: first.label,
      grants: issued.wraps.map(({ access }) => ({ vault: first.vault, access })),
      expiresAt: null,
      token: issued.token,
    }
  })

export * as Init from "./Init.js"
