import { assert, describe, it } from "@effect/vitest"
import * as fc from "fast-check"

import { Display } from "../src/ui/Display.js"
import { Event } from "../src/ui/Event.js"
import { Key } from "../src/ui/Key.js"
import { Reducer } from "../src/ui/Reducer.js"
import { State } from "../src/ui/State.js"

// The state after typing `text` at the Locked prompt, one key per code point.
const typed = (text: string): State =>
  [...text].reduce(
    (state, character) => Reducer.reduce(state, Event.Key({ key: Key.char(character) })).state,
    State.initial,
  )

describe("Display", () => {
  it("draws the Locked prompt from the length of the typed Passphrase alone", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), (text) => {
        const length = [...text].length

        assert.deepStrictEqual(Display.of(typed(text)), Display.of(typed("x".repeat(length))))
      }),
    )
  })

  it("draws one mask cell per character typed, multi-byte characters included", () => {
    const shown = Display.of(typed("pä😀"))

    assert.deepStrictEqual(
      Display.$match(shown, { Locked: ({ prompt, mask }) => prompt + mask, Open: () => "" }),
      "hush Passphrase: ***",
    )
  })
})
