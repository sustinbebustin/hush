import { Data, Effect, Match } from "effect"
import { resolve } from "node:path"

import { Host } from "../server/Host.js"
import { ServerConfig } from "../server/ServerConfig.js"
import { StartupError, type StateDirRequired } from "../server/StartupError.js"
import type { TokenRevoked } from "../shared/Api.js"
import { CliError } from "./CliError.js"
import type { EnvVars } from "./LaunchEnv.js"

// `hush server revoke` and `hush server backup` as the command table calls them:the state directory from
// `--state-dir` or `HUSH_STATE_DIR`, the arguments parsed, one `Host` call; and the render of their errors.

export type HostCommandError = Host.HostError | StateDirRequired

// The raw flag and environment every host command reads its state directory from.
export interface Location {
  readonly stateDir: string | undefined
  readonly env: EnvVars
}

const stateDir = (location: Location) => Effect.fromResult(ServerConfig.stateDir(location.stateDir, location.env))

export const revoke = (input: Location & { readonly label: string }): Effect.Effect<TokenRevoked, HostCommandError> =>
  Effect.flatMap(stateDir(input), (directory) => Host.revoke(directory, input.label))

// What `hush server backup` did: wrote a new file, whose receipt goes to stdout, or streamed the bytes to stdout.
export type BackupOutcome = Data.TaggedEnum<{
  Written: { readonly receipt: Host.BackupReceipt }
  Streamed: {}
}>

export const BackupOutcome = Data.taggedEnum<BackupOutcome>()

// `file` is a new file to write, or `-` for stdout.
export const backup = (input: Location & { readonly file: string }): Effect.Effect<BackupOutcome, HostCommandError> =>
  Effect.flatMap(stateDir(input), (directory): Effect.Effect<BackupOutcome, Host.HostError> => {
    if (input.file === "-") return Effect.as(Host.backupToStdout(directory), BackupOutcome.Streamed())

    return Effect.map(Host.backupToFile(directory, resolve(input.file)), (receipt) =>
      BackupOutcome.Written({ receipt }),
    )
  })

// None of these names the Server's origin, which a host command never has.
const renderServer = (error: Parameters<typeof CliError.renderServer>[0]) => CliError.renderServer(error, "")

// Each error by the catalogue it belongs to: CLI errors in `CliError`, startup errors in the Server's `StartupError`.
export const render = (error: HostCommandError): string =>
  Match.valueTags(error, {
    StateDirRequired: StartupError.render,
    StatePermissionFailed: StartupError.render,
    DatabaseOpenFailed: StartupError.render,
    MigrationPending: StartupError.render,
    InvalidName: renderServer,
    TokenNotFound: renderServer,
    AuditUnavailable: renderServer,
    OutputExists: CliError.render,
    FileWriteFailed: CliError.render,
  })

export * as HostCommand from "./HostCommand.js"
