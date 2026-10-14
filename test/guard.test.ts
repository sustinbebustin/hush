import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"

import { Guard } from "../src/server/Guard.js"
import type { ServerState } from "../src/server/ServerState.js"
import { passphraseSentinel, scan, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

const ready: ServerState = { _tag: "Ready" }
const uninitialised: ServerState = {
  _tag: "Uninitialised",
  initCodeDigest: new Uint8Array(32),
  initCodeFile: "/var/lib/hush/init-code",
}

const json = { host: "127.0.0.1:7787", "content-type": "application/json" }

const refusal = (
  request: Partial<Guard.GuardRequest>,
  { allowedHosts = [], state = ready }: { allowedHosts?: ReadonlyArray<string>; state?: ServerState } = {},
) => {
  const result = Guard.check(
    { method: "POST", url: "/v1/secrets/resolve", headers: json, ...request },
    allowedHosts,
    state,
  )
  return Result.isFailure(result) ? result.failure : undefined
}

describe("Guard.check", () => {
  it("passes a JSON POST addressed by IP literal, with or without a port", () => {
    for (const host of ["127.0.0.1:7787", "127.0.0.1", "100.84.135.127:7787", "[::1]:7787", "[::1]", "0.0.0.0:1"])
      assert.isUndefined(refusal({ headers: { ...json, host } }), host)
  })

  it("passes localhost in any case, and an allowed host matched without its port", () => {
    for (const host of ["localhost:7787", "LocalHost", "dev.tail1234.ts.net:443", "DEV.tail1234.ts.net"])
      assert.isUndefined(refusal({ headers: { ...json, host } }, { allowedHosts: ["dev.tail1234.ts.net"] }), host)
  })

  it("refuses a missing Host or one that is not an IP literal, localhost or an allowed host with HostNotAllowed", () => {
    assert.deepStrictEqual(refusal({ headers: { "content-type": "application/json" } })?._tag, "HostNotAllowed")
    for (const host of [
      "evil.test",
      "evil.test:7787",
      "localhost.evil.test",
      "127.0.0.1.evil.test",
      "::1",
      "[evil.test]:1",
      "127.0.0.1:port",
      "127.0.0.1:",
      "",
    ]) {
      const error = refusal({ headers: { ...json, host } })
      assert.deepStrictEqual(error?._tag === "HostNotAllowed" ? error.host : error, host, host)
    }
    const missing = refusal({ headers: {} })
    assert.deepStrictEqual(missing?._tag === "HostNotAllowed" ? missing.host : missing, null)
  })

  it("refuses any Tailscale-Funnel-Request header with FunnelRequestRefused", () => {
    assert.strictEqual(
      refusal({ headers: { ...json, "tailscale-funnel-request": "?1" } })?._tag,
      "FunnelRequestRefused",
    )
    assert.strictEqual(refusal({ headers: { ...json, "tailscale-funnel-request": "" } })?._tag, "FunnelRequestRefused")
  })

  it("refuses any Origin, GET included, with BrowserRequestRefused", () => {
    for (const origin of ["http://127.0.0.1:7787", "null", ""])
      assert.strictEqual(refusal({ headers: { ...json, origin } })?._tag, "BrowserRequestRefused", origin)
    assert.strictEqual(
      refusal({ method: "GET", url: "/v1/status", headers: { host: "127.0.0.1", origin: "null" } })?._tag,
      "BrowserRequestRefused",
    )
  })

  it("refuses a POST whose trimmed, lowercased media type is not exactly application/json", () => {
    for (const contentType of [" Application/JSON ", "application/json"])
      assert.isUndefined(refusal({ headers: { ...json, "content-type": contentType } }), contentType)
    for (const contentType of ["application/json; charset=utf-8", "text/plain", "application/jsonx", ""]) {
      const error = refusal({ headers: { ...json, "content-type": contentType } })
      assert.deepStrictEqual(error?._tag === "UnsupportedContentType" ? error.received : error, contentType)
    }
    const missing = refusal({ headers: { host: "127.0.0.1" } })
    assert.deepStrictEqual(missing?._tag === "UnsupportedContentType" ? missing.received : missing, null)
  })

  it("does not ask a GET for a media type", () => {
    assert.isUndefined(refusal({ method: "GET", url: "/v1/status", headers: { host: "127.0.0.1" } }))
  })

  it("lets an Uninitialised Server serve only status and admin/init", () => {
    assert.strictEqual(refusal({}, { state: uninitialised })?._tag, "NotInitialised")
    assert.strictEqual(refusal({ url: "/v1/nope?x=1" }, { state: uninitialised })?._tag, "NotInitialised")
    assert.isUndefined(refusal({ url: "/v1/admin/init" }, { state: uninitialised }))
    assert.isUndefined(refusal({ method: "GET", url: "/v1/status?x" }, { state: uninitialised }))
  })

  it("answers the first failing check, in the order Host, Funnel, Origin, media type, gate", () => {
    const everything = {
      host: "evil.test",
      "tailscale-funnel-request": "?1",
      origin: "null",
      "content-type": "text/plain",
    }
    const options = { state: uninitialised }
    assert.strictEqual(refusal({ headers: everything }, options)?._tag, "HostNotAllowed")
    assert.strictEqual(refusal({ headers: { host: "evil.test", origin: "null" } })?._tag, "HostNotAllowed")
    const fromIp = { ...everything, host: "127.0.0.1" }
    assert.strictEqual(refusal({ headers: fromIp }, options)?._tag, "FunnelRequestRefused")
    const { "tailscale-funnel-request": _funnel, ...noFunnel } = fromIp
    assert.strictEqual(refusal({ headers: noFunnel }, options)?._tag, "BrowserRequestRefused")
    const { origin: _origin, ...noOrigin } = noFunnel
    assert.strictEqual(refusal({ headers: noOrigin }, options)?._tag, "UnsupportedContentType")
    assert.strictEqual(refusal({ headers: json }, options)?._tag, "NotInitialised")
  })
})

const withSandbox = async (test: (box: Sandbox) => Promise<void>) => {
  const box = await sandbox()
  try {
    await test(box)
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel]), [])
  } finally {
    await box.close()
  }
}

