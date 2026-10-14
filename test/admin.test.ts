import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"
import * as fc from "fast-check"
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Admin } from "../src/cli/Admin.js"
import { CliError } from "../src/cli/CliError.js"
import { Route, UnusedProxy } from "../src/cli/Route.js"
import type { Target } from "../src/cli/Target.js"
import { Name } from "../src/shared/Name.js"
import { Token } from "../src/shared/Token.js"

const target: Target = {
  origin: "http://127.0.0.1:7787",
  source: "default",
  route: Route.Direct({ unused: UnusedProxy.None() }),
}

describe("Admin.tokenInput", () => {
  const anyToken = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(Token.format)
  const padding = fc.constantFrom("", " ", "\t", "\n", "\r\n")

  it("accepts a bare Token with surrounding whitespace, or a --print receipt holding it", () => {
    fc.assert(
      fc.property(anyToken, padding, padding, (token, before, after) => {
        assert.deepStrictEqual(Admin.tokenInput(`${before}${token}${after}`), Result.succeed(token))
        const receipt = JSON.stringify({ label: "agent", grants: [], expiresAt: null, revokedOnServer: false, token })
        assert.deepStrictEqual(Admin.tokenInput(`${before}${receipt}${after}`), Result.succeed(token))
      }),
    )
  })

  it("refuses anything else as TokenInputInvalid", () => {
    const token = Token.format(new Uint8Array(32).fill(1))

    for (const input of [
      "hush_short",
      `"${token}"`,
      `{"token":"hush_short"}`,
      `{"receipt":"${token}"}`,
      `[${JSON.stringify(token)}]`,
      `${token} ${token}`,
    ])
      assert.deepStrictEqual(Admin.tokenInput(input), Result.fail(new CliError.TokenInputInvalid()), input)
  })
})

describe("Admin.parseSince", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z")

  it("converts a duration back from now, or an ISO 8601 time, to the instant the Server compares", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["7d", "2026-10-06T12:00:00.000Z"],
      ["90m", "2026-10-13T10:30:00.000Z"],
      ["1w", "2026-10-06T12:00:00.000Z"],
      ["30s", "2026-10-13T11:59:30.000Z"],
      ["100000w", "1970-01-01T00:00:00.000Z"],
      ["2026-10-01", "2026-10-01T00:00:00.000Z"],
      ["2026-10-01T09:00Z", "2026-10-01T09:00:00.000Z"],
      ["2026-10-01T09:00:00+02:00", "2026-10-01T07:00:00.000Z"],
      ["2026-10-01T09:00:00.5Z", "2026-10-01T09:00:00.500Z"],
      ["2026-10-01T09:00:00.123Z", "2026-10-01T09:00:00.123Z"],
    ]

    for (const [since, instant] of cases) assert.deepStrictEqual(Admin.parseSince(since, now), Result.succeed(instant))
  })

  it("refuses anything else as AuditFlagsInvalid naming --since", () => {
    for (const since of [
      "",
      "7",
      "7y",
      "0d",
      "07d",
      "-7d",
      "yesterday",
      "2026-10-01T09:00",
      "2026-10-01 09:00Z",
      "1e3s",
    ])
      assert.deepStrictEqual(
        Admin.parseSince(since, now),
        Result.fail(new CliError.AuditFlagsInvalid({ problem: { flag: "since", input: since } })),
      )
  })
})

describe("Admin.auditQuery", () => {
  const none = { vault: undefined, label: undefined, since: undefined, limit: undefined, before: undefined }

  it("sends only the filters given, names as parsed", () => {
    assert.deepStrictEqual(Admin.auditQuery(none, 0), Result.succeed({}))
    assert.deepStrictEqual(
      Admin.auditQuery({ vault: "Work", label: "agent on box", since: "1s", limit: "1000", before: "42" }, 5_000),
      Result.succeed({
        vault: "Work",
        label: "agent on box",
        since: "1970-01-01T00:00:04.000Z",
        limit: 1000,
        before: 42,
      }),
    )
  })

  it("accepts --limit exactly from 1 to 1000 in plain digits", () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 2_000 }), (limit) => {
        const result = Admin.auditQuery({ ...none, limit: String(limit) }, 0)
        assert.strictEqual(Result.isSuccess(result), limit >= 1 && limit <= 1000)
      }),
    )

    for (const limit of ["01", "1.0", " 5", "1e2"])
      assert.isTrue(Result.isFailure(Admin.auditQuery({ ...none, limit }, 0)), limit)
  })
})

describe("Admin.saveIssued", () => {
  it.effect.skipIf(process.getuid?.() === 0)(
    "reports an issued Token it cannot save as TokenNotSaved, telling the human to Revoke it, writing nothing",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "hush-admin-"))),
        (home) =>
          Effect.gen(function* () {
            // The home turned read-only after the pre-prompt check passed.
            yield* Effect.promise(() => chmod(home, 0o500))

            const error = yield* Effect.flip(
              Admin.saveIssued({
                target,
                label: Result.getOrThrow(Name.parse("agent on box")),
                token: Redacted.make(Token.format(new Uint8Array(32).fill(5))),
                replace: false,
                env: { HOME: home },
              }),
            )

            assert.strictEqual(error._tag, "TokenNotSaved")
            const file = join(home, ".config", "hush", "tokens.json")
            assert.strictEqual(
              CliError.render(error),
              `Token agent on box was issued but could not be saved to ${file} (EACCES) and cannot be shown again. Revoke it with \`hush token revoke "agent on box"\` and issue a new one.`,
            )
            assert.deepStrictEqual(yield* Effect.promise(() => readdir(home)), [])
          }),
        (home) => Effect.promise(() => chmod(home, 0o700).then(() => rm(home, { recursive: true, force: true }))),
      ),
  )
})

describe("Admin.deliverIssued", () => {
  const issuedToken = Token.format(new Uint8Array(32).fill(7))

  it.effect.skipIf(process.getuid?.() === 0)(
    "reports a Token issued by `token issue` that it cannot save as TokenNotSaved, never returning the Token",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "hush-admin-"))),
        (home) =>
          Effect.gen(function* () {
            // The home turned read-only after the pre-prompt check passed and the Server issued the Token.
            yield* Effect.promise(() => chmod(home, 0o500))

            const error = yield* Effect.flip(
              Admin.deliverIssued({
                target,
                issued: {
                  token: Redacted.make(issuedToken),
                  label: "work agent",
                  grants: [{ vault: "Work", access: "read" }],
                  createdAt: "2026-10-13T00:00:00.000Z",
                  expiresAt: null,
                  replaced: false,
                },
                label: Result.getOrThrow(Name.parse("work agent")),
                delivery: Admin.Delivery.Save({ replace: false }),
                env: { HOME: home },
              }),
            )

            assert.strictEqual(error._tag, "TokenNotSaved")
            const message = CliError.render(error)
            assert.include(message, 'Revoke it with `hush token revoke "work agent"`')
            assert.notInclude(message, issuedToken)
            assert.notInclude(JSON.stringify(error), issuedToken)
            assert.deepStrictEqual(yield* Effect.promise(() => readdir(home)), [])
          }),
        (home) => Effect.promise(() => chmod(home, 0o700).then(() => rm(home, { recursive: true, force: true }))),
      ),
  )
})
