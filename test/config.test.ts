import { assert, describe, it } from "@effect/vitest"
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { scan, passphraseSentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// `hush config get|set` and how the Server and route settings reach every command.

const withSandbox = async (test: (box: Sandbox, file: string) => Promise<void>) => {
  const box = await sandbox()
  try {
    await test(box, join(box.home, ".config", "hush", "config.json"))
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel]), [])
  } finally {
    await box.close()
  }
}

// HUSH_SERVER empty counts as unset, so the config file and the default apply.
const noServerEnv = { HUSH_SERVER: "" }

const text = (path: string) => readFile(path, "utf8").catch(() => undefined)

describe("hush config", () => {
  it("shows the defaults and their sources, contacting nothing", () =>
    withSandbox(async (box) => {
      const result = await box.run(["config", "get"], { env: noServerEnv })
      assert.strictEqual(result.code, 0)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        server: "http://127.0.0.1:7787",
        proxy: "auto",
        source: { server: "default", proxy: "default" },
      })
      assert.deepStrictEqual(result.calls, [])
    }))

  it("shows HUSH_SERVER and HUSH_PROXY as env", () =>
    withSandbox(async (box) => {
      const result = await box.run(["config", "get"], { env: { HUSH_PROXY: "direct" } })
      assert.strictEqual(result.code, 0)
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        server: box.server.url,
        proxy: "direct",
        source: { server: "env", proxy: "env" },
      })
    }))

  it("saves the Server as its origin in a 0600 file in a 0700 directory, and uses it", () =>
    withSandbox(async (box, file) => {
      const set = await box.run(["config", "set", "server", `${box.server.url}/`])
      assert.strictEqual(set.code, 0)
      assert.deepStrictEqual(JSON.parse(set.stdout), { server: box.server.url })
      assert.deepStrictEqual(set.calls, [])
      assert.strictEqual((await stat(file)).mode & 0o777, 0o600)
      assert.strictEqual((await stat(join(box.home, ".config", "hush"))).mode & 0o777, 0o700)
      assert.deepStrictEqual(JSON.parse((await text(file)) ?? ""), { server: box.server.url })

      const status = await box.run(["status"], { env: noServerEnv })
      assert.strictEqual(status.code, 0)
      assert.strictEqual(JSON.parse(status.stdout).server, box.server.url)
      assert.deepStrictEqual(status.calls, [{ method: "GET", path: "/v1/status", status: 200 }])

      const get = await box.run(["config", "get"], { env: noServerEnv })
      assert.deepStrictEqual(JSON.parse(get.stdout).source, { server: "config", proxy: "default" })
    }))

  it("saves the proxy mode, keeping the Server", () =>
    withSandbox(async (box, file) => {
      await box.run(["config", "set", "server", "http://100.64.0.7:7787"])
      const set = await box.run(["config", "set", "proxy", "direct"])
      assert.strictEqual(set.code, 0)
      assert.deepStrictEqual(JSON.parse(set.stdout), { proxy: "direct" })
      assert.deepStrictEqual(set.calls, [])
      assert.deepStrictEqual(JSON.parse((await text(file)) ?? ""), {
        server: "http://100.64.0.7:7787",
        proxy: "direct",
      })
      const get = await box.run(["config", "get"], { env: noServerEnv })
      assert.deepStrictEqual(JSON.parse(get.stdout), {
        server: "http://100.64.0.7:7787",
        proxy: "direct",
        source: { server: "config", proxy: "config" },
      })
    }))

  it("refuses an invalid Server URL with ServerUrlInvalid, saving nothing", () =>
    withSandbox(async (box, file) => {
      const result = await box.run(["config", "set", "server", "https://127.0.0.1:7787"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: That is not a valid Server URL (only http: is supported); nothing was saved. Use `hush config set server http://<ip>:7787`.\n",
      )
      assert.strictEqual(await text(file), undefined)
    }))

  it("refuses a proxy mode other than auto or direct as a usage error, saving nothing", () =>
    withSandbox(async (box, file) => {
      const result = await box.run(["config", "set", "proxy", "env"])
      assert.strictEqual(result.code, 1)
      assert.deepStrictEqual(result.calls, [])
      assert.strictEqual(await text(file), undefined)
    }))

  it("fails ServerUrlInvalid naming the config file when its server is invalid, contacting nothing", () =>
    withSandbox(async (box, file) => {
      await mkdir(join(box.home, ".config", "hush"), { recursive: true })
      const content = `{ "server": "http://127.0.0.1:7787/v1" }`
      await writeFile(file, content)
      const result = await box.run(["status"], { env: noServerEnv })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        `hush: ${file} holds an invalid Server URL (only a host and port are allowed); nothing was contacted. Use \`hush config set server http://<ip>:7787\`.\n`,
      )
      assert.deepStrictEqual(result.calls, [])
      assert.strictEqual(await text(file), content)
    }))

  it("fails ConfigInvalid for a config file that is not JSON, for every command, changing nothing", () =>
    withSandbox(async (box, file) => {
      await mkdir(join(box.home, ".config", "hush"), { recursive: true })
      await writeFile(file, "server = 1")
      for (const args of [["status"], ["config", "get"], ["config", "set", "proxy", "direct"]]) {
        const result = await box.run(args)
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(
          result.stderr,
          `hush: Could not read the CLI config ${file} (not JSON); nothing was contacted or changed. Fix or remove the file, then run \`hush config set server http://<ip>:7787\` if needed.\n`,
        )
        assert.deepStrictEqual(result.calls, [])
      }
      assert.strictEqual(await text(file), "server = 1")
    }))

  it("fails ConfigInvalid for a config file of the wrong shape", () =>
    withSandbox(async (box, file) => {
      await mkdir(join(box.home, ".config", "hush"), { recursive: true })
      await writeFile(file, `{ "server": 7787 }`)
      const result = await box.run(["status"])
      assert.strictEqual(result.code, 1)
      assert.include(result.stderr, `${file} (not a hush config file); nothing was contacted or changed.`)
      assert.deepStrictEqual(result.calls, [])
    }))

  it("fails ConfigInvalid for a HUSH_PROXY other than auto or direct, contacting nothing", () =>
    withSandbox(async (box) => {
      const result = await box.run(["status"], { env: { HUSH_PROXY: "env" } })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: HUSH_PROXY must be `auto` or `direct`; nothing was contacted. Set `HUSH_PROXY=direct` to turn a loopback proxy off, or unset it.\n",
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it("fails ConfigInvalid for a config proxy other than auto or direct", () =>
    withSandbox(async (box, file) => {
      await mkdir(join(box.home, ".config", "hush"), { recursive: true })
      await writeFile(file, `{ "proxy": "off" }`)
      const result = await box.run(["status"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        `hush: ${file} sets \`proxy\` to something other than \`auto\` or \`direct\`; nothing was contacted. Run \`hush config set proxy auto\` (or \`direct\`).\n`,
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it("fails FileWriteFailed when the config directory cannot be created, writing nothing", () =>
    withSandbox(async (box, file) => {
      const parent = join(box.home, ".config")
      await mkdir(parent)
      await chmod(parent, 0o500)
      try {
        const result = await box.run(["config", "set", "proxy", "direct"])
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(
          result.stderr,
          `hush: Could not write the CLI config ${file} (EACCES); it was not changed. Fix its directory's permissions and run \`hush config set\` again.\n`,
        )
        assert.deepStrictEqual(result.calls, [])
        assert.strictEqual(await text(file), undefined)
      } finally {
        await chmod(parent, 0o700)
      }
    }))
})
