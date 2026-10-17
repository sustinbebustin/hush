import { Clock, Effect, Match, Redacted } from "effect"

import { Admin, type AuditQuery, unverifiedOnTransport } from "../cli/Admin.js"
import { Client } from "../cli/Client.js"
import {
  type AuditFlagsInvalid,
  ChangeUnverified,
  CliError,
  type ServerUnreachable,
  type UnexpectedResponse,
} from "../cli/CliError.js"
import { Create } from "../cli/Create.js"
import { PrivateInput } from "../cli/PrivateInput.js"
import type { Target } from "../cli/Target.js"
import { Api, type ItemChange } from "../shared/Api.js"
import {
  type ApiError,
  BackoffActive,
  type InvalidName,
  isApiError,
  parseName,
  PassphraseIncorrect,
} from "../shared/ApiError.js"
import { Kind } from "../shared/Kind.js"
import { Audit, type Ask } from "./Audit.js"
import type { Clipboard } from "./Clipboard.js"
import { Event } from "./Event.js"
import { ItemForm, type Save } from "./ItemForm.js"
import { Problem } from "./Problem.js"
import type { UiEffect } from "./UiEffect.js"

// Runs the reducer's effects that leave the process or wait: each Server request through the CLI's typed Client
// (one request, no retry), timers and clipboard reads and writes. Each ends in the one event that reports it; every
// expected failure becomes a `Problem` rendered from typed fields, so no response body reaches the screen
// (invariant 2). In an Open UI every refusal, a wrong Passphrase (changed elsewhere) included, is a notice with the
// CLI's message.

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

