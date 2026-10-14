import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { hostname } from "node:os"
import { join } from "node:path"

import { scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox, seedPassphrase } from "./sandbox.js"

const value = valueSentinel.text
// A plain Field's value: sealed like any value, and never shown by `find` or `inventory` either.
const plainSentinel: Sentinel = { kind: "value", text: "fictional-plain-username-4Rk" }

// Runs `test`, then asserts that no value, Passphrase, Init code or Token seen during the test reached anything
// observable it does not belong in.
const withSandbox = async (test: (box: Sandbox, seen: (sentinel: Sentinel) => void) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, plainSentinel, { kind: "passphrase", text: seedPassphrase }]
  try {
    await test(box, (sentinel) => sentinels.push(sentinel))
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

const call = (path: string, status: number) => ({ method: "POST", path, status })
const listed = [call("/v1/items/list", 200)]

// The listing the matching cases run over, plus a login with a plain Field: Personal holds `Cloud API` and
// `Cloud Login`, Work holds `Database` and the empty Vault `Empty` is granted too.
const seedListing = async (box: Sandbox, seen: (sentinel: Sentinel) => void) => {
  const code = await box.server.initCode()
  if (code !== undefined) seen({ kind: "initCode", text: code })
  const seeded = await box.seed({
    items: [
      { kind: "api-credential", title: "Cloud API", value },
      { kind: "login", title: "Cloud Login", value, plain: { username: plainSentinel.text } },
    ],
  })
  seen({ kind: "token", text: seeded.token })
  for (const vault of ["Work", "Empty"]) await admin(box, ["vault", "create", vault])
  await admin(box, [
    "token",
    "issue",
    "--label",
    "agent on box",
    "--create",
    "Work",
    "--read",
    "Empty",
    "--keep-grants",
    "--replace",
  ])
  seen({ kind: "token", text: await savedToken(box) })
  const created = await box.run(["create", "database", "--title", "Database", "--vault", "Work", "--stdin"], {
    input: `${value}\n`,
  })
  assert.strictEqual(created.code, 0, created.stderr)
}

const admin = async (box: Sandbox, args: ReadonlyArray<string>) => {
  const result = await box.run([...args, "--passphrase-stdin"], { input: `${seedPassphrase}\n` })
  assert.strictEqual(result.code, 0, result.stderr)
  return result
}

const SavedTokens = Schema.fromJsonString(
  Schema.Struct({ tokens: Schema.Tuple([Schema.Struct({ token: Schema.String })]) }),
)

const savedToken = async (box: Sandbox) =>
  Schema.decodeUnknownSync(SavedTokens)(await Bun.file(join(box.home, ".config", "hush", "tokens.json")).text())
    .tokens[0].token

// The account the CLI runs as, which a rendered `hush token issue` command names.
const user = "agent"
const account = { USER: user }
const host = hostname()

// The seeded Token's Grants, which the Server lists by name.
const grantedNames = ["Empty", "Personal", "Work"]
const grantedText = "Empty (read), Personal (read+create), Work (read+create)"

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())

const lastAudit = async (box: Sandbox) =>
  (
    await rows(
      box,
      "SELECT actor, token_label, action, vaults, refs, outcome, error FROM audit ORDER BY id DESC LIMIT 1",
    )
  )[0]

// The state a refused command must not have changed; every audited Token use moves `last_used_at`.
const snapshot = async (box: Sandbox) => ({
  items: await rows(box, "SELECT * FROM items"),
  fields: await rows(box, "SELECT * FROM fields"),
  tokens: await rows(box, "SELECT id, label, revoked_at, expires_at FROM tokens"),
  grants: await rows(box, "SELECT * FROM token_vaults"),
  vaults: await rows(box, "SELECT * FROM vaults"),
})

// Exit 1, nothing on stdout, exactly `message` on stderr, the given calls, and no change but an audit row.
const assertRefused = async (
  box: Sandbox,
  run: () => Promise<{
    readonly code: number
    readonly stdout: string
    readonly stderr: string
    readonly calls: unknown
  }>,
  message: string,
  calls: ReadonlyArray<unknown> = [],
) => {
  const before = await snapshot(box)
  const result = await run()
  assert.strictEqual(result.code, 1)
  assert.strictEqual(result.stdout, "")
  assert.strictEqual(result.stderr, `hush: ${message}\n`)
  assert.deepStrictEqual(result.calls, calls)
  assert.deepStrictEqual(await snapshot(box), before)
}

