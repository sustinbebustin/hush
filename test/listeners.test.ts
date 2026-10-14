import { assert, describe, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { join } from "node:path"

import packageJson from "../package.json" with { type: "json" }
import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { cli, sandbox, type Sandbox, type SandboxOptions } from "./sandbox.js"

const withSandbox = async (
  options: SandboxOptions,
  test: (box: Sandbox, seen: (code: string) => void) => Promise<void>,
) => {
  const box = await sandbox(options)
  const codes: Array<Sentinel> = []
  try {
    await test(box, (code) => codes.push({ kind: "initCode", text: code }))
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel, ...codes]), [])
  } finally {
    await box.close()
  }
}

const startupLine = (box: Sandbox): unknown =>
  JSON.parse(
    box.server
      .output()
      .split("\n")
      .findLast((line) => line.includes('"listening"')) ?? "",
  )

const warnings = (box: Sandbox) =>
  box.server
    .output()
    .split("\n")
    .filter((line) => line.includes('"cleartext-listen"'))

// The runner's first non-loopback IPv4 address, if it has one.
const lanAddress = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .find(({ family, internal }) => family === "IPv4" && !internal)?.address

// Bun itself creates `~/.bun` in a fresh HOME.
const createdBesidesBun = async (home: string) => (await readdir(home)).filter((name) => name !== ".bun")

// Runs `hush server` with `args` from a fresh HOME and asserts it failed with `message`, exit 1 and nothing created.
const assertStartRefused = async (args: ReadonlyArray<string>, message: string, env: Record<string, string> = {}) => {
  const box = await cli()
  try {
    const result = await box.run(["server", "--state-dir", join(box.home, "state"), "--port", "0", ...args], { env })
    assert.strictEqual(result.code, 1)
    assert.strictEqual(result.stdout, "")
    assert.strictEqual(result.stderr, `hush: ${message}\n`)
    assert.deepStrictEqual(await createdBesidesBun(box.home), [])
  } finally {
    await box.close()
  }
}

const linux = process.platform === "linux"

describe("hush server listeners", () => {
  it("binds 127.0.0.1 alone by default and logs no cleartext warning", () =>
    withSandbox({}, async (box) => {
      assert.deepStrictEqual(box.server.addresses(), [{ ip: "127.0.0.1", port: Number(new URL(box.server.url).port) }])
      assert.deepStrictEqual(warnings(box), [])
    }))

  it("adds each --listen address after loopback, each on its own ephemeral port with --port 0", () =>
    withSandbox({ serverArgs: ["--listen", "::1"], port: 0 }, async (box) => {
      const addresses = box.server.addresses()
      assert.deepStrictEqual(
        addresses.map(({ ip }) => ip),
        ["127.0.0.1", "::1"],
      )
      assert.strictEqual(new Set(addresses.map(({ port }) => port)).size, 2)
      for (const { ip, port } of addresses) {
        const origin = ip.includes(":") ? `http://[${ip}]:${port}` : `http://${ip}:${port}`
        const status = await box.run(["status"], { env: { HUSH_SERVER: origin } })
        assert.strictEqual(status.code, 0, ip)
      }
      assert.deepStrictEqual(startupLine(box), {
        event: "listening",
        version: packageJson.version,
        state: "uninitialised",
        addresses,
        allowAnyListen: false,
        initCodeFile: join(box.server.stateDir, "init-code"),
      })
    }))

  it("accepts Init on a second, opted-in listener and warns about cleartext at every start", async () => {
    if (lanAddress === undefined) {
      console.log("skipped: the runner has no non-loopback IPv4 address to listen on")
      return
    }
    await withSandbox({ serverArgs: ["--allow-any-listen", "--listen", lanAddress] }, async (box, seen) => {
      const [, second] = box.server.addresses()
      assert.strictEqual(second?.ip, lanAddress)
      assert.propertyVal(startupLine(box), "allowAnyListen", true)
      assert.strictEqual(warnings(box).length, 1)
      const code = (await box.server.initCode()) ?? ""
      seen(code)
      const init = await box.run(["init", "--passphrase-stdin"], {
        input: `${code}\n${passphraseSentinel.text}\n`,
        env: { HUSH_SERVER: `http://${lanAddress}:${second?.port}` },
      })
      assert.strictEqual(init.code, 0, init.stderr)
      assert.strictEqual(JSON.parse((await box.run(["status"])).stdout).state, "ready")
      await box.server.restart()
      assert.strictEqual(warnings(box).length, 2)
      const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(lanAddress)
      assert.deepStrictEqual(JSON.parse(warnings(box)[0] ?? ""), {
        event: "cleartext-listen",
        addresses: tailnet ? [] : [lanAddress],
        message:
          "--allow-any-listen is in effect: Tokens and the Passphrase cross every listener outside loopback and the tailnet in cleartext. Publish or route those only to this host or the tailnet.",
      })
    })
  })
})

