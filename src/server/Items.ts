import { Effect, Redacted, Result, Schema, type Types } from "effect"
import { SqlClient } from "effect/sql"

import {
  type AuthenticatedToken,
  type CreateReceipt,
  type CreateRequest,
  type ItemList,
  type ItemMeta,
  type ListRequest,
  maxReferences,
  type ResolveRequest,
  type ResolveResponse,
} from "../shared/Api.js"
import { Access } from "../shared/Access.js"
import {
  CreateNotAllowed,
  FieldRequired,
  IntegrityCheckFailed,
  InvalidReference,
  InvalidValue,
  ItemExists,
  LimitExceeded,
  parseName,
  ReferenceNotFound,
  TitleRetired,
  UnknownField,
  VaultNotGranted,
} from "../shared/ApiError.js"
import { type FieldSpec, Kind } from "../shared/Kind.js"
import { Match } from "../shared/Match.js"
import { Name } from "../shared/Name.js"
import { Reference } from "../shared/Reference.js"
import { Value } from "../shared/Value.js"
import { Audit } from "./Audit.js"
import { Database } from "./Database.js"
import { Keys } from "./Keys.js"
import { Tokens } from "./Tokens.js"

// Items under a Token: `items/list`, `secrets/resolve` and `items/create`. Each runs in one transaction with its
// audit row (`Tokens.audited`); resolve and create re-read the Token's state with the wraps they use, so a Token
// revoked mid-request is not honoured. Create refuses a Retired title; `ItemAdmin` retires and releases.

type Grant = AuthenticatedToken["grants"][number]

// The Grant for `vault` by name identity, or `VaultNotGranted` naming the granted Vaults and the closest one.
const grantFor = (token: AuthenticatedToken, vault: Name): Result.Result<Grant, VaultNotGranted> => {
  const grant = token.grants.find((candidate) => Name.key(candidate.vault) === Name.key(vault))

  if (grant !== undefined) return Result.succeed(grant)

  const [closest] = Match.suggest(
    Match.terms(vault),
    token.grants.map((candidate) => ({ title: candidate.vault })),
    { max: 1 },
  )

  const refusal: Types.Mutable<ConstructorParameters<typeof VaultNotGranted>[0]> = {
    vault,
    label: token.label,
    granted: token.grants.map(({ vault: name, access }) => ({ vault: name, access })),
  }

  if (closest !== undefined) refusal.suggestion = closest.title

  return Result.fail(new VaultNotGranted(refusal))
}

// The Vault an audit row names: the stored display name when granted, else the name as requested.
const vaultName = (token: AuthenticatedToken, requested: string): string =>
  Result.match(Name.parse(requested), {
    onFailure: () => requested,
    onSuccess: (name) => Result.getOrUndefined(grantFor(token, name))?.vault ?? name,
  })

// `kind` stays a string: a value outside the Kinds can only come from a modified file, and is reported as such.
const ItemRow = Schema.Struct({ id: Schema.Number, title: Name.schema, kind: Schema.String })

const FieldRow = Schema.Struct({
  id: Schema.Number,
  label: Name.schema,
  nonce: Schema.Uint8Array,
  sealed: Schema.Uint8Array,
})

const { rows } = Database

export const resolve = (token: AuthenticatedToken, request: ResolveRequest, peer: string | null) => {
  const parsed: Result.Result<ReadonlyArray<Reference>, InvalidReference | LimitExceeded> = request.references.length >
  maxReferences
    ? Result.fail(new LimitExceeded({ what: "references", max: maxReferences }))
    : Result.all(
        request.references.map((reference) =>
          Result.mapError(Reference.parse(reference), ({ reason }) => new InvalidReference({ reference, reason })),
        ),
      )

  // An unparsable string may be anything, even a pasted secret, so it is never recorded; nor is a request over
  // the limit.
  const scope: Tokens.Scope = Result.match(parsed, {
    onFailure: () => ({ vaults: [], references: [] }),
    onSuccess: (references) => ({
      vaults: [...new Set(references.map(({ vault }) => vaultName(token, vault)))],
      references: references.map(Reference.format),
    }),
  })

  return Tokens.audited({
    token,
    action: "secrets.resolve",
    peer,
    scope,
    operation: Effect.flatMap(Effect.fromResult(parsed), (references) => resolveAll(token, references)),
  })
}

