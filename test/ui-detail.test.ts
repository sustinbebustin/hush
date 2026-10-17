import { assert, describe, it } from "@effect/vitest"
import { Predicate, Redacted } from "effect"

import type { ItemMeta } from "../src/shared/Api.js"
import { Event } from "../src/ui/Event.js"
import { Key } from "../src/ui/Key.js"
import { Reducer } from "../src/ui/Reducer.js"
import { State } from "../src/ui/State.js"
import { UiEffect } from "../src/ui/UiEffect.js"
import { View } from "../src/ui/View.js"

// The Item detail view and Reveal through the pure reducer: which keys open and leave it, the one Reveal request,
// and that a Revealed value leaves the state when it is hidden.

const sentinel = "fictional revealed value 7Qx"

const press = (state: State, ...keys: ReadonlyArray<Key>) =>
  keys.reduce<{ readonly state: State; readonly effects: ReadonlyArray<UiEffect> }>(
    (step, key) => {
      const next = Reducer.reduce(step.state, Event.Key({ key }))

      return { state: next.state, effects: [...step.effects, ...next.effects] }
    },
    { state, effects: [] },
  )

const login: ItemMeta = {
  title: "GitHub",
  kind: "login",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  fields: [
    { label: "password", concealed: true },
    { label: "username", concealed: false },
  ],
}

const stripe: ItemMeta = {
  title: "Stripe",
  kind: "api-credential",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  fields: [{ label: "credential", concealed: true }],
}

// Open on Vault Personal with its Items answered.
const opened = (): State => {
  const checking = press(State.initial, ...[..."right"].map(Key.char), Key.named("return")).state

  const open = Reducer.reduce(
    checking,
    Event.Unlocked({
      passphrase: Redacted.make("right"),
      vaults: [{ vault: "Personal", items: 2, activeTokens: 0, createdAt: "2026-10-01T00:00:00.000Z" }],
      clipboard: false,
    }),
  ).state

  return Reducer.reduce(open, Event.ItemsLoaded({ list: { vault: "Personal", items: [login, stripe], retired: [] } }))
    .state
}

const detailOf = (state: State) =>
  State.$is("Open")(state) && View.$is("ItemDetail")(state.view) ? state.view : undefined

// Every string under `parts`, plain or behind a Redacted, found by walking every field and element.
const stringsIn = (parts: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    if (Redacted.isRedacted(part)) return stringsIn([Redacted.value(part)])

    if (Predicate.isString(part)) return [part]

    return Predicate.isObjectOrArray(part) ? stringsIn(Object.values(part)) : []
  })

// Every string the state holds, plain or behind a Redacted.
const held = (state: State) => stringsIn([state])

// The detail of the second Item (Stripe), opened from the rows.
const onStripe = () => press(opened(), Key.named("tab"), Key.named("down"), Key.named("return"))

// Revealed: `r` on Stripe's credential, answered with the sentinel.
const revealed = () => {
  const asking = press(onStripe().state, Key.char("r"))
  const [reveal] = asking.effects
  const reference = reveal !== undefined && UiEffect.$is("Reveal")(reveal) ? reveal.reference : ""
  const generation = reveal !== undefined && UiEffect.$is("Reveal")(reveal) ? reveal.generation : -1

  const answered = Reducer.reduce(
    asking.state,
    Event.Revealed({ reference, generation, value: Redacted.make(sentinel) }),
  )

  return { ...answered, generation, reference, asked: asking.effects }
}

describe("Item detail", () => {
  it("opens the Item under the row cursor on Enter, with no request", () => {
    const { state, effects } = onStripe()

    assert.strictEqual(detailOf(state)?.item.title, "Stripe")
    assert.deepStrictEqual(effects, [])
  })

  it("returns to the Item list as it was on Esc", () => {
    const { state } = press(onStripe().state, Key.named("escape"))

    assert.isTrue(State.$is("Open")(state) && View.$is("ItemList")(state.view))
  })
})

describe("Reveal", () => {
  it("asks for one admin/items/reveal of the Field under the cursor, with the held Passphrase", () => {
    const { asked } = revealed()

    assert.strictEqual(asked.length, 1)
    const [reveal] = asked
    assert.isTrue(reveal !== undefined && UiEffect.$is("Reveal")(reveal))
    assert.strictEqual(reveal?._tag === "Reveal" ? reveal.reference : undefined, "hush://Personal/Stripe/credential")
    assert.strictEqual(reveal?._tag === "Reveal" ? Redacted.value(reveal.passphrase) : undefined, "right")
  })

  it("holds the answer as Redacted and starts the hide timer", () => {
    const { state, effects } = revealed()

    const reveal = detailOf(state)?.reveal
    assert.strictEqual(reveal?._tag, "Shown")
    assert.isTrue(reveal?._tag === "Shown" && Redacted.isRedacted(reveal.value))
    assert.strictEqual(reveal?._tag === "Shown" ? Redacted.value(reveal.value) : undefined, sentinel)
    assert.include(held(state), sentinel)
    assert.deepStrictEqual(
      effects.map(({ _tag }) => _tag),
      ["After"],
    )
  })

  it("drops the value from the state on its hide tick", () => {
    const { state, generation } = revealed()
    const hidden = Reducer.reduce(state, Event.RevealExpired({ generation })).state

    assert.strictEqual(detailOf(hidden)?.reveal._tag, "Hidden")
    assert.notInclude(held(hidden), sentinel)
  })

  it("drops the value from the state on any key, and that key does nothing else", () => {
    const { state } = revealed()
    const hidden = press(state, Key.char("q")).state

    assert.strictEqual(detailOf(hidden)?.reveal._tag, "Hidden")
    assert.notInclude(held(hidden), sentinel)
  })

  it("ignores a hide tick from an earlier Reveal", () => {
    const { state, generation } = revealed()
    const stale = Reducer.reduce(state, Event.RevealExpired({ generation: generation - 1 })).state

    assert.strictEqual(detailOf(stale)?.reveal._tag, "Shown")
  })

  it("drops an answer that arrives after the Owner left the detail", () => {
    const asking = press(onStripe().state, Key.char("r"), Key.named("escape"))

    const late = Reducer.reduce(
      asking.state,
      Event.Revealed({ reference: "hush://Personal/Stripe/credential", generation: 1, value: Redacted.make(sentinel) }),
    )

    assert.notInclude(held(late.state), sentinel)
    assert.deepStrictEqual(late.effects, [])
  })
})

describe("Reveal and the lock paths", () => {
  const tenMinutes = 10 * 60 * 1_000

  const lockPaths: ReadonlyArray<readonly [string, ReadonlyArray<Event>]> = [
    ["Ctrl-C", [Event.Key({ key: Key.named("c", { ctrl: true }) })]],
    ["Ctrl-Z", [Event.Key({ key: Key.named("z", { ctrl: true }) })]],
    ["SIGTSTP", [Event.Suspend()]],
    ["an exit signal", [Event.Closed()]],
    ["ten minutes idle", [Event.IdleTick({ now: 0 }), Event.IdleTick({ now: tenMinutes })]],
  ]

  for (const [path, events] of lockPaths)
    it(`drops a Revealed value and the Passphrase on ${path}`, () => {
      const locked = events.reduce((state, event) => Reducer.reduce(state, event).state, revealed().state)

      assert.strictEqual(locked._tag, "Locked")
      assert.notInclude(held(locked), sentinel)
      assert.notInclude(held(locked), "right")
    })
})
