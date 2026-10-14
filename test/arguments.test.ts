import { assert, describe, it } from "@effect/vitest"

import { decodeTrailingArguments, normalizeTrailingArguments } from "../src/cli/arguments.js"

describe("normalizeTrailingArguments", () => {
  it("preserves command flags after -- as operands", () => {
    const normalized = normalizeTrailingArguments(["run", "--env", "A=hush://v/i/f", "--", "sh", "-c", "echo ok"])
    assert.deepStrictEqual(normalized.slice(0, 3), ["run", "--env", "A=hush://v/i/f"])
    assert.strictEqual(normalized.length, 6)
    assert.deepStrictEqual(decodeTrailingArguments(normalized.slice(3)), ["sh", "-c", "echo ok"])
  })

  it("leaves arguments without -- unchanged", () => {
    assert.deepStrictEqual(normalizeTrailingArguments(["find", "--vault", "Work", "cloud"]), [
      "find",
      "--vault",
      "Work",
      "cloud",
    ])
  })

  it("passes ordinary values through decoding unchanged", () => {
    assert.deepStrictEqual(decodeTrailingArguments(["plain", "--flag"]), ["plain", "--flag"])
  })
})
