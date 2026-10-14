import { Effect, Redacted, Result } from "effect"

import { Value } from "../shared/Value.js"
import {
  ClipboardUnsupported,
  InputEmpty,
  InputSourceConflict,
  InputSourceRequired,
  InputUnreadable,
  InvalidValue,
  type NoTerminal,
  type Outcome,
  type PromptCancelled,
  StdinIsTerminal,
} from "./CliError.js"
import { Terminal } from "./Terminal.js"

// One private value from exactly one source:piped stdin, a hidden line on `/dev/tty`, or
// `pbpaste` on macOS; never argv or env, and never an implicit prompt.

const sources = ["stdin", "prompt", "clipboard"] as const

export type PrivateSource = (typeof sources)[number]

// The source flags as given, one boolean per flag.
export type SourceFlags = { readonly [Source in PrivateSource]: boolean }

// How a refusal names the input and what it left untouched: "The <noun> is empty; nothing was <outcome>."
export interface Wording {
  readonly noun: string
  readonly outcome: Outcome
}

// Throws on any invalid sequence instead of substituting U+FFFD, so a value is never silently altered.
const decoder = new TextDecoder("utf-8", { fatal: true })

export const decode = (input: Uint8Array, { noun, outcome }: Wording): Result.Result<string, InvalidValue> => {
  try {
    return Result.succeed(decoder.decode(input))
  } catch {
    return Result.fail(new InvalidValue({ noun, reason: "not-utf8", outcome }))
  }
}

// Exactly one of the three flags; checked before any input is read.
export const source = (
  flags: SourceFlags,
  outcome: Outcome,
): Result.Result<PrivateSource, InputSourceRequired | InputSourceConflict> => {
  const [only, ...rest] = sources.filter((name) => flags[name])

  if (only === undefined) return Result.fail(new InputSourceRequired({ outcome }))

  return rest.length === 0 ? Result.succeed(only) : Result.fail(new InputSourceConflict({ outcome }))
}

// One trailing `\n` or `\r\n` stripped, so `echo` works; then blank, NUL and over 64 KiB are refused.
export const value = (
  text: string,
  { noun, outcome }: Wording,
): Result.Result<Redacted.Redacted<string>, InputEmpty | InvalidValue> => {
  const stripped = text.replace(/\r?\n$/, "")

  if (stripped.trim() === "") return Result.fail(new InputEmpty({ noun, outcome }))
  const problem = Value.problem(stripped)

  switch (problem) {
    case undefined:
      return Result.succeed(Redacted.make(stripped))
    case "empty":
      return Result.fail(new InputEmpty({ noun, outcome }))
    case "nul":
    case "too-long":
    case "not-utf8":
      return Result.fail(new InvalidValue({ noun, reason: problem, outcome }))
  }
}

// All of piped stdin. A terminal stdin would wait for typing with no prompt.
export const stdin = (flag: "--stdin" | "--passphrase-stdin", { noun, outcome }: Wording) =>
  Effect.gen(function* () {
    if (process.stdin.isTTY) return yield* new StdinIsTerminal({ flag, outcome })

    return yield* Effect.tryPromise({
      try: () => Bun.stdin.bytes(),
      catch: () => new InputUnreadable({ noun, outcome }),
    })
  })

// `pbpaste`'s output (macOS only). Its stderr is discarded and its exit status alone decides: a message from it
// could echo the clipboard.
const clipboard = ({ noun, outcome }: Wording) =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return yield* new ClipboardUnsupported({ outcome })

    const output = yield* Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(["pbpaste"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
        const [bytes, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited])

        return { bytes, code }
      },
      catch: () => new InputUnreadable({ noun, outcome }),
    })

    if (output.code !== 0) return yield* new InputUnreadable({ noun, outcome })

    return output.bytes
  })

// A hidden line at `/dev/tty`. Without a terminal, `--stdin` is the way.
const prompted = (prompt: string, { outcome }: Wording) =>
  Terminal.hidden(prompt, { for: "value", outcome }).pipe(Effect.map(Redacted.value))

const bytesFrom = (from: PrivateSource, wording: Wording, prompt: string) => {
  switch (from) {
    case "stdin":
      return stdin("--stdin", wording)
    case "clipboard":
      return clipboard(wording)
    case "prompt":
      return prompted(prompt, wording)
  }
}

// The value from the chosen source, decoded and checked; `prompt` is the hidden prompt's text, e.g.
// `Value for credential: `.
export const read = (request: {
  readonly source: PrivateSource
  readonly wording: Wording
  readonly prompt: string
}): Effect.Effect<
  Redacted.Redacted<string>,
  StdinIsTerminal | ClipboardUnsupported | NoTerminal | PromptCancelled | InputUnreadable | InvalidValue | InputEmpty
> =>
  Effect.gen(function* () {
    const { source: from, wording, prompt } = request
    const input = yield* bytesFrom(from, wording, prompt)
    const text = yield* Effect.fromResult(decode(input, wording))

    return yield* Effect.fromResult(value(text, wording))
  })

export * as PrivateInput from "./PrivateInput.js"
