import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { garbledMarker } from "./proxy.js"
import { onPty, sandbox, type Sandbox } from "./sandbox.js"

// The Owner's Item commands through the seam: `item edit|rename|delete|release`, Retired titles and
// the WAL purge after each retiring write.

const passphrase = passphraseSentinel.text
const value = valueSentinel.text
const rotated = "fictional rotated credential 4Wz"
const rotatedSentinel: Sentinel = { kind: "value", text: rotated }

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in.
const withSandbox = async (test: (box: Sandbox, seen: (sentinel: Sentinel) => void) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, passphraseSentinel, rotatedSentinel]

  try {
    await test(box, (sentinel) => sentinels.push(sentinel))
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

// `seed` with one api-credential Item `Stripe` and one login `GitHub`, its Token and Init code registered as
// sentinels.
const seeded = async (box: Sandbox, seen: (sentinel: Sentinel) => void) => {
  const code = await box.server.initCode()

  if (code !== undefined) seen({ kind: "initCode", text: code })

  const result = await box.seed({
    items: [
      { kind: "api-credential", title: "Stripe", value },
      { kind: "login", title: "GitHub", value },
    ],
  })

  seen({ kind: "token", text: result.token })

  return result
}

const call = (path: string, status: number) => ({ method: "POST", path, status })
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// A Passphrase command with the Passphrase line piped to `--passphrase-stdin`, then `rest` (an `--stdin` value).
const admin = (box: Sandbox, args: ReadonlyArray<string>, rest = "") =>
  box.run([...args, "--passphrase-stdin"], { input: `${passphrase}\n${rest}` })

const read = (box: Sandbox, reference: string) => box.run(["read", reference], { secretStdout: true })

describe("hush item edit --field", () => {
  it("replaces the concealed value, verified: the new value resolves and the old one no longer does", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await admin(
        box,
        ["item", "edit", "personal", "stripe", "--field", "credential", "--stdin"],
        `${rotated}\n`,
      )

      assert.strictEqual(result.code, 0, result.stderr)
      const receipt = JSON.parse(result.stdout)
      assert.deepStrictEqual(Object.keys(receipt), ["vault", "title", "kind", "fields", "updatedAt", "verified"])
      assert.deepStrictEqual(
        { ...receipt, updatedAt: undefined },
        {
          vault: "Personal",
          title: "Stripe",
          kind: "api-credential",
          fields: [{ label: "credential", concealed: true, ref: "hush://Personal/Stripe/credential" }],
          updatedAt: undefined,
          verified: true,
        },
      )
      assert.match(receipt.updatedAt, isoTime)
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/edit", 200)])
      const resolved = await read(box, "hush://Personal/Stripe/credential")
      assert.strictEqual(resolved.code, 0, resolved.stderr)
      assert.strictEqual(resolved.stdout, rotated)
    }))

  it("adds an absent plain Field to a login with its own id, and it resolves beside the password", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      // Everything after the Passphrase line is the value, newlines included; one trailing newline is stripped.
      const result = await admin(
        box,
        ["item", "edit", "Personal", "GitHub", "--field", "Notes", "--stdin"],
        `${value}\n`,
      )

      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout).fields, [
        { label: "password", concealed: true, ref: "hush://Personal/GitHub/password" },
        { label: "notes", concealed: false, ref: "hush://Personal/GitHub/notes" },
      ])
      const notes = await read(box, "hush://Personal/GitHub/notes")
      assert.strictEqual(notes.code, 0, notes.stderr)
      assert.strictEqual(notes.stdout, value)
      const password = await read(box, "hush://Personal/GitHub/password")
      assert.strictEqual(password.stdout, value)
    }))
})

// What a refused edit must leave as it was, seen as an agent sees it: the metadata through `inventory` and both
// primary values through `read`.
const items = async (box: Sandbox) => ({
  inventory: (await box.run(["inventory"])).stdout,
  stripe: (await read(box, "hush://Personal/Stripe/credential")).stdout,
  github: (await read(box, "hush://Personal/GitHub/password")).stdout,
})

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())

