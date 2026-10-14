import { assert, describe, it } from "@effect/vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { onPty, sandbox, type Sandbox, type Seeded } from "./sandbox.js"

// The Owner's Passphrase operations through the seam: `vault create|list|delete`, `passphrase change`, the
// backoff and the Audit Log rows they write.

const passphrase = passphraseSentinel.text
const newPassphrase = "another fictional passphrase 9Kd"
const newPassphraseSentinel: Sentinel = { kind: "passphrase", text: newPassphrase }

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in.
const withSandbox = async (test: (box: Sandbox, seen: (sentinel: Sentinel) => void) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, passphraseSentinel, newPassphraseSentinel]

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

// One Item in the first Vault, so `Personal` is never empty.
const withItem = (box: Sandbox, seen: (sentinel: Sentinel) => void) =>
  seeded(box, seen, { items: [{ kind: "api-credential", title: "Stripe", value: valueSentinel.text }] })

const call = (path: string, status: number) => ({ method: "POST", path, status })
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// A Passphrase command with `lines` piped to `--passphrase-stdin`, the Passphrase alone by default.
const admin = (box: Sandbox, args: ReadonlyArray<string>, lines: ReadonlyArray<string> = [passphrase]) =>
  box.run([...args, "--passphrase-stdin"], { input: lines.map((line) => `${line}\n`).join("") })

// A raw JSON POST, as a client that is not the CLI would send it.
const post = (box: Sandbox, path: string, body: unknown) =>
  box.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())

const auditRows = (box: Sandbox) =>
  rows(box, "SELECT actor, token_id, action, vaults, refs, detail, outcome, error FROM audit ORDER BY id")

// Everything a refused Passphrase command must leave as it was; the Audit Log is checked separately, since an
// evaluated refusal adds its row.
const state = async (box: Sandbox) => ({
  meta: await rows(box, "SELECT * FROM meta"),
  vaults: await rows(box, "SELECT * FROM vaults"),
  items: await rows(box, "SELECT id FROM items"),
  tokenVaults: await rows(box, "SELECT * FROM token_vaults"),
})

const passphraseRow = (action: string, vaults: ReadonlyArray<string>, outcome: string, error: string | null) => ({
  actor: "passphrase",
  token_id: null,
  action,
  vaults: JSON.stringify(vaults),
  refs: "[]",
  detail: null,
  outcome,
  error,
})

const incorrectNow =
  "hush: The Passphrase is incorrect; nothing was changed. You can try again now; repeated failures slow every Passphrase operation on this Server.\n"

const listed = (stdout: string) =>
  (JSON.parse(stdout).vaults as ReadonlyArray<{ vault: string; items: number; activeTokens: number }>).map(
    ({ vault, items, activeTokens }) => ({ vault, items, activeTokens }),
  )

