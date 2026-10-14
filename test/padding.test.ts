import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import * as fc from "fast-check"

import { Padding } from "../src/server/Padding.js"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

describe("Padding.pad", () => {
  it("encodes u32be(byteLength), the UTF-8 bytes, then zero bytes up to the next multiple of 64", () => {
    assert.strictEqual(hex(Padding.pad("é")), `00000002c3a9${"00".repeat(58)}`)
  })

  for (const [bytes, padded] of [
    [0, 64],
    [60, 64],
    [61, 128],
    [65536, 65600],
  ] as const)
    it(`pads a ${bytes}-byte value to ${padded} bytes and opens it again`, () => {
      const value = "x".repeat(bytes)
      const sealed = Padding.pad(value)
      assert.strictEqual(sealed.length, padded)
      assert.deepStrictEqual(Padding.unpad(sealed), Result.succeed(value))
    })

  it("round-trips any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (value) => {
        const padded = Padding.pad(value)
        assert.strictEqual(padded.length % 64, 0)
        assert.deepStrictEqual(Padding.unpad(padded), Result.succeed(value))
      }),
    )
  })
})

const padded = () => Padding.pad("value")

describe("Padding.unpad", () => {
  it("refuses a length prefix that does not fit", () => {
    const bytes = padded()
    bytes[3] = 61
    assert.isTrue(Result.isFailure(Padding.unpad(bytes)))
  })

  it("refuses non-zero padding", () => {
    const bytes = padded()
    bytes[63] = 1
    assert.isTrue(Result.isFailure(Padding.unpad(bytes)))
  })

  it("refuses a buffer that is not a positive multiple of 64 bytes", () => {
    assert.isTrue(Result.isFailure(Padding.unpad(padded().slice(0, 63))))
    assert.isTrue(Result.isFailure(Padding.unpad(new Uint8Array(0))))
  })

  it("refuses bytes that are not UTF-8", () => {
    const bytes = padded()
    bytes[4] = 0xff
    assert.isTrue(Result.isFailure(Padding.unpad(bytes)))
  })
})
