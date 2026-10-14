import { assert, describe, it } from "@effect/vitest"

import { passphraseSentinel, scan, valueSentinel, type Sentinel } from "./leaks.js"

const token: Sentinel = { kind: "token", text: "hush_fictionalTokenSentinel" }

describe("leak scan", () => {
  it("finds a sentinel in raw and in JSON-escaped form", () => {
    const leaks = scan(
      [
        { target: "cli", text: `prefix ${valueSentinel.text} suffix` },
        { target: "server", text: JSON.stringify({ value: valueSentinel.text }) },
      ],
      [valueSentinel],
    )

    assert.deepStrictEqual(
      leaks.map(({ target }) => target),
      ["cli", "server"],
    )
  })

  it("reports nothing for clean targets", () => {
    assert.deepStrictEqual(scan([{ target: "cli", text: "{}" }], [valueSentinel, passphraseSentinel, token]), [])
  })

  it("lets the token file hold a Token but not a value or the Passphrase", () => {
    const leaks = scan(
      [{ target: "tokenFile", text: `${token.text} ${passphraseSentinel.text}` }],
      [token, passphraseSentinel],
    )

    assert.deepStrictEqual(leaks, [{ target: "tokenFile", sentinel: passphraseSentinel }])
  })

  it("scans the database for Tokens but not for proxy userinfo", () => {
    const userinfo: Sentinel = { kind: "proxyUserinfo", text: "u:p" }
    const leaks = scan([{ target: "database", text: `${token.text} u:p` }], [token, userinfo])
    assert.deepStrictEqual(leaks, [{ target: "database", sentinel: token }])
  })
})
