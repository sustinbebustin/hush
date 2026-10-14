import { Effect, Result } from "effect"
import { chmod, mkdir, open, readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

import { PlatformCause } from "../shared/PlatformCause.js"
import { Log } from "./Log.js"
import { type Owner, StateFileNotOwned, StatePermissionFailed } from "./StartupError.js"

// The state directory and the modes of its files.

export const databaseFile = "hush.db"
const databaseFiles = [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`] as const

export const databasePath = (stateDir: string) => join(stateDir, databaseFile)

export interface OwnedPath {
  readonly path: string
  readonly owner: Owner
}

// Every existing state path must belong to the Server's effective uid before it is chmod-ed: a
// root-owned file restored by hand otherwise fails later with a bare EPERM.
export const check = (input: {
  readonly stateDir: string
  readonly paths: ReadonlyArray<OwnedPath>
  readonly server: Owner
}): Result.Result<void, StateFileNotOwned> => {
  const foreign = input.paths.find(({ owner }) => owner.uid !== input.server.uid)
  return foreign === undefined
    ? Result.void
    : Result.fail(new StateFileNotOwned({ stateDir: input.stateDir, ...foreign, server: input.server }))
}

const attempt = <A>(
  operation: StatePermissionFailed["operation"],
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, StatePermissionFailed> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new StatePermissionFailed({ operation, path, code: PlatformCause.codeOrUnknown(cause) }),
  })

// The owner of `path`, or undefined when it does not exist.
const ownerIfPresent = (path: string): Effect.Effect<OwnedPath | undefined, StatePermissionFailed> =>
  Effect.tryPromise({
    try: () => stat(path).then(({ uid, gid }): OwnedPath => ({ path, owner: { uid, gid } })),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      PlatformCause.code(cause) === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(new StatePermissionFailed({ operation: "read", path, code: PlatformCause.codeOrUnknown(cause) })),
    ),
  )

const identity = Effect.suspend(() => {
  const uid = process.geteuid?.()
  const gid = process.getegid?.()
  return uid === undefined || gid === undefined
    ? Effect.die(new Error("hush server runs on POSIX only: process.geteuid is unavailable"))
    : Effect.succeed<Owner>({ uid, gid })
})

// The name of a backup snapshot in the state directory; `suffix` is random.
export const snapshotName = (suffix: string) => `backup-${suffix}.db`

// A snapshot left by a killed backup: with a later-revoked Token it would still open current values.
const isSnapshot = (name: string) => name.startsWith("backup-") && name.endsWith(".db")

// Deletes every snapshot in the state directory, logging each: at every start and every host command.
export const deleteStaleSnapshots = (stateDir: string): Effect.Effect<void, StatePermissionFailed> =>
  Effect.gen(function* () {
    const names = yield* attempt("read", stateDir, () => readdir(stateDir))
    for (const name of names.filter(isSnapshot)) {
      const path = join(stateDir, name)
      yield* attempt("delete", path, () => unlink(path))
      yield* Log.write({ event: "stale-snapshot-deleted", path })
    }
  })

// Creates a missing directory 0700, or checks ownership and chmods an existing one; deletes stale snapshots;
// creates a missing database empty with mode 0600 by exclusive create (so `-wal` and `-shm` inherit it), or
// chmods the database files that exist.
export const prepare = (stateDir: string): Effect.Effect<void, StateFileNotOwned | StatePermissionFailed> =>
  Effect.gen(function* () {
    const server = yield* identity
    const directory = yield* ownerIfPresent(stateDir)
    if (directory === undefined) {
      yield* attempt("create", stateDir, () => mkdir(stateDir, { mode: 0o700 }))
    } else {
      const files = yield* Effect.forEach(databaseFiles, (name) => ownerIfPresent(join(stateDir, name)))
      const present = files.filter((file) => file !== undefined)
      yield* Effect.fromResult(check({ stateDir, paths: [directory, ...present], server }))
    }
    // chmod even after mkdir: the umask may have narrowed or the parent's default ACL widened the mode.
    yield* attempt("chmod-0700", stateDir, () => chmod(stateDir, 0o700))
    yield* deleteStaleSnapshots(stateDir)
    const database = databasePath(stateDir)
    const created = yield* Effect.tryPromise({
      try: () => open(database, "wx", 0o600).then((handle) => handle.close().then(() => true)),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        PlatformCause.code(cause) === "EEXIST"
          ? Effect.succeed(false)
          : Effect.fail(
              new StatePermissionFailed({
                operation: "create",
                path: database,
                code: PlatformCause.codeOrUnknown(cause),
              }),
            ),
      ),
    )
    for (const name of created ? [databaseFile] : databaseFiles) {
      const path = join(stateDir, name)
      if ((yield* ownerIfPresent(path)) !== undefined) yield* attempt("chmod-0600", path, () => chmod(path, 0o600))
    }
  })

export * as StateDir from "./StateDir.js"
