import { Effect, Redacted, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"

import { Access } from "../shared/Access.js"
import type {
  AuthenticatedToken,
  PassphraseOnly,
  TokenDescription,
  TokenIssueReceipt,
  TokenIssueRequest,
  TokenList,
  TokenRevoked,
  TokenRevokeRequest,
  TokenState,
} from "../shared/Api.js"
import {
  type ApiError,
  type AuditUnavailable,
  IntegrityCheckFailed,
  LimitExceeded,
  parseName,
  TokenLabelExists,
  TokenNotFound,
  TokenRejected,
  VaultNotFound,
} from "../shared/ApiError.js"
import { Name } from "../shared/Name.js"
import { Token } from "../shared/Token.js"
import { Audit } from "./Audit.js"
import { Database } from "./Database.js"
import { Keys } from "./Keys.js"
import { Passphrase } from "./Passphrase.js"

// Tokens: issue, list and revoke under the Passphrase, `TokenAuth`'s steps, `token/describe`, and the audit row
// every authenticated Token request writes before it responds, so no result is returned unrecorded.

const TokenRow = Schema.Struct({
  id: Schema.Number,
  label: Schema.String,
  wrap_salt: Schema.Uint8Array,
  expires_at: Schema.NullOr(Schema.String),
  revoked_at: Schema.NullOr(Schema.String),
})
type TokenRow = typeof TokenRow.Type

const GrantRow = Schema.Struct({ vault_id: Schema.Number, name: Name.schema, access: Schema.Literals(Access.all) })

// The refusal for a revoked Token, or one expired at `at`, naming its Label and when; undefined while active.
const inactive = (row: TokenRow, at: string): TokenRejected | undefined => {
  if (row.revoked_at !== null)
    return new TokenRejected({ rejection: { reason: "revoked", label: row.label, at: row.revoked_at } })
  if (row.expires_at !== null && row.expires_at <= at)
    return new TokenRejected({ rejection: { reason: "expired", label: row.label, at: row.expires_at } })
  return undefined
}

const refused = (reason: "missing" | "malformed" | "unknown") => new TokenRejected({ rejection: { reason } })

// `TokenAuth`: the format check and the hash lookup are refused unaudited; a revoked or expired
// Token is refused and audited `denied` under `action`. Store failures are not expected outcomes, so they die.
export const authenticate = (
  credential: Redacted.Redacted<string>,
  action: Audit.Action,
  peer: string | null,
): Effect.Effect<AuthenticatedToken, TokenRejected | AuditUnavailable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const presented = Redacted.value(credential)
    if (presented === "") return yield* refused("missing")
    const parsed = Token.parse(presented)
    if (Result.isFailure(parsed)) return yield* refused("malformed")
    const token = parsed.success
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(TokenRow))(
      yield* sql`SELECT id, label, wrap_salt, expires_at, revoked_at FROM tokens WHERE hash = ${Keys.authHash(token)}`,
    ).pipe(Effect.orDie)
    if (row === undefined) return yield* refused("unknown")
    const at = yield* Audit.now
    const rejection = inactive(row, at)
    if (rejection !== undefined) {
      yield* sql
        .withTransaction(
          Audit.write({
            at,
            actor: { type: "token", id: row.id, label: row.label },
            action,
            vaults: [],
            references: [],
            result: { outcome: "denied", error: rejection._tag },
            peer,
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      return yield* rejection
    }
    const grants = yield* Schema.decodeUnknownEffect(Schema.Array(GrantRow))(
      yield* sql`
        SELECT tv.vault_id, v.name, tv.access FROM token_vaults tv JOIN vaults v ON v.id = tv.vault_id
        WHERE tv.token_id = ${row.id} ORDER BY v.name`,
    ).pipe(Effect.orDie)
    return {
      id: row.id,
      label: row.label,
      grants: grants.map(({ vault_id, name, access }) => ({ vaultId: vault_id, vault: name, access })),
      token: Redacted.make(token),
      wrapSalt: new Uint8Array(row.wrap_salt),
    }
  }).pipe(Effect.catchTag("SqlError", Effect.die))

const WrapRow = Schema.Struct({
  vault_id: Schema.Number,
  access: Schema.Literals(Access.all),
  key_nonce: Schema.NullOr(Schema.Uint8Array),
  key_wrapped: Schema.NullOr(Schema.Uint8Array),
})

// The Token's state and the Grant wraps of `vaultIds`, read in one statement, so a Revoke commits
// either wholly before or wholly after it. No row or a NULL wrap means
// the Token was revoked or expired after `TokenAuth` passed it: `TokenRejected`, which `audited` records `denied`.
// `vaultIds` must be granted Vaults.
export const activeWraps = (
  token: AuthenticatedToken,
  vaultIds: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, Keys.GrantWrap>, TokenRejected, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const at = yield* Audit.now
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(WrapRow))(
      yield* sql`
        SELECT tv.vault_id, tv.access, tv.key_nonce, tv.key_wrapped FROM token_vaults tv
        JOIN tokens t ON t.id = tv.token_id
        WHERE tv.token_id = ${token.id} AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ${at})
          AND ${sql.in("tv.vault_id", vaultIds)}`,
    ).pipe(Effect.orDie)
    const wraps = new Map<number, Keys.GrantWrap>()
    for (const row of rows)
      if (row.key_nonce !== null && row.key_wrapped !== null)
        wraps.set(row.vault_id, {
          vaultId: row.vault_id,
          access: row.access,
          wrap: { nonce: new Uint8Array(row.key_nonce), wrapped: new Uint8Array(row.key_wrapped) },
        })
    if (vaultIds.every((id) => wraps.has(id))) return wraps
    // Which of the two: the row says, read again only on this path. Tokens are never deleted, and an active
    // Token has a wrap per Grant, so anything else is a broken store.
    const [state] = yield* Schema.decodeUnknownEffect(Schema.Array(TokenRow))(
      yield* sql`SELECT id, label, wrap_salt, expires_at, revoked_at FROM tokens WHERE id = ${token.id}`,
    ).pipe(Effect.orDie)
    const rejection = state === undefined ? undefined : inactive(state, at)
    if (rejection === undefined)
      return yield* Effect.die(new Error(`Token ${token.id} is active but lacks a Grant wrap for a granted Vault`))
    return yield* rejection
  }).pipe(Effect.catchTag("SqlError", Effect.die))

