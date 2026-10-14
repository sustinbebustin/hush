import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import * as fc from "fast-check"

import { Listen } from "../src/server/Listen.js"
import { ListenInvalid } from "../src/server/StartupError.js"

const classOf = (text: string) => {
  const result = Listen.parse("--listen", text)
  return Result.isSuccess(result) ? result.success.class : result.failure._tag
}

const address = (ip: string) => Result.getOrThrow(Listen.parse("--listen", ip))

describe("Listen.parse", () => {
  it("classifies loopback, tailnet, wildcard and other IP literals", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["127.0.0.1", "loopback"],
      ["127.255.0.9", "loopback"],
      ["::1", "loopback"],
      ["0:0:0:0:0:0:0:1", "loopback"],
      ["100.64.0.0", "tailnet"],
      ["100.84.135.127", "tailnet"],
      ["100.127.255.255", "tailnet"],
      ["0.0.0.0", "wildcard"],
      ["::", "wildcard"],
      ["100.63.255.255", "other"],
      ["100.128.0.0", "other"],
      ["192.168.1.10", "other"],
      ["10.0.0.1", "other"],
      ["2001:db8::1", "other"],
      // fd7a:115c:a1e0::/48, documented by Tailscale.
      ["fd7a:115c:a1e0::9833:8782", "tailnet"],
      ["fd7a:115c:a1e0:ab12:4843:cd96:6258:b240", "tailnet"],
      ["FD7A:115C:A1E0:FFFF:FFFF:FFFF:FFFF:FFFF", "tailnet"],
      ["fd7a:115c:a1e1::1", "other"],
      ["fd7a:115c:a1df:ffff::1", "other"],
      ["fd7b:115c:a1e0::1", "other"],
    ]
    for (const [text, expected] of cases) assert.strictEqual(classOf(text), expected, text)
  })

  it("keeps the address as written, trimmed of nothing", () => {
    assert.deepStrictEqual(
      Listen.parse("--listen", "100.84.135.127"),
      Result.succeed({ ip: "100.84.135.127", class: "tailnet" }),
    )
  })

  it("refuses hostnames, link-local, scoped and IPv4-mapped addresses with ListenInvalid", () => {
    for (const text of [
      "localhost",
      "hush.example.ts.net",
      "127.1",
      "010.0.0.1",
      "[::1]",
      "127.0.0.1:7787",
      "fe80::1",
      "febf::1",
      "fe80::1%eth0",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:6454:877f",
      "",
    ])
      assert.deepStrictEqual(
        Listen.parse("HUSH_LISTEN", text),
        Result.fail(new ListenInvalid({ source: "HUSH_LISTEN", value: text })),
        text,
      )
  })

  it("never classifies an IPv4 literal outside 127/8 and 100.64/10 as allowed, except the wildcard as wildcard", () => {
    fc.assert(
      fc.property(fc.ipV4(), (ip) => {
        const [a = 0, b = 0] = ip.split(".").map(Number)
        const expected =
          ip === "0.0.0.0"
            ? "wildcard"
            : a === 127
              ? "loopback"
              : a === 100 && b >= 64 && b <= 127
                ? "tailnet"
                : "other"
        return classOf(ip) === expected
      }),
    )
  })
})

describe("Listen.allowed", () => {
  it("allows loopback and tailnet addresses only", () => {
    const ips = ["127.0.0.1", "::1", "100.64.0.1", "fd7a:115c:a1e0::1", "0.0.0.0", "::", "192.168.1.10", "fd00::1"]
    assert.deepStrictEqual(
      ips.map((ip) => Listen.allowed(address(ip))),
      [true, true, true, true, false, false, false, false],
    )
  })
})

describe("Listen.listeners", () => {
  it("binds 127.0.0.1 alone by default, never a wildcard", () => {
    assert.deepStrictEqual(Listen.listeners([]), [address("127.0.0.1")])
  })

  it("binds loopback first, then each --listen in order, once each", () => {
    assert.deepStrictEqual(
      Listen.listeners(["100.84.135.127", "::1", "127.0.0.1", "100.84.135.127"].map(address)),
      ["127.0.0.1", "100.84.135.127", "::1"].map(address),
    )
  })

  it("lets a wildcard replace the loopback listener", () => {
    assert.deepStrictEqual(Listen.listeners([address("0.0.0.0")]), [address("0.0.0.0")])
    assert.deepStrictEqual(Listen.listeners([address("::")]), [address("::")])
  })
})