describe("hush vault create and vault list", () => {
  it("creates a Vault and lists every Vault by name with its Item count, active Tokens and creation time", () =>
    withSandbox(async (box, seen) => {
      await withItem(box, seen)
      const created = await admin(box, ["vault", "create", "Work"])
      assert.strictEqual(created.code, 0, created.stderr)
      const receipt = JSON.parse(created.stdout)
      assert.deepStrictEqual(Object.keys(receipt), ["vault", "createdAt"])
      assert.strictEqual(receipt.vault, "Work")
      assert.match(receipt.createdAt, isoTime)
      assert.deepStrictEqual(created.calls, [call("/v1/admin/vaults/create", 200)])

      const result = await admin(box, ["vault", "list"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(listed(result.stdout), [
        { vault: "Personal", items: 1, activeTokens: 1 },
        { vault: "Work", items: 0, activeTokens: 0 },
      ])

      for (const { createdAt } of JSON.parse(result.stdout).vaults) assert.match(createdAt, isoTime)
      assert.deepStrictEqual(result.calls, [call("/v1/admin/vaults/list", 200)])
    }))

  it("sorts Vaults by name, case aside", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { vault: "beta" })

      for (const name of ["Alpha", "gamma"]) assert.strictEqual((await admin(box, ["vault", "create", name])).code, 0)
      const result = await admin(box, ["vault", "list"])
      assert.deepStrictEqual(
        listed(result.stdout).map(({ vault }) => vault),
        ["Alpha", "beta", "gamma"],
      )
    }))

  it("widens no existing Token: the Init Token is not granted the new Vault", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      assert.strictEqual((await admin(box, ["vault", "create", "Work"])).code, 0)
      const result = await box.run(["read", "hush://Work/Anything/credential"])
      assert.strictEqual(result.code, 1)
      assert.include(result.stderr, "is not granted Vault Work")
    }))

  it("refuses a case variant of a taken name with VaultExists, audited error, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await state(box)
      const result = await admin(box, ["vault", "create", "PERSONAL"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(result.stderr, "hush: A Vault named PERSONAL already exists; nothing was changed.\n")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/vaults/create", 409)])
      assert.deepStrictEqual(await state(box), before)
      assert.deepStrictEqual(
        (await auditRows(box)).at(-1),
        passphraseRow("vault.create", ["PERSONAL"], "error", "VaultExists"),
      )
    }))

  it("refuses an invalid name with InvalidName at the CLI before reading the Passphrase or sending anything", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await state(box)
      const result = await box.run(["vault", "create", "a/b"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: vault is not a valid name (slash); nothing was changed. Names are 1-128 characters without `/` or control characters, not starting with `-` or with a space at either end.\n",
      )
      assert.deepStrictEqual(result.calls, [])
      assert.deepStrictEqual(await state(box), before)
    }))

  it("refuses an invalid name at the Server too, with InvalidName after the Passphrase check, audited error", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await state(box)
      const response = await post(box, "/v1/admin/vaults/create", { passphrase, vault: " Work" })
      assert.strictEqual(response.status, 400)
      assert.deepStrictEqual(await response.json(), {
        _tag: "InvalidName",
        what: "vault",
        reason: "whitespace-edge",
      })
      assert.deepStrictEqual(await state(box), before)
      assert.deepStrictEqual((await auditRows(box)).at(-1), passphraseRow("vault.create", [], "error", "InvalidName"))
    }))
})

describe("hush vault delete", () => {
  it("refuses a Vault with Items or an unrevoked Token's Grant with VaultNotEmpty and the counts, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await withItem(box, seen)
      const before = await state(box)
      const result = await admin(box, ["vault", "delete", "personal"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: Vault Personal still has 1 Item and 1 unrevoked Token granted to it; nothing was deleted. Delete its Items and Revoke those Tokens first.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/vaults/delete", 409)])
      assert.deepStrictEqual(await state(box), before)
      assert.deepStrictEqual(
        (await auditRows(box)).at(-1),
        passphraseRow("vault.delete", ["personal"], "error", "VaultNotEmpty"),
      )
    }))

  it("refuses a missing Vault with VaultNotFound, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await state(box)
      const result = await admin(box, ["vault", "delete", "Nowhere"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: Vault Nowhere does not exist on this Server; nothing was changed. `hush vault list` shows the Vaults.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/vaults/delete", 404)])
      assert.deepStrictEqual(await state(box), before)
    }))

  it("deletes an empty Vault, and its Vault key wrap leaves hush.db and the WAL", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      assert.strictEqual((await admin(box, ["vault", "create", "Work"])).code, 0)

      const wrap = await box.inspect((db) => {
        const row = db.query("SELECT key_wrapped FROM vaults WHERE name = 'Work'").get()

        if (
          typeof row !== "object" ||
          row === null ||
          !("key_wrapped" in row) ||
          !(row.key_wrapped instanceof Uint8Array)
        )
          throw new Error("no wrap for Work")

        return Buffer.from(row.key_wrapped)
      })

      const result = await admin(box, ["vault", "delete", "work"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, json({ deleted: true, vault: "Work" }))
      assert.deepStrictEqual(result.calls, [call("/v1/admin/vaults/delete", 200)])
      assert.deepStrictEqual(await stateFilesHolding(box, wrap), [])
      assert.deepStrictEqual(listed((await admin(box, ["vault", "list"])).stdout), [
        { vault: "Personal", items: 0, activeTokens: 1 },
      ])
    }))
})

// The database files that hold `bytes`, read raw.
const stateFilesHolding = async (box: Sandbox, bytes: Buffer) => {
  const holding: Array<string> = []

  for (const name of ["hush.db", "hush.db-wal"]) {
    const content = await readFile(join(box.server.stateDir, name)).catch(() => Buffer.alloc(0))

    if (content.includes(bytes)) holding.push(name)
  }

  return holding
}

