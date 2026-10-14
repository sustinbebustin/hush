import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import * as fc from "fast-check"

import { InvalidValue, StdinFramingInvalid } from "../src/cli/CliError.js"
import { PassphraseStdin } from "../src/cli/PassphraseStdin.js"

const initLines = ["the Init code", "the new Passphrase"] as const

// Each outcome as a plain object, so an error compares by its fields.
const frameBytes = (input: Uint8Array) =>
  Result.match(PassphraseStdin.frame(input, "init", initLines), {
    onSuccess: (lines) => ({ lines }),
    onFailure: (error) => ({ ...error }),
  })

const frame = (input: string) => frameBytes(new TextEncoder().encode(input))
const framingInvalid = { ...new StdinFramingInvalid({ command: "init", expected: initLines }) }

describe("PassphraseStdin.frame", () => {
  it("reads one secret per line, stripping one \\n or \\r\\n from each", () => {
    assert.deepStrictEqual(frame("code\npassphrase\n"), { lines: ["code", "passphrase"] })
    assert.deepStrictEqual(frame("code\r\npassphrase\r\n"), { lines: ["code", "passphrase"] })
  })

  it("accepts a last line that ends at EOF", () => {
    assert.deepStrictEqual(frame("code\npassphrase"), { lines: ["code", "passphrase"] })
  })

  it("strips only the line ending: spaces and a lone \\r inside a line are kept", () => {
    assert.deepStrictEqual(frame(" code \npass\rphrase \n"), { lines: [" code ", "pass\rphrase "] })
  })

  it("is StdinFramingInvalid, naming the expected lines, when a line is missing", () => {
    assert.deepStrictEqual(frame("code\n"), framingInvalid)
    assert.deepStrictEqual(frame(""), framingInvalid)
  })

  it("is StdinFramingInvalid when anything follows the secret lines", () => {
    assert.deepStrictEqual(frame("code\npassphrase\nextra"), framingInvalid)
    assert.deepStrictEqual(frame("code\npassphrase\n\n"), framingInvalid)
  })

  it("is InvalidValue not-utf8 for bytes that are not UTF-8, before framing", () => {
    assert.deepStrictEqual(frameBytes(new Uint8Array([0x63, 0x0a, 0xff, 0x0a])), {
      ...new InvalidValue({ noun: "input on stdin", reason: "not-utf8", outcome: "changed" }),
    })
  })

  it("treats an empty last line with no line ending as missing", () => {
    assert.deepStrictEqual(frame("code\n"), framingInvalid)
    assert.deepStrictEqual(frame("code\n\n"), { lines: ["code", ""] })
  })

  it("returns any two lines without line breaks exactly, whichever line endings separate them", () => {
    const line = fc.string({ unit: "grapheme" }).filter((text) => !/[\r\n]/.test(text))
    const ending = fc.constantFrom("\n", "\r\n")
    fc.assert(
      fc.property(line, line, ending, fc.constantFrom("", "\n", "\r\n"), (code, passphrase, first, last) => {
        fc.pre(passphrase !== "" || last !== "")
        assert.deepStrictEqual(frame(`${code}${first}${passphrase}${last}`), { lines: [code, passphrase] })
      }),
    )
  })
})

const frameOne = (input: string) =>
  Result.match(PassphraseStdin.frameOne(new TextEncoder().encode(input), "vault list"), {
    onSuccess: (line) => ({ line }),
    onFailure: (error) => ({ ...error }),
  })

describe("PassphraseStdin.frameOne", () => {
  const oneInvalid = { ...new StdinFramingInvalid({ command: "vault list", expected: ["the Passphrase"] }) }

  it("reads the Passphrase as the one line, with or without its line ending", () => {
    assert.deepStrictEqual(frameOne("pass phrase\r\n"), { line: "pass phrase" })
    assert.deepStrictEqual(frameOne("pass phrase"), { line: "pass phrase" })
  })

  it("is StdinFramingInvalid for no line, or anything after the first", () => {
    assert.deepStrictEqual(frameOne(""), oneInvalid)
    assert.deepStrictEqual(frameOne("pass phrase\nextra"), oneInvalid)
    assert.deepStrictEqual(frameOne("pass phrase\n\n"), oneInvalid)
  })
})

const frameWithValue = (input: string) =>
  Result.match(PassphraseStdin.frameWithValue(new TextEncoder().encode(input), "item edit"), {
    onSuccess: (framed) => ({ ...framed }),
    onFailure: (error) => ({ ...error }),
  })

describe("PassphraseStdin.frameWithValue", () => {
  it("reads the Passphrase line, then everything after it as the value, line breaks included", () => {
    assert.deepStrictEqual(frameWithValue("pass phrase\r\nline one\nline two\n"), {
      passphrase: "pass phrase",
      value: "line one\nline two\n",
    })
    assert.deepStrictEqual(frameWithValue("pass phrase"), { passphrase: "pass phrase", value: "" })
  })

  it("is StdinFramingInvalid, naming the Passphrase and the value, for empty stdin", () => {
    assert.deepStrictEqual(frameWithValue(""), {
      ...new StdinFramingInvalid({ command: "item edit", expected: ["the Passphrase", "the value"] }),
    })
  })
})
