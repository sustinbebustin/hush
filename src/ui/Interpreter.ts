import { Effect, Match } from "effect"

import { unverifiedOnTransport } from "../cli/Admin.js"
import { Client } from "../cli/Client.js"
import { CliError } from "../cli/CliError.js"
import type { Target } from "../cli/Target.js"
import { Api } from "../shared/Api.js"
import { type ApiError, BackoffActive, isApiError, PassphraseIncorrect } from "../shared/ApiError.js"
import type { Clipboard } from "./Clipboard.js"
import { Event } from "./Event.js"
import { Problem } from "./Problem.js"
import type { UiEffect } from "./UiEffect.js"

// Runs the reducer's effects that leave the process or wait: each Server request through the CLI's typed Client
// (one request, no retry), timers and clipboard writes. Each ends in the one event that reports it; every expected failure becomes
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

// `clipboard` is the host clipboard the copy key writes to.
export const run = (target: Target, work: Work, clipboard: Clipboard): Effect.Effect<Event> => {
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
    ListTokens: ({ passphrase }) =>
      Client.request(Api, target, (client) => client.admin.tokensList({ payload: { passphrase } })).pipe(
        Effect.map((list) => Event.TokensLoaded({ list })),
        Effect.catch((error) => Effect.succeed(Event.TokensRefused({ problem: refused(error) }))),
      ),
    RevokeToken: ({ passphrase, label }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) => client.admin.tokensRevoke({ payload: { passphrase, label } })),
      ).pipe(
        Effect.map((receipt) => Event.TokenRevoked({ label: receipt.label })),
        Effect.catch((error) => Effect.succeed(Event.RevokeRefused({ problem: refused(error) }))),
      ),
    IssueToken: ({ passphrase, fields }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) => client.admin.tokensIssue({ payload: { passphrase, ...fields } })),
      ).pipe(
        Effect.map((receipt) => Event.TokenIssued({ receipt, copyable: clipboard.available })),
        Effect.catch((error) => Effect.succeed(Event.IssueRefused({ problem: refused(error) }))),
      ),
    CopyToken: ({ token }) => Effect.map(clipboard.write(token), (written) => Event.TokenCopied({ written })),
    After: ({ millis, event }) => Effect.as(Effect.sleep(millis), event),
  })
}

export * as Interpreter from "./Interpreter.js"
