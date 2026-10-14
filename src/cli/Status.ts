import { Effect } from "effect"

import { Api, type ServerStateWire } from "../shared/Api.js"
import type { GuardError } from "../shared/ApiError.js"
import { Version } from "../shared/Version.js"
import { Client } from "./Client.js"
import type { RequestTooLarge, ServerUnreachable, UnexpectedResponse } from "./CliError.js"
import type { Target } from "./Target.js"

// `hush status`:one `GET /v1/status`, for reachability and version skew.

export interface Report {
  readonly server: string
  readonly state: ServerStateWire
  readonly serverVersion: string
  readonly cliVersion: string
  readonly api: number
}

export const run = (
  target: Target,
): Effect.Effect<Report, ServerUnreachable | UnexpectedResponse | RequestTooLarge | GuardError> =>
  Client.request(Api, target, (client) => client.public.status()).pipe(
    Effect.map((status) => ({
      server: target.origin,
      state: status.state,
      serverVersion: status.version,
      cliVersion: Version.current,
      api: status.api,
    })),
  )

export * as Status from "./Status.js"
