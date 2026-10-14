import { assert, describe, it } from "@effect/vitest"

import { Terminal } from "../src/cli/Terminal.js"

const utf8 = (text: string) => new TextEncoder().encode(text)

// The bytes typed so far, as one chunk each, from an empty line.
const typedBytes = (...chunks: ReadonlyArray<Uint8Array>) => chunks.reduce(Terminal.feed, Terminal.empty)

// The keys typed so far, as one UTF-8 chunk each, from an empty line.
const typed = (...chunks: ReadonlyArray<string>) => typedBytes(...chunks.map(utf8))
const entered = (text: string) => Terminal.Line.Entered({ bytes: utf8(text) })
const reading = (text: string) => Terminal.Line.Reading({ bytes: utf8(text) })
const cancelled = Terminal.Line.Cancelled()

describe("Terminal.feed", () => {
  it("collects printable keys until Enter, as Return or as newline", () => {
    assert.deepStrictEqual(typed("ab", "c"), reading("abc"))
    assert.deepStrictEqual(typed("ab", "c\r"), entered("abc"))
    assert.deepStrictEqual(typed("abc\n"), entered("abc"))
  })

  it("ends at the first Enter and drops the rest of a pasted chunk", () => {
    assert.deepStrictEqual(typed("abc\rdef\r"), entered("abc"))
    assert.deepStrictEqual(typed("abc\r", "def"), entered("abc"))
  })

  it("accepts Enter on an empty line, leaving the empty check to the caller", () => {
    assert.deepStrictEqual(typed("\r"), entered(""))
  })

  it("erases one character with Backspace (DEL or BS), mid-line or after a whole line", () => {
    assert.deepStrictEqual(typed("abc\x7fd\r"), entered("abd"))
    assert.deepStrictEqual(typed("ab\b\b\r"), entered(""))
  })

  it("ignores Backspace at the start of the line", () => {
    assert.deepStrictEqual(typed("\x7f\x7fa\r"), entered("a"))
    assert.deepStrictEqual(typed("a\x7f\x7f\x7fb\r"), entered("b"))
  })

  it("keeps multi-byte characters whole, even split across chunks, and erases them whole", () => {
    assert.deepStrictEqual(typed("pässwörd✓\r"), entered("pässwörd✓"))
    const check = utf8("✓")
    assert.deepStrictEqual(typedBytes(utf8("a"), check.slice(0, 1), check.slice(1), utf8("\r")), entered("a✓"))
    assert.deepStrictEqual(typed("aä\x7f\r"), entered("a"))
    assert.deepStrictEqual(typed("a😀\x7f\r"), entered("a"))
    assert.deepStrictEqual(typed("✓\x7f✓\r"), entered("✓"))
  })

  it("cancels on Ctrl-C at any point", () => {
    assert.deepStrictEqual(typed("\x03"), cancelled)
    assert.deepStrictEqual(typed("abc\x03def\r"), cancelled)
  })

  it("cancels on Ctrl-D on an empty line and ignores it after typing", () => {
    assert.deepStrictEqual(typed("\x04"), cancelled)
    assert.deepStrictEqual(typed("ab\x04c\r"), entered("abc"))
    assert.deepStrictEqual(typed("a\x7f\x04"), cancelled)
  })

  it("does not change a finished line", () => {
    assert.deepStrictEqual(Terminal.feed(entered("a"), utf8("b\x03")), entered("a"))
    assert.deepStrictEqual(Terminal.feed(cancelled, utf8("b\r")), cancelled)
  })
})
