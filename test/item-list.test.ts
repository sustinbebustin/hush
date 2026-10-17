import { assert, describe, it } from "@effect/vitest"
import type { Schema } from "effect"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// `hush item list <vault>` through the seam: the Owner's view of a Vault's Items and Retired titles under the
// Passphrase, with no Token involved (ADR-0010).

const passphrase = passphraseSentinel.text
const value = valueSentinel.text

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in.
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

// `seed` with one Item of every Kind, plain Fields on two, and a deleted `Old Key` whose title is Retired; its
// Token and Init code registered as sentinels.
const seeded = async (box: Sandbox, seen: (sentinel: Sentinel) => void) => {
  const code = await box.server.initCode()

  if (code !== undefined) seen({ kind: "initCode", text: code })

  const result = await box.seed({
    items: [
      { kind: "api-credential", title: "Stripe", value },
      { kind: "login", title: "GitHub", value, plain: { username: "octocat" } },
      { kind: "database", title: "Orders DB", value, plain: { host: "db.internal", port: "5432" } },
      { kind: "api-credential", title: "Old Key", value },
    ],
  })

  seen({ kind: "token", text: result.token })
  const deleted = await admin(box, ["item", "delete", "Personal", "Old Key"])
  assert.strictEqual(deleted.code, 0, deleted.stderr)

  return result
}

const call = (path: string, status: number) => ({ method: "POST", path, status })
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// A raw JSON POST, as a client that is not the CLI would send it.
const post = (box: Sandbox, path: string, body: Schema.Json, headers: Record<string, string> = {}) =>
  box.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

// A Passphrase command with the Passphrase line piped to `--passphrase-stdin`.
const admin = (box: Sandbox, args: ReadonlyArray<string>, line = passphrase) =>
  box.run([...args, "--passphrase-stdin"], { input: `${line}\n` })

describe("hush item list", () => {
  it("prints the Vault's Items of every Kind, Fields with their concealed flag and no value, and its Retired titles", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await admin(box, ["item", "list", "personal"])

      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/list", 200)])
      const listed = JSON.parse(result.stdout)
      assert.deepStrictEqual(Object.keys(listed), ["vault", "items", "retired"])

      for (const item of listed.items) {
        assert.deepStrictEqual(Object.keys(item), ["title", "kind", "createdAt", "updatedAt", "fields"])
        assert.match(item.createdAt, isoTime)
        assert.match(item.updatedAt, isoTime)
      }

      assert.deepStrictEqual(
        {
          ...listed,
          items: listed.items.map(({ title, kind, fields }: { title: string; kind: string; fields: unknown }) => ({
            title,
            kind,
            fields,
          })),
        },
        {
          vault: "Personal",
          items: [
            {
              title: "GitHub",
              kind: "login",
              fields: [
                { label: "password", concealed: true },
                { label: "username", concealed: false },
              ],
            },
            {
              title: "Orders DB",
              kind: "database",
              fields: [
                { label: "password", concealed: true },
                { label: "host", concealed: false },
                { label: "port", concealed: false },
              ],
            },
            { title: "Stripe", kind: "api-credential", fields: [{ label: "credential", concealed: true }] },
          ],
          retired: ["old key"],
        },
      )
    }))

  it("lists an empty Vault as no Items and no Retired titles", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      assert.strictEqual((await admin(box, ["vault", "create", "Work"])).code, 0)

      const result = await admin(box, ["item", "list", "Work"])

      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout), { vault: "Work", items: [], retired: [] })
    }))
})

const auditRows = (box: Sandbox) =>
  box.inspect((db) =>
    db.query("SELECT actor, action, vaults, refs, detail, outcome, error FROM audit ORDER BY id").all(),
  )

const passphraseRow = (vaults: ReadonlyArray<string>, outcome: string, error: string | null) => ({
  actor: "passphrase",
  action: "item.list",
  vaults: JSON.stringify(vaults),
  refs: "[]",
  detail: null,
  outcome,
  error,
})

