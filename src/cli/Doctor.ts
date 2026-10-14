import { Duration, Effect, Result } from "effect"

import { Api, type Status } from "../shared/Api.js"
import type { GuardError } from "../shared/ApiError.js"
import { Version } from "../shared/Version.js"
import { Client } from "./Client.js"
import { CliError } from "./CliError.js"
import type { EnvVars } from "./LaunchEnv.js"
import type { Route, Unused } from "./Route.js"
import { type Source, Target } from "./Target.js"
import { TokenStore } from "./TokenStore.js"

// `hush doctor`: one `GET /v1/status` with no credential and
// the token file's health, reported with a note for each known first-run problem. Only what is safe to paste into
// a public issue: never the Server URL, Vault names, Labels, References or Tokens. It always exits 0.

export interface ServerCheck {
  readonly source: Source
  readonly route: "direct" | "proxy"
  // host:port only, never userinfo.
  readonly proxy: string | null
  readonly proxyUnused: Unused
  readonly reachable: boolean
  readonly state: Status["state"] | null
  readonly version: string | null
}

export type TokenCheck = TokenStore.Health

export interface Report {
  readonly hush: string
  readonly platform: string
  readonly bun: string
  // Null when the Server URL or proxy mode is invalid, so there was nothing to check.
  readonly server: ServerCheck | null
  readonly token: TokenCheck
  readonly notes?: ReadonlyArray<string>
}

export const report = (input: {
  readonly version: string
  readonly server: ServerCheck | null
  readonly token: TokenCheck
  readonly notes: ReadonlyArray<string>
}): Report => ({
  hush: input.version,
  platform: `${process.platform}-${process.arch}`,
  bun: Bun.version,
  server: input.server,
  token: input.token,
  ...(input.notes.length === 0 ? {} : { notes: input.notes }),
})

const statusTimeout = Duration.seconds(5)

// The notes, worded without the Server URL or any name.
const note = {
  uninitialised:
    "The Server is not initialised: a human reads the Init code from the Server's state directory (the `init-code` file; the Server's startup log prints its path) and runs `hush init --vault <name>`.",
  noToken:
    "No Token is available for this Server (HUSH_TOKEN unset, none saved for it): a human runs `hush token issue --read <vault>` with a Label, or sets HUSH_TOKEN.",
  unreachableDirect: (reason: string) =>
    `The Server did not answer a direct connection (${reason}): check ${CliError.directCheck} (\`hush config get\` shows which).`,
  unreachableProxy: (proxy: string, reason: string) =>
    `The Server did not answer through the loopback proxy at ${proxy} (${reason}): inside an agent sandbox, add the Server's IP:port (\`hush config get\` shows the Server) to the sandbox's allowed domains.`,
  proxyInUse: (proxy: string) =>
    `Requests go through the loopback proxy at ${proxy} (HTTP_PROXY); if this is not an agent sandbox's proxy it sees Tokens and the Passphrase in cleartext: set HUSH_PROXY=direct.`,
  notLoopback: "HTTP_PROXY is set but is not a loopback proxy, so hush connects directly.",
  disabled: CliError.proxyDisabled,
  versions: (server: string) =>
    `This CLI is version ${Version.current} but the Server is version ${server}; install the same version of both.`,
  insecure:
    "The token file ~/.config/hush/tokens.json can be read by other users: run `chmod 600 ~/.config/hush/tokens.json`, and Revoke its Token if it may have been copied.",
  invalid:
    "The token file ~/.config/hush/tokens.json cannot be read or is not a hush token file: fix or remove it, or set HUSH_TOKEN.",
  hostNotAllowed:
    "The Server refused the request's Host name: start it with `--allowed-host <the host name in HUSH_SERVER>` (or HUSH_ALLOWED_HOSTS), or point HUSH_SERVER at its IP address.",
  unexpected: (status: number) =>
    `The Server answered with something this CLI does not understand (HTTP ${status}); CLI and Server versions may differ.`,
} as const

// What the status request found, and the note for a failure.
type Probe =
  | { readonly _tag: "Answered"; readonly status: Status }
  | { readonly _tag: "Refused"; readonly note: string }
  | { readonly _tag: "Unreachable"; readonly note: string }

