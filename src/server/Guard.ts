import { Effect, Ref, Result, Schema } from "effect"
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http"
import { isIP } from "node:net"

import {
  BrowserRequestRefused,
  FunnelRequestRefused,
  guardErrors,
  HostNotAllowed,
  httpStatus,
  NotInitialised,
  UnsupportedContentType,
} from "../shared/ApiError.js"
import { ServerState } from "./ServerState.js"

// The request guard, run on every listener before routing, body decoding and Token auth, so it also covers unknown
// routes. Its refusals are never audited or counted against the Passphrase backoff, so refused traffic cannot fill
// the Audit Log or delay the Owner. It reads headers only: never the peer address or a forwarded header, which
// container networking and proxies make meaningless.

// What the guard reads of a request; header names are lowercase, as Effect gives them.
export interface GuardRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
}

// Every error the guard answers with: its own refusals, then the Uninitialised gate's.
const refusals = [...guardErrors, NotInitialised] as const
const Refusal = Schema.Union(refusals)

export type Refusal = typeof Refusal.Type

// The only paths an Uninitialised Server serves; every other path is refused until Init.
const ungated: ReadonlySet<string> = new Set(["/v1/status", "/v1/admin/init"])

// The request target without its query or fragment.
export const pathOf = (url: string) => url.split(/[?#]/, 1)[0] ?? url

// `[v6]` or `name`, optionally followed by `:<port>`.
const hostPattern = /^(?:\[([^\]]*)\]|([^:[\]]*))(?::\d{1,5})?$/

// An IP literal, `localhost` or an allowed host, matched without the port. `allowedHosts` are
// lowercase already.
const hostAllowed = (host: string, allowedHosts: ReadonlyArray<string>): boolean => {
  const match = hostPattern.exec(host)

  if (match === null) return false
  const [, bracketed, name] = match

  if (bracketed !== undefined) return isIP(bracketed) === 6

  if (name === undefined || name === "") return false
  const lowered = name.toLowerCase()

  return isIP(name) === 4 || lowered === "localhost" || allowedHosts.includes(lowered)
}

// The checks in order (Host, Funnel, Origin, media type, Uninitialised gate), so a request failing several gets
// the first one's error.
export const check = (
  request: GuardRequest,
  allowedHosts: ReadonlyArray<string>,
  state: ServerState,
): Result.Result<void, Refusal> => {
  const { host, origin } = request.headers

  if (host === undefined || !hostAllowed(host, allowedHosts))
    return Result.fail(new HostNotAllowed({ host: host ?? null }))

  if (request.headers["tailscale-funnel-request"] !== undefined) return Result.fail(new FunnelRequestRefused())

  if (origin !== undefined) return Result.fail(new BrowserRequestRefused())
  const contentType = request.headers["content-type"]

  if (request.method === "POST" && contentType?.trim().toLowerCase() !== "application/json")
    return Result.fail(new UnsupportedContentType({ received: contentType ?? null }))

  if (ServerState.$is("Uninitialised")(state) && !ungated.has(pathOf(request.url)))
    return Result.fail(new NotInitialised())

  return Result.void
}

// The body and status the typed client decodes for a declared error.
const refusal = (error: Refusal) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeSync(Refusal)(error), { status: httpStatus(error) })

export const middleware = (allowedHosts: ReadonlyArray<string>) =>
  HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const state = yield* Ref.get(yield* ServerState.Current)

      return yield* Result.match(check(request, allowedHosts, state), {
        onFailure: (error) => Effect.succeed(refusal(error)),
        onSuccess: () => app,
      })
    }),
  )

export * as Guard from "./Guard.js"
