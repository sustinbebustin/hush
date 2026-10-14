import { Effect, type Redacted, Result } from "effect"

import { Api } from "../shared/Api.js"
import { Reference } from "../shared/Reference.js"
import { Client } from "./Client.js"
import { InvalidReference, UnexpectedResponse } from "./CliError.js"
import type { Target } from "./Target.js"
import type { EnvVars } from "./LaunchEnv.js"
import { TokenStore } from "./TokenStore.js"

// `hush read <reference>`:the last-resort explicit read. The Reference is parsed locally, so a
// malformed one makes no request; then one `secrets/resolve`. The caller writes the value byte-exact.
export const run = (target: Target, input: string, env: EnvVars) =>
  Effect.gen(function* () {
    const reference = yield* Effect.fromResult(
      Result.mapError(Reference.parse(input), ({ reason }) => new InvalidReference({ input, reason })),
    )

    const choice = yield* TokenStore.current(target, env, reference.vault)

    const { values } = yield* Client.request(
      Api,
      target,
      (client) => client.token.resolve({ payload: { references: [Reference.format(reference)] } }),
      choice.token,
    )

    const [resolved, ...rest] = values

    // One value per Reference sent; anything else is an answer this CLI does not understand.
    if (resolved === undefined || rest.length > 0)
      return yield* new UnexpectedResponse({ url: target.origin, status: 200 })
    const value: Redacted.Redacted<string> = resolved.value

    return value
  })

export * as Read from "./Read.js"
