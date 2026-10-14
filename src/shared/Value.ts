import { Utf8 } from "./Utf8.js"

// The rule for a Field value, checked by the CLI before sending and by the Server: 1 to 65536
// UTF-8 bytes, no U+0000, and well-formed UTF-16 so it has a UTF-8 form. An environment variable can carry any
// value that passes.

export const maxBytes = 65536

// Every reason `problem` can give, at runtime, so error schemas can list them as literals.
export const problems = ["empty", "nul", "too-long", "not-utf8"] as const

export type Problem = (typeof problems)[number]

export const problem = (value: string): Problem | undefined => {
  if (value === "") return "empty"

  if (!value.isWellFormed()) return "not-utf8"

  if (value.includes("\0")) return "nul"

  if (Utf8.byteLength(value) > maxBytes) return "too-long"

  return undefined
}

export * as Value from "./Value.js"
