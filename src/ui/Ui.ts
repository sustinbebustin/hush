import { type CliRenderer, createCliRenderer, type KeyEvent, type PasteEvent } from "@opentui/core"
import { Effect, FiberSet, Queue } from "effect"

import { UiNeedsTerminal } from "../cli/CliError.js"
import type { Target } from "../cli/Target.js"
import { Clipboard } from "./Clipboard.js"
import { Display } from "./Display.js"
import { Event } from "./Event.js"
import { Interpreter } from "./Interpreter.js"
import { Reducer } from "./Reducer.js"
import { Screen } from "./Screen.js"
import { State } from "./State.js"
import { UiEffect } from "./UiEffect.js"

// `hush ui`: the loop that feeds renderer input to the reducer, draws each state and runs its effects. `run` takes
// the renderer, so tests pass OpenTUI's headless one; `launch` is the command, on the real terminal.

// Listens for input and the renderer's destruction; on release, stops listening and destroys the renderer (which
// restores the terminal), then waits for it to finish.
const attach = (renderer: CliRenderer, send: (event: Event) => void) => {
  const onKey = (key: KeyEvent) => send(Event.Key({ key: Screen.key(key) }))
  const onPaste = (paste: PasteEvent) => send(Event.Paste({ text: Screen.pasted(paste) }))
  const onDestroy = () => send(Event.Closed())

  return Effect.acquireRelease(
    Effect.sync(() => {
      renderer.keyInput.on("keypress", onKey)
      renderer.keyInput.on("paste", onPaste)
      renderer.on("destroy", onDestroy)
    }),
    () =>
      Effect.promise(() => {
        renderer.keyInput.off("keypress", onKey)
        renderer.keyInput.off("paste", onPaste)
        renderer.off("destroy", onDestroy)
        renderer.destroy()

        return renderer.closed
      }),
  )
}

// Runs the UI on `renderer` until the reducer quits; the renderer is destroyed when it returns.
export const run = (input: {
  readonly renderer: CliRenderer
  readonly target: Target
  readonly clipboard: Clipboard
}): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { renderer, target, clipboard } = input
      const events = yield* Queue.unbounded<Event>()
      yield* attach(renderer, (event) => Queue.offerUnsafe(events, event))
      // Released before the renderer: an answer still in flight is interrupted, never applied.
      const work = yield* FiberSet.make<void>()
      const screen = Screen.mount(renderer)
      let state = State.initial
      screen.draw(Display.of(state))

      for (;;) {
        const step = Reducer.reduce(state, yield* Queue.take(events))
        state = step.state
        screen.draw(Display.of(state))

        for (const effect of step.effects) {
          if (UiEffect.$is("Quit")(effect)) return

          yield* FiberSet.run(work)(
            Effect.flatMap(Interpreter.run(target, effect, clipboard), (event) => Queue.offer(events, event)),
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
// reducer (`exitOnCtrlC` off) so quitting drops the Passphrase; the default exit signals destroy the renderer,
// which the reducer sees as `Closed`. The host clipboard lives as long as the UI.
export const launch = (target: Target): Effect.Effect<void, UiNeedsTerminal> =>
  Effect.scoped(
    Effect.gen(function* () {
      const stream = notTerminal(process.stdin.isTTY, process.stdout.isTTY)

      if (stream !== undefined) return yield* new UiNeedsTerminal({ stream })
      const clipboard = yield* Clipboard.host(process.platform, process.env)

      const renderer = yield* Effect.promise(() =>
        createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" }),
      )

      return yield* run({ renderer, target, clipboard })
    }),
  )

export * as Ui from "./Ui.js"