// What a Token request's audit row names: Vaults, References and detail, never values.
export interface Scope {
  readonly vaults: ReadonlyArray<string>
  readonly references: ReadonlyArray<string>
  readonly detail?: Audit.Detail
}

// Refusals about what the Token may do are `denied`; every other failure after authentication is `error`.
const outcomeOf = (error: ApiError): Audit.Outcome =>
  error._tag === "TokenRejected" || error._tag === "VaultNotGranted" || error._tag === "CreateNotAllowed"
    ? { outcome: "denied", error: error._tag }
    : { outcome: "error", error: error._tag }

// Runs `operation` in one transaction that commits with its `ok` audit row and `last_used_at`, so a result is
// returned only once it is recorded. A failure is recorded in a transaction of its own, then returned; if
// that row cannot be written either, the request fails `AuditUnavailable`. Store failures die.
export const audited = <A, E extends ApiError>(request: {
  readonly token: AuthenticatedToken
  readonly action: Audit.Action
  readonly peer: string | null
  readonly scope: Scope
  readonly operation: Effect.Effect<A, E, SqlClient.SqlClient>
}): Effect.Effect<A, E | AuditUnavailable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const { token, action, peer, scope, operation } = request
    const sql = yield* SqlClient.SqlClient
    const at = yield* Audit.now
    const record = (result: Audit.Outcome) =>
      Audit.write({
        at,
        actor: { type: "token", id: token.id, label: token.label },
        action,
        vaults: scope.vaults,
        references: scope.references,
        ...(scope.detail === undefined ? {} : { detail: scope.detail }),
        result,
        peer,
      })
    return yield* sql.withTransaction(Effect.tap(operation, () => record({ outcome: "ok" }))).pipe(
      Effect.catchIf(
        (error): error is Exclude<E, AuditUnavailable> => error._tag !== "AuditUnavailable",
        (error) => Effect.andThen(sql.withTransaction(record(outcomeOf(error))), Effect.fail(error)),
      ),
    )
  }).pipe(Effect.catchTag("SqlError", Effect.die))

