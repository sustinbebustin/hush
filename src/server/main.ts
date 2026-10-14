import { BunHttpServer } from "@effect/platform-bun"
import { Console, Context, Effect, Layer, Predicate, Ref, References, Schema } from "effect"
import { HttpServer } from "effect/http"
import { SqlClient, SqlError } from "effect/sql"

import { PlatformCause } from "../shared/PlatformCause.js"
import { Version } from "../shared/Version.js"
import { Database } from "./Database.js"
import { Http } from "./Http.js"
import { Listen, type ListenAddress } from "./Listen.js"
import { Locks } from "./Locks.js"
import { Log } from "./Log.js"
import { Passphrase } from "./Passphrase.js"
import { ServerConfig, type ServerFlags } from "./ServerConfig.js"
import { ServerState } from "./ServerState.js"
import { ListenAddressInUse, ListenAddressUnavailable, ListenFailed, type StartupError } from "./StartupError.js"
import { StateDir } from "./StateDir.js"

// `hush server`: config, listeners, state dir, database, state, startup line.

// Bun answers a larger body with an empty 413 before Effect runs (Effect's `MaxBodySize` is not honoured on Bun).
const maxRequestBodySize = 1_048_576

// Bun.serve throws synchronously inside the layer's constructor, so a bind failure arrives as a defect; one
// without a system code is not a bind failure and stays a defect.
const bindError =
  (ip: string, port: number) =>
  (cause: unknown): Effect.Effect<never, ListenAddressUnavailable | ListenAddressInUse | ListenFailed> => {
    const code = PlatformCause.code(cause)

    switch (code) {
      case undefined:
        return Effect.die(cause)
      case "EADDRNOTAVAIL":
        return Effect.fail(new ListenAddressUnavailable({ ip }))
      case "EADDRINUSE":
        return Effect.fail(new ListenAddressInUse({ ip, port }))
      default:
        return Effect.fail(new ListenFailed({ ip, port, code }))
    }
  }

// Binds one listener with an explicit hostname. Until `serve` installs the app, Bun's stub answers an
// empty 404, so nothing is served unguarded.
const bind = (address: ListenAddress, port: number) =>
  Layer.build(BunHttpServer.layer({ hostname: address.ip, port, maxRequestBodySize })).pipe(
    Effect.orDie,
    Effect.catchDefect(bindError(address.ip, port)),
    Effect.flatMap((context) => {
      const bound = Context.get(context, HttpServer.HttpServer).address

      return Predicate.isTagged(bound, "UnixPathAddress")
        ? Effect.die(new Error("the listener bound a unix socket"))
        : Effect.succeed({ ip: address.ip, port: bound.port, context })
    }),
  )

const cleartextWarning =
  "--allow-any-listen is in effect: Tokens and the Passphrase cross every listener outside loopback and the tailnet in cleartext. Publish or route those only to this host or the tailnet."

// Prints the startup line once every listener serves, then serves until interrupted. Fails only before the line.
export const run = (
  flags: ServerFlags,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<never, StartupError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* Effect.fromResult(ServerConfig.parse(flags, env))
      const addresses = Listen.listeners(config.listen)
      // Bound before the state dir is touched, so a failed bind creates nothing.
      const listeners = yield* Effect.forEach(addresses, (address) => bind(address, config.port))
      yield* StateDir.prepare(config.stateDir)
      const sql = yield* Database.open(config.stateDir)

      const state = yield* ServerState.load(config.stateDir).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchIf(
          (error): error is SqlError.SqlError | Schema.SchemaError =>
            SqlError.isSqlError(error) || Schema.isSchemaError(error),
          (error) => Effect.fail(Database.openFailed(config.stateDir)(error)),
        ),
      )

      // Built once and shared by every listener.
      const services = Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, sql),
        Layer.succeed(ServerState.Current, yield* Ref.make(state)),
        Layer.succeed(Locks.Service, yield* Locks.make),
        Layer.succeed(Passphrase.Attempts, yield* Passphrase.makeAttempts),
      )

      const app = Http.app(config).pipe(Layer.provide(services))
      yield* Effect.forEach(listeners, ({ context }) =>
        Layer.build(app.pipe(Layer.provide(Layer.succeedContext(context)))).pipe(Effect.orDie),
      )

      // Logged only once serving, so a failed start prints nothing but its error line.
      if (config.allowAnyListen)
        yield* Log.write({
          event: "cleartext-listen",
          addresses: addresses.filter((address) => !Listen.allowed(address)).map(({ ip }) => ip),
          message: cleartextWarning,
        })

      if (ServerState.$is("Uninitialised")(state))
        yield* Log.write({
          event: "init-code-written",
          path: state.initCodeFile,
          readWith: `cat ${state.initCodeFile}`,
          next: "hush init",
        })

      const listening = {
        event: "listening",
        version: Version.current,
        state: ServerState.wire(state),
        addresses: listeners.map(({ ip, port }) => ({ ip, port })),
        allowAnyListen: config.allowAnyListen,
      }

      yield* Console.log(
        JSON.stringify(
          ServerState.$match(state, {
            Ready: () => listening,
            Uninitialised: ({ initCodeFile }) => ({ ...listening, initCodeFile }),
          }),
        ),
      )

      return yield* Effect.never
    }),
  ).pipe(
    // Stray library logs must never reach stdout, which carries only the startup line.
    Effect.provideService(References.LogToStderr, true),
  )

export * as Server from "./main.js"
