import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { chown, stat } from "node:fs/promises"

import type { TokenRevoked } from "../shared/Api.js"
import { type AuditUnavailable, type InvalidName, parseName, type TokenNotFound } from "../shared/ApiError.js"
import { type FileWriteFailed, OutputFile, type OutputExists } from "../shared/OutputFile.js"
import { PlatformCause } from "../shared/PlatformCause.js"
import { Audit } from "./Audit.js"
import { Backup } from "./Backup.js"
import { Database } from "./Database.js"
import { type DatabaseOpenFailed, type MigrationPending, type Owner, StatePermissionFailed } from "./StartupError.js"
import { StateDir } from "./StateDir.js"
import { Tokens } from "./Tokens.js"

// The host commands: `hush server revoke` and `hush server backup`, run on the Server host as the owner of
// `hush.db` or root, with no Passphrase. Each first deletes stale snapshots left by an interrupted backup, then works
// over its own connection beside the running Server; SQLite's locks and the busy timeout serialise the two.

export type HostError =
  | StatePermissionFailed
  | DatabaseOpenFailed
  | MigrationPending
  | InvalidName
  | TokenNotFound
  | AuditUnavailable
  | OutputExists
  | FileWriteFailed

const walFiles = (stateDir: string) => {
  const database = StateDir.databasePath(stateDir)

  return [`${database}-wal`, `${database}-shm`] as const
}

// The paths of `paths` that exist now.
const existing = (paths: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const found = await Promise.all(
      paths.map((path) =>
        stat(path).then(
          () => [path],
          () => [],
        ),
      ),
    )

    return found.flat()
  })

// The `-wal`/`-shm` files a host command must hand back to the database's owner: only when run as root, and only
// those it created, since the Server could not open root-owned ones.
export const walFilesToHandBack = (input: {
  readonly euid: number | undefined
  readonly before: ReadonlyArray<string>
  readonly after: ReadonlyArray<string>
}): ReadonlyArray<string> => (input.euid === 0 ? input.after.filter((path) => !input.before.includes(path)) : [])

const chownCreated = (stateDir: string, before: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const created = walFilesToHandBack({
      euid: process.geteuid?.(),
      before,
      after: yield* existing(walFiles(stateDir)),
    })

    if (created.length === 0) return
    const database = StateDir.databasePath(stateDir)

    const owner: Owner = yield* Effect.tryPromise({
      try: () => stat(database).then(({ uid, gid }) => ({ uid, gid })),
      catch: (cause) =>
        new StatePermissionFailed({ operation: "read", path: database, code: PlatformCause.codeOrUnknown(cause) }),
    })

    for (const path of created)
      yield* Effect.tryPromise({
        try: () => chown(path, owner.uid, owner.gid),
        catch: (cause) =>
          new StatePermissionFailed({ operation: "chown", path, code: PlatformCause.codeOrUnknown(cause) }),
      })
  })

// Stale snapshots deleted, then `work` over a host connection that is closed before any `-wal`/`-shm` it created
// is handed to the database's owner.
const withConnection = <A, E>(stateDir: string, work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* StateDir.deleteStaleSnapshots(stateDir)
    const before = yield* existing(walFiles(stateDir))

    return yield* Effect.scoped(
      Effect.flatMap(Database.openHost(stateDir), (sql) => Effect.provideService(work, SqlClient.SqlClient, sql)),
    ).pipe(Effect.ensuring(Effect.orDie(chownCreated(stateDir, before))))
  })

// The audit row of a host Revoke: no credential and no peer, just the Label.
const revokedByHost = (revoked: TokenRevoked) =>
  Effect.flatMap(Audit.now, (at) =>
    Audit.write({
      at,
      actor: { type: "host" },
      action: "token.revoke",
      vaults: [],
      references: [],
      detail: { label: revoked.label },
      result: { outcome: "ok" },
      peer: null,
    }),
  )

// `hush server revoke <label>`: the Revoke and its audit row (actor `host`) in one transaction, then the
// checkpoint that takes the old wraps out of the files. The backoff is the Server's, in its memory, so a
// pinned backoff cannot stop it.
export const revoke = (stateDir: string, label: string): Effect.Effect<TokenRevoked, HostError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.fromResult(parseName("label", label))

    return yield* withConnection(
      stateDir,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const receipt = yield* sql.withTransaction(Effect.tap(Tokens.revokeLabelled(parsed), revokedByHost))
        yield* Database.checkpointCommitted

        return receipt
      }).pipe(Effect.catchTag("SqlError", Effect.die)),
    )
  })

export interface BackupReceipt extends Backup.Digest {
  readonly file: string
}

// `hush server backup <file>` to the absolute `path`: the snapshot is a 0600 temp in the target's
// own directory, linked into place, so a backup disk on another filesystem works; a failed `VACUUM INTO` (disk
// full, say) means nothing was written. No audit row: the host needs no credential.
export const backupToFile = (stateDir: string, path: string): Effect.Effect<BackupReceipt, HostError> =>
  withConnection(
    stateDir,
    Effect.map(
      OutputFile.place(path, (temp) =>
        Backup.vacuumInto(temp).pipe(Effect.mapError((error) => OutputFile.writeFailed(path)(error.reason.cause))),
      ),
      (digest) => ({ file: path, ...digest }),
    ),
  )

// `hush server backup -`: the snapshot is made in the state directory, its bytes alone go to stdout, and it is
// deleted.
export const backupToStdout = (stateDir: string): Effect.Effect<void, HostError> =>
  withConnection(
    stateDir,
    Effect.scoped(
      Effect.flatMap(Backup.snapshot(stateDir), (snapshot) =>
        Effect.promise(() => Bun.write(Bun.stdout, Bun.file(snapshot.path))),
      ),
    ).pipe(Effect.orDie, Effect.asVoid),
  )

export * as Host from "./Host.js"
