import { assert, describe, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import packageJson from "../package.json" with { type: "json" }
import { cli } from "./sandbox.js"

// Runs `hush <args>` with a token file and config file that would block any read (FIFOs with no writer)
// and HUSH_SERVER pointing at a listener that counts connections.
const isolated = async (args: ReadonlyArray<string>) => {
  const box = await cli()
  const listener = createServer((socket) => socket.destroy())
  let connections = 0
  listener.on("connection", () => {
    connections += 1
  })

  try {
    const config = join(box.home, ".config", "hush")
    await mkdir(config, { recursive: true })

    for (const file of ["tokens.json", "config.json"]) execFileSync("mkfifo", [join(config, file)])
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    const address = listener.address()

    if (address === null || typeof address === "string") throw new Error("listener has no TCP address")
    const result = await box.run(args, { env: { HUSH_SERVER: `http://127.0.0.1:${address.port}` } })

    return { ...result, connections }
  } finally {
    listener.close()
    await box.close()
  }
}

describe("hush --help and --version", () => {
  it("prints help and exits 0 without reading the token file or contacting a Server", async () => {
    const result = await isolated(["--help"])
    assert.strictEqual(result.code, 0)
    assert.strictEqual(result.stderr, "")

    for (const command of ["find", "create", "env", "token", "server"]) assert.include(result.stdout, command)
    assert.strictEqual(result.connections, 0)
  })

  it("prints the package version and exits 0 without reading the token file or contacting a Server", async () => {
    const result = await isolated(["--version"])
    assert.strictEqual(result.code, 0)
    assert.include(result.stdout, packageJson.version)
    assert.strictEqual(result.connections, 0)
  })
})

describe("global flags", () => {
  it("treats -v as --version, also after a command", async () => {
    for (const args of [["-v"], ["find", "-v"]]) {
      const result = await isolated(args)
      assert.strictEqual(result.code, 0)
      assert.include(result.stdout, packageJson.version)
    }
  })

  for (const flag of ["--completions", "--wizard", "--log-level"]) {
    it(`does not offer effect/cli's ${flag}`, async () => {
      const result = await isolated([flag, "bash"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.connections, 0)
    })
  }
})
