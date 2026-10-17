import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { chmod, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// `hush token issue`, Grant enforcement and the Token lifecycle (list, revoke, expiry, save, forget, status)
// through the seam.

const passphrase = passphraseSentinel.text
const value = valueSentinel.text

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in: the token file may hold a Token, and `--print` receipts are not scanned.
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

const call = (path: string, status: number) => ({ method: "POST", path, status })

// A Passphrase command with the Passphrase piped to `--passphrase-stdin`.
const admin = (box: Sandbox, args: ReadonlyArray<string>) =>
  box.run([...args, "--passphrase-stdin"], { input: `${passphrase}\n`, secretStdout: args.includes("--print") })

const PrintReceipt = Schema.fromJsonString(
  Schema.Struct({
    label: Schema.String,
    grants: Schema.Array(Schema.Struct({ vault: Schema.String, access: Schema.String })),
    expiresAt: Schema.NullOr(Schema.String),
    revokedOnServer: Schema.Boolean,
    token: Schema.String,
  }),
)

// `token issue ... --print`, its Token registered as a sentinel.
const issuePrinted = async (box: Sandbox, seen: (sentinel: Sentinel) => void, args: ReadonlyArray<string>) => {
  const result = await admin(box, ["token", "issue", ...args, "--print"])
  assert.strictEqual(result.code, 0, result.stderr)
  const receipt = Schema.decodeUnknownSync(PrintReceipt)(result.stdout)
  seen({ kind: "token", text: receipt.token })

  return { ...result, receipt }
}

describe("hush token issue", () => {
  it("prints a Token with Read on a second Vault that reads it, saving nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const tokenFile = await Bun.file(`${box.home}/.config/hush/tokens.json`).text()
      const issued = await issuePrinted(box, seen, ["--label", "reader", "--read", "Personal"])
      assert.deepStrictEqual(
        { ...issued.receipt, token: undefined },
        {
          label: "reader",
          grants: [{ vault: "Personal", access: "read" }],
          expiresAt: null,
          revokedOnServer: false,
          token: undefined,
        },
      )
      assert.deepStrictEqual(issued.calls, [call("/v1/admin/tokens/issue", 200)])
      assert.strictEqual(await Bun.file(`${box.home}/.config/hush/tokens.json`).text(), tokenFile)

      const read = await box.run(["read", "hush://Personal/Key/credential"], {
        env: { HUSH_TOKEN: issued.receipt.token },
        secretStdout: true,
      })

      assert.strictEqual(read.code, 0, read.stderr)
      assert.strictEqual(read.stdout, value)
    }))
})

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())

const lastAudit = async (box: Sandbox) =>
  (
    await rows(
      box,
      "SELECT actor, token_label, action, vaults, detail, outcome, error FROM audit ORDER BY id DESC LIMIT 1",
    )
  )[0]

const tokenFilePath = (box: Sandbox) => join(box.home, ".config", "hush", "tokens.json")

// Everything a refused issue must leave as it was; the Audit Log is checked separately.
const tokenState = async (box: Sandbox) => ({
  tokens: await rows(box, "SELECT * FROM tokens"),
  grants: await rows(box, "SELECT * FROM token_vaults"),
  file: await readFile(tokenFilePath(box), "utf8").catch(() => undefined),
})

// A refused `token issue`: exit 1, the message, the calls made, and nothing changed.
const assertRefused = async (
  box: Sandbox,
  args: ReadonlyArray<string>,
  message: string,
  calls: ReadonlyArray<ReturnType<typeof call>>,
) => {
  const before = await tokenState(box)
  const result = await admin(box, ["token", "issue", ...args])
  assert.strictEqual(result.code, 1)
  assert.strictEqual(result.stdout, "")
  assert.strictEqual(result.stderr, `hush: ${message}\n`)
  assert.deepStrictEqual(result.calls, calls)
  assert.deepStrictEqual(await tokenState(box), before)
}

const resolve = (box: Sandbox, token: string, references: ReadonlyArray<string>) =>
  box.fetch("/v1/secrets/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ references }),
  })

