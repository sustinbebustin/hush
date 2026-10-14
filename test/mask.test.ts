import { assert, describe, it } from "@effect/vitest"
import * as fc from "fast-check"

import { Mask } from "../src/cli/Mask.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Feeds `chunks` through a fresh mask over `values` and returns everything it wrote, as text.
const through = (values: ReadonlyArray<string>, chunks: ReadonlyArray<string | Uint8Array>): string => {
  const mask = Mask.make(values)
  const parts = chunks.map((chunk) => mask.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk))
  return decoder.decode(Buffer.concat([...parts, mask.end()]))
}

const concealed = "<concealed by hush>"

// A single left-to-right replacement over the whole input, longest value first at each position.
const reference = (values: ReadonlyArray<string>, input: Uint8Array): string => {
  const masked = [...new Set(values)]
    .map((value) => encoder.encode(value))
    .filter((bytes) => bytes.length >= 8)
    .toSorted((a, b) => b.length - a.length)
  const out: Array<Uint8Array> = []
  let i = 0
  while (i < input.length) {
    const at = i
    const found = masked.find((value) => value.every((byte, k) => input[at + k] === byte))
    if (found === undefined) {
      out.push(input.subarray(i, i + 1))
      i += 1
    } else {
      out.push(encoder.encode(concealed))
      i += found.length
    }
  }
  return decoder.decode(Buffer.concat(out))
}

// Text over a small alphabet, so values recur and overlap in the input.
const text = (minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom("a", "b", "c", "é"), minLength, maxLength })

describe("Mask.make", () => {
  it("replaces a value inside one chunk", () => {
    assert.strictEqual(through(["sk-live-12345"], ["key=sk-live-12345\n"]), `key=${concealed}\n`)
  })

  it("replaces a value split across chunks", () => {
    assert.strictEqual(through(["sk-live-12345"], ["key=sk-li", "ve-12", "345 done"]), `key=${concealed} done`)
  })

  it("leaves values shorter than 8 bytes alone", () => {
    assert.strictEqual(through(["1234567"], ["1234567"]), "1234567")
    assert.strictEqual(through(["12345678"], ["12345678"]), concealed)
  })

  it("counts bytes, not characters", () => {
    // Four two-byte characters: 8 bytes.
    assert.strictEqual(through(["éééé"], ["xéééé"]), `x${concealed}`)
  })

  it("prefers the longest value at the same position", () => {
    assert.strictEqual(through(["password", "password-long"], ["password-long!"]), `${concealed}!`)
  })

  it("holds back at most (longest - 1) bytes until the end", () => {
    const mask = Mask.make(["abcdefgh"])
    assert.strictEqual(decoder.decode(mask.push(encoder.encode("0123456789"))), "012")
    assert.strictEqual(decoder.decode(mask.end()), "3456789")
  })

  it("passes everything through with no values", () => {
    const mask = Mask.make([])
    assert.strictEqual(decoder.decode(mask.push(encoder.encode("plain"))), "plain")
    assert.strictEqual(mask.end().length, 0)
  })

  it("equals a reference replacement of the concatenated input for any values and chunking", () => {
    fc.assert(
      fc.property(
        fc.array(text(1, 14), { maxLength: 4 }),
        fc.array(fc.oneof(text(0, 30), fc.constantFrom("aaaaaaaa", "abcabcab", "éééé")), { maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        (values, pieces, cuts) => {
          const input = encoder.encode(pieces.join("") + values.join(""))
          const points = [...new Set(cuts.map((cut) => cut % (input.length + 1)))].toSorted((a, b) => a - b)
          const bounds = [0, ...points, input.length]
          const chunks = bounds.slice(1).map((end, index) => input.subarray(bounds[index] ?? 0, end))
          assert.strictEqual(through(values, chunks), reference(values, input))
        },
      ),
    )
  })
})
