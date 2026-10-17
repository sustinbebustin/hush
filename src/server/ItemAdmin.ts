import { Effect, Redacted, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"

import type {
  ItemChange,
  ItemDeleted,
  ItemEditReceipt,
  ItemEditRequest,
  ItemReleased,
  ItemReleaseRequest,
  ItemRenamed,
  ItemRenameRequest,
  ItemRequest,
  ItemRevealed,
  ItemRevealRequest,
  VaultItems,
  VaultRequest,
} from "../shared/Api.js"
import {
  FieldNotFound,
  FieldRequired,
  IntegrityCheckFailed,
  InvalidReference,
  InvalidValue,
  ItemExists,
  ItemNotFound,
  parseName,
  TitleNotRetired,
  UnknownField,
  VaultNotFound,
} from "../shared/ApiError.js"
import { type FieldSpec, Kind } from "../shared/Kind.js"
import { Name } from "../shared/Name.js"
import { Reference } from "../shared/Reference.js"
import { Value } from "../shared/Value.js"
import { Audit } from "./Audit.js"
import { Database } from "./Database.js"
import { Items } from "./Items.js"
import { Keys } from "./Keys.js"
import { Passphrase } from "./Passphrase.js"

// Items under the Passphrase: the Owner's only way to change an existing Item, and to Reveal one Field without a
// Token. Each is one Passphrase check and one transaction with its audit row; the Kind never changes.

const { rows } = Database

const VaultRow = Schema.Struct({
  id: Schema.Number,
  name: Name.schema,
  key_nonce: Schema.Uint8Array,
  key_wrapped: Schema.Uint8Array,
})

const ItemRow = Schema.Struct({ id: Schema.Number, title: Name.schema, kind: Schema.String })
const IdRow = Schema.Struct({ id: Schema.Number })
const LabelRow = Schema.Struct({ label: Name.schema })
const SealedRow = Schema.Struct({ nonce: Schema.Uint8Array, sealed: Schema.Uint8Array })

// The Kind's specs of the labels an Item has, in display order.
const inKindOrder = (kind: Kind, labels: ReadonlyArray<{ readonly label: Name }>): ReadonlyArray<FieldSpec> =>
  Kind.fields(kind).filter((spec) => labels.some(({ label }) => Name.key(label) === Name.key(spec.label)))

type VaultFound = typeof VaultRow.Type

// `kind` stays a string until an operation needs it: deleting an Item whose Kind was damaged still works.
type ItemFound = typeof ItemRow.Type

interface ItemOfKind {
  readonly id: number
  readonly title: Name
  readonly kind: Kind
}

// The first name an audit row records for a requested string, if it is a Name.
const nameOf = (input: string): Name | undefined => Audit.named(input)[0]

const vaultNamed = (vault: Name) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const [found] = yield* rows(
      VaultRow,
      sql`SELECT id, name, key_nonce, key_wrapped FROM vaults WHERE name_key = ${Name.key(vault)}`,
    )

    return found ?? (yield* new VaultNotFound({ vault }))
  })

const findVault = (input: string) => Effect.flatMap(Effect.fromResult(parseName("vault", input)), vaultNamed)

// The Item titled `title` in `vault`, by name identity.
const itemIn = (vault: VaultFound, title: Name) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const [item] = yield* rows(
      ItemRow,
      sql`SELECT id, title, kind FROM items WHERE vault_id = ${vault.id} AND title_key = ${Name.key(title)}`,
    )

    if (item === undefined) return yield* new ItemNotFound({ vault: vault.name, item: title })

    return { vault, item }
  })

// The Vault and the Item a request names: the Vault is looked up before the title is parsed.
const locate = (vaultInput: string, itemInput: string) =>
  Effect.gen(function* () {
    const vault = yield* findVault(vaultInput)

    return yield* itemIn(vault, yield* Effect.fromResult(parseName("title", itemInput)))
  })