describe("hush token issue receipts and local checks", () => {
  it("saves over the entry of another Label with --replace, naming it still active with its revoke command", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await admin(box, ["token", "issue", "--label", "work agent", "--read", "Personal", "--replace"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        label: "work agent",
        grants: [{ vault: "Personal", access: "read" }],
        expiresAt: null,
        saved: tokenFilePath(box),
        revokedOnServer: false,
        replacedLocally: "agent on box",
        stillActive: "agent on box",
      })
      assert.strictEqual(
        result.stderr,
        'hush: The Token labelled agent on box, whose saved entry was replaced, is still active on the Server; revoke it with `hush token revoke "agent on box"`.\n',
      )
      const saved = JSON.parse(await readFile(tokenFilePath(box), "utf8"))
      assert.strictEqual(saved.tokens.length, 1)
      assert.strictEqual(saved.tokens[0].label, "work agent")
      seen({ kind: "token", text: saved.tokens[0].token })
    }))

  it("refuses an existing saved entry without --replace before the prompt with TokenAlreadySaved", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefused(
        box,
        ["--label", "other", "--read", "Personal"],
        "A Token for this Server is already saved (Label agent on box); nothing was issued or saved. Pass `--replace`, or `--print` to print the new Token instead.",
        [],
      )
    }))

  it.skipIf(process.getuid?.() === 0)(
    "refuses an unwritable token file before the prompt with FileWriteFailed, suggesting --print",
    () =>
      withSandbox(async (box, seen) => {
        await seeded(box, seen)
        await rm(tokenFilePath(box))
        await chmod(join(box.home, ".config", "hush"), 0o500)

        try {
          await assertRefused(
            box,
            ["--label", "other", "--read", "Personal"],
            `Could not write the token file ${tokenFilePath(box)} (EACCES); nothing was issued and no prompt was shown. Run this command from a CLI machine, or add \`--print\` to print the Token instead of saving it.`,
            [],
          )
        } finally {
          await chmod(join(box.home, ".config", "hush"), 0o700)
        }
      }),
  )

  for (const [args, message] of [
    [
      ["--label", "x", "--read", "Personal", "--create", "PERSONAL", "--print"],
      "Vault PERSONAL is named twice; name each Vault once, with `--read` or `--create`; nothing was issued and no prompt was shown. See `hush token issue --help`.",
    ],
    [
      ["--label", "x", "--print"],
      "Pass at least one `--read <vault>` or `--create <vault>` (or `--keep-grants --replace` to keep the Grants of the Token being replaced); nothing was issued and no prompt was shown. See `hush token issue --help`.",
    ],
    [
      ["--label", "x", "--read", "Personal", "--keep-grants", "--print"],
      "`--keep-grants` copies the Grants of the Token being replaced, so it needs `--replace`; nothing was issued and no prompt was shown. See `hush token issue --help`.",
    ],
    [
      ["--label", "x", "--read", "Personal", "--ttl", "90", "--print"],
      "`--ttl 90` is not a duration such as 90d (a whole number and one of s, m, h, d, w), at most 3650 days; nothing was issued and no prompt was shown. See `hush token issue --help`.",
    ],
    [
      ["--label", "x", "--read", "Personal", "--ttl", "3651d", "--print"],
      "`--ttl 3651d` is not a duration such as 90d (a whole number and one of s, m, h, d, w), at most 3650 days; nothing was issued and no prompt was shown. See `hush token issue --help`.",
    ],
  ] as const) {
    it(`refuses ${args.slice(2).join(" ")} with IssueFlagsInvalid before the prompt`, () =>
      withSandbox(async (box, seen) => {
        await seeded(box, seen)
        await assertRefused(box, args, message, [])
      }))
  }

  it("sets expiresAt from --ttl 1s", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const issued = await issuePrinted(box, seen, ["--label", "brief", "--read", "Personal", "--ttl", "1s"])
      const [row] = await rows(box, "SELECT created_at, expires_at FROM tokens WHERE label = 'brief'")

      const { created_at, expires_at } = Schema.decodeUnknownSync(
        Schema.Struct({ created_at: Schema.String, expires_at: Schema.String }),
      )(row)

      assert.strictEqual(issued.receipt.expiresAt, expires_at)
      assert.strictEqual(Date.parse(expires_at) - Date.parse(created_at), 1000)
    }))
})

// Every file of the database, raw.
const databaseBytes = async (box: Sandbox) =>
  Buffer.concat(
    await Promise.all(
      ["hush.db", "hush.db-wal"].map((name) => readFile(join(box.server.stateDir, name)).catch(() => Buffer.alloc(0))),
    ),
  )

const WrapRow = Schema.Struct({ key_wrapped: Schema.Uint8Array })

