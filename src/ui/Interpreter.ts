import { Clock, Effect, Match } from "effect"

import { Admin, type AuditQuery } from "../cli/Admin.js"
import { Client } from "../cli/Client.js"
import { type AuditFlagsInvalid, CliError } from "../cli/CliError.js"
import type { Target } from "../cli/Target.js"
import { Api } from "../shared/Api.js"
import { type ApiError, BackoffActive, type InvalidName, isApiError, PassphraseIncorrect } from "../shared/ApiError.js"
import { Audit, type Ask } from "./Audit.js"
import { Event } from "./Event.js"
import { Problem } from "./Problem.js"
import type { UiEffect } from "./UiEffect.js"

// Runs the reducer's effects that leave the process or wait: each Server request through the CLI's typed Client
// (one request, no retry), and timers. Each ends in the one event that reports it; every expected failure becomes
// a `Problem` rendered from typed fields, so no response body reaches the screen (invariant 2).

// The effects run here; `Quit` is the loop's own.
export type Work = Exclude<UiEffect, { readonly _tag: "Quit" }>

const problemOf =
  (target: Target) =>
  (error: ApiError | CliError.CliError): Problem => {
    if (error instanceof PassphraseIncorrect) return Problem.Incorrect({ retryAfterSeconds: error.retryAfterSeconds })

    if (error instanceof BackoffActive) return Problem.Backoff({ retryAfterSeconds: error.retryAfterSeconds })

    return Problem.Failed({
      message: isApiError(error) ? CliError.renderServer(error, target.origin) : CliError.render(error),
    })
  }

// A filter as `hush audit` takes its flag: empty is no filter.
const typed = (text: string) => (text === "" ? undefined : text)

// The query an Audit request sends: a first page's filters checked and resolved as `hush audit` resolves its
// flags (a relative since against the clock now), a later page's the query its first page sent.
const auditQuery = (ask: Ask): Effect.Effect<AuditQuery, AuditFlagsInvalid | InvalidName> =>
  Audit.Ask.$match(ask, {
    First: ({ filters }) => {
      const flags = { vault: typed(filters.vault), label: typed(filters.label), since: typed(filters.since) }

      return Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.fromResult(Admin.auditQuery({ ...flags, limit: undefined, before: undefined }, now)),
      )
    },
    Next: ({ query }) => Effect.succeed(query),
  })

export const run = (target: Target, work: Work): Effect.Effect<Event> => {
  const refused = problemOf(target)

  return Match.valueTags(work, {
    ListVaults: ({ passphrase }) =>
      Client.request(Api, target, (client) => client.admin.vaultsList({ payload: { passphrase } })).pipe(
        Effect.map(({ vaults }) => Event.Unlocked({ passphrase, vaults })),
        Effect.catch((error) => Effect.succeed(Event.UnlockRefused({ problem: refused(error) }))),
      ),
    ListItems: ({ passphrase, vault }) =>
      Client.request(Api, target, (client) => client.admin.itemsList({ payload: { passphrase, vault } })).pipe(
        Effect.map((list) => Event.ItemsLoaded({ list })),
        Effect.catch((error) => Effect.succeed(Event.ItemsRefused({ vault, problem: refused(error) }))),
      ),
    ListAudit: ({ passphrase, ask }) =>
      auditQuery(ask).pipe(
        Effect.flatMap((query) =>
          Client.request(Api, target, (client) =>
            client.admin.audit({
              payload: Audit.Ask.$is("Next")(ask)
                ? { passphrase, ...query, before: ask.before }
                : { passphrase, ...query },
            }),
          ).pipe(Effect.map((page) => Event.AuditListed({ ask, query, page }))),
        ),
        Effect.catch((error) => Effect.succeed(Event.AuditRefused({ ask, problem: refused(error) }))),
      ),
    After: ({ millis, event }) => Effect.as(Effect.sleep(millis), event),
  })
}

export * as Interpreter from "./Interpreter.js"
