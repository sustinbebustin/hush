import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { onPty, sandbox, type Sandbox } from "./sandbox.js"

// `hush item create` through the seam: the Owner creates an Item with the Passphrase, verified before commit by
// `admin/items/create`, and a Token then reads it.

const passphrase = passphraseSentinel.text
const value = valueSentinel.text
// A plain Field's value: sealed like any value, so it must not leak either.
const plainValue = "fictional-plain-username-8Lm"

const AuditRow = Schema.Struct({
  actor: Schema.String,
  action: Schema.String,
  vaults: Schema.String,
  refs: Schema.String,
  detail: Schema.NullOr(Schema.String),
  outcome: Schema.String,
  error: Schema.NullOr(Schema.String),
})

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in.
const withSandbox = async (test: (box: Sandbox, seen: (sentinel: Sentinel) => void) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, passphraseSentinel, { kind: "value", text: plainValue }]

  try {
    await test(box, (sentinel) => sentinels.push(sentinel))
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

// `seed` with no Items: Vault Personal and a Read+Create Token for it, Token and Init code registered as sentinels.
const seeded = async (box: Sandbox, seen: (sentinel: Sentinel) => void) => {
  const code = await box.server.initCode()

  if (code !== undefined) seen({ kind: "initCode", text: code })

  const result = await box.seed()
  seen({ kind: "token", text: result.token })

  return result
}

const call = (path: string, status: number) => ({ method: "POST", path, status })
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// `hush item create` with the Passphrase line piped to `--passphrase-stdin`, then `rest` (an `--stdin` value).
const itemCreate = (box: Sandbox, args: ReadonlyArray<string>, rest = "") =>
  box.run(["item", "create", ...args, "--passphrase-stdin"], { input: `${passphrase}\n${rest}` })

const read = (box: Sandbox, reference: string) => box.run(["read", reference], { secretStdout: true })

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())

const itemRows = (box: Sandbox) => rows(box, "SELECT title, kind FROM items ORDER BY id")

const lastAudit = async (box: Sandbox) =>
  Schema.decodeUnknownSync(Schema.Array(AuditRow))(
    await rows(box, "SELECT actor, action, vaults, refs, detail, outcome, error FROM audit ORDER BY id"),
  ).at(-1)

describe("hush item create", () => {
  it("creates an api-credential verified before commit, and a Token reads it", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await itemCreate(
        box,
        ["api-credential", "--vault", "personal", "--title", "Stripe", "--stdin"],
        `${value}\n`,
      )

      assert.strictEqual(result.code, 0, result.stderr)
      const receipt = JSON.parse(result.stdout)
      assert.deepStrictEqual(Object.keys(receipt), ["vault", "title", "kind", "fields", "createdAt", "verified"])
      assert.deepStrictEqual(
        { ...receipt, createdAt: undefined },
        {
          vault: "Personal",
          title: "Stripe",
          kind: "api-credential",
          fields: [{ label: "credential", concealed: true, ref: "hush://Personal/Stripe/credential" }],
          createdAt: undefined,
          verified: true,
        },
      )
      assert.match(receipt.createdAt, isoTime)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/create", 200)])
      const resolved = await read(box, "hush://Personal/Stripe/credential")
      assert.strictEqual(resolved.code, 0, resolved.stderr)
      assert.strictEqual(resolved.stdout, value)
    }))

  const kinds = [
    {
      name: "login with username and notes",
      kind: "login",
      title: "GitHub",
      plain: { username: plainValue, notes: "fictional note" },
      fields: ["password", "username", "notes"],
    },
    {
      name: "database with every plain Field",
      kind: "database",
      title: "App DB",
      plain: { notes: "n", database: "app", port: "5432", host: "db.internal", username: plainValue },
      fields: ["password", "username", "host", "port", "database", "notes"],
    },
  ] as const

  for (const created of kinds)
    it(`creates a ${created.name}: Fields in Kind order, inventory lists it, a Token reads every Field`, () =>
      withSandbox(async (box, seen) => {
        await seeded(box, seen)
        const plainFlags = Object.entries(created.plain).flatMap(([label, text]) => [`--${label}`, text])

        const result = await itemCreate(
          box,
          [created.kind, "--vault", "Personal", "--title", created.title, "--stdin", ...plainFlags],
          `${value}\n`,
        )

        assert.strictEqual(result.code, 0, result.stderr)
        const refs = created.fields.map((label) => `hush://Personal/${created.title}/${label}`)

        assert.deepStrictEqual(
          JSON.parse(result.stdout).fields,
          created.fields.map((label, index) => ({ label, concealed: index === 0, ref: refs[index] })),
        )

        const inventory = await box.run(["inventory"])
        assert.strictEqual(inventory.code, 0, inventory.stderr)

        assert.deepStrictEqual(
          JSON.parse(inventory.stdout).items.map(({ title, kind }: { title: string; kind: string }) => ({
            title,
            kind,
          })),
          [{ title: created.title, kind: created.kind }],
        )

        const expected: Record<string, string> = { ...created.plain, password: value }

        for (const [index, label] of created.fields.entries()) {
          const resolved = await read(box, refs[index] ?? "")
          assert.strictEqual(resolved.code, 0, resolved.stderr)
          assert.strictEqual(resolved.stdout, expected[label])
        }
      }))

  it("writes one item.create row: actor passphrase, the Vault and the title and labels only", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await itemCreate(box, ["login", "--vault", "personal", "--title", "GitHub", "--stdin", "--username", "u"], value)

      assert.deepStrictEqual(await lastAudit(box), {
        actor: "passphrase",
        action: "item.create",
        vaults: '["Personal"]',
        refs: "[]",
        detail: JSON.stringify({ title: "GitHub", fields: ["password", "username"] }),
        outcome: "ok",
        error: null,
      })
    }))
})

