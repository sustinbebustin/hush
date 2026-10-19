import { Data, Result, type Types } from "effect"

import { Access } from "../shared/Access.js"
import { maxTtlSeconds, type TokenInfo, type TokenIssueRequest } from "../shared/Api.js"
import { Duration } from "../shared/Duration.js"
import { Name } from "../shared/Name.js"
import { Key } from "./Key.js"
import { Problem } from "./Problem.js"

// The Token issue form as plain state: a Label, one Grant choice per Vault, an optional TTL and, when the Label
// belongs to a Token that is not revoked, whether to replace that Token (ADR-0007: Grants are fixed, so a change
// is a replacement that revokes the old Token in the same step). `submit` turns it into the one `tokens/issue`.

// A Vault's row in the Grant picker: no Grant, or one of the two Access levels.
export type Choice = "none" | Access

const choices: ReadonlyArray<Choice> = ["none", ...Access.all]

// Not replacing; replacing and keeping the old Grants (the picker adds Vaults or changes their Access); or
// replacing with exactly the Grants the picker shows, which start as the old ones.
export type Replacement = "none" | "keep" | "edit"

const replacements: ReadonlyArray<Replacement> = ["none", "keep", "edit"]

export interface GrantChoice {
  readonly vault: string
  readonly choice: Choice
}

// A Token whose Label the form can replace, with the Grants it holds.
export type Replaceable = Pick<TokenInfo, "label" | "grants">

export interface IssueForm {
  readonly label: string
  // In the sidebar's Vault order.
  readonly grants: ReadonlyArray<GrantChoice>
  // As typed, such as `90d`; empty for a Token that never expires.
  readonly ttl: string
  readonly replacement: Replacement
  // The focused row, an index into `fields`.
  readonly field: number
  readonly replaceable: ReadonlyArray<Replaceable>
}

// What a submit sends: the `tokens/issue` payload without the Passphrase, which the request adds.
export type IssueFields = Omit<TokenIssueRequest, "passphrase">

// A row of the form.
export type Field = Data.TaggedEnum<{
  Label: {}
  Grant: { readonly index: number }
  Ttl: {}
  Replace: { readonly old: Replaceable }
}>

const Field = Data.taggedEnum<Field>()

// A form with no Grant chosen. Revoked Tokens are left out of `tokens`: their Labels are free again.
const open = (vaults: ReadonlyArray<string>, tokens: ReadonlyArray<TokenInfo>): IssueForm => ({
  label: "",
  grants: vaults.map((vault) => ({ vault, choice: "none" })),
  ttl: "",
  replacement: "none",
  field: 0,
  replaceable: tokens.flatMap(({ label, grants, state }) => (state === "revoked" ? [] : [{ label, grants }])),
})

// Name identity, as the Server compares Labels and Vaults; a text that is not a Name matches nothing.
const sameName = (left: string, right: string): boolean => {
  const a = Name.parse(left)
  const b = Name.parse(right)

  return Result.isSuccess(a) && Result.isSuccess(b) && Name.key(a.success) === Name.key(b.success)
}

// The Token the typed Label would replace, if any.
const replaced = (form: IssueForm): Replaceable | undefined =>
  form.replaceable.find(({ label }) => sameName(label, form.label))

// The rows in order; the replace row appears only while the Label belongs to a replaceable Token.
const fields = (form: IssueForm): ReadonlyArray<Field> => {
  const old = replaced(form)

  return [
    Field.Label(),
    ...form.grants.map((_, index) => Field.Grant({ index })),
    Field.Ttl(),
    ...(old === undefined ? [] : [Field.Replace({ old })]),
  ]
}

const focused = (form: IssueForm): Field => {
  const all = fields(form)

  return all[Math.min(form.field, all.length - 1)] ?? Field.Label()
}

// The option `step` places after `current`, wrapping around.
const cycle = <A>(all: ReadonlyArray<A>, current: A, step: number): A =>
  all[(all.indexOf(current) + step + all.length) % all.length] ?? current

// A text field after `key`: Backspace erases one character, a printable key appends it.
const edited = (text: string, key: Key): string => {
  if (Key.is(key, "backspace")) return [...text].slice(0, -1).join("")

  return text + (Key.printable(key) ?? "")
}

// The picker set to the old Token's Grants, for a replacement that edits them.
const withGrantsOf = (form: IssueForm, old: Replaceable): IssueForm => ({
  ...form,
  grants: form.grants.map(({ vault }) => ({
    vault,
    choice: old.grants.find((grant) => sameName(grant.vault, vault))?.access ?? "none",
  })),
})

const stepOf = (key: Key): number | undefined => {
  if (Key.is(key, "space") || Key.is(key, "right") || Key.is(key, " ")) return 1

  return Key.is(key, "left") ? -1 : undefined
}

