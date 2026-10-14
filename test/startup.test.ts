import { assert, describe, it } from "@effect/vitest"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { readFileSync, statSync } from "node:fs"
import { chmod, chown, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { ServerStateWire } from "../src/shared/Api.js"
import { passphraseSentinel, scan, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// Every start that fails for a cause in the state directory: one `hush:` line on stderr, nothing on stdout, exit
// 1; and once the cause is removed, the next start succeeds.

const withSandbox = async (test: (box: Sandbox) => Promise<void>) => {
  const box = await sandbox()

  try {
    await test(box)
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel]), [])
  } finally {
    await box.close()
  }
}

// Root ignores directory modes, so a permission failure cannot be provoked as root.
const asRoot = process.geteuid?.() === 0

// A second Server on the sandbox's state directory, while the sandbox's own is stopped.
const startOnce = (box: Sandbox, stateDir = box.server.stateDir) =>
  box.run(["server", "--state-dir", stateDir, "--port", "0"])

const status = async (box: Sandbox): Promise<ServerStateWire> => {
  const result = await box.run(["status"])
  assert.strictEqual(result.code, 0, result.stderr)

  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ state: ServerStateWire })))(result.stdout).state
}

const databaseOf = (box: Sandbox) => join(box.server.stateDir, "hush.db")

const removeDatabase = async (box: Sandbox) => {
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${databaseOf(box)}${suffix}`, { force: true })
}

const Salt = Schema.Struct({ kdf_salt: Schema.Uint8Array })

interface Planted {
  readonly remove: () => Promise<void>
  // Checks of what the failed start left, before the cause is removed.
  readonly afterFailure?: () => Promise<void>
}

interface FailureCase {
  readonly name: string
  // Why the case cannot run here, if it cannot.
  readonly skip?: string
  // Leaves the sandbox's Server stopped with the cause in place.
  readonly plant: (box: Sandbox) => Promise<Planted>
  readonly line: (box: Sandbox) => string
  // The state the Server reports once the cause is removed.
  readonly recovered: ServerStateWire
}

const cases: ReadonlyArray<FailureCase> = [
  {
    name: "MetaInvalid on a `meta` row whose kdf_salt was altered",
    plant: async (box) => {
      await box.seed()
      await box.server.stop()

      const original = await box.inspect((db) =>
        Schema.decodeUnknownSync(Salt)(db.query("SELECT kdf_salt FROM meta").get()),
      )

      // The CHECK refuses a wrong length, so the edit goes around it, as a hand edit of the file can.
      await box.inspect((db) => {
        db.run("PRAGMA ignore_check_constraints = ON")
        db.run("UPDATE meta SET kdf_salt = x'00'")
      })

      return {
        remove: () => box.inspect((db) => void db.run("UPDATE meta SET kdf_salt = ?", [original.kdf_salt])),
      }
    },
    line: () =>
      `The database's key metadata is invalid (kdf_salt), so it was modified or corrupted; nothing was changed. Restore from a backup (README, "Backup and restore").`,
    recovered: "ready",
  },
  {
    name: "DatabaseOpenFailed on a restored hush.db that is not SQLite",
    plant: async (box) => {
      await box.server.stop()
      await removeDatabase(box)
      await writeFile(databaseOf(box), "this is not a hush backup\n".repeat(40), { mode: 0o600 })

      return { remove: () => removeDatabase(box) }
    },
    line: (box) =>
      `Could not open ${databaseOf(box)} (SQLITE_NOTADB); nothing was changed. If it was just restored, check it is a hush backup and that \`-wal\`/\`-shm\` from the old file were deleted.`,
    recovered: "uninitialised",
  },
  {
    name: "MigrationFailed on a schema the migrator cannot upgrade, leaving the file byte-identical",
    plant: async (box) => {
      await box.server.stop()
      await removeDatabase(box)
      // Already in WAL mode, with the migrator's table and no migration applied, but a `meta` table in the way.
      const db = new Database(databaseOf(box))
      db.run("PRAGMA journal_mode = WAL")
      db.run(
        "CREATE TABLE effect_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)",
      )
      db.run("CREATE TABLE meta (id INTEGER PRIMARY KEY)")
      db.close()
      const before = await readFile(databaseOf(box))

      return {
        remove: () => removeDatabase(box),
        afterFailure: async () => assert.isTrue(before.equals(await readFile(databaseOf(box)))),
      }
    },
    line: () =>
      "Upgrading the database schema to 0001_init failed (table meta already exists); the migration was rolled back and the file is as before. Keep the file, run the previous hush version, and report the message.",
    recovered: "uninitialised",
  },
  {
    name: "StatePermissionFailed when the state directory's parent is not writable",
    skip: asRoot ? "root ignores directory modes" : undefined,
    plant: async (box) => {
      await box.server.stop()
      await rm(box.server.stateDir, { recursive: true })
      await chmod(dirname(box.server.stateDir), 0o500)

      return {
        remove: () => chmod(dirname(box.server.stateDir), 0o700),
        afterFailure: async () => assert.notInclude(await readdir(dirname(box.server.stateDir)), "state"),
      }
    },
    line: (box) =>
      `Could not create ${box.server.stateDir} (EACCES); nothing else was changed. Check the directory's owner and the filesystem (never NFS or a bind mount).`,
    recovered: "uninitialised",
  },
  {
    name: "InitCodeWriteFailed when a directory stands where the Init code file goes",
    plant: async (box) => {
      await box.server.stop()
      const initCode = join(box.server.stateDir, "init-code")
      await rm(initCode)
      await mkdir(join(initCode, "occupied"), { recursive: true })

      return {
        remove: () => rm(initCode, { recursive: true }),
        afterFailure: async () => assert.notInclude(await readdir(box.server.stateDir), "init-code.tmp"),
      }
    },
    line: (box) =>
      `Could not write the Init code file ${join(box.server.stateDir, "init-code")} (EISDIR); nothing else was changed. Check the state directory's owner and free space.`,
    recovered: "uninitialised",
  },
  {
    name: "StateFileNotOwned on a restored hush.db that belongs to another uid",
    skip: asRoot ? undefined : "only root can hand a file to another uid",
    plant: async (box) => {
      await box.server.stop()
      await chown(databaseOf(box), 12345, 12345)

      return { remove: () => chown(databaseOf(box), 0, 0) }
    },
    line: (box) =>
      `${databaseOf(box)} is owned by 12345:12345 but the Server runs as 0:0; nothing was changed. Fix it with the command for your deployment: systemd static user \`sudo chown hush:hush ${databaseOf(box)}\`; DynamicUser \`sudo chown --reference=/var/lib/private/hush ${databaseOf(box)}\`; Docker \`docker run --rm -v hush-data:/data debian:stable-slim chown 10001:10001 /data/hush.db\`.`,
    recovered: "uninitialised",
  },
]

