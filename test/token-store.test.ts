import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Name } from "../src/shared/Name.js"
import { Token } from "../src/shared/Token.js"
import { TokenStore } from "../src/cli/TokenStore.js"
import type { Target } from "../src/cli/Target.js"

const target: Target = { origin: "http://127.0.0.1:7787", source: "default", route: { _tag: "Direct", unused: "none" } }
const other = "http://100.64.0.1:7787"
const token = (fill: number) => Token.format(new Uint8Array(32).fill(fill))
const label = (text: string) => Result.getOrThrow(Name.parse(text))

const withHome = <A, E>(test: (home: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "hush-tokens-"))),
    test,
    (home) => Effect.promise(() => chmod(home, 0o700).then(() => rm(home, { recursive: true, force: true }))),
  )

const dir = (home: string) => join(home, ".config", "hush")
const file = (home: string) => join(dir(home), "tokens.json")

const writeTokens = (home: string, content: unknown, mode = 0o600) =>
  Effect.promise(async () => {
    await mkdir(dir(home), { recursive: true, mode: 0o700 })
    await writeFile(file(home), typeof content === "string" ? content : JSON.stringify(content), { mode })
    await chmod(file(home), mode)
  })

// Another origin's entry, then this origin's.
const entries = {
  version: 1,
  tokens: [
    { server: other, label: "elsewhere", token: token(2) },
    { server: target.origin, label: "me on box", token: token(1) },
  ],
} as const

const tag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (error) => error._tag)

const mode = (path: string) => Effect.promise(async () => ((await stat(path)).mode & 0o777).toString(8))

describe("TokenStore.current", () => {
  it.effect("uses HUSH_TOKEN, trimmed, and never opens the token file", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(dir(home), { recursive: true })
          // A FIFO with no writer: opening it would block the test until it times out.
          execFileSync("mkfifo", [file(home)])
        })
        const choice = yield* TokenStore.current(target, { HOME: home, HUSH_TOKEN: ` ${token(3)}\n` })
        assert.strictEqual(choice._tag, "Env")
        assert.strictEqual(Redacted.value(choice.token), token(3))
      }),
    ),
  )

  it.effect("refuses an invalid HUSH_TOKEN with TokenEnvInvalid, without trying the file", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* writeTokens(home, entries)
        assert.strictEqual(
          yield* tag(TokenStore.current(target, { HOME: home, HUSH_TOKEN: "hush_short" })),
          "TokenEnvInvalid",
        )
      }),
    ),
  )

  it.effect("treats an empty or blank HUSH_TOKEN as unset and uses this origin's file entry", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* writeTokens(home, entries)

        for (const value of ["", "  "]) {
          const choice = yield* TokenStore.current(target, { HOME: home, HUSH_TOKEN: value })
          assert.strictEqual(choice._tag, "Saved")

          if (choice._tag !== "Saved") return
          assert.strictEqual(choice.label, "me on box")
          assert.strictEqual(Redacted.value(choice.token), token(1))
        }
      }),
    ),
  )

  it.effect("is NoToken with no file, and with no entry for this origin", () =>
    withHome((home) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* tag(TokenStore.current(target, { HOME: home })), "NoToken")
        yield* writeTokens(home, { version: 1, tokens: [{ server: other, label: "x", token: token(2) }] })
        assert.strictEqual(yield* tag(TokenStore.current(target, { HOME: home })), "NoToken")
      }),
    ),
  )

  for (const [name, content] of [
    ["not JSON", "{"],
    ["another version", { version: 2, tokens: [] }],
    [
      "an entry with a malformed Token",
      { version: 1, tokens: [{ server: target.origin, label: "x", token: "hush_x" }] },
    ],
    [
      "two entries for one origin",
      {
        version: 1,
        tokens: [
          { server: target.origin, label: "a", token: token(1) },
          { server: target.origin, label: "b", token: token(2) },
        ],
      },
    ],
  ] as const)
    it.effect(`is TokenFileInvalid for a file holding ${name}`, () =>
      withHome((home) =>
        Effect.gen(function* () {
          yield* writeTokens(home, content)
          assert.strictEqual(yield* tag(TokenStore.current(target, { HOME: home })), "TokenFileInvalid")
        }),
      ),
    )

  it.effect.skipIf(process.getuid?.() === 0)("is TokenFileInvalid for an unreadable file", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* writeTokens(home, entries, 0o200)
        assert.strictEqual(yield* tag(TokenStore.current(target, { HOME: home })), "TokenFileInvalid")
      }),
    ),
  )

  it.effect("is TokenFileInsecure, naming the mode and the chmod fix, when group or other bits are set", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* writeTokens(home, entries, 0o640)
        const error = yield* Effect.flip(TokenStore.current(target, { HOME: home }))
        assert.deepInclude(error, { _tag: "TokenFileInsecure", path: file(home), mode: "640" })
      }),
    ),
  )
})