describe("hush token issue --replace", () => {
  it("revokes the old Token in the same step, keeps its Grants, and leaves no old wrap in the files", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })

      const oldWraps = Schema.decodeUnknownSync(Schema.Array(WrapRow))(
        await rows(box, "SELECT key_wrapped FROM token_vaults"),
      )

      const replaced = await admin(box, ["token", "issue", "--label", "agent on box", "--keep-grants", "--replace"])
      assert.strictEqual(replaced.code, 0, replaced.stderr)
      assert.deepStrictEqual(JSON.parse(replaced.stdout), {
        label: "agent on box",
        grants: [{ vault: "Personal", access: "read+create" }],
        expiresAt: null,
        saved: tokenFilePath(box),
        revokedOnServer: true,
        replacedLocally: "agent on box",
      })
      assert.strictEqual(replaced.stderr, "")
      assert.deepStrictEqual(replaced.calls, [call("/v1/admin/tokens/issue", 200)])
      const saved = JSON.parse(await readFile(tokenFilePath(box), "utf8")).tokens[0].token
      seen({ kind: "token", text: saved })

      const old = await box.run(["read", first.references[0] ?? ""], { env: { HUSH_TOKEN: first.token } })
      assert.strictEqual(old.code, 1)
      assert.match(old.stderr, /^hush: Token agent on box was revoked at /)
      const fresh = await box.run(["read", first.references[0] ?? ""], { secretStdout: true })
      assert.strictEqual(fresh.code, 0, fresh.stderr)
      assert.strictEqual(fresh.stdout, value)

      const files = await databaseBytes(box)

      for (const { key_wrapped } of oldWraps) assert.strictEqual(files.indexOf(Buffer.from(key_wrapped)), -1)

      const [issueRow] = await rows(
        box,
        "SELECT actor, token_label, action, vaults, detail, outcome, error FROM audit WHERE action = 'token.issue'",
      )

      assert.deepStrictEqual(issueRow, {
        actor: "passphrase",
        token_label: null,
        action: "token.issue",
        vaults: '["Personal"]',
        detail:
          '{"label":"agent on box","grants":[{"vault":"Personal","access":"read+create"}],"expiresAt":null,"replaced":"agent on box"}',
        outcome: "ok",
        error: null,
      })
    }))

  it("says replaced: false when no Token has the Label", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const issued = await issuePrinted(box, seen, ["--label", "new", "--read", "Personal", "--replace"])
      assert.strictEqual(issued.receipt.revokedOnServer, false)
    }))

  it("widens a Token to a new Vault with the Passphrase typed twice in total", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      assert.strictEqual((await admin(box, ["vault", "create", "Work"])).code, 0)

      const widened = await admin(box, [
        "token",
        "issue",
        "--label",
        first.label,
        "--create",
        "Work",
        "--keep-grants",
        "--replace",
      ])

      assert.strictEqual(widened.code, 0, widened.stderr)
      assert.deepStrictEqual(JSON.parse(widened.stdout).grants, [
        { vault: "Personal", access: "read+create" },
        { vault: "Work", access: "read+create" },
      ])
      seen({ kind: "token", text: JSON.parse(await readFile(tokenFilePath(box), "utf8")).tokens[0].token })

      const created = await box.run(["create", "api-credential", "--title", "Office", "--vault", "Work", "--stdin"], {
        input: "work value\n",
      })

      assert.strictEqual(created.code, 0, created.stderr)
      const read = await box.run(["read", first.references[0] ?? ""], { secretStdout: true })
      assert.strictEqual(read.stdout, value)
      const passphraseRows = await rows(box, "SELECT action FROM audit WHERE actor = 'passphrase' ORDER BY id")
      assert.deepStrictEqual(passphraseRows, [{ action: "vault.create" }, { action: "token.issue" }])
    }))

  it("overrides a kept Grant's Access with an explicit flag", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const issued = await issuePrinted(box, seen, [
        "--label",
        "agent on box",
        "--read",
        "Personal",
        "--keep-grants",
        "--replace",
      ])

      assert.deepStrictEqual(issued.receipt.grants, [{ vault: "Personal", access: "read" }])
    }))
})

describe("tokens/issue refusals", () => {
  it("refuses 65 Grants with LimitExceeded, issuing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const reads = Array.from({ length: 65 }, (_, index) => ["--read", `Vault ${index}`]).flat()
      await assertRefused(
        box,
        ["--label", "wide", ...reads, "--print"],
        "A Token can hold at most 64 Grants; nothing was issued. Grant fewer Vaults (with `--keep-grants`, the kept Grants count too).",
        [call("/v1/admin/tokens/issue", 400)],
      )
    }))

  it("refuses a Vault that does not exist with VaultNotFound", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefused(
        box,
        ["--label", "x", "--read", "Nope", "--print"],
        "Vault Nope does not exist on this Server; nothing was changed. `hush vault list` shows the Vaults.",
        [call("/v1/admin/tokens/issue", 404)],
      )
    }))

  it("refuses the Label of an active Token without --replace with TokenLabelExists", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefused(
        box,
        ["--label", "AGENT ON BOX", "--read", "Personal", "--print"],
        "A Token labelled AGENT ON BOX already exists (active or expired); nothing was issued. To replace it in one step, add `--replace` (and `--keep-grants` to keep its Grants), or choose another Label.",
        [call("/v1/admin/tokens/issue", 409)],
      )
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "passphrase",
        token_label: null,
        action: "token.issue",
        vaults: '["Personal"]',
        detail: '{"label":"AGENT ON BOX"}',
        outcome: "error",
        error: "TokenLabelExists",
      })
    }))

  it("refuses --keep-grants with no Token to replace with TokenNotFound", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefused(
        box,
        ["--label", "nobody", "--keep-grants", "--replace", "--print"],
        "No unrevoked Token is labelled nobody; nothing was revoked or issued. `hush token list` shows Tokens.",
        [call("/v1/admin/tokens/issue", 404)],
      )
    }))
})

