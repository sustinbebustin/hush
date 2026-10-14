import { assert, describe, it } from "@effect/vitest"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { chmod, copyFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// Backups and the host commands through the seam: `hush backup` over the raw route, `hush server backup` and
// `hush server revoke` over their own connection beside the running Server, and restores of what they wrote.

const value = valueSentinel.text

// Runs `test`, then asserts that no sentinel reached anything observable, every backup and snapshot included.
const withSandbox = async (test: (box: Sandbox, seen: (sentinel: Sentinel) => void) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, passphraseSentinel]

  try {
    await test(box, (sentinel) => sentinels.push(sentinel))
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

// `seed`, with its Token and the Init code it used registered as sentinels.
const seeded = async (box: Sandbox, seen: (sentinel: Sentinel) => void, spec?: Parameters<Sandbox["seed"]>[0]) => {
  const code = await box.server.initCode()

  if (code !== undefined) seen({ kind: "initCode", text: code })
  const result = await box.seed(spec)
  seen({ kind: "token", text: result.token })

  return result
}

const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8)

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex")

const tables = ["meta", "vaults", "items", "fields", "tokens", "token_vaults", "retired_titles", "audit"] as const

const Count = Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Number }))

// The schema and the row count of every table, read from `path` alone.
const shape = (path: string) => {
  const db = new Database(path, { readonly: true })

  try {
    const schema = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()

    const counts = Object.fromEntries(
      tables.map((table) => [table, Count(db.query(`SELECT count(*) AS n FROM ${table}`).get()).n]),
    )

    return { schema, counts }
  } finally {
    db.close()
  }
}

const hostBackup = (box: Sandbox, target: string) =>
  box.run(["server", "backup", "--state-dir", box.server.stateDir, target])

// `hush backup <file>` with the Passphrase piped.
const backup = (box: Sandbox, target: string, options: { readonly env?: Record<string, string> } = {}) =>
  box.run(["backup", target, "--passphrase-stdin"], { input: `${passphraseSentinel.text}\n`, ...options })

const lastAudit = async (box: Sandbox) =>
  (
    await box.inspect((db) =>
      db
        .query("SELECT actor, token_label, action, vaults, refs, detail, outcome, error FROM audit ORDER BY id DESC")
        .all(),
    )
  )[0]

describe("hush backup <file>", () => {
  it("streams a snapshot from the Server into a new 0600 file with the live schema and row counts", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const target = join(box.backupDir, "hush.db")
      const result = await backup(box, target)
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, [{ method: "POST", path: "/v1/admin/backup", status: 200 }])
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        file: target,
        bytes: (await stat(target)).size,
        sha256: await sha256(target),
      })
      assert.strictEqual(await mode(target), "600")
      assert.deepStrictEqual(await readdir(box.backupDir), ["hush.db"])
      assert.deepStrictEqual(await snapshots(box), [])
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "passphrase",
        token_label: null,
        action: "backup",
        vaults: "[]",
        refs: "[]",
        detail: null,
        outcome: "ok",
        error: null,
      })
      // The snapshot was taken before its own audit row was written.
      const live = shape(join(box.server.stateDir, "hush.db"))
      assert.deepStrictEqual(shape(target), {
        ...live,
        counts: { ...live.counts, audit: (live.counts.audit ?? 0) - 1 },
      })
    }))
})

describe("hush backup refusals", () => {
  it("fails BackupCorrupt with exit 1 when the stream differs from its SHA-256, writing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await files(box)
      box.proxy.mode("corrupt-response")
      const result = await backup(box, join(box.backupDir, "hush.db"), { env: { HUSH_SERVER: box.proxy.url } })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: The backup stream did not match its size or SHA-256; nothing was written. Run `hush backup` again.\n",
      )
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/admin/backup HTTP/1.1"])
      assert.deepStrictEqual(await snapshots(box), [])
      const after = await files(box)
      // The Server took and audited the snapshot; only its audit row was added.
      assert.deepStrictEqual({ ...after, rows: after.rows.slice(0, -1) }, { ...before, rows: before.rows.slice(0, -1) })
    }))

  it("fails OutputExists with exit 1 before asking for the Passphrase, sending nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const target = join(box.backupDir, "taken.db")
      await Bun.write(target, "an older file")
      const before = await files(box)
      // No `--passphrase-stdin` and no terminal: a prompt would have failed `NoTerminal`.
      const result = await box.run(["backup", target])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        `hush: ${target} already exists; nothing was written. Choose a new file name; a backup never overwrites a file.\n`,
      )
      assert.deepStrictEqual(result.calls, [])
      assert.deepStrictEqual(await files(box), before)
    }))

  it("fails PassphraseIncorrect with exit 1 for a wrong Passphrase, taking no snapshot", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await box.run(["backup", join(box.backupDir, "hush.db"), "--passphrase-stdin"], {
        input: "not the passphrase\n",
      })

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: The Passphrase is incorrect; nothing was changed. You can try again now; repeated failures slow every Passphrase operation on this Server.\n",
      )
      assert.deepStrictEqual(result.calls, [{ method: "POST", path: "/v1/admin/backup", status: 401 }])
      assert.deepStrictEqual(await readdir(box.backupDir), [])
      assert.deepStrictEqual(await snapshots(box), [])
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "passphrase",
        token_label: null,
        action: "backup",
        vaults: "[]",
        refs: "[]",
        detail: null,
        outcome: "denied",
        error: "PassphraseIncorrect",
      })
    }))
})

