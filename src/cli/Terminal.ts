import { Data, Effect, Redacted } from "effect"
import { closeSync, openSync, writeSync } from "node:fs"
import { ReadStream } from "node:tty"

import { NoTerminal, PromptCancelled } from "./CliError.js"

// The hidden reader on `/dev/tty`, never stdin or stdout: a prompt works while stdin is piped, and the
// JSON on stdout stays clean. The key handling is the pure `feed`; `hidden` wires it to the terminal in raw mode.

// One line being typed at a hidden prompt, as raw bytes: decoding is left to the caller, so an invalid UTF-8
// sequence is refused rather than silently replaced.
export type Line = Data.TaggedEnum<{
  Reading: { readonly bytes: Uint8Array }
  Entered: { readonly bytes: Uint8Array }
  Cancelled: {}
}>

export const Line = Data.taggedEnum<Line>()
export const empty: Line = Line.Reading({ bytes: new Uint8Array() })

const ctrlC = 0x03
const ctrlD = 0x04
const backspace = 0x08
const newline = 0x0a
const carriageReturn = 0x0d
const del = 0x7f

const isContinuation = (byte: number) => (byte & 0xc0) === 0x80

// The bytes without their last UTF-8 character: trailing continuation bytes, then the lead byte.
const eraseLast = (bytes: Uint8Array) => {
  let end = bytes.length

  while (end > 0 && isContinuation(bytes[end - 1] ?? 0)) end -= 1

  return bytes.slice(0, Math.max(end - 1, 0))
}

const append = (bytes: Uint8Array, byte: number) => {
  const next = new Uint8Array(bytes.length + 1)
  next.set(bytes)
  next[bytes.length] = byte

  return next
}

// One key byte. Enter (CR or LF) ends the line; Ctrl-C cancels, and Ctrl-D cancels only an empty line;
// Backspace (DEL or BS) erases one character and does nothing at the start. Every other byte is kept, so a
// typed control character reaches the value checks instead of vanishing.
const key = (bytes: Uint8Array, byte: number): Line => {
  switch (byte) {
    case carriageReturn:
    case newline:
      return Line.Entered({ bytes })
    case ctrlC:
      return Line.Cancelled()
    case ctrlD:
      return bytes.length === 0 ? Line.Cancelled() : Line.Reading({ bytes })
    case del:
    case backspace:
      return Line.Reading({ bytes: eraseLast(bytes) })
    default:
      return Line.Reading({ bytes: append(bytes, byte) })
  }
}

// A chunk of input as the terminal delivered it; a finished line ignores anything after its end.
export const feed = (line: Line, chunk: Uint8Array): Line => {
  let current = line

  for (const byte of chunk) {
    if (!Line.$is("Reading")(current)) return current
    current = key(current.bytes, byte)
  }

  return current
}

interface Opened {
  readonly fd: number
  readonly stream: ReadStream
}

// `/dev/tty` cannot be opened (`ENXIO` without a controlling terminal), set raw or read.
type Unavailable = () => NoTerminal

const open = (unavailable: Unavailable) =>
  Effect.try({
    try: (): Opened => {
      const fd = openSync("/dev/tty", "r+")

      try {
        return { fd, stream: new ReadStream(fd) }
      } catch (cause) {
        closeSync(fd)
        throw cause
      }
    },
    catch: unavailable,
  })

// On every exit path: a line end, since the typed line was never echoed; then raw mode off before the stream (and
// its fd) is closed. The line end is cosmetic, so a terminal gone by now does not stop the restore.
const close = ({ fd, stream }: Opened) =>
  Effect.sync(() => {
    try {
      writeSync(fd, "\r\n")
    } catch {}

    stream.setRawMode(false)
    stream.destroy()
  })

const readLine = ({ stream }: Opened, unavailable: Unavailable) =>
  Effect.callback<Uint8Array, PromptCancelled | NoTerminal>((resume) => {
    let line: Line = empty

    const onData = (chunk: Uint8Array) => {
      line = feed(line, chunk)

      Line.$match(line, {
        Reading: () => {},
        Entered: ({ bytes }) => resume(Effect.succeed(bytes)),
        Cancelled: () => resume(Effect.fail(new PromptCancelled())),
      })
    }

    const onEnd = () => resume(Effect.fail(new PromptCancelled()))
    const onError = () => resume(Effect.fail(unavailable()))
    stream.on("data", onData).on("end", onEnd).on("error", onError)

    return Effect.sync(() => {
      stream.off("data", onData).off("end", onEnd).off("error", onError)
    })
  })

// One hidden line typed at `/dev/tty` after `prompt`, as bytes for the caller to decode. Raw mode is set before
// the prompt appears, so no key typed after it is echoed. `need` says what the prompt was for, which picks the
// advice `NoTerminal` gives.
export const hidden = (
  prompt: string,
  need: NoTerminal["prompt"],
): Effect.Effect<Redacted.Redacted<Uint8Array>, PromptCancelled | NoTerminal> => {
  const unavailable = () => new NoTerminal({ prompt: need })

  return Effect.acquireUseRelease(
    open(unavailable),
    (opened) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            opened.stream.setRawMode(true)
            writeSync(opened.fd, prompt)
          },
          catch: unavailable,
        })

        return Redacted.make(yield* readLine(opened, unavailable))
      }),
    close,
  )
}

export * as Terminal from "./Terminal.js"