const mkWrapped = (box: Sandbox) =>
  box.inspect((db) => {
    const row = db.query("SELECT mk_wrapped FROM meta").get()

    if (typeof row !== "object" || row === null || !("mk_wrapped" in row) || !(row.mk_wrapped instanceof Uint8Array))
      throw new Error("no meta row")

    return Buffer.from(row.mk_wrapped)
  })

describe("hush passphrase change", () => {
  it("rewraps the master key under the new Passphrase: the old one is refused, the new one works and the Init Token still reads", () =>
    withSandbox(async (box, seen) => {
      const seed: Seeded = await withItem(box, seen)
      const oldWrap = await mkWrapped(box)
      const vaultsBefore = await rows(box, "SELECT * FROM vaults")
      const grantsBefore = await rows(box, "SELECT * FROM token_vaults")
      const fieldsBefore = await rows(box, "SELECT * FROM fields")

      const result = await admin(box, ["passphrase", "change"], [passphrase, newPassphrase])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, json({ changed: true }))
      assert.deepStrictEqual(result.calls, [call("/v1/admin/passphrase/change", 200)])
      // The old wrap must be in neither hush.db nor hush.db-wal.
      assert.deepStrictEqual(await stateFilesHolding(box, oldWrap), [])
      // Vault keys, Token wraps and Fields are untouched.
      assert.deepStrictEqual(await rows(box, "SELECT * FROM vaults"), vaultsBefore)
      assert.deepStrictEqual(await rows(box, "SELECT * FROM token_vaults"), grantsBefore)
      assert.deepStrictEqual(await rows(box, "SELECT * FROM fields"), fieldsBefore)
      const meta = await rows(box, "SELECT kdf_memory_kib, kdf_passes, kdf_parallelism FROM meta")
      assert.deepStrictEqual(meta, [{ kdf_memory_kib: 65536, kdf_passes: 3, kdf_parallelism: 4 }])

      const old = await admin(box, ["vault", "list"])
      assert.strictEqual(old.code, 1)
      assert.strictEqual(old.stderr, incorrectNow)
      assert.strictEqual((await admin(box, ["vault", "list"], [newPassphrase])).code, 0)
      const read = await box.run(["read", seed.references[0] ?? ""], { secretStdout: true })
      assert.strictEqual(read.code, 0, read.stderr)
      assert.strictEqual(read.stdout, valueSentinel.text)
    }))

  it("refuses a wrong current Passphrase with PassphraseIncorrect, audited denied, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await state(box)
      const result = await admin(box, ["passphrase", "change"], [`${passphrase}x`, newPassphrase])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(result.stderr, incorrectNow)
      assert.deepStrictEqual(result.calls, [call("/v1/admin/passphrase/change", 401)])
      assert.deepStrictEqual(await state(box), before)
      assert.deepStrictEqual(
        (await auditRows(box)).at(-1),
        passphraseRow("passphrase.change", [], "denied", "PassphraseIncorrect"),
      )
    }))

  it("refuses a new Passphrase under the policy at the CLI, before any request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await state(box)
      const result = await admin(box, ["passphrase", "change"], [passphrase, "short pass"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: The new Passphrase is too short (at least 12 characters); nothing was changed. Choose another.\n",
      )
      assert.deepStrictEqual(result.calls, [])
      assert.deepStrictEqual(await state(box), before)
    }))

  it("refuses a new Passphrase under the policy at the Server after checking the current one, audited error", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await state(box)

      const wrong = await post(box, "/v1/admin/passphrase/change", {
        passphrase: `${passphrase}x`,
        newPassphrase: "short pass",
      })

      assert.strictEqual(wrong.status, 401)
      assert.deepStrictEqual(await wrong.json(), { _tag: "PassphraseIncorrect", retryAfterSeconds: 0 })
      const response = await post(box, "/v1/admin/passphrase/change", { passphrase, newPassphrase: "short pass" })
      assert.strictEqual(response.status, 400)
      assert.deepStrictEqual(await response.json(), { _tag: "PassphraseInvalid", reason: "too-short" })
      assert.deepStrictEqual(await state(box), before)
      assert.deepStrictEqual((await auditRows(box)).slice(-2), [
        passphraseRow("passphrase.change", [], "denied", "PassphraseIncorrect"),
        passphraseRow("passphrase.change", [], "error", "PassphraseInvalid"),
      ])
    }))

  it("refuses a framing without the new Passphrase with StdinFramingInvalid, before any request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await admin(box, ["passphrase", "change"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: stdin did not contain the current Passphrase, then the new Passphrase, one per line and nothing after; nothing was changed. See `hush passphrase change --help`.\n",
      )
      assert.deepStrictEqual(result.calls, [])
    }))
})

