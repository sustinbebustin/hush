import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"

import packageJson from "../package.json" with { type: "json" }
import { Doctor } from "../src/cli/Doctor.js"
import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { type Cli, cli, sandbox, type Sandbox, type Seeded } from "./sandbox.js"

const TcpAddress = Schema.Struct({ port: Schema.Number })

const server: Doctor.ServerCheck = {
  source: "default",
  route: "direct",
  proxy: null,
  proxyUnused: "none",
  reachable: true,
  state: "ready",
  version: "0.0.0",
}

const token: Doctor.TokenCheck = { source: "file", file: "ok" }

describe("Doctor.report", () => {
  it("reports versions and checks in a fixed order, omitting empty notes", () => {
    const report = Doctor.report({ version: "1.2.3", server, token, notes: [] })
    assert.deepStrictEqual(Object.keys(report), ["hush", "platform", "bun", "server", "token"])
    assert.strictEqual(report.hush, "1.2.3")
    assert.match(report.platform, /^[a-z0-9]+-[a-z0-9]+$/)
    assert.match(report.bun, /^\d+\.\d+\.\d+/)
    assert.deepStrictEqual(report.server, server)
    assert.deepStrictEqual(report.token, token)
  })

  it("lists notes last when there are any", () => {
    const report = Doctor.report({ version: "1.2.3", server, token, notes: ["No hush Token is available."] })
    assert.deepStrictEqual(Object.keys(report), ["hush", "platform", "bun", "server", "token", "notes"])
    assert.deepStrictEqual(report.notes, ["No hush Token is available."])
  })
})

// The doctor notes, as an agent reads them.
const note = {
  uninitialised:
    "The Server is not initialised: a human reads the Init code from the Server's state directory (the `init-code` file; the Server's startup log prints its path) and runs `hush init --vault <name>`.",
  noToken:
    "No Token is available for this Server (HUSH_TOKEN unset, none saved for it): a human runs `hush token issue --read <vault>` with a Label, or sets HUSH_TOKEN.",
  unreachableDirect: (reason: string) =>
    `The Server did not answer a direct connection (${reason}): check that it is running and that \`HUSH_SERVER\` or \`server\` in \`~/.config/hush/config.json\` points to it (\`hush config get\` shows which).`,
  unreachableProxy: (proxy: string, reason: string) =>
    `The Server did not answer through the loopback proxy at ${proxy} (${reason}): inside an agent sandbox, add the Server's IP:port (\`hush config get\` shows the Server) to the sandbox's allowed domains.`,
  proxyInUse: (proxy: string) =>
    `Requests go through the loopback proxy at ${proxy} (HTTP_PROXY); if this is not an agent sandbox's proxy it sees Tokens and the Passphrase in cleartext: set HUSH_PROXY=direct.`,
  notLoopback: "HTTP_PROXY is set but is not a loopback proxy, so hush connects directly.",
  disabled:
    "A loopback HTTP_PROXY is set but HUSH_PROXY=direct (or config proxy: direct) disables it; inside an agent sandbox unset HUSH_PROXY (or run `hush config set proxy auto`).",
  versions: (serverVersion: string) =>
    `This CLI is version ${packageJson.version} but the Server is version ${serverVersion}; install the same version of both.`,
  insecure:
    "The token file ~/.config/hush/tokens.json can be read by other users: run `chmod 600 ~/.config/hush/tokens.json`, and Revoke its Token if it may have been copied.",
  invalid:
    "The token file ~/.config/hush/tokens.json cannot be read or is not a hush token file: fix or remove it, or set HUSH_TOKEN.",
  hostNotAllowed:
    "The Server refused the request's Host name: start it with `--allowed-host <the host name in HUSH_SERVER>` (or HUSH_ALLOWED_HOSTS), or point HUSH_SERVER at its IP address.",
} as const

const parse = (stdout: string) => JSON.parse(stdout)

// Doctor's output is safe to paste: no Server URL, Vault name, Label, Reference or Token.
const assertSafe = (stdout: string, forbidden: ReadonlyArray<string>) => {
  for (const text of forbidden) assert.notInclude(stdout, text)
}

const withBox = async (test: (box: Sandbox) => Promise<ReadonlyArray<Sentinel>>) => {
  const box = await sandbox()

  try {
    const extra = await test(box)
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel, ...extra]), [])
  } finally {
    await box.close()
  }
}

const withSeeded = (test: (box: Sandbox, seeded: Seeded) => Promise<void>) =>
  withBox(async (box) => {
    const seeded = await box.seed({ items: [{ kind: "api-credential", title: "Stripe", value: valueSentinel.text }] })
    await test(box, seeded)

    return [{ kind: "token", text: seeded.token }]
  })

const forbiddenFor = (box: Sandbox, seeded: Seeded) => [
  box.server.url,
  seeded.vault,
  seeded.label,
  seeded.token,
  ...seeded.references,
]

const status = [{ method: "GET", path: "/v1/status", status: 200 }]

