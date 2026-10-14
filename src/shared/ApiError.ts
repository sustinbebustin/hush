import { Result, Schema, SchemaAST } from "effect"

import { Access } from "./Access.js"
import { Name } from "./Name.js"
import { Reference } from "./Reference.js"
import { Value } from "./Value.js"

// Every error the Server returns, each a `Schema.TaggedError` with `httpApiStatus`, and their union.
// No field ever holds a value, Token, Passphrase or Init code.

// The request guard's refusals, before routing: none is audited or counted.

// `Host` missing (null), or not an IP literal, `localhost` or an allowed host.
export class HostNotAllowed extends Schema.TaggedError<HostNotAllowed>()(
  "HostNotAllowed",
  { host: Schema.NullOr(Schema.String) },
  { httpApiStatus: 403 },
) {}

// A `Tailscale-Funnel-Request` header: the request came from the public internet.
export class FunnelRequestRefused extends Schema.TaggedError<FunnelRequestRefused>()(
  "FunnelRequestRefused",
  {},
  { httpApiStatus: 403 },
) {}

// An `Origin` header, which browsers send and the CLI never does.
export class BrowserRequestRefused extends Schema.TaggedError<BrowserRequestRefused>()(
  "BrowserRequestRefused",
  {},
  { httpApiStatus: 403 },
) {}

// A POST whose `Content-Type` is not exactly `application/json`; `received` is null when there was none.
export class UnsupportedContentType extends Schema.TaggedError<UnsupportedContentType>()(
  "UnsupportedContentType",
  { received: Schema.NullOr(Schema.String) },
  { httpApiStatus: 415 },
) {}

// Every guard refusal, declared on every endpoint so that the typed client decodes it.
export const guardErrors = [
  HostNotAllowed,
  FunnelRequestRefused,
  BrowserRequestRefused,
  UnsupportedContentType,
] as const

export type GuardError = HostNotAllowed | FunnelRequestRefused | BrowserRequestRefused | UnsupportedContentType

// The Uninitialised gate refused a path other than `status` and `admin/init`.
export class NotInitialised extends Schema.TaggedError<NotInitialised>()(
  "NotInitialised",
  {},
  { httpApiStatus: 409 },
) {}

export class AlreadyInitialised extends Schema.TaggedError<AlreadyInitialised>()(
  "AlreadyInitialised",
  {},
  { httpApiStatus: 409 },
) {}

// Missing, malformed or wrong; never says which.
export class InitCodeInvalid extends Schema.TaggedError<InitCodeInvalid>()(
  "InitCodeInvalid",
  {},
  { httpApiStatus: 403 },
) {}

// A new Passphrase that fails `Passphrase.policy`, at Init or change.
export class PassphraseInvalid extends Schema.TaggedError<PassphraseInvalid>()(
  "PassphraseInvalid",
  { reason: Schema.Literals(["too-short", "too-long"]) },
  { httpApiStatus: 400 },
) {}

// A wrong Passphrase: the master key's tag failed. `retryAfterSeconds` is the delay the next attempt waits, 0
// while free failures remain. Audited `denied`.
export class PassphraseIncorrect extends Schema.TaggedError<PassphraseIncorrect>()(
  "PassphraseIncorrect",
  { retryAfterSeconds: Schema.Number },
  { httpApiStatus: 401 },
) {}

// A Passphrase attempt before the backoff's delay ran out; nothing was checked, counted or audited.
export class BackoffActive extends Schema.TaggedError<BackoffActive>()(
  "BackoffActive",
  { retryAfterSeconds: Schema.Number },
  { httpApiStatus: 429 },
) {}

// The errors every Passphrase endpoint can return.
export const passphraseErrors = [PassphraseIncorrect, BackoffActive] as const

