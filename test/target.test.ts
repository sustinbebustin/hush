import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"

import type { Config } from "../src/cli/Config.js"
import { Route } from "../src/cli/Route.js"
import { Target } from "../src/cli/Target.js"

const path = "/home/me/.config/hush/config.json"
const noFile: Config.Loaded = { path, file: {} }
const withFile = (file: Config.File): Config.Loaded => ({ path, file })

const failure = (env: Record<string, string>, config: Config.Loaded = noFile) => {
  const result = Target.resolve(env, config)

  return Result.isFailure(result) ? result.failure : undefined
}

const reason = (env: Record<string, string>, config?: Config.Loaded) => {
  const error = failure(env, config)

  return error?._tag === "ServerUrlInvalid" ? error.reason : undefined
}

const problemOf = (env: Record<string, string>, config?: Config.Loaded) => {
  const error = failure(env, config)

  return error?._tag === "ConfigInvalid" ? error.problem : error
}

const direct = { _tag: "Direct", unused: "none" } as const

describe("Target.resolve", () => {
  it("defaults to the loopback Server on port 7787, direct", () => {
    assert.deepStrictEqual(
      Target.resolve({}, noFile),
      Result.succeed({ origin: "http://127.0.0.1:7787", source: "default", route: direct }),
    )
  })

  it("takes HUSH_SERVER as an origin, before the config file", () => {
    assert.deepStrictEqual(
      Target.resolve({ HUSH_SERVER: "http://100.64.0.7:7787/" }, withFile({ server: "http://100.64.0.8:7787" })),
      Result.succeed({ origin: "http://100.64.0.7:7787", source: "env", route: direct }),
    )
  })

  it("takes the config file's server when HUSH_SERVER is unset or empty", () => {
    for (const env of [{}, { HUSH_SERVER: "" }])
      assert.deepStrictEqual(
        Target.resolve(env, withFile({ server: "http://100.64.0.8:7787" })),
        Result.succeed({ origin: "http://100.64.0.8:7787", source: "config", route: direct }),
      )
  })

  it("refuses a HUSH_SERVER that is not an http origin", () => {
    assert.strictEqual(reason({ HUSH_SERVER: "https://127.0.0.1:7787" }), "only http: is supported")
    assert.strictEqual(reason({ HUSH_SERVER: "127.0.0.1:7787" }), "not a URL")
    assert.strictEqual(reason({ HUSH_SERVER: "not a url" }), "not a URL")
    assert.strictEqual(reason({ HUSH_SERVER: "http://u:p@127.0.0.1:7787" }), "it must not hold a user or password")
    assert.strictEqual(reason({ HUSH_SERVER: "http://127.0.0.1:7787/v1" }), "only a host and port are allowed")
    assert.strictEqual(reason({ HUSH_SERVER: "http://127.0.0.1:7787/?a=1" }), "only a host and port are allowed")
    assert.strictEqual(reason({ HUSH_SERVER: "http://127.0.0.1:7787/#x" }), "only a host and port are allowed")
    assert.deepStrictEqual(failure({ HUSH_SERVER: "ftp://x" })?._tag, "ServerUrlInvalid")
  })

  it("names the config file when its server is invalid", () => {
    const error = failure({}, withFile({ server: "http://127.0.0.1:7787/path" }))
    assert.deepStrictEqual(
      error?._tag === "ServerUrlInvalid" ? { source: error.source, reason: error.reason } : error,
      { source: { from: "config", path }, reason: "only a host and port are allowed" },
    )
  })

  it("takes the proxy mode from HUSH_PROXY, then the config file, then auto", () => {
    const proxy = { HTTP_PROXY: "http://127.0.0.1:3128" }

    const routeOf = (env: Record<string, string>, config: Config.Loaded = noFile) => {
      const result = Target.resolve({ ...proxy, ...env }, config)

      return Result.isSuccess(result) ? Route.view(result.success.route) : undefined
    }

    assert.deepStrictEqual(routeOf({}), { _tag: "Proxy", proxy: "127.0.0.1:3128" })
    assert.deepStrictEqual(routeOf({ HUSH_PROXY: "direct" }), { _tag: "Direct", unused: "disabled" })
    assert.deepStrictEqual(routeOf({}, withFile({ proxy: "direct" })), { _tag: "Direct", unused: "disabled" })
    assert.deepStrictEqual(routeOf({ HUSH_PROXY: "auto" }, withFile({ proxy: "direct" })), {
      _tag: "Proxy",
      proxy: "127.0.0.1:3128",
    })
  })

  it("refuses a proxy mode other than auto or direct, naming where it came from", () => {
    assert.deepStrictEqual(problemOf({ HUSH_PROXY: "env" }), { reason: "proxy-mode", source: { from: "env" } })
    assert.deepStrictEqual(problemOf({}, withFile({ proxy: "off" })), {
      reason: "proxy-mode",
      source: { from: "config", path },
    })
  })
})