describe("hush find", () => {
  it("matches every term of a query case-insensitively, across every granted Vault, in one items/list", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      const result = await box.run(["find", "API CLOUD"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        matches: [{ ref: "hush://Personal/Cloud API/credential", title: "Cloud API", kind: "api-credential" }],
      })
      assert.deepStrictEqual(result.calls, listed)
    }))

  it("answers several queries in one call, marking each match with the queries it answers", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      const result = await box.run(["find", "database", "cloud api", "cloud"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        matches: [
          {
            ref: "hush://Personal/Cloud API/credential",
            title: "Cloud API",
            kind: "api-credential",
            queries: ["cloud api", "cloud"],
          },
          { ref: "hush://Personal/Cloud Login/password", title: "Cloud Login", kind: "login", queries: ["cloud"] },
          { ref: "hush://Work/Database/password", title: "Database", kind: "database", queries: ["database"] },
        ],
      })
      assert.deepStrictEqual(result.calls, listed)
    }))

  it("suggests close titles for a query that matches nothing, in the same call", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      const result = await box.run(["find", "databse", "nothing like this"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        matches: [],
        suggestions: [{ query: "databse", ref: "hush://Work/Database/password", title: "Database", kind: "database" }],
      })
      assert.deepStrictEqual(result.calls, listed)
    }))

  it("narrows the search to one Vault with --vault, by name identity", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      const result = await box.run(["find", "cloud", "database", "--vault", "personal"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        matches: [
          {
            ref: "hush://Personal/Cloud API/credential",
            title: "Cloud API",
            kind: "api-credential",
            queries: ["cloud"],
          },
          { ref: "hush://Personal/Cloud Login/password", title: "Cloud Login", kind: "login", queries: ["cloud"] },
        ],
      })
      assert.deepStrictEqual(result.calls, listed)
    }))

  it("refuses a Vault outside the Grants with VaultNotGranted, suggesting only a granted name, audited denied", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      // Closer to the typo than `Personal`, but not granted: the Token must never learn its name.
      await admin(box, ["vault", "create", "Personnel"])
      await assertRefused(
        box,
        () => box.run(["find", "cloud", "--vault", "Personel"], { env: account }),
        `Token agent on box is not granted Vault Personel; nothing was read or changed. Did you mean Personal? It is granted: ${grantedText}. If Personel is right, ask the human to run: \`hush token issue --label "agent on box" --read Personel --keep-grants --replace\` as ${user} on ${host}, whose token file holds this Token; from another account: \`hush token issue --label "agent on box" --read Personel --keep-grants --replace --print | sudo -u ${user} hush token save --stdin --replace\`.`,
        [call("/v1/items/list", 403)],
      )
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "token",
        token_label: "agent on box",
        action: "items.list",
        vaults: '["Personel"]',
        refs: "[]",
        outcome: "denied",
        error: "VaultNotGranted",
      })
    }))
})

// Each Item's stored times by title, which `inventory` reports as they are.
const times = async (box: Sandbox) =>
  new Map(
    Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ title: Schema.String, created_at: Schema.String, updated_at: Schema.String })),
    )(await rows(box, "SELECT title, created_at, updated_at FROM items")).map(({ title, created_at, updated_at }) => [
      title,
      { createdAt: created_at, updatedAt: updated_at },
    ]),
  )

describe("hush inventory", () => {
  it("lists every granted Vault with its Access, empty ones included, and every Item with all its Fields", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      const stored = await times(box)
      const result = await box.run(["inventory"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        vaults: [
          { vault: "Empty", access: "read" },
          { vault: "Personal", access: "read+create" },
          { vault: "Work", access: "read+create" },
        ],
        items: [
          {
            title: "Cloud API",
            vault: "Personal",
            kind: "api-credential",
            ...stored.get("Cloud API"),
            fields: [{ label: "credential", concealed: true, ref: "hush://Personal/Cloud API/credential" }],
          },
          {
            title: "Cloud Login",
            vault: "Personal",
            kind: "login",
            ...stored.get("Cloud Login"),
            fields: [
              { label: "password", concealed: true, ref: "hush://Personal/Cloud Login/password" },
              { label: "username", concealed: false, ref: "hush://Personal/Cloud Login/username" },
            ],
          },
          {
            title: "Database",
            vault: "Work",
            kind: "database",
            ...stored.get("Database"),
            fields: [{ label: "password", concealed: true, ref: "hush://Work/Database/password" }],
          },
        ],
      })
      assert.deepStrictEqual(result.calls, listed)
    }))

  it("marks exactly one Field of a three-Field login concealed", () =>
    withSandbox(async (box, seen) => {
      const code = await box.server.initCode()
      if (code !== undefined) seen({ kind: "initCode", text: code })
      const seeded = await box.seed({
        items: [
          {
            kind: "login",
            title: "GitHub",
            value,
            plain: { username: plainSentinel.text, notes: "fictional-notes-8Hq" },
          },
        ],
      })
      seen({ kind: "token", text: seeded.token })
      seen({ kind: "value", text: "fictional-notes-8Hq" })
      const result = await box.run(["inventory"])
      assert.strictEqual(result.code, 0, result.stderr)
      const [item] = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            items: Schema.Array(
              Schema.Struct({
                fields: Schema.Array(Schema.Struct({ label: Schema.String, concealed: Schema.Boolean })),
              }),
            ),
          }),
        ),
      )(result.stdout).items
      assert.deepStrictEqual(item?.fields, [
        { label: "password", concealed: true },
        { label: "username", concealed: false },
        { label: "notes", concealed: false },
      ])
    }))

  it("narrows both lists to one Vault with --vault", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      for (const [vault, expected] of [
        ["EMPTY", { vaults: [{ vault: "Empty", access: "read" }], items: [] }],
        ["Work", { vaults: [{ vault: "Work", access: "read+create" }], items: ["Database"] }],
      ] as const) {
        const result = await box.run(["inventory", "--vault", vault])
        assert.strictEqual(result.code, 0, result.stderr)
        const { vaults, items } = JSON.parse(result.stdout)
        assert.deepStrictEqual({ vaults, items: items.map(({ title }: { readonly title: string }) => title) }, expected)
        assert.deepStrictEqual(result.calls, listed)
      }
    }))

  it("refuses an invalid --vault name with InvalidName before any request", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      for (const command of [["inventory"], ["find", "cloud"]])
        await assertRefused(
          box,
          () => box.run([...command, "--vault", "Work/Database"]),
          "vault is not a valid name (slash); nothing was changed. Names are 1-128 characters without `/` or control characters, not starting with `-` or with a space at either end.",
        )
    }))
})

