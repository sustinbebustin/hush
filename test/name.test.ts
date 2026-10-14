import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import * as fc from "fast-check"

import { Name } from "../src/shared/Name.js"
import { COMPOSED_CAFE, DECOMPOSED_CAFE, validName } from "./arbitraries.js"

// Non-ASCII characters by code point: the formatter would turn `\u` escapes into look-alike literals.
const char = (code: number) => String.fromCodePoint(code)
const COMBINING_ACUTE = char(0x0301)
const COMBINING_DOT_ABOVE = char(0x0307)
const CAPITAL_E_ACUTE = char(0x00c9)
const NO_BREAK_SPACE = char(0x00a0)
const IDEOGRAPHIC_SPACE = char(0x3000)
const KEY_EMOJI = char(0x1f511)
const CAPITAL_I_DOT_ABOVE = char(0x0130)
const SHARP_S = char(0x00df)
const CAPITAL_SHARP_S = char(0x1e9e)

const reason = (input: string) => Result.match(Name.parse(input), { onSuccess: () => "ok", onFailure: (e) => e.reason })

const parsed = (input: string): string | undefined => Result.getOrUndefined(Name.parse(input))

const key = (input: string): string | undefined => Result.map(Name.parse(input), Name.key).pipe(Result.getOrUndefined)

const asciiFold = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase())

describe("Name.parse", () => {
  it("accepts an ordinary name with spaces and punctuation", () => {
    assert.strictEqual(parsed("Stripe API Key?#%="), "Stripe API Key?#%=")
  })

  it("normalises to NFC before checking the rules", () => {
    assert.strictEqual(parsed(DECOMPOSED_CAFE), COMPOSED_CAFE)
    // 128 decomposed characters are 256 code points before NFC and 128 after.
    assert.strictEqual(reason(`e${COMBINING_ACUTE}`.repeat(128)), "ok")
  })

  it("refuses each broken rule with its own reason", () => {
    assert.strictEqual(reason(""), "empty")
    assert.strictEqual(reason("a".repeat(129)), "too-long")
    assert.strictEqual(reason("Work/Stripe"), "slash")
    assert.strictEqual(reason("line\nbreak"), "control")
    assert.strictEqual(reason("del\u007f"), "control")
    assert.strictEqual(reason("c1\u0085"), "control")
    assert.strictEqual(reason(" leading"), "whitespace-edge")
    assert.strictEqual(reason(`trailing${NO_BREAK_SPACE}`), "whitespace-edge")
    assert.strictEqual(reason("-flag"), "leading-dash")
  })

  it("accepts 128 code points, counting astral characters once", () => {
    assert.strictEqual(reason("a".repeat(128)), "ok")
    assert.strictEqual(reason(KEY_EMOJI.repeat(128)), "ok")
    assert.strictEqual(reason(KEY_EMOJI.repeat(129)), "too-long")
  })

  it("accepts inner whitespace and an inner or trailing dash", () => {
    assert.strictEqual(reason(`a b${IDEOGRAPHIC_SPACE}c-d-`), "ok")
  })

  it("accepts every string built from the name rules, unchanged", () => {
    fc.assert(fc.property(validName, (text) => parsed(text) === text))
  })

  it("refuses every string containing a forbidden character", () => {
    const forbidden = fc.oneof(
      fc.constant("/"),
      fc.integer({ min: 0, max: 0x1f }).map(char),
      fc.integer({ min: 0x7f, max: 0x9f }).map(char),
    )

    fc.assert(
      fc.property(validName, forbidden, fc.nat(), (text, bad, at) => {
        const index = at % (text.length + 1)

        return Result.isFailure(Name.parse(text.slice(0, index) + bad + text.slice(index)))
      }),
    )
  })
})

describe("Name.key", () => {
  it("is NFC then full-Unicode lowercase", () => {
    assert.strictEqual(key("Stripe API Key"), "stripe api key")
    assert.strictEqual(key(DECOMPOSED_CAFE), key(`CAF${CAPITAL_E_ACUTE}`))
  })

  it("folds beyond ASCII, unlike an ASCII-only fold", () => {
    // A capital I with a dot above lowercases to "i" plus a combining dot above.
    assert.strictEqual(key(`${CAPITAL_I_DOT_ABOVE}stanbul`), `i${COMBINING_DOT_ABOVE}stanbul`)
    assert.notStrictEqual(asciiFold(`${CAPITAL_I_DOT_ABOVE}stanbul`), `i${COMBINING_DOT_ABOVE}stanbul`)
    // A capital sharp s lowercases to the sharp s, so the two spellings of "strasse" share a key.
    assert.strictEqual(key(`STRA${CAPITAL_SHARP_S}E`), key(`stra${SHARP_S}e`))
    assert.notStrictEqual(asciiFold(`STRA${CAPITAL_SHARP_S}E`), asciiFold(`stra${SHARP_S}e`))
  })
})
