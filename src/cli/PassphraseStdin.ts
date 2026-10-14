import { Effect, Result } from "effect"

import { type InputUnreadable, type InvalidValue, StdinFramingInvalid, type StdinIsTerminal } from "./CliError.js"
import { PrivateInput } from "./PrivateInput.js"

// `--passphrase-stdin`:stdin read to EOF, decoded as strict UTF-8, one secret per line in a
// fixed order, each with one `\n` or `\r\n` stripped. Nothing may follow the secret lines, except an `--stdin`
// value, which is everything after the Passphrase line.

const wording = { noun: "input on stdin", outcome: "changed" } as const

// Two secrets, as `init` (code, new Passphrase) and `passphrase change` (current, new) read them.
export type Pair = readonly [string, string]

// The next line without its `\n` or `\r\n`, and what follows it; undefined when nothing is left. A last line
// may end at EOF, so an empty last line needs its line ending to count.
const takeLine = (text: string): { readonly line: string; readonly rest: string } | undefined => {
  if (text === "") return undefined
  const end = text.indexOf("\n")
  if (end === -1) return { line: text, rest: "" }
  const line = text.slice(0, end)
  return { line: line.endsWith("\r") ? line.slice(0, -1) : line, rest: text.slice(end + 1) }
}

// `lines` names each expected secret in order, for the error message.
export const frame = (
  input: Uint8Array,
  command: string,
  lines: Pair,
): Result.Result<Pair, InvalidValue | StdinFramingInvalid> =>
  Result.flatMap(PrivateInput.decode(input, wording), (text) => {
    const first = takeLine(text)
    const second = first === undefined ? undefined : takeLine(first.rest)
    return first === undefined || second === undefined || second.rest !== ""
      ? Result.fail(new StdinFramingInvalid({ command, expected: lines }))
      : Result.succeed([first.line, second.line] as const)
  })

// The Passphrase alone, as every other Passphrase command reads it: one line, nothing after.
export const frameOne = (
  input: Uint8Array,
  command: string,
): Result.Result<string, InvalidValue | StdinFramingInvalid> =>
  Result.flatMap(PrivateInput.decode(input, wording), (text) => {
    const only = takeLine(text)
    return only === undefined || only.rest !== ""
      ? Result.fail(new StdinFramingInvalid({ command, expected: ["the Passphrase"] }))
      : Result.succeed(only.line)
  })

// The Passphrase line, then the rest of stdin as an `--stdin` value (`item edit --field L --stdin`), which the
// caller checks as private input.
export const frameWithValue = (
  input: Uint8Array,
  command: string,
): Result.Result<{ readonly passphrase: string; readonly value: string }, InvalidValue | StdinFramingInvalid> =>
  Result.flatMap(PrivateInput.decode(input, wording), (text) => {
    const first = takeLine(text)
    return first === undefined
      ? Result.fail(new StdinFramingInvalid({ command, expected: ["the Passphrase", "the value"] }))
      : Result.succeed({ passphrase: first.line, value: first.rest })
  })

type ReadError = StdinIsTerminal | InputUnreadable | InvalidValue | StdinFramingInvalid

// Refuses a terminal stdin, which would wait for typing with no prompt, then reads and frames all of stdin.
export const read = (command: string, lines: Pair): Effect.Effect<Pair, ReadError> =>
  PrivateInput.stdin("--passphrase-stdin", wording).pipe(
    Effect.flatMap((input) => Effect.fromResult(frame(input, command, lines))),
  )

export const readOne = (command: string): Effect.Effect<string, ReadError> =>
  PrivateInput.stdin("--passphrase-stdin", wording).pipe(
    Effect.flatMap((input) => Effect.fromResult(frameOne(input, command))),
  )

export const readWithValue = (command: string) =>
  PrivateInput.stdin("--passphrase-stdin", wording).pipe(
    Effect.flatMap((input) => Effect.fromResult(frameWithValue(input, command))),
  )

export * as PassphraseStdin from "./PassphraseStdin.js"