describe("items/list errors", () => {
  it("refuses a requested Vault that is not a name with InvalidName, audited error", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      const before = await snapshot(box)
      const response = await box.fetch("/v1/items/list", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await savedToken(box)}` },
        body: JSON.stringify({ vaults: ["Work", "a/b"] }),
      })
      assert.strictEqual(response.status, 400)
      assert.deepStrictEqual(await response.json(), { _tag: "InvalidName", what: "vault", reason: "slash" })
      assert.deepStrictEqual(await snapshot(box), before)
      const row = await lastAudit(box)
      assert.deepStrictEqual(row, {
        actor: "token",
        token_label: "agent on box",
        action: "items.list",
        vaults: '["Work","a/b"]',
        refs: "[]",
        outcome: "error",
        error: "InvalidName",
      })
    }))

  it("fails an Item whose stored Kind was modified with IntegrityCheckFailed naming the Item", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      await box.inspect((db) => db.prepare("UPDATE items SET kind = 'note' WHERE title = 'Database'").run())
      const before = await snapshot(box)
      for (const command of [["inventory"], ["find", "cloud"]]) {
        const result = await box.run(command)
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(
          result.stderr,
          'hush: Stored data for Item Database in Vault Work failed its integrity check, so the database file was modified or corrupted; nothing was returned or changed. Restore the Server from a backup: see "Backup and restore" in the hush README.\n',
        )
        assert.deepStrictEqual(result.calls, [call("/v1/items/list", 500)])
      }
      assert.deepStrictEqual(await snapshot(box), before)
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "token",
        token_label: "agent on box",
        action: "items.list",
        vaults: JSON.stringify(grantedNames),
        refs: "[]",
        outcome: "error",
        error: "IntegrityCheckFailed",
      })
    }))
})

describe("the Init-saved Token", () => {
  it("runs find and inventory with no Passphrase", () =>
    withSandbox(async (box, seen) => {
      const code = await box.server.initCode()
      if (code !== undefined) seen({ kind: "initCode", text: code })
      const seeded = await box.seed({ items: [{ kind: "api-credential", title: "Stripe", value }] })
      seen({ kind: "token", text: seeded.token })
      const found = await box.run(["find", "stripe"])
      assert.strictEqual(found.code, 0, found.stderr)
      assert.deepStrictEqual(JSON.parse(found.stdout), {
        matches: [{ ref: "hush://Personal/Stripe/credential", title: "Stripe", kind: "api-credential" }],
      })
      assert.deepStrictEqual(found.calls, listed)
      const inventory = await box.run(["inventory"])
      assert.strictEqual(inventory.code, 0, inventory.stderr)
      assert.deepStrictEqual(JSON.parse(inventory.stdout).vaults, [{ vault: "Personal", access: "read+create" }])
      assert.deepStrictEqual(inventory.calls, listed)
    }))
})

describe("the items.list audit row", () => {
  it("names the Token and every Vault listed, outcome ok", () =>
    withSandbox(async (box, seen) => {
      await seedListing(box, seen)
      assert.strictEqual((await box.run(["find", "cloud"])).code, 0)
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "token",
        token_label: "agent on box",
        action: "items.list",
        vaults: JSON.stringify(grantedNames),
        refs: "[]",
        outcome: "ok",
        error: null,
      })
      assert.strictEqual((await box.run(["inventory", "--vault", "work"])).code, 0)
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "token",
        token_label: "agent on box",
        action: "items.list",
        vaults: '["Work"]',
        refs: "[]",
        outcome: "ok",
        error: null,
      })
    }))
})
