import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { InitCode } from "../src/server/InitCode.js"
import { StartupError } from "../src/server/StartupError.js"

describe("InitCode.write", () => {
  // Root ignores directory modes, so the failure cannot be provoked there.
  it.effect.skipIf(process.geteuid?.() === 0)(
    "fails InitCodeWriteFailed naming the path and code when the state directory is not writable, writing nothing",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "hush-init-code-")))
        yield* Effect.promise(() => chmod(stateDir, 0o500))
        const error = yield* Effect.flip(InitCode.write(stateDir))
        assert.strictEqual(
          StartupError.render(error),
          `Could not write the Init code file ${join(stateDir, "init-code")} (EACCES); nothing else was changed. Check the state directory's owner and free space.`,
        )
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(stateDir)), [])
        yield* Effect.promise(() => chmod(stateDir, 0o700).then(() => rm(stateDir, { recursive: true })))
      }),
  )

  it("matches only the code whose digest it holds", () => {
    const expected = InitCode.digest("0123456789abcdef0123456789abcdef")
    assert.isTrue(InitCode.matches("0123456789abcdef0123456789abcdef", expected))
    assert.isFalse(InitCode.matches("0123456789abcdef0123456789abcdee", expected))
    assert.isFalse(InitCode.matches("", expected))
  })
})