describe("a failed start", () => {
  for (const failure of cases)
    it.skipIf(failure.skip !== undefined)(
      `fails ${failure.name} with one line and exit 1, and starts once the cause is removed${failure.skip === undefined ? "" : ` (skipped: ${failure.skip})`}`,
      () =>
        withSandbox(async (box) => {
          const planted = await failure.plant(box)
          const result = await startOnce(box)
          assert.strictEqual(result.stdout, "")
          assert.strictEqual(result.stderr, `hush: ${failure.line(box)}\n`)
          assert.strictEqual(result.code, 1)
          await planted.afterFailure?.()
          await planted.remove()
          await box.server.restart()
          assert.strictEqual(await status(box), failure.recovered)
        }),
    )
})

// The root of a read-only mount this user owns, where chmod fails with EROFS; most runners have none, and an
// unprivileged runner cannot make one.
const readOnlyOwnedMount = (): string | undefined => {
  const uid = process.geteuid?.()

  return readFileSync("/proc/self/mounts", "utf8")
    .split("\n")
    .flatMap((line) => {
      const [, target, , options] = line.split(" ")

      return target !== undefined && options?.split(",").includes("ro") === true ? [target] : []
    })
    .find((target) => {
      try {
        const stats = statSync(target)

        return stats.isDirectory() && stats.uid === uid
      } catch {
        return false
      }
    })
}

const readOnly = readOnlyOwnedMount()

describe("a state directory on a read-only filesystem", () => {
  it.skipIf(readOnly === undefined)(
    `fails StatePermissionFailed naming the chmod, with exit 1${readOnly === undefined ? " (skipped: no read-only mount owned by this user)" : ""}`,
    () =>
      withSandbox(async (box) => {
        if (readOnly === undefined) throw new Error("ran without a read-only mount; skipIf should have skipped it")
        const stateDir = readOnly
        const before = (await stat(stateDir)).mode
        const result = await startOnce(box, stateDir)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(
          result.stderr,
          `hush: Could not set mode 0700 on ${stateDir} (EROFS); nothing else was changed. Check the directory's owner and the filesystem (never NFS or a bind mount).\n`,
        )
        assert.strictEqual(result.code, 1)
        assert.strictEqual((await stat(stateDir)).mode, before)
      }),
  )
})