// The Locked prompt's refusal: the two Passphrase refusals keep the Server's wait, so the prompt counts it down;
// every other error is the notice an Open UI would show.
const unlockProblemOf =
  (target: Target) =>
  (error: ApiError | CliError.CliError): Problem => {
    if (error instanceof PassphraseIncorrect) return Problem.Incorrect({ retryAfterSeconds: error.retryAfterSeconds })

    if (error instanceof BackoffActive) return Problem.Backoff({ retryAfterSeconds: error.retryAfterSeconds })

    return noticeOf(target)(error)
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

// A write sent once: an answer lost or not understood after sending may or may not have changed anything, so it
// reads as the CLI's "do not retry" (invariant 3).
const sentOnce = <A, E, R>(write: Effect.Effect<A, E | ServerUnreachable | UnexpectedResponse, R>) =>
  unverifiedOnTransport(write).pipe(Effect.catchTag("UnexpectedResponse", () => Effect.fail(new ChangeUnverified())))

const parsedName = (what: string, input: string) => Effect.fromResult(parseName(what, input))

// The Item form's one write, after the checks `hush item create` and `hush item edit` make before sending, in
// their order, each failing with the CLI's own error.
const saveItem = (target: Target, passphrase: Redacted.Redacted<string>, save: Save) =>
  ItemForm.Save.$match(save, {
    Create: ({ vault, title, kind, value, plain }) =>
      Effect.gen(function* () {
        const primary = Kind.primary(kind).label
        const names = { vault: yield* parsedName("vault", vault), title: yield* parsedName("title", title) }

        const fields = yield* Effect.forEach(plain, ({ label, text }) =>
          Create.plainField(kind, { label, value: text }),
        )

        const secret = yield* Effect.fromResult(
          PrivateInput.value(Redacted.value(value), { noun: `value for ${primary}`, outcome: "created" }),
        )

        const receipt = yield* sentOnce(
          Client.request(Api, target, (client) =>
            client.admin.itemsCreate({
              payload: { passphrase, ...names, kind, fields: [{ label: primary, value: secret }, ...fields] },
            }),
          ),
        )

        return Event.ItemCreated({ receipt })
      }),
    Edit: ({ vault, item, label, change }) =>
      Effect.gen(function* () {
        const field = yield* parsedName("field", label)
        const names = { vault: yield* parsedName("vault", vault), item: yield* parsedName("title", item.title) }

        const wire: ItemChange = ItemForm.Change.$is("Set")(change)
          ? {
              set: {
                label: field,
                value: yield* Effect.fromResult(
                  PrivateInput.value(Redacted.value(change.value), { noun: `value for ${field}`, outcome: "changed" }),
                ),
              },
            }
          : { remove: field }

        const receipt = yield* sentOnce(
          Client.request(Api, target, (client) =>
            client.admin.itemsEdit({ payload: { passphrase, ...names, change: wire } }),
          ),
        )

        return Event.ItemEdited({ receipt })
      }),
  })

// `clipboard` is the host clipboard the copy key writes to and the paste key reads from.
export const run = (target: Target, work: Work, clipboard: Clipboard): Effect.Effect<Event> => {
  const refused = noticeOf(target)

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
        Effect.catch((error) => Effect.succeed(Event.VaultRefused({ problem: refused(error) }))),
      ),
    DeleteVault: ({ passphrase, vault }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) => client.admin.vaultsDelete({ payload: { passphrase, vault } })),
      ).pipe(
        Effect.map(() => Event.VaultChanged()),
        Effect.catch((error) => Effect.succeed(Event.VaultRefused({ problem: refused(error) }))),
      ),
    RefreshVaults: ({ passphrase }) =>
      Client.request(Api, target, (client) => client.admin.vaultsList({ payload: { passphrase } })).pipe(
        Effect.map(({ vaults }) => Event.VaultsListed({ vaults })),
        Effect.catch((error) => Effect.succeed(Event.VaultRefused({ problem: refused(error) }))),
      ),
    CopyToken: ({ token }) => Effect.map(clipboard.write(token), (written) => Event.TokenCopied({ written })),
    After: ({ millis, event }) => Effect.as(Effect.sleep(millis), event),
    Reveal: ({ passphrase, reference, generation }) =>
      Client.request(Api, target, (client) => client.admin.itemsReveal({ payload: { passphrase, reference } })).pipe(
        Effect.map(({ value }) => Event.Revealed({ reference, generation, value })),
        Effect.catch((error) =>
          Effect.succeed(Event.RevealRefused({ reference, generation, problem: refused(error) })),
        ),
      ),
    SaveItem: ({ passphrase, save }) =>
      saveItem(target, passphrase, save).pipe(
        Effect.catch((error) => Effect.succeed(Event.ItemSaveRefused({ problem: refused(error) }))),
      ),
    ReadClipboard: () => Effect.map(clipboard.read, (pasted) => Event.ClipboardRead({ pasted })),
    // Writes, so a lost answer reads as unverified (invariant 3); refusals read as the CLI's `item` commands say.
    RenameItem: ({ passphrase, vault, item, newTitle }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) =>
          client.admin.itemsRename({ payload: { passphrase, vault, item, newTitle } }),
        ),
      ).pipe(
        Effect.map((receipt) => Event.Renamed({ receipt })),
        Effect.catch((error) => Effect.succeed(Event.ChangeRefused({ problem: refused(error) }))),
      ),
    DeleteItem: ({ passphrase, vault, item }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) => client.admin.itemsDelete({ payload: { passphrase, vault, item } })),
      ).pipe(
        Effect.map(() => Event.ItemsChanged({ vault })),
        Effect.catch((error) => Effect.succeed(Event.ChangeRefused({ problem: refused(error) }))),
      ),
    ReleaseTitle: ({ passphrase, vault, title }) =>
      unverifiedOnTransport(
        Client.request(Api, target, (client) => client.admin.itemsRelease({ payload: { passphrase, vault, title } })),
      ).pipe(
        Effect.map(() => Event.ItemsChanged({ vault })),
        Effect.catch((error) => Effect.succeed(Event.ChangeRefused({ problem: refused(error) }))),
      ),
  })
}

export * as Interpreter from "./Interpreter.js"