// All or nothing: every Reference is checked against the Grants and the store before any key is unwrapped, and
// one failure returns nothing.
const resolveAll = (token: AuthenticatedToken, references: ReadonlyArray<Reference>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const granted = yield* Effect.forEach(references, (reference) =>
      Effect.map(Effect.fromResult(grantFor(token, reference.vault)), (grant) => ({ reference, grant })),
    )

    const wraps = yield* Tokens.activeWraps(token, [...new Set(granted.map(({ grant }) => grant.vaultId))])

    const located = yield* Effect.forEach(granted, ({ reference, grant }) =>
      Effect.gen(function* () {
        const [item] = yield* rows(
          ItemRow,
          sql`SELECT id, title, kind FROM items WHERE vault_id = ${grant.vaultId} AND title_key = ${Name.key(reference.item)}`,
        )

        const missing = (what: "item" | "field", suggestions: ReadonlyArray<Reference>) =>
          new ReferenceNotFound({
            reference: Reference.format(reference),
            missing: what,
            suggestions: suggestions.map(Reference.format),
          })

        if (item === undefined) return yield* missing("item", yield* closeItems(grant, reference))

        const [field] = yield* rows(
          FieldRow,
          sql`SELECT id, label, nonce, sealed FROM fields WHERE item_id = ${item.id} AND label_key = ${Name.key(reference.field)}`,
        )

        if (field === undefined)
          return yield* missing("field", yield* closeFields(grant, item.id, item.title, reference))
        const stored = Reference.format({ vault: grant.vault, item: item.title, field: field.label })

        return { grant, item, field, stored }
      }),
    )

    const keys = new Map<number, Keys.VaultKey>()
    const values = []

    for (const { grant, item, field, stored } of located) {
      const tampered = new IntegrityCheckFailed({ damaged: { what: "field", reference: stored } })
      const wrap = wraps.get(grant.vaultId) ?? (yield* Effect.die(new Error("resolve: a granted Vault has no wrap")))
      const key = keys.get(grant.vaultId) ?? (yield* vaultKey(token, grant, wrap))
      keys.set(grant.vaultId, key)
      const kind = yield* Effect.fromResult(Result.mapError(Kind.parse(item.kind), () => tampered))
      const labelKey = Name.key(field.label)

      const value = yield* Keys.openField(
        key,
        { vaultId: grant.vaultId, itemId: item.id, fieldId: field.id, kind, labelKey },
        { nonce: new Uint8Array(field.nonce), wrapped: new Uint8Array(field.sealed) },
      ).pipe(Effect.mapError(() => tampered))

      values.push({
        reference: stored,
        value: Redacted.make(value),
        concealed: Kind.spec(kind, labelKey)?.role === "primary",
      })
    }

    const response: ResolveResponse = { values }

    return response
  })

const TitledFieldRow = Schema.Struct({ title: Name.schema, label: Name.schema })
const LabelRow = Schema.Struct({ label: Name.schema })

// `ReferenceNotFound`'s suggestions, from the granted Vault only and names only: the Items of close
// titles that have the requested Field, closest first.
const closeItems = (grant: Grant, reference: Reference) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const candidates = yield* rows(
      TitledFieldRow,
      sql`SELECT i.title, f.label FROM items i JOIN fields f ON f.item_id = i.id
          WHERE i.vault_id = ${grant.vaultId} AND f.label_key = ${Name.key(reference.field)}`,
    )

    return Match.suggest(Match.terms(reference.item), candidates).map(({ title, label }) => ({
      vault: grant.vault,
      item: title,
      field: label,
    }))
  })

// The Item's own Fields when only the Field is missing, closest label first and at most three, however far.
const closeFields = (grant: Grant, itemId: number, title: Name, reference: Reference) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const labels = yield* rows(LabelRow, sql`SELECT label FROM fields WHERE item_id = ${itemId}`)

    return Match.suggest(
      Match.terms(reference.field),
      labels.map(({ label }) => ({ title: label })),
      { threshold: 0 },
    ).map(({ title: label }) => ({ vault: grant.vault, item: title, field: label }))
  })