const lastAudit = async (box: Sandbox) =>
  (await rows(box, "SELECT actor, action, vaults, refs, detail, outcome, error FROM audit ORDER BY id")).at(-1)

describe("hush item edit --remove", () => {
  it("drops a present plain Field, which then no longer resolves", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await admin(box, ["item", "edit", "Personal", "GitHub", "--field", "username", "--stdin"], "octocat\n")
      const result = await admin(box, ["item", "edit", "Personal", "GitHub", "--remove", "username"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout).fields, [
        { label: "password", concealed: true, ref: "hush://Personal/GitHub/password" },
      ])
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/edit", 200)])
      const gone = await read(box, "hush://Personal/GitHub/username")
      assert.strictEqual(gone.code, 1)
      assert.include(gone.stderr, "does not exist (no such field)")
    }))
})

describe("a refused item edit changes nothing", () => {
  const refusals = [
    {
      name: "FieldRequired for removing the primary Field",
      args: ["Personal", "Stripe", "--remove", "credential"],
      status: 400,
      tag: "FieldRequired",
      stderr: "hush: api-credential Items need their credential Field; nothing was changed.\n",
    },
    {
      name: "UnknownField, listing the allowed labels, for a label outside the Kind",
      args: ["Personal", "Stripe", "--field", "url", "--stdin"],
      input: `${rotated}\n`,
      status: 400,
      tag: "UnknownField",
      stderr: "hush: api-credential Items have no Field url; nothing was changed. Allowed: credential, notes.\n",
    },
    {
      name: "FieldNotFound for removing an absent Field",
      args: ["Personal", "Stripe", "--remove", "notes"],
      status: 404,
      tag: "FieldNotFound",
      stderr:
        "hush: Item Stripe has no Field notes; nothing was changed. `hush inventory --vault Personal` lists its Fields.\n",
    },
    {
      name: "ItemNotFound naming the Vault and the Item",
      args: ["personal", "Stripe Old", "--field", "credential", "--stdin"],
      input: `${rotated}\n`,
      status: 404,
      tag: "ItemNotFound",
      stderr:
        'hush: Item Stripe Old does not exist in Vault Personal; nothing was changed. `hush find "Stripe Old" --vault Personal` shows exact titles.\n',
    },
  ] as const

  for (const refusal of refusals)
    it(`${refusal.name}: exit 1, audited error`, () =>
      withSandbox(async (box, seen) => {
        await seeded(box, seen)
        const before = await items(box)
        const result = await admin(box, ["item", "edit", ...refusal.args], "input" in refusal ? refusal.input : "")
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(result.stderr, refusal.stderr)
        assert.deepStrictEqual(result.calls, [call("/v1/admin/items/edit", refusal.status)])
        const audited = await lastAudit(box)
        assert.deepStrictEqual(await items(box), before)
        assert.deepStrictEqual(audited, {
          actor: "passphrase",
          action: "item.edit",
          vaults: JSON.stringify([refusal.args[0]]),
          refs: "[]",
          detail: JSON.stringify({
            title: refusal.args[1],
            [refusal.args[2] === "--remove" ? "removed" : "set"]: refusal.args[3],
          }),
          outcome: "error",
          error: refusal.tag,
        })
      }))

  it("EditFlagsInvalid for both --field and --remove, or a value source with --remove, before any prompt or request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      for (const flags of [
        ["--field", "notes", "--remove", "notes", "--stdin"],
        ["--remove", "notes", "--stdin"],
        [],
      ]) {
        const result = await box.run(["item", "edit", "Personal", "GitHub", ...flags])
        assert.strictEqual(result.code, 1)
        assert.strictEqual(
          result.stderr,
          "hush: Pass either `--field <label>` with one of `--stdin`, `--prompt` or `--clipboard`, or `--remove <label>` alone; nothing was changed and no prompt was shown. See `hush item edit --help`.\n",
        )
        assert.deepStrictEqual(result.calls, [])
      }
    }))
})

