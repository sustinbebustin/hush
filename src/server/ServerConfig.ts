import { Result, Schema, SchemaGetter } from "effect"
import { resolve } from "node:path"

import { Listen, type ListenAddress } from "./Listen.js"
import { ConfigInvalid, type ListenInvalid, ListenNotAllowed, StateDirRequired } from "./StartupError.js"

// `hush server` flags and env into a validated config. A flag wins over its env var; a
// repeatable flag given at all replaces its env list.

export interface ServerConfig {
  // Absolute: `parse` resolves a relative path against the working directory.
  readonly stateDir: string
  // 0 asks for an ephemeral port per listener (tests only).
  readonly port: number
  // The `--listen` addresses in the order given, each allowed or opted in; `Listen.listeners` adds loopback.
  readonly listen: ReadonlyArray<ListenAddress>
  readonly allowAnyListen: boolean
  // Lowercase hostnames without a port, as the guard matches them against `Host`.
  readonly allowedHosts: ReadonlyArray<string>
}

// The raw flag values: undefined, false or empty when the flag was not given.
export interface ServerFlags {
  readonly stateDir: string | undefined
  readonly port: string | undefined
  readonly listen: ReadonlyArray<string>
  readonly allowAnyListen: boolean
  readonly allowedHost: ReadonlyArray<string>
}

export type ConfigError = StateDirRequired | ConfigInvalid | ListenInvalid | ListenNotAllowed

type Env = Readonly<Record<string, string | undefined>>

const defaultPort = 7787

// Decimal digits only, so `1e3` or ` 80` are refused rather than read as numbers.
const Port = Schema.String.check(Schema.isPattern(/^\d{1,5}$/)).pipe(
  Schema.decodeTo(Schema.NumberFromString.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
)

// An empty value counts as absent, as an empty `HUSH_STATE_DIR=` in a unit file means "unset".
const StateDirPath = Schema.NonEmptyString

// `HUSH_ALLOW_ANY_LISTEN`; an empty value counts as absent, like the other variables.
const AllowAnyListen = Schema.Literals(["true", "false", ""]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((text) => text === "true"),
    encode: SchemaGetter.transform((allow) => (allow ? "true" : "false")),
  }),
)

// DNS labels of letters, digits and inner hyphens; no port, no brackets.
const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

const decodePort = (source: string, text: string): Result.Result<number, ConfigInvalid> =>
  Result.mapError(
    Schema.decodeUnknownResult(Port)(text),
    () => new ConfigInvalid({ source, reason: "expected a port number from 0 to 65535" }),
  )

const decodeStateDir = (text: string | undefined): string | undefined =>
  Result.getOrUndefined(Schema.decodeUnknownResult(StateDirPath)(text))

// A comma-separated env list, each item trimmed. Empty or unset is no list.
const envList = (env: Env, name: string): Result.Result<ReadonlyArray<string>, ConfigInvalid> => {
  const text = env[name]

  if (text === undefined || text === "") return Result.succeed([])
  const items = text.split(",").map((item) => item.trim())

  return items.includes("")
    ? Result.fail(new ConfigInvalid({ source: name, reason: "the comma-separated list has an empty item" }))
    : Result.succeed(items)
}

// The flag's values when given, else the env list's, with the source to name in an error.
const listFrom = <Flag extends string, Name extends string>(
  flag: Flag,
  values: ReadonlyArray<string>,
  env: Env,
  name: Name,
): Result.Result<{ readonly source: Flag | Name; readonly items: ReadonlyArray<string> }, ConfigInvalid> =>
  values.length > 0
    ? Result.succeed({ source: flag, items: values })
    : Result.map(envList(env, name), (items) => ({ source: name, items }))

const decodeListen = (flags: ServerFlags, env: Env): Result.Result<ReadonlyArray<ListenAddress>, ConfigError> =>
  Result.flatMap(listFrom("--listen", flags.listen, env, "HUSH_LISTEN"), ({ source, items }) =>
    Result.all(items.map((item) => Listen.parse(source, item))),
  )

const decodeAllowedHosts = (flags: ServerFlags, env: Env): Result.Result<ReadonlyArray<string>, ConfigInvalid> =>
  Result.flatMap(listFrom("--allowed-host", flags.allowedHost, env, "HUSH_ALLOWED_HOSTS"), ({ source, items }) =>
    Result.all(
      items.map((item) => {
        const host = item.toLowerCase()

        return hostnamePattern.test(host)
          ? Result.succeed(host)
          : Result.fail(
              new ConfigInvalid({ source, reason: "expected a hostname without a port, such as hush.tail1234.ts.net" }),
            )
      }),
    ),
  )

const decodeAllowAnyListen = (flags: ServerFlags, env: Env): Result.Result<boolean, ConfigInvalid> => {
  if (flags.allowAnyListen || env.HUSH_ALLOW_ANY_LISTEN === undefined) return Result.succeed(flags.allowAnyListen)

  return Result.mapError(
    Schema.decodeUnknownResult(AllowAnyListen)(env.HUSH_ALLOW_ANY_LISTEN),
    () => new ConfigInvalid({ source: "HUSH_ALLOW_ANY_LISTEN", reason: "expected true or false" }),
  )
}

// `--state-dir`, else `HUSH_STATE_DIR`, made absolute; the Server and the host commands both need it.
const stateDir = (flag: string | undefined, env: Env): Result.Result<string, StateDirRequired> => {
  const given = decodeStateDir(flag) ?? decodeStateDir(env.HUSH_STATE_DIR)

  return given === undefined ? Result.fail(new StateDirRequired()) : Result.succeed(resolve(given))
}

const parse = (flags: ServerFlags, env: Env): Result.Result<ServerConfig, ConfigError> =>
  Result.gen(function* () {
    const directory = yield* stateDir(flags.stateDir, env)

    const port =
      flags.port !== undefined
        ? yield* decodePort("--port", flags.port)
        : env.HUSH_PORT !== undefined
          ? yield* decodePort("HUSH_PORT", env.HUSH_PORT)
          : defaultPort

    const listen = yield* decodeListen(flags, env)
    const allowAnyListen = yield* decodeAllowAnyListen(flags, env)
    const allowedHosts = yield* decodeAllowedHosts(flags, env)
    // The first address outside the allowed ranges, unless the Deployer opted in, so a LAN or
    // public bind is never accidental.
    const refused = allowAnyListen ? undefined : listen.find((address) => !Listen.allowed(address))

    if (refused !== undefined) return yield* Result.fail(new ListenNotAllowed({ ip: refused.ip }))

    return { stateDir: directory, port, listen, allowAnyListen, allowedHosts }
  })

export const ServerConfig = { defaultPort, parse, stateDir } as const
