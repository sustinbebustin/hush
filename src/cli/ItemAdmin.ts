import { Data, Effect, Redacted, Result } from "effect"

import { Api, type ItemChange } from "../shared/Api.js"
import { parseName } from "../shared/ApiError.js"
import { Name } from "../shared/Name.js"
import { Reference } from "../shared/Reference.js"
import { passphraseCommand, passphraseOnly, type SecretSource, unverifiedOnTransport } from "./Admin.js"
import { Client } from "./Client.js"
import {
  EditFlagsInvalid,
  type InputSourceConflict,
  type InputSourceRequired,
  InvalidReference,
  releaseCommand,
  UnexpectedResponse,
} from "./CliError.js"
import { PassphraseStdin } from "./PassphraseStdin.js"
import { PrivateInput } from "./PrivateInput.js"
import type { Target } from "./Target.js"

// The Owner's Item commands: `item list|edit|rename|delete|release|reveal`, each one Passphrase request.

const parse = (what: string, input: string) => Effect.fromResult(parseName(what, input))

// What `item edit` was asked to do, from its flags: set a Field from one private source, or remove one.
type Edit = Data.TaggedEnum<{
  Set: { readonly label: string; readonly from: PrivateInput.PrivateSource }
  Remove: { readonly label: string }
}>

const Edit = Data.taggedEnum<Edit>()

const editOf = (
  input: ItemEditInput,
): Result.Result<Edit, EditFlagsInvalid | InputSourceRequired | InputSourceConflict> => {
  const { field, remove, sources } = input

  if (field !== undefined && remove === undefined)
    return Result.map(PrivateInput.source(sources, "changed"), (from) => Edit.Set({ label: field, from }))
  const anySource = sources.stdin || sources.prompt || sources.clipboard

  if (remove !== undefined && field === undefined && !anySource) return Result.succeed(Edit.Remove({ label: remove }))

  return Result.fail(new EditFlagsInvalid())
}

// The Passphrase and the change to send. With `--passphrase-stdin` and `--stdin` both, the value is everything
// after the Passphrase line;otherwise the Passphrase comes first, then the value from its own source.
const editSecrets = (edit: Edit, label: Name) => (command: string, source: SecretSource) =>
  Effect.gen(function* () {
    if (Edit.$is("Remove")(edit)) {
      const change: ItemChange = { remove: label }

      return { passphrase: yield* passphraseOnly(command, source), change }
    }

    const wording = { noun: `value for ${label}`, outcome: "changed" } as const

    if (source === "stdin" && edit.from === "stdin") {
      const piped = yield* PassphraseStdin.readWithValue(command)
      const value = yield* Effect.fromResult(PrivateInput.value(piped.value, wording))
      const change: ItemChange = { set: { label, value } }

      return { passphrase: Redacted.make(piped.passphrase), change }
    }

    const passphrase = yield* passphraseOnly(command, source)
    const value = yield* PrivateInput.read({ source: edit.from, wording, prompt: `Value for ${label}: ` })
    const change: ItemChange = { set: { label, value } }

    return { passphrase, change }
  })

// A name the Server answered with, or `UnexpectedResponse` for one that is not a Name.
const answered = (target: Target, text: string) =>
  Result.match(Name.parse(text), {
    onSuccess: (name) => Effect.succeed(name),
    onFailure: () => Effect.fail(new UnexpectedResponse({ url: target.origin, status: 200 })),
  })

// The Reference of a Field the Server named.
const referenceOf = (
  target: Target,
  parts: { readonly vault: string; readonly item: string; readonly field: string },
) =>
  Effect.map(
    Effect.all({
      vault: answered(target, parts.vault),
      item: answered(target, parts.item),
      field: answered(target, parts.field),
    }),
    Reference.format,
  )

export interface ItemEditInput {
  readonly target: Target
  readonly source: SecretSource
  readonly vault: string
  readonly title: string
  readonly field: string | undefined
  readonly remove: string | undefined
  readonly sources: PrivateInput.SourceFlags
}

// `hush item edit <vault> <title> (--field L (--stdin | --prompt | --clipboard) | --remove L)`: flags and names,
// then the Passphrase and the value, then one `admin/items/edit`, which verifies the new seal before commit.
export const itemEdit = (input: ItemEditInput) =>
  Effect.gen(function* () {
    const edit = yield* Effect.fromResult(editOf(input))
    const label = yield* parse("field", edit.label)

    return yield* passphraseCommand({
      command: "item edit",
      source: input.source,
      secrets: editSecrets(edit, label),
      prepare: Effect.all({ vault: parse("vault", input.vault), item: parse("title", input.title) }),
      send: ({ vault, item }, { passphrase, change }) =>
        Effect.gen(function* () {
          const edited = yield* unverifiedOnTransport(
            Client.request(Api, input.target, (client) =>
              client.admin.itemsEdit({ payload: { passphrase, vault, item, change } }),
            ),
          )

          const fields = yield* Effect.forEach(edited.fields, (field) =>
            Effect.map(
              referenceOf(input.target, { vault: edited.vault, item: edited.title, field: field.label }),
              (ref) => ({ ...field, ref }),
            ),
          )

          return { ...edited, fields }
        }),
    })
  })

