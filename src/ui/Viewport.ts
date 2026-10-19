// The window a box of rows draws over a list taller than the box: entries `[top, end)`, each drawn whole. It follows
// the cursor by the least scroll that brings it in, and otherwise stays where it was, so moving inside the window, a
// reload or a refresh does not move it. Pure: the caller passes the previous top, and `Display` keeps it.

export interface Viewport {
  readonly top: number
  readonly end: number
}

const sum = (heights: ReadonlyArray<number>, from: number, to: number): number =>
  heights.slice(from, to).reduce((total, height) => total + height, 0)

// The end of the window from `top`: as many entries as fit in `rows`, and at least the first, cut if it is taller.
const endFrom = (heights: ReadonlyArray<number>, top: number, rows: number): number => {
  let end = top + 1

  while (end < heights.length && sum(heights, top, end + 1) <= rows) end += 1

  return end
}

// The least top whose window still reaches entry `last`.
const topEndingAt = (heights: ReadonlyArray<number>, last: number, rows: number): number => {
  let top = last

  while (top > 0 && sum(heights, top - 1, last + 1) <= rows) top -= 1

  return top
}

// The window over entries `heights` rows tall in a box of `rows`, with the cursor on entry `cursor` (none when it is
// outside the list) and the window last at `previous`. It never leaves rows empty below the last entry while
// entries above are hidden.
const follow = (heights: ReadonlyArray<number>, cursor: number, rows: number, previous: number): Viewport => {
  if (heights.length === 0) return { top: 0, end: 0 }
  const last = heights.length - 1
  const kept = Math.min(Math.max(0, previous), topEndingAt(heights, last, rows))
  const inList = cursor >= 0 && cursor <= last

  const top = !inList
    ? kept
    : cursor < kept
      ? cursor
      : cursor >= endFrom(heights, kept, rows)
        ? topEndingAt(heights, cursor, rows)
        : kept

  return { top, end: endFrom(heights, top, rows) }
}

// How many rows `text` takes word-wrapped to `width` columns.
const wordLines = (text: string, width: number): number =>
  text
    .split(" ")
    .reduce(
      ({ lines, used }, word) =>
        used + 1 + word.length <= width
          ? { lines, used: used + 1 + word.length }
          : { lines: lines + 1, used: word.length },
      { lines: 1, used: -1 },
    ).lines

// How many rows `text` takes wrapped at any character to `width` columns.
const charLines = (text: string, width: number): number => Math.max(1, Math.ceil([...text].length / width))

export const Viewport = { follow, wordLines, charLines } as const