// The Item with its Kind. A Kind outside the Kinds can only come from a modified file.
const ofKind = (vault: VaultFound, item: ItemFound): Effect.Effect<ItemOfKind, IntegrityCheckFailed> =>
  Effect.fromResult(
    Result.mapBoth(Kind.parse(item.kind), {
      onSuccess: (kind) => ({ id: item.id, title: item.title, kind }),
      onFailure: () => new IntegrityCheckFailed({ damaged: { what: "item", vault: vault.name, item: item.title } }),
    }),
  )

// `admin/items/list`: one Vault's Items as `items/list` shows them, and its Retired titles. Nothing is unwrapped,
// so the Passphrase check is the whole check.
export const list = (request: VaultRequest, peer: string | null) =>
  Passphrase.audited({
    passphrase: request.passphrase,
    action: "item.list",
    peer,
    scope: { vaults: Audit.named(request.vault) },
    exclusive: false,
    checkpoint: false,
    unlock: Keys.fromPassphrase,
    operation: () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const vault = yield* findVault(request.vault)
        const [listed] = yield* Items.itemsOf([{ vaultId: vault.id, vault: vault.name }])

        if (listed === undefined) return yield* Effect.die(new Error("list: itemsOf returned nothing for one Vault"))

        const retired = yield* rows(
          Items.RetiredRow,
          sql`SELECT title_key FROM retired_titles WHERE vault_id = ${vault.id} ORDER BY title_key`,
        )

        const receipt: VaultItems = {
          vault: vault.name,
          items: listed.items,
          retired: retired.map(({ title_key }) => title_key),
        }

        return receipt
      }),
    recorded: (receipt) => ({ vaults: [receipt.vault] }),
  })

// The Kind's spec for a requested label, or `UnknownField` listing the Kind's labels.
const specFor = (kind: Kind, label: string): Result.Result<FieldSpec, UnknownField> => {
  const name = Name.parse(label)
  const spec = Result.isSuccess(name) ? Kind.spec(kind, Name.key(name.success)) : undefined

  return spec === undefined
    ? Result.fail(new UnknownField({ kind, field: label, allowed: Kind.fields(kind).map((field) => field.label) }))
    : Result.succeed(spec)
}

// K_v unwrapped with MK; a wrap that does not open under the right MK was modified.
const vaultKey = (master: Keys.MasterKey, vault: VaultFound) =>
  Keys.vaultKeyFromMaster(master, vault.id, {
    nonce: new Uint8Array(vault.key_nonce),
    wrapped: new Uint8Array(vault.key_wrapped),
  }).pipe(Effect.mapError(() => new IntegrityCheckFailed({ damaged: { what: "vault-key", vault: vault.name } })))

// What an edit seals with; a test replaces it to corrupt the new seal and prove the
// verification below rolls back.
export interface Sealer {
  readonly sealField: typeof Keys.sealField
}

