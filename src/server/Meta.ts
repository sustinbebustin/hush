import { Effect, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import { MetaInvalid } from "./StartupError.js"

// The `meta` row: the KDF parameters and MK's wrap. Its CHECKs guard every write, but a file
// edited by hand or corrupted can still hold a row that breaks them, so a Ready start checks it and refuses it
// with `MetaInvalid`, naming the first column that fails.

const bytesOfLength = (length: number) => Schema.Uint8Array.check(Schema.isBetweenLength(length, length))

// In column order, each as the migration's CHECK states it.
const columns = {
  format: Schema.Literal(1),
  kdf_version: Schema.Literal(1),
  kdf_memory_kib: Schema.Int.check(Schema.isGreaterThanOrEqualTo(65536)),
  kdf_passes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(3)),
  kdf_parallelism: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  kdf_salt: bytesOfLength(16),
  mk_nonce: bytesOfLength(12),
  mk_wrapped: bytesOfLength(48),
  initialised_at: Schema.String,
  passphrase_changed_at: Schema.String,
} as const

const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))

// Start checks `meta` only once a row exists, so a missing `id = 1` row (possible only by editing the file) is
// invalid too.
const check: Effect.Effect<void, MetaInvalid | SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* Schema.decodeUnknownEffect(Rows)(yield* sql`SELECT * FROM meta WHERE id = 1`)

    if (row === undefined) return yield* new MetaInvalid({ field: "id" })
    const invalid = Object.entries(columns).find(([name, schema]) => !Schema.is(schema)(row[name]))

    if (invalid !== undefined) return yield* new MetaInvalid({ field: invalid[0] })
  })

export const Meta = { check } as const
