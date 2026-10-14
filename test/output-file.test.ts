import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Host } from "../src/server/Host.js"
import { OutputFile } from "../src/shared/OutputFile.js"

// The file step both backup forms share, and which `-wal`/`-shm` a host command hands back to the database's owner.

const withDirectory = <A, E>(f: (directory: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "hush-output-"))),
    f,
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )

describe("OutputFile.createPrivate", () => {
  it.effect("creates the file 0600 even under a umask that would allow everyone", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const previous = process.umask(0)
        const path = yield* OutputFile.createPrivate(directory, (suffix) => `backup-${suffix}.db`).pipe(
          Effect.ensuring(Effect.sync(() => process.umask(previous))),
        )
        assert.strictEqual(((yield* Effect.promise(() => stat(path))).mode & 0o777).toString(8), "600")
        assert.match(path, /backup-[0-9a-f]{16}\.db$/)
      }),
    ),
  )
})

describe("OutputFile.place", () => {
  it.effect("leaves neither the target nor the temp file when the write fails", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const failed = yield* OutputFile.place(join(directory, "out.db"), () => Effect.fail("write failed")).pipe(
          Effect.flip,
        )
        assert.strictEqual(failed, "write failed")
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(directory)), [])
      }),
    ),
  )
})

describe("Host.walFilesToHandBack", () => {
  const wal = "/var/lib/hush/hush.db-wal"
  const shm = "/var/lib/hush/hush.db-shm"

  it("hands back only the files the command created, when run as root", () => {
    assert.deepStrictEqual(Host.walFilesToHandBack({ euid: 0, before: [], after: [wal, shm] }), [wal, shm])
    assert.deepStrictEqual(Host.walFilesToHandBack({ euid: 0, before: [wal, shm], after: [wal, shm] }), [])
    assert.deepStrictEqual(Host.walFilesToHandBack({ euid: 0, before: [shm], after: [wal, shm] }), [wal])
  })

  it("hands back nothing when run as the owner, whose files are already its own", () => {
    assert.deepStrictEqual(Host.walFilesToHandBack({ euid: 1000, before: [], after: [wal, shm] }), [])
  })
})