describe("hush server backup <file>", () => {
  it("writes a 0600 snapshot beside the running Server with the live schema and row counts", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const target = join(box.backupDir, "hush.db")
      const audit = await rows(box, "SELECT * FROM audit")
      const result = await hostBackup(box, target)
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, [])
      assert.deepStrictEqual(await rows(box, "SELECT * FROM audit"), audit)
      const receipt = JSON.parse(result.stdout)
      assert.deepStrictEqual(receipt, {
        file: target,
        bytes: (await stat(target)).size,
        sha256: await sha256(target),
      })
      assert.strictEqual(await mode(target), "600")
      // The file alone holds every row: it is a snapshot, not a copy of a database whose rows sit in a WAL.
      assert.deepStrictEqual(await readdir(box.backupDir), ["hush.db"])
      assert.deepStrictEqual(shape(target), shape(join(box.server.stateDir, "hush.db")))
    }))
})

// The snapshots left in the state directory.
const snapshots = async (box: Sandbox) =>
  (await readdir(box.server.stateDir)).filter((name) => name.startsWith("backup-"))

describe("hush server backup -", () => {
  it("writes the database bytes and nothing else to stdout, and leaves no snapshot behind", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const result = await hostBackup(box, "-")
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stderr, "")
      const written = join(box.backupDir, "from-stdout.db")
      await Bun.write(written, result.stdoutBytes)
      assert.deepStrictEqual(shape(written), shape(join(box.server.stateDir, "hush.db")))
      assert.deepStrictEqual(await snapshots(box), [])
    }))
})

const WrongPassphraseAnswer = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.TaggedStruct("PassphraseIncorrect", { retryAfterSeconds: Schema.Number }),
    Schema.TaggedStruct("BackoffActive", { retryAfterSeconds: Schema.Number }),
  ]),
)

const wrongPassphrase = async (box: Sandbox) => {
  const response = await box.fetch("/v1/admin/vaults/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "wrong passphrase guess" }),
  })

  return WrongPassphraseAnswer(await response.json())
}

const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

// Sends wrong Passphrases, as anyone who reaches the Server can, each once the previous delay ran
// out, until one pins the backoff for at least `seconds`: long enough that it cannot expire under a loaded suite.
const pinBackoff = async (box: Sandbox, seconds: number) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const answer = await wrongPassphrase(box)

    if (answer._tag === "PassphraseIncorrect" && answer.retryAfterSeconds >= seconds) return

    if (answer._tag === "BackoffActive") await wait(answer.retryAfterSeconds)
  }

  throw new Error(`the backoff did not pin for ${seconds} s after 20 wrong Passphrases`)
}

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())

const hostRevoke = (box: Sandbox, label: string) =>
  box.run(["server", "revoke", "--state-dir", box.server.stateDir, label])

