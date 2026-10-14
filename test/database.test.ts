import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "../src/server/Database.js"
import { StateDir } from "../src/server/StateDir.js"

// The Server's connection, opened in-process on a temporary state directory: pragmas are per connection, so
// only the connection itself can show them.
const withDatabase = <A, E>(test: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "hush-db-"))),
    (root) =>
      Effect.gen(function* () {
        const stateDir = join(root, "state")
        yield* StateDir.prepare(stateDir)
        const sql = yield* Database.open(stateDir)

        return yield* test(sql)
      }).pipe(Effect.scoped),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  )

const Rows = <S extends Schema.Struct.Fields>(fields: S) => Schema.Array(Schema.Struct(fields))

const pragma = (sql: SqlClient.SqlClient, name: string) =>
  sql.unsafe(`PRAGMA ${name}`).pipe(Effect.map((rows) => Object.values(rows[0] ?? {})[0]))

const rejected = (statement: Effect.Effect<unknown, unknown>) =>
  Effect.match(statement, { onFailure: () => true, onSuccess: () => false })

describe("Database.open", () => {
  it.effect("sets the hygiene pragmas, WAL and a 5 s busy timeout on its connection", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* pragma(sql, "foreign_keys"), 1)
        assert.strictEqual(yield* pragma(sql, "secure_delete"), 1)
        assert.strictEqual(yield* pragma(sql, "synchronous"), 2) // FULL
        assert.strictEqual(yield* pragma(sql, "temp_store"), 2) // MEMORY
        assert.strictEqual(yield* pragma(sql, "journal_mode"), "wal")
        assert.strictEqual(yield* pragma(sql, "busy_timeout"), 5000)
      }),
    ),
  )

  it.effect("migrates to exactly the expected tables, indexes and trigger, every table STRICT", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        const objects = yield* Schema.decodeUnknownEffect(Rows({ type: Schema.String, name: Schema.String }))(
          yield* sql`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        )

        assert.deepStrictEqual(
          objects.map(({ type, name }) => `${type} ${name}`),
          [
            "index audit_token",
            "index token_vaults_vault",
            "index tokens_active_label",
            "table audit",
            "table effect_sql_migrations",
            "table fields",
            "table items",
            "table meta",
            "table retired_titles",
            "table token_vaults",
            "table tokens",
            "table vaults",
            "trigger tokens_revoke_drops_wraps",
          ],
        )

        const strict = yield* Schema.decodeUnknownEffect(Rows({ name: Schema.String, strict: Schema.Number }))(
          yield* sql`SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND name != 'effect_sql_migrations'`,
        )

        assert.strictEqual(strict.length, 8)

        for (const table of strict) assert.strictEqual(table.strict, 1, table.name)
      }),
    ),
  )

  it.effect("enforces the schema's CHECKs", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        assert.isTrue(
          yield* rejected(
            sql`INSERT INTO meta VALUES (2, 1, 1, 65536, 3, 4, zeroblob(16), zeroblob(12), zeroblob(48), 'now', 'now')`,
          ),
        )
        assert.isTrue(
          yield* rejected(
            sql`INSERT INTO meta VALUES (1, 1, 1, 1024, 3, 4, zeroblob(16), zeroblob(12), zeroblob(48), 'now', 'now')`,
          ),
        )
        yield* sql`INSERT INTO vaults VALUES (1, 'Work', 'work', zeroblob(12), zeroblob(48), 'now')`
        yield* sql`INSERT INTO tokens VALUES (1, zeroblob(32), zeroblob(16), 'agent', 'agent', 'now', NULL, NULL, NULL)`
        assert.isTrue(yield* rejected(sql`INSERT INTO token_vaults VALUES (1, 1, 'write', zeroblob(12), zeroblob(48))`))
        assert.isTrue(yield* rejected(sql`INSERT INTO token_vaults VALUES (1, 1, 'read', zeroblob(12), NULL)`))
        // foreign_keys = ON: a Grant for a Vault that does not exist is refused.
        assert.isTrue(yield* rejected(sql`INSERT INTO token_vaults VALUES (1, 99, 'read', zeroblob(12), zeroblob(48))`))
      }),
    ),
  )

  it.effect("nulls a Token's wraps when it is revoked (tokens_revoke_drops_wraps)", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO vaults VALUES (1, 'Work', 'work', zeroblob(12), zeroblob(48), 'now')`
        yield* sql`INSERT INTO tokens VALUES (1, zeroblob(32), zeroblob(16), 'agent', 'agent', 'now', NULL, NULL, NULL)`
        yield* sql`INSERT INTO token_vaults VALUES (1, 1, 'read', zeroblob(12), zeroblob(48))`
        yield* sql`UPDATE tokens SET revoked_at = 'later' WHERE id = 1`
        const wraps = yield* sql`SELECT key_nonce, key_wrapped, access FROM token_vaults`
        assert.deepStrictEqual(wraps, [{ key_nonce: null, key_wrapped: null, access: "read" }])
      }),
    ),
  )

  it.effect(
    "nextIds gives a fresh table id 1, consecutive ids within a transaction, and SQLite continues after them",
    () =>
      withDatabase((sql) =>
        Effect.gen(function* () {
          const insert = (id: number, key: string) =>
            sql`INSERT INTO vaults VALUES (${id}, ${key}, ${key}, zeroblob(12), zeroblob(48), 'now')`

          const first = yield* sql.withTransaction(
            Effect.gen(function* () {
              const ids = yield* Database.nextIds("vaults", 1)

              for (const [index, id] of ids.entries()) yield* insert(id, `a${index}`)

              return ids
            }),
          )

          assert.deepStrictEqual(first, [1])

          const next = yield* sql.withTransaction(
            Effect.gen(function* () {
              const ids = yield* Database.nextIds("vaults", 2)

              for (const [index, id] of ids.entries()) yield* insert(id, `b${index}`)

              return ids
            }),
          )

          assert.deepStrictEqual(next, [2, 3])
          yield* sql`INSERT INTO vaults (name, name_key, key_nonce, key_wrapped, created_at)
          VALUES ('c', 'c', zeroblob(12), zeroblob(48), 'now')`
          const ids = yield* sql`SELECT id FROM vaults ORDER BY id`
          assert.deepStrictEqual(ids, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
          assert.deepStrictEqual(yield* sql.withTransaction(Database.nextIds("items", 1)), [1])
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
  )

  it.effect("fails a duplicate key with a SqlError whose reason is UniqueViolation", () =>
    withDatabase((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO vaults VALUES (1, 'Work', 'work', zeroblob(12), zeroblob(48), 'now')`

        const error = yield* Effect.flip(
          sql`INSERT INTO vaults VALUES (2, 'WORK', 'work', zeroblob(12), zeroblob(48), 'now')`,
        )

        assert.strictEqual(error.reason._tag, "UniqueViolation")
      }),
    ),
  )
})
