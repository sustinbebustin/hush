import { Clock, Effect, Option, Result } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"

import type { AuditAction, AuditDetail } from "../shared/Api.js"
import { type ApiError, AuditUnavailable } from "../shared/ApiError.js"
import { Name } from "../shared/Name.js"
import { PlatformCause } from "../shared/PlatformCause.js"
import { Log } from "./Log.js"

// The Audit Log: one row per evaluated request, in the same database, fail closed. Rows hold names only, never a
// value, Token, Passphrase or Init code.

export type Action = AuditAction

export type Outcome =
  | { readonly outcome: "ok" }
  // `error` is the tag of the error the request failed with.
  | { readonly outcome: "denied" | "error"; readonly error: ApiError["_tag"] }

export type Actor =
  | { readonly type: "init" | "passphrase" | "host" }
  | { readonly type: "token"; readonly id: number; readonly label: string }

export type Detail = AuditDetail

export interface Entry {
  readonly at: string
  readonly actor: Actor
  readonly action: Action
  readonly vaults: ReadonlyArray<string>
  readonly references: ReadonlyArray<string>
  readonly detail?: Detail
  readonly result: Outcome
  // Information only, never used for a decision: behind a proxy or bridge it is the proxy's address.
  readonly peer: string | null
}

// The current time as the Audit Log and every row's timestamps hold it: ISO 8601 UTC with milliseconds, so two
// timestamps compare as strings.
export const now: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (millis) =>
  new Date(millis).toISOString(),
)

// The name an audit row records for a requested string: the name as parsed, or none for a string that is not a
// Name (it may be anything, even a pasted secret).
export const named = (input: string): ReadonlyArray<Name> =>
  Result.match(Name.parse(input), { onFailure: () => [], onSuccess: (name) => [name] })

// The address the request came from, as the listener saw it.
export const peer: Effect.Effect<string | null, never, HttpServerRequest.HttpServerRequest> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  return Option.getOrNull(request.remoteAddress)
})

// How long a dead Token's denials keep folding into one row.
const coalesceMs = 60_000

// A `TokenRejected` row is audited only for a revoked or expired Token, so such a denial updates the newest row with
// the same Token, outcome and error when its `last_at` is under a minute old (`count + 1`, `last_at = at`; Action
// and References stay the first request's): a dead Token being hammered adds about one row a minute.
// Active Tokens are never coalesced. Returns whether a row absorbed the denial.
const coalesced = (entry: Entry, tokenId: number) =>
  Effect.gen(function* () {
    if (entry.result.outcome !== "denied" || entry.result.error !== "TokenRejected") return false
    const sql = yield* SqlClient.SqlClient
    const since = new Date(Date.parse(entry.at) - coalesceMs).toISOString()
    const updated = yield* sql`
      UPDATE audit SET count = count + 1, last_at = ${entry.at}
      WHERE id = (SELECT id FROM audit WHERE token_id = ${tokenId} AND outcome = 'denied' AND error = ${entry.result.error}
        ORDER BY id DESC LIMIT 1)
        AND last_at > ${since}
      RETURNING id`
    return updated.length > 0
  })

// Records one request. Run it inside the operation's transaction, so the operation commits only with its row
// and no operation commits unrecorded; a failed write is `AuditUnavailable`, which rolls the transaction back. A
// Token's request moves its `last_used_at` in the same transaction, and a dead Token's denial may be coalesced.
export const write = (entry: Entry): Effect.Effect<void, AuditUnavailable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const error = entry.result.outcome === "ok" ? null : entry.result.error
    const token = entry.actor.type === "token" ? entry.actor : undefined
    if (token !== undefined) {
      yield* sql`UPDATE tokens SET last_used_at = ${entry.at} WHERE id = ${token.id}`
      if (yield* coalesced(entry, token.id)) return
    }
    const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail)
    yield* sql`
      INSERT INTO audit (at, last_at, actor, token_id, token_label, action, vaults, refs, detail, outcome, error, peer)
      VALUES (${entry.at}, ${entry.at}, ${entry.actor.type}, ${token?.id ?? null}, ${token?.label ?? null},
        ${entry.action}, ${JSON.stringify(entry.vaults)}, ${JSON.stringify(entry.references)}, ${detail},
        ${entry.result.outcome}, ${error}, ${entry.peer})`
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Log.write({
        event: "audit-write-failed",
        code: PlatformCause.code(cause.reason.cause) ?? cause.reason._tag,
      }).pipe(Effect.andThen(Effect.fail(new AuditUnavailable()))),
    ),
  )

export * as Audit from "./Audit.js"