describe("Grant enforcement", () => {
  it("refuses a Vault outside several Grants, suggesting only a granted name", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      for (const name of ["Shared", "Work"]) assert.strictEqual((await admin(box, ["vault", "create", name])).code, 0)
      const issued = await issuePrinted(box, seen, ["--label", "a", "--read", "Personal", "--create", "Shared"])
      const env = { HUSH_TOKEN: issued.receipt.token }
      const typo = await box.run(["read", "hush://Sharde/Key/credential"], { env })
      assert.strictEqual(typo.code, 1)
      assert.strictEqual(
        typo.stderr,
        'hush: Token a is not granted Vault Sharde; nothing was read or changed. Did you mean Shared? It is granted: Personal (read), Shared (read+create). If Sharde is right, ask the human to run: `hush token issue --label "a" --read Sharde --keep-grants --replace --print`, then put the printed Token in `HUSH_TOKEN`.\n',
      )
      // `Work` exists and is one edit from `Wirk`, but is not granted, so it is never named.
      const other = await box.run(["read", "hush://Wirk/Key/credential"], { env })
      assert.strictEqual(
        other.stderr,
        'hush: Token a is not granted Vault Wirk; nothing was read or changed. It is granted: Personal (read), Shared (read+create). If Wirk is right, ask the human to run: `hush token issue --label "a" --read Wirk --keep-grants --replace --print`, then put the printed Token in `HUSH_TOKEN`.\n',
      )
      assert.deepStrictEqual(other.calls, [call("/v1/secrets/resolve", 403)])
    }))

  it("resolves a cross-Vault template with one Token in one secrets/resolve", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Home", value }] })
      assert.strictEqual((await admin(box, ["vault", "create", "Work"])).code, 0)
      const issued = await issuePrinted(box, seen, ["--label", "both", "--read", "Personal", "--create", "Work"])

      const created = await box.run(["create", "api-credential", "--title", "Office", "--vault", "Work", "--stdin"], {
        input: "work value\n",
        env: { HUSH_TOKEN: issued.receipt.token },
      })

      assert.strictEqual(created.code, 0, created.stderr)

      const response = await resolve(box, issued.receipt.token, [
        "hush://Personal/Home/credential",
        "hush://Work/Office/credential",
      ])

      assert.strictEqual(response.status, 200)

      const body = Schema.decodeUnknownSync(
        Schema.Struct({ values: Schema.Array(Schema.Struct({ reference: Schema.String, value: Schema.String })) }),
      )(await response.json())

      assert.deepStrictEqual(
        body.values.map(({ value: resolved }) => resolved),
        [value, "work value"],
      )
    }))

  it("fails resolve with IntegrityCheckFailed after a Grant's access is changed in the file", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const issued = await issuePrinted(box, seen, ["--label", "reader", "--read", "Personal"])
      await box.inspect((db) =>
        db.run(
          "UPDATE token_vaults SET access = 'read+create' WHERE token_id = (SELECT id FROM tokens WHERE label = 'reader')",
        ),
      )

      const result = await box.run(["read", "hush://Personal/Key/credential"], {
        env: { HUSH_TOKEN: issued.receipt.token },
      })

      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        'hush: Stored data for Vault Personal failed its integrity check, so the database file was modified or corrupted; nothing was returned or changed. Restore the Server from a backup: see "Backup and restore" in the hush README.\n',
      )
    }))

  it("refuses create under a Read Grant with CreateNotAllowed, audited denied, creating nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const issued = await issuePrinted(box, seen, ["--label", "reader", "--read", "Personal"])
      const items = await rows(box, "SELECT id FROM items")

      const result = await box.run(["create", "api-credential", "--title", "Key", "--vault", "Personal", "--stdin"], {
        input: `${value}\n`,
        env: { HUSH_TOKEN: issued.receipt.token },
      })

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        'hush: Token reader has Read Access to Vault Personal, which cannot create Items; nothing was created. Ask the human to run: `hush token issue --label "reader" --create Personal --keep-grants --replace --print`, then put the printed Token in `HUSH_TOKEN`.\n',
      )
      assert.deepStrictEqual(result.calls, [call("/v1/items/create", 403)])
      assert.deepStrictEqual(await rows(box, "SELECT id FROM items"), items)
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "token",
        token_label: "reader",
        action: "items.create",
        vaults: '["Personal"]',
        detail: '{"title":"Key","fields":["credential"]}',
        outcome: "denied",
        error: "CreateNotAllowed",
      })
    }))
})

const TimesRow = Schema.Struct({
  label: Schema.String,
  created_at: Schema.String,
  expires_at: Schema.NullOr(Schema.String),
  revoked_at: Schema.NullOr(Schema.String),
  last_used_at: Schema.NullOr(Schema.String),
})

// The stored timestamps of the Token labelled `label`.
const timesOf = async (box: Sandbox, label: string) => {
  const found = await box.inspect((db) =>
    db.query("SELECT label, created_at, expires_at, revoked_at, last_used_at FROM tokens WHERE label = ?").all(label),
  )

  const [row] = Schema.decodeUnknownSync(Schema.Array(TimesRow))(found)

  if (row === undefined) throw new Error(`no Token labelled ${label}`)

  return row
}

