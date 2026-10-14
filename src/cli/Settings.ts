import { Effect, Result } from "effect"

import type { ConfigInvalid, FileWriteFailed, ServerUrlInvalid } from "./CliError.js"
import { Config } from "./Config.js"
import type { EnvVars } from "./LaunchEnv.js"
import type { Mode } from "./Route.js"
import { type Source, Target } from "./Target.js"

// `hush config get` and `hush config set`:the CLI's own settings, with no Server request.

export interface Current {
  readonly server: string
  readonly proxy: Mode
  // Where each value came from.
  readonly source: { readonly server: Source; readonly proxy: Source }
}

export const get = (env: EnvVars): Effect.Effect<Current, ConfigInvalid | ServerUrlInvalid> =>
  Effect.flatMap(Config.load(env), (config) =>
    Effect.fromResult(
      Result.map(Target.settings(env, config), ({ server, proxy }) => ({
        server: server.origin,
        proxy: proxy.mode,
        source: { server: server.source, proxy: proxy.source },
      })),
    ),
  )

// Saves the Server URL as its origin, after the same check `HUSH_SERVER` gets.
export const setServer = (
  env: EnvVars,
  url: string,
): Effect.Effect<{ readonly server: string }, ConfigInvalid | ServerUrlInvalid | FileWriteFailed> =>
  Effect.gen(function* () {
    const server = yield* Effect.fromResult(Target.parseServer({ from: "argument" }, url))
    yield* Effect.flatMap(Config.load(env), (config) => Config.set(config, { server }))
    return { server }
  })

export const setProxy = (
  env: EnvVars,
  proxy: Mode,
): Effect.Effect<{ readonly proxy: Mode }, ConfigInvalid | FileWriteFailed> =>
  Effect.flatMap(Config.load(env), (config) => Config.set(config, { proxy })).pipe(Effect.as({ proxy }))

export * as Settings from "./Settings.js"
