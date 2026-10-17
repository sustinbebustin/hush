import { assert, describe, it } from "@effect/vitest"
import { Redacted } from "effect"
import * as fc from "fast-check"

import type { ItemMeta } from "../src/shared/Api.js"
import { Audit } from "../src/ui/Audit.js"
import { Event } from "../src/ui/Event.js"
import { Key } from "../src/ui/Key.js"
import { Problem } from "../src/ui/Problem.js"
import { Reducer } from "../src/ui/Reducer.js"
import { State, type Vault } from "../src/ui/State.js"
import { UiEffect } from "../src/ui/UiEffect.js"
import { View } from "../src/ui/View.js"

// The keys typed so far from `state`, one Key event each, and every effect they asked for.
const press = (state: State, ...keys: ReadonlyArray<Key>) =>
  keys.reduce<{ readonly state: State; readonly effects: ReadonlyArray<UiEffect> }>(
    (step, key) => {
      const next = Reducer.reduce(step.state, Event.Key({ key }))

      return { state: next.state, effects: [...step.effects, ...next.effects] }
    },
    { state, effects: [] },
  )

const typing = (text: string) => [...text].map(Key.char)

// What the effects asked for: the Vault of each Item request, else the effect's tag.
const asked = (effects: ReadonlyArray<UiEffect>) =>
  effects.map((effect) => (UiEffect.$is("ListItems")(effect) ? effect.vault : effect._tag))

const vault = (name: string, items: number): Vault => ({
  vault: name,
  items,
  activeTokens: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
})

const item = (title: string): ItemMeta => ({
  title,
  kind: "api-credential",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  fields: [{ label: "credential", concealed: true }],
})

// Open on Vaults Personal and Work, with Personal's Items answered.
const opened = (titles: ReadonlyArray<string> = []): State => {
  const checking = press(State.initial, ...typing("right"), Key.named("return")).state

  const open = Reducer.reduce(
    checking,
    Event.Unlocked({
      passphrase: Redacted.make("right"),
      vaults: [vault("Personal", titles.length), vault("Work", 0)],
    }),
  ).state

  return Reducer.reduce(open, Event.ItemsLoaded({ list: { vault: "Personal", items: titles.map(item), retired: [] } }))
    .state
}

// The titles the Item list shows.
const shown = (state: State): ReadonlyArray<string> | undefined => {
  if (!State.$is("Open")(state) || !View.$is("ItemList")(state.view)) return undefined
  const { items, filter } = state.view

  return View.Items.$is("Loaded")(items) ? View.visible(items.items, filter).map(({ title }) => title) : undefined
}

describe("Reducer from Locked", () => {
  it("sends the typed Passphrase on Enter and holds none of it while the check runs", () => {
    const { state, effects } = press(State.initial, ...typing("pässwörd"), Key.named("return"))

    assert.strictEqual(state._tag, "Locked")
    assert.isUndefined(State.passphrase(state))
    assert.strictEqual(effects.length, 1)
    const [sent] = effects
    assert.strictEqual(sent?._tag, "ListVaults")
    assert.strictEqual(sent?._tag === "ListVaults" ? Redacted.value(sent.passphrase) : undefined, "pässwörd")
  })

  it("erases one character with Backspace and sends nothing for an empty Passphrase", () => {
    const erased = press(State.initial, ...typing("ab"), Key.named("backspace"), Key.named("backspace"))
    assert.strictEqual(State.$is("Locked")(erased.state) ? erased.state.entered.length : -1, 0)

    const { state, effects } = press(erased.state, Key.named("return"))
    assert.deepStrictEqual(effects, [])
    assert.strictEqual(State.$is("Locked")(state) ? state.phase._tag : undefined, "Empty")
  })

  it("opens on the Server's Vault list and asks for the first Vault's Items with the same Passphrase", () => {
    const checking = press(State.initial, ...typing("right"), Key.named("return")).state

    const { state, effects } = Reducer.reduce(
      checking,
      Event.Unlocked({ passphrase: Redacted.make("right"), vaults: [vault("Personal", 2), vault("Work", 0)] }),
    )

    assert.strictEqual(state._tag, "Open")
    assert.strictEqual(Redacted.value(State.passphrase(state) ?? Redacted.make("")), "right")
    assert.deepStrictEqual(asked(effects), ["Personal"])
  })

  it("opens with no Item request when the Server has no Vault", () => {
    const checking = press(State.initial, ...typing("right"), Key.named("return")).state
    const unlocked = Event.Unlocked({ passphrase: Redacted.make("right"), vaults: [] })
    const { state, effects } = Reducer.reduce(checking, unlocked)

    assert.strictEqual(State.$is("Open")(state) ? state.view._tag : undefined, "NoVaults")
    assert.deepStrictEqual(effects, [])
  })

  it("counts a refusal's wait down one tick a second and stops at zero", () => {
    const checking = press(State.initial, ...typing("wrong"), Key.named("return")).state
    const backoff = Event.UnlockRefused({ problem: Problem.Backoff({ retryAfterSeconds: 2 }) })
    const refused = Reducer.reduce(checking, backoff)
    assert.deepStrictEqual(asked(refused.effects), ["After"])

    const once = Reducer.reduce(refused.state, Event.WaitTick({ attempt: 1 }))
    assert.deepStrictEqual(asked(once.effects), ["After"])

    const twice = Reducer.reduce(once.state, Event.WaitTick({ attempt: 1 }))
    assert.deepStrictEqual(twice.effects, [])

    const phase = State.$is("Locked")(twice.state) ? twice.state.phase : undefined
    assert.deepStrictEqual(phase, State.Phase.Refused({ problem: Problem.Backoff({ retryAfterSeconds: 0 }) }))
  })

  it("ignores a wait tick from an earlier attempt", () => {
    const first = press(State.initial, ...typing("a"), Key.named("return")).state
    const refused = Reducer.reduce(first, Event.UnlockRefused({ problem: Problem.Incorrect({ retryAfterSeconds: 5 }) }))
    const second = press(refused.state, ...typing("b"), Key.named("return")).state
    const again = Reducer.reduce(second, Event.UnlockRefused({ problem: Problem.Incorrect({ retryAfterSeconds: 9 }) }))

    assert.deepStrictEqual(Reducer.reduce(again.state, Event.WaitTick({ attempt: 1 })), {
      state: again.state,
      effects: [],
    })
  })

  it("types q into the prompt rather than quitting, and quits on Ctrl-C", () => {
    assert.deepStrictEqual(press(State.initial, Key.char("q")).effects, [])
    assert.deepStrictEqual(asked(press(State.initial, Key.named("c", { ctrl: true })).effects), ["Quit"])
  })
})