// The form after one key other than Enter, Escape and Ctrl-C (the reducer's). Up and Down (or Tab) move between
// rows; text rows take typing; Space, Left and Right change a Grant or the replacement.
const key = (form: IssueForm, pressed: Key): IssueForm => {
  const last = fields(form).length - 1

  if (Key.is(pressed, "up")) return { ...form, field: Math.max(0, Math.min(last, form.field) - 1) }

  if (Key.is(pressed, "down") || Key.is(pressed, "tab")) return { ...form, field: Math.min(last, form.field + 1) }
  const step = stepOf(pressed)

  return Field.$match(focused(form), {
    Label: () => ({ ...form, label: edited(form.label, pressed) }),
    Ttl: () => ({ ...form, ttl: edited(form.ttl, pressed) }),
    Grant: ({ index }) =>
      step === undefined
        ? form
        : {
            ...form,
            grants: form.grants.map((grant, at) =>
              at === index ? { ...grant, choice: cycle(choices, grant.choice, step) } : grant,
            ),
          },
    Replace: ({ old }) => {
      if (step === undefined) return form
      const replacement = cycle(replacements, form.replacement, step)

      return replacement === "edit" ? withGrantsOf({ ...form, replacement }, old) : { ...form, replacement }
    },
  })
}

// Pasted text, on a text row only.
const paste = (form: IssueForm, text: string): IssueForm =>
  Field.$match(focused(form), {
    Label: () => ({ ...form, label: form.label + text }),
    Ttl: () => ({ ...form, ttl: form.ttl + text }),
    Grant: () => form,
    Replace: () => form,
  })

const maxTtlDays = maxTtlSeconds / 86_400

const refused = (message: string) => Result.fail(Problem.Failed({ message: `${message}; nothing was issued.` }))

// The one request the form sends, or why it cannot be sent. Names are left to the Server (`InvalidName`).
const submit = (form: IssueForm): Result.Result<IssueFields, Problem> => {
  const replacement = replaced(form) === undefined ? "none" : form.replacement
  const grants = form.grants.flatMap(({ vault, choice }) => (choice === "none" ? [] : [{ vault, access: choice }]))
  const ttlSeconds = form.ttl === "" ? undefined : Duration.seconds(form.ttl)

  if (form.label === "") return refused("Type a Label for the Token")

  if (ttlSeconds === undefined && form.ttl !== "")
    return refused(
      `TTL ${form.ttl} is not a duration such as 90d (a whole number and one of s, m, h, d, w), at most ${maxTtlDays} days`,
    )

  if (ttlSeconds !== undefined && ttlSeconds > maxTtlSeconds)
    return refused(`TTL ${form.ttl} is longer than the most a Token may live, at most ${maxTtlDays} days`)

  if (grants.length === 0 && replacement !== "keep")
    return refused("Choose Read or Read+Create for at least one Vault with Space on its row")
  const request: Types.Mutable<IssueFields> = { label: form.label, grants }

  if (ttlSeconds !== undefined) request.ttlSeconds = ttlSeconds

  if (replacement !== "none") request.replaces = true

  if (replacement === "keep") request.keepGrants = true

  return Result.succeed(request)
}

const accessText = (choice: Choice) => (choice === "none" ? "-" : choice)

const replacementText = (replacement: Replacement) => {
  switch (replacement) {
    case "none":
      return "no (Space to replace it)"
    case "keep":
      return "yes, keeping its Grants and adding those above"
    case "edit":
      return "yes, with exactly the Grants above"
  }
}

// The form as the modal draws it: one line per row, `>` on the focused one and `_` where typing goes.
const lines = (form: IssueForm): string => {
  const all = fields(form)
  const current = Math.min(form.field, all.length - 1)
  const width = Math.max(0, ...form.grants.map(({ vault }) => vault.length))

  const text = (field: Field, focus: boolean) =>
    Field.$match(field, {
      Label: () => `Label: ${form.label}${focus ? "_" : ""}\n  Grants (Space: - / read / read+create):`,
      Grant: ({ index }) => {
        const grant = form.grants[index]

        return grant === undefined ? "" : `  ${grant.vault.padEnd(width)}  ${accessText(grant.choice)}`
      },
      Ttl: () => `TTL: ${form.ttl}${focus ? "_" : ""}  (empty: never; at most ${maxTtlDays}d)`,
      Replace: ({ old }) => `Replace ${old.label}: ${replacementText(form.replacement)}`,
    })

  return all.map((field, index) => `${index === current ? "> " : "  "}${text(field, index === current)}`).join("\n")
}

export const IssueForm = { open, key, paste, submit, lines } as const