// A Token's `create` of an api-credential titled `title` in Personal.
const tokenCreate = (box: Sandbox, title: string) =>
  box.run(["create", "api-credential", "--title", title, "--vault", "Personal", "--stdin"], { input: `${rotated}\n` })

const RetiredRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ title_key: Schema.String })))

const retiredKeys = async (box: Sandbox) =>
  RetiredRows(await rows(box, "SELECT title_key FROM retired_titles ORDER BY title_key")).map(
    ({ title_key }) => title_key,
  )

const releaseNotice = (title: string) =>
  `hush: Tokens cannot create an Item titled ${title} in Vault Personal again until you run \`hush item release Personal "${title}"\`.\n`

const titleRetired = (title: string) =>
  `hush: The title ${title} in Vault Personal was freed by a rename or delete, and Tokens cannot reuse it until the human releases it; nothing was created. Choose another title, or ask the human to run \`hush item release Personal "${title}"\`.\n`

describe("hush item rename", () => {
  it("prints old and new References, retires the old title, breaks the old Reference with a suggestion of the new one", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await admin(box, ["item", "rename", "personal", "stripe", "Stripe Live"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        vault: "Personal",
        from: "Stripe",
        to: "Stripe Live",
        references: [{ old: "hush://Personal/Stripe/credential", new: "hush://Personal/Stripe Live/credential" }],
        retired: "Stripe",
      })
      assert.strictEqual(result.stderr, releaseNotice("Stripe"))
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/rename", 200)])
      assert.deepStrictEqual(await retiredKeys(box), ["stripe"])

      const old = await read(box, "hush://Personal/Stripe/credential")
      assert.strictEqual(old.code, 1)
      assert.include(old.stderr, "Did you mean: hush://Personal/Stripe Live/credential?")
      const renamed = await read(box, "hush://Personal/Stripe Live/credential")
      assert.strictEqual(renamed.stdout, value)
    }))

  it("refuses a Token's create under the old title with TitleRetired, audited error, creating nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await admin(box, ["item", "rename", "Personal", "Stripe", "Stripe Live"])
      const before = await rows(box, "SELECT id, title FROM items ORDER BY id")
      const created = await tokenCreate(box, "STRIPE")
      assert.strictEqual(created.code, 1)
      assert.strictEqual(created.stdout, "")
      assert.strictEqual(created.stderr, titleRetired("STRIPE"))
      assert.deepStrictEqual(created.calls, [call("/v1/items/create", 409)])
      assert.deepStrictEqual(await rows(box, "SELECT id, title FROM items ORDER BY id"), before)
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "token",
        action: "items.create",
        vaults: '["Personal"]',
        refs: "[]",
        detail: JSON.stringify({ title: "STRIPE", fields: ["credential"] }),
        outcome: "error",
        error: "TitleRetired",
      })
    }))

  it("allows a case-only rename, which retires nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await admin(box, ["item", "rename", "Personal", "Stripe", "STRIPE"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout).retired, null)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(await retiredKeys(box), [])
      assert.strictEqual((await read(box, "hush://Personal/STRIPE/credential")).stdout, value)
    }))

  it("releases a Retired title it renames onto, and retires the title it leaves", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await admin(box, ["item", "rename", "Personal", "Stripe", "Stripe Live"])
      const back = await admin(box, ["item", "rename", "Personal", "Stripe Live", "Stripe"])
      assert.strictEqual(back.code, 0, back.stderr)
      assert.deepStrictEqual(await retiredKeys(box), ["stripe live"])
      assert.strictEqual((await read(box, "hush://Personal/Stripe/credential")).stdout, value)
    }))

  it("refuses a taken title with ItemExists, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await items(box)
      const result = await admin(box, ["item", "rename", "Personal", "Stripe", "github"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        'hush: An Item titled github already exists in Vault Personal; nothing was created or overwritten. Run hush find "github" --vault Personal, or choose another title.\n',
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/rename", 409)])
      assert.deepStrictEqual(await items(box), before)
      assert.deepStrictEqual(await retiredKeys(box), [])
    }))

  it("refuses a missing Item with ItemNotFound, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await items(box)
      const result = await admin(box, ["item", "rename", "Personal", "Nope", "Other"])
      assert.strictEqual(result.code, 1)
      assert.include(result.stderr, "hush: Item Nope does not exist in Vault Personal; nothing was changed.")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/rename", 404)])
      assert.deepStrictEqual(await items(box), before)
    }))
})

