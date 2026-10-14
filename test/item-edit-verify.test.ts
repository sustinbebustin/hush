import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "../src/server/Database.js"
import { ItemAdmin } from "../src/server/ItemAdmin.js"
import { Keys } from "../src/server/Keys.js"
import { Locks } from "../src/server/Locks.js"
import { Passphrase } from "../src/server/Passphrase.js"
import { StateDir } from "../src/server/StateDir.js"
import { Kind } from "../src/shared/Kind.js"
import { Name } from "../src/shared/Name.js"

// `item edit`'s verification before commit at repository level: the seam cannot corrupt a seal between
// the write and the commit, so a test double of `Keys.sealField` tampers with the new row, and the edit must fail
// `IntegrityCheckFailed` and roll back, leaving the old value as it was.

const passphrase = "correct horse battery staple"

// What an edit needs from the Server: the connection, the locks and the backoff.
type Needs = Effect.Services<ReturnType<typeof ItemAdmin.edit>>

const withStore = <A, E>(test: Effect.Effect<A, E, Needs>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "hush-edit-"))),
    (root) =>
      Effect.gen(function* () {
        const stateDir = join(root, "state")
        yield* StateDir.prepare(stateDir)
        const sql = yield* Database.open(stateDir)

        return yield* test.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Locks.Service, yield* Locks.make),
          Effect.provideService(Passphrase.Attempts, yield* Passphrase.makeAttempts),
        )
      }).pipe(Effect.scoped),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  )

const at = "2026-01-01T00:00:00.000Z"

// `meta` under `passphrase`, Vault `Work` (id 1) and the api-credential `Stripe` (id 1) with its credential Field
// (id 1), as Init and create store them.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { master, salt, params, wrap } = yield* Keys.newMaster(passphrase)
  yield* sql`
    INSERT INTO meta (id, format, kdf_version, kdf_memory_kib, kdf_passes, kdf_parallelism, kdf_salt, mk_nonce,
      mk_wrapped, initialised_at, passphrase_changed_at)
    VALUES (1, 1, ${Keys.kdfVersion}, ${params.memoryKib}, ${params.passes}, ${params.parallelism}, ${salt},
      ${wrap.nonce}, ${wrap.wrapped}, ${at}, ${at})`
  const underMaster = yield* Keys.newVault(master, 1)
  yield* sql`
    INSERT INTO vaults (id, name, name_key, key_nonce, key_wrapped, created_at)
    VALUES (1, 'Work', 'work', ${underMaster.nonce}, ${underMaster.wrapped}, ${at})`
  yield* sql`
    INSERT INTO items (id, vault_id, title, title_key, kind, created_at, updated_at)
    VALUES (1, 1, 'Stripe', 'stripe', 'api-credential', ${at}, ${at})`
  const key = yield* Keys.vaultKeyFromMaster(master, 1, underMaster)

  const sealed = yield* Keys.sealField(
    key,
    {
      vaultId: 1,
      itemId: 1,
      fieldId: 1,
      kind: "api-credential",
      labelKey: Name.key(Kind.primary("api-credential").label),
    },
    "old value",
  )

  yield* sql`
    INSERT INTO fields (id, item_id, label, label_key, nonce, sealed, updated_at)
    VALUES (1, 1, 'credential', 'credential', ${sealed.nonce}, ${sealed.wrapped}, ${at})`
})

const request = {
  passphrase: Redacted.make(passphrase),
  vault: "Work",
  item: "Stripe",
  change: { set: { label: "credential", value: Redacted.make("new value") } },
} as const

// A sealer whose new seal has one ciphertext bit flipped, so it no longer opens.
const flipsABit: ItemAdmin.Sealer = {
  sealField: (key, location, value) =>
    Effect.map(Keys.sealField(key, location, value), (sealed) => {
      const wrapped = new Uint8Array(sealed.wrapped)
      wrapped.set([(wrapped.at(0) ?? 0) ^ 1], 0)

      return { ...sealed, wrapped }
    }),
}

// A sealer that seals another value, which opens but differs from the input.
const sealsAnotherValue: ItemAdmin.Sealer = {
  sealField: (key, location) => Keys.sealField(key, location, "another value"),
}

describe("item edit verification before commit", () => {
  for (const [name, sealer] of [
    ["a new seal that does not open", flipsABit],
    ["a new seal that opens to another value", sealsAnotherValue],
  ] as const)
    it.effect(`rolls back ${name} with IntegrityCheckFailed, audited error`, () =>
      withStore(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* seed

          const before = {
            fields: yield* sql`SELECT * FROM fields`,
            items: yield* sql`SELECT * FROM items`,
          }

          const failed = yield* Effect.flip(ItemAdmin.edit(request, null, sealer))
          assert.strictEqual(failed._tag, "IntegrityCheckFailed")
          assert.deepStrictEqual(failed._tag === "IntegrityCheckFailed" ? failed.damaged : undefined, {
            what: "field",
            reference: "hush://Work/Stripe/credential",
          })
          assert.deepStrictEqual(
            { fields: yield* sql`SELECT * FROM fields`, items: yield* sql`SELECT * FROM items` },
            before,
          )
          assert.deepStrictEqual(yield* sql`SELECT action, outcome, error FROM audit`, [
            { action: "item.edit", outcome: "error", error: "IntegrityCheckFailed" },
          ])
        }),
      ),
    )

  it.effect("commits with the real sealer, so the double is the only difference", () =>
    withStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* seed
        const receipt = yield* ItemAdmin.edit(request, null)
        assert.strictEqual(receipt.verified, true)
        assert.deepStrictEqual(yield* sql`SELECT action, outcome, error FROM audit`, [
          { action: "item.edit", outcome: "ok", error: null },
        ])
      }),
    ),
  )
})
