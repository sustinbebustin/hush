import { Effect, Exit, Layer, Option, Ref, Schema } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, type HttpApiGroup } from "effect/http-api"
import { SqlClient } from "effect/sql"

import {
  Api,
  type BackupError,
  BackupRoute,
  CurrentToken,
  PassphraseOnly,
  TokenAuth,
  type TokenGroup,
} from "../shared/Api.js"
import { httpStatus } from "../shared/ApiError.js"
import { Version } from "../shared/Version.js"
import { Audit } from "./Audit.js"
import { AuditLog } from "./AuditLog.js"
import { Backup } from "./Backup.js"
import { Guard } from "./Guard.js"
import { Init } from "./Init.js"
import { ItemAdmin } from "./ItemAdmin.js"
import { Items } from "./Items.js"
import { Keys } from "./Keys.js"
import { Log } from "./Log.js"
import { Passphrase } from "./Passphrase.js"
import { ServerState } from "./ServerState.js"
import { Tokens } from "./Tokens.js"
import { Vaults } from "./Vaults.js"

// The HTTP side of the Server: handlers per group, the guard and the request log.

const PublicLive = HttpApiBuilder.group(Api, "public", (handlers) =>
  handlers.handle("status", () =>
    Effect.gen(function* () {
      const state = yield* Ref.get(yield* ServerState.Current)

      return { state: ServerState.wire(state), version: Version.current, api: Version.api }
    }),
  ),
)

// An admin handler: the operation called with the decoded payload and the peer its audit row names.
const withPeer =
  <P, A, E, R>(operation: (payload: P, peer: string | null) => Effect.Effect<A, E, R>) =>
  ({ payload }: { readonly payload: P }) =>
    Effect.flatMap(Audit.peer, (peer) => operation(payload, peer))

const AdminLive = HttpApiBuilder.group(Api, "admin", (handlers) =>
  handlers
    .handle("init", withPeer(Init.run))
    .handle("passphraseChange", withPeer(Passphrase.change))
    .handle("vaultsCreate", withPeer(Vaults.create))
    .handle("vaultsList", withPeer(Vaults.list))
    .handle("vaultsDelete", withPeer(Vaults.remove))
    .handle("tokensIssue", withPeer(Tokens.issue))
    .handle("tokensList", withPeer(Tokens.list))
    .handle("tokensRevoke", withPeer(Tokens.revoke))
    .handle("itemsList", withPeer(ItemAdmin.list))
    .handle("itemsEdit", withPeer(ItemAdmin.edit))
    .handle("itemsRename", withPeer(ItemAdmin.rename))
    .handle("itemsDelete", withPeer(ItemAdmin.remove))
    .handle("itemsRelease", withPeer(ItemAdmin.releaseTitle))
    .handle("itemsReveal", withPeer(ItemAdmin.reveal))
    .handle("audit", withPeer(AuditLog.read)),
)

const TokenLive = HttpApiBuilder.group(Api, "token", (handlers) =>
  handlers
    .handle("resolve", ({ payload }) =>
      Effect.all([CurrentToken, Audit.peer]).pipe(
        Effect.flatMap(([token, peer]) => Items.resolve(token, payload, peer)),
      ),
    )
    .handle("create", ({ payload }) =>
      Effect.all([CurrentToken, Audit.peer]).pipe(
        Effect.flatMap(([token, peer]) => Items.create(token, payload, peer)),
      ),
    )
    .handle("list", ({ payload }) =>
      Effect.all([CurrentToken, Audit.peer]).pipe(Effect.flatMap(([token, peer]) => Items.list(token, payload, peer))),
    )
    .handle("describe", () =>
      Effect.all([CurrentToken, Audit.peer]).pipe(Effect.flatMap(([token, peer]) => Tokens.describe(token, peer))),
    ),
)

type TokenEndpoint = HttpApiGroup.Endpoints<typeof TokenGroup>["identifier"]

// The audit Action of each endpoint of the `token` group, for the rows `TokenAuth` writes itself. Keyed by the
// group's endpoints, so an endpoint added without an Action does not compile.
const tokenActions = {
  resolve: "secrets.resolve",
  create: "items.create",
  list: "items.list",
  describe: "token.describe",
} as const satisfies { readonly [Endpoint in TokenEndpoint]: Audit.Action }

