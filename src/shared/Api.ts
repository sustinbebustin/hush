import { Context, type Redacted, Result, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"

import { Access } from "./Access.js"
import {
  AlreadyInitialised,
  AuditUnavailable,
  CreateNotAllowed,
  FieldNotFound,
  FieldRequired,
  GrantWire,
  guardErrors,
  InitCodeInvalid,
  IntegrityCheckFailed,
  InvalidName,
  InvalidReference,
  InvalidValue,
  ItemExists,
  ItemNotFound,
  LimitExceeded,
  NotInitialised,
  passphraseErrors,
  PassphraseInvalid,
  ReferenceNotFound,
  TitleNotRetired,
  TitleRetired,
  TokenLabelExists,
  TokenNotFound,
  TokenRejected,
  UnknownField,
  VaultExists,
  VaultNotEmpty,
  VaultNotFound,
  VaultNotGranted,
} from "./ApiError.js"
import { Kind } from "./Kind.js"
import { Name } from "./Name.js"
import { maxBytes as passphraseMaxBytes } from "./Passphrase.js"
import type { Token } from "./Token.js"
import { Utf8 } from "./Utf8.js"

// The single HTTP contract, shared by the Server's handlers and the CLI's typed client.
// Paths carry `/v1` themselves: `HttpApi.prefix` only covers groups added before it is called.
// Names travel as plain strings: the handlers parse them, so a bad one is `InvalidName`, not an empty 400.

export const ServerStateWire = Schema.Literals(["uninitialised", "ready"])

export type ServerStateWire = typeof ServerStateWire.Type

export const Status = Schema.Struct({
  state: ServerStateWire,
  version: Schema.String,
  api: Schema.Literal(1),
})

export type Status = typeof Status.Type

// Needs no credential, and the Uninitialised gate never refuses it. Every endpoint declares the guard's
// refusals, so the typed client decodes them.
export class Public extends HttpApiGroup.make("public").add(
  HttpApiEndpoint.get("status", "/v1/status", { success: Status, error: [...guardErrors] }),
) {}

// Secret fields are Redacted, encodable both ways from this one Api. The Passphrase policy is
// checked by the handler, at Init and change only.
const Passphrase = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.makeFilter((text: string) => Utf8.byteLength(text) >= 1 && Utf8.byteLength(text) <= passphraseMaxBytes),
  ),
)

// The format is checked by the handler, which answers `InitCodeInvalid` for anything wrong.
const InitCode = Schema.RedactedFromValue(Schema.String.check(Schema.isBetweenLength(1, 64)))

// A Field value. `Value.problem` (1-65536 UTF-8 bytes, no U+0000, well-formed) is checked by the handler as
// `InvalidValue`.
const Value = Schema.RedactedFromValue(Schema.String)

const TokenWire = Schema.RedactedFromValue(Schema.String)

const KindWire = Schema.Literals(Kind.all)

// With `first`, Init also creates that Vault and issues a Read+Create Token for it labelled `label`.
export const InitRequest = Schema.Struct({
  initCode: InitCode,
  passphrase: Passphrase,
  first: Schema.optionalKey(Schema.Struct({ vault: Schema.String, label: Schema.String })),
})

export type InitRequest = typeof InitRequest.Type

export const InitReceipt = Schema.Struct({
  state: Schema.Literal("ready"),
  // The plaintext Token appears here only.
  first: Schema.optionalKey(
    Schema.Struct({
      vault: Schema.String,
      label: Schema.String,
      grants: Schema.Array(GrantWire),
      expiresAt: Schema.Null,
      token: TokenWire,
    }),
  ),
})

export type InitReceipt = typeof InitReceipt.Type

export const PassphraseChangeRequest = Schema.Struct({ passphrase: Passphrase, newPassphrase: Passphrase })

export type PassphraseChangeRequest = typeof PassphraseChangeRequest.Type

export const PassphraseChangeReceipt = Schema.Struct({ changed: Schema.Literal(true) })

export type PassphraseChangeReceipt = typeof PassphraseChangeReceipt.Type

// Just the Passphrase, for the endpoints that take nothing else.
export const PassphraseOnly = Schema.Struct({ passphrase: Passphrase })

export type PassphraseOnly = typeof PassphraseOnly.Type

export const VaultRequest = Schema.Struct({ passphrase: Passphrase, vault: Schema.String })

export type VaultRequest = typeof VaultRequest.Type

export const VaultReceipt = Schema.Struct({ vault: Schema.String, createdAt: Schema.String })

