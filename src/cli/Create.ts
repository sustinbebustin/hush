import { Effect, Redacted, Result } from "effect"

import { Api } from "../shared/Api.js"
import { InvalidValue, parseName, UnknownField } from "../shared/ApiError.js"
import { Kind } from "../shared/Kind.js"
import { Name } from "../shared/Name.js"
import { Reference } from "../shared/Reference.js"
import { Value } from "../shared/Value.js"
import { Client } from "./Client.js"
import { CreationMayHaveSucceeded, CreationUnverified } from "./CliError.js"
import { PrivateInput } from "./PrivateInput.js"
import type { Target } from "./Target.js"
import type { EnvVars } from "./LaunchEnv.js"
import { TokenStore } from "./TokenStore.js"

// `hush create <kind>`:every check that needs no Server runs before the value is
// read; then one `items/create`, then one `secrets/resolve` of every created Field under the same Token, compared
// in memory. Any failure after the create was sent says do not retry (invariant 3); nothing is ever retried.

export interface CreateInput {
  readonly kind: Kind
  readonly title: string
  readonly vault: string
  readonly sources: PrivateInput.SourceFlags
  readonly plain: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

export interface Receipt {
  readonly title: string
  readonly vault: string
  readonly kind: Kind
  readonly field: string
  readonly ref: string
  readonly verified: true
}

const parse = (what: string, input: string) => Effect.fromResult(parseName(what, input))

// A plain flag must name a plain Field of the Kind and carry a non-blank value.
const plainField = (kind: Kind, field: { readonly label: string; readonly value: string }) =>
  Effect.gen(function* () {
    const label = yield* parse("field", field.label)
    const spec = Kind.spec(kind, Name.key(label))
    if (spec?.role !== "plain")
      return yield* new UnknownField({
        kind,
        field: field.label,
        allowed: Kind.fields(kind).flatMap((candidate) => (candidate.role === "plain" ? [candidate.label] : [])),
      })
    const problem = field.value.trim() === "" ? "empty" : Value.problem(field.value)
    if (problem !== undefined) return yield* new InvalidValue({ field: spec.label, reason: problem })
    return { label: spec.label, value: Redacted.make(field.value) }
  })

export const run = (target: Target, input: CreateInput, env: EnvVars) =>
  Effect.gen(function* () {
    const source = yield* Effect.fromResult(PrivateInput.source(input.sources, "created"))
    const vault = yield* parse("vault", input.vault)
    const title = yield* parse("title", input.title)
    const plain = yield* Effect.forEach(input.plain, (field) => plainField(input.kind, field))
    const choice = yield* TokenStore.current(target, env, vault)
    const primary = Kind.primary(input.kind)
    const secret = yield* PrivateInput.read({
      source,
      wording: { noun: `value for ${primary.label}`, outcome: "created" },
      prompt: `Value for ${primary.label}: `,
    })
    const fields = [{ label: primary.label, value: secret }, ...plain]

    const created = yield* Client.request(
      Api,
      target,
      (client) => client.token.create({ payload: { vault, title, kind: input.kind, fields } }),
      choice.token,
    ).pipe(
      // Sent, but no answer this CLI understands: the Item may exist.
      Effect.catchTag(["ServerUnreachable", "UnexpectedResponse"], () =>
        Effect.fail(new CreationMayHaveSucceeded({ title, vault })),
      ),
    )

    // The Server's names, if they are the ones asked for; the ones sent otherwise, for the error's Reference.
    const stored = Result.all({ vault: Name.parse(created.vault), item: Name.parse(created.title) })
    const names = Result.isSuccess(stored) ? stored.success : { vault, item: title }
    const ref = Reference.format({ ...names, field: primary.label })
    const unverified = new CreationUnverified({ title: names.item, vault: names.vault, ref })
    if (
      Result.isFailure(stored) ||
      Name.key(names.vault) !== Name.key(vault) ||
      Name.key(names.item) !== Name.key(title) ||
      created.kind !== input.kind
    )
      return yield* unverified

    const references = fields.map(({ label }) => Reference.format({ ...names, field: label }))
    const resolved = yield* Client.request(
      Api,
      target,
      (client) => client.token.resolve({ payload: { references } }),
      choice.token,
    ).pipe(Effect.mapError(() => unverified))
    const matches =
      resolved.values.length === fields.length &&
      fields.every((field, index) => {
        const value = resolved.values[index]
        return (
          value !== undefined &&
          Redacted.value(value.value) === Redacted.value(field.value) &&
          value.concealed === (field.label === primary.label)
        )
      })
    if (!matches) return yield* unverified
    const receipt: Receipt = {
      title: names.item,
      vault: names.vault,
      kind: input.kind,
      field: primary.label,
      ref,
      verified: true,
    }
    return receipt
  })

export * as Create from "./Create.js"