describe("hush server revoke", () => {
  it("revokes a Token while the Passphrase backoff is pinned, audited as the host", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      await pinBackoff(box, 16)

      const refused = await box.run(["token", "revoke", first.label, "--passphrase-stdin"], {
        input: `${passphraseSentinel.text}\n`,
      })

      assert.strictEqual(refused.code, 1)
      assert.include(refused.stderr, "Too many incorrect Passphrase attempts")

      const result = await hostRevoke(box, first.label)
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, [])
      // Still pinned after the host revoke, so the backoff was active throughout.
      assert.strictEqual((await wrongPassphrase(box))._tag, "BackoffActive")
      const receipt = JSON.parse(result.stdout)
      assert.deepStrictEqual(receipt, { label: first.label, revoked: true, revokedAt: receipt.revokedAt })
      assert.deepStrictEqual(await rows(box, "SELECT revoked_at FROM tokens"), [{ revoked_at: receipt.revokedAt }])
      assert.deepStrictEqual(await rows(box, "SELECT key_wrapped FROM token_vaults"), [{ key_wrapped: null }])
      assert.deepStrictEqual(
        await rows(
          box,
          "SELECT actor, token_label, action, vaults, refs, detail, outcome, error, peer FROM audit ORDER BY id DESC LIMIT 1",
        ),
        [
          {
            actor: "host",
            token_label: null,
            action: "token.revoke",
            vaults: "[]",
            refs: "[]",
            detail: JSON.stringify({ label: first.label }),
            outcome: "ok",
            error: null,
            peer: null,
          },
        ],
      )
      const read = await box.run(["read", first.references[0] ?? ""], { env: { HUSH_TOKEN: first.token } })
      assert.strictEqual(read.code, 1)
      assert.include(read.stderr, `Token ${first.label} was revoked at ${receipt.revokedAt}`)
    }))

  it("fails TokenNotFound with exit 1 for a Label with no unrevoked Token, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const before = {
        tokens: await rows(box, "SELECT * FROM tokens"),
        audit: await rows(box, "SELECT * FROM audit"),
      }

      const result = await hostRevoke(box, "nobody")
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: No unrevoked Token is labelled nobody; nothing was revoked or issued. `hush token list` shows Tokens.\n",
      )
      assert.deepStrictEqual(
        { tokens: await rows(box, "SELECT * FROM tokens"), audit: await rows(box, "SELECT * FROM audit") },
        before,
      )
    }))
})

// What a refused command must leave as it was: every row, the state directory's file names (the WAL index changes
// on any read beside a running Server) and every file in the backup directory, raw.
const files = async (box: Sandbox) => {
  const backups: Record<string, Buffer> = {}

  for (const name of await readdir(box.backupDir)) backups[name] = await readFile(join(box.backupDir, name))

  return {
    rows: await box.inspect((db) => tables.map((table) => db.query(`SELECT * FROM ${table}`).all())),
    stateDir: (await readdir(box.server.stateDir)).toSorted(),
    backups,
  }
}

describe("host command refusals", () => {
  it("fail MigrationPending with exit 1 on a database whose migrations are behind the binary, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await box.server.stop()
      await box.inspect((db) => db.run("DELETE FROM effect_sql_migrations"))
      const before = await files(box)

      for (const args of [
        ["revoke", "agent on box"],
        ["backup", join(box.backupDir, "hush.db")],
        ["backup", "-"],
      ]) {
        const result = await box.run(["server", ...args, "--state-dir", box.server.stateDir])
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(
          result.stderr,
          "hush: The database schema is older than this hush binary; nothing was changed. Start the Server once (it migrates), then run the command again.\n",
        )
      }

      assert.deepStrictEqual(await files(box), before)
    }))

  it("fail OutputExists with exit 1 when the target exists, leaving it as it was", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const target = join(box.backupDir, "taken.db")
      await Bun.write(target, "an older file")
      const before = await files(box)
      const result = await hostBackup(box, target)
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        `hush: ${target} already exists; nothing was written. Choose a new file name; a backup never overwrites a file.\n`,
      )
      assert.deepStrictEqual(await files(box), before)
    }))

  it("fail FileWriteFailed with exit 1 when the target's directory does not exist, writing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const target = join(box.backupDir, "missing", "hush.db")
      const before = await files(box)
      const result = await hostBackup(box, target)
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        `hush: Could not write ${target} (ENOENT); nothing was written. Check that its directory exists and is writable, and its free space.\n`,
      )
      assert.deepStrictEqual(await files(box), before)
    }))
})

// A fresh Server whose database is `backup`, put in place as README's Backup and restore section says: stopped, the
// file installed 0600 with no old `-wal`/`-shm` beside it, started again. The caller closes it after `check`ing it.
const restore = async (backupFile: string) => {
  const box = await sandbox()
  await box.server.stop()

  for (const name of await readdir(box.server.stateDir)) await rm(join(box.server.stateDir, name))
  await copyFile(backupFile, join(box.server.stateDir, "hush.db"))
  await chmod(join(box.server.stateDir, "hush.db"), 0o600)
  await box.server.restart()

  return box
}

// Asserts no sentinel reached anything the restored Server made observable, then closes it.
const check = async (box: Sandbox, sentinels: ReadonlyArray<Sentinel>) => {
  try {
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

const VaultNames = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ vaults: Schema.Array(Schema.Struct({ vault: Schema.String })) })),
)