// Every key the UI binds, plus arbitrary typed text.
const anyKey: fc.Arbitrary<Key> = fc.oneof(
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 2 }).map(Key.char),
  fc.constantFrom(..."qjk/".split("").map(Key.char)),
  fc
    .constantFrom("return", "backspace", "escape", "up", "down", "tab", "pageup", "pagedown")
    .map((name) => Key.named(name)),
  fc.constantFrom(Key.named("c", { ctrl: true }), Key.named("d", { ctrl: true }), Key.named("x", { meta: true })),
)

const anyProblem: fc.Arbitrary<Problem> = fc.oneof(
  fc.nat({ max: 3 }).map((retryAfterSeconds) => Problem.Incorrect({ retryAfterSeconds })),
  fc.nat({ max: 3 }).map((retryAfterSeconds) => Problem.Backoff({ retryAfterSeconds })),
  fc.constant(Problem.Failed({ message: "The hush Server at http://127.0.0.1:7787 has not been initialised." })),
)

const vaultName = fc.constantFrom("Personal", "Work")

const anyAsk = fc.oneof(
  fc.constant(Audit.Ask.First({ filters: { vault: "", label: "", since: "" } })),
  fc.nat({ max: 3 }).map((before) => Audit.Ask.Next({ query: {}, before })),
)

// Every event but a correct Passphrase's answer (`Unlocked`).
const withoutUnlock: fc.Arbitrary<Event> = fc.oneof(
  anyKey.map((key) => Event.Key({ key })),
  fc.string().map((text) => Event.Paste({ text })),
  anyProblem.map((problem) => Event.UnlockRefused({ problem })),
  fc
    .tuple(vaultName, fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }))
    .map(([name, titles]) => Event.ItemsLoaded({ list: { vault: name, items: titles.map(item), retired: [] } })),
  fc.tuple(vaultName, anyProblem).map(([name, problem]) => Event.ItemsRefused({ vault: name, problem })),
  anyAsk.map((ask) => Event.AuditListed({ ask, query: {}, page: { entries: [], next: 1 } })),
  fc.tuple(anyAsk, anyProblem).map(([ask, problem]) => Event.AuditRefused({ ask, problem })),
  fc.nat({ max: 3 }).map((attempt) => Event.WaitTick({ attempt })),
  fc.constant(Event.Closed()),
)

const anyEvent: fc.Arbitrary<Event> = fc.oneof(
  { arbitrary: withoutUnlock, weight: 5 },
  {
    arbitrary: fc
      .subarray([vault("Personal", 1), vault("Work", 0)])
      .map((vaults) => Event.Unlocked({ passphrase: Redacted.make("held passphrase"), vaults })),
    weight: 1,
  },
)

