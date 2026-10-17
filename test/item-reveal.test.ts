import { assert, describe, it } from "@effect/vitest"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// The Owner's Reveal through the seam: `hush item reveal <reference>` over `admin/items/reveal`, one Field's value on
// stdout and one audit row naming its Reference.

const passphrase = passphraseSentinel.text
const value = valueSentinel.text
const username = "fictional plain username 9Kp"

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in. Revealed values are on stdout only, which `secretStdout` leaves out of the scan.
const withSandbox = async (test: (box: Sandbox) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, passphraseSentinel, { kind: "value", text: username }]

  try {
    const code = await box.server.initCode()

    if (code !== undefined) sentinels.push({ kind: "initCode", text: code })

    const { token } = await box.seed({
      items: [
        { kind: "api-credential", title: "Stripe", value },
        { kind: "login", title: "GitHub", value, plain: { username } },
      ],
    })

    sentinels.push({ kind: "token", text: token })
    await test(box)
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

const call = (path: string, status: number) => ({ method: "POST", path, status })

const reveal = (box: Sandbox, reference: string) =>
  box.run(["item", "reveal", reference, "--passphrase-stdin"], { input: `${passphrase}\n`, secretStdout: true })

describe("hush item reveal", () => {
  it("prints a concealed Field's value byte-exact on stdout, nothing on stderr, in one admin/items/reveal", () =>
    withSandbox(async (box) => {
      const result = await reveal(box, "hush://personal/stripe/CREDENTIAL")
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, value)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/reveal", 200)])
    }))
})
