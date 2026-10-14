import { Effect, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"

import {
  AuditAction,
  type AuditActor,
  AuditDetail,
  type AuditEntry,
  auditLimit,
  type AuditPage,
  type AuditRequest,
} from "../shared/Api.js"
import { parseName } from "../shared/ApiError.js"
import { Name } from "../shared/Name.js"
import { Database } from "./Database.js"
import { Keys } from "./Keys.js"
import { Passphrase } from "./Passphrase.js"

// The Audit Log reader, `admin/audit`: the Passphrase only, newest
// first, filtered by Vault, Token Label and time, paged by entry id. Reading is itself one `audit.read` row.
// There is no prune: the log is kept forever.

const Names = Schema.fromJsonString(Schema.Array(Schema.String))

const AuditRow = Schema.Struct({
  id: Schema.Number,
  at: Schema.String,
  last_at: Schema.String,
  count: Schema.Number,
  actor: Schema.Literals(["init", "passphrase", "host", "token"]),
  token_label: Schema.NullOr(Schema.String),
  action: AuditAction,
  vaults: Names,
  refs: Names,
  detail: Schema.NullOr(Schema.fromJsonString(AuditDetail)),
  outcome: Schema.Literals(["ok", "denied", "error"]),
  error: Schema.NullOr(Schema.String),
  peer: Schema.NullOr(Schema.String),
})

type AuditRow = typeof AuditRow.Type

// The row's actor; undefined for a Token row without its Label.
const actorOf = ({ actor, token_label }: AuditRow): AuditActor | undefined => {
  if (actor !== "token") return { type: actor }

  return token_label === null ? undefined : { type: actor, label: token_label }
}

// The row as an entry. The table's CHECKs pair a Token actor with its Label and a non-`ok` outcome with its error,
// so a row that breaks either is a broken store.
const entryOf = (row: AuditRow): Effect.Effect<AuditEntry> => {
  const broken = Effect.die(new Error(`audit row ${row.id} breaks the table's constraints`))
  const actor = actorOf(row)

  if (actor === undefined) return broken

  const common = {
    id: row.id,
    at: row.at,
    lastAt: row.last_at,
    count: row.count,
    actor,
    action: row.action,
    vaults: row.vaults,
    references: row.refs,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.peer === null ? {} : { peer: row.peer }),
  }

  if (row.outcome === "ok") return Effect.succeed({ ...common, outcome: row.outcome })

  if (row.error === null) return broken

  return Effect.succeed({ ...common, outcome: row.outcome, error: row.error })
}

// Whether `name` (as a row holds it) has the identity `key`; a string that is not a Name matches nothing.
const sameName = (key: string) => (name: string) =>
  Result.match(Name.parse(name), { onFailure: () => false, onSuccess: (parsed) => Name.key(parsed) === key })

// The identity of a filter name, or `InvalidName`; undefined when the filter is absent.
const nameKey = (what: string, input: string | undefined) =>
  input === undefined ? Effect.succeed(undefined) : Effect.map(Effect.fromResult(parseName(what, input)), Name.key)

// One page, newest first: rows below `before` whose last activity is at or after `since`, kept when they name the
// Vault and come from a Token with the Label. Name identity is NFC plus full-Unicode lowercase, which SQLite's
// `lower` does not do, so those two filters run here, over rows read in batches of one more than the page; `next`
// is set only when a further matching row exists.
const readPage = (request: AuditRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const vault = yield* nameKey("vault", request.vault)
    const label = yield* nameKey("label", request.label)
    const limit = request.limit ?? auditLimit.default

    const matches = (row: AuditRow) =>
      (vault === undefined || row.vaults.some(sameName(vault))) &&
      (label === undefined || (row.token_label !== null && sameName(label)(row.token_label)))

    const found: Array<AuditRow> = []
    let below = request.before ?? Number.MAX_SAFE_INTEGER

    while (found.length <= limit) {
      const batch = yield* Database.rows(
        AuditRow,
        sql`
          SELECT id, at, last_at, count, actor, token_label, action, vaults, refs, detail, outcome, error, peer
          FROM audit WHERE id < ${below} AND last_at >= ${request.since ?? ""} ORDER BY id DESC LIMIT ${limit + 1}`,
      )

      found.push(...batch.filter(matches))
      const last = batch.at(-1)

      if (last === undefined || batch.length <= limit) break
      below = last.id
    }

    const entries = yield* Effect.forEach(found.slice(0, limit), entryOf)
    const next = found.length > limit ? entries.at(-1)?.id : undefined
    const result: AuditPage = { entries, ...(next === undefined ? {} : { next }) }

    return result
  })

// `admin/audit`: the Passphrase under the backoff, then the page, read in the transaction that writes this read's
// own `audit.read` row, so the page never holds it.
export const read = (request: AuditRequest, peer: string | null) =>
  Passphrase.audited({
    passphrase: request.passphrase,
    action: "audit.read",
    peer,
    scope: { vaults: [] },
    exclusive: false,
    checkpoint: false,
    unlock: Keys.fromPassphrase,
    operation: () => readPage(request),
  })

export * as AuditLog from "./AuditLog.js"