// K_v from the Token's Grant wrap; a wrap that does not open after a hash match was modified.
const vaultKey = (token: AuthenticatedToken, grant: Grant, wrap: Keys.GrantWrap) =>
  Keys.vaultKeyFromToken(token, wrap).pipe(
    Effect.mapError(() => new IntegrityCheckFailed({ damaged: { what: "vault-key", vault: grant.vault } })),
  )

const ListedItemRow = Schema.Struct({
  id: Schema.Number,
  vault_id: Schema.Number,
  title: Name.schema,
  kind: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
})

const ListedFieldRow = Schema.Struct({ item_id: Schema.Number, label: Name.schema })

// `items/list`: the Grants named by `vaults`, or all of them, each with its Items' metadata. Names only: nothing
// is unwrapped, so `TokenAuth`'s check of the Token is the whole check.
export const list = (token: AuthenticatedToken, request: ListRequest, peer: string | null) =>
  Tokens.audited({
    token,
    action: "items.list",
    peer,
    scope: {
      vaults:
        request.vaults === undefined
          ? token.grants.map(({ vault }) => vault)
          : request.vaults.map((vault) => vaultName(token, vault)),
      references: [],
    },
    operation: Effect.gen(function* () {
      const grants =
        request.vaults === undefined
          ? token.grants
          : yield* Effect.forEach(request.vaults, (requested) =>
              Effect.flatMap(Effect.fromResult(parseName("vault", requested)), (vault) =>
                Effect.fromResult(grantFor(token, vault)),
              ),
            )

      return yield* listed(grants)
    }),
  })

const listed = (grants: ReadonlyArray<Grant>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const vaultIds = grants.map(({ vaultId }) => vaultId)

    const items =
      vaultIds.length === 0
        ? []
        : yield* rows(
            ListedItemRow,
            sql`SELECT id, vault_id, title, kind, created_at, updated_at FROM items
                WHERE ${sql.in("vault_id", vaultIds)} ORDER BY title_key`,
          )

    const fields =
      items.length === 0
        ? []
        : yield* rows(
            ListedFieldRow,
            sql`SELECT item_id, label FROM fields WHERE ${sql.in(
              "item_id",
              items.map(({ id }) => id),
            )}`,
          )

    const vaults = yield* Effect.forEach(grants, (grant) =>
      Effect.map(
        Effect.forEach(
          items.filter(({ vault_id }) => vault_id === grant.vaultId),
          (item) =>
            itemMeta(
              grant.vault,
              item,
              fields.filter(({ item_id }) => item_id === item.id).map(({ label }) => label),
            ),
        ),
        (metas) => ({ vault: grant.vault, access: grant.access, items: metas }),
      ),
    )

    const response: ItemList = { vaults }

    return response
  })

// An Item's metadata with its Fields in Kind order. A Kind outside the Kinds, a missing primary Field or a label
// outside the Kind can only come from a modified file: no value is opened here, so the AAD cannot catch it, and it
// is reported as damage.
const itemMeta = (vault: Name, item: typeof ListedItemRow.Type, labels: ReadonlyArray<Name>) =>
  Effect.gen(function* () {
    const damagedItem = new IntegrityCheckFailed({ damaged: { what: "item", vault, item: item.title } })
    const kind = yield* Effect.fromResult(Result.mapError(Kind.parse(item.kind), () => damagedItem))

    if (!labels.some((label) => Name.key(label) === Name.key(Kind.primary(kind).label))) return yield* damagedItem
    const outsideKind = labels.find((label) => Kind.spec(kind, Name.key(label)) === undefined)

    if (outsideKind !== undefined)
      return yield* new IntegrityCheckFailed({
        damaged: { what: "field", reference: Reference.format({ vault, item: item.title, field: outsideKind }) },
      })

    const meta: ItemMeta = {
      title: item.title,
      kind,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      fields: Kind.fields(kind).flatMap((spec) =>
        labels.some((label) => Name.key(label) === Name.key(spec.label))
          ? [{ label: spec.label, concealed: spec.role === "primary" }]
          : [],
      ),
    }

    return meta
  })

export const create = (token: AuthenticatedToken, request: CreateRequest, peer: string | null) =>
  Tokens.audited({
    token,
    action: "items.create",
    peer,
    scope: {
      vaults: [vaultName(token, request.vault)],
      references: [],
      detail: { title: request.title, fields: request.fields.map(({ label }) => label) },
    },
    operation: createChecked(token, request),
  })

