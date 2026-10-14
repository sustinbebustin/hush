import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import * as fc from "fast-check"

import { Token } from "../src/shared/Token.js"

const fixed = "hush_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

describe("Token.parse", () => {
  it("accepts hush_ and 43 base64url characters, and decodes them to the 32 secret bytes", () => {
    const token = Result.getOrThrow(Token.parse(fixed))
    assert.strictEqual(fixed.length, 48)
    assert.deepStrictEqual(
      [...Token.secret(token)],
      Array.from({ length: 32 }, (_, index) => index),
    )
  })

  for (const [name, input] of [
    ["an empty string", ""],
    ["a missing prefix", fixed.slice(5)],
    ["an uppercase prefix", `HUSH_${fixed.slice(5)}`],
    ["42 characters", fixed.slice(0, -1)],
    ["44 characters", `${fixed}A`],
    ["a padding character", `${fixed.slice(0, -1)}=`],
    ["a standard-base64 character", `${fixed.slice(0, -1)}+`],
    ["surrounding whitespace", ` ${fixed}`],
    ["non-canonical trailing bits", `${fixed.slice(0, -1)}9`],
  ] as const)
    it(`refuses ${name}`, () => {
      assert.isTrue(Result.isFailure(Token.parse(input)))
    })

  it("accepts every generated Token and only those", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const token = Result.getOrThrow(Token.parse(Token.format(bytes)))
        assert.deepStrictEqual([...Token.secret(token)], [...bytes])
      }),
    )
  })
})