const isTokenEndpoint = (identifier: string): identifier is TokenEndpoint => Object.hasOwn(tokenActions, identifier)

// `TokenAuth`: runs before the payload is decoded, and provides the Token to the handler.
const TokenAuthLive = Layer.effect(
  TokenAuth,
  Effect.gen(function* () {
    const context = yield* Effect.context<SqlClient.SqlClient>()

    return {
      bearer: (handler, { credential, endpoint }) =>
        Effect.gen(function* () {
          // `TokenAuth` is attached to the `token` group only, so any other endpoint here is a wiring bug.
          if (!isTokenEndpoint(endpoint.identifier))
            return yield* Effect.die(new Error(`TokenAuth ran for endpoint ${endpoint.identifier}`))
          const action = tokenActions[endpoint.identifier]
          const peer = yield* Audit.peer
          const token = yield* Tokens.authenticate(credential, action, peer).pipe(Effect.provideContext(context))

          return yield* Effect.provideService(handler, CurrentToken, token)
        }),
    }
  }),
)

// One log line per request with the method, path and status only: never a header, query or
// body, which may hold a Token, the Passphrase or a value.
const requestLog = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const exit = yield* Effect.exit(app)

    const status = Exit.isSuccess(exit)
      ? exit.value.status
      : HttpServerError.causeResponseStripped(exit.cause)[0].status

    yield* Log.write({ event: "request", method: request.method, path: Guard.pathOf(request.url), status })

    return yield* exit
  }),
)

const backupError = (error: BackupError) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeSync(BackupRoute.error)(error), { status: httpStatus(error) })

// The raw backup route (its answer is an `application/octet-stream` body, not JSON), registered on the same
// router as the `HttpApi` and so behind the same guard and request log. The Passphrase is checked as for every
// admin endpoint; the snapshot is taken outside a transaction (SQLite refuses `VACUUM` inside one), then audited.
// The request scope stays open while the body streams and is closed when it ends, so the snapshot is deleted after
// its last byte or when the client goes away.
const backupRoute = (stateDir: string) =>
  HttpRouter.add("POST", BackupRoute.path, (request) =>
    Effect.gen(function* () {
      const payload = yield* Effect.flatMap(request.json, Schema.decodeUnknownEffect(PassphraseOnly)).pipe(
        Effect.option,
      )

      // Undecodable, as the `HttpApi` answers a malformed body.
      if (Option.isNone(payload)) return HttpServerResponse.empty({ status: 400 })

      const snapshot = yield* Passphrase.audited({
        passphrase: payload.value.passphrase,
        action: "backup",
        peer: yield* Audit.peer,
        scope: { vaults: [] },
        exclusive: false,
        checkpoint: false,
        outsideTransaction: true,
        unlock: Keys.fromPassphrase,
        operation: () => Backup.snapshot(stateDir).pipe(Effect.orDie),
      })

      return HttpServerResponse.stream(Backup.bytes(snapshot), {
        contentType: "application/octet-stream",
        contentLength: snapshot.bytes,
        headers: { [BackupRoute.headers.bytes]: String(snapshot.bytes), [BackupRoute.headers.sha256]: snapshot.sha256 },
      })
    }).pipe(Effect.catch((error) => Effect.succeed(backupError(error)))),
  )

const routes = (stateDir: string) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(Api).pipe(Layer.provide([PublicLive, AdminLive, TokenLive]), Layer.provide(TokenAuthLive)),
    backupRoute(stateDir),
  )

// The routes of one listener behind the guard; the caller provides `HttpServer` and the shared services.
export const app = (config: { readonly allowedHosts: ReadonlyArray<string>; readonly stateDir: string }) =>
  HttpRouter.serve(routes(config.stateDir), {
    disableLogger: true,
    disableListenLog: true,
    // The log is outermost so that it records the guard's refusals too.
    middleware: (handler) => requestLog(Guard.middleware(config.allowedHosts)(handler)),
  })

export * as Http from "./Http.js"
