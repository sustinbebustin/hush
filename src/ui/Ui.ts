import { type CliRenderer, createCliRenderer, type KeyEvent, type PasteEvent } from "@opentui/core"
import { Clock, Effect, FiberSet, Queue } from "effect"

import { UiNeedsTerminal } from "../cli/CliError.js"
import type { Target } from "../cli/Target.js"
import { Display } from "./Display.js"
import { Event } from "./Event.js"
import { Interpreter } from "./Interpreter.js"
import { Reducer } from "./Reducer.js"
import { Screen } from "./Screen.js"
import { State } from "./State.js"
import { UiEffect } from "./UiEffect.js"

// `hush ui`: the loop that feeds renderer input to the reducer, draws each state and runs its effects. `run` takes
// the renderer, so tests pass OpenTUI's headless one; `launch` is the command, on the real terminal.

// OpenTUI's default exit signals but Windows' SIGBREAK, handled here instead of by the renderer (`launch` passes
// `exitSignals: []`), so the reducer Locks before the renderer is destroyed.
const exitSignals: ReadonlyArray<NodeJS.Signals> = [
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
  "SIGQUIT",
  "SIGABRT",
  "SIGPIPE",
  "SIGBUS",
]

// Listens for input, SIGTSTP, the exit signals and the renderer's destruction; on release, stops listening and
// destroys the renderer (which restores the terminal), then waits for it to finish.
const attach = (renderer: CliRenderer, send: (event: Event) => void) => {
  const onKey = (key: KeyEvent) => send(Event.Key({ key: Screen.key(key) }))
  const onPaste = (paste: PasteEvent) => send(Event.Paste({ text: Screen.pasted(paste) }))
  const onStop = () => send(Event.Suspend())
  const onDestroy = () => send(Event.Closed())

  return Effect.acquireRelease(
    Effect.sync(() => {
      renderer.keyInput.on("keypress", onKey)
      renderer.keyInput.on("paste", onPaste)
      process.on("SIGTSTP", onStop)

      for (const signal of exitSignals) process.on(signal, onDestroy)
      renderer.on("destroy", onDestroy)
    }),
    () =>
      Effect.promise(() => {
        renderer.keyInput.off("keypress", onKey)
        renderer.keyInput.off("paste", onPaste)
        process.off("SIGTSTP", onStop)

        for (const signal of exitSignals) process.off(signal, onDestroy)
        renderer.off("destroy", onDestroy)
        renderer.destroy()

        return renderer.closed
      }),
  )
}

// Stops this process as SIGTSTP would by default (its listener above replaces that), and waits for the SIGCONT that
// continues it, such as the shell's `fg`.
const stopUntilContinued = Effect.callback<void>((resume) => {
  const onContinue = () => resume(Effect.void)
  process.once("SIGCONT", onContinue)
  process.kill(process.pid, "SIGSTOP")

  return Effect.sync(() => process.off("SIGCONT", onContinue))
})

// Gives the terminal back while stopped, then takes it again and repaints the (Locked) state.
const suspend = (renderer: CliRenderer) =>
  Effect.promise(() => renderer.suspend()).pipe(
    Effect.andThen(stopUntilContinued),
    Effect.andThen(Effect.promise(() => renderer.resume())),
  )

const idleTickMillis = 1_000

// The idle clock: the wall clock every second, for the reducer's idle timeout.
const idleClock = (send: (event: Event) => Effect.Effect<boolean>) =>
  Effect.forever(
    Effect.sleep(idleTickMillis).pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((now) => send(Event.IdleTick({ now }))),
    ),
  )

// Runs the UI on `renderer` until the reducer quits; the renderer is destroyed when it returns.
export const run = (input: { readonly renderer: CliRenderer; readonly target: Target }): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { renderer, target } = input
      const events = yield* Queue.unbounded<Event>()
      yield* attach(renderer, (event) => Queue.offerUnsafe(events, event))
      // Released before the renderer: an answer still in flight is interrupted, never applied.
      const work = yield* FiberSet.make<void>()
      yield* FiberSet.run(work)(idleClock((event) => Queue.offer(events, event)))
      const screen = Screen.mount(renderer)
      let state = State.initial
      screen.draw(Display.of(state))

      for (;;) {
        const step = Reducer.reduce(state, yield* Queue.take(events))
        state = step.state
        screen.draw(Display.of(state))

        for (const effect of step.effects) {
          if (UiEffect.$is("Quit")(effect)) return

          if (UiEffect.$is("Suspend")(effect)) {
            yield* suspend(renderer)
            continue
          }

          yield* FiberSet.run(work)(
            Effect.flatMap(Interpreter.run(target, effect), (event) => Queue.offer(events, event)),
          )
        }
      }
    }),
  )

const notTerminal = (stdin: boolean, stdout: boolean): UiNeedsTerminal["stream"] | undefined => {
  if (!stdin && !stdout) return "stdin and stdout"

  if (!stdin) return "stdin"

  return stdout ? undefined : "stdout"
}

// `hush ui`: refuses unless stdin and stdout are terminals, then runs on the alternate screen. Ctrl-C reaches the
// reducer (`exitOnCtrlC` off) so quitting drops the Passphrase, and `run` owns the exit signals, so they Lock
// before the renderer is destroyed.
export const launch = (target: Target): Effect.Effect<void, UiNeedsTerminal> =>
  Effect.gen(function* () {
    const stream = notTerminal(process.stdin.isTTY, process.stdout.isTTY)

    if (stream !== undefined) return yield* new UiNeedsTerminal({ stream })

    const renderer = yield* Effect.promise(() =>
      createCliRenderer({ exitOnCtrlC: false, exitSignals: [], screenMode: "alternate-screen" }),
    )

    return yield* run({ renderer, target })
  })

export * as Ui from "./Ui.js"
