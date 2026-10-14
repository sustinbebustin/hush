import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import * as fc from "fast-check"

import { Passphrase } from "../src/shared/Passphrase.js"
import { COMPOSED_CAFE, DECOMPOSED_CAFE } from "./arbitraries.js"

const E_ACUTE = String.fromCodePoint(0x00e9)

const outcome = (text: string) =>
  Result.match(Passphrase.policy(text), { onSuccess: (nfc) => ({ nfc }), onFailure: (error) => error.reason })

describe("Passphrase.policy", () => {
  it("accepts 12 to 1024 code points and returns the NFC form", () => {
    assert.deepStrictEqual(outcome("a".repeat(12)), { nfc: "a".repeat(12) })
    assert.deepStrictEqual(outcome("a".repeat(1024)), { nfc: "a".repeat(1024) })
    assert.deepStrictEqual(outcome(`${DECOMPOSED_CAFE} 12345678`), { nfc: `${COMPOSED_CAFE} 12345678` })
  })

  it("is too-short under 12 code points, counted after NFC", () => {
    assert.strictEqual(outcome("a".repeat(11)), "too-short")
    // 12 code points decomposed, 11 once composed.
    assert.strictEqual(outcome(`${DECOMPOSED_CAFE}1234567`), "too-short")
  })

  it("is too-long over 1024 code points or over 1024 UTF-8 bytes", () => {
    assert.strictEqual(outcome("a".repeat(1025)), "too-long")
    // 513 code points, 1026 bytes.
    assert.strictEqual(outcome(E_ACUTE.repeat(513)), "too-long")
    assert.deepStrictEqual(outcome(E_ACUTE.repeat(512)), { nfc: E_ACUTE.repeat(512) })
  })

  it("decides the same for every Unicode normalisation of a Passphrase, returning its NFC form", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), (text) => {
        const nfd = outcome(text.normalize("NFD"))
        assert.deepStrictEqual(outcome(text.normalize("NFC")), nfd)
        assert.deepStrictEqual(outcome(text.normalize("NFKC").normalize("NFD")), outcome(text.normalize("NFKC")))
        if (typeof nfd !== "string") assert.strictEqual(nfd.nfc, text.normalize("NFC"))
      }),
    )
  })

  it("counts an astral character as one code point", () => {
    assert.strictEqual(outcome(String.fromCodePoint(0x1f511).repeat(11)), "too-short")
    assert.deepStrictEqual(outcome(String.fromCodePoint(0x1f511).repeat(12)), {
      nfc: String.fromCodePoint(0x1f511).repeat(12),
    })
  })
})