// Told on stderr when a rename or delete retired a title.
const retiredNotice = (vault: string, title: string) =>
  `Tokens cannot create an Item titled ${title} in Vault ${vault} again until you run ${releaseCommand(vault, title)}.`

// The receipt for stdout and the notices for stderr.
export interface Retiring<R> {
  readonly receipt: R
  readonly notices: ReadonlyArray<string>
}

interface ItemInput {
  readonly target: Target
  readonly source: SecretSource
  readonly vault: string
  readonly title: string
}

// `hush item rename <vault> <title> <new-title>`: one `admin/items/rename`. `retired` is the old title, or null
// for a case-only change, which retires nothing.
export const itemRename = (input: ItemInput & { readonly newTitle: string }) =>
  passphraseCommand({
    command: "item rename",
    source: input.source,
    secrets: passphraseOnly,
    prepare: Effect.all({
      vault: parse("vault", input.vault),
      item: parse("title", input.title),
      newTitle: parse("new title", input.newTitle),
    }),
    send: (names, passphrase) =>
      Effect.gen(function* () {
        const renamed = yield* unverifiedOnTransport(
          Client.request(Api, input.target, (client) =>
            client.admin.itemsRename({ payload: { passphrase, ...names } }),
          ),
        )

        const from = yield* answered(input.target, renamed.from)
        const to = yield* answered(input.target, renamed.to)
        const retired = Name.key(from) === Name.key(to) ? null : renamed.from

        const delivered: Retiring<typeof renamed & { readonly retired: string | null }> = {
          receipt: { ...renamed, retired },
          notices: retired === null ? [] : [retiredNotice(renamed.vault, retired)],
        }

        return delivered
      }),
  })

// `hush item delete <vault> <title>`: one `admin/items/delete`; the title is always retired.
export const itemDelete = (input: ItemInput) =>
  passphraseCommand({
    command: "item delete",
    source: input.source,
    secrets: passphraseOnly,
    prepare: Effect.all({ vault: parse("vault", input.vault), item: parse("title", input.title) }),
    send: (names, passphrase) =>
      Effect.gen(function* () {
        const deleted = yield* unverifiedOnTransport(
          Client.request(Api, input.target, (client) =>
            client.admin.itemsDelete({ payload: { passphrase, ...names } }),
          ),
        )

        const delivered: Retiring<typeof deleted & { readonly retired: true }> = {
          receipt: { ...deleted, retired: true },
          notices: [retiredNotice(deleted.vault, deleted.title)],
        }

        return delivered
      }),
  })

// `hush item list <vault>`: one `admin/items/list`; reads only, so a lost answer is plain `ServerUnreachable`.
export const itemList = (input: { readonly target: Target; readonly source: SecretSource; readonly vault: string }) =>
  passphraseCommand({
    command: "item list",
    source: input.source,
    secrets: passphraseOnly,
    prepare: parse("vault", input.vault),
    send: (vault, passphrase) =>
      Client.request(Api, input.target, (client) => client.admin.itemsList({ payload: { passphrase, vault } })),
  })

// `hush item release <vault> <title>`: one `admin/items/release`.
export const itemRelease = (input: ItemInput) =>
  passphraseCommand({
    command: "item release",
    source: input.source,
    secrets: passphraseOnly,
    prepare: Effect.all({ vault: parse("vault", input.vault), title: parse("title", input.title) }),
    send: (names, passphrase) =>
      unverifiedOnTransport(
        Client.request(Api, input.target, (client) => client.admin.itemsRelease({ payload: { passphrase, ...names } })),
      ),
  })

// `hush item reveal <reference>`: the Reference parsed locally, so a malformed one never prompts; then one
// `admin/items/reveal`. Nothing is written, so a lost answer needs no `ChangeUnverified`. The caller writes the
// value byte-exact, as `read` does.
export const itemReveal = (input: {
  readonly target: Target
  readonly source: SecretSource
  readonly reference: string
}) =>
  passphraseCommand({
    command: "item reveal",
    source: input.source,
    secrets: passphraseOnly,
    prepare: Effect.fromResult(
      Result.mapError(
        Reference.parse(input.reference),
        ({ reason }) => new InvalidReference({ input: input.reference, reason }),
      ),
    ),
    send: (reference, passphrase) =>
      Effect.map(
        Client.request(Api, input.target, (client) =>
          client.admin.itemsReveal({ payload: { passphrase, reference: Reference.format(reference) } }),
        ),
        ({ value }): Redacted.Redacted<string> => value,
      ),
  })

export * as ItemAdmin from "./ItemAdmin.js"
