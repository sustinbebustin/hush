import { Effect } from "effect"
import { timingSafeEqual } from "node:crypto"
import { chmod, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { PlatformCause } from "../shared/PlatformCause.js"
import { Crypto } from "./Crypto.js"
import { InitCodeWriteFailed, StatePermissionFailed } from "./StartupError.js"

// The one-time Init code: 16 random bytes as 32 lowercase hex, written at each Uninitialised
// start to `<state-dir>/init-code` (0600) and held in memory only as its SHA-256 digest. Never logged.

export const path = (stateDir: string) => join(stateDir, "init-code")

const utf8 = new TextEncoder()

export const digest = (code: string): Crypto.Bytes => Crypto.sha256(utf8.encode(code))

// Constant-time: both sides are 32-byte digests, so `timingSafeEqual` never throws on a length mismatch.
export const matches = (candidate: string, expected: Uint8Array): boolean =>
  timingSafeEqual(digest(candidate), expected)

// Writes a fresh code by temp file (0600, exclusive create) and rename, so the file is never partial or wider
// than 0600, and returns its digest.
export const write = (stateDir: string): Effect.Effect<Crypto.Bytes, InitCodeWriteFailed> =>
  Effect.gen(function* () {
    const target = path(stateDir)
    const temp = `${target}.tmp`
    const code = Buffer.from(Crypto.randomBytes(16)).toString("hex")
    yield* Effect.tryPromise({
      try: async () => {
        await rm(temp, { force: true })
        await writeFile(temp, code, { flag: "wx", mode: 0o600 })
        // The umask only narrows, but a default ACL on the directory can widen the mode.
        await chmod(temp, 0o600)
        await rename(temp, target)
      },
      catch: (cause) => new InitCodeWriteFailed({ path: target, code: PlatformCause.codeOrUnknown(cause) }),
    }).pipe(Effect.tapError(() => Effect.promise(() => rm(temp, { force: true }).catch(() => undefined))))
    return digest(code)
  })

// Deletes the code file at `file` if present: after Init, and at every Ready start, so no code outlives
// Init.
export const remove = (file: string): Effect.Effect<void, StatePermissionFailed> =>
  Effect.tryPromise({
    try: () => rm(file, { force: true }),
    catch: (cause) =>
      new StatePermissionFailed({ operation: "delete", path: file, code: PlatformCause.codeOrUnknown(cause) }),
  })

export * as InitCode from "./InitCode.js"