describe("hush server listen errors", () => {
  it("refuses a LAN address without the opt-in with ListenNotAllowed, creating nothing", () =>
    assertStartRefused(
      ["--listen", "192.0.2.10"],
      "Refusing to listen on 192.0.2.10: it is not a loopback or Tailscale address, and Tokens and the Passphrase would cross it in cleartext; nothing was started. In a Docker bridge container set `HUSH_ALLOW_ANY_LISTEN=true` only together with `-p 127.0.0.1:7787:7787` or `-p <tailnet-ip>:7787:7787`; elsewhere listen on 127.0.0.1 or the tailnet IP.",
    ))

  it("refuses a wildcard from HUSH_LISTEN without the opt-in", () =>
    assertStartRefused(
      [],
      "Refusing to listen on 0.0.0.0: it is not a loopback or Tailscale address, and Tokens and the Passphrase would cross it in cleartext; nothing was started. In a Docker bridge container set `HUSH_ALLOW_ANY_LISTEN=true` only together with `-p 127.0.0.1:7787:7787` or `-p <tailnet-ip>:7787:7787`; elsewhere listen on 127.0.0.1 or the tailnet IP.",
      { HUSH_LISTEN: "0.0.0.0" },
    ))

  it("refuses a hostname with ListenInvalid naming `tailscale ip -4`", () =>
    assertStartRefused(
      ["--listen", "hush.local"],
      "`--listen hush.local` must be an IP address (not a hostname, link-local or IPv4-mapped address); nothing was started. For the tailnet use the 100.x address from `tailscale ip -4`.",
    ))

  it("refuses an empty HUSH_LISTEN item with ConfigInvalid", () =>
    assertStartRefused(
      [],
      "HUSH_LISTEN is invalid (the comma-separated list has an empty item); nothing was started.",
      { HUSH_LISTEN: "127.0.0.1,," },
    ))

  it("fails an unassigned tailnet address with ListenAddressUnavailable, creating nothing", async () => {
    const ip = "100.127.255.254"
    if (Object.values(networkInterfaces()).some((entries) => entries?.some(({ address }) => address === ip))) {
      console.log(`skipped: the runner has ${ip} assigned`)
      return
    }
    await assertStartRefused(
      ["--listen", ip],
      `${ip} is not assigned to this host yet; nothing was started. If it is the tailnet IP, start after Tailscale (\`systemctl enable tailscale-wait-online.service\` and order the unit after \`tailscale-online.target\`); systemd and Docker retry automatically.`,
    )
  })

  it("fails any other bind error with ListenFailed naming its code, creating nothing", async () => {
    const unprivilegedFrom = linux ? Number(readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8")) : 0
    if (process.getuid?.() === 0 || unprivilegedFrom <= 80) {
      console.log("skipped: this runner may bind port 80, so it cannot provoke EACCES")
      return
    }
    const box = await cli()
    try {
      const result = await box.run(["server", "--state-dir", join(box.home, "state"), "--port", "80"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stderr, "hush: Could not listen on 127.0.0.1:80 (EACCES); nothing was started.\n")
      assert.deepStrictEqual(await createdBesidesBun(box.home), [])
    } finally {
      await box.close()
    }
  })
})
