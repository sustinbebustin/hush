// The environment as the CLI's modules receive it: every variable set at start, each with its value.
export type Snapshot = Readonly<Record<string, string>>

// What a module that only reads variables accepts: a `Snapshot`, or a test's literal with some left unset.
export type EnvVars = Readonly<Record<string, string | undefined>>

// An immutable snapshot of `process.env` taken when the CLI starts, before the request route edits
// `NO_PROXY` in-process. Children of `run` get this snapshot, never the mutated environment.
export const snapshot: Snapshot = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])),
  ),
)

export * as LaunchEnv from "./LaunchEnv.js"