// `set`: the Field's row keeps its id and gets a new nonce and seal, or an absent Field gets a row with an id from
// `Database.nextIds`. Either way the stored seal is read back, opened with K_v and compared with the input before
// commit; a mismatch fails `IntegrityCheckFailed`, which rolls the transaction back.
const setField = (input: {
  readonly master: Keys.MasterKey
  readonly sealer: Sealer
  readonly at: string
  readonly vault: VaultFound
  readonly item: ItemOfKind
  readonly label: string
  readonly value: Redacted.Redacted<string>
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { vault, item } = input
    const spec = yield* Effect.fromResult(specFor(item.kind, input.label))
    const problem = Value.problem(Redacted.value(input.value))

    if (problem !== undefined) return yield* new InvalidValue({ field: spec.label, reason: problem })
    const labelKey = Name.key(spec.label)

    const [existing] = yield* rows(
      IdRow,
      sql`SELECT id FROM fields WHERE item_id = ${item.id} AND label_key = ${labelKey}`,
    )

    const fieldId = existing?.id ?? (yield* Database.nextId("fields"))
    const reference = Reference.format({ vault: vault.name, item: item.title, field: spec.label })
    const key = yield* vaultKey(input.master, vault)
    const location: Keys.FieldLocation = { vaultId: vault.id, itemId: item.id, fieldId, kind: item.kind, labelKey }
    const sealed = yield* input.sealer.sealField(key, location, Redacted.value(input.value))
    yield* (
      existing === undefined
        ? sql`
            INSERT INTO fields (id, item_id, label, label_key, nonce, sealed, updated_at)
            VALUES (${fieldId}, ${item.id}, ${spec.label}, ${labelKey}, ${sealed.nonce}, ${sealed.wrapped}, ${input.at})`
        : sql`
            UPDATE fields SET nonce = ${sealed.nonce}, sealed = ${sealed.wrapped}, updated_at = ${input.at}
            WHERE id = ${fieldId}`
    ).pipe(Effect.orDie)
    const damaged = new IntegrityCheckFailed({ damaged: { what: "field", reference } })
    const [stored] = yield* rows(SealedRow, sql`SELECT nonce, sealed FROM fields WHERE id = ${fieldId}`)

    if (stored === undefined) return yield* damaged

    const opened = yield* Keys.openField(key, location, {
      nonce: new Uint8Array(stored.nonce),
      wrapped: new Uint8Array(stored.sealed),
    }).pipe(Effect.mapError(() => damaged))

    if (opened !== Redacted.value(input.value)) return yield* damaged
  })

// `remove`: a present plain Field only; the primary Field is `FieldRequired` whether present or not.
const removeField = (vault: VaultFound, item: ItemOfKind, label: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const spec = yield* Effect.fromResult(specFor(item.kind, label))

    if (spec.role === "primary") return yield* new FieldRequired({ kind: item.kind, field: spec.label })

    const removed = yield* rows(
      IdRow,
      sql`DELETE FROM fields WHERE item_id = ${item.id} AND label_key = ${Name.key(spec.label)} RETURNING id`,
    )

    if (removed.length === 0)
      return yield* new FieldNotFound({ vault: vault.name, item: item.title, field: spec.label })
  })

// The label an edit sets or removes, as the audit row names it.
const changeDetail = (change: ItemChange): Audit.Detail => {
  if ("set" in change) {
    const set = nameOf(change.set.label)

    return set === undefined ? {} : { set }
  }

  const removed = nameOf(change.remove)

  return removed === undefined ? {} : { removed }
}

// `items/edit`: one Field set or removed, then the WAL is checkpointed so the old seal leaves the files.
export const edit = (request: ItemEditRequest, peer: string | null, sealer: Sealer = Keys) => {
  const title = nameOf(request.item)
  const detail: Audit.Detail = { title, ...changeDetail(request.change) }

  return Passphrase.audited({
    passphrase: request.passphrase,
    action: "item.edit",
    peer,
    scope: { vaults: Audit.named(request.vault), detail },
    exclusive: false,
    checkpoint: true,
    unlock: Keys.fromPassphrase,
    operation: (unlocked) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const located = yield* locate(request.vault, request.item)
        const { vault } = located
        const item = yield* ofKind(vault, located.item)
        const at = yield* Audit.now
        const { change } = request

        if ("set" in change)
          yield* setField({
            master: unlocked,
            sealer,
            at,
            vault,
            item,
            label: change.set.label,
            value: change.set.value,
          })
        else yield* removeField(vault, item, change.remove)
        yield* sql`UPDATE items SET updated_at = ${at} WHERE id = ${item.id}`.pipe(Effect.orDie)
        const labels = yield* rows(LabelRow, sql`SELECT label FROM fields WHERE item_id = ${item.id}`)

        const receipt: ItemEditReceipt = {
          vault: vault.name,
          title: item.title,
          kind: item.kind,
          fields: inKindOrder(item.kind, labels).map((spec) => ({
            label: spec.label,
            concealed: spec.role === "primary",
          })),
          updatedAt: at,
          verified: true,
        }

        return receipt
      }),
    recorded: (receipt) => ({ vaults: [receipt.vault], detail: { ...detail, title: receipt.title } }),
  })
}