describe("restore", () => {
  it("opens a backup taken before a Passphrase change with the old Passphrase on a fresh state directory", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const file = join(box.backupDir, "before-change.db")
      assert.strictEqual((await backup(box, file)).code, 0)
      const changed = "a fictional new passphrase 9Kz"
      seen({ kind: "passphrase", text: changed })

      const change = await box.run(["passphrase", "change", "--passphrase-stdin"], {
        input: `${passphraseSentinel.text}\n${changed}\n`,
      })

      assert.strictEqual(change.code, 0, change.stderr)

      const copy = await restore(file)
      const listWith = (secret: string) => copy.run(["vault", "list", "--passphrase-stdin"], { input: `${secret}\n` })
      const old = await listWith(passphraseSentinel.text)
      assert.strictEqual(old.code, 0, old.stderr)
      assert.deepStrictEqual(
        VaultNames(old.stdout).vaults.map(({ vault }) => vault),
        ["Personal"],
      )
      const current = await listWith(changed)
      assert.strictEqual(current.code, 1)
      assert.include(current.stderr, "The Passphrase is incorrect")
      await check(copy, [valueSentinel, passphraseSentinel, { kind: "passphrase", text: changed }])
    }))

  it("resolves a Token live at backup time against the restored copy, even after its Revoke on the live Server", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const file = join(box.backupDir, "before-revoke.db")
      assert.strictEqual((await hostBackup(box, file)).code, 0)
      assert.strictEqual((await hostRevoke(box, first.label)).code, 0)
      const reference = first.references[0] ?? ""
      const live = await box.run(["read", reference], { env: { HUSH_TOKEN: first.token } })
      assert.strictEqual(live.code, 1)

      // Known caveat (docs/adr/0002): a backup opens with any Token that was live when it was taken.
      const copy = await restore(file)
      const restored = await copy.run(["read", reference], { env: { HUSH_TOKEN: first.token }, secretStdout: true })
      assert.strictEqual(restored.code, 0, restored.stderr)
      assert.strictEqual(restored.stdout, value)
      await check(copy, [valueSentinel, passphraseSentinel, { kind: "token", text: first.token }])
    }))
})

// A directory on another filesystem than the backup directory's, where the runner has one.
const otherFilesystem = (() => {
  const shm = "/dev/shm"

  if (!existsSync(shm)) return undefined

  return statSync(shm).dev === statSync(tmpdir()).dev ? undefined : shm
})()

describe("hush server backup to another filesystem (skipped where /dev/shm is absent or on the temp dir's filesystem)", () => {
  it.skipIf(otherFilesystem === undefined)(
    "writes a backup to /dev/shm, a filesystem other than the state directory's",
    () =>
      withSandbox(async (box, seen) => {
        await seeded(box, seen)
        const directory = await mkdtemp(join(otherFilesystem ?? "", "hush-backup-"))

        try {
          const target = join(directory, "hush.db")
          const result = await hostBackup(box, target)
          assert.strictEqual(result.code, 0, result.stderr)
          assert.strictEqual(JSON.parse(result.stdout).file, target)
          assert.strictEqual(await mode(target), "600")
          assert.deepStrictEqual(await readdir(directory), ["hush.db"])
          assert.deepStrictEqual(shape(target), shape(join(box.server.stateDir, "hush.db")))
          // Into the backup directory, so the leak scan reads it.
          await copyFile(target, join(box.backupDir, "from-other-filesystem.db"))
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }),
  )
})

describe("host commands and stale snapshots", () => {
  it("leave no state file holding a revoked Token's wrap, a stale snapshot taken before the Revoke included", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen)
      const killed = join(box.backupDir, "killed.db")
      assert.strictEqual((await hostBackup(box, killed)).code, 0)
      // What an API backup killed mid-stream leaves in the state directory.
      await copyFile(killed, join(box.server.stateDir, "backup-killed.db"))

      const [wrap] = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ key_wrapped: Schema.Uint8Array })))(
        await rows(box, "SELECT key_wrapped FROM token_vaults"),
      )

      if (wrap === undefined) throw new Error("the seeded Token has no wrap")

      const holding = async () => {
        const held: Array<string> = []

        for (const name of await readdir(box.server.stateDir))
          if ((await readFile(join(box.server.stateDir, name))).includes(Buffer.from(wrap.key_wrapped))) held.push(name)

        return held.toSorted()
      }

      assert.include(await holding(), "backup-killed.db")
      assert.strictEqual((await hostRevoke(box, first.label)).code, 0)
      assert.deepStrictEqual(await holding(), [])
    }))

  it("delete every stale snapshot in the state directory first, logging each", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const stale = join(box.server.stateDir, "backup-stale.db")
      await Bun.write(stale, value)
      const result = await hostBackup(box, join(box.backupDir, "hush.db"))
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stderr, `${JSON.stringify({ event: "stale-snapshot-deleted", path: stale })}\n`)
      assert.deepStrictEqual(await snapshots(box), [])
    }))
})
