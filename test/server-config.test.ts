import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"

import { ServerConfig, type ServerFlags } from "../src/server/ServerConfig.js"
import { ConfigInvalid, ListenInvalid, ListenNotAllowed } from "../src/server/StartupError.js"

const parse = (flags: Partial<ServerFlags>, env: Record<string, string> = {}) =>
  ServerConfig.parse(
    { stateDir: undefined, port: undefined, listen: [], allowAnyListen: false, allowedHost: [], ...flags },
    env,
  )

const failure = (result: ReturnType<typeof parse>) => (Result.isFailure(result) ? result.failure : undefined)
const success = (result: ReturnType<typeof parse>) => (Result.isSuccess(result) ? result.success : undefined)

const defaults = { listen: [], allowAnyListen: false, allowedHosts: [] }

describe("ServerConfig.parse", () => {
  it("requires a state directory from --state-dir or HUSH_STATE_DIR", () => {
    assert.strictEqual(failure(parse({}))?._tag, "StateDirRequired")
    assert.strictEqual(failure(parse({}, { HUSH_STATE_DIR: "" }))?._tag, "StateDirRequired")
    assert.deepStrictEqual(
      parse({}, { HUSH_STATE_DIR: "/var/lib/hush" }),
      Result.succeed({ stateDir: "/var/lib/hush", port: 7787, ...defaults }),
    )
  })

  it("prefers flags over env", () => {
    assert.deepStrictEqual(
      parse({ stateDir: "/srv/a", port: "0" }, { HUSH_STATE_DIR: "/srv/b", HUSH_PORT: "9000" }),
      Result.succeed({ stateDir: "/srv/a", port: 0, ...defaults }),
    )
    assert.deepStrictEqual(
      parse({ stateDir: "/srv/a" }, { HUSH_PORT: "9000" }),
      Result.succeed({ stateDir: "/srv/a", port: 9000, ...defaults }),
    )
  })

  it("makes a relative state directory absolute", () => {
    const result = parse({ stateDir: "state" })
    assert.isTrue(Result.isSuccess(result) && result.success.stateDir.startsWith("/"))
  })

  for (const port of ["65536", "-1", "80a", "", "1e3"])
    it(`refuses port ${JSON.stringify(port)} with ConfigInvalid naming its source`, () => {
      const error = failure(parse({ stateDir: "/srv/a", port }))
      assert.deepStrictEqual(error?._tag === "ConfigInvalid" ? error.source : error, "--port")
    })
})

describe("ServerConfig.parse: listen and allowed hosts", () => {
  const base = { stateDir: "/srv/a" }

  it("reads repeatable --listen in order, classified", () => {
    assert.deepStrictEqual(success(parse({ ...base, listen: ["100.84.135.127", "::1"] }))?.listen, [
      { ip: "100.84.135.127", class: "tailnet" },
      { ip: "::1", class: "loopback" },
    ])
  })

  it("splits HUSH_LISTEN and HUSH_ALLOWED_HOSTS on commas, trimming each item", () => {
    const config = success(
      parse(base, { HUSH_LISTEN: " 100.84.135.127 ,::1", HUSH_ALLOWED_HOSTS: "Dev.Tail1234.ts.net, localhost.lan " }),
    )
    assert.deepStrictEqual(config?.listen, [
      { ip: "100.84.135.127", class: "tailnet" },
      { ip: "::1", class: "loopback" },
    ])
    assert.deepStrictEqual(config?.allowedHosts, ["dev.tail1234.ts.net", "localhost.lan"])
  })

  it("lets the flags replace the env lists", () => {
    const config = success(
      parse(
        { ...base, listen: ["127.0.0.2"], allowedHost: ["A.example"] },
        { HUSH_LISTEN: "100.84.135.127", HUSH_ALLOWED_HOSTS: "b.example" },
      ),
    )
    assert.deepStrictEqual(config?.listen, [{ ip: "127.0.0.2", class: "loopback" }])
    assert.deepStrictEqual(config?.allowedHosts, ["a.example"])
  })

  it("treats an empty HUSH_LISTEN or HUSH_ALLOWED_HOSTS as unset", () => {
    assert.deepStrictEqual(success(parse(base, { HUSH_LISTEN: "", HUSH_ALLOWED_HOSTS: "" })), {
      stateDir: "/srv/a",
      port: 7787,
      ...defaults,
    })
  })

  for (const [name, text] of [
    ["HUSH_LISTEN", "100.84.135.127,"],
    ["HUSH_LISTEN", "100.84.135.127, ,::1"],
    ["HUSH_ALLOWED_HOSTS", ",a.example"],
  ] as const)
    it(`refuses an empty item in ${name}=${JSON.stringify(text)} with ConfigInvalid`, () => {
      assert.deepStrictEqual(
        failure(parse(base, { [name]: text })),
        new ConfigInvalid({ source: name, reason: "the comma-separated list has an empty item" }),
      )
    })

  for (const [host, source] of [
    ["hush.example:7787", "--allowed-host"],
    ["bad host", "--allowed-host"],
    ["", "--allowed-host"],
    ["-lead.example", "HUSH_ALLOWED_HOSTS"],
  ] as const)
    it(`refuses the allowed host ${JSON.stringify(host)} from ${source} with ConfigInvalid`, () => {
      const result =
        source === "--allowed-host" ? parse({ ...base, allowedHost: [host] }) : parse(base, { [source]: host })
      assert.deepStrictEqual(
        failure(result),
        new ConfigInvalid({ source, reason: "expected a hostname without a port, such as hush.tail1234.ts.net" }),
      )
    })

  it("refuses a hostname or link-local listen address with ListenInvalid naming its source", () => {
    assert.deepStrictEqual(
      failure(parse({ ...base, listen: ["hush.local"] })),
      new ListenInvalid({ source: "--listen", value: "hush.local" }),
    )
    assert.deepStrictEqual(
      failure(parse(base, { HUSH_LISTEN: "fe80::1" })),
      new ListenInvalid({ source: "HUSH_LISTEN", value: "fe80::1" }),
    )
  })

  it("refuses an address outside the allowed ranges without the opt-in, naming the first one", () => {
    assert.deepStrictEqual(
      failure(parse({ ...base, listen: ["100.84.135.127", "192.168.1.10", "0.0.0.0"] })),
      new ListenNotAllowed({ ip: "192.168.1.10" }),
    )
    assert.deepStrictEqual(failure(parse(base, { HUSH_LISTEN: "0.0.0.0" })), new ListenNotAllowed({ ip: "0.0.0.0" }))
  })

  it("accepts any address with --allow-any-listen or HUSH_ALLOW_ANY_LISTEN=true", () => {
    for (const config of [
      success(parse({ ...base, listen: ["192.168.1.10"], allowAnyListen: true })),
      success(parse(base, { HUSH_LISTEN: "0.0.0.0", HUSH_ALLOW_ANY_LISTEN: "true" })),
    ])
      assert.isTrue(config?.allowAnyListen)
    assert.isFalse(success(parse(base, { HUSH_ALLOW_ANY_LISTEN: "false" }))?.allowAnyListen)
  })

  it("refuses an HUSH_ALLOW_ANY_LISTEN that is not true or false", () => {
    assert.deepStrictEqual(
      failure(parse(base, { HUSH_ALLOW_ANY_LISTEN: "yes" })),
      new ConfigInvalid({ source: "HUSH_ALLOW_ANY_LISTEN", reason: "expected true or false" }),
    )
  })
})
