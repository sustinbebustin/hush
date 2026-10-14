import { Effect, Result, Schema } from "effect"

import { ConfigInvalid, ServerUrlInvalid } from "./CliError.js"
import { Config } from "./Config.js"
import type { EnvVars } from "./LaunchEnv.js"
import { Mode, Route } from "./Route.js"

// Which Server the CLI talks to and by which route. Each setting
// comes from the environment, else the config file, else its default.

export type Source = "env" | "config" | "default"

export interface Target {
  // `http://host[:port]`, no path; Tokens are keyed by it.
  readonly origin: string
  readonly source: Source
  readonly route: Route
}

// The settings behind a Target, each with where it came from (`hush config get`).
export interface Settings {
  readonly server: { readonly origin: string; readonly source: Source }
  readonly proxy: { readonly mode: Mode; readonly source: Source }
}

const defaultServer = "http://127.0.0.1:7787"

// An `http:` origin with a host and optional port only.
const parseServer = (source: ServerUrlInvalid["source"], text: string): Result.Result<string, ServerUrlInvalid> => {
  const invalid = (reason: string) => Result.fail(new ServerUrlInvalid({ source, reason }))
  const decoded = Schema.decodeUnknownResult(Schema.URLFromString)(text)
  if (Result.isFailure(decoded)) return invalid("not a URL")
  const url = decoded.success
  if (url.protocol !== "http:") return invalid("only http: is supported")
  if (url.username !== "" || url.password !== "") return invalid("it must not hold a user or password")
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return invalid("only a host and port are allowed")
  return Result.succeed(url.origin)
}

// Empty means unset, as for every hush variable.
const fromEnv = (env: EnvVars, name: string): string | undefined => {
  const value = env[name]
  return value === "" ? undefined : value
}

const server = (env: EnvVars, { path, file }: Config.Loaded): Result.Result<Settings["server"], ServerUrlInvalid> => {
  const variable = fromEnv(env, "HUSH_SERVER")
  if (variable !== undefined)
    return Result.map(parseServer({ from: "env" }, variable), (origin) => ({ origin, source: "env" }))
  if (file.server !== undefined)
    return Result.map(parseServer({ from: "config", path }, file.server), (origin) => ({ origin, source: "config" }))
  return Result.succeed({ origin: defaultServer, source: "default" })
}

type ModeSource = Extract<ConfigInvalid["problem"], { readonly reason: "proxy-mode" }>["source"]

const parseMode = (source: ModeSource, text: string): Result.Result<Mode, ConfigInvalid> =>
  Result.mapError(
    Schema.decodeUnknownResult(Mode)(text),
    () => new ConfigInvalid({ problem: { reason: "proxy-mode", source } }),
  )

const proxy = (env: EnvVars, { path, file }: Config.Loaded): Result.Result<Settings["proxy"], ConfigInvalid> => {
  const variable = fromEnv(env, "HUSH_PROXY")
  if (variable !== undefined)
    return Result.map(parseMode({ from: "env" }, variable), (mode) => ({ mode, source: "env" }))
  if (file.proxy !== undefined)
    return Result.map(parseMode({ from: "config", path }, file.proxy), (mode) => ({ mode, source: "config" }))
  return Result.succeed({ mode: "auto", source: "default" })
}

const settings = (env: EnvVars, config: Config.Loaded): Result.Result<Settings, ServerUrlInvalid | ConfigInvalid> =>
  Result.all({ server: server(env, config), proxy: proxy(env, config) })

const resolve = (env: EnvVars, config: Config.Loaded): Result.Result<Target, ServerUrlInvalid | ConfigInvalid> =>
  Result.map(settings(env, config), (current) => ({
    origin: current.server.origin,
    source: current.server.source,
    route: Route.select(current.proxy.mode, env),
  }))

// The Target from the launch environment and the config file.
const load = (env: EnvVars): Effect.Effect<Target, ServerUrlInvalid | ConfigInvalid> =>
  Effect.flatMap(Config.load(env), (config) => Effect.fromResult(resolve(env, config)))

export const Target = { defaultServer, parseServer, settings, resolve, load } as const
