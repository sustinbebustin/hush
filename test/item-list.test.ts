import { assert, describe, it } from "@effect/vitest"

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
})
