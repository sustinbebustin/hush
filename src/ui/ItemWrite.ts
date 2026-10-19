import { Data, Redacted, Result } from "effect"

import { CliError, type InputEmpty, type InvalidValue as InputInvalid } from "../cli/CliError.js"
import { PlainField } from "../cli/PlainField.js"
import { PrivateInput } from "../cli/PrivateInput.js"
import type { CreateRequest, ItemChange } from "../shared/Api.js"
import { type InvalidName, type InvalidValue, isApiError, parseName, type UnknownField } from "../shared/ApiError.js"
import { Kind } from "../shared/Kind.js"
import { ItemForm, type Save } from "./ItemForm.js"
import { Problem } from "./Problem.js"

// The Item form's one write, checked as `hush item create` and `hush item edit` check theirs before sending, in
// their order and with their errors. The reducer runs the checks on Enter, before the concealed buffer leaves its
// state, so a refusal keeps what was typed; the interpreter sends what passed, without the Passphrase it adds.

export type ItemWrite = Data.TaggedEnum<{
  Create: { readonly payload: CreateRequest }
  Edit: { readonly vault: string; readonly item: string; readonly change: ItemChange }
}>

const { Create: Created, Edit, $match } = Data.taggedEnum<ItemWrite>()

type CheckError = InvalidName | UnknownField | InvalidValue | InputEmpty | InputInvalid

const checked = (save: Save): Result.Result<ItemWrite, CheckError> =>
  ItemForm.Save.$match(save, {
    Create: ({ vault, title, kind, value, plain }) =>
      Result.gen(function* () {
        const primary = Kind.primary(kind).label
        const names = { vault: yield* parseName("vault", vault), title: yield* parseName("title", title) }

        const fields = yield* Result.all(plain.map(({ label, text }) => PlainField.check(kind, { label, value: text })))

        const secret = yield* PrivateInput.value(Redacted.value(value), {
          noun: `value for ${primary}`,
          outcome: "created",
        })

        return Created({ payload: { ...names, kind, fields: [{ label: primary, value: secret }, ...fields] } })
      }),
    Edit: ({ vault, item, label, change }) =>
      Result.gen(function* () {
        const field = yield* parseName("field", label)
        const names = { vault: yield* parseName("vault", vault), item: yield* parseName("title", item.title) }

        const wire: ItemChange = ItemForm.Change.$is("Set")(change)
          ? {
              set: {
                label: field,
                value: yield* PrivateInput.value(Redacted.value(change.value), {
                  noun: `value for ${field}`,
                  outcome: "changed",
                }),
              },
            }
          : { remove: field }

        return Edit({ ...names, change: wire })
      }),
  })

// `renderServer` names the Server only for NotInitialised and AlreadyInitialised, which no check fails with.
const noServer = ""

// The write `save` sends, or the CLI's own message, word for word, for the check that refused it.
const check = (save: Save): Result.Result<ItemWrite, Problem> =>
  Result.mapError(checked(save), (error) =>
    Problem.Failed({ message: isApiError(error) ? CliError.renderServer(error, noServer) : CliError.render(error) }),
  )

export const ItemWrite = { Create: Created, Edit, $match, check } as const
