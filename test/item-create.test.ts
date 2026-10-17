import { assert, describe, it } from "@effect/vitest"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// `hush item create` through the seam: the Owner creates an Item with the Passphrase, verified before commit by
// `admin/items/create`, and a Token then reads it.

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
})