describe("Passphrase input", () => {
  it("refuses anything after the Passphrase line with StdinFramingInvalid, before any request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await admin(box, ["vault", "list"], [passphrase, "extra"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: stdin did not contain the Passphrase, one per line and nothing after; nothing was changed. See `hush vault list --help`.\n",
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it("fails NoTerminal at once without --passphrase-stdin, before any request (agents cannot run it)", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await box.run(["vault", "create", "Work"], { input: `${passphrase}\n` })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: hush vault create needs a human with the Passphrase at a terminal; nothing was changed. Run it from an interactive terminal (or pipe secrets with `--passphrase-stdin`). Agents cannot run it.\n",
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it.skipIf(!onPty)("reads the Passphrase at the hidden `hush Passphrase: ` prompt", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await box.run(["vault", "list"], {
        tty: { keys: [{ after: "hush Passphrase: ", keys: `${passphrase}\r` }] },
      })

      assert.strictEqual(result.code, 0, result.stdout)
      assert.include(result.stdout, '"vault": "Personal"')
      assert.deepStrictEqual(result.calls, [call("/v1/admin/vaults/list", 200)])
    }),
  )

  it.skipIf(!onPty)("asks current, new and repeat at a terminal for passphrase change", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await box.run(["passphrase", "change"], {
        tty: {
          keys: [
            { after: "hush Passphrase: ", keys: `${passphrase}\r` },
            { after: "New Passphrase: ", keys: `${newPassphrase}\r` },
            { after: "Repeat new Passphrase: ", keys: `${newPassphrase}\r` },
          ],
        },
      })

      assert.strictEqual(result.code, 0, result.stdout)
      assert.include(result.stdout, '"changed": true')
      assert.strictEqual((await admin(box, ["vault", "list"], [newPassphrase])).code, 0)
    }),
  )
})

describe("the Audit Log of Passphrase operations", () => {
  it("writes one row per evaluated Passphrase: actor passphrase, the Action, the Vault, no detail, the outcome", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = (await auditRows(box)).length

      for (const [args, lines] of [
        [["vault", "create", "Work"], [passphrase]],
        [["vault", "list"], [passphrase]],
        [["vault", "delete", "Work"], [passphrase]],
        [
          ["passphrase", "change"],
          [passphrase, newPassphrase],
        ],
        [["vault", "list"], [passphrase]],
      ] as const)
        await admin(box, args, lines)
      assert.deepStrictEqual((await auditRows(box)).slice(before), [
        passphraseRow("vault.create", ["Work"], "ok", null),
        passphraseRow("vault.list", [], "ok", null),
        passphraseRow("vault.delete", ["Work"], "ok", null),
        passphraseRow("passphrase.change", [], "ok", null),
        passphraseRow("vault.list", [], "denied", "PassphraseIncorrect"),
      ])
    }))
})

// Wrong Passphrases to `vaults/list`, `n` at once.
const wrongLists = (box: Sandbox, n: number) =>
  Promise.all(
    Array.from({ length: n }, async () => {
      const response = await post(box, "/v1/admin/vaults/list", { passphrase: "a wrong fictional passphrase" })

      return { status: response.status, body: await response.json() }
    }),
  )

const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