describe("hush token list", () => {
  it("lists every Token newest first with its Grants, times and state, audited under the Passphrase", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await issuePrinted(box, seen, ["--label", "reader", "--read", "Personal", "--ttl", "90d"])
      const result = await admin(box, ["token", "list"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, [call("/v1/admin/tokens/list", 200)])
      const reader = await timesOf(box, "reader")
      const agent = await timesOf(box, "agent on box")
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        tokens: [
          {
            label: "reader",
            grants: [{ vault: "Personal", access: "read" }],
            createdAt: reader.created_at,
            expiresAt: reader.expires_at,
            revokedAt: null,
            lastUsedAt: null,
            state: "active",
          },
          {
            label: "agent on box",
            grants: [{ vault: "Personal", access: "read+create" }],
            createdAt: agent.created_at,
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
            state: "active",
          },
        ],
      })
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "passphrase",
        token_label: null,
        action: "token.list",
        vaults: "[]",
        detail: null,
        outcome: "ok",
        error: null,
      })
    }))
})

const DeniedRow = Schema.Struct({
  action: Schema.String,
  count: Schema.Number,
  at: Schema.String,
  last_at: Schema.String,
  outcome: Schema.String,
  error: Schema.NullOr(Schema.String),
})

// The Token-actor audit rows, oldest first.
const tokenRows = async (box: Sandbox) =>
  Schema.decodeUnknownSync(Schema.Array(DeniedRow))(
    await rows(box, "SELECT action, count, at, last_at, outcome, error FROM audit WHERE actor = 'token' ORDER BY id"),
  )

describe("denied requests from a dead Token", () => {
  it("coalesces 100 requests from a revoked Token within a minute into one row with count 100", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen)
      assert.strictEqual((await admin(box, ["token", "revoke", first.label])).code, 0)

      for (let index = 0; index < 100; index += 1) {
        const response = await resolve(box, first.token, ["hush://Personal/Key/credential"])
        assert.strictEqual(response.status, 401)
      }

      const denied = await tokenRows(box)
      assert.strictEqual(denied.length, 1)
      const [row] = denied
      assert.deepStrictEqual(
        { action: row?.action, count: row?.count, outcome: row?.outcome, error: row?.error },
        { action: "secrets.resolve", count: 100, outcome: "denied", error: "TokenRejected" },
      )
      assert.strictEqual((await timesOf(box, first.label)).last_used_at, row?.last_at)
    }))

  // A 5 s TTL, not 1 s: the first read must land before expiry even when a loaded machine takes seconds to start
  // the CLI process; the wait after it runs to the Server's own `expiresAt`, so the test stays as short as it can.
  it("resolves with a --ttl 5s Token once, then refuses it as expired, audited denied, listed expired", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const issued = await issuePrinted(box, seen, ["--label", "brief", "--read", "Personal", "--ttl", "5s"])
      const env = { HUSH_TOKEN: issued.receipt.token }
      const fresh = await box.run(["read", "hush://Personal/Key/credential"], { env, secretStdout: true })
      assert.strictEqual(fresh.code, 0, fresh.stderr)
      const expiresAt = issued.receipt.expiresAt ?? ""
      await new Promise((wait) => setTimeout(wait, Math.max(0, Date.parse(expiresAt) - Date.now() + 50)))
      const late = await box.run(["read", "hush://Personal/Key/credential"], { env })
      assert.strictEqual(late.code, 1)
      assert.strictEqual(late.stdout, "")
      assert.strictEqual(
        late.stderr,
        `hush: Token brief was expired at ${expiresAt}; nothing was read. Ask the human to issue a new Token (\`hush token issue\`), then run \`hush token save --replace\` or update \`HUSH_TOKEN\`.\n`,
      )
      assert.deepStrictEqual(
        (await tokenRows(box)).slice(-2).map(({ outcome, error }) => ({ outcome, error })),
        [
          { outcome: "ok", error: null },
          { outcome: "denied", error: "TokenRejected" },
        ],
      )
      const listed = JSON.parse((await admin(box, ["token", "list"])).stdout)
      assert.strictEqual(listed.tokens[0].state, "expired")
    }))

  it("never coalesces an active Token's denials, and moves last_used_at with each row", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen)

      for (let index = 0; index < 2; index += 1) {
        const response = await resolve(box, first.token, ["hush://Work/Key/credential"])
        assert.strictEqual(response.status, 403)
      }

      const denied = await tokenRows(box)
      assert.deepStrictEqual(
        denied.map(({ count, error }) => ({ count, error })),
        [
          { count: 1, error: "VaultNotGranted" },
          { count: 1, error: "VaultNotGranted" },
        ],
      )
      assert.strictEqual((await timesOf(box, first.label)).last_used_at, denied[1]?.at)
    }))
})