const createChecked = (token: AuthenticatedToken, request: CreateRequest) =>
  Effect.gen(function* () {
    const vault = yield* Effect.fromResult(parseName("vault", request.vault))
    const title = yield* Effect.fromResult(parseName("title", request.title))
    const grant = yield* Effect.fromResult(grantFor(token, vault))

    if (!Access.allowsCreate(grant.access))
      return yield* new CreateNotAllowed({ vault: grant.vault, label: token.label })
    const allowed = Kind.fields(request.kind).map(({ label }) => label)

    const fields = yield* Effect.forEach(request.fields, ({ label, value }) =>
      Effect.gen(function* () {
        const name = Name.parse(label)
        const spec = Result.isSuccess(name) ? Kind.spec(request.kind, Name.key(name.success)) : undefined

        if (spec === undefined) return yield* new UnknownField({ kind: request.kind, field: label, allowed })
        const problem = Value.problem(Redacted.value(value))

        if (problem !== undefined) return yield* new InvalidValue({ field: spec.label, reason: problem })

        return { spec, value }
      }),
    )

    const primary = Kind.primary(request.kind)

    if (!fields.some(({ spec }) => spec.role === "primary"))
      return yield* new FieldRequired({ kind: request.kind, field: primary.label })
    // Kind order, so ids, the receipt and the audit detail follow display order.
    const ordered = Kind.fields(request.kind).flatMap((spec) => fields.filter((field) => field.spec === spec))

    return yield* insert(token, grant, title, request.kind, ordered)
  })

// A `retired_titles` row as create and release read it.
export const RetiredRow = Schema.Struct({ title_key: Schema.String })

// Inside `Tokens.audited`'s transaction: re-check the Token, so no Item commits after a Revoke; refuse a Retired
// title; take ids from `Database.nextIds`; insert the Item (the unique index decides `ItemExists`), then seal and
// insert each Field with its own ids in the AAD.
const insert = (
  token: AuthenticatedToken,
  grant: Grant,
  title: Name,
  kind: Kind,
  fields: ReadonlyArray<{ readonly spec: FieldSpec; readonly value: Redacted.Redacted<string> }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const wraps = yield* Tokens.activeWraps(token, [grant.vaultId])
    const wrap = wraps.get(grant.vaultId) ?? (yield* Effect.die(new Error("create: the granted Vault has no wrap")))

    const retired = yield* rows(
      RetiredRow,
      sql`SELECT title_key FROM retired_titles WHERE vault_id = ${grant.vaultId} AND title_key = ${Name.key(title)}`,
    )

    if (retired.length > 0) return yield* new TitleRetired({ vault: grant.vault, item: title })
    const at = yield* Audit.now
    const itemId = yield* Database.nextId("items")
    const fieldIds = yield* Database.nextIds("fields", fields.length)
    yield* sql`
      INSERT INTO items (id, vault_id, title, title_key, kind, created_at, updated_at)
      VALUES (${itemId}, ${grant.vaultId}, ${title}, ${Name.key(title)}, ${kind}, ${at}, ${at})`.pipe(
      Effect.catchReason("SqlError", "UniqueViolation", () =>
        Effect.fail(new ItemExists({ vault: grant.vault, item: title })),
      ),
      Effect.catchTag("SqlError", Effect.die),
    )
    const key = yield* vaultKey(token, grant, wrap)

    for (const [index, { spec, value }] of fields.entries()) {
      const fieldId = fieldIds[index] ?? (yield* Effect.die(new Error("create: nextIds returned too few ids")))
      const labelKey = Name.key(spec.label)

      const sealed = yield* Keys.sealField(
        key,
        { vaultId: grant.vaultId, itemId, fieldId, kind, labelKey },
        Redacted.value(value),
      )

      yield* sql`
        INSERT INTO fields (id, item_id, label, label_key, nonce, sealed, updated_at)
        VALUES (${fieldId}, ${itemId}, ${spec.label}, ${labelKey}, ${sealed.nonce}, ${sealed.wrapped}, ${at})`.pipe(
        Effect.orDie,
      )
    }

    const receipt: CreateReceipt = {
      vault: grant.vault,
      title,
      kind,
      fields: fields.map(({ spec }) => ({ label: spec.label, concealed: spec.role === "primary" })),
      createdAt: at,
    }

    return receipt
  })

export * as Items from "./Items.js"
