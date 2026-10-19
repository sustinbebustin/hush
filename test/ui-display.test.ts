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
import { View } from "../src/ui/View.js"

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

// Open on Vaults Personal (with `items` Items and `retired` Retired titles, answered), Work and `more` others.
const openedWith = (items: number, retired = 0, more = 0): State => {
  const checking = press(typed("right"), Key.named("return"))
  const others = Array.from({ length: more }, (_, n) => vault(`Vault ${n}`, 0))

  const open = Reducer.reduce(
    checking,
    Event.Unlocked({
      attempt: 1,
      passphrase: Redacted.make("right"),
      vaults: [vault("Personal", items), vault("Work", 0), ...others],
      clipboard: false,
    }),
  ).state

  const list = {
    vault: "Personal",
    items: Array.from({ length: items }, (_, n) => (n === 0 ? item : { ...item, title: `Item ${n}` })),
    retired: Array.from({ length: retired }, (_, n) => `retired ${n}`),
  }

  return Reducer.reduce(open, Event.ItemsLoaded({ list })).state
}

// Open on Vaults Personal (one Item, answered) and Work.
const opened = (): State => openedWith(1)

// The displays drawn as `keys` are pressed from `state` at `width`x`height`, each from the one before, as `Ui.run`
// draws them; with the cursor's row each time.
const walk = (from: State, width: number, height: number, keys: ReadonlyArray<Key>) => {
  let state = sized(from, width, height)
  let display = Display.of(state)
  const steps: Array<{ readonly state: State; readonly display: Display }> = []

  for (const key of keys) {
    state = Reducer.reduce(state, Event.Key({ key })).state
    display = Display.of(state, display)
    steps.push({ state, display })
  }

  return steps
}

// The Open display's fields, or a test failure.
const openOf = (display: Display) =>
  Display.$match(display, {
    Open: (open) => open,
    Locked: () => assert.fail("expected the Open layout, got Locked"),
    TooSmall: () => assert.fail("expected the Open layout, got TooSmall"),
  })

// The Token table columns drawn at `width`.
const columnsAt = (width: number) => openOf(Display.of(sized(tokensOpened(), width, 24))).tokenColumns

// The cursor's entry in the sidebar and in the Item rows (Items, then Retired titles), if any.
const cursors = (state: State) => {
  if (!State.$is("Open")(state)) throw new Error("expected an Open state")
  const { view } = state
  const row = View.$is("ItemList")(view) ? View.cursorRow(view) : undefined

  return { sidebar: state.cursor, row }
}

const moves = fc.array(fc.constantFrom(Key.named("up"), Key.named("down")), { maxLength: 80 })

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

  it("keeps the cursor's row inside the drawn window of the Item rows and the sidebar, at any height from 10", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 10, max: 40 }),
        moves,
        moves,
        (items, retired, more, height, inSidebar, inRows) => {
          const sidebarRows = height - 3
          const sidebarSteps = walk(openedWith(items, retired, more), 100, height, inSidebar)

          for (const { state, display } of sidebarSteps) {
            const { sidebar } = openOf(display).windows

            assert.isAtMost(sidebar.top, cursors(state).sidebar)
            assert.isAbove(sidebar.end, cursors(state).sidebar)
            assert.isAtMost(sidebar.end - sidebar.top, sidebarRows)
          }

          for (const { state, display } of walk(openedWith(items, retired), 100, height, [
            Key.named("tab"),
            ...inRows,
          ])) {
            const { row } = cursors(state)
            const { rows } = openOf(display).windows

            if (row === undefined) continue
            assert.isAtMost(rows.top, row)
            assert.isAbove(rows.end, row)
          }
        },
      ),
    )
  })

  it("says how many rows are hidden above and below the window", () => {
    const steps = walk(openedWith(25), 121, 19, [
      Key.named("tab"),
      ...Array.from({ length: 20 }, () => Key.named("down")),
    ])

    const last = openOf(steps.at(-1)?.display ?? Display.of(State.initial))

    // 16 rows in the pane: Items 5 to 20 drawn, with the cursor on Item 20.
    assert.deepStrictEqual(last.windows.rows, { top: 5, end: 21, line: 5, count: 25 })
    assert.strictEqual(last.paneHidden, "5 above, 4 below")
    assert.strictEqual(last.sidebarHidden, "")
  })

  it("drops whole Token table columns as the pane narrows: Expires, then Created, then State; Label always", () => {
    assert.deepStrictEqual(columnsAt(121), ["state", "created", "expires", "grants"])
    assert.deepStrictEqual(columnsAt(90), ["state", "created", "expires", "grants"])
    assert.deepStrictEqual(columnsAt(80), ["state", "created", "grants"])
    assert.deepStrictEqual(columnsAt(70), ["state", "grants"])
    assert.deepStrictEqual(columnsAt(60), ["grants"])
  })

  it("draws one mask cell per character typed, multi-byte characters included", () => {
    const shown = Display.of(typed("pä😀"))

    assert.deepStrictEqual(
      Display.$match(shown, { Locked: ({ prompt, mask }) => prompt + mask, Open: () => "", TooSmall: () => "" }),
      "hush Passphrase: ***",
    )
  })
})