const auditCount = (box: Sandbox) => box.inspect((db) => db.query("SELECT count(*) AS count FROM audit").get())

// A Token request that passes every guard check unless `headers` override one.
const resolve = (box: Sandbox, token: string, reference: string, headers: Record<string, string> = {}) =>
  box.fetch("/v1/secrets/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ references: [reference] }),
  })

const corsHeaders = (response: Response) =>
  [...response.headers.keys()].filter((name) => name.startsWith("access-control-"))

describe("the guard on a running Server", () => {
  it("refuses Origin, a foreign Host, the Funnel header and non-JSON POSTs before the handler, unaudited", () =>
    withSandbox(async (box) => {
      const { token, references } = await box.seed({
        items: [{ kind: "api-credential", title: "Example", value: valueSentinel.text }],
      })
      const reference = references[0] ?? ""
      const before = await auditCount(box)
      const cases: ReadonlyArray<readonly [Record<string, string>, number, unknown]> = [
        [{ origin: "http://127.0.0.1:1" }, 403, { _tag: "BrowserRequestRefused" }],
        [{ host: "evil.test" }, 403, { _tag: "HostNotAllowed", host: "evil.test" }],
        [{ host: "evil.test", origin: "null" }, 403, { _tag: "HostNotAllowed", host: "evil.test" }],
        [{ "tailscale-funnel-request": "?1" }, 403, { _tag: "FunnelRequestRefused" }],
        [{ "content-type": "text/plain" }, 415, { _tag: "UnsupportedContentType", received: "text/plain" }],
        [
          { "content-type": "application/json; charset=utf-8" },
          415,
          { _tag: "UnsupportedContentType", received: "application/json; charset=utf-8" },
        ],
      ]
      for (const [headers, status, body] of cases) {
        const response = await resolve(box, token, reference, headers)
        assert.strictEqual(response.status, status, JSON.stringify(headers))
        assert.deepStrictEqual(await response.json(), body)
        assert.deepStrictEqual(corsHeaders(response), [])
      }
      const untyped = await box.fetch("/v1/secrets/resolve", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ references: [reference] }),
      })
      assert.strictEqual(untyped.status, 415)
      assert.deepStrictEqual(await untyped.json(), { _tag: "UnsupportedContentType", received: null })
      assert.deepStrictEqual(await auditCount(box), before)
      // The request log holds method, path and status only for every refusal.
      const refused = (await box.calls()).filter(({ status }) => status === 403 || status === 415)
      assert.strictEqual(refused.length, cases.length + 1)
      for (const call of refused) assert.deepStrictEqual(call.path, "/v1/secrets/resolve")
    }))

  it("runs for unknown routes too", () =>
    withSandbox(async (box) => {
      const response = await box.fetch("/nope", { headers: { host: "evil.test" } })
      assert.strictEqual(response.status, 403)
      assert.deepStrictEqual(await response.json(), { _tag: "HostNotAllowed", host: "evil.test" })
    }))

  it("sends no CORS headers on status", () =>
    withSandbox(async (box) => {
      const response = await box.fetch("/v1/status")
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(corsHeaders(response), [])
    }))

  it("answers a body over 1 MiB with Bun's empty 413 before the guard", () =>
    withSandbox(async (box) => {
      for (const host of ["127.0.0.1", "evil.test"]) {
        const response = await box.fetch("/v1/admin/init", {
          method: "POST",
          headers: { "content-type": "application/json", host },
          body: "x".repeat(1_048_577),
        })
        assert.strictEqual(response.status, 413, host)
        assert.strictEqual(await response.text(), "")
      }
      const exact = await box.fetch("/v1/admin/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(1_048_576),
      })
      assert.strictEqual(exact.status, 400)
    }))
})
