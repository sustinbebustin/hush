import { assert, describe, it } from "@effect/vitest"
import { Redacted } from "effect"
import * as fc from "fast-check"

import type { ItemMeta } from "../src/shared/Api.js"
import { Audit } from "../src/ui/Audit.js"
import { Display } from "../src/ui/Display.js"
import { Event } from "../src/ui/Event.js"
import { Key } from "../src/ui/Key.js"
import { Reducer } from "../src/ui/Reducer.js"
import { State, type Vault } from "../src/ui/State.js"

// The state after typing `text` at the Locked prompt, one key per code point.
const typed = (text: string): State =>
  [...text].reduce<State>(
    (state, character) => Reducer.reduce(state, Event.Key({ key: Key.char(character) })).state,
    State.initial,
  )

const press = (state: State, ...keys: ReadonlyArray<Key>): State =>
  keys.reduce((next, key) => Reducer.reduce(next, Event.Key({ key })).state, state)

const sized = (state: State, width: number, height: number): State =>
  Reducer.reduce(state, Event.Resize({ width, height })).state

const vault = (name: string, items: number): Vault => ({
  vault: name,
  items,
  activeTokens: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
})

const item: ItemMeta = {
  title: "Stripe live key",
  kind: "api-credential",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  fields: [{ label: "credential", concealed: true }],
}

// Open on Vaults Personal (one Item, answered) and Work.
const opened = (): State => {
  const checking = press(typed("right"), Key.named("return"))

  const open = Reducer.reduce(
    checking,
    Event.Unlocked({
      attempt: 1,
      passphrase: Redacted.make("right"),
      vaults: [vault("Personal", 1), vault("Work", 0)],
      clipboard: false,
    }),
  ).state

  return Reducer.reduce(open, Event.ItemsLoaded({ list: { vault: "Personal", items: [item], retired: [] } })).state
}

const detailOpened = () => press(opened(), Key.named("tab"), Key.named("return"))

const tokensOpened = () =>
  Reducer.reduce(
    press(opened(), Key.named("down"), Key.named("down"), Key.named("return")),
    Event.TokensLoaded({
      list: {
        tokens: [
          {
            label: "agent on box",
            grants: [{ vault: "Personal", access: "read+create" }],
            createdAt: "2026-10-01T00:00:00.000Z",
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
            state: "active",
          },
        ],
      },
    }),
  ).state

const auditOpened = () =>
  Reducer.reduce(
    press(opened(), Key.named("down"), Key.named("down"), Key.named("down"), Key.named("return")),
    Event.AuditListed({
      ask: Audit.Ask.First({ filters: { vault: "", label: "", since: "" } }),
      query: {},
      page: {
        entries: [
          {
            id: 1,
            at: "2026-10-17T09:30:05.123Z",
            lastAt: "2026-10-17T09:30:05.123Z",
            count: 1,
            actor: { type: "passphrase" },
            action: "vault.list",
            vaults: [],
            references: [],
            outcome: "ok",
          },
        ],
      },
    }),
  ).state

const hintsOf = (state: State): string =>
  Display.$match(Display.of(state), { Locked: ({ hints }) => hints, Open: ({ hints }) => hints, TooSmall: () => "" })

describe("Display", () => {
  it("draws the Locked prompt from the length of the typed Passphrase alone", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), (text) => {
        const length = [...text].length

        assert.deepStrictEqual(Display.of(typed(text)), Display.of(typed("x".repeat(length))))
      }),
    )
  })

  it("lays out every frame from 60x10 up, and below that draws one notice naming the floor", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 300 }), fc.integer({ min: 1, max: 120 }), (width, height) => {
        const shown = Display.of(sized(opened(), width, height))
        const fits = width >= 60 && height >= 10

        assert.strictEqual(shown._tag, fits ? "Open" : "TooSmall")

        if (!fits)
          assert.strictEqual(
            Display.$match(shown, { Locked: () => "", Open: () => "", TooSmall: ({ notice }) => notice }),
            `hush ui needs at least 60x10; this terminal is ${width}x${height}. Enlarge it; Ctrl-C quits.`,
          )
      }),
    )
  })

  it("draws the Open layout of each view at 121x19, 80x12 and 64x24", () => {
    for (const [width, height] of [
      [121, 19],
      [80, 12],
      [64, 24],
    ] as const)
      for (const state of [State.initial, opened(), detailOpened(), tokensOpened(), auditOpened()])
        assert.notStrictEqual(Display.of(sized(state, width, height))._tag, "TooSmall", `${width}x${height}`)
  })

  it("fits each hint bar on one line of the frame's width, dropping whole keys, `? help` and `q quit` last", () => {
    const states = [State.initial, opened(), press(opened(), Key.named("tab")), detailOpened(), tokensOpened()]

    fc.assert(
      fc.property(fc.integer({ min: 60, max: 120 }), fc.constantFrom(...states), (width, state) => {
        const hints = hintsOf(sized(state, width, 24))

        assert.isAtMost(hints.length, width)
        assert.notInclude(hints, "\n")
        assert.isTrue(hintsOf(sized(state, 200, 24)).startsWith(hints.split("  ")[0] ?? ""), hints)
      }),
    )

    assert.strictEqual(
      hintsOf(sized(press(opened(), Key.named("tab")), 64, 24)),
      "Up/Down move  Enter open  c create  n rename  ? help  q quit",
    )
    assert.strictEqual(
      hintsOf(sized(press(opened(), Key.named("tab")), 80, 24)),
      "Up/Down move  Enter open  c create  n rename  d delete  / filter  ? help  q quit",
    )
  })

  it("draws one mask cell per character typed, multi-byte characters included", () => {
    const shown = Display.of(typed("pä😀"))

    assert.deepStrictEqual(
      Display.$match(shown, { Locked: ({ prompt, mask }) => prompt + mask, Open: () => "", TooSmall: () => "" }),
      "hush Passphrase: ***",
    )
  })
})