// A stand-in Server that answers every request with `response`, for answers a real Server never gives.
const withStub = async (response: () => Response, test: (url: string, run: Cli["run"]) => Promise<void>) => {
  const stub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: response })
  const box = await cli()
  const url = `http://127.0.0.1:${stub.port}`

  try {
    await test(url, (args, options) => box.run(args, { ...options, env: { HUSH_SERVER: url, ...options?.env } }))
  } finally {
    await stub.stop(true)
    await box.close()
  }
}

describe("hush doctor", () => {
  it("reports a ready Server and a saved Token with no notes, calling only status", () =>
    withSeeded(async (box, seeded) => {
      const result = await box.run(["doctor"])
      assert.strictEqual(result.code, 0)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, status)
      const report = parse(result.stdout)
      assert.deepStrictEqual(Object.keys(report), ["hush", "platform", "bun", "server", "token"])
      assert.strictEqual(report.hush, packageJson.version)
      assert.deepStrictEqual(report.server, {
        source: "env",
        route: "direct",
        proxy: null,
        proxyUnused: "none",
        reachable: true,
        state: "ready",
        version: packageJson.version,
      })
      assert.deepStrictEqual(report.token, { source: "file", file: "ok" })
      assertSafe(result.stdout, forbiddenFor(box, seeded))
    }))

  it("reports an Uninitialised Server and no Token, with a note for each", () =>
    withBox(async (box) => {
      const result = await box.run(["doctor"])
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(result.calls, status)
      const report = parse(result.stdout)
      assert.strictEqual(report.server.state, "uninitialised")
      assert.deepStrictEqual(report.token, { source: "none", file: "missing" })
      assert.deepStrictEqual(report.notes, [note.uninitialised, note.noToken])
      assertSafe(result.stdout, [box.server.url])

      return []
    }))

  it("reports HUSH_TOKEN as the source without reading the token file", () =>
    withSeeded(async (box, seeded) => {
      await chmod(join(box.home, ".config", "hush", "tokens.json"), 0o644)
      const result = await box.run(["doctor"], { env: { HUSH_TOKEN: "not even a token" } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(parse(result.stdout).token, { source: "env", file: "not-read" })
      assert.strictEqual(parse(result.stdout).notes, undefined)
      assertSafe(result.stdout, [...forbiddenFor(box, seeded), "not even a token"])
    }))

  it("notes an insecure token file", () =>
    withSeeded(async (box) => {
      await chmod(join(box.home, ".config", "hush", "tokens.json"), 0o644)
      const result = await box.run(["doctor"])
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(parse(result.stdout).token, { source: "none", file: "insecure" })
      assert.deepStrictEqual(parse(result.stdout).notes, [note.insecure])
    }))

  it("notes an invalid token file", () =>
    withBox(async (box) => {
      await box.seed()
      await writeFile(join(box.home, ".config", "hush", "tokens.json"), "not json", { mode: 0o600 })
      const result = await box.run(["doctor"])
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(parse(result.stdout).token, { source: "none", file: "invalid" })
      assert.deepStrictEqual(parse(result.stdout).notes, [note.invalid])

      return []
    }))

  it("exits 0 and notes a direct connection that failed, calling nothing", () =>
    withSeeded(async (box, seeded) => {
      await box.server.stop()
      const result = await box.run(["doctor"])
      assert.strictEqual(result.code, 0)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, [])
      const report = parse(result.stdout)
      assert.deepStrictEqual(report.server, {
        source: "env",
        route: "direct",
        proxy: null,
        proxyUnused: "none",
        reachable: false,
        state: null,
        version: null,
      })
      assert.deepStrictEqual(report.notes, [note.unreachableDirect("refused")])
      assertSafe(result.stdout, forbiddenFor(box, seeded))
    }))

  it("reports the loopback proxy in use, with the cleartext warning", () =>
    withSeeded(async (box) => {
      const result = await box.run(["doctor"], { env: { HTTP_PROXY: box.proxy.url, NO_PROXY: "127.0.0.1" } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(result.calls, status)
      const proxy = box.proxy.url.replace("http://", "")
      const report = parse(result.stdout)
      assert.deepStrictEqual(
        { route: report.server.route, proxy: report.server.proxy, unused: report.server.proxyUnused },
        { route: "proxy", proxy, unused: "none" },
      )
      assert.deepStrictEqual(report.notes, [note.proxyInUse(proxy)])
      assert.deepStrictEqual(box.proxy.log(), [`GET ${box.server.url}/v1/status HTTP/1.1`])
    }))

  it("notes a loopback proxy that failed, never showing its userinfo", () =>
    withBox(async (box) => {
      const result = await box.run(["doctor"], { env: { HTTP_PROXY: "http://u:p@127.0.0.1:1" } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(result.calls, [])
      const report = parse(result.stdout)
      assert.strictEqual(report.server.reachable, false)
      assert.strictEqual(report.server.proxy, "127.0.0.1:1")
      assert.deepStrictEqual(report.notes, [
        note.unreachableProxy("127.0.0.1:1", "refused"),
        note.proxyInUse("127.0.0.1:1"),
        note.noToken,
      ])

      return [{ kind: "proxyUserinfo", text: "u:p" }]
    }))

  it("notes a proxy that is not on loopback", () =>
    withSeeded(async (box) => {
      const result = await box.run(["doctor"], { env: { HTTP_PROXY: "http://192.0.2.1:9" } })
      assert.strictEqual(result.code, 0)
      const report = parse(result.stdout)
      assert.deepStrictEqual(
        { route: report.server.route, proxy: report.server.proxy, unused: report.server.proxyUnused },
        { route: "direct", proxy: "192.0.2.1:9", unused: "not-loopback" },
      )
      assert.deepStrictEqual(report.notes, [note.notLoopback])
    }))

  it("notes a loopback proxy disabled by HUSH_PROXY=direct", () =>
    withSeeded(async (box) => {
      const result = await box.run(["doctor"], { env: { HTTP_PROXY: box.proxy.url, HUSH_PROXY: "direct" } })
      assert.strictEqual(result.code, 0)
      const report = parse(result.stdout)
      assert.deepStrictEqual(
        { route: report.server.route, unused: report.server.proxyUnused },
        { route: "direct", unused: "disabled" },
      )
      assert.deepStrictEqual(report.notes, [note.disabled])
      assert.deepStrictEqual(box.proxy.log(), [])
    }))

  it("notes CLI and Server versions that differ", () =>
    withStub(
      () => Response.json({ state: "ready", version: "0.0.0-other", api: 1 }),
      async (url, run) => {
        const result = await run(["doctor"])
        assert.strictEqual(result.code, 0)
        assert.strictEqual(parse(result.stdout).server.version, "0.0.0-other")
        assert.deepStrictEqual(parse(result.stdout).notes, [note.versions("0.0.0-other"), note.noToken])
        assertSafe(result.stdout, [url])
      },
    ))

  it("notes a Host the Server does not allow, without naming it", () =>
    withStub(
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      () => Response.json({ _tag: "HostNotAllowed", host: "hush.example.ts.net" }, { status: 403 }),
      async (url, run) => {
        const result = await run(["doctor"])
        assert.strictEqual(result.code, 0)
        const report = parse(result.stdout)
        assert.deepStrictEqual(
          { reachable: report.server.reachable, state: report.server.state, version: report.server.version },
          { reachable: true, state: null, version: null },
        )
        assert.deepStrictEqual(report.notes, [note.hostNotAllowed, note.noToken])
        assertSafe(result.stdout, [url, "hush.example.ts.net"])
      },
    ))

  it("notes an answer it does not understand", () =>
    withStub(
      () => new Response("<html>", { status: 502 }),
      async (url, run) => {
        const result = await run(["doctor"])
        assert.strictEqual(result.code, 0)
        assert.deepStrictEqual(parse(result.stdout).notes, [
          "The Server answered with something this CLI does not understand (HTTP 502); CLI and Server versions may differ.",
          note.noToken,
        ])
        assertSafe(result.stdout, [url])
      },
    ))

  it("gives up on a Server that accepts but never answers after 5 seconds", async () => {
    const listener = createServer(() => {})
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    // A TCP listener's address; a pipe's string or a closed listener's null fails here.
    const address = Schema.decodeUnknownSync(TcpAddress)(listener.address())
    const box = await cli()

    try {
      const started = Date.now()
      const result = await box.run(["doctor"], { env: { HUSH_SERVER: `http://127.0.0.1:${address.port}` } })
      const elapsed = Date.now() - started
      assert.strictEqual(result.code, 0)
      assert.strictEqual(parse(result.stdout).server.reachable, false)
      assert.deepStrictEqual(parse(result.stdout).notes, [note.unreachableDirect("timed out"), note.noToken])
      assert.isAtLeast(elapsed, 5000)
      assert.isBelow(elapsed, 12_000)
    } finally {
      listener.close()
      await box.close()
    }
  })

  it("exits 0 with the Server check left out when HUSH_SERVER is invalid", async () => {
    const box = await cli()

    try {
      const result = await box.run(["doctor"], { env: { HUSH_SERVER: "https://secret-host.example:7787" } })
      assert.strictEqual(result.code, 0)
      const report = parse(result.stdout)
      assert.strictEqual(report.server, null)
      assert.deepStrictEqual(report.token, { source: "none", file: "missing" })
      assert.deepStrictEqual(report.notes, [
        "HUSH_SERVER holds an invalid Server URL (only http: is supported); nothing was contacted. Use `hush config set server http://<ip>:7787`.",
      ])
      assertSafe(result.stdout, ["secret-host"])
    } finally {
      await box.close()
    }
  })

  it("reports the config file as the Server source", () =>
    withSeeded(async (box) => {
      await mkdir(join(box.home, ".config", "hush"), { recursive: true })
      await box.run(["config", "set", "server", box.server.url])
      const result = await box.run(["doctor"], { env: { HUSH_SERVER: "" } })
      assert.strictEqual(result.code, 0)
      assert.strictEqual(parse(result.stdout).server.source, "config")
      assert.deepStrictEqual(parse(result.stdout).token, { source: "file", file: "ok" })
    }))
})
