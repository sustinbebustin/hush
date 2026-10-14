import { Option, Schema } from "effect"

// Fields of an error thrown by Bun, Node or bun:sqlite (`ECONNREFUSED`, `EADDRINUSE`, `SQLITE_NOTADB`, ...),
// read without trusting its shape: anything missing or not a string is undefined, each field on its own.

const decodeCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))

const decodeMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))

export const code = (cause: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(decodeCode(cause), (fields) => fields.code))

// The code for an error message or a tagged error's `code` field: `unknown` when the platform gave none.
export const codeOrUnknown = (cause: unknown): string => code(cause) ?? "unknown"

export const message = (cause: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(decodeMessage(cause), (fields) => fields.message))

export * as PlatformCause from "./PlatformCause.js"