const InfoRow = Schema.Struct({
  id: Schema.Number,
  label: Schema.String,
  created_at: Schema.String,
  expires_at: Schema.NullOr(Schema.String),
  revoked_at: Schema.NullOr(Schema.String),
  last_used_at: Schema.NullOr(Schema.String),
})

const ListedGrantRow = Schema.Struct({ token_id: Schema.Number, ...GrantRow.fields })

const stateOf = (row: typeof InfoRow.Type, at: string): TokenState => {
  if (row.revoked_at !== null) return "revoked"
  return row.expires_at !== null && row.expires_at <= at ? "expired" : "active"
}

// `tokens/list`: every Token, newest first, with the Grants it holds or, revoked, held. Nothing is unwrapped.
export const list = (request: PassphraseOnly, peer: string | null) =>
  Passphrase.audited({
    passphrase: request.passphrase,
    action: "token.list",
    peer,
    scope: { vaults: [] },
    exclusive: false,
    checkpoint: false,
    unlock: Keys.fromPassphrase,
    operation: () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const at = yield* Audit.now
        const tokens = yield* Database.rows(
          InfoRow,
          sql`SELECT id, label, created_at, expires_at, revoked_at, last_used_at FROM tokens ORDER BY id DESC`,
        )
        const grants = yield* Database.rows(
          ListedGrantRow,
          sql`
            SELECT tv.token_id, tv.vault_id, v.name, tv.access FROM token_vaults tv JOIN vaults v ON v.id = tv.vault_id
            ORDER BY v.name_key, v.name`,
        )
        const listed: TokenList = {
          tokens: tokens.map((row) => ({
            label: row.label,
            grants: grants
              .filter(({ token_id }) => token_id === row.id)
              .map(({ name, access }) => ({ vault: name, access })),
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            revokedAt: row.revoked_at,
            lastUsedAt: row.last_used_at,
            state: stateOf(row, at),
          })),
        }
        return listed
      }),
  })

const LabelRow = Schema.Struct({ id: Schema.Number, label: Schema.String })

// The non-revoked Token with `label`'s key gets `revoked_at`; the trigger nulls its wraps and the row and
// hash stay, so later uses are recognised and audited `denied`. No key is needed. Run it inside the transaction
// that writes its audit row; `tokens/revoke` and `hush server revoke` both do.
export const revokeLabelled = (label: Name): Effect.Effect<TokenRevoked, TokenNotFound, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [found] = yield* Database.rows(
      LabelRow,
      sql`SELECT id, label FROM tokens WHERE label_key = ${Name.key(label)} AND revoked_at IS NULL`,
    )
    if (found === undefined) return yield* new TokenNotFound({ label })
    const at = yield* Audit.now
    yield* sql`UPDATE tokens SET revoked_at = ${at} WHERE id = ${found.id}`.pipe(Effect.orDie)
    const receipt: TokenRevoked = { label: found.label, revoked: true, revokedAt: at }
    return receipt
  })

// `tokens/revoke`: `revokeLabelled` under the Passphrase. The WAL is checkpointed after the commit, so the old
// wraps leave the files.
export const revoke = (request: TokenRevokeRequest, peer: string | null) => {
  const [label] = Audit.named(request.label)
  return Passphrase.audited({
    passphrase: request.passphrase,
    action: "token.revoke",
    peer,
    scope: { vaults: [], ...(label === undefined ? {} : { detail: { label } }) },
    exclusive: false,
    checkpoint: true,
    unlock: Keys.fromPassphrase,
    operation: () => Effect.flatMap(parse("label", request.label), revokeLabelled),
    recorded: (receipt) => ({ vaults: [], detail: { label: receipt.label } }),
  })
}