// The audit row could not be written, so the request was refused and returned nothing.
export class AuditUnavailable extends Schema.TaggedError<AuditUnavailable>()(
  "AuditUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

// Why a Token was refused. `missing`, `malformed` and `unknown` say nothing about any Token row and are not
// audited; `revoked` and `expired` name the Token's Label and when, and are audited `denied`.
export const Rejection = Schema.Union([
  Schema.Struct({ reason: Schema.Literals(["missing", "malformed", "unknown"]) }),
  Schema.Struct({ reason: Schema.Literals(["revoked", "expired"]), label: Schema.String, at: Schema.String }),
])

export type Rejection = typeof Rejection.Type

// A Token request refused by `TokenAuth` or by a handler's revocation re-check.
export class TokenRejected extends Schema.TaggedError<TokenRejected>()(
  "TokenRejected",
  { rejection: Rejection },
  { httpApiStatus: 401 },
) {}

export const GrantWire = Schema.Struct({ vault: Schema.String, access: Schema.Literals(Access.all) })

// A Vault outside the Token's Grants. `suggestion` is the closest granted name, never another.
export class VaultNotGranted extends Schema.TaggedError<VaultNotGranted>()(
  "VaultNotGranted",
  {
    vault: Schema.String,
    label: Schema.String,
    granted: Schema.Array(GrantWire),
    suggestion: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 403 },
) {}

// A create in a Vault where the Token's Grant is Read. Audited `denied`.
export class CreateNotAllowed extends Schema.TaggedError<CreateNotAllowed>()(
  "CreateNotAllowed",
  { vault: Schema.String, label: Schema.String },
  { httpApiStatus: 403 },
) {}

// A Token issue without `replaces` whose Label is held by an active or expired Token, decided by the
// unique index on the Label key of non-revoked Tokens.
export class TokenLabelExists extends Schema.TaggedError<TokenLabelExists>()(
  "TokenLabelExists",
  { label: Schema.String },
  { httpApiStatus: 409 },
) {}

// No unrevoked Token holds the Label: a Revoke of an unknown or revoked Label, or `keepGrants` with no Token to
// replace.
export class TokenNotFound extends Schema.TaggedError<TokenNotFound>()(
  "TokenNotFound",
  { label: Schema.String },
  { httpApiStatus: 404 },
) {}

// A request-size limit: `what` names the counted thing and `max` its limit.
export class LimitExceeded extends Schema.TaggedError<LimitExceeded>()(
  "LimitExceeded",
  { what: Schema.Literals(["grants", "references"]), max: Schema.Number },
  { httpApiStatus: 400 },
) {}

// An admin call names a Vault that does not exist.
export class VaultNotFound extends Schema.TaggedError<VaultNotFound>()(
  "VaultNotFound",
  { vault: Schema.String },
  { httpApiStatus: 404 },
) {}

// Decided by the unique index on `vaults.name_key`, so a case variant of a name collides too.
export class VaultExists extends Schema.TaggedError<VaultExists>()(
  "VaultExists",
  { vault: Schema.String },
  { httpApiStatus: 409 },
) {}

// A Vault delete refused while the Vault has Items or an unrevoked Token holds a Grant on it.
export class VaultNotEmpty extends Schema.TaggedError<VaultNotEmpty>()(
  "VaultNotEmpty",
  { vault: Schema.String, items: Schema.Number, activeTokens: Schema.Number },
  { httpApiStatus: 409 },
) {}

// `what` names the argument, e.g. `vault` or `label`. Every endpoint that takes names declares it.
export class InvalidName extends Schema.TaggedError<InvalidName>()(
  "InvalidName",
  { what: Schema.String, reason: Schema.Literals(Name.invalidReasons) },
  { httpApiStatus: 400 },
) {}

// `Name.parse` for the argument `what`, failing as `InvalidName`; the CLI uses it to refuse a name before sending.
export const parseName = (what: string, input: string): Result.Result<Name, InvalidName> =>
  Result.mapError(Name.parse(input), ({ reason }) => new InvalidName({ what, reason }))

// Decided by the unique index on `(vault_id, title_key)`, so a case variant of a title collides too.
export class ItemExists extends Schema.TaggedError<ItemExists>()(
  "ItemExists",
  { vault: Schema.String, item: Schema.String },
  { httpApiStatus: 409 },
) {}

// An Item edit, rename or delete names a title that no Item of the Vault has. `vault` is the stored name.
export class ItemNotFound extends Schema.TaggedError<ItemNotFound>()(
  "ItemNotFound",
  { vault: Schema.String, item: Schema.String },
  { httpApiStatus: 404 },
) {}

// An edit removes a Field the Item does not have. `vault` and `item` are stored names.
export class FieldNotFound extends Schema.TaggedError<FieldNotFound>()(
  "FieldNotFound",
  { vault: Schema.String, item: Schema.String, field: Schema.String },
  { httpApiStatus: 404 },
) {}

// A Token's create under a title a rename or delete freed: not an authorisation refusal,
// so it is audited `error`.
export class TitleRetired extends Schema.TaggedError<TitleRetired>()(
  "TitleRetired",
  { vault: Schema.String, item: Schema.String },
  { httpApiStatus: 409 },
) {}

// A release of a title that is not retired in the Vault.
export class TitleNotRetired extends Schema.TaggedError<TitleNotRetired>()(
  "TitleNotRetired",
  { vault: Schema.String, item: Schema.String },
  { httpApiStatus: 404 },
) {}

// A label the Kind does not have; `allowed` lists the Kind's labels in display order.
export class UnknownField extends Schema.TaggedError<UnknownField>()(
  "UnknownField",
  { kind: Schema.String, field: Schema.String, allowed: Schema.Array(Schema.String) },
  { httpApiStatus: 400 },
) {}

// The Kind's primary Field was missing.
export class FieldRequired extends Schema.TaggedError<FieldRequired>()(
  "FieldRequired",
  { kind: Schema.String, field: Schema.String },
  { httpApiStatus: 400 },
) {}

// A value that fails `Value.problem`: empty, with U+0000, over 65536 UTF-8 bytes, or not well-formed UTF-16.
export class InvalidValue extends Schema.TaggedError<InvalidValue>()(
  "InvalidValue",
  { field: Schema.String, reason: Schema.Literals(Value.problems) },
  { httpApiStatus: 400 },
) {}

// The first string of a resolve that is not a Reference.
export class InvalidReference extends Schema.TaggedError<InvalidReference>()(
  "InvalidReference",
  { reference: Schema.String, reason: Schema.Literals(Reference.invalidReasons) },
  { httpApiStatus: 400 },
) {}

// The first Reference of a resolve whose Item or Field is missing, with up to three References from the same
// granted Vault.
export class ReferenceNotFound extends Schema.TaggedError<ReferenceNotFound>()(
  "ReferenceNotFound",
  {
    reference: Schema.String,
    missing: Schema.Literals(["item", "field"]),
    suggestions: Schema.Array(Schema.String),
  },
  { httpApiStatus: 404 },
) {}

// What failed its integrity check, and where: a Field names its Reference, an Item (its Kind or its required
// Field) its Vault and title, a Vault key its Vault.
export const Damaged = Schema.Union([
  Schema.Struct({ what: Schema.Literal("field"), reference: Schema.String }),
  Schema.Struct({ what: Schema.Literal("item"), vault: Schema.String, item: Schema.String }),
  Schema.Struct({ what: Schema.Literal("vault-key"), vault: Schema.String }),
  Schema.Struct({ what: Schema.Literal("master-key") }),
])

export type Damaged = typeof Damaged.Type

// An AEAD or padding failure under a key that must be right: the file was modified or corrupted.
export class IntegrityCheckFailed extends Schema.TaggedError<IntegrityCheckFailed>()(
  "IntegrityCheckFailed",
  { damaged: Damaged },
  { httpApiStatus: 500 },
) {}

const classes = [
  ...guardErrors,
  NotInitialised,
  AlreadyInitialised,
  InitCodeInvalid,
  PassphraseInvalid,
  PassphraseIncorrect,
  BackoffActive,
  AuditUnavailable,
  TokenRejected,
  VaultNotGranted,
  CreateNotAllowed,
  TokenLabelExists,
  TokenNotFound,
  LimitExceeded,
  VaultNotFound,
  VaultExists,
  VaultNotEmpty,
  InvalidName,
  ItemExists,
  ItemNotFound,
  FieldNotFound,
  TitleRetired,
  TitleNotRetired,
  UnknownField,
  FieldRequired,
  InvalidValue,
  InvalidReference,
  ReferenceNotFound,
  IntegrityCheckFailed,
] as const

export const ApiError = Schema.Union(classes)

export type ApiError = typeof ApiError.Type

// By class, not by shape: the CLI has its own `InvalidValue` and `InvalidReference` with the same tags, and a
// tag-based check would take them for Server errors.
export const isApiError = (input: unknown): input is ApiError => classes.some((error) => input instanceof error)

// The HTTP status `error`'s class declares, for responses built outside the `HttpApi` (the guard, the raw backup
// route); read from the class rather than repeated. `httpApiStatus` is typed `number` by `HttpApiSchema`'s
// annotation augment and read the same way there; 500 is its default for an error without one.
const declaredStatus = SchemaAST.resolveAt<number>("httpApiStatus")

export const httpStatus = (error: ApiError): number => {
  const declared = classes.find((errorClass) => error instanceof errorClass)

  return (declared === undefined ? undefined : declaredStatus(declared.ast)) ?? 500
}
