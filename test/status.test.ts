import { assert, describe, it } from "@effect/vitest"

import packageJson from "../package.json" with { type: "json" }
import { scan, valueSentinel, passphraseSentinel } from "./leaks.js"
import { cli, sandbox, type Sandbox } from "./sandbox.js"

const withSandbox = async (test: (box: Sandbox) => Promise<void>) => {
  const box = await sandbox()
  try {
    await test(box)
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel]), [])
  } finally {
    await box.close()
  }
}

describe("hush status", () => {
  it("reports a fresh Server as uninitialised with one status request", () =>
    withSandbox(async (box) => {
      const result = await box.run(["status"])
      assert.strictEqual(result.code, 0)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        server: box.server.url,
        state: "uninitialised",
        serverVersion: packageJson.version,
        cliVersion: packageJson.version,
        api: 1,
      })
      assert.deepStrictEqual(result.calls, [{ method: "GET", path: "/v1/status", status: 200 }])
    }))

  it("reports ready once a meta row exists, after a restart that needs no human step", () =>
    withSandbox(async (box) => {
      await box.inspect((db) =>
        db.run(
          `INSERT INTO meta VALUES (1, 1, 1, 65536, 3, 4, zeroblob(16), zeroblob(12), zeroblob(48), 'now', 'now')`,
        ),
      )
      await box.server.restart()
      const result = await box.run(["status"])
      assert.strictEqual(result.code, 0)
      assert.strictEqual(JSON.parse(result.stdout).state, "ready")
      assert.strictEqual(JSON.parse(result.stdout).server, box.server.url)
    }))

  it("fails ServerUnreachable with exit 1 when the Server does not answer", () =>
    withSandbox(async (box) => {
      await box.server.stop()
      const result = await box.run(["status"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        `hush: Could not reach the hush Server at ${box.server.url} directly (refused); nothing was read or changed. Check that it is running and that \`HUSH_SERVER\` or \`server\` in \`~/.config/hush/config.json\` points to it. \`hush doctor\` shows the route.\n`,
      )
    }))

  for (const [answer, response] of [
    ["an empty 500", () => new Response(null, { status: 500 })],
    ["a non-JSON 200", () => new Response("<html>not hush</html>", { status: 200 })],
    ["a JSON 200 of the wrong shape", () => Response.json({ state: "unlocked", version: 1 })],
  ] as const) {
    it(`fails UnexpectedResponse without echoing the body when the Server answers ${answer}`, async () => {
      let requests = 0
      const stub = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
          requests += 1
          return response()
        },
      })
      const box = await cli()
      try {
        const url = `http://127.0.0.1:${stub.port}`
        const status = response().status
        const result = await box.run(["status"], { env: { HUSH_SERVER: url } })
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(
          result.stderr,
          `hush: The hush Server at ${url} answered with something this CLI does not understand (HTTP ${status}); nothing is known to have changed. CLI and Server versions may differ; \`hush status\` shows both.\n`,
        )
        // One read-only request and no retry: nothing on the Server could have changed.
        assert.strictEqual(requests, 1)
      } finally {
        await stub.stop(true)
        await box.close()
      }
    })
  }

  it("fails ServerUrlInvalid with exit 1 and contacts nothing when HUSH_SERVER is not an http origin", async () => {
    const box = await cli()
    try {
      const result = await box.run(["status"], { env: { HUSH_SERVER: "https://127.0.0.1:7787/path" } })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: HUSH_SERVER holds an invalid Server URL (only http: is supported); nothing was contacted. Use `hush config set server http://<ip>:7787`.\n",
      )
    } finally {
      await box.close()
    }
  })
})