// A Passphrase command's refusal as the audit row records it.
const errorRow = (vault: string, detail: object, error: string) => ({
  actor: "passphrase",
  action: "item.create",
  vaults: JSON.stringify([vault]),
  refs: "[]",
  detail: JSON.stringify(detail),
  outcome: "error",
  error,
})

const titleRetired = (title: string) =>
  `hush: The title ${title} in Vault Personal was freed by a rename or delete, and Tokens cannot reuse it until the human releases it; nothing was created. Choose another title, or ask the human to run \`hush item release Personal "${title}"\`.\n`

describe("a refused hush item create creates nothing", () => {
  it("refuses a taken title with ItemExists, audited error", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await itemCreate(box, ["api-credential", "--vault", "Personal", "--title", "Stripe", "--stdin"], value)
      const before = await itemRows(box)
      const result = await itemCreate(box, ["login", "--vault", "Personal", "--title", "STRIPE", "--stdin"], value)
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        'hush: An Item titled STRIPE already exists in Vault Personal; nothing was created or overwritten. Run hush find "STRIPE" --vault Personal, or choose another title.\n',
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/create", 409)])
      assert.deepStrictEqual(await itemRows(box), before)
      assert.deepStrictEqual(
        await lastAudit(box),
        errorRow("Personal", { title: "STRIPE", fields: ["password"] }, "ItemExists"),
      )
    }))

  it("refuses a Retired title with TitleRetired as for a Token, and creates it once released", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await itemCreate(box, ["api-credential", "--vault", "Personal", "--title", "Stripe", "--stdin"], value)
      await box.run(["item", "delete", "Personal", "Stripe", "--passphrase-stdin"], { input: `${passphrase}\n` })
      const args = ["api-credential", "--vault", "Personal", "--title", "stripe", "--stdin"]
      const refused = await itemCreate(box, args, value)
      assert.strictEqual(refused.code, 1)
      assert.strictEqual(refused.stdout, "")
      assert.strictEqual(refused.stderr, titleRetired("stripe"))
      assert.deepStrictEqual(refused.calls, [call("/v1/admin/items/create", 409)])
      assert.deepStrictEqual(await itemRows(box), [])

      assert.deepStrictEqual(
        await lastAudit(box),
        errorRow("Personal", { title: "stripe", fields: ["credential"] }, "TitleRetired"),
      )

      await box.run(["item", "release", "Personal", "Stripe", "--passphrase-stdin"], { input: `${passphrase}\n` })
      const created = await itemCreate(box, args, value)
      assert.strictEqual(created.code, 0, created.stderr)
    }))

  it("refuses a wrong Passphrase with PassphraseIncorrect, audited denied", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await box.run(
        [
          "item",
          "create",
          "api-credential",
          "--vault",
          "Personal",
          "--title",
          "Stripe",
          "--stdin",
          "--passphrase-stdin",
        ],
        { input: `wrong passphrase entirely\n${value}` },
      )

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.match(result.stderr, /^hush: The Passphrase is incorrect; nothing was changed\./)
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/create", 401)])
      assert.deepStrictEqual(await itemRows(box), [])

      assert.deepStrictEqual(await lastAudit(box), {
        ...errorRow("Personal", { title: "Stripe", fields: ["credential"] }, "PassphraseIncorrect"),
        outcome: "denied",
      })
    }))

  it("refuses a plain flag outside the Kind with UnknownField before any prompt or request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await itemCreate(box, [
        "api-credential",
        "--vault",
        "Personal",
        "--title",
        "S",
        "--stdin",
        "--host",
        "h",
      ])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: api-credential Items have no Field host; nothing was changed. Allowed: notes.\n",
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it("refuses a value holding NUL with InvalidValue before any request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await itemCreate(box, ["api-credential", "--vault", "Personal", "--title", "S", "--stdin"], "a\0b")
      assert.strictEqual(result.code, 1)
      assert.include(result.stderr, "nothing was created")
      assert.deepStrictEqual(result.calls, [])
    }))

  it("refuses a missing Vault with VaultNotFound, audited error", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await itemCreate(box, ["api-credential", "--vault", "Nope", "--title", "S", "--stdin"], value)
      assert.strictEqual(result.code, 1)
      assert.include(result.stderr, "hush: Vault Nope does not exist on this Server; nothing was changed.")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/create", 404)])
      assert.deepStrictEqual(
        await lastAudit(box),
        errorRow("Nope", { title: "S", fields: ["credential"] }, "VaultNotFound"),
      )
    }))

  it("refuses with InputSourceRequired before any prompt or request when no value source is given", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await itemCreate(box, ["api-credential", "--vault", "Personal", "--title", "S"])
      assert.strictEqual(result.code, 1)
      assert.include(result.stderr, "nothing was created")
      assert.deepStrictEqual(result.calls, [])
    }))
})