const probe = (target: Target): Effect.Effect<Probe> =>
  Client.request(Api, target, (client) => client.public.status(), undefined, statusTimeout).pipe(
    Effect.map((status): Probe => ({ _tag: "Answered", status })),
    Effect.catch((error): Effect.Effect<Probe> => {
      switch (error._tag) {
        case "ServerUnreachable":
          return Effect.succeed({
            _tag: "Unreachable",
            note:
              error.route._tag === "Proxy"
                ? note.unreachableProxy(error.route.proxy, error.reason)
                : note.unreachableDirect(error.reason),
          })
        case "UnexpectedResponse":
          return Effect.succeed({ _tag: "Refused", note: note.unexpected(error.status) })
        case "RequestTooLarge":
          return Effect.succeed({ _tag: "Refused", note: note.unexpected(413) })
        case "HostNotAllowed":
        case "FunnelRequestRefused":
        case "BrowserRequestRefused":
        case "UnsupportedContentType":
          return Effect.succeed({ _tag: "Refused", note: refusedNote(error) })
      }
    }),
  )

// A guard refusal of `status`; the Host itself is never shown, as it is part of the Server URL.
const refusedNote = (error: GuardError): string =>
  error._tag === "HostNotAllowed" ? note.hostNotAllowed : CliError.renderServer(error, "the Server")

const routeNotes = (route: Route): ReadonlyArray<string> => {
  switch (route._tag) {
    case "Proxy":
      return [note.proxyInUse(route.proxyDisplay)]
    case "Direct":
      switch (route.unused) {
        case "none":
          return []
        case "not-loopback":
          return [note.notLoopback]
        case "disabled":
          return [note.disabled]
      }
  }
}

const tokenNotes = (token: TokenCheck): ReadonlyArray<string> => {
  switch (token.file) {
    case "insecure":
      return [note.insecure]
    case "invalid":
      return [note.invalid]
    case "ok":
    case "missing":
      return token.source === "none" ? [note.noToken] : []
    case "not-read":
      return []
  }
}

const statusNotes = (status: Status): ReadonlyArray<string> => [
  ...(status.state === "uninitialised" ? [note.uninitialised] : []),
  ...(status.version === Version.current ? [] : [note.versions(status.version)]),
]

// The proxy as shown: the one in use or the one left unused, when there is one to show.
const shownProxy = (route: Route): string | null =>
  route._tag === "Direct" && route.unused === "none" ? null : (route.proxyDisplay ?? null)

const checkServer = (
  target: Target,
): Effect.Effect<{ readonly check: ServerCheck; readonly notes: ReadonlyArray<string> }> =>
  Effect.map(probe(target), (found) => {
    const { route } = target
    const status = found._tag === "Answered" ? found.status : undefined

    return {
      check: {
        source: target.source,
        route: route._tag === "Proxy" ? "proxy" : "direct",
        proxy: shownProxy(route),
        proxyUnused: route._tag === "Proxy" ? "none" : route.unused,
        reachable: found._tag !== "Unreachable",
        state: status?.state ?? null,
        version: status?.version ?? null,
      },
      // The failure first, as the likeliest cause of whatever brought the agent here.
      notes: [
        ...(found._tag === "Answered" ? [] : [found.note]),
        ...routeNotes(route),
        ...(status === undefined ? [] : statusNotes(status)),
      ],
    }
  })

export const run = (env: EnvVars): Effect.Effect<Report> =>
  Effect.gen(function* () {
    const target = yield* Effect.result(Target.load(env))
    const token = yield* TokenStore.health(Result.isSuccess(target) ? target.success.origin : undefined, env)

    if (Result.isFailure(target))
      return report({ version: Version.current, server: null, token, notes: [CliError.render(target.failure)] })
    const server = yield* checkServer(target.success)

    return report({
      version: Version.current,
      server: server.check,
      token,
      notes: [...server.notes, ...tokenNotes(token)],
    })
  })

export * as Doctor from "./Doctor.js"
