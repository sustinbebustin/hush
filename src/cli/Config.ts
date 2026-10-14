import { Effect, Schema } from "effect"
import { readFile } from "node:fs/promises"

import { PlatformCause } from "../shared/PlatformCause.js"
import { ConfigInvalid, FileWriteFailed } from "./CliError.js"
import type { EnvVars } from "./LaunchEnv.js"
import { PrivateFile } from "./PrivateFile.js"

// The CLI config file `~/.config/hush/config.json`:the Server URL and the proxy mode. Values are kept as
// written and checked where they are used (`Target`), so a bad value is reported with its source and stays
// replaceable by `hush config set`.

export const File = Schema.Struct({
  server: Schema.optionalKey(Schema.String),
  proxy: Schema.optionalKey(Schema.String),
})

export type File = typeof File.Type

export interface Loaded {
  readonly path: string
  // Empty when the file does not exist.
  readonly file: File
}

export const path = (env: EnvVars) => PrivateFile.path(env, "config.json")

export const load = (env: EnvVars): Effect.Effect<Loaded, ConfigInvalid> =>
  Effect.gen(function* () {
    const file = path(env)

    const text = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: (cause) => PlatformCause.codeOrUnknown(cause),
    }).pipe(
      Effect.map((content): string | undefined => content),
      Effect.catch((code) =>
        code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(new ConfigInvalid({ problem: { reason: "unreadable", path: file, code } })),
      ),
    )

    if (text === undefined) return { path: file, file: {} }

    const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError(() => new ConfigInvalid({ problem: { reason: "not-json", path: file } })),
    )

    const decoded = yield* Schema.decodeUnknownEffect(File)(json).pipe(
      Effect.mapError(() => new ConfigInvalid({ problem: { reason: "invalid", path: file } })),
    )

    return { path: file, file: decoded }
  })

// Writes `loaded` with `change` applied, keeping the other key as it was.
export const set = (loaded: Loaded, change: File): Effect.Effect<File, FileWriteFailed> => {
  const next: File = { ...loaded.file, ...change }

  return PrivateFile.write(loaded.path, `${JSON.stringify(next, null, 2)}\n`).pipe(
    Effect.mapError(({ code }) => new FileWriteFailed({ path: loaded.path, code, consequence: "config" })),
    Effect.as(next),
  )
}

export * as Config from "./Config.js"
