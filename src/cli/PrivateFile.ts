import { Effect } from "effect"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { PlatformCause } from "../shared/PlatformCause.js"
import type { EnvVars } from "./LaunchEnv.js"

// The CLI's own files under `~/.config/hush` (the token file, the config file).

// The file `name` in `~/.config/hush`, under `HOME` (the OS home directory when unset).
export const path = (env: EnvVars, name: string) => join(env.HOME ?? homedir(), ".config", "hush", name)

// Why a write failed: the platform error code, `unknown` when there is none.
export interface WriteFailure {
  readonly code: string
}

// Writes `text` by temp file and rename: the directory is 0700 and the file 0600 at every moment, and a crash
// leaves either the old file or the new one.
export const write = (file: string, text: string): Effect.Effect<void, WriteFailure> => {
  const temp = `${file}.${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}.tmp`
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await chmod(dirname(file), 0o700)
      await writeFile(temp, text, { flag: "wx", mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, file)
    },
    catch: (cause) => ({ code: PlatformCause.codeOrUnknown(cause) }),
  }).pipe(Effect.tapError(() => Effect.promise(() => rm(temp, { force: true }).catch(() => undefined))))
}

export * as PrivateFile from "./PrivateFile.js"
