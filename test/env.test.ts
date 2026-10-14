import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { Env } from "../src/cli/Env.js"
import { COMPOSED_CAFE, DECOMPOSED_CAFE } from "./arbitraries.js"

const SENTINEL = "fictional-only-secret-line"

describe("Env.parseAssignment", () => {
  it("parses a secret reference", () => {
    assert.deepStrictEqual(
      Env.parseAssignment("OPENAI_API_KEY=hush://Personal/OpenAI API Key/credential"),
      Result.succeed({ name: "OPENAI_API_KEY", reference: "hush://Personal/OpenAI API Key/credential" }),
    )
  })

  it("rejects plaintext", () => {
    assert.deepStrictEqual(Env.parseAssignment("OPENAI_API_KEY=plaintext"), Result.fail({ reason: "reference-scheme" }))
  })

  it("rejects a 1Password reference", () => {
    assert.deepStrictEqual(
      Env.parseAssignment("OPENAI_API_KEY=op://Personal/OpenAI API Key/credential"),
      Result.fail({ reason: "op-reference" }),
    )
  })

  it("rejects a malformed hush:// reference with the Reference's reason", () => {
    assert.deepStrictEqual(Env.parseAssignment("KEY=hush://Work/Stripe"), Result.fail({ reason: "reference-segments" }))
    assert.deepStrictEqual(
      Env.parseAssignment("KEY=hush://Work/-Stripe/credential"),
      Result.fail({ reason: "reference-leading-dash" }),
    )
  })

  it("stores the Reference with NFC names", () => {
    assert.deepStrictEqual(
      Env.parseAssignment(`KEY=hush://${DECOMPOSED_CAFE}/Key/credential`),
      Result.succeed({ name: "KEY", reference: `hush://${COMPOSED_CAFE}/Key/credential` }),
    )
  })

  for (const input of ["=hush://v/i/f", "1BAD=hush://v/i/f", "NO_EQUALS"]) {
    it(`rejects ${JSON.stringify(input)} as not an assignment`, () => {
      assert.deepStrictEqual(Env.parseAssignment(input), Result.fail({ reason: "not-assignment" }))
    })
  }
})

describe("Env.render", () => {
  it("writes a deterministic reference file", () => {
    assert.strictEqual(
      Env.render([{ name: "OPENAI_API_KEY", reference: "hush://Personal/OpenAI API Key/credential" }]),
      "OPENAI_API_KEY=hush://Personal/OpenAI API Key/credential\n",
    )
  })
})

describe("Env.parse", () => {
  it("classifies each line of a template", () => {
    const content = [
      "# Development",
      "",
      "NODE_ENV=development",
      "export  API_KEY = 'hush://Work/Cloud API/credential'",
      SENTINEL,
      "=no-name",
    ].join("\r\n")

    assert.deepStrictEqual(
      Env.parse(content),
      Result.succeed([
        { _tag: "Verbatim", original: "# Development" },
        { _tag: "Verbatim", original: "" },
        { _tag: "Plain", original: "NODE_ENV=development", name: "NODE_ENV", value: "development" },
        {
          _tag: "Reference",
          original: "export  API_KEY = 'hush://Work/Cloud API/credential'",
          name: "API_KEY",
          reference: "hush://Work/Cloud API/credential",
        },
        { _tag: "Other", original: SENTINEL, line: 5 },
        { _tag: "Other", original: "=no-name", line: 6 },
      ]),
    )
  })

  it("fails a 1Password reference with its line number and never its text", () => {
    const result = Env.parse(["# ok", `TOKEN="op://Personal/${SENTINEL}/credential"`].join("\n"))
    assert.deepStrictEqual(result, Result.fail(new Env.LineInvalid({ line: 2, reason: "op-reference" })))
    assert.notInclude(JSON.stringify(result), SENTINEL)
  })

  it("fails an invalid hush:// value with its line number and reason code and never its text", () => {
    const cases = [
      [`TOKEN=hush://Work/${SENTINEL}`, "reference-segments"],
      [`TOKEN="hush://Work/${SENTINEL}/a/b"`, "reference-segments"],
      [`TOKEN=hush://Work/${SENTINEL}/`, "reference-empty"],
      [`TOKEN=hush://Work/-${SENTINEL}/credential`, "reference-leading-dash"],
      [`TOKEN=hush://Work/${SENTINEL}\u0085/credential`, "reference-control"],
    ] as const

    for (const [line, reason] of cases) {
      const result = Env.parse(["# ok", "PLAIN=value", line].join("\n"))
      assert.deepStrictEqual(result, Result.fail(new Env.LineInvalid({ line: 3, reason })))
      assert.notInclude(JSON.stringify(result), SENTINEL)
    }
  })
})

describe("Env.resolve", () => {
  it.effect("preserves ordinary lines and safely quotes resolved values", () =>
    Effect.gen(function* () {
      const result = yield* Env.resolve(
        [
          "# Development",
          "NODE_ENV=development",
          "OPENAI_API_KEY=hush://Personal/OpenAI API Key/credential",
          "not an assignment",
          "",
        ].join("\n"),
        () => Effect.succeed(['a "secret"\\\nwith lines\r\n']),
      )

      assert.deepStrictEqual(result, {
        content: [
          "# Development",
          "NODE_ENV=development",
          'OPENAI_API_KEY="a \\"secret\\"\\\\\\nwith lines\\r"',
          "not an assignment",
          "",
        ].join("\n"),
        count: 1,
      })
    }),
  )

  it.effect("resolves duplicate references once", () =>
    Effect.gen(function* () {
      let calls = 0

      const result = yield* Env.resolve(
        ["FIRST=hush://Personal/Shared/credential", "SECOND=hush://Personal/Shared/credential"].join("\n"),
        (references) =>
          Effect.sync(() => {
            calls += 1
            assert.deepStrictEqual(references, ["hush://Personal/Shared/credential"])

            return ["secret"]
          }),
      )

      assert.strictEqual(calls, 1)
      assert.strictEqual(result.count, 2)
    }),
  )

  it.effect("returns a template without references unchanged and never calls the resolver", () =>
    Effect.gen(function* () {
      const content = ["# nothing secret", "NODE_ENV=development", ""].join("\n")
      const result = yield* Env.resolve(content, () => Effect.die("the resolver must not be called"))
      assert.deepStrictEqual(result, { content, count: 0 })
    }),
  )

  it.effect("fails an op:// line before resolving anything", () =>
    Effect.gen(function* () {
      const error = yield* Env.resolve(["A=hush://v/i/f", "B=op://v/i/f"].join("\n"), () =>
        Effect.die("the resolver must not be called"),
      ).pipe(Effect.flip)

      assert.deepStrictEqual(error, new Env.LineInvalid({ line: 2, reason: "op-reference" }))
    }),
  )
})
