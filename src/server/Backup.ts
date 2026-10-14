import { Effect, type Scope, Stream } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { createHash } from "node:crypto"

import { OutputFile } from "../shared/OutputFile.js"
import { StateDir } from "./StateDir.js"

// Backup snapshots: `VACUUM INTO` an empty 0600 file,
// which SQLite documents as a consistent snapshot of a live database, never a copy of its WAL; then its size and
// SHA-256. The raw route and both host backup forms use it.

export interface Digest {
  readonly bytes: number
  // Lowercase hex.
  readonly sha256: string
}

// Read in chunks, so a database of hundreds of MB never sits in memory. Failing to read a file this process has
// just written is not an expected outcome, so it dies.
export const digest = (path: string): Effect.Effect<Digest> =>
  Effect.promise(async () => {
    const hash = createHash("sha256")
    let bytes = 0

    for await (const chunk of Bun.file(path).stream()) {
      hash.update(chunk)
      bytes += chunk.byteLength
    }

    return { bytes, sha256: hash.digest("hex") }
  })

// `VACUUM INTO` `path`, an existing empty file (the 0600 mode is the caller's); then its digest. SQLite refuses
// VACUUM inside a transaction, so this runs on the bare connection, serialised with every other statement.
export const vacuumInto = (path: string): Effect.Effect<Digest, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`VACUUM INTO ${path}`

    return yield* digest(path)
  })

export interface Snapshot extends Digest {
  readonly path: string
}

// A snapshot at a fresh `backup-<random>.db` in the state directory, deleted when the scope closes; one left by a
// killed process is deleted at the next start or host command. The state directory is the Server's own,
// so failing to create a file in it dies.
export const snapshot = (
  stateDir: string,
): Effect.Effect<Snapshot, SqlError.SqlError, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* () {
    const path = yield* Effect.acquireRelease(
      OutputFile.createPrivate(stateDir, StateDir.snapshotName).pipe(Effect.orDie),
      OutputFile.remove,
    )

    return { path, ...(yield* vacuumInto(path)) }
  })

// The snapshot's bytes, read when the stream is pulled.
export const bytes = (taken: Snapshot): Stream.Stream<Uint8Array> =>
  Stream.fromReadableStream({ evaluate: () => Bun.file(taken.path).stream(), onError: (cause) => cause }).pipe(
    Stream.orDie,
  )

export * as Backup from "./Backup.js"