describe("hush item delete and item release", () => {
  it("deletes the Item and retires its title; a Token's create gets TitleRetired until a release, then succeeds", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const deleted = await admin(box, ["item", "delete", "personal", "stripe"])
      assert.strictEqual(deleted.code, 0, deleted.stderr)
      assert.strictEqual(
        deleted.stdout,
        `${JSON.stringify({ deleted: true, vault: "Personal", title: "Stripe", retired: true }, null, 2)}\n`,
      )
      assert.strictEqual(deleted.stderr, releaseNotice("Stripe"))
      assert.deepStrictEqual(deleted.calls, [call("/v1/admin/items/delete", 200)])
      assert.deepStrictEqual(await rows(box, "SELECT title FROM items ORDER BY id"), [{ title: "GitHub" }])
      assert.deepStrictEqual(await rows(box, "SELECT label FROM fields ORDER BY id"), [{ label: "password" }])
      const gone = await read(box, "hush://Personal/Stripe/credential")
      assert.strictEqual(gone.code, 1)
      assert.include(gone.stderr, "does not exist (no such item)")

      const refused = await tokenCreate(box, "Stripe")
      assert.strictEqual(refused.code, 1)
      assert.strictEqual(refused.stderr, titleRetired("Stripe"))

      const released = await admin(box, ["item", "release", "Personal", "stripe"])
      assert.strictEqual(released.code, 0, released.stderr)
      assert.strictEqual(
        released.stdout,
        `${JSON.stringify({ released: true, vault: "Personal", title: "stripe" }, null, 2)}\n`,
      )
      assert.strictEqual(released.stderr, "")
      assert.deepStrictEqual(released.calls, [call("/v1/admin/items/release", 200)])
      assert.deepStrictEqual(await retiredKeys(box), [])

      const created = await tokenCreate(box, "Stripe")
      assert.strictEqual(created.code, 0, created.stderr)
      assert.strictEqual((await read(box, "hush://Personal/Stripe/credential")).stdout, rotated)
    }))

  it("refuses to delete a missing Item with ItemNotFound, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await items(box)
      const result = await admin(box, ["item", "delete", "Personal", "Nope"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.include(result.stderr, "hush: Item Nope does not exist in Vault Personal; nothing was changed.")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/delete", 404)])
      assert.deepStrictEqual(await items(box), before)
      assert.deepStrictEqual(await retiredKeys(box), [])
    }))

  it("refuses to release a title that is not retired with TitleNotRetired, audited error, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await admin(box, ["item", "delete", "Personal", "Stripe"])
      const result = await admin(box, ["item", "release", "Personal", "GitHub"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: The title GitHub is not retired in Vault Personal; nothing was changed.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/release", 404)])
      assert.deepStrictEqual(await retiredKeys(box), ["stripe"])
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "passphrase",
        action: "item.release",
        vaults: '["Personal"]',
        refs: "[]",
        detail: JSON.stringify({ title: "GitHub" }),
        outcome: "error",
        error: "TitleNotRetired",
      })
    }))
})

// An `ok` audit row of a Passphrase operation on Personal.
const okRow = (action: string, detail: { readonly [key: string]: string }) => ({
  actor: "passphrase",
  action,
  vaults: '["Personal"]',
  refs: "[]",
  detail: JSON.stringify(detail),
  outcome: "ok",
  error: null,
})