export type VaultReceipt = typeof VaultReceipt.Type

// Sorted by name; `activeTokens` counts Tokens neither revoked nor expired with a Grant on the Vault.
export const VaultList = Schema.Struct({
  vaults: Schema.Array(
    Schema.Struct({
      vault: Schema.String,
      items: Schema.Number,
      activeTokens: Schema.Number,
      createdAt: Schema.String,
    }),
  ),
})

export type VaultList = typeof VaultList.Type

export const VaultDeleted = Schema.Struct({ deleted: Schema.Literal(true), vault: Schema.String })

export type VaultDeleted = typeof VaultDeleted.Type

// The longest `--ttl`: 3650 days.
export const maxTtlSeconds = 315_360_000

// Each Vault at most once, by name identity; the CLI refuses a Vault named twice before sending, so a request that
// does is malformed (an empty 400). A name that is not a Name is left to the handler (`InvalidName`).
const distinctVaults = Schema.makeFilter((grants: ReadonlyArray<{ readonly vault: string }>) => {
  const keys = grants.map(({ vault }) =>
    Result.match(Name.parse(vault), { onSuccess: Name.key, onFailure: () => vault }),
  )

  return new Set(keys).size === keys.length
})

// `keepGrants` only with `replaces`, and at least one Grant once it is applied: the CLI never sends anything
// else. More than 64 Grants is the handler's `LimitExceeded`, not an empty 400.
export const TokenIssueRequest = Schema.Struct({
  passphrase: Passphrase,
  label: Schema.String,
  grants: Schema.Array(GrantWire).check(distinctVaults),
  ttlSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxTtlSeconds }))),
  replaces: Schema.optionalKey(Schema.Literal(true)),
  keepGrants: Schema.optionalKey(Schema.Literal(true)),
}).check(
  Schema.makeFilter(
    ({ grants, replaces, keepGrants }) =>
      (keepGrants !== true || replaces === true) && (grants.length > 0 || keepGrants === true),
  ),
)

export type TokenIssueRequest = typeof TokenIssueRequest.Type

// The plaintext Token appears here only. `replaced` says whether a Token with the
// Label was revoked in the same transaction.
export const TokenIssueReceipt = Schema.Struct({
  token: TokenWire,
  label: Schema.String,
  grants: Schema.Array(GrantWire),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  replaced: Schema.Boolean,
})

export type TokenIssueReceipt = typeof TokenIssueReceipt.Type

export const TokenState = Schema.Literals(["active", "expired", "revoked"])

export type TokenState = typeof TokenState.Type

// What a Token learns about itself through `token/describe`; never its value.
export const TokenDescription = Schema.Struct({
  label: Schema.String,
  grants: Schema.Array(GrantWire),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
})

export type TokenDescription = typeof TokenDescription.Type

// A Token as listed by the Owner. A revoked Token keeps listing the Grants it had, until its Vault goes.
export const TokenInfo = Schema.Struct({
  ...TokenDescription.fields,
  revokedAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
  state: TokenState,
})

export type TokenInfo = typeof TokenInfo.Type

// Newest first.
export const TokenList = Schema.Struct({ tokens: Schema.Array(TokenInfo) })

export type TokenList = typeof TokenList.Type

export const TokenRevokeRequest = Schema.Struct({ passphrase: Passphrase, label: Schema.String })

export type TokenRevokeRequest = typeof TokenRevokeRequest.Type

// `label` is the stored display Label.
export const TokenRevoked = Schema.Struct({
  label: Schema.String,
  revoked: Schema.Literal(true),
  revokedAt: Schema.String,
})

export type TokenRevoked = typeof TokenRevoked.Type

// What an audited request did.
export const AuditAction = Schema.Literals([
  "init",
  "passphrase.change",
  "vault.create",
  "vault.list",
  "vault.delete",
  "item.list",
  "item.edit",
  "item.rename",
  "item.delete",
  "item.release",
  "item.reveal",
  "item.create",
  "token.issue",
  "token.list",
  "token.revoke",
  "audit.read",
  "backup",
  "token.describe",
  "items.list",
  "secrets.resolve",
  "items.create",
])

export type AuditAction = typeof AuditAction.Type