// Every state a sequence passes through, with the effects of the step that reached it.
const run = (events: ReadonlyArray<Event>): ReadonlyArray<Reducer.Step> => {
  const steps: Array<Reducer.Step> = []

  for (const event of events) steps.push(Reducer.reduce(steps.at(-1)?.state ?? State.initial, event))

  return steps
}

const quits = ({ effects }: Reducer.Step) => effects.some(UiEffect.$is("Quit"))

describe("Reducer properties", () => {
  it("stays Locked through any events from Locked without a correct Passphrase", () => {
    fc.assert(
      fc.property(fc.array(withoutUnlock, { maxLength: 40 }), (events) => {
        for (const { state } of run(events)) {
          assert.strictEqual(state._tag, "Locked")
          assert.isUndefined(State.passphrase(state))
        }
      }),
    )
  })

  it("holds no Passphrase and an empty prompt after a quit from any state", () => {
    const quitting = fc.constantFrom(Event.Key({ key: Key.named("c", { ctrl: true }) }), Event.Closed())

    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 40 }), quitting, (events, last) => {
        const quitSteps = run([...events, last]).filter(quits)
        assert.isNotEmpty(quitSteps)

        for (const { state, effects } of quitSteps) {
          assert.isUndefined(State.passphrase(state))
          assert.strictEqual(State.$is("Locked")(state) ? state.entered.length : -1, 0)
          assert.deepStrictEqual(asked(effects), ["Quit"])
        }
      }),
    )
  })
})

describe("Reducer when Open", () => {
  it("asks for exactly one Item list when Enter selects the Vault under the cursor", () => {
    const { state, effects } = press(opened(), Key.named("down"), Key.named("return"))

    assert.deepStrictEqual(asked(effects), ["Work"])
    assert.deepStrictEqual(State.$is("Open")(state) ? state.view : undefined, View.loading("Work"))
  })

  it("keeps the cursor on the sidebar: the Vaults, then Audit", () => {
    const top = press(opened(), Key.named("up"))
    const bottom = press(opened(), Key.named("down"), Key.named("down"), Key.named("down"))

    assert.strictEqual(State.$is("Open")(top.state) ? top.state.cursor : undefined, 0)
    assert.strictEqual(State.$is("Open")(bottom.state) ? bottom.state.cursor : undefined, 2)
  })

  it("narrows the Item list by every word of the filter, ignoring case, as `hush find` matches titles", () => {
    const state = opened(["Stripe live key", "Stripe test key", "GitHub token"])
    const filtered = press(state, Key.char("/"), ...typing("KEY live"))

    assert.deepStrictEqual(shown(filtered.state), ["Stripe live key"])
    assert.deepStrictEqual(shown(press(filtered.state, Key.named("return")).state), ["Stripe live key"])
    assert.deepStrictEqual(shown(press(filtered.state, Key.named("escape")).state), [
      "Stripe live key",
      "Stripe test key",
      "GitHub token",
    ])
  })

  it("types q into the filter and quits on q outside it", () => {
    const editing = press(opened(["quota"]), Key.char("/"), Key.char("q"))
    assert.deepStrictEqual(editing.effects, [])
    assert.deepStrictEqual(shown(editing.state), ["quota"])

    const done = press(editing.state, Key.named("return"), Key.char("q"))
    assert.deepStrictEqual(asked(done.effects), ["Quit"])
    assert.strictEqual(done.state._tag, "Locked")
  })

  it("drops an answer for a Vault no longer selected", () => {
    const work = press(opened(["a"]), Key.named("down"), Key.named("return")).state
    const answer = Event.ItemsLoaded({ list: { vault: "Personal", items: [item("a")], retired: [] } })
    const late = Reducer.reduce(work, answer)

    assert.deepStrictEqual(late, { state: work, effects: [] })
  })

  it("shows a refused Item list as a notice that Escape dismisses", () => {
    const work = press(opened(), Key.named("down"), Key.named("return")).state
    const problem = Problem.Failed({ message: "Vault Work does not exist on this Server." })
    const refused = Reducer.reduce(work, Event.ItemsRefused({ vault: "Work", problem })).state

    assert.deepStrictEqual(State.$is("Open")(refused) ? refused.modals : undefined, [View.Modal.Notice({ problem })])
    const dismissed = press(refused, Key.named("escape")).state
    assert.deepStrictEqual(State.$is("Open")(dismissed) ? dismissed.modals : undefined, [])
  })
})

const tenMinutes = 10 * 60 * 1_000

// The idle clock's ticks at each time in turn (Unix milliseconds), from `state`.
const ticks = (state: State, ...times: ReadonlyArray<number>) =>
  times.reduce((current, now) => Reducer.reduce(current, Event.IdleTick({ now })).state, state)

