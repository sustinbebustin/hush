// Fields of an error thrown by Bun, Node or bun:sqlite (`ECONNREFUSED`, `EADDRINUSE`, `SQLITE_NOTADB`, ...),
// read without trusting its shape: anything missing or not a string is undefined.

const stringField = (cause: unknown, name: string): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined
  const value: unknown = Reflect.get(cause, name)
  return typeof value === "string" ? value : undefined
}

export const code = (cause: unknown): string | undefined => stringField(cause, "code")

// The code for an error message or a tagged error's `code` field: `unknown` when the platform gave none.
export const codeOrUnknown = (cause: unknown): string => code(cause) ?? "unknown"

export const message = (cause: unknown): string | undefined => stringField(cause, "message")

export * as PlatformCause from "./PlatformCause.js"
