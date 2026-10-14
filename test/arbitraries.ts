import * as fc from "fast-check"

// A name built from the Name rules (src/shared/Name.ts): any Unicode text with `/` and Cc replaced, NFC-normalised,
// at most 128 code points, without whitespace at either end or a leading `-`. Up to 140 graphemes so the
// 128-code-point limit is reached.
export const validName: fc.Arbitrary<string> = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 140 })
  .map((text) => text.replace(/[/\p{Cc}]/gu, "x").normalize("NFC"))
  .filter((text) => [...text].length <= 128 && !/^\p{White_Space}|\p{White_Space}$|^-/u.test(text))

// "e" plus a combining acute accent, and the single e-acute it composes to under NFC. Built by code point
// because the formatter rewrites `\u` escapes into look-alike literals.
export const DECOMPOSED_CAFE = `Cafe${String.fromCodePoint(0x0301)}`
export const COMPOSED_CAFE = `Caf${String.fromCodePoint(0x00e9)}`