const DescribedRow = Schema.Struct({ created_at: Schema.String, expires_at: Schema.NullOr(Schema.String) })

// `token/describe`: the Token's Label, Grants and times. Nothing is unwrapped,
// so `TokenAuth`'s check of revocation and expiry is the whole check.
export const describe = (token: AuthenticatedToken, peer: string | null) =>
  audited({
    token,
    action: "token.describe",
    peer,
    scope: { vaults: [], references: [] },
    operation: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* Database.rows(
        DescribedRow,
        sql`SELECT created_at, expires_at FROM tokens WHERE id = ${token.id}`,
      )
      // Tokens are never deleted, so an authenticated Token without its row is a broken store.
      if (row === undefined) return yield* Effect.die(new Error(`Token ${token.id} has no row`))
      const described: TokenDescription = {
        label: token.label,
        grants: token.grants.map(({ vault, access }) => ({ vault, access })),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }
      return described
    }),
  })

// The most Grants one Token may hold (a fixed request-size limit).
const maxGrants = 64

// A Vault as a Grant needs it: its id, stored name and K_v wrap under MK.
const VaultKeyRow = Schema.Struct({
  id: Schema.Number,
  name: Name.schema,
  key_nonce: Schema.Uint8Array,
  key_wrapped: Schema.Uint8Array,
})
type VaultKeyRow = typeof VaultKeyRow.Type

const KeptRow = Schema.Struct({ ...VaultKeyRow.fields, access: Schema.Literals(Access.all) })

const IdRow = Schema.Struct({ id: Schema.Number })

interface IssueGrant {
  readonly vault: VaultKeyRow
  readonly access: Access
}

const parse = (what: string, input: string) => Effect.fromResult(parseName(what, input))

// `tokens/issue`. Its rows name the Label and Vaults as requested until it succeeds; the `ok` row holds the Grants
// it issued, `expiresAt` and the replaced Label, never the Token. A replacement revokes, so the WAL is checkpointed
// after it.
export const issue = (request: TokenIssueRequest, peer: string | null) => {
  const [label] = Audit.named(request.label)
  return Passphrase.audited({
    passphrase: request.passphrase,
    action: "token.issue",
    peer,
    scope: {
      vaults: request.grants.flatMap(({ vault }) => Audit.named(vault)),
      ...(label === undefined ? {} : { detail: { label } }),
    },
    exclusive: false,
    checkpoint: request.replaces === true,
    unlock: Keys.fromPassphrase,
    operation: (master) => issueUnder(master, request),
    recorded: (receipt) => ({
      vaults: receipt.grants.map(({ vault }) => vault),
      detail: {
        label: receipt.label,
        grants: receipt.grants,
        expiresAt: receipt.expiresAt,
        // `AuditDetail.replaced` is a Label: the replaced Token had this one.
        ...(receipt.replaced ? { replaced: receipt.label } : {}),
      },
    }),
  })
}

