import { assert, describe, it } from "@effect/vitest"
import { Effect, Predicate, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "../src/server/Database.js"
import { Items } from "../src/server/Items.js"
import { Keys } from "../src/server/Keys.js"
import { StateDir } from "../src/server/StateDir.js"
import { Tokens } from "../src/server/Tokens.js"

// The Revoke race at repository level: a Token revoked after authentication must not commit a write or open a
// value, because the handlers read the Token's state with the wraps they use and create re-checks it inside its
// transaction. The seam cannot order a Revoke between
// `TokenAuth` and the handler, so this test authenticates, revokes the row, then calls the handlers' operations
// with the Token they were given.

const withStore = <A, E>(test: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "hush-race-"))),
    (root) =>
      Effect.gen(function* () {
        const stateDir = join(root, "state")
        yield* StateDir.prepare(stateDir)
        const sql = yield* Database.open(stateDir)

        return yield* Effect.provideService(test, SqlClient.SqlClient, sql)
      }).pipe(Effect.scoped),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  )

// One Vault and one Read+Create Token on it, as Init stores them; returns the plaintext Token.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { master } = yield* Keys.newMaster("correct horse battery staple")
  const underMaster = yield* Keys.newVault(master, 1)
  yield* sql`
    INSERT INTO vaults (id, name, name_key, key_nonce, key_wrapped, created_at)
    VALUES (1, 'Work', 'work', ${underMaster.nonce}, ${underMaster.wrapped}, '2026-01-01T00:00:00.000Z')`
  const issued = yield* Keys.newToken(master, 1, [{ vaultId: 1, access: "read+create", underMaster }])
  yield* sql`
    INSERT INTO tokens (id, hash, wrap_salt, label, label_key, created_at)
    VALUES (1, ${issued.hash}, ${issued.salt}, 'agent', 'agent', '2026-01-01T00:00:00.000Z')`

  for (const grant of issued.wraps)
    yield* sql`
      INSERT INTO token_vaults (token_id, vault_id, access, key_nonce, key_wrapped)
      VALUES (1, ${grant.vaultId}, ${grant.access}, ${grant.wrap.nonce}, ${grant.wrap.wrapped})`

  return issued.token
})

const request = (title: string) =>
  ({
    vault: "Work",
    title,
    kind: "api-credential",
    fields: [{ label: "credential", value: Redacted.make(`${title} value`) }],
  }) as const

describe("the Revoke race", () => {
  it.effect(
    "fails create and resolve with TokenRejected revoked for a Token revoked after auth, committing nothing",
    () =>
      withStore(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const token = yield* seed
          const authenticated = yield* Tokens.authenticate(token, "items.create", null)
          yield* Items.create(authenticated, request("Before"), null)

          yield* sql`UPDATE tokens SET revoked_at = '2026-01-02T00:00:00.000Z' WHERE id = 1`

          const created = yield* Effect.flip(Items.create(authenticated, request("After"), null))

          const resolved = yield* Effect.flip(
            Items.resolve(authenticated, { references: ["hush://Work/Before/credential"] }, null),
          )

          const revoked = { reason: "revoked", label: "agent", at: "2026-01-02T00:00:00.000Z" } as const
          assert.strictEqual(created._tag, "TokenRejected")
          assert.deepStrictEqual(Predicate.isTagged(created, "TokenRejected") ? created.rejection : undefined, revoked)
          assert.strictEqual(resolved._tag, "TokenRejected")
          assert.deepStrictEqual(
            Predicate.isTagged(resolved, "TokenRejected") ? resolved.rejection : undefined,
            revoked,
          )
          assert.deepStrictEqual(yield* sql`SELECT title FROM items`, [{ title: "Before" }])
          // Denials of one revoked Token within a minute are coalesced into one audit row.
          assert.deepStrictEqual(yield* sql`SELECT action, count, outcome, error FROM audit ORDER BY id`, [
            { action: "items.create", count: 1, outcome: "ok", error: null },
            { action: "items.create", count: 2, outcome: "denied", error: "TokenRejected" },
          ])
        }),
      ),
  )
})