describe("the Audit Log of Item operations", () => {
  it("writes item.edit, item.rename, item.delete and item.release rows: actor passphrase, names only in detail", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = (await rows(box, "SELECT id FROM audit")).length
      await admin(box, ["item", "edit", "personal", "github", "--field", "username", "--stdin"], "octocat\n")
      await admin(box, ["item", "edit", "Personal", "GitHub", "--remove", "USERNAME"])
      await admin(box, ["item", "rename", "Personal", "stripe", "Stripe Live"])
      await admin(box, ["item", "delete", "Personal", "Stripe Live"])
      await admin(box, ["item", "release", "Personal", "stripe live"])
      const added = await rows(box, "SELECT actor, action, vaults, refs, detail, outcome, error FROM audit ORDER BY id")
      assert.deepStrictEqual(added.slice(before), [
        okRow("item.edit", { title: "GitHub", set: "username" }),
        okRow("item.edit", { title: "GitHub", removed: "USERNAME" }),
        okRow("item.rename", { from: "Stripe", to: "Stripe Live" }),
        okRow("item.delete", { title: "Stripe Live" }),
        okRow("item.release", { title: "stripe live" }),
      ])
    }))
})

const SealedRow = Schema.decodeUnknownOption(Schema.Struct({ sealed: Schema.Uint8Array }))

// The sealed value of `title`'s `label` Field, read raw.
const sealedOf = (box: Sandbox, title: string, label: string) =>
  box.inspect((db) => {
    const row = SealedRow(
      db
        .query("SELECT f.sealed FROM fields f JOIN items i ON i.id = f.item_id WHERE i.title = ? AND f.label = ?")
        .get(title, label),
    )

    if (Option.isNone(row)) throw new Error(`no sealed value for ${title}/${label}`)

    return Buffer.from(row.value.sealed)
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

// The WAL's size: 0 right after a `wal_checkpoint(TRUNCATE)`.
const walBytes = async (box: Sandbox) => (await stat(join(box.server.stateDir, "hush.db-wal"))).size

describe("the WAL purge after Item writes: old sealed bytes are in neither hush.db nor hush.db-wal", () => {
  it("purges the old sealed value after an edit, the deleted one after a delete, and checkpoints after a rename", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const oldSeal = await sealedOf(box, "Stripe", "credential")

      const edited = await admin(
        box,
        ["item", "edit", "Personal", "Stripe", "--field", "credential", "--stdin"],
        rotated,
      )

      assert.strictEqual(edited.code, 0, edited.stderr)
      assert.deepStrictEqual(await stateFilesHolding(box, oldSeal), [])
      assert.strictEqual(await walBytes(box), 0)

      const deletedSeal = await sealedOf(box, "GitHub", "password")
      const deleted = await admin(box, ["item", "delete", "Personal", "GitHub"])
      assert.strictEqual(deleted.code, 0, deleted.stderr)
      assert.deepStrictEqual(await stateFilesHolding(box, deletedSeal), [])
      assert.strictEqual(await walBytes(box), 0)

      const renamed = await admin(box, ["item", "rename", "Personal", "Stripe", "Stripe Live"])
      assert.strictEqual(renamed.code, 0, renamed.stderr)
      assert.strictEqual(await walBytes(box), 0)
    }))
})

describe("an Item write whose answer is lost", () => {
  it("reports ChangeUnverified and deletes exactly once", () =>
    withSandbox(async (box, seen) => {
      const seed = await seeded(box, seen)
      box.proxy.mode("drop-response")

      const result = await box.run(["item", "delete", "Personal", "Stripe", "--passphrase-stdin"], {
        input: `${passphrase}\n`,
        env: { HUSH_SERVER: box.proxy.url, HUSH_TOKEN: seed.token },
      })

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: The connection failed after the request was sent, so the change may or may not have happened. Do not retry blindly; check with `hush vault list`, `hush token list` or `hush inventory`.\n",
      )
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/admin/items/delete HTTP/1.1"])
      assert.deepStrictEqual(await rows(box, "SELECT title FROM items ORDER BY id"), [{ title: "GitHub" }])
    }))
})

