import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

import type { PassphraseOnly, VaultDeleted, VaultList, VaultReceipt, VaultRequest } from "../shared/Api.js"
import { parseName, VaultExists, VaultNotEmpty, VaultNotFound } from "../shared/ApiError.js"
import { Name } from "../shared/Name.js"
import { Audit } from "./Audit.js"
import { Database } from "./Database.js"
import { Keys } from "./Keys.js"
import { Passphrase } from "./Passphrase.js"

// Vaults under the Passphrase: create, list and delete, each one Passphrase
// check and one transaction with its audit row.

const parse = (input: string) => Effect.fromResult(parseName("vault", input))

const { named } = Audit
const { rows } = Database

// The one row of an aggregate query; none is a broken store.
const single = <A>(found: ReadonlyArray<A>): Effect.Effect<A> => {
  const [row] = found
  return row === undefined ? Effect.die(new Error("an aggregate query returned no row")) : Effect.succeed(row)
}

// A new K_v wrapped under MK, with its id (from `Database.nextIds`) bound in the AAD. No Token gains a Grant: that
// takes `token issue`.
export const create = (request: VaultRequest, peer: string | null) =>
  Passphrase.audited({
    passphrase: request.passphrase,
    action: "vault.create",
    peer,
    scope: { vaults: named(request.vault) },
    exclusive: false,
    checkpoint: false,
    unlock: Keys.fromPassphrase,
    operation: (master) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const vault = yield* parse(request.vault)
        const at = yield* Audit.now
        const vaultId = yield* Database.nextId("vaults")
        const wrap = yield* Keys.newVault(master, vaultId)
        yield* sql`
          INSERT INTO vaults (id, name, name_key, key_nonce, key_wrapped, created_at)
          VALUES (${vaultId}, ${vault}, ${Name.key(vault)}, ${wrap.nonce}, ${wrap.wrapped}, ${at})`.pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "UniqueViolation",
            () => Effect.fail(new VaultExists({ vault })),
          ),
          Effect.catchTag("SqlError", Effect.die),
        )
        const receipt: VaultReceipt = { vault, createdAt: at }
        return receipt
      }),
  })

const ListRow = Schema.Struct({
  name: Schema.String,
  created_at: Schema.String,
  items: Schema.Number,
  active_tokens: Schema.Number,
})

// Every Vault by name with its counts; nothing is unwrapped.
export const list = (request: PassphraseOnly, peer: string | null) =>
  Passphrase.audited({
    passphrase: request.passphrase,
    action: "vault.list",
    peer,
    scope: { vaults: [] },
    exclusive: false,
    checkpoint: false,
    unlock: Keys.fromPassphrase,
    operation: () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const at = yield* Audit.now
        const found = yield* rows(
          ListRow,
          sql`
            SELECT v.name, v.created_at,
              (SELECT count(*) FROM items i WHERE i.vault_id = v.id) AS items,
              (SELECT count(*) FROM token_vaults tv JOIN tokens t ON t.id = tv.token_id
                WHERE tv.vault_id = v.id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ${at}))
                AS active_tokens
            FROM vaults v ORDER BY v.name_key, v.name`,
        )
        const listed: VaultList = {
          vaults: found.map((row) => ({
            vault: row.name,
            items: row.items,
            activeTokens: row.active_tokens,
            createdAt: row.created_at,
          })),
        }
        return listed
      }),
  })

const VaultRow = Schema.Struct({ id: Schema.Number, name: Schema.String })
const Count = Schema.Struct({ count: Schema.Number })

// Refused while the Vault has Items or an unrevoked Token (expired ones included) holds a Grant on it.
// Otherwise the Vault goes, and with it (by cascade) the Grants of revoked Tokens and its retired titles; then the
// WAL is checkpointed, so its K_v wrap is gone from the files.
export const remove = (request: VaultRequest, peer: string | null) =>
  Passphrase.audited({
    passphrase: request.passphrase,
    action: "vault.delete",
    peer,
    scope: { vaults: named(request.vault) },
    exclusive: false,
    checkpoint: true,
    unlock: Keys.fromPassphrase,
    operation: () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const vault = yield* parse(request.vault)
        const [found] = yield* rows(VaultRow, sql`SELECT id, name FROM vaults WHERE name_key = ${Name.key(vault)}`)
        if (found === undefined) return yield* new VaultNotFound({ vault })
        const items = yield* Effect.flatMap(
          rows(Count, sql`SELECT count(*) AS count FROM items WHERE vault_id = ${found.id}`),
          single,
        )
        const tokens = yield* Effect.flatMap(
          rows(
            Count,
            sql`
              SELECT count(*) AS count FROM token_vaults tv JOIN tokens t ON t.id = tv.token_id
              WHERE tv.vault_id = ${found.id} AND t.revoked_at IS NULL`,
          ),
          single,
        )
        const counts = { items: items.count, activeTokens: tokens.count }
        if (counts.items > 0 || counts.activeTokens > 0)
          return yield* new VaultNotEmpty({ vault: found.name, ...counts })
        yield* sql`DELETE FROM vaults WHERE id = ${found.id}`.pipe(Effect.orDie)
        const receipt: VaultDeleted = { deleted: true, vault: found.name }
        return receipt
      }),
  })

export * as Vaults from "./Vaults.js"
