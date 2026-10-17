import { assert, describe, it } from "@effect/vitest"
import { Predicate, Redacted } from "effect"
import * as fc from "fast-check"

import type { ItemMeta } from "../src/shared/Api.js"
import { Clipboard } from "../src/ui/Clipboard.js"
import { Display } from "../src/ui/Display.js"
import { Event } from "../src/ui/Event.js"
import { ItemForm } from "../src/ui/ItemForm.js"
import { Key } from "../src/ui/Key.js"
import { Reducer, type Step } from "../src/ui/Reducer.js"
import { State } from "../src/ui/State.js"
import { UiEffect } from "../src/ui/UiEffect.js"

// The Item form through the pure reducer: the concealed value typed or pasted is held only in the form's buffer,
// never in what the screen draws, and leaves the state with the one write that carries it.

const github: ItemMeta = {
  title: "GitHub",
  kind: "login",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  fields: [
    { label: "password", concealed: true },
    { label: "username", concealed: false },
  ],
}

// Each event in turn from `state`, keeping every state and effect along the way.
const run = (state: State, events: ReadonlyArray<Event>) =>
  events.reduce<{ readonly state: State; readonly states: ReadonlyArray<State>; readonly effects: Step["effects"] }>(
    (acc, event) => {
      const next = Reducer.reduce(acc.state, event)

      return { state: next.state, states: [...acc.states, next.state], effects: [...acc.effects, ...next.effects] }
    },
    { state, states: [], effects: [] },
  )

const keys = (...pressed: ReadonlyArray<Key>) => pressed.map((key) => Event.Key({ key }))

const typing = (text: string) => keys(...[...text].map(Key.char))

// Open on Vault Personal with GitHub listed, on a host with a clipboard.
const opened = (): State => {
  const checking = run(State.initial, [...typing("right"), ...keys(Key.named("return"))]).state

  return run(checking, [
    Event.Unlocked({
      passphrase: Redacted.make("right"),
      vaults: [{ vault: "Personal", items: 1, activeTokens: 0, createdAt: "2026-10-01T00:00:00.000Z" }],
      clipboard: true,
    }),
    Event.ItemsLoaded({ list: { vault: "Personal", items: [github], retired: [] } }),
  ]).state
}

// Every string under `parts`, plain or behind a Redacted, found by walking every field and element.
const stringsIn = (parts: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    if (Redacted.isRedacted(part)) return stringsIn([Redacted.value(part)])

    if (Predicate.isString(part)) return [part]

    return Predicate.isObjectOrArray(part) ? stringsIn(Object.values(part)) : []
  })

const holds = (state: State, text: string) => stringsIn([state]).some((each) => each.includes(text))

const draws = (state: State, text: string) => stringsIn([Display.of(state)]).some((each) => each.includes(text))

// What the write effects carried.
const saved = (effects: Step["effects"]) =>
  effects.flatMap((effect) => (UiEffect.$is("SaveItem")(effect) ? [effect.save] : []))

// A concealed value: a fixed prefix, so it matches nothing else in the state, then any printable text.
const concealedValue = fc
  .string({ unit: fc.constantFrom(..."abcXYZ019 -_é!"), minLength: 1, maxLength: 24 })
  .map((tail) => `sentinel-7Rv${tail}`)

// How the value reaches the buffer: typed, a bracketed paste, or the clipboard paste key.
const entered = (value: string): fc.Arbitrary<ReadonlyArray<Event>> =>
  fc.constantFrom<ReadonlyArray<Event>>(
    typing(value),
    [Event.Paste({ text: value })],
    [
      ...keys(Key.named("v", { ctrl: true })),
      Event.ClipboardRead({ pasted: Clipboard.Pasted.Text({ text: Redacted.make(value) }) }),
    ],
  )

const withEntry = concealedValue.chain((value) => fc.tuple(fc.constant(value), entered(value)))

describe("Item form concealed buffer", () => {
  it("a create holds the value only until submit, never draws it, and sends it in one write", () =>
    fc.assert(
      fc.property(withEntry, ([value, events]) => {
        const open = [
          ...keys(Key.named("tab")),
          ...typing("c"),
          ...keys(Key.named("down")),
          ...typing("Key"),
          ...keys(Key.named("down")),
        ]

        const filled = run(opened(), [...open, ...events])
        assert.isTrue(holds(filled.state, value))

        for (const state of filled.states) assert.isFalse(draws(state, value))
        const submitted = run(filled.state, keys(Key.named("return")))
        assert.isFalse(holds(submitted.state, value))
        assert.isFalse(draws(submitted.state, value))

        const [save, ...more] = saved(submitted.effects)
        assert.deepStrictEqual(more, [])

        assert.isTrue(
          save !== undefined && ItemForm.Save.$is("Create")(save) && Redacted.value(save.value) === value,
          "the one write carries the value",
        )
      }),
    ))

  it("an edit replacing the concealed Field drops the value with its one write", () =>
    fc.assert(
      fc.property(withEntry, ([value, events]) => {
        const detail = keys(Key.named("tab"), Key.named("return"), Key.char("e"))
        const filled = run(opened(), [...detail, ...events])
        assert.isTrue(holds(filled.state, value))

        for (const state of filled.states) assert.isFalse(draws(state, value))
        const submitted = run(filled.state, keys(Key.named("return")))
        assert.isFalse(holds(submitted.state, value))
        assert.strictEqual(saved(submitted.effects).length, 1)
      }),
    ))

  it("drops a clipboard answer that arrives after a Lock", () => {
    const pasting = run(opened(), [
      ...keys(Key.named("tab")),
      ...typing("c"),
      ...keys(Key.named("down"), Key.named("down"), Key.named("v", { ctrl: true })),
    ])

    assert.deepStrictEqual(
      pasting.effects.map(({ _tag }) => _tag),
      ["ReadClipboard"],
    )

    const locked = run(pasting.state, [
      Event.Suspend(),
      Event.ClipboardRead({ pasted: Clipboard.Pasted.Text({ text: Redacted.make("sentinel-7Rv late") }) }),
    ])

    assert.isFalse(holds(locked.state, "sentinel-7Rv"))
  })
})
