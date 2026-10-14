import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"

import { Backoff } from "../src/server/Backoff.js"

// Reserves `n` attempts at `nowMs`, as `n` wrong Passphrases arriving at once would.
const reserveTimes = (n: number, nowMs: number) => {
  let state = Backoff.initial

  for (let attempt = 0; attempt < n; attempt += 1) state = Result.getOrThrow(Backoff.reserve(state, nowMs))

  return state
}

describe("Backoff.delaySeconds", () => {
  it("gives three free failures, then doubles from 1 s, capped at 15 minutes", () => {
    const schedule = [0, 1, 2, 3, 4, 5, 6, 13, 14, 15, 100].map(Backoff.delaySeconds)
    assert.deepStrictEqual(schedule, [0, 0, 0, 0, 1, 2, 4, 512, 900, 900, 900])
  })
})

describe("Backoff.reserve", () => {
  it("lets the first three attempts through at once, then refuses the fourth's successor until notBefore", () => {
    const afterFour = reserveTimes(4, 10_000)
    assert.deepStrictEqual(afterFour, { failures: 4, notBeforeMs: 11_000 })
    assert.deepStrictEqual(Backoff.reserve(afterFour, 10_000), Result.fail({ retryAfterSeconds: 1 }))
    assert.deepStrictEqual(Backoff.reserve(afterFour, 11_000), Result.succeed({ failures: 5, notBeforeMs: 13_000 }))
  })

  it("rounds the wait up to whole seconds", () => {
    const pinned = { failures: 10, notBeforeMs: 70_000 }
    assert.deepStrictEqual(Backoff.reserve(pinned, 5_001), Result.fail({ retryAfterSeconds: 65 }))
    assert.deepStrictEqual(Backoff.reserve(pinned, 69_999), Result.fail({ retryAfterSeconds: 1 }))
  })

  it("never sets a delay over 900 s, however many failures", () => {
    const state = Result.getOrThrow(Backoff.reserve({ failures: 50, notBeforeMs: 0 }, 1_000))
    assert.deepStrictEqual(state, { failures: 51, notBeforeMs: 901_000 })
  })
})

describe("Backoff.succeed", () => {
  it("clears the failures and the delay", () => {
    assert.deepStrictEqual(Backoff.succeed(), Backoff.initial)
    assert.deepStrictEqual(Backoff.initial, { failures: 0, notBeforeMs: 0 })
  })
})
