import { Result } from "effect"

import { Name, type NameKey } from "./Name.js"

// The Kinds of Item and their fixed Field specs. Each Kind has exactly one
// primary Field, which is required and concealed; plain Fields are optional unvalidated strings.
const all = ["api-credential", "login", "database"] as const

export type Kind = (typeof all)[number]

export type FieldSpec = {
  readonly label: Name
  readonly role: "primary" | "plain"
  // The `create` flag for a plain Field; the primary Field is read from private input, so it has none.
  readonly flag: string | undefined
}

// The labels are literals that satisfy the name rules, so a failure here is a bug caught at module load.
const label = (text: string): Name => Result.getOrThrow(Name.parse(text))

// Every plain Field label of any Kind: `create` declares one flag per entry and refuses one the chosen Kind lacks.
const plainLabels = ["username", "host", "port", "database", "notes"] as const

export type PlainLabel = (typeof plainLabels)[number]

const primary = (text: string): FieldSpec => ({ label: label(text), role: "primary", flag: undefined })
const plain = (text: PlainLabel): FieldSpec => ({ label: label(text), role: "plain", flag: `--${text}` })

const specs: { readonly [K in Kind]: readonly [FieldSpec, ...ReadonlyArray<FieldSpec>] } = {
  "api-credential": [primary("credential"), plain("notes")],
  login: [primary("password"), plain("username"), plain("notes")],
  database: [primary("password"), plain("username"), plain("host"), plain("port"), plain("database"), plain("notes")],
}

const isKind = (input: string): input is Kind => all.some((kind) => kind === input)

export const Kind = {
  all,
  plainLabels,
  parse: (input: string): Result.Result<Kind, { readonly allowed: ReadonlyArray<Kind> }> =>
    isKind(input) ? Result.succeed(input) : Result.fail({ allowed: all }),
  // Display order: the primary Field first.
  fields: (kind: Kind): ReadonlyArray<FieldSpec> => specs[kind],
  primary: (kind: Kind): FieldSpec => specs[kind][0],
  spec: (kind: Kind, labelKey: NameKey): FieldSpec | undefined =>
    specs[kind].find((spec) => Name.key(spec.label) === labelKey),
} as const