// A title freed by a rename or delete: Tokens cannot create it until the Owner releases it. It is never
// already retired, since no live Item has a retired key; the guard keeps a broken store from failing the write.
const retire = (vaultId: number, title: Name) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const at = yield* Audit.now
    yield* sql`
      INSERT INTO retired_titles (vault_id, title_key, retired_at) VALUES (${vaultId}, ${Name.key(title)}, ${at})
      ON CONFLICT DO NOTHING`.pipe(Effect.orDie)
  })

// Frees a Retired title, returning whether it was retired.
const unretire = (vaultId: number, title: Name) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const released = yield* rows(
      Items.RetiredRow,
      sql`DELETE FROM retired_titles WHERE vault_id = ${vaultId} AND title_key = ${Name.key(title)} RETURNING title_key`,
    )

    return released.length > 0
  })

// `items/rename`: the title and its key change, nothing is re-sealed (the Field AAD binds ids, not the title).
// Unless only the case changed, the old title is retired, and a new title that was retired is released. The unique
// index decides `ItemExists`. The WAL is checkpointed after commit.
export const rename = (request: ItemRenameRequest, peer: string | null) => {
  const from = nameOf(request.item)
  const to = nameOf(request.newTitle)

  return Passphrase.audited({
    passphrase: request.passphrase,
    action: "item.rename",
    peer,
    scope: {
      vaults: Audit.named(request.vault),
      detail: { from, to },
    },
    exclusive: false,
    checkpoint: true,
    unlock: Keys.fromPassphrase,
    operation: () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const newTitle = yield* Effect.fromResult(parseName("new title", request.newTitle))
        const located = yield* locate(request.vault, request.item)
        const { vault } = located
        const item = yield* ofKind(vault, located.item)
        yield* sql`UPDATE items SET title = ${newTitle}, title_key = ${Name.key(newTitle)} WHERE id = ${item.id}`.pipe(
          Effect.catchReason("SqlError", "UniqueViolation", () =>
            Effect.fail(new ItemExists({ vault: vault.name, item: newTitle })),
          ),
          Effect.catchTag("SqlError", Effect.die),
        )

        if (Name.key(newTitle) !== Name.key(item.title)) {
          yield* retire(vault.id, item.title)
          yield* unretire(vault.id, newTitle)
        }

        const labels = yield* rows(LabelRow, sql`SELECT label FROM fields WHERE item_id = ${item.id}`)

        const renamed: ItemRenamed = {
          vault: vault.name,
          from: item.title,
          to: newTitle,
          references: inKindOrder(item.kind, labels).map((spec) => ({
            old: Reference.format({ vault: vault.name, item: item.title, field: spec.label }),
            new: Reference.format({ vault: vault.name, item: newTitle, field: spec.label }),
          })),
        }

        return renamed
      }),
    recorded: (renamed) => ({ vaults: [renamed.vault], detail: { from: renamed.from, to: renamed.to } }),
  })
}

// `items/delete`: the Item goes with its Fields (cascade), its title is retired, and the WAL is checkpointed so
// the sealed values leave the files.
export const remove = (request: ItemRequest, peer: string | null) => {
  const title = nameOf(request.item)

  return Passphrase.audited({
    passphrase: request.passphrase,
    action: "item.delete",
    peer,
    scope: { vaults: Audit.named(request.vault), detail: title === undefined ? undefined : { title } },
    exclusive: false,
    checkpoint: true,
    unlock: Keys.fromPassphrase,
    operation: () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { vault, item } = yield* locate(request.vault, request.item)
        yield* sql`DELETE FROM items WHERE id = ${item.id}`.pipe(Effect.orDie)
        yield* retire(vault.id, item.title)
        const deleted: ItemDeleted = { deleted: true, vault: vault.name, title: item.title }

        return deleted
      }),
    recorded: (deleted) => ({ vaults: [deleted.vault], detail: { title: deleted.title } }),
  })
}

