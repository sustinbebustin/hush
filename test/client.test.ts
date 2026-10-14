import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

import { Client } from "../src/cli/Client.js"
import { ServerUnreachable, UnexpectedResponse } from "../src/cli/CliError.js"
import { Route, UnusedProxy } from "../src/cli/Route.js"
import type { Target } from "../src/cli/Target.js"
import { Api } from "../src/shared/Api.js"
import { HostNotAllowed } from "../src/shared/ApiError.js"

// A one-endpoint Api with a JSON body, so the client's POST handling is exercised before the real POST endpoints
// exist; the stub Server stands in for Bun's own answers.
class Echo extends HttpApiGroup.make("echo").add(
  HttpApiEndpoint.post("echo", "/v1/echo", {
    payload: Schema.Struct({ text: Schema.String }),
    success: Schema.Struct({ ok: Schema.Boolean }),
  }),
) {}

class TestApi extends HttpApi.make("test").add(Echo) {}

const direct = Route.Direct({ unused: UnusedProxy.None() })

const withStub = <A, E>(
  respond: (request: Request) => Response | Promise<Response>,
  test: (target: Target) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond })),
    (stub) => test({ origin: `http://127.0.0.1:${stub.port}`, source: "env", route: direct }),
    (stub) => Effect.promise(() => stub.stop(true)),
  )

const echo = (target: Target) =>
  Client.request(TestApi, target, (client) => client.echo.echo({ payload: { text: "hi" } }))

describe("Client.request", () => {
  it.effect("sends a POST body with exactly Content-Type: application/json", () => {
    const seen: Array<string | null> = []

    return withStub(
      (request) => {
        seen.push(request.headers.get("content-type"))

        return Response.json({ ok: true })
      },
      (target) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* echo(target), { ok: true })
          assert.deepStrictEqual(seen, ["application/json"])
        }),
    )
  })

  it.effect("maps Bun's empty 413 to RequestTooLarge", () =>
    withStub(
      () => new Response(null, { status: 413 }),
      (target) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(echo(target))
          assert.strictEqual(error._tag, "RequestTooLarge")
        }),
    ),
  )

  it.effect("maps an empty 400 to UnexpectedResponse with its status, and sends the request once", () => {
    let requests = 0

    return withStub(
      () => {
        requests += 1

        return new Response(null, { status: 400 })
      },
      (target) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(echo(target))
          assert.deepStrictEqual(error, new UnexpectedResponse({ url: target.origin, status: 400 }))
          assert.strictEqual(requests, 1)
        }),
    )
  })

  it.effect("decodes a guard refusal on any endpoint of the real Api, status included", () =>
    withStub(
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      () => Response.json({ _tag: "HostNotAllowed", host: "evil.test" }, { status: 403 }),
      (target) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Client.request(Api, target, (client) => client.public.status()))
          assert.deepStrictEqual(error, new HostNotAllowed({ host: "evil.test" }))
        }),
    ),
  )

  it.effect("maps a refused connection to ServerUnreachable (refused)", () =>
    Effect.gen(function* () {
      const target: Target = { origin: "http://127.0.0.1:1", source: "env", route: direct }
      const error = yield* Effect.flip(echo(target))
      assert.deepStrictEqual(
        error,
        new ServerUnreachable({
          url: target.origin,
          address: "127.0.0.1:1",
          route: Route.view(direct),
          reason: "refused",
        }),
      )
    }),
  )
})