describe("TokenStore.checkSavable and save", () => {
  const entry = { server: target.origin, label: label("me on box"), token: Redacted.make(token(4)) }

  it.effect("saves into a new 0700 directory and 0600 file, keeping other origins' entries", () =>
    withHome((home) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* TokenStore.checkSavable(target, false, { HOME: home }), { existing: undefined })
        assert.deepStrictEqual(yield* TokenStore.save(entry, false, { HOME: home }, "issue"), {
          replaced: undefined,
          path: file(home),
        })
        assert.strictEqual(yield* mode(dir(home)), "700")
        assert.strictEqual(yield* mode(file(home)), "600")
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(dir(home))), ["tokens.json"])
        assert.deepStrictEqual(JSON.parse(yield* Effect.promise(() => readFile(file(home), "utf8"))), {
          version: 1,
          tokens: [{ server: target.origin, label: "me on box", token: token(4) }],
        })
      }),
    ),
  )

  it.effect("refuses an existing entry for this origin with TokenAlreadySaved unless replace is set", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* writeTokens(home, entries)
        const refused = yield* Effect.flip(TokenStore.checkSavable(target, false, { HOME: home }))
        assert.deepInclude(refused, { _tag: "TokenAlreadySaved", label: "me on box", command: "issue" })
        const given = yield* Effect.flip(TokenStore.save(entry, false, { HOME: home }, "save"))
        assert.deepInclude(given, { _tag: "TokenAlreadySaved", label: "me on box", command: "save" })
        assert.deepStrictEqual(yield* TokenStore.checkSavable(target, true, { HOME: home }), { existing: "me on box" })
        assert.deepStrictEqual(yield* TokenStore.save(entry, true, { HOME: home }, "issue"), {
          replaced: "me on box",
          path: file(home),
        })
        assert.deepStrictEqual(JSON.parse(yield* Effect.promise(() => readFile(file(home), "utf8"))), {
          version: 1,
          tokens: [
            { server: other, label: "elsewhere", token: token(2) },
            { server: target.origin, label: "me on box", token: token(4) },
          ],
        })
      }),
    ),
  )

  it.effect.skipIf(process.getuid?.() === 0)(
    "is FileWriteFailed for an unwritable home, before anything is written",
    () =>
      withHome((home) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => chmod(home, 0o500))
          const error = yield* Effect.flip(TokenStore.checkSavable(target, false, { HOME: home }))
          assert.deepInclude(error, { _tag: "FileWriteFailed", path: file(home) })
          assert.deepStrictEqual(yield* Effect.promise(() => readdir(home)), [])
        }),
      ),
  )

  it.effect.skipIf(process.getuid?.() === 0)("is FileWriteFailed for an unwritable token file", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* writeTokens(home, entries, 0o400)
        assert.strictEqual(yield* tag(TokenStore.checkSavable(target, true, { HOME: home })), "FileWriteFailed")
      }),
    ),
  )
})