// Names only, never values, Tokens, the Passphrase or the Init code.
export const AuditDetail = Schema.Struct({
  fields: Schema.optionalKey(Schema.Array(Schema.String)),
  label: Schema.optionalKey(Schema.String),
  grants: Schema.optionalKey(Schema.Array(GrantWire)),
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // An Item rename's old and new titles.
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  // The Field label an Item edit set or removed.
  set: Schema.optionalKey(Schema.String),
  removed: Schema.optionalKey(Schema.String),
  // The Label of the Token a `token.issue` revoked in its own transaction.
  replaced: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
})

export type AuditDetail = typeof AuditDetail.Type

// Who made an audited request; a Token by its Label, never its value.
export const AuditActor = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["init", "passphrase", "host"]) }),
  Schema.Struct({ type: Schema.Literal("token"), label: Schema.String }),
])

export type AuditActor = typeof AuditActor.Type

const auditEntryFields = {
  id: Schema.Number,
  at: Schema.String,
  // Equal to `at` unless denials were coalesced into the entry, then `count > 1`.
  lastAt: Schema.String,
  count: Schema.Number,
  actor: AuditActor,
  action: AuditAction,
  vaults: Schema.Array(Schema.String),
  references: Schema.Array(Schema.String),
  detail: Schema.optionalKey(AuditDetail),
  // Information only, not authenticated: behind a proxy or bridge it is the proxy's address.
  peer: Schema.optionalKey(Schema.String),
}

// One Audit Log row. `denied` is an authorisation refusal, `error` any other failure after authentication;
// either names the error's tag.
export const AuditEntry = Schema.Union([
  Schema.Struct({ ...auditEntryFields, outcome: Schema.Literal("ok") }),
  Schema.Struct({ ...auditEntryFields, outcome: Schema.Literals(["denied", "error"]), error: Schema.String }),
])

export type AuditEntry = typeof AuditEntry.Type

// The most entries one page holds, and how many when the request does not say.
export const auditLimit = { max: 1000, default: 100 } as const

// An instant as the Audit Log holds it: ISO 8601 UTC with milliseconds, so instants compare as
// strings. The CLI converts `--since` to this form.
const Instant = Schema.String.check(
  Schema.makeFilter((text: string) => {
    const ms = Date.parse(text)

    return !Number.isNaN(ms) && new Date(ms).toISOString() === text
  }),
)

// Every filter optional; `before` is an entry id, as a page's `next` gives it. The CLI checks each before sending,
// so an out-of-range one is malformed (an empty 400); a name that is not a Name is the handler's `InvalidName`.
export const AuditRequest = Schema.Struct({
  passphrase: Passphrase,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: auditLimit.max }))),
  before: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  since: Schema.optionalKey(Instant),
  vault: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
})

export type AuditRequest = typeof AuditRequest.Type

// Newest first. `next` is set when older matching entries remain: pass it as `before` for the next page.
export const AuditPage = Schema.Struct({ entries: Schema.Array(AuditEntry), next: Schema.optionalKey(Schema.Number) })

export type AuditPage = typeof AuditPage.Type

export const FieldMeta = Schema.Struct({ label: Schema.String, concealed: Schema.Boolean })

// Each label at most once, by name identity; the CLI never sends a label twice, so a request that does is
// malformed (an empty 400), not a domain error. A label that is not a Name is left to the handler (`UnknownField`).
const distinctLabels = Schema.makeFilter((fields: ReadonlyArray<{ readonly label: string }>) => {
  const keys = fields.map(({ label }) =>
    Result.match(Name.parse(label), { onSuccess: Name.key, onFailure: () => label }),
  )

  return new Set(keys).size === keys.length
})

// A Token's `items/create`; under the Passphrase, the body of `admin/items/create`.
export const CreateRequest = Schema.Struct({
  vault: Schema.String,
  title: Schema.String,
  kind: KindWire,
  fields: Schema.Array(Schema.Struct({ label: Schema.String, value: Value })).check(distinctLabels),
})

export type CreateRequest = typeof CreateRequest.Type

// Stored display names, Fields in Kind order.
export const CreateReceipt = Schema.Struct({
  vault: Schema.String,
  title: Schema.String,
  kind: KindWire,
  fields: Schema.Array(FieldMeta),
  createdAt: Schema.String,
})

export type CreateReceipt = typeof CreateReceipt.Type

export const ItemCreateRequest = Schema.Struct({ passphrase: Passphrase, ...CreateRequest.fields })

export type ItemCreateRequest = typeof ItemCreateRequest.Type

// `verified`: every new seal was opened and compared before commit.
export const ItemCreateReceipt = Schema.Struct({ ...CreateReceipt.fields, verified: Schema.Literal(true) })