describe("Reducer idle timeout", () => {
  it("locks an Open UI on the first tick ten minutes after the first tick without a keypress", () => {
    const idle = ticks(opened(["a"]), 1_000, 1_000 + tenMinutes - 1)
    assert.strictEqual(idle._tag, "Open")

    const locked = Reducer.reduce(idle, Event.IdleTick({ now: 1_000 + tenMinutes }))
    assert.deepStrictEqual(locked, { state: State.locked(), effects: [] })
  })

  it("restarts the idle time on a keypress or a paste", () => {
    const pressed = press(ticks(opened(["a"]), 0, tenMinutes - 1), Key.named("down")).state
    const pasted = Reducer.reduce(ticks(opened(["a"]), 0, tenMinutes - 1), Event.Paste({ text: "x" })).state

    for (const input of [pressed, pasted]) {
      assert.strictEqual(ticks(input, tenMinutes, 2 * tenMinutes - 1)._tag, "Open")
      assert.strictEqual(ticks(input, tenMinutes, 2 * tenMinutes)._tag, "Locked")
    }
  })

  it("counts time the host spent asleep, since the ticks carry the wall clock", () => {
    assert.strictEqual(ticks(opened(["a"]), 0, 8 * 60 * 60 * 1_000)._tag, "Locked")
  })

  it("ignores ticks while Locked", () => {
    const typed = press(State.initial, ...typing("pass")).state

    assert.deepStrictEqual(Reducer.reduce(typed, Event.IdleTick({ now: 0 })), { state: typed, effects: [] })
  })
})

describe("Reducer suspend", () => {
  const suspendChord = Key.named("z", { ctrl: true })

  it("locks an Open UI, then asks to suspend, on Ctrl-Z and on SIGTSTP", () => {
    const filtering = press(opened(["a"]), Key.char("/"))

    for (const step of [press(filtering.state, suspendChord), Reducer.reduce(filtering.state, Event.Suspend())])
      assert.deepStrictEqual(step, { state: State.locked(), effects: [UiEffect.Suspend()] })
  })

  it("clears the typed input at the prompt and drops a check answered after it", () => {
    const checking = press(State.initial, ...typing("right"), Key.named("return")).state
    const suspended = Reducer.reduce(checking, Event.Suspend())
    assert.deepStrictEqual(suspended, { state: State.locked(1), effects: [UiEffect.Suspend()] })

    const late = Event.Unlocked({ passphrase: Redacted.make("right"), vaults: [vault("Personal", 0)] })
    assert.deepStrictEqual(Reducer.reduce(suspended.state, late), { state: State.locked(1), effects: [] })

    const typed = press(State.initial, ...typing("half typed"), suspendChord)
    assert.deepStrictEqual(typed, { state: State.locked(), effects: [UiEffect.Suspend()] })
  })
})

// Each lock path, and whether it also locks from Locked (clearing the prompt) or only from Open: quit (Ctrl-C, or
// `q` outside the filter), Ctrl-Z, SIGTSTP, an exit signal, and the idle timeout.
const lockPath: fc.Arbitrary<{ readonly events: ReadonlyArray<Event>; readonly fromLocked: boolean }> = fc.constantFrom(
  { events: [Event.Key({ key: Key.named("c", { ctrl: true }) })], fromLocked: true },
  { events: [Event.Key({ key: Key.named("escape") }), Event.Key({ key: Key.char("q") })], fromLocked: false },
  { events: [Event.Key({ key: Key.named("z", { ctrl: true }) })], fromLocked: true },
  { events: [Event.Suspend()], fromLocked: true },
  { events: [Event.Closed()], fromLocked: true },
  { events: [Event.IdleTick({ now: 0 }), Event.IdleTick({ now: tenMinutes })], fromLocked: false },
)

// The Locked prompt as the UI starts: no Passphrase, no typed input (the one Redacted a Locked state has, and
// deep equality does not look inside a Redacted), and nothing else.
const assertFresh = (state: State | undefined) => {
  if (state === undefined || !State.$is("Locked")(state)) return assert.fail(`expected Locked, got ${state?._tag}`)
  assert.isUndefined(State.passphrase(state))
  assert.strictEqual(Redacted.value(state.entered.value), "")
  assert.deepStrictEqual(state, State.locked(state.attempt))
}

describe("Reducer lock paths", () => {
  it("yields a fresh Locked state with no Passphrase and no held value on every path into Locked", () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 30 }), lockPath, (events, path) => {
        const before = run(events).at(-1)?.state ?? State.initial
        const steps = run([...events, ...path.events])
        const states = [State.initial, ...steps.map(({ state }) => state)]

        steps.forEach(({ state }, index) => {
          const previous = states[index]

          if (State.$is("Locked")(state) && previous !== undefined && State.$is("Open")(previous)) assertFresh(state)
        })

        if (path.fromLocked || State.$is("Open")(before)) assertFresh(steps.at(-1)?.state)
      }),
    )
  })
})
