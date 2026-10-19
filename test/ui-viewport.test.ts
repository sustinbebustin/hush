import { assert, describe, it } from "@effect/vitest"
import * as fc from "fast-check"

import { Viewport } from "../src/ui/Viewport.js"

// The window a box of rows draws over a taller list: which entries, given the cursor and where the window was.

const sum = (heights: ReadonlyArray<number>, from: number, to: number) =>
  heights.slice(from, to).reduce((total, height) => total + height, 0)

const list = fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 60 }).chain((heights) =>
  fc.record({
    heights: fc.constant(heights),
    cursor: fc.integer({ min: 0, max: heights.length - 1 }),
    rows: fc.integer({ min: 3, max: 40 }),
    previous: fc.integer({ min: 0, max: heights.length + 5 }),
    pick: fc.nat(),
  }),
)

describe("Viewport", () => {
  it("always draws the entry under the cursor, whole, and only as many entries as fit", () => {
    fc.assert(
      fc.property(list, ({ heights, cursor, rows, previous }) => {
        const { top, end } = Viewport.follow(heights, cursor, rows, previous)

        assert.isAtMost(top, cursor)
        assert.isAbove(end, cursor)
        assert.isAtMost(sum(heights, top, end), rows)
      }),
    )
  })

  it("keeps the window where it was while the cursor stays inside it", () => {
    fc.assert(
      fc.property(list, ({ heights, cursor, rows, previous, pick }) => {
        const before = Viewport.follow(heights, cursor, rows, previous)
        const inside = before.top + (pick % (before.end - before.top))

        assert.strictEqual(Viewport.follow(heights, inside, rows, before.top).top, before.top)
      }),
    )
  })

  it("scrolls by the least that brings the cursor in: one row past either edge moves the window one row", () => {
    const heights = Array.from({ length: 25 }, () => 1)

    assert.deepStrictEqual(Viewport.follow(heights, 9, 10, 0), { top: 0, end: 10 })
    assert.deepStrictEqual(Viewport.follow(heights, 10, 10, 0), { top: 1, end: 11 })
    assert.deepStrictEqual(Viewport.follow(heights, 24, 10, 1), { top: 15, end: 25 })
    assert.deepStrictEqual(Viewport.follow(heights, 14, 10, 15), { top: 14, end: 24 })
    // A shorter list after a reload pulls the window up rather than leave rows empty below it.
    assert.deepStrictEqual(Viewport.follow(heights.slice(0, 12), 11, 10, 15), { top: 2, end: 12 })
  })
})