export type ItemCreateReceipt = typeof ItemCreateReceipt.Type

// An Item's metadata: stored display names, Fields in Kind order, never a value.
export const ItemMeta = Schema.Struct({
  title: Schema.String,
  kind: KindWire,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  fields: Schema.Array(FieldMeta),
})

export type ItemMeta = typeof ItemMeta.Type

// One Vault as the Owner sees it: its Items by title, and its Retired titles. A Retired title keeps only its key
// (NFC, lowercased), so `retired` lists keys, sorted.
export const VaultItems = Schema.Struct({
  vault: Schema.String,
  items: Schema.Array(ItemMeta),
  retired: Schema.Array(Schema.String),
})

export type VaultItems = typeof VaultItems.Type

// One change per edit: `set` replaces a Field's value or adds an absent plain Field; `remove` drops a
// present plain Field.
export const ItemChange = Schema.Union([
  Schema.Struct({ set: Schema.Struct({ label: Schema.String, value: Value }) }),
  Schema.Struct({ remove: Schema.String }),
])

export type ItemChange = typeof ItemChange.Type

export const ItemEditRequest = Schema.Struct({
  passphrase: Passphrase,
  vault: Schema.String,
  item: Schema.String,
  change: ItemChange,
})

export type ItemEditRequest = typeof ItemEditRequest.Type

// Stored display names, Fields in Kind order. `verified`: the new seal was opened and compared before commit.
export const ItemEditReceipt = Schema.Struct({
  vault: Schema.String,
  title: Schema.String,
  kind: KindWire,
  fields: Schema.Array(FieldMeta),
  updatedAt: Schema.String,
  verified: Schema.Literal(true),
})

export type ItemEditReceipt = typeof ItemEditReceipt.Type

export const ItemRenameRequest = Schema.Struct({
  passphrase: Passphrase,
  vault: Schema.String,
  item: Schema.String,
  newTitle: Schema.String,
})

export type ItemRenameRequest = typeof ItemRenameRequest.Type

// `references` holds the old and new Reference of every Field, in Kind order.
export const ItemRenamed = Schema.Struct({
  vault: Schema.String,
  from: Schema.String,
  to: Schema.String,
  references: Schema.Array(Schema.Struct({ old: Schema.String, new: Schema.String })),
})

export type ItemRenamed = typeof ItemRenamed.Type

export const ItemRequest = Schema.Struct({ passphrase: Passphrase, vault: Schema.String, item: Schema.String })

export type ItemRequest = typeof ItemRequest.Type

export const ItemDeleted = Schema.Struct({ deleted: Schema.Literal(true), vault: Schema.String, title: Schema.String })

export type ItemDeleted = typeof ItemDeleted.Type

export const ItemReleaseRequest = Schema.Struct({ passphrase: Passphrase, vault: Schema.String, title: Schema.String })

export type ItemReleaseRequest = typeof ItemReleaseRequest.Type

// `title` is the title as requested: a Retired title keeps only its key.
export const ItemReleased = Schema.Struct({
  released: Schema.Literal(true),
  vault: Schema.String,
  title: Schema.String,
})

export type ItemReleased = typeof ItemReleased.Type

// `reference` is parsed by the handler, so a bad one is `InvalidReference`, not an empty 400.
export const ItemRevealRequest = Schema.Struct({ passphrase: Passphrase, reference: Schema.String })

export type ItemRevealRequest = typeof ItemRevealRequest.Type

// The one Field's value, the only Passphrase receipt that carries one.
export const ItemRevealed = Schema.Struct({ value: Value })

export type ItemRevealed = typeof ItemRevealed.Type

// Every error a Passphrase endpoint shares: the guard and gate, a wrong Passphrase, the backoff, the Audit Log.
const passphraseEndpointErrors = [
  ...guardErrors,
  NotInitialised,
  ...passphraseErrors,
  InvalidValue,
  AuditUnavailable,
] as const

