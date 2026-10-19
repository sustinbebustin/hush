import { Clock, Effect, Match, Redacted } from "effect"

import { Admin, type AuditQuery, sentOnce } from "../cli/Admin.js"
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
import { ItemWrite } from "./ItemWrite.js"
import { Problem } from "./Problem.js"
import type { UiEffect } from "./UiEffect.js"

// Runs the reducer's effects that leave the process or wait: each Server request through the CLI's typed Client
// (one request, no retry), timers and clipboard reads and writes. Each ends in the one event that reports it; every
// expected failure becomes a `Problem` rendered from typed fields, so no response body reaches the screen
// (invariant 2). In an Open UI a wrong Passphrase (changed elsewhere) or the backoff Locks the UI; every other
// refusal is a notice with the CLI's message.

// The effects run here; `Quit` and `Suspend` act on the renderer, so they are the loop's own.
export type Work = Exclude<UiEffect, { readonly _tag: "Quit" | "Suspend" }>

// The one error path of an Open UI: the CLI's own message for `error`, word for word, rendered from its typed fields.
// An answer the Client could not decode is `UnexpectedResponse`, whose message is fixed, so no response body ever
// reaches the screen (invariant 2).
const noticeOf =
  (target: Target) =>
  (error: ApiError | CliError.CliError): Problem =>
    Problem.Failed({
      message: isApiError(error) ? CliError.renderServer(error, target.origin) : CliError.render(error),
    })

// The two Passphrase refusals, keeping the Server's wait so the Locked prompt counts it down; undefined for any other
// error.
const passphraseProblemOf = (error: ApiError | CliError.CliError): Problem | undefined => {
  if (error instanceof PassphraseIncorrect) return Problem.Incorrect({ retryAfterSeconds: error.retryAfterSeconds })

  return error instanceof BackoffActive ? Problem.Backoff({ retryAfterSeconds: error.retryAfterSeconds }) : undefined
}

// The Locked prompt's refusal: a Passphrase refusal, or the notice an Open UI would show.
const unlockProblemOf =
  (target: Target) =>
  (error: ApiError | CliError.CliError): Problem =>
    passphraseProblemOf(error) ?? noticeOf(target)(error)