// Inside the issue transaction: with `replaces`, the active or expired Token with the Label is revoked first (the
// trigger nulls its wraps) and, with `keepGrants`, its Grants merged under the explicit ones; then the new Token,
// its id from `nextIds`, and per Grant K_v rewrapped from MK to TW.
const issueUnder = (master: Keys.MasterKey, request: TokenIssueRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const label = yield* parse("label", request.label)
    // Before any Vault lookup, so 65 Grants is `LimitExceeded` whatever they name; kept Grants are counted below.
    if (request.grants.length > maxGrants) return yield* new LimitExceeded({ what: "grants", max: maxGrants })
    const explicit = yield* Effect.forEach(request.grants, (grant) =>
      Effect.gen(function* () {
        const vault = yield* parse("vault", grant.vault)
        const [found] = yield* Database.rows(
          VaultKeyRow,
          sql`SELECT id, name, key_nonce, key_wrapped FROM vaults WHERE name_key = ${Name.key(vault)}`,
        )
        if (found === undefined) return yield* new VaultNotFound({ vault })
        const issued: IssueGrant = { vault: found, access: grant.access }
        return issued
      }),
    )
    const at = yield* Audit.now
    const [replaced] =
      request.replaces === true
        ? yield* Database.rows(
            IdRow,
            sql`SELECT id FROM tokens WHERE label_key = ${Name.key(label)} AND revoked_at IS NULL`,
          )
        : []
    if (replaced === undefined && request.keepGrants === true) return yield* new TokenNotFound({ label })
    const kept: ReadonlyArray<IssueGrant> =
      replaced === undefined || request.keepGrants !== true
        ? []
        : (yield* Database.rows(
            KeptRow,
            sql`
              SELECT v.id, v.name, v.key_nonce, v.key_wrapped, tv.access FROM token_vaults tv
              JOIN vaults v ON v.id = tv.vault_id WHERE tv.token_id = ${replaced.id}`,
          )).map(({ access, ...vault }) => ({ vault, access }))
    if (replaced !== undefined)
      yield* sql`UPDATE tokens SET revoked_at = ${at} WHERE id = ${replaced.id}`.pipe(Effect.orDie)
    // Explicit Access wins per Vault.
    const grants = [
      ...explicit,
      ...kept.filter(({ vault }) => !explicit.some((grant) => grant.vault.id === vault.id)),
    ].toSorted((a, b) => Name.key(a.vault.name).localeCompare(Name.key(b.vault.name)))
    if (grants.length > maxGrants) return yield* new LimitExceeded({ what: "grants", max: maxGrants })
    // The request schema demands a Grant or `keepGrants`, and an unrevoked Token keeps its Grants (a Vault with one
    // cannot be deleted), so none here is a broken store; a Token without Grants is never issued.
    if (grants.length === 0) return yield* Effect.die(new Error(`Token ${label} to replace has no Grants to keep`))

    const tokenId = yield* Database.nextId("tokens")
    const issued = yield* Keys.newToken(
      master,
      tokenId,
      grants.map(({ vault, access }) => ({
        vaultId: vault.id,
        access,
        underMaster: { nonce: new Uint8Array(vault.key_nonce), wrapped: new Uint8Array(vault.key_wrapped) },
      })),
    ).pipe(
      Effect.catchTag("GrantKeyOpenFailed", ({ vaultId }) => {
        const vault = grants.find((grant) => grant.vault.id === vaultId)?.vault.name
        return vault === undefined
          ? Effect.die(new Error(`newToken failed for Vault ${vaultId}, which it was not given`))
          : Effect.fail(new IntegrityCheckFailed({ damaged: { what: "vault-key", vault } }))
      }),
    )
    const expiresAt =
      request.ttlSeconds === undefined ? null : new Date(Date.parse(at) + request.ttlSeconds * 1000).toISOString()
    yield* sql`
      INSERT INTO tokens (id, hash, wrap_salt, label, label_key, created_at, expires_at)
      VALUES (${tokenId}, ${issued.hash}, ${issued.salt}, ${label}, ${Name.key(label)}, ${at}, ${expiresAt})`.pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "UniqueViolation",
        () => Effect.fail(new TokenLabelExists({ label })),
      ),
      Effect.catchTag("SqlError", Effect.die),
    )
    for (const grant of issued.wraps)
      yield* sql`
        INSERT INTO token_vaults (token_id, vault_id, access, key_nonce, key_wrapped)
        VALUES (${tokenId}, ${grant.vaultId}, ${grant.access}, ${grant.wrap.nonce}, ${grant.wrap.wrapped})`.pipe(
        Effect.orDie,
      )
    const receipt: TokenIssueReceipt = {
      token: issued.token,
      label,
      grants: grants.map(({ vault, access }) => ({ vault: vault.name, access })),
      createdAt: at,
      expiresAt,
      replaced: replaced !== undefined,
    }
    return receipt
  })

export * as Tokens from "./Tokens.js"