// Gated by the Init code or the Passphrase.
export class Admin extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.post("init", "/v1/admin/init", {
      payload: InitRequest,
      success: InitReceipt,
      error: [
        ...guardErrors,
        AlreadyInitialised,
        InitCodeInvalid,
        PassphraseInvalid,
        InvalidName,
        InvalidValue,
        AuditUnavailable,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("passphraseChange", "/v1/admin/passphrase/change", {
      payload: PassphraseChangeRequest,
      success: PassphraseChangeReceipt,
      error: [...passphraseEndpointErrors, PassphraseInvalid],
    }),
    HttpApiEndpoint.post("vaultsCreate", "/v1/admin/vaults/create", {
      payload: VaultRequest,
      success: VaultReceipt,
      error: [...passphraseEndpointErrors, InvalidName, VaultExists],
    }),
    HttpApiEndpoint.post("vaultsList", "/v1/admin/vaults/list", {
      payload: PassphraseOnly,
      success: VaultList,
      error: passphraseEndpointErrors,
    }),
    HttpApiEndpoint.post("vaultsDelete", "/v1/admin/vaults/delete", {
      payload: VaultRequest,
      success: VaultDeleted,
      error: [...passphraseEndpointErrors, InvalidName, VaultNotFound, VaultNotEmpty],
    }),
    HttpApiEndpoint.post("tokensIssue", "/v1/admin/tokens/issue", {
      payload: TokenIssueRequest,
      success: TokenIssueReceipt,
      error: [
        ...passphraseEndpointErrors,
        InvalidName,
        VaultNotFound,
        TokenLabelExists,
        TokenNotFound,
        LimitExceeded,
        IntegrityCheckFailed,
      ],
    }),
    HttpApiEndpoint.post("tokensList", "/v1/admin/tokens/list", {
      payload: PassphraseOnly,
      success: TokenList,
      error: passphraseEndpointErrors,
    }),
    HttpApiEndpoint.post("tokensRevoke", "/v1/admin/tokens/revoke", {
      payload: TokenRevokeRequest,
      success: TokenRevoked,
      error: [...passphraseEndpointErrors, InvalidName, TokenNotFound],
    }),
    // The Owner's view of one Vault without a Token (ADR-0010): metadata and Retired titles, never a value.
    HttpApiEndpoint.post("itemsList", "/v1/admin/items/list", {
      payload: VaultRequest,
      success: VaultItems,
      error: [...passphraseEndpointErrors, InvalidName, VaultNotFound, IntegrityCheckFailed],
    }),
    HttpApiEndpoint.post("itemsEdit", "/v1/admin/items/edit", {
      payload: ItemEditRequest,
      success: ItemEditReceipt,
      error: [
        ...passphraseEndpointErrors,
        InvalidName,
        VaultNotFound,
        ItemNotFound,
        UnknownField,
        FieldNotFound,
        FieldRequired,
        IntegrityCheckFailed,
      ],
    }),
    HttpApiEndpoint.post("itemsRename", "/v1/admin/items/rename", {
      payload: ItemRenameRequest,
      success: ItemRenamed,
      // `IntegrityCheckFailed`: an Item whose Kind was damaged cannot list its References in Kind order.
      error: [...passphraseEndpointErrors, InvalidName, VaultNotFound, ItemNotFound, ItemExists, IntegrityCheckFailed],
    }),
    HttpApiEndpoint.post("itemsDelete", "/v1/admin/items/delete", {
      payload: ItemRequest,
      success: ItemDeleted,
      error: [...passphraseEndpointErrors, InvalidName, VaultNotFound, ItemNotFound],
    }),
    HttpApiEndpoint.post("itemsRelease", "/v1/admin/items/release", {
      payload: ItemReleaseRequest,
      success: ItemReleased,
      error: [...passphraseEndpointErrors, InvalidName, VaultNotFound, TitleNotRetired],
    }),
    // Reveal: one Field opened under the Passphrase, never with a Token.
    HttpApiEndpoint.post("itemsReveal", "/v1/admin/items/reveal", {
      payload: ItemRevealRequest,
      success: ItemRevealed,
      error: [
        ...passphraseEndpointErrors,
        InvalidReference,
        VaultNotFound,
        ItemNotFound,
        FieldNotFound,
        IntegrityCheckFailed,
      ],
    }),
    // A Retired title is refused as for a Token: only `items/release` frees it.
    HttpApiEndpoint.post("itemsCreate", "/v1/admin/items/create", {
      payload: ItemCreateRequest,
      success: ItemCreateReceipt,
      error: [
        ...passphraseEndpointErrors,
        InvalidName,
        VaultNotFound,
        ItemExists,
        TitleRetired,
        UnknownField,
        FieldRequired,
        IntegrityCheckFailed,
      ],
    }),
    // The Passphrase only: no Token of any Access reads the log.
    HttpApiEndpoint.post("audit", "/v1/admin/audit", {
      payload: AuditRequest,
      success: AuditPage,
      error: [...passphraseEndpointErrors, InvalidName],
    }),
  ) {}

// The Token a request authenticated with, provided by `TokenAuth` for that request only.
export interface AuthenticatedToken {
  readonly id: number
  readonly label: string
  readonly grants: ReadonlyArray<{ readonly vaultId: number; readonly vault: Name; readonly access: Access }>
  readonly token: Redacted.Redacted<Token>
  readonly wrapSalt: Uint8Array<ArrayBuffer>
}

export class CurrentToken extends Context.Service<CurrentToken, AuthenticatedToken>()("hush/CurrentToken") {}

// Bearer security on the `token` group. Effect calls it with an empty credential when the header is
// missing, so the implementation rejects that itself.
export class TokenAuth extends HttpApiMiddleware.Service<TokenAuth, { provides: CurrentToken }>()("hush/TokenAuth", {
  error: [TokenRejected, AuditUnavailable],
  security: { bearer: HttpApiSecurity.bearer },
}) {}

// More than `maxReferences` is the handler's `LimitExceeded`, not an empty 400.
export const maxReferences = 256

export const ResolveRequest = Schema.Struct({
  references: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
})

export type ResolveRequest = typeof ResolveRequest.Type

export const ResolvedValue = Schema.Struct({ reference: Schema.String, value: Value, concealed: Schema.Boolean })

// In request order, one per Reference sent.
export const ResolveResponse = Schema.Struct({ values: Schema.Array(ResolvedValue) })

export type ResolveResponse = typeof ResolveResponse.Type

// Absent `vaults`: every granted Vault. Each named Vault must be granted.
export const ListRequest = Schema.Struct({ vaults: Schema.optionalKey(Schema.Array(Schema.String)) })

export type ListRequest = typeof ListRequest.Type

// Every Vault listed, empty ones included, with the Token's Access to it.
export const ItemList = Schema.Struct({
  vaults: Schema.Array(
    Schema.Struct({ vault: Schema.String, access: Schema.Literals(Access.all), items: Schema.Array(ItemMeta) }),
  ),
})

export type ItemList = typeof ItemList.Type

// Every endpoint here is refused by the Uninitialised gate before `TokenAuth` runs.
export class TokenGroup extends HttpApiGroup.make("token")
  .add(
    HttpApiEndpoint.post("resolve", "/v1/secrets/resolve", {
      payload: ResolveRequest,
      success: ResolveResponse,
      error: [
        ...guardErrors,
        NotInitialised,
        VaultNotGranted,
        InvalidReference,
        LimitExceeded,
        ReferenceNotFound,
        IntegrityCheckFailed,
        TokenRejected,
        AuditUnavailable,
      ],
    }),
    HttpApiEndpoint.post("create", "/v1/items/create", {
      payload: CreateRequest,
      success: CreateReceipt,
      error: [
        ...guardErrors,
        NotInitialised,
        VaultNotGranted,
        CreateNotAllowed,
        InvalidName,
        ItemExists,
        TitleRetired,
        UnknownField,
        FieldRequired,
        InvalidValue,
        IntegrityCheckFailed,
        TokenRejected,
        AuditUnavailable,
      ],
    }),
    HttpApiEndpoint.post("list", "/v1/items/list", {
      payload: ListRequest,
      success: ItemList,
      error: [
        ...guardErrors,
        NotInitialised,
        VaultNotGranted,
        InvalidName,
        IntegrityCheckFailed,
        TokenRejected,
        AuditUnavailable,
      ],
    }),
    HttpApiEndpoint.post("describe", "/v1/token/describe", {
      payload: Schema.Struct({}),
      success: TokenDescription,
      error: [...guardErrors, NotInitialised, TokenRejected, AuditUnavailable],
    }),
  )
  .middleware(TokenAuth) {}

export class Api extends HttpApi.make("hush").add(Public).add(Admin).add(TokenGroup) {}

// `POST /v1/admin/backup`: a raw route beside the `HttpApi`, behind the same guard, since its success is a stream of database bytes, not JSON. It takes `PassphraseOnly`; success is
// `application/octet-stream` with the size and lowercase hex SHA-256 in `headers`; errors are JSON bodies of
// `BackupError` with the status of their class.
export const BackupRoute = {
  path: "/v1/admin/backup",
  headers: { bytes: "x-hush-backup-bytes", sha256: "x-hush-backup-sha256" },
  error: Schema.Union(passphraseEndpointErrors),
} as const

export type BackupError = typeof BackupRoute.error.Type