const post = (box: Sandbox, body: object, headers: Record<string, string> = {}) =>
  box.fetch("/v1/admin/items/create", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

const errorTag = async (response: Response) =>
  Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))(await response.json())._tag

describe("admin/items/create over HTTP", () => {
  const refusals = [
    {
      name: "FieldRequired without the Kind's primary Field",
      fields: [{ label: "notes", value: "n" }],
      status: 400,
      tag: "FieldRequired",
    },
    {
      name: "UnknownField for a label outside the Kind",
      fields: [
        { label: "credential", value },
        { label: "host", value: "h" },
      ],
      status: 400,
      tag: "UnknownField",
    },
    {
      name: "InvalidValue for an empty value",
      fields: [{ label: "credential", value: "" }],
      status: 400,
      tag: "InvalidValue",
    },
    {
      name: "InvalidName for a title that is not a Name",
      title: "-bad",
      fields: [{ label: "credential", value }],
      status: 400,
      tag: "InvalidName",
    },
  ] as const

  for (const refusal of refusals)
    it(`refuses ${refusal.name}, creating nothing`, () =>
      withSandbox(async (box, seen) => {
        await seeded(box, seen)

        const response = await post(box, {
          passphrase,
          vault: "Personal",
          title: "title" in refusal ? refusal.title : "Stripe",
          kind: "api-credential",
          fields: refusal.fields,
        })

        assert.strictEqual(response.status, refusal.status)
        assert.strictEqual(await errorTag(response), refusal.tag)
        assert.deepStrictEqual(await itemRows(box), [])
        assert.strictEqual((await lastAudit(box))?.error, refusal.tag)
      }))

  it("is never reachable with a Token: a Token without the Passphrase is a malformed request", () =>
    withSandbox(async (box, seen) => {
      const { token } = await seeded(box, seen)

      const response = await post(
        box,
        { vault: "Personal", title: "Stripe", kind: "api-credential", fields: [{ label: "credential", value }] },
        { authorization: `Bearer ${token}` },
      )

      assert.strictEqual(response.status, 400)
      assert.deepStrictEqual(await itemRows(box), [])
    }))
})

describe("item create at a terminal", () => {
  it.skipIf(!onPty)("reads the Passphrase, then the value at `Value for password: `", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await box.run(
        ["item", "create", "login", "--vault", "Personal", "--title", "GitHub", "--prompt"],
        {
          tty: {
            keys: [
              { after: "hush Passphrase: ", keys: `${passphrase}\r` },
              { after: "Value for password: ", keys: "fictional typed password\r" },
            ],
          },
        },
      )

      assert.strictEqual(result.code, 0, result.stdout)
      assert.include(result.stdout, '"verified": true')
      assert.strictEqual((await read(box, "hush://Personal/GitHub/password")).stdout, "fictional typed password")
    }),
  )
})