const wrongPassphrase = "a wrong fictional passphrase"

const incorrectNow =
  "hush: The Passphrase is incorrect; nothing was changed. You can try again now; repeated failures slow every Passphrase operation on this Server.\n"

describe("a refused hush item list", () => {
  it("VaultNotFound for a Vault that does not exist: exit 1, audited error", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await admin(box, ["item", "list", "Nowhere"])

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: Vault Nowhere does not exist on this Server; nothing was changed. `hush vault list` shows the Vaults.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/list", 404)])
      assert.deepStrictEqual((await auditRows(box)).at(-1), passphraseRow(["Nowhere"], "error", "VaultNotFound"))
    }))

  it("InvalidName at the CLI before reading the Passphrase or sending anything", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await box.run(["item", "list", "a/b"])

      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: vault is not a valid name (slash); nothing was changed. Names are 1-128 characters without `/` or control characters, not starting with `-` or with a space at either end.\n",
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it("InvalidName at the Server too, after the Passphrase check, audited error naming no Vault", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const response = await post(box, "/v1/admin/items/list", { passphrase, vault: " Work" })

      assert.strictEqual(response.status, 400)
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      assert.deepStrictEqual(await response.json(), { _tag: "InvalidName", what: "vault", reason: "whitespace-edge" })
      assert.deepStrictEqual((await auditRows(box)).at(-1), passphraseRow([], "error", "InvalidName"))
    }))

  it("PassphraseIncorrect for a wrong Passphrase, audited denied, printing nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const result = await admin(box, ["item", "list", "Personal"], wrongPassphrase)

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(result.stderr, incorrectNow)
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/list", 401)])
      assert.deepStrictEqual(
        (await auditRows(box)).at(-1),
        passphraseRow(["Personal"], "denied", "PassphraseIncorrect"),
      )
    }))

  it("BackoffActive after four wrong Passphrases refuses even the right one, unaudited", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      for (let attempt = 0; attempt < 4; attempt += 1)
        assert.strictEqual((await admin(box, ["item", "list", "Personal"], wrongPassphrase)).code, 1)
      const before = await auditRows(box)

      const pinned = await admin(box, ["item", "list", "Personal"])

      assert.strictEqual(pinned.code, 1)
      assert.strictEqual(pinned.stdout, "")
      assert.match(pinned.stderr, /^hush: Too many incorrect Passphrase attempts; /)
      assert.deepStrictEqual(pinned.calls, [call("/v1/admin/items/list", 429)])
      assert.deepStrictEqual(await auditRows(box), before)
    }))

  it("refuses a Token without a Passphrase as any admin endpoint does: the body does not decode, nothing is audited", () =>
    withSandbox(async (box, seen) => {
      const { token } = await seeded(box, seen)
      const before = await auditRows(box)

      const response = await post(
        box,
        "/v1/admin/items/list",
        { vault: "Personal" },
        { authorization: `Bearer ${token}` },
      )

      assert.strictEqual(response.status, 400)
      assert.strictEqual(await response.text(), "")
      assert.deepStrictEqual(await auditRows(box), before)
    }))
})

describe("the Audit Log of hush item list", () => {
  it("shows an item.list row in hush audit: actor passphrase, the Vault's stored name, no detail", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      assert.strictEqual((await admin(box, ["item", "list", "personal"])).code, 0)

      const result = await admin(box, ["audit", "--vault", "Personal", "--limit", "1"])

      assert.strictEqual(result.code, 0, result.stderr)
      const [listed] = JSON.parse(result.stdout).entries
      assert.deepStrictEqual(
        { ...listed, id: undefined, at: undefined, lastAt: undefined },
        {
          id: undefined,
          at: undefined,
          lastAt: undefined,
          count: 1,
          actor: { type: "passphrase" },
          action: "item.list",
          vaults: ["Personal"],
          references: [],
          peer: "127.0.0.1",
          outcome: "ok",
        },
      )
    }))
})