// `items/release`: a Retired title becomes free for Tokens again.
export const releaseTitle = (request: ItemReleaseRequest, peer: string | null) => {
  const title = nameOf(request.title)

  return Passphrase.audited({
    passphrase: request.passphrase,
    action: "item.release",
    peer,
    scope: { vaults: Audit.named(request.vault), detail: title === undefined ? undefined : { title } },
    exclusive: false,
    checkpoint: false,
    unlock: Keys.fromPassphrase,
    operation: () =>
      Effect.gen(function* () {
        const vault = yield* findVault(request.vault)
        const parsed = yield* Effect.fromResult(parseName("title", request.title))

        if (!(yield* unretire(vault.id, parsed))) return yield* new TitleNotRetired({ vault: vault.name, item: parsed })
        const released: ItemReleased = { released: true, vault: vault.name, title: parsed }

        return released
      }),
    recorded: (released) => ({ vaults: [released.vault], detail: { title: released.title } }),
  })
}

const FieldRow = Schema.Struct({
  id: Schema.Number,
  label: Name.schema,
  nonce: Schema.Uint8Array,
  sealed: Schema.Uint8Array,
})

// `items/reveal`: one Field opened with K_v from MK, never a Token wrap. An unparsable Reference may be anything,
// even a pasted secret, so its row names nothing; a parsed one is named as requested, then as stored.
export const reveal = (request: ItemRevealRequest, peer: string | null) => {
  const parsed = Result.mapError(
    Reference.parse(request.reference),
    ({ reason }) => new InvalidReference({ reference: request.reference, reason }),
  )

  const scope: Passphrase.Scope = Result.match(parsed, {
    onFailure: () => ({ vaults: [] }),
    onSuccess: (reference) => ({ vaults: [reference.vault], references: [Reference.format(reference)] }),
  })

  return Passphrase.audited({
    passphrase: request.passphrase,
    action: "item.reveal",
    peer,
    scope,
    exclusive: false,
    checkpoint: false,
    unlock: Keys.fromPassphrase,
    operation: (master) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const reference = yield* Effect.fromResult(parsed)
        const located = yield* itemIn(yield* vaultNamed(reference.vault), reference.item)
        const { vault } = located
        const item = yield* ofKind(vault, located.item)

        const [field] = yield* rows(
          FieldRow,
          sql`SELECT id, label, nonce, sealed FROM fields WHERE item_id = ${item.id} AND label_key = ${Name.key(reference.field)}`,
        )

        if (field === undefined)
          return yield* new FieldNotFound({ vault: vault.name, item: item.title, field: reference.field })
        const stored = Reference.format({ vault: vault.name, item: item.title, field: field.label })
        const key = yield* vaultKey(master, vault)
        const labelKey = Name.key(field.label)

        const value = yield* Keys.openField(
          key,
          { vaultId: vault.id, itemId: item.id, fieldId: field.id, kind: item.kind, labelKey },
          { nonce: new Uint8Array(field.nonce), wrapped: new Uint8Array(field.sealed) },
        ).pipe(Effect.mapError(() => new IntegrityCheckFailed({ damaged: { what: "field", reference: stored } })))

        return { vault: vault.name, reference: stored, revealed: { value: Redacted.make(value) } }
      }),
    recorded: ({ vault, reference }) => ({ vaults: [vault], references: [reference] }),
  }).pipe(Effect.map(({ revealed }): ItemRevealed => revealed))
}

export * as ItemAdmin from "./ItemAdmin.js"
