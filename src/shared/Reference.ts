import { Result } from "effect"

import { Name } from "./Name.js"

// `hush://<vault>/<item>/<field>`. No escaping or percent-decoding: `?`, `#`, `%`, `=` and
// spaces are ordinary characters. Parts match by `Name.key`; output always uses stored display names.
export type Reference = { readonly vault: Name; readonly item: Name; readonly field: Name }

const invalidReasons = ["scheme", "segments", ...Name.invalidReasons] as const

export type InvalidReferenceReason = (typeof invalidReasons)[number]

const SCHEME = "hush://"

export const Reference = {
  scheme: SCHEME,
  // Every reason `parse` can fail with, at runtime, so error schemas can list them as literals.
  invalidReasons,
  parse: (input: string): Result.Result<Reference, { readonly reason: InvalidReferenceReason }> => {
    if (!input.startsWith(SCHEME)) return Result.fail({ reason: "scheme" })
    const parts = input.slice(SCHEME.length).split("/")
    if (parts.length !== 3) return Result.fail({ reason: "segments" })
    const [vault = "", item = "", field = ""] = parts
    return Result.all({ vault: Name.parse(vault), item: Name.parse(item), field: Name.parse(field) })
  },
  format: (reference: Reference): string => `${SCHEME}${reference.vault}/${reference.item}/${reference.field}`,
} as const
