import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Schema, Scope } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient, SqlError } from "effect/sql"

import { PlatformCause } from "../shared/PlatformCause.js"
import { Log } from "./Log.js"
import { migrations } from "./migrations.js"
import { DatabaseOpenFailed, MigrationFailed, MigrationPending } from "./StartupError.js"
import { StateDir } from "./StateDir.js"

// The Server's one SQLite connection: WAL and a 5 s busy timeout (the client's defaults), the hygiene pragmas,
// migrations, and the start checkpoint. Host commands open a
// second connection of their own with `openHost`.

// The tables whose rows are sealed or wrapped with their own id in the AAD, so the id must be
// known before the insert.
export type IdTable = "vaults" | "items" | "fields" | "tokens"

const Sequence = Schema.Array(Schema.Struct({ seq: Schema.Number }))

// The ids the next `n` rows of `table` get: `sqlite_sequence` read once, then base+1..base+n in insertion order.
// Call it inside the write transaction (`BEGIN IMMEDIATE`) that inserts those rows with explicit ids,
// so no other writer can take them; SQLite then advances `seq` past them. Reading or decoding the sequence
// failing is not an expected outcome, so it dies.
export const nextIds = (table: IdTable, n: number): Effect.Effect<ReadonlyArray<number>, never, SqlClient.SqlClient> =>
  Effect.map(lastId(table), (base) => Array.from({ length: n }, (_, index) => base + 1 + index))

// `nextIds(table, 1)` for the one row a transaction inserts.
export const nextId = (table: IdTable): Effect.Effect<number, never, SqlClient.SqlClient> =>
  Effect.map(lastId(table), (base) => base + 1)

const lastId = (table: IdTable): Effect.Effect<number, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const rows = yield* Schema.decodeUnknownEffect(Sequence)(
      yield* sql`SELECT seq FROM sqlite_sequence WHERE name = ${table}`,
    )

    return rows[0]?.seq ?? 0
  }).pipe(Effect.orDie)

// Every row of `statement`, decoded with `schema`. A failed read or an undecodable row is a broken store, not an
// expected outcome, so it dies.
export const rows = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  statement: Effect.Effect<unknown, SqlError.SqlError>,
) => Effect.flatMap(statement, Schema.decodeUnknownEffect(Schema.Array(schema))).pipe(Effect.orDie)

// bun:sqlite's error code (`SQLITE_NOTADB`, ...) and message, or the reason's tag when the cause carries none.
const sqliteDetail = (error: SqlError.SqlError) => ({
  code: PlatformCause.code(error.reason.cause) ?? error.reason._tag,
  message: PlatformCause.message(error.reason.cause) ?? error.reason._tag,
})

// Pragmas are no-ops inside a transaction, so they run on the bare connection before anything else.
const hygiene = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`PRAGMA secure_delete = ON`
  yield* sql`PRAGMA synchronous = FULL`
  yield* sql`PRAGMA temp_store = MEMORY`
})

const CheckpointResult = Schema.Struct({ busy: Schema.Number, log: Schema.Number, checkpointed: Schema.Number })

// `wal_checkpoint(TRUNCATE)` outside any transaction, so retired wraps and sealed values leave the WAL file. A busy
// result is logged; the next checkpointing write or the next start retries it.
export const checkpoint: Effect.Effect<void, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const answer = yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`
    const result = yield* Schema.decodeUnknownEffect(Schema.Tuple([CheckpointResult]))(answer)

    if (result[0].busy !== 0) yield* Log.write({ event: "checkpoint-busy" })
  },
)

// `checkpoint` after a commit that retired a wrap. The write has committed, so a failure is logged
// rather than reported; the next checkpointing write or the next start retries it.
export const checkpointCommitted: Effect.Effect<void, never, SqlClient.SqlClient> = checkpoint.pipe(
  Effect.catch((error) =>
    Log.write({
      event: "checkpoint-failed",
      code: Schema.isSchemaError(error) ? "unexpected result" : error.reason._tag,
    }),
  ),
)

const migrate = SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
  // The migrator dies with a `MigrationError` when a migration fails, after rolling the transaction back.
  Effect.catchDefect((defect) =>
    defect instanceof SqliteMigrator.MigrationError ? Effect.fail(defect) : Effect.die(defect),
  ),
  Effect.mapError((error) => {
    const version = Object.keys(migrations).at(-1) ?? "unknown"

    if (error instanceof SqliteMigrator.MigrationError) {
      const cause: unknown = error.cause
      const detail = SqlError.isSqlError(cause) ? sqliteDetail(cause).message : error.message

      return new MigrationFailed({ version, message: detail })
    }

    return new MigrationFailed({ version, message: sqliteDetail(error).message })
  }),
)

// A failure reading the database during start, with SQLite's code when it gave one.
export const openFailed = (stateDir: string) => (error: SqlError.SqlError | Schema.SchemaError) =>
  new DatabaseOpenFailed({
    path: StateDir.databasePath(stateDir),
    code: SqlError.isSqlError(error) ? sqliteDetail(error).code : "unexpected result",
  })

// Opens `<stateDir>/hush.db` (prepared by `StateDir.prepare`), applies the pragmas, migrates and checkpoints.
export const open = (
  stateDir: string,
): Effect.Effect<SqlClient.SqlClient, DatabaseOpenFailed | MigrationFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const path = StateDir.databasePath(stateDir)
    const failed = openFailed(stateDir)

    const client = yield* SqliteClient.make({ filename: path }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError(failed),
    )

    const withClient = Effect.provideService(SqlClient.SqlClient, client)
    yield* hygiene.pipe(withClient, Effect.mapError(failed))
    yield* migrate.pipe(withClient)
    yield* checkpoint.pipe(withClient, Effect.mapError(failed))

    return client
  })

// The highest migration id this binary knows: keys are `<id>_<name>`.
const latestMigration = Math.max(...Object.keys(migrations).map((key) => Number.parseInt(key, 10)))

const Applied = Schema.Array(Schema.Struct({ id: Schema.NullOr(Schema.Number) }))

// Whether every migration this binary knows has been applied: the migrator's table exists and holds the latest.
const schemaCurrent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const table = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`

  if (table.length === 0) return false

  const [applied] = yield* Schema.decodeUnknownEffect(Applied)(
    yield* sql`SELECT max(migration_id) AS id FROM effect_sql_migrations`,
  )

  return (applied?.id ?? 0) >= latestMigration
})

// A host command's own connection to `<stateDir>/hush.db`: WAL, the busy timeout and the hygiene
// pragmas as the Server's, beside which it is safe; never created, chmod-ed or migrated. A schema older than
// this binary is `MigrationPending`.
export const openHost = (
  stateDir: string,
): Effect.Effect<SqlClient.SqlClient, DatabaseOpenFailed | MigrationPending, Scope.Scope> =>
  Effect.gen(function* () {
    const failed = openFailed(stateDir)

    const client = yield* SqliteClient.make({ filename: StateDir.databasePath(stateDir), create: false }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError(failed),
    )

    const withClient = Effect.provideService(SqlClient.SqlClient, client)
    yield* hygiene.pipe(withClient, Effect.mapError(failed))

    if (!(yield* schemaCurrent.pipe(withClient, Effect.mapError(failed)))) return yield* new MigrationPending()

    return client
  })

export * as Database from "./Database.js"