describe("hush token status", () => {
  it("shows the saved Token's Label, Grants and times through token/describe, audited under the Token", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen)
      const result = await box.run(["token", "status"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, [call("/v1/token/describe", 200)])
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        label: first.label,
        grants: [{ vault: "Personal", access: "read+create" }],
        createdAt: (await timesOf(box, first.label)).created_at,
        expiresAt: null,
        source: "file",
      })
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "token",
        token_label: first.label,
        action: "token.describe",
        vaults: "[]",
        detail: null,
        outcome: "ok",
        error: null,
      })
      const [audit] = await rows(box, "SELECT last_at FROM audit ORDER BY id DESC LIMIT 1")
      assert.deepStrictEqual(audit, { last_at: (await timesOf(box, first.label)).last_used_at })
    }))

  it("says source env for a HUSH_TOKEN Token, and its expiry", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const issued = await issuePrinted(box, seen, ["--label", "brief", "--read", "Personal", "--ttl", "1h"])
      const result = await box.run(["token", "status"], { env: { HUSH_TOKEN: issued.receipt.token } })
      assert.strictEqual(result.code, 0, result.stderr)
      const shown = JSON.parse(result.stdout)
      assert.deepStrictEqual(
        { label: shown.label, expiresAt: shown.expiresAt, source: shown.source },
        { label: "brief", expiresAt: issued.receipt.expiresAt, source: "env" },
      )
    }))

  it("refuses a revoked saved Token with TokenRejected naming its Label", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen)
      const revoked = await admin(box, ["token", "revoke", first.label])
      const { revokedAt } = Schema.decodeUnknownSync(RevokeReceipt)(revoked.stdout)
      const result = await box.run(["token", "status"], { env: { HUSH_TOKEN: first.token } })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        `hush: Token ${first.label} was revoked at ${revokedAt}; nothing was read. Ask the human to issue a new Token (\`hush token issue\`), then run \`hush token save --replace\` or update \`HUSH_TOKEN\`.\n`,
      )
      assert.deepStrictEqual(result.calls, [call("/v1/token/describe", 401)])
    }))
})

const savedTokens = async (box: Sandbox) => JSON.parse(await readFile(tokenFilePath(box), "utf8")).tokens

describe("hush token save and forget", () => {
  it("saves a --print receipt piped to --stdin --replace after one token/describe, then reads with it", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const issued = await issuePrinted(box, seen, ["--label", "reader", "--read", "Personal", "--ttl", "90d"])
      const result = await box.run(["token", "save", "--stdin", "--replace"], { input: issued.stdout })
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, [call("/v1/token/describe", 200)])
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        saved: tokenFilePath(box),
        label: "reader",
        grants: [{ vault: "Personal", access: "read" }],
        expiresAt: issued.receipt.expiresAt,
        replaced: first.label,
      })
      assert.deepStrictEqual(await savedTokens(box), [
        { server: box.server.url, label: "reader", token: issued.receipt.token },
      ])
      const read = await box.run(["read", first.references[0] ?? ""], { secretStdout: true })
      assert.strictEqual(read.stdout, value)
    }))

  it("saves a bare Token after forget, which drops the entry without contacting the Server", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen)
      const forgotten = await box.run(["token", "forget"])
      assert.strictEqual(forgotten.code, 0, forgotten.stderr)
      assert.deepStrictEqual(forgotten.calls, [])
      assert.deepStrictEqual(JSON.parse(forgotten.stdout), { forgotten: true, label: first.label, revoked: false })
      assert.deepStrictEqual(await savedTokens(box), [])
      const listed = JSON.parse((await admin(box, ["token", "list"])).stdout)
      assert.strictEqual(listed.tokens[0].state, "active")

      const saved = await box.run(["token", "save", "--stdin"], { input: ` ${first.token}\n` })
      assert.strictEqual(saved.code, 0, saved.stderr)
      assert.deepStrictEqual(JSON.parse(saved.stdout), {
        saved: tokenFilePath(box),
        label: first.label,
        grants: [{ vault: "Personal", access: "read+create" }],
        expiresAt: null,
      })
      assert.deepStrictEqual(await savedTokens(box), [
        { server: box.server.url, label: first.label, token: first.token },
      ])
    }))

  it("refuses to save over an existing entry without --replace with TokenAlreadySaved, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const issued = await issuePrinted(box, seen, ["--label", "reader", "--read", "Personal"])
      const before = await tokenState(box)
      const result = await box.run(["token", "save", "--stdin"], { input: issued.stdout })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: A Token for this Server is already saved (Label agent on box); nothing was saved. Pass `--replace` to replace it.\n",
      )
      assert.deepStrictEqual(result.calls, [])
      assert.deepStrictEqual(await tokenState(box), before)
    }))

  it("refuses input that is neither a Token nor a receipt with TokenInputInvalid, with no request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      for (const input of [`${value}\n`, '{"token":"hush_short"}\n', "[1]\n"]) {
        const before = await tokenState(box)
        const result = await box.run(["token", "save", "--stdin", "--replace"], { input })
        assert.strictEqual(result.code, 1)
        assert.strictEqual(
          result.stderr,
          "hush: The input is not a hush Token (expected `hush_` and 43 characters) or a `hush token issue --print` receipt; nothing was saved.\n",
        )
        assert.deepStrictEqual(result.calls, [])
        assert.deepStrictEqual(await tokenState(box), before)
      }
    }))

  it("refuses a Token the Server does not know with TokenRejected unknown, saving nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await tokenState(box)
      const stranger = `hush_${Buffer.alloc(32, 7).toString("base64url")}`
      const result = await box.run(["token", "save", "--stdin", "--replace"], { input: stranger })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: This Server does not know the Token (issued by another Server, or the Server was restored from an older backup); nothing was read. Ask the human for a new Token.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/token/describe", 401)])
      assert.deepStrictEqual(await tokenState(box), before)
    }))

  it("forgets nothing when no Token is saved for this Server, with NoToken", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      assert.strictEqual((await box.run(["token", "forget"])).code, 0)
      const again = await box.run(["token", "forget"])
      assert.strictEqual(again.code, 1)
      assert.match(again.stderr, /^hush: No hush Token is available for /)
      assert.deepStrictEqual(again.calls, [])
    }))
})