// An Item command through the proxy in `garble-response` mode: the Server makes the change, and the CLI gets an
// answer it cannot decode in its place.
const garbled = async (box: Sandbox, args: ReadonlyArray<string>, rest = "") => {
  box.proxy.mode("garble-response")

  const result = await box.run([...args, "--passphrase-stdin"], {
    input: `${passphrase}\n${rest}`,
    env: { HUSH_SERVER: box.proxy.url },
  })

  box.proxy.mode("pass")

  return result
}

// As far as the CLI knows the change may or may not have happened, so it says so and never shows the body.
const assertUnverified = (result: Awaited<ReturnType<Sandbox["run"]>>) => {
  assert.strictEqual(result.code, 1)
  assert.strictEqual(result.stdout, "")
  assert.strictEqual(
    result.stderr,
    "hush: The connection failed after the request was sent, so the change may or may not have happened. Do not retry blindly; check with `hush vault list`, `hush token list` or `hush inventory`.\n",
  )
  assert.notInclude(result.stderr, garbledMarker)
}

describe("an Item write whose answer cannot be decoded", () => {
  it("reports item edit as ChangeUnverified, never the body, and edits exactly once", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await garbled(
        box,
        ["item", "edit", "Personal", "Stripe", "--field", "credential", "--stdin"],
        `${rotated}\n`,
      )

      assertUnverified(result)
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/admin/items/edit HTTP/1.1"])
      const resolved = await read(box, "hush://Personal/Stripe/credential")
      assert.strictEqual(resolved.code, 0, resolved.stderr)
      assert.strictEqual(resolved.stdout, rotated)
    }))

  it("reports item rename as ChangeUnverified, never the body, and renames exactly once", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await garbled(box, ["item", "rename", "Personal", "Stripe", "Stripe Live"])
      assertUnverified(result)
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/admin/items/rename HTTP/1.1"])
      assert.deepStrictEqual(await rows(box, "SELECT title FROM items ORDER BY id"), [
        { title: "Stripe Live" },
        { title: "GitHub" },
      ])
      assert.deepStrictEqual(await retiredKeys(box), ["stripe"])
    }))

  it("reports item delete as ChangeUnverified, never the body, and deletes exactly once", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await garbled(box, ["item", "delete", "Personal", "Stripe"])
      assertUnverified(result)
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/admin/items/delete HTTP/1.1"])
      assert.deepStrictEqual(await rows(box, "SELECT title FROM items ORDER BY id"), [{ title: "GitHub" }])
    }))

  it("reports item release as ChangeUnverified, never the body, and releases exactly once", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      assert.strictEqual((await admin(box, ["item", "delete", "Personal", "Stripe"])).code, 0)
      assert.deepStrictEqual(await retiredKeys(box), ["stripe"])
      const result = await garbled(box, ["item", "release", "Personal", "Stripe"])
      assertUnverified(result)
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/admin/items/release HTTP/1.1"])
      assert.deepStrictEqual(await retiredKeys(box), [])
    }))
})

describe("item edit at a terminal", () => {
  it.skipIf(!onPty)("reads the Passphrase, then the value at `Value for credential: `", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await box.run(["item", "edit", "Personal", "Stripe", "--field", "credential", "--prompt"], {
        tty: {
          keys: [
            { after: "hush Passphrase: ", keys: `${passphrase}\r` },
            { after: "Value for credential: ", keys: `${rotated}\r` },
          ],
        },
      })

      assert.strictEqual(result.code, 0, result.stdout)
      assert.include(result.stdout, '"verified": true')
      assert.strictEqual((await read(box, "hush://Personal/Stripe/credential")).stdout, rotated)
    }),
  )
})
