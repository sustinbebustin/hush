import { assert, describe, it } from "@effect/vitest"
import { Redacted } from "effect"

import { Route } from "../src/cli/Route.js"

// What a route shows and where it sends requests, without the redacted proxy URL.
const view = (route: Route) => {
  switch (route._tag) {
    case "Direct":
      return route.unused === "none" ? { direct: "none" } : { direct: route.unused, display: route.proxyDisplay }
    case "Proxy":
      return { proxy: Redacted.value(route.proxy).href, display: route.proxyDisplay }
  }
}

describe("Route.select", () => {
  it("goes direct with nothing unused when no proxy is set", () => {
    assert.deepStrictEqual(view(Route.select("auto", {})), { direct: "none" })
    assert.deepStrictEqual(view(Route.select("direct", {})), { direct: "none" })
    assert.deepStrictEqual(view(Route.select("auto", { HTTP_PROXY: "" })), { direct: "none" })
  })

  for (const [proxy, display] of [
    ["http://127.0.0.1:3128", "127.0.0.1:3128"],
    ["http://127.9.8.7:1", "127.9.8.7:1"],
    ["http://localhost:8080", "localhost:8080"],
    ["http://LOCALHOST:8080", "localhost:8080"],
    ["http://[::1]:9000", "[::1]:9000"],
    ["http://127.0.0.1", "127.0.0.1:80"],
  ] as const) {
    it(`uses the loopback proxy ${proxy} in mode auto, shown as ${display}`, () => {
      assert.deepStrictEqual(view(Route.select("auto", { HTTP_PROXY: proxy })), {
        proxy: new URL(proxy).href,
        display,
      })
    })

    it(`goes direct with ${proxy} disabled in mode direct`, () => {
      assert.deepStrictEqual(view(Route.select("direct", { HTTP_PROXY: proxy })), { direct: "disabled", display })
    })
  }

  for (const proxy of [
    "http://192.0.2.1:9",
    "http://128.0.0.1:9",
    "http://localhost.example:9",
    "http://10.0.0.1:3128",
  ])
    it(`never uses the non-loopback proxy ${proxy}`, () => {
      for (const mode of ["auto", "direct"] as const)
        assert.deepStrictEqual(view(Route.select(mode, { HTTP_PROXY: proxy })), {
          direct: "not-loopback",
          display: new URL(proxy).host,
        })
    })

  it("treats a proxy that is not a URL as not loopback, with nothing to display", () => {
    assert.deepStrictEqual(view(Route.select("auto", { HTTP_PROXY: "not a url" })), {
      direct: "not-loopback",
      display: undefined,
    })
  })

  it("reads http_proxy when HTTP_PROXY is unset, and prefers HTTP_PROXY", () => {
    assert.deepStrictEqual(view(Route.select("auto", { http_proxy: "http://127.0.0.1:1" })), {
      proxy: "http://127.0.0.1:1/",
      display: "127.0.0.1:1",
    })
    assert.deepStrictEqual(
      view(Route.select("auto", { HTTP_PROXY: "http://192.0.2.1:9", http_proxy: "http://127.0.0.1:1" })),
      { direct: "not-loopback", display: "192.0.2.1:9" },
    )
  })

  it("keeps the userinfo for fetch but never in the display form", () => {
    const route = Route.select("auto", { HTTP_PROXY: "http://u:p@127.0.0.1:1" })
    assert.deepStrictEqual(view(route), { proxy: "http://u:p@127.0.0.1:1/", display: "127.0.0.1:1" })
    assert.notInclude(JSON.stringify(route), "u:p")
    for (const mode of ["direct", "auto"] as const)
      for (const proxy of ["http://u:p@127.0.0.1:1", "http://u:p@192.0.2.1:9"])
        assert.notInclude(JSON.stringify(Route.select(mode, { HTTP_PROXY: proxy })), "u:p")
  })
})
