import { assert, describe, it } from "@effect/vitest"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox, type Seeded } from "./sandbox.js"

// The request route through the seam: the test proxy stands in for an agent sandbox's
// loopback proxy, and its log shows which requests went through it.

const userinfo: Sentinel = { kind: "proxyUserinfo", text: "u:p" }

const withSeeded = async (test: (box: Sandbox, seeded: Seeded) => Promise<void>) => {
  const box = await sandbox()

  try {
    const seeded = await box.seed({ items: [{ kind: "api-credential", title: "Stripe", value: valueSentinel.text }] })
    await test(box, seeded)
    const token: Sentinel = { kind: "token", text: seeded.token }
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel, token, userinfo]), [])
  } finally {
    await box.close()
  }
}

const listItems = [{ method: "POST", path: "/v1/items/list", status: 200 }]

describe("request route", () => {
  it("sends requests through a loopback HTTP_PROXY, ignoring NO_PROXY for the Server", () =>
    withSeeded(async (box) => {
      const result = await box.run(["inventory"], { env: { HTTP_PROXY: box.proxy.url, NO_PROXY: "127.0.0.1" } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(result.calls, listItems)
      assert.deepStrictEqual(box.proxy.log(), [`POST ${box.server.url}/v1/items/list HTTP/1.1`])
    }))

  it("reads the lowercase http_proxy and no_proxy too", () =>
    withSeeded(async (box) => {
      const result = await box.run(["inventory"], { env: { http_proxy: box.proxy.url, no_proxy: "*" } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(box.proxy.log(), [`POST ${box.server.url}/v1/items/list HTTP/1.1`])
    }))

  it("goes direct with HUSH_PROXY=direct, leaving the proxy unused", () =>
    withSeeded(async (box) => {
      const result = await box.run(["inventory"], { env: { HTTP_PROXY: box.proxy.url, HUSH_PROXY: "direct" } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(result.calls, listItems)
      assert.deepStrictEqual(box.proxy.log(), [])
    }))

  it("goes direct after `config set proxy direct`, leaving the proxy unused", () =>
    withSeeded(async (box) => {
      const set = await box.run(["config", "set", "proxy", "direct"])
      assert.strictEqual(set.code, 0)
      const result = await box.run(["inventory"], { env: { HTTP_PROXY: box.proxy.url } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(result.calls, listItems)
      assert.deepStrictEqual(box.proxy.log(), [])
    }))

  it("never uses a proxy that is not on loopback", () =>
    withSeeded(async (box) => {
      const result = await box.run(["inventory"], { env: { HTTP_PROXY: "http://192.0.2.1:9" } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(result.calls, listItems)
    }))

  it("names the loopback proxy as host:port, never its userinfo, when it cannot be reached", () =>
    withSeeded(async (box) => {
      await box.server.stop()
      const result = await box.run(["status"], { env: { HTTP_PROXY: "http://u:p@127.0.0.1:1" } })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      const address = box.server.url.replace("http://", "")
      assert.strictEqual(
        result.stderr,
        `hush: Could not reach the hush Server at ${box.server.url} through the loopback proxy at 127.0.0.1:1 (refused); nothing was read or changed. Inside an agent sandbox, add \`${address}\` to its allowed domains; if that proxy is not a sandbox's, set HUSH_PROXY=direct, since it would otherwise receive Tokens in cleartext. \`hush doctor\` shows the route.\n`,
      )
    }))

  it("says a loopback proxy was disabled when a direct request fails", () =>
    withSeeded(async (box) => {
      await box.server.stop()
      const result = await box.run(["status"], { env: { HTTP_PROXY: box.proxy.url, HUSH_PROXY: "direct" } })
      assert.strictEqual(result.code, 1)
      assert.include(
        result.stderr,
        `directly (refused); nothing was read or changed. Check that it is running and that \`HUSH_SERVER\` or \`server\` in \`~/.config/hush/config.json\` points to it. A loopback HTTP_PROXY is set but HUSH_PROXY=direct (or config proxy: direct) disables it; inside an agent sandbox unset HUSH_PROXY`,
      )
    }))

  it("gives the child of `run` the original NO_PROXY and HTTP_PROXY under the proxy route", () =>
    withSeeded(async (box, seeded) => {
      const result = await box.run(
        [
          "run",
          "--env",
          `X=${seeded.references[0]}`,
          "--",
          "sh",
          "-c",
          `test "$NO_PROXY" = 127.0.0.1 && test "$no_proxy" = localhost && test "$HTTP_PROXY" = '${box.proxy.url}'`,
        ],
        { env: { HTTP_PROXY: box.proxy.url, NO_PROXY: "127.0.0.1", no_proxy: "localhost" } },
      )

      assert.strictEqual(result.stderr, "")
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(box.proxy.log(), [`POST ${box.server.url}/v1/secrets/resolve HTTP/1.1`])
    }))
})
