import { Context, Data, Effect, Ref, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import type { ServerStateWire } from "../shared/Api.js"
import type { Crypto } from "./Crypto.js"
import { InitCode } from "./InitCode.js"
import { Meta } from "./Meta.js"
import type { InitCodeWriteFailed, MetaInvalid, StatePermissionFailed } from "./StartupError.js"

// Uninitialised or Ready: a `meta` row at start means Ready. Held in one Ref that only Init
// changes.
export type ServerState = Data.TaggedEnum<{
  // `initCodeDigest` is the SHA-256 of the code in `initCodeFile`, the absolute path Init deletes.
  Uninitialised: { readonly initCodeDigest: Crypto.Bytes; readonly initCodeFile: string }
  Ready: {}
}>

// Destructured, not spread: `Data.taggedEnum` returns a Proxy with no own keys, so a spread copies nothing.
const { Uninitialised, Ready, $is, $match } = Data.taggedEnum<ServerState>()

class Current extends Context.Service<Current, Ref.Ref<ServerState>>()("hush/ServerState/Current") {}

const MetaCount = Schema.Tuple([Schema.Struct({ count: Schema.Number })])

// The state at start: with a `meta` row Ready once the row decodes, deleting any stale code file, so no code
// outlives Init; without one Uninitialised, with a new code written.
const load = (
  stateDir: string,
): Effect.Effect<
  ServerState,
  SqlError.SqlError | Schema.SchemaError | MetaInvalid | InitCodeWriteFailed | StatePermissionFailed,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [{ count }] = yield* Schema.decodeUnknownEffect(MetaCount)(yield* sql`SELECT count(*) AS count FROM meta`)
    const initCodeFile = InitCode.path(stateDir)

    if (count > 0) {
      yield* Meta.check
      yield* InitCode.remove(initCodeFile)

      return Ready()
    }

    return Uninitialised({ initCodeDigest: yield* InitCode.write(stateDir), initCodeFile })
  })

const wire = (state: ServerState): ServerStateWire =>
  $match(state, {
    Ready: (): ServerStateWire => "ready",
    Uninitialised: (): ServerStateWire => "uninitialised",
  })

export const ServerState = { Uninitialised, Ready, $is, $match, Current, load, wire } as const