describe("Token selection through the seam", () => {
  it("runs create and read with the Owner's Init-saved Token and no Passphrase", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const created = await box.run(["create", "api-credential", "--title", "Key", "--vault", "Personal", "--stdin"], {
        input: `${value}\n`,
      })

      assert.strictEqual(created.code, 0, created.stderr)
      assert.deepStrictEqual(created.calls, [call("/v1/items/create", 200), call("/v1/secrets/resolve", 200)])
      const read = await box.run(["read", "hush://Personal/Key/credential"], { secretStdout: true })
      assert.strictEqual(read.stdout, value)
      assert.deepStrictEqual(read.calls, [call("/v1/secrets/resolve", 200)])
    }))

  const reading = ["read", "hush://Personal/Key/credential"] as const

  // A refused Token command: exit 1, the message, no request, and nothing changed.
  const assertSelectionRefused = async (box: Sandbox, message: string, env?: Record<string, string>) => {
    const before = await tokenState(box)
    const result = await box.run(reading, env === undefined ? {} : { env })
    assert.strictEqual(result.code, 1)
    assert.strictEqual(result.stdout, "")
    assert.strictEqual(result.stderr, `hush: ${message}\n`)
    assert.deepStrictEqual(result.calls, [])
    assert.deepStrictEqual(await tokenState(box), before)
  }

  it("refuses a group-readable token file with TokenFileInsecure naming the path, the mode and chmod 600", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await chmod(tokenFilePath(box), 0o640)
      const file = tokenFilePath(box)
      await assertSelectionRefused(
        box,
        `The token file ${file} has mode 640, so other users may read its Token; nothing was read. Run \`chmod 600 ${file}\` and Revoke the Token if it may have been copied.`,
      )
    }))

  it("refuses an invalid token file with TokenFileInvalid, trying no other source", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await Bun.write(tokenFilePath(box), '{"version":1,"tokens":"no"}')
      await assertSelectionRefused(
        box,
        `Could not read the token file ${tokenFilePath(box)} (not a hush token file); nothing was read and no other Token was tried. Fix or remove the file, or set \`HUSH_TOKEN\`.`,
      )
    }))

  it("refuses an invalid HUSH_TOKEN with TokenEnvInvalid, never falling back to the saved Token", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertSelectionRefused(
        box,
        "`HUSH_TOKEN` does not hold a hush Token (expected `hush_` and 43 characters); nothing was read and the token file was not tried. Fix or unset it.",
        { HUSH_TOKEN: "hush_not-a-token" },
      )
    }))
})

const RevokeReceipt = Schema.fromJsonString(
  Schema.Struct({
    label: Schema.String,
    revoked: Schema.Literal(true),
    revokedAt: Schema.String,
    forgotLocally: Schema.Boolean,
  }),
)

