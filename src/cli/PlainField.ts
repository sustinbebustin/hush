import { Redacted, Result } from "effect"

import { InvalidValue, parseName, UnknownField } from "../shared/ApiError.js"
import { Kind } from "../shared/Kind.js"
import { Name } from "../shared/Name.js"
import { Value } from "../shared/Value.js"

// A plain Field given to `hush create` or `hush item create` (or the UI's Item form): it must name a plain Field of
// the Kind and carry a non-blank value. Pure, with no Client, so the UI's reducer runs it before the concealed value
// leaves its state.
export const check = (kind: Kind, field: { readonly label: string; readonly value: string }) =>
  Result.gen(function* () {
    const label = yield* parseName("field", field.label)
    const spec = Kind.spec(kind, Name.key(label))

    if (spec?.role !== "plain")
      return yield* Result.fail(
        new UnknownField({
          kind,
          field: field.label,
          allowed: Kind.fields(kind).flatMap((candidate) => (candidate.role === "plain" ? [candidate.label] : [])),
        }),
      )
    const problem = field.value.trim() === "" ? "empty" : Value.problem(field.value)

    if (problem !== undefined) return yield* Result.fail(new InvalidValue({ field: spec.label, reason: problem }))

    return { label: spec.label, value: Redacted.make(field.value) }
  })

export * as PlainField from "./PlainField.js"