// An Open UI's refusal: a Passphrase refusal Locks it (`PassphraseRejected`), so it sends nothing more with a
// Passphrase that no longer works; any other error is the event `otherwise` makes of its notice.
const refusalOf =
  (target: Target) =>
  (error: ApiError | CliError.CliError, otherwise: (problem: Problem) => Event): Effect.Effect<Event> => {
    const problem = passphraseProblemOf(error)

    return Effect.succeed(
      problem === undefined ? otherwise(noticeOf(target)(error)) : Event.PassphraseRejected({ problem }),
    )
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

// The Item form's one write, checked by the reducer before it was asked for (`ItemWrite.check`).
const saveItem = (target: Target, passphrase: Redacted.Redacted<string>, write: ItemWrite) =>
  ItemWrite.$match(write, {
    Create: ({ payload }) =>
      sentOnce(
        Client.request(Api, target, (client) => client.admin.itemsCreate({ payload: { passphrase, ...payload } })),
      ).pipe(Effect.map((receipt) => Event.ItemCreated({ receipt }))),
    Edit: ({ vault, item, change }) =>
      sentOnce(
        Client.request(Api, target, (client) =>
          client.admin.itemsEdit({ payload: { passphrase, vault, item, change } }),
        ),
      ).pipe(Effect.map((receipt) => Event.ItemEdited({ receipt }))),
  })

// `clipboard` is the host clipboard the copy key writes to and the paste key reads from.
export const run = (target: Target, work: Work, clipboard: Clipboard): Effect.Effect<Event> => {
  const refused = refusalOf(target)

  return Match.valueTags(work, {
    ListVaults: ({ passphrase, attempt }) =>
      Client.request(Api, target, (client) => client.admin.vaultsList({ payload: { passphrase } })).pipe(
        Effect.map(({ vaults }) => Event.Unlocked({ attempt, passphrase, vaults, clipboard: clipboard.available })),
        Effect.catch((error) =>
          Effect.succeed(Event.UnlockRefused({ attempt, problem: unlockProblemOf(target)(error) })),
        ),
      ),
    ListItems: ({ passphrase, vault }) =>
      Client.request(Api, target, (client) => client.admin.itemsList({ payload: { passphrase, vault } })).pipe(
        Effect.map((list) => Event.ItemsLoaded({ list })),
        Effect.catch((error) => refused(error, (problem) => Event.ItemsRefused({ vault, problem }))),
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
        Effect.catch((error) => refused(error, (problem) => Event.AuditRefused({ ask, problem }))),
      ),
    ListTokens: ({ passphrase }) =>
      Client.request(Api, target, (client) => client.admin.tokensList({ payload: { passphrase } })).pipe(
        Effect.map((list) => Event.TokensLoaded({ list })),
        Effect.catch((error) => refused(error, (problem) => Event.TokensRefused({ problem }))),
      ),
    RevokeToken: ({ passphrase, label }) =>
      sentOnce(
        Client.request(Api, target, (client) => client.admin.tokensRevoke({ payload: { passphrase, label } })),
      ).pipe(
        Effect.map((receipt) => Event.TokenRevoked({ label: receipt.label })),
        Effect.catch((error) => refused(error, (problem) => Event.RevokeRefused({ problem }))),
      ),
    IssueToken: ({ passphrase, fields }) =>
      sentOnce(
        Client.request(Api, target, (client) => client.admin.tokensIssue({ payload: { passphrase, ...fields } })),
      ).pipe(
        Effect.map((receipt) => Event.TokenIssued({ receipt, copyable: clipboard.available })),
        Effect.catch((error) => refused(error, (problem) => Event.IssueRefused({ problem }))),
      ),
    CreateVault: ({ passphrase, vault }) =>
      Effect.fromResult(parseName("vault", vault)).pipe(
        Effect.flatMap((name) =>
          sentOnce(
            Client.request(Api, target, (client) =>
              client.admin.vaultsCreate({ payload: { passphrase, vault: name } }),
            ),
          ),
        ),
        Effect.map(() => Event.VaultChanged()),
        Effect.catch((error) => refused(error, (problem) => Event.VaultRefused({ problem }))),
      ),
    DeleteVault: ({ passphrase, vault }) =>
      sentOnce(
        Client.request(Api, target, (client) => client.admin.vaultsDelete({ payload: { passphrase, vault } })),
      ).pipe(
        Effect.map(() => Event.VaultChanged()),
        Effect.catch((error) => refused(error, (problem) => Event.VaultRefused({ problem }))),
      ),
    RefreshVaults: ({ passphrase }) =>
      Client.request(Api, target, (client) => client.admin.vaultsList({ payload: { passphrase } })).pipe(
        Effect.map(({ vaults }) => Event.VaultsListed({ vaults })),
        Effect.catch((error) => refused(error, (problem) => Event.VaultRefused({ problem }))),
      ),
    CopyToken: ({ token }) => Effect.map(clipboard.write(token), (written) => Event.TokenCopied({ written })),
    After: ({ millis, event }) => Effect.as(Effect.sleep(millis), event),
    Reveal: ({ passphrase, reference, generation }) =>
      Client.request(Api, target, (client) => client.admin.itemsReveal({ payload: { passphrase, reference } })).pipe(
        Effect.map(({ value }) => Event.Revealed({ reference, generation, value })),
        Effect.catch((error) => refused(error, (problem) => Event.RevealRefused({ reference, generation, problem }))),
      ),
    SaveItem: ({ passphrase, write }) =>
      saveItem(target, passphrase, write).pipe(
        Effect.catch((error) => refused(error, (problem) => Event.ItemSaveRefused({ problem }))),
      ),
    ReadClipboard: () => Effect.map(clipboard.read, (pasted) => Event.ClipboardRead({ pasted })),
    // Writes, so a lost or undecodable answer reads as unverified (invariant 3); refusals read as the CLI's `item`
    // commands say.
    RenameItem: ({ passphrase, vault, item, newTitle }) =>
      sentOnce(
        Client.request(Api, target, (client) =>
          client.admin.itemsRename({ payload: { passphrase, vault, item, newTitle } }),
        ),
      ).pipe(
        Effect.map((receipt) => Event.Renamed({ receipt })),
        Effect.catch((error) => refused(error, (problem) => Event.ChangeRefused({ problem }))),
      ),
    DeleteItem: ({ passphrase, vault, item }) =>
      sentOnce(
        Client.request(Api, target, (client) => client.admin.itemsDelete({ payload: { passphrase, vault, item } })),
      ).pipe(
        Effect.map(() => Event.ItemsChanged({ vault })),
        Effect.catch((error) => refused(error, (problem) => Event.ChangeRefused({ problem }))),
      ),
    ReleaseTitle: ({ passphrase, vault, title }) =>
      sentOnce(
        Client.request(Api, target, (client) => client.admin.itemsRelease({ payload: { passphrase, vault, title } })),
      ).pipe(
        Effect.map(() => Event.ItemsChanged({ vault })),
        Effect.catch((error) => refused(error, (problem) => Event.ChangeRefused({ problem }))),
      ),
  })
}

export * as Interpreter from "./Interpreter.js"
