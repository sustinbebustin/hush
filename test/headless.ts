import { createTestRenderer, TestRecorder, type MockInput } from "@opentui/core/testing"
import { Clock, Effect, Exit, Redacted } from "effect"

import { Target } from "../src/cli/Target.js"
import { Clipboard } from "../src/ui/Clipboard.js"
import { Ui } from "../src/ui/Ui.js"
import type { Call, Sandbox } from "./sandbox.js"

// The UI's seam beside `sandbox()`: the real UI entry point in this process, drawn by OpenTUI's headless test
// renderer and driven by its mock keyboard, against the sandbox's real Server (seeded through the CLI). The only
// things injected are the renderer, as in production, the host clipboard, and Effect's own Clock, moved forward for
// idle tests.

const settleTimeoutMs = 15_000
const pollMs = 20

export interface Headless {
  readonly keys: MockInput
  // The last committed frame, as text.
  readonly frame: () => string
  // Every frame committed since the UI started, as text: what a leak scan reads.
  readonly frames: () => ReadonlyArray<string>
  // Waits until the frame shows `text` and returns that frame.
  readonly waitFor: (text: string) => Promise<string>
  // Waits until the frame satisfies `predicate` and returns that frame.
  readonly waitUntil: (predicate: (frame: string) => boolean) => Promise<string>
  // Types `text` one key at a time.
  readonly type: (text: string) => Promise<void>
  // The sandbox Server's request log so far.
  readonly calls: () => Promise<ReadonlyArray<Call>>
  // Moves the UI's wall clock forward by `millis`; its timers still run in real time.
  readonly advanceClock: (millis: number) => void
  // Resolves with the UI's exit once it has ended.
  readonly ended: Promise<Exit.Exit<void, unknown>>
  readonly close: () => Promise<void>
}

// The real Clock, `skew()` milliseconds ahead.
const skewed = (skew: () => number): Clock.Clock => {
  const real = Effect.runSync(Clock.clockWith(Effect.succeed))
  const millis = () => real.currentTimeMillisUnsafe() + skew()
  const nanos = () => real.currentTimeNanosUnsafe() + BigInt(skew()) * 1_000_000n

  return {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (duration) => real.sleep(duration),
  }
}

// A host clipboard that records what is written to it and answers reads with what a test put on it, in place of
// the machine's.
export interface FakeClipboard {
  readonly clipboard: Clipboard
  readonly copies: () => ReadonlyArray<string>
  // What the next reads answer: `text`, or empty after `put(undefined)`.
  readonly put: (text: string | undefined) => void
  // How many reads the UI made.
  readonly reads: () => number
}

export const fakeClipboard = (): FakeClipboard => {
  const copies: Array<string> = []
  let content: string | undefined
  let reads = 0

  return {
    clipboard: {
      available: true,
      write: (text) =>
        Effect.sync(() => {
          copies.push(Redacted.value(text))

          return "written" as const
        }),
      read: Effect.sync(() => {
        reads += 1

        return content === undefined
          ? Clipboard.Pasted.Empty()
          : Clipboard.Pasted.Text({ text: Redacted.make(content) })
      }),
    },
    copies: () => copies,
    put: (text) => {
      content = text
    },
    reads: () => reads,
  }
}

export const headless = async (
  box: Sandbox,
  {
    width = 100,
    height = 30,
    server = box.server.url,
    // No host clipboard unless a test passes one, so a test never touches the machine's.
    clipboard = Clipboard.none,
  }: {
    readonly width?: number
    readonly height?: number
    // `HUSH_SERVER`: the sandbox's Server, or its proxy (`box.proxy.url`) to hold an answer in flight.
    readonly server?: string
    readonly clipboard?: Clipboard
  } = {},
): Promise<Headless> => {
  // `exitSignals: []` as `hush ui` runs it: the UI handles the exit signals itself.
  const setup = await createTestRenderer({ width, height, exitSignals: [] })
  const recorder = new TestRecorder(setup.renderer)
  recorder.rec()

  // The CLI's own resolution with the sandbox's settings; `direct` keeps any proxy of the test host out.
  const target = await Effect.runPromise(Target.load({ HOME: box.home, HUSH_SERVER: server, HUSH_PROXY: "direct" }))

  let skew = 0
  const clock = skewed(() => skew)

  const ended = Effect.runPromiseExit(
    Effect.provideService(Ui.run({ renderer: setup.renderer, target, clipboard }), Clock.Clock, clock),
  )

  const waitUntil = async (predicate: (frame: string) => boolean) => {
    const deadline = Date.now() + settleTimeoutMs

    for (;;) {
      if (!setup.renderer.isDestroyed) await setup.renderOnce()
      const frame = setup.captureCharFrame()

      if (predicate(frame)) return frame

      if (Date.now() > deadline)
        throw new Error(`no matching frame within ${settleTimeoutMs} ms; last frame:\n${frame}`)
      await new Promise((wait) => setTimeout(wait, pollMs))
    }
  }

  return {
    keys: setup.mockInput,
    frame: () => setup.captureCharFrame(),
    frames: () => recorder.recordedFrames.map(({ frame }) => frame),
    waitFor: (text) => waitUntil((frame) => frame.includes(text)),
    waitUntil,
    type: (text) => setup.mockInput.typeText(text),
    calls: box.calls,
    advanceClock: (millis) => {
      skew += millis
    },
    ended,
    close: async () => {
      recorder.stop()
      await setup.dispose()
      await ended
    },
  }
}
