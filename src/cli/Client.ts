import { Duration, Effect, Option, type Redacted, Ref, Schema, type Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http"
import { HttpApiClient, type HttpApi, type HttpApiGroup } from "effect/http-api"

import { type BackupError, BackupRoute, PassphraseOnly } from "../shared/Api.js"
import { PlatformCause } from "../shared/PlatformCause.js"
import type { Token } from "../shared/Token.js"
import { RequestTooLarge, ServerUnreachable, UnexpectedResponse } from "./CliError.js"
import { Route } from "./Route.js"
import type { Target } from "./Target.js"

// The CLI's seam to the Server:the typed client of the shared Api over fetch, with the
// route applied. It never retries (invariant 3) and maps every failure that is not a declared Server error
// to a CLI error rendered from typed fields, so no response body reaches the user verbatim (invariant 2).

// To response headers;bodies are unbounded. The Server sends a backup's headers only after `VACUUM INTO`
// and hashing, which for hundreds of MB on slow storage can take minutes.
const defaultHeadersTimeout = Duration.seconds(30)
const backupHeadersTimeout = Duration.minutes(10)

// The cause of a TransportError raised when the response headers did not arrive in time.
const headersTimedOut = Symbol("hush/Client/headersTimedOut")

type TransportFailure = ServerUnreachable | UnexpectedResponse | RequestTooLarge

const fromHttpClientError =
  (target: Target) =>
  (error: HttpClientError.HttpClientError): Effect.Effect<never, TransportFailure> => {
    const { reason } = error
    const url = target.origin
    switch (reason._tag) {
      case "TransportError":
        return Effect.fail(
          new ServerUnreachable({
            url,
            address: Route.display(new URL(url)),
            route: Route.view(target.route),
            reason:
              reason.cause === headersTimedOut
                ? "timed out"
                : PlatformCause.code(reason.cause) === "ECONNREFUSED"
                  ? "refused"
                  : "other",
          }),
        )
      case "StatusCodeError":
      case "DecodeError":
      case "EmptyBodyError":
        return Effect.fail(
          reason.response.status === 413
            ? new RequestTooLarge()
            : new UnexpectedResponse({ url, status: reason.response.status }),
        )
      case "EncodeError":
      case "InvalidUrlError":
        // The request was never sent: a bug in the CLI, not a Server answer.
        return Effect.die(error)
    }
  }

const transport =
  (lastStatus: Ref.Ref<number | undefined>, token: Redacted.Redacted<Token> | undefined, timeout: Duration.Duration) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      // The Server's guard accepts exactly `application/json`, so every request sends it.
      HttpClient.mapRequest((request) =>
        request.method === "POST" ? HttpClientRequest.setHeader(request, "content-type", "application/json") : request,
      ),
      HttpClient.mapRequest((request) =>
        token === undefined ? request : HttpClientRequest.bearerToken(request, token),
      ),
      HttpClient.transform((response, request) =>
        Effect.timeoutOrElse(response, {
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause: headersTimedOut }),
              }),
            ),
        }),
      ),
      // A body that fails its schema surfaces as a SchemaError without the response, so its status is kept here.
      HttpClient.tap((response) => Ref.set(lastStatus, response.status)),
    )

// Runs one call of `api`'s typed client against `target`, sending `token` as the bearer credential when given.
// `headersTimeout` bounds the wait for the response headers.
export const request = <ApiId extends string, Groups extends HttpApiGroup.Constraint, A, E, R>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  target: Target,
  call: (
    client: HttpApiClient.Client<Groups>,
  ) => Effect.Effect<A, E | HttpClientError.HttpClientError | Schema.SchemaError, R>,
  token?: Redacted.Redacted<Token>,
  headersTimeout: Duration.Duration = defaultHeadersTimeout,
): Effect.Effect<
  A,
  Exclude<Exclude<E, HttpClientError.HttpClientError>, Schema.SchemaError> | TransportFailure,
  Exclude<R | HttpApiGroup.MiddlewareClient<Groups>, HttpClient.HttpClient>
> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => Route.apply(target.route))
    const lastStatus = yield* Ref.make<number | undefined>(undefined)
    const client = yield* HttpApiClient.make(api, {
      baseUrl: target.origin,
      transformClient: transport(lastStatus, token, headersTimeout),
    })
    return yield* call(client).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, Route.fetchInit(target.route)),
      Effect.catchIf(HttpClientError.isHttpClientError, fromHttpClientError(target)),
      Effect.catchIf(Schema.isSchemaError, (error) =>
        Effect.flatMap(Ref.get(lastStatus), (status) =>
          status === undefined
            ? // No response yet: the request payload failed to encode, a bug in the CLI.
              Effect.die(error)
            : Effect.fail(new UnexpectedResponse({ url: target.origin, status })),
        ),
      ),
    )
  }).pipe(Effect.provide(FetchHttpClient.layer))

// A backup as the Server announced it: the size and SHA-256 from its headers, and the body still to read.
export interface Download {
  readonly bytes: number
  readonly sha256: string
  readonly body: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>
}

const BytesHeader = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))
const Sha256Header = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

// The raw backup route:one POST with the Passphrase, 10 min to headers, then `receive` reads the body.
// An error answer is decoded as the route's JSON error; anything else unexpected is `UnexpectedResponse`.
export const backup = <A, E>(
  target: Target,
  passphrase: Redacted.Redacted<string>,
  receive: (download: Download) => Effect.Effect<A, E | HttpClientError.HttpClientError>,
): Effect.Effect<A, Exclude<E, HttpClientError.HttpClientError> | BackupError | TransportFailure> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => Route.apply(target.route))
    const client = transport(
      yield* Ref.make<number | undefined>(undefined),
      undefined,
      backupHeadersTimeout,
    )(yield* HttpClient.HttpClient)
    const body = yield* Schema.encodeEffect(PassphraseOnly)({ passphrase }).pipe(Effect.orDie)
    const response = yield* client.execute(
      HttpClientRequest.post(`${target.origin}${BackupRoute.path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    )
    const unexpected = new UnexpectedResponse({ url: target.origin, status: response.status })
    if (response.status === 413) return yield* new RequestTooLarge()
    if (response.status !== 200) {
      const declared = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(BackupRoute.error)),
        Effect.option,
      )
      return yield* Option.match(declared, { onNone: () => Effect.fail(unexpected), onSome: Effect.fail })
    }
    const bytes = Schema.decodeUnknownOption(BytesHeader)(response.headers[BackupRoute.headers.bytes])
    const sha256 = Schema.decodeUnknownOption(Sha256Header)(response.headers[BackupRoute.headers.sha256])
    if (Option.isNone(bytes) || Option.isNone(sha256)) return yield* unexpected
    return yield* receive({ bytes: bytes.value, sha256: sha256.value, body: response.stream })
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, Route.fetchInit(target.route)),
    Effect.catchIf(
      (error): error is HttpClientError.HttpClientError => HttpClientError.isHttpClientError(error),
      fromHttpClientError(target),
    ),
    Effect.provide(FetchHttpClient.layer),
  )

export * as Client from "./Client.js"
