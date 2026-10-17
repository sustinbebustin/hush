import { Clock, Effect, Match } from "effect"

import { Admin, type AuditQuery, unverifiedOnTransport } from "../cli/Admin.js"
import { Client } from "../cli/Client.js"
import { type AuditFlagsInvalid, CliError } from "../cli/CliError.js"
import type { Target } from "../cli/Target.js"
import { Api } from "../shared/Api.js"
import {
  type ApiError,
  BackoffActive,
  type InvalidName,
  isApiError,
  parseName,
  PassphraseIncorrect,
} from "../shared/ApiError.js"
import { Audit, type Ask } from "./Audit.js"
import type { Clipboard } from "./Clipboard.js"
import { Event } from "./Event.js"
import { Problem } from "./Problem.js"
import type { UiEffect } from "./UiEffect.js"

// Runs the reducer's effects that leave the process or wait: each Server request through the CLI's typed Client
// (one request, no retry), timers and clipboard writes. Each ends in the one event that reports it; every expected failure becomes
// a `Problem` rendered from typed fields, so no response body reaches the screen (invariant 2).

// The effects run here; `Quit` and `Suspend` act on the renderer, so they are the loop's own.
export type Work = Exclude<UiEffect, { readonly _tag: "Quit" | "Suspend" }>

// The CLI's own message for `error`, word for word.
const renderedOf =
  (target: Target) =>
  (error: ApiError | CliError.CliError): Problem =>
    Problem.Failed({
      message: isApiError(error) ? CliError.renderServer(error, target.origin) : CliError.render(error),
    })

const problemOf =
  (target: Target) =>
  (error: ApiError | CliError.CliError): Problem => {
    if (error instanceof PassphraseIncorrect) return Problem.Incorrect({ retryAfterSeconds: error.retryAfterSeconds })

    if (error instanceof BackoffActive) return Problem.Backoff({ retryAfterSeconds: error.retryAfterSeconds })

    return renderedOf(target)(error)
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
    CreateVault: ({ passphrase, vault }) =>
      Effect.fromResult(parseName("vault", vault)).pipe(
        Effect.flatMap((name) =>
          unverifiedOnTransport(
            Client.request(Api, target, (client) =>
              client.admin.vaultsCreate({ payload: { passphrase, vault: name } }),
            ),
          ),
        ),
        Effect.map(() => Event.VaultChanged()),
        Effect.catch((error) => Effect.succeed(Event.VaultRefused({ problem: renderedOf(target)(error) }))),
      ),
    DeleteVault: ({ passphrase, vault }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) => client.admin.vaultsDelete({ payload: { passphrase, vault } })),
      ).pipe(
        Effect.map(() => Event.VaultChanged()),
        Effect.catch((error) => Effect.succeed(Event.VaultRefused({ problem: renderedOf(target)(error) }))),
      ),
    RefreshVaults: ({ passphrase }) =>
      Client.request(Api, target, (client) => client.admin.vaultsList({ payload: { passphrase } })).pipe(
        Effect.map(({ vaults }) => Event.VaultsListed({ vaults })),
        Effect.catch((error) => Effect.succeed(Event.VaultRefused({ problem: renderedOf(target)(error) }))),
      ),
    CopyToken: ({ token }) => Effect.map(clipboard.write(token), (written) => Event.TokenCopied({ written })),
    After: ({ millis, event }) => Effect.as(Effect.sleep(millis), event),
    // A refused Reveal is a notice in an Open UI, not the Locked prompt, so even a wrong Passphrase (changed
    // elsewhere) reads as the CLI says it.
    Reveal: ({ passphrase, reference, generation }) =>
      Client.request(Api, target, (client) => client.admin.itemsReveal({ payload: { passphrase, reference } })).pipe(
        Effect.map(({ value }) => Event.Revealed({ reference, generation, value })),
        Effect.catch((error) =>
          Effect.succeed(Event.RevealRefused({ reference, generation, problem: renderedOf(target)(error) })),
        ),
      ),
    // Writes, so a lost answer reads as unverified (invariant 3); refusals read as the CLI's `item` commands say.
    RenameItem: ({ passphrase, vault, item, newTitle }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) =>
          client.admin.itemsRename({ payload: { passphrase, vault, item, newTitle } }),
        ),
      ).pipe(
        Effect.map((receipt) => Event.Renamed({ receipt })),
        Effect.catch((error) => Effect.succeed(Event.ChangeRefused({ problem: renderedOf(target)(error) }))),
      ),
    DeleteItem: ({ passphrase, vault, item }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) => client.admin.itemsDelete({ payload: { passphrase, vault, item } })),
      ).pipe(
        Effect.map(() => Event.ItemsChanged({ vault })),
        Effect.catch((error) => Effect.succeed(Event.ChangeRefused({ problem: renderedOf(target)(error) }))),
      ),
    ReleaseTitle: ({ passphrase, vault, title }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) => client.admin.itemsRelease({ payload: { passphrase, vault, title } })),
      ).pipe(
        Effect.map(() => Event.ItemsChanged({ vault })),
        Effect.catch((error) => Effect.succeed(Event.ChangeRefused({ problem: renderedOf(target)(error) }))),
      ),
  })
}

export * as Interpreter from "./Interpreter.js"
