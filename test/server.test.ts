import { assert, describe, it } from "@effect/vitest"
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import packageJson from "../package.json" with { type: "json" }
import { passphraseSentinel, scan, valueSentinel } from "./leaks.js"
import { cli, sandbox, type Sandbox, serverSupported } from "./sandbox.js"

const withSandbox = async (test: (box: Sandbox) => Promise<void>) => {
  const box = await sandbox()

  try {
    await test(box)
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel]), [])
  } finally {
    await box.close()
  }
}

// Bun itself creates `~/.bun` in a fresh HOME.
const createdBesidesBun = async (home: string) => (await readdir(home)).filter((name) => name !== ".bun")

const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8)

describe("hush server start", () => {
  it("prints one startup line naming its loopback address once it listens", () =>
    withSandbox(async (box) => {
      const [line, ...rest] = box.server
        .output()
        .split("\n")
        .filter((text) => text.includes('"listening"'))

      assert.strictEqual(rest.length, 0)
      assert.deepStrictEqual(JSON.parse(line ?? ""), {
        event: "listening",
        version: packageJson.version,
        state: "uninitialised",
        addresses: [{ ip: "127.0.0.1", port: Number(new URL(box.server.url).port) }],
        allowAnyListen: false,
        initCodeFile: join(box.server.stateDir, "init-code"),
      })
    }))

  it("keeps the state directory 0700 and the database, WAL, SHM and Init code file 0600", () =>
    withSandbox(async (box) => {
      assert.strictEqual(await mode(box.server.stateDir), "700")
      const files = (await readdir(box.server.stateDir)).toSorted()
      assert.deepStrictEqual(files, ["hush.db", "hush.db-shm", "hush.db-wal", "init-code"])

      for (const file of files) assert.strictEqual(await mode(join(box.server.stateDir, file)), "600")
    }))

  it("narrows an existing state directory and database to 0700 and 0600 at start", () =>
    withSandbox(async (box) => {
      await box.server.stop()
      await chmod(box.server.stateDir, 0o755)
      await chmod(join(box.server.stateDir, "hush.db"), 0o644)
      await box.server.restart()
      assert.strictEqual(await mode(box.server.stateDir), "700")
      assert.strictEqual(await mode(join(box.server.stateDir, "hush.db")), "600")
    }))

  it("deletes every stale backup snapshot before opening the database, logging each", () =>
    withSandbox(async (box) => {
      const stale = ["backup-a1.db", "backup-b2.db"]

      for (const name of stale) await writeFile(join(box.server.stateDir, name), valueSentinel.text)
      await box.server.restart()
      assert.deepStrictEqual(
        (await readdir(box.server.stateDir)).filter((name) => name.startsWith("backup-")),
        [],
      )

      for (const name of stale)
        assert.include(
          box.server.output(),
          JSON.stringify({ event: "stale-snapshot-deleted", path: join(box.server.stateDir, name) }),
        )
    }))

  it("logs method, path and status per request on stderr, and nothing else", () =>
    withSandbox(async (box) => {
      const secret = "hush_fictionalHeaderSentinel"
      await box.fetch(`/v1/status?probe=${secret}`, { headers: { authorization: `Bearer ${secret}` } })
      const calls = await box.calls()
      assert.deepStrictEqual(calls.at(-1), { method: "GET", path: "/v1/status", status: 200 })
      assert.notInclude(box.server.output(), secret)

      for (const line of box.server
        .output()
        .split("\n")
        .filter((text) => text.includes('"request"')))
        assert.deepStrictEqual(Object.keys(JSON.parse(line)), ["event", "method", "path", "status"])
    }))

  it("restarts on the same port with no human step", () =>
    withSandbox(async (box) => {
      const url = box.server.url
      await box.server.restart()
      await box.server.restart()
      assert.strictEqual(box.server.url, url)
      assert.strictEqual((await box.run(["status"])).code, 0)
    }))

  // A restart binds the same port again; an ephemeral port freed by the stop could go to any other process first.
  it.skipIf(process.platform !== "linux")("runs the sandbox's Server on a port outside the ephemeral range", () =>
    withSandbox(async (box) => {
      const [low, high] = (await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8")).trim().split(/\s+/)
      const port = Number(new URL(box.server.url).port)
      assert.isTrue(port < Number(low) || port > Number(high), `port ${port} is in ${low}-${high}`)
    }),
  )

  it("fails ListenAddressInUse with exit 1 when the port is taken, leaving the running Server unchanged", () =>
    withSandbox(async (box) => {
      const port = new URL(box.server.url).port
      const other = await mkdtemp(join(tmpdir(), "hush-other-"))
      const result = await box.run(["server", "--state-dir", join(other, "state"), "--port", port])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        `hush: 127.0.0.1:${port} is already in use (another hush Server on this state dir or port?); nothing was started. Stop the other process or choose \`--port\`.\n`,
      )
      const status = await box.run(["status"])
      assert.strictEqual(JSON.parse(status.stdout).state, "uninitialised")
    }))
})

describe.skipIf(!serverSupported)("hush server config errors", () => {
  it("fails StateDirRequired with one line and exit 1, creating nothing", async () => {
    const box = await cli()

    try {
      const result = await box.run(["server", "--port", "0"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: hush server needs a state directory and none was given; nothing was created. Pass `--state-dir /var/lib/hush` or set `HUSH_STATE_DIR` (the unit and image set it already).\n",
      )
      assert.deepStrictEqual(await createdBesidesBun(box.home), [])
    } finally {
      await box.close()
    }
  })

  it("fails ConfigInvalid with exit 1 on a port that is not a number, creating nothing", async () => {
    const box = await cli()

    try {
      const stateDir = join(box.home, "state")
      const result = await box.run(["server", "--state-dir", stateDir], { env: { HUSH_PORT: "http" } })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: HUSH_PORT is invalid (expected a port number from 0 to 65535); nothing was started.\n",
      )
      assert.deepStrictEqual(await createdBesidesBun(box.home), [])
    } finally {
      await box.close()
    }
  })
})

describe("the harness", () => {
  it("runs the CLI with no controlling terminal, so /dev/tty fails", async () => {
    const box = await cli()

    try {
      const result = await box.shell(": < /dev/tty")
      assert.notStrictEqual(result.code, 0)
    } finally {
      await box.close()
    }
  })

  it("records [status] for `status` and [] for `--help` (no preflight, one request per command)", () =>
    withSandbox(async (box) => {
      assert.deepStrictEqual(
        (await box.run(["status"])).calls.map(({ path }) => path),
        ["/v1/status"],
      )
      const help = await box.run(["--help"])
      assert.strictEqual(help.code, 0)
      assert.deepStrictEqual(help.calls, [])
    }))
})