describe("hush token revoke", () => {
  it("keeps the row, removes the wraps from the files and the local entry, and refuses later uses as denied", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })

      const oldWraps = Schema.decodeUnknownSync(Schema.Array(WrapRow))(
        await rows(box, "SELECT key_wrapped FROM token_vaults"),
      )

      const hash = await rows(box, "SELECT hash FROM tokens")
      const result = await admin(box, ["token", "revoke", "AGENT ON BOX"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/tokens/revoke", 200)])
      const receipt = Schema.decodeUnknownSync(RevokeReceipt)(result.stdout)
      const stored = await timesOf(box, "agent on box")
      assert.deepStrictEqual(receipt, {
        label: "agent on box",
        revoked: true,
        revokedAt: stored.revoked_at ?? "",
        forgotLocally: true,
      })
      assert.deepStrictEqual(JSON.parse(await readFile(tokenFilePath(box), "utf8")), { version: 1, tokens: [] })
      assert.deepStrictEqual(await rows(box, "SELECT hash FROM tokens"), hash)
      assert.deepStrictEqual(await rows(box, "SELECT key_nonce, key_wrapped, access FROM token_vaults"), [
        { key_nonce: null, key_wrapped: null, access: "read+create" },
      ])
      const files = await databaseBytes(box)

      for (const { key_wrapped } of oldWraps) assert.strictEqual(files.indexOf(Buffer.from(key_wrapped)), -1)
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "passphrase",
        token_label: null,
        action: "token.revoke",
        vaults: "[]",
        detail: '{"label":"agent on box"}',
        outcome: "ok",
        error: null,
      })

      const later = await box.run(["read", first.references[0] ?? ""], { env: { HUSH_TOKEN: first.token } })
      assert.strictEqual(later.code, 1)
      assert.strictEqual(
        later.stderr,
        `hush: Token agent on box was revoked at ${receipt.revokedAt}; nothing was read. Ask the human to issue a new Token (\`hush token issue\`), then run \`hush token save --replace\` or update \`HUSH_TOKEN\`.\n`,
      )
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "token",
        token_label: "agent on box",
        action: "secrets.resolve",
        vaults: "[]",
        detail: null,
        outcome: "denied",
        error: "TokenRejected",
      })

      const listed = await admin(box, ["token", "list"])
      assert.deepStrictEqual(JSON.parse(listed.stdout).tokens, [
        {
          label: "agent on box",
          grants: [{ vault: "Personal", access: "read+create" }],
          createdAt: stored.created_at,
          expiresAt: null,
          revokedAt: receipt.revokedAt,
          lastUsedAt: (await timesOf(box, "agent on box")).last_used_at,
          state: "revoked",
        },
      ])
    }))

  it("keeps the saved entry of another Label and says forgotLocally: false", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await issuePrinted(box, seen, ["--label", "reader", "--read", "Personal"])
      const file = await readFile(tokenFilePath(box), "utf8")
      const result = await admin(box, ["token", "revoke", "reader"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(Schema.decodeUnknownSync(RevokeReceipt)(result.stdout).forgotLocally, false)
      assert.strictEqual(await readFile(tokenFilePath(box), "utf8"), file)
    }))

  it("still reports a Revoke whose saved entry cannot be removed, with the reason on stderr", () =>
    withSandbox(async (box, seen) => {
      const first = await seeded(box, seen)
      await chmod(tokenFilePath(box), 0o644)
      const file = await readFile(tokenFilePath(box), "utf8")
      const result = await admin(box, ["token", "revoke", first.label])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(Schema.decodeUnknownSync(RevokeReceipt)(result.stdout).forgotLocally, false)
      assert.strictEqual(
        result.stderr,
        `hush: The Token was revoked, but its saved entry was not removed: The token file ${tokenFilePath(box)} has mode 644, so other users may read its Token; nothing was read. Run \`chmod 600 ${tokenFilePath(box)}\` and Revoke the Token if it may have been copied.\n`,
      )
      assert.strictEqual(await readFile(tokenFilePath(box), "utf8"), file)
      assert.strictEqual((await timesOf(box, first.label)).revoked_at === null, false)
    }))

  it("refuses an already revoked Label with TokenNotFound, changing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await issuePrinted(box, seen, ["--label", "reader", "--read", "Personal"])
      assert.strictEqual((await admin(box, ["token", "revoke", "reader"])).code, 0)
      const before = await tokenState(box)
      const result = await admin(box, ["token", "revoke", "reader"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: No unrevoked Token is labelled reader; nothing was revoked or issued. `hush token list` shows Tokens.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/tokens/revoke", 404)])
      assert.deepStrictEqual(await tokenState(box), before)
      assert.deepStrictEqual(await lastAudit(box), {
        actor: "passphrase",
        token_label: null,
        action: "token.revoke",
        vaults: "[]",
        detail: '{"label":"reader"}',
        outcome: "error",
        error: "TokenNotFound",
      })
    }))

  it("lets a Vault go once its Tokens are revoked and its Items gone, still listing their Grants", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      assert.strictEqual((await admin(box, ["vault", "create", "Work"])).code, 0)
      await issuePrinted(box, seen, ["--label", "worker", "--create", "Work", "--read", "Personal"])
      assert.strictEqual((await admin(box, ["token", "revoke", "worker"])).code, 0)
      const deleted = await admin(box, ["vault", "delete", "Work"])
      assert.strictEqual(deleted.code, 0, deleted.stderr)
      const listed = JSON.parse((await admin(box, ["token", "list"])).stdout)
      assert.deepStrictEqual(
        listed.tokens.map(({ label, grants, state }: { label: string; grants: unknown; state: string }) => ({
          label,
          grants,
          state,
        })),
        [
          { label: "worker", grants: [{ vault: "Personal", access: "read" }], state: "revoked" },
          { label: "agent on box", grants: [{ vault: "Personal", access: "read+create" }], state: "active" },
        ],
      )
    }))
})
