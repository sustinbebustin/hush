import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import * as fc from "fast-check"

import { Reference } from "../src/shared/Reference.js"
import { COMPOSED_CAFE, DECOMPOSED_CAFE, validName } from "./arbitraries.js"

const reason = (input: string) =>
  Result.match(Reference.parse(input), { onSuccess: () => "ok", onFailure: (e) => e.reason })

const roundTrip = (input: string) => Result.map(Reference.parse(input), Reference.format).pipe(Result.getOrUndefined)

// Widens the branded Names so expected values can be plain string literals.
const parsed = (input: string): { readonly vault: string; readonly item: string; readonly field: string } | undefined =>
  Result.getOrUndefined(Reference.parse(input))

describe("Reference.parse", () => {
  it("parses a Vault, Item and Field", () => {
    assert.deepStrictEqual(parsed("hush://Work/Stripe API Key/credential"), {
      vault: "Work",
      item: "Stripe API Key",
      field: "credential",
    })
  })

  it("treats ?, #, %, = and spaces as ordinary characters", () => {
    assert.deepStrictEqual(parsed("hush://My Vault/a?b#c%20=d/notes"), {
      vault: "My Vault",
      item: "a?b#c%20=d",
      field: "notes",
    })
  })

  it("requires exactly the lowercase hush:// scheme", () => {
    assert.strictEqual(reason("op://Work/Stripe/credential"), "scheme")
    assert.strictEqual(reason("HUSH://Work/Stripe/credential"), "scheme")
    assert.strictEqual(reason("hush:/Work/Stripe/credential"), "scheme")
    assert.strictEqual(reason("Work/Stripe/credential"), "scheme")
  })

  it("requires exactly three names", () => {
    assert.strictEqual(reason("hush://Work/Stripe"), "segments")
    assert.strictEqual(reason("hush://Work/Section/Stripe/credential"), "segments")
    assert.strictEqual(reason("hush://Work/Stripe/credential/"), "segments")
    assert.strictEqual(reason("hush://"), "segments")
  })

  it("refuses a segment that is not a valid name with the name's reason", () => {
    assert.strictEqual(reason("hush://Work//credential"), "empty")
    assert.strictEqual(reason("hush://Work/ Stripe/credential"), "whitespace-edge")
    assert.strictEqual(reason("hush://Work/-Stripe/credential"), "leading-dash")
    assert.strictEqual(reason("hush://Work/Str\tipe/credential"), "control")
    assert.strictEqual(reason(`hush://Work/${"a".repeat(129)}/credential`), "too-long")
  })
})

describe("Reference.format", () => {
  it("writes hush://vault/item/field with the stored display names", () => {
    assert.strictEqual(roundTrip("hush://Work/Stripe API Key/credential"), "hush://Work/Stripe API Key/credential")
  })

  it("writes NFC names", () => {
    assert.strictEqual(roundTrip(`hush://${DECOMPOSED_CAFE}/Key/credential`), `hush://${COMPOSED_CAFE}/Key/credential`)
  })

  it("is stable: formatting a parsed Reference parses back to the same Reference", () => {
    fc.assert(
      fc.property(validName, validName, validName, (vault, item, field) => {
        const formatted = roundTrip(`hush://${vault}/${item}/${field}`)

        return formatted !== undefined && roundTrip(formatted) === formatted
      }),
    )
  })
})