describe("the Passphrase backoff", () => {
  it("lets three wrong Passphrases through free, then gives the fourth retryAfterSeconds >= 1", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await admin(box, ["vault", "list"], ["a wrong fictional passphrase"])
        assert.strictEqual(result.stderr, incorrectNow)
      }

      const fourth = await admin(box, ["vault", "list"], ["a wrong fictional passphrase"])
      assert.strictEqual(fourth.code, 1)
      assert.strictEqual(
        fourth.stderr,
        "hush: The Passphrase is incorrect; nothing was changed. You can try again in 1 second; repeated failures slow every Passphrase operation on this Server.\n",
      )
      assert.deepStrictEqual(fourth.calls, [call("/v1/admin/vaults/list", 401)])
    }))

  it("evaluates exactly 4 of 20 concurrent wrong attempts from a clean state; the other 16 are BackoffActive, unaudited", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = (await auditRows(box)).length
      const answers = await wrongLists(box, 20)
      const incorrect = answers.filter(({ status }) => status === 401)
      const active = answers.filter(({ status }) => status === 429)
      assert.strictEqual(incorrect.length, 4)
      assert.strictEqual(active.length, 16)

      for (const { body } of active) assert.strictEqual(body._tag, "BackoffActive")
      assert.deepStrictEqual(
        incorrect.map(({ body }) => body).toSorted((a, b) => a.retryAfterSeconds - b.retryAfterSeconds),
        [0, 0, 0, 1].map((retryAfterSeconds) => ({ _tag: "PassphraseIncorrect", retryAfterSeconds })),
      )
      const added = (await auditRows(box)).slice(before)
      assert.strictEqual(added.length, 4)

      for (const row of added)
        assert.deepStrictEqual(row, passphraseRow("vault.list", [], "denied", "PassphraseIncorrect"))
    }))

  it("does not count guard refusals: three wrong attempts, refused ones in between, and the fourth waits 1 s", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await wrongLists(box, 3)
      const before = (await auditRows(box)).length
      const body = JSON.stringify({ passphrase: "a wrong fictional passphrase" })

      const refusals: ReadonlyArray<Record<string, string>> = [
        { "content-type": "application/json", origin: "https://evil.example" },
        { "content-type": "text/plain" },
      ]

      for (const headers of refusals) {
        const refused = await box.fetch("/v1/admin/vaults/list", { method: "POST", headers, body })
        assert.include([403, 415], refused.status)
      }

      assert.strictEqual((await auditRows(box)).length, before)
      const [fourth] = await wrongLists(box, 1)
      assert.deepStrictEqual(fourth, { status: 401, body: { _tag: "PassphraseIncorrect", retryAfterSeconds: 1 } })
    }))

  it("refuses the right Passphrase while pinned with BackoffActive and the break-glass advice, serves Tokens, and clears at restart", () =>
    withSandbox(async (box, seen) => {
      const seed = await withItem(box, seen)
      // Pinned for 4 s: failures 4, 5 and 6, each sent once the previous delay ran out.
      await wrongLists(box, 4)
      await wait(1)
      await wrongLists(box, 1)
      await wait(2)
      const [sixth] = await wrongLists(box, 1)
      assert.deepStrictEqual(sixth, { status: 401, body: { _tag: "PassphraseIncorrect", retryAfterSeconds: 4 } })
      const before = { state: await state(box), audit: await auditRows(box) }

      const pinned = await admin(box, ["vault", "list"])
      assert.strictEqual(pinned.code, 1)
      assert.strictEqual(pinned.stdout, "")
      assert.match(
        pinned.stderr,
        /^hush: Too many incorrect Passphrase attempts; the Server will check the next one in [1-4] seconds?\. Nothing was checked or changed\. Wait, or restart the Server to clear the delay\. If the delay keeps returning, someone is guessing: to Revoke a Token now, run `hush server revoke <label>` on the Server host, then block the source \(README, "Incident"\)\.\n$/,
      )
      assert.deepStrictEqual(pinned.calls, [call("/v1/admin/vaults/list", 429)])
      assert.deepStrictEqual({ state: await state(box), audit: await auditRows(box) }, before)

      // The backoff never applies to Token requests.
      const read = await box.run(["read", seed.references[0] ?? ""], { secretStdout: true })
      assert.strictEqual(read.code, 0, read.stderr)

      await box.server.restart()
      const cleared = await admin(box, ["vault", "list"])
      assert.strictEqual(cleared.code, 0, cleared.stderr)
    }))
})

describe("a Passphrase write whose answer is lost", () => {
  it("reports ChangeUnverified naming vault list, token list and inventory, and creates exactly once", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      box.proxy.mode("drop-response")

      const result = await box.run(["vault", "create", "Work", "--passphrase-stdin"], {
        input: `${passphrase}\n`,
        env: { HUSH_SERVER: box.proxy.url },
      })

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: The connection failed after the request was sent, so the change may or may not have happened. Do not retry blindly; check with `hush vault list`, `hush token list` or `hush inventory`.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/vaults/create", 200)])
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/admin/vaults/create HTTP/1.1"])
      assert.deepStrictEqual(await rows(box, "SELECT name FROM vaults ORDER BY id"), [
        { name: "Personal" },
        { name: "Work" },
      ])
    }))
})
