import { type Array as Arr, Effect, Fiber, type PlatformError, Stdio, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { PlatformCause } from "../shared/PlatformCause.js"
import { ChildFailed, ChildNotFound, ChildSignalled } from "./CliError.js"
import type { Snapshot } from "./LaunchEnv.js"
import { Mask } from "./Mask.js"

// The child of `run` and `env run`: no shell, argv unchanged, stdin inherited, and
// `detached: false`, so it keeps the controlling terminal and gets Ctrl-C as SIGINT. Its environment is exactly
// `env` (`extendEnv: false`). A stream that is not a TTY is piped through `Mask` when there is anything to mask.

export type ChildError = ChildNotFound | ChildSignalled | ChildFailed

// Effect reports a signal death only as this message.
const signalMessage = /^Process interrupted due to receipt of signal: '(SIG[A-Z0-9]+)'$/

// Maps a spawner failure for `command` (the executable as given): ENOENT on spawn is not found, a failed exit
// code read is a signal death, anything else a generic failure whose details are suppressed.
export const failure = (command: string, error: PlatformError.PlatformError): ChildError => {
  const { method, cause } = error.reason

  if (method === "spawn" && PlatformCause.code(cause) === "ENOENT") return new ChildNotFound({ command })

  if (method === "exitCode")
    return new ChildSignalled({
      command,
      signal: signalMessage.exec(PlatformCause.message(cause) ?? "")?.[1] ?? "unknown",
    })

  return new ChildFailed({ command })
}

const masked = <E>(stream: Stream.Stream<Uint8Array, E>, values: ReadonlyArray<string>) =>
  Stream.suspend(() => {
    const mask = Mask.make(values)

    return stream.pipe(
      Stream.map(mask.push),
      Stream.concat(Stream.sync(() => mask.end())),
      Stream.filter((chunk) => chunk.length > 0),
    )
  })

// Runs `command` to completion and returns its exit code, after piped output has drained. `conceal` holds the
// values to mask; `Mask` keeps those of at least 8 bytes.
export const run = (command: Arr.NonEmptyReadonlyArray<string>, env: Snapshot, conceal: ReadonlyArray<string>) => {
  const [file, ...args] = command

  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const masking = Mask.masked(conceal).length > 0
    const pipeStdout = masking && !(yield* stdio.stdoutIsTerminal)
    const pipeStderr = masking && !(yield* stdio.stderrIsTerminal)

    const handle = yield* spawner.spawn(
      ChildProcess.make(file, args, {
        env: { ...env },
        extendEnv: false,
        detached: false,
        stdin: "inherit",
        stdout: pipeStdout ? "pipe" : "inherit",
        stderr: pipeStderr ? "pipe" : "inherit",
      }),
    )

    // Copies a piped stream to hush's own, masked; an inherited one has nothing to copy.
    const pump = (piped: boolean, from: typeof handle.stdout, to: ReturnType<typeof stdio.stdout>) =>
      Effect.forkScoped(piped ? Stream.run(masked(from, conceal), to) : Effect.void)

    const stdout = yield* pump(pipeStdout, handle.stdout, stdio.stdout())
    const stderr = yield* pump(pipeStderr, handle.stderr, stdio.stderr())
    yield* Fiber.join(stdout)
    yield* Fiber.join(stderr)
    const code: number = yield* handle.exitCode

    return code
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => failure(file, error)),
  )
}

export * as Child from "./Child.js"
