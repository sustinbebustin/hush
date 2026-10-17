import { assert, describe, it } from "@effect/vitest"
import { Redacted } from "effect"

import { AuditAction, type AuditEntry, type AuditPage } from "../src/shared/Api.js"
import { Audit, type Ask } from "../src/ui/Audit.js"
import { Display } from "../src/ui/Display.js"
import { Event } from "../src/ui/Event.js"
import { Key } from "../src/ui/Key.js"
import { Problem } from "../src/ui/Problem.js"
import { Reducer } from "../src/ui/Reducer.js"
import { State } from "../src/ui/State.js"
import { UiEffect } from "../src/ui/UiEffect.js"

// The Audit view through the reducer and the display model: which `admin/audit` requests each key sends, how
// pages are appended, which answers are dropped, and what each row says.

const press = (state: State, ...keys: ReadonlyArray<Key>) =>
  keys.reduce<{ readonly state: State; readonly effects: ReadonlyArray<UiEffect> }>(
    (step, key) => {
      const next = Reducer.reduce(step.state, Event.Key({ key }))

      return { state: next.state, effects: [...step.effects, ...next.effects] }
    },
    { state, effects: [] },
  )

const typing = (text: string) => [...text].map(Key.char)

// The Audit requests the effects ask for.
const asks = (effects: ReadonlyArray<UiEffect>): ReadonlyArray<Ask> =>
  effects.flatMap((effect) => (UiEffect.$is("ListAudit")(effect) ? [effect.ask] : []))

type Outcome = { readonly outcome: "ok" } | { readonly outcome: "denied" | "error"; readonly error: string }

type Fields = Partial<Omit<Extract<AuditEntry, { readonly outcome: "ok" }>, "id" | "outcome">>

const entry = (id: number, fields: Fields = {}, outcome: Outcome = { outcome: "ok" }): AuditEntry => ({
  id,
  at: "2026-10-17T09:30:05.123Z",
  lastAt: "2026-10-17T09:30:05.123Z",
  count: 1,
  actor: { type: "passphrase" },
  action: "vault.list",
  vaults: [],
  references: [],
  ...fields,
  ...outcome,
})

const page = (ids: ReadonlyArray<number>, next?: number): AuditPage =>
  next === undefined ? { entries: ids.map((id) => entry(id)) } : { entries: ids.map((id) => entry(id)), next }

const ids = (from: number, count: number) => Array.from({ length: count }, (_, n) => from - n)

const noFilters = { vault: "", label: "", since: "" }

const first = Audit.Ask.First({ filters: noFilters })

const vault = (name: string) => ({ vault: name, items: 0, activeTokens: 0, createdAt: "2026-10-01T00:00:00.000Z" })

// Open on Personal and Work, with the Audit row (below them) selected: its first-page request sent.
const selected = (): ReturnType<typeof press> => {
  const checking = press(State.initial, ...typing("right"), Key.named("return")).state

  const open = Reducer.reduce(
    checking,
    Event.Unlocked({ passphrase: Redacted.make("right"), vaults: [vault("Personal"), vault("Work")] }),
  ).state

  return press(open, Key.named("down"), Key.named("down"), Key.named("return"))
}

const answered = (state: State, ask: Ask, answer: AuditPage, query = {}) =>
  Reducer.reduce(state, Event.AuditListed({ ask, query, page: answer })).state

// The Audit pane's filter row and status line.
const shown = (state: State) =>
  Display.$match(Display.of(state), {
    Locked: () => ({ filter: "", message: "" }),
    Open: ({ filter, message }) => ({ filter, message }),
  })

const pageDown = Key.named("pagedown")

describe("Audit view", () => {
  it("asks for the first page with no filter when Audit is selected below the Vaults", () => {
    const { state, effects } = selected()

    assert.deepStrictEqual(asks(effects), [first])
    assert.strictEqual(shown(state).message, "Loading...")

    const sidebar = Display.$match(Display.of(state), { Locked: () => [], Open: ({ sections }) => sections })
    assert.deepStrictEqual(sidebar, [{ name: "Audit", underCursor: true }])
  })

  it("sends the filters as typed, one request on Enter, none when nothing changed or on Escape", () => {
    const loaded = answered(selected().state, first, page([3, 2, 1]))
    const typed = press(loaded, Key.char("/"), ...typing("Work"), Key.named("tab"), ...typing("deploy bot"))

    assert.deepStrictEqual(typed.effects, [])
    assert.strictEqual(shown(typed.state).filter, "/ Vault: Work  Label: deploy bot_  Since: ")

    const applied = press(typed.state, Key.named("tab"), ...typing("7d"), Key.named("return"))
    const filters = { vault: "Work", label: "deploy bot", since: "7d" }
    assert.deepStrictEqual(asks(applied.effects), [Audit.Ask.First({ filters })])
    assert.strictEqual(shown(applied.state).filter, "Vault: Work  Label: deploy bot  Since: 7d")

    const unchanged = press(
      answered(applied.state, Audit.Ask.First({ filters }), page([2])),
      Key.char("/"),
      Key.named("return"),
    )

    assert.deepStrictEqual(unchanged.effects, [])

    const cancelled = press(unchanged.state, Key.char("/"), ...typing("x"), Key.named("escape"))
    assert.deepStrictEqual(cancelled.effects, [])
    assert.strictEqual(shown(cancelled.state).filter, "Vault: Work  Label: deploy bot  Since: 7d")

    const cleared = press(cancelled.state, Key.named("escape"))
    assert.deepStrictEqual(asks(cleared.effects), [first])
  })

  it("types q and j into a filter rather than quitting or moving the sidebar", () => {
    const loaded = answered(selected().state, first, page([1]))
    const typed = press(loaded, Key.char("/"), ...typing("qj"))

    assert.deepStrictEqual(typed.effects, [])
    assert.strictEqual(shown(typed.state).filter, "/ Vault: qj_  Label:   Since: ")
  })

  it("fetches the page below `next` once the bottom is in view, with the first page's query, and appends it", () => {
    const query = { since: "2026-10-10T09:30:05.123Z" }
    const loaded = answered(selected().state, first, page(ids(100, 25), 76), query)
    const scrolled = press(loaded, pageDown)

    assert.deepStrictEqual(scrolled.effects, [])
    assert.include(shown(scrolled.state).message, "25 entries, from row 11, older entries load at the bottom")

    const bottom = press(scrolled.state, pageDown, pageDown, pageDown)
    const next = Audit.Ask.Next({ query, before: 76 })
    assert.deepStrictEqual(asks(bottom.effects), [next])
    assert.include(shown(bottom.state).message, "loading older entries")

    const appended = answered(bottom.state, next, page(ids(75, 5)))
    assert.include(shown(appended).message, "30 entries, from row 16, end of the log")
    assert.deepStrictEqual(press(appended, pageDown, pageDown).effects, [])
  })

  it("drops a first page answered after the filters changed, and a page nothing is waiting for", () => {
    const { state } = selected()
    const changed = press(state, Key.char("/"), ...typing("Work"), Key.named("return")).state

    assert.deepStrictEqual(Reducer.reduce(changed, Event.AuditListed({ ask: first, query: {}, page: page([1]) })), {
      state: changed,
      effects: [],
    })

    const loaded = answered(changed, Audit.Ask.First({ filters: { ...noFilters, vault: "Work" } }), page([1]))
    const stray = Audit.Ask.Next({ query: {}, before: 1 })
    assert.deepStrictEqual(Reducer.reduce(loaded, Event.AuditListed({ ask: stray, query: {}, page: page([0]) })), {
      state: loaded,
      effects: [],
    })
  })

  it("keeps the loaded entries when a later page is refused, so PgDn asks for it again", () => {
    const loaded = answered(selected().state, first, page([3, 2], 2))
    const bottom = press(loaded, pageDown)
    const next = Audit.Ask.Next({ query: {}, before: 2 })
    assert.deepStrictEqual(asks(bottom.effects), [next])

    const problem = Problem.Failed({ message: "The Audit Log is unavailable." })
    const refused = Reducer.reduce(bottom.state, Event.AuditRefused({ ask: next, problem })).state
    assert.include(shown(refused).message, "2 entries, from row 1, older entries load at the bottom")
    assert.deepStrictEqual(State.$is("Open")(refused) ? refused.modals.length : undefined, 1)

    const dismissed = press(refused, Key.named("escape"), pageDown)
    assert.deepStrictEqual(asks(dismissed.effects), [next])
  })

  it("shows a refused first page as the notice and an unreadable log", () => {
    const problem = Problem.Failed({ message: "`--since 7x` is neither a duration such as 7d" })
    const refused = Reducer.reduce(selected().state, Event.AuditRefused({ ask: first, problem })).state

    assert.strictEqual(shown(refused).message, "Could not read the Audit Log.")
    assert.strictEqual(
      Display.$match(Display.of(refused), { Locked: () => "", Open: ({ modal }) => modal ?? "" }),
      problem.message,
    )
  })
})

// A row's detail column: past the four before it (19, 12, 17 and 12 wide, a space after each).
const detailOf = (fields: Fields, outcome?: Outcome) => Audit.row(entry(1, fields, outcome)).slice(64)

describe("Audit rows", () => {
  it("names every action the Api defines", () => {
    for (const action of AuditAction.literals) assert.include(Audit.row(entry(1, { action })), ` ${action} `)
  })

  it("lays out time, actor, action, Vaults and detail in columns", () => {
    assert.strictEqual(
      Audit.row(
        entry(1, { action: "item.reveal", vaults: ["Personal"], references: ["hush://Personal/Stripe/credential"] }),
      ),
      "2026-10-17 09:30:05 Passphrase   item.reveal       Personal     hush://Personal/Stripe/credential",
    )
  })

  it("names the Token by its Label, and init and host by name", () => {
    assert.include(Audit.row(entry(1, { actor: { type: "token", label: "agent on box" } })), " agent on box ")
    assert.include(Audit.row(entry(1, { actor: { type: "init" } })), " init ")
    assert.include(Audit.row(entry(1, { actor: { type: "host" } })), " host ")
    assert.include(
      Audit.row(entry(1, { actor: { type: "token", label: "a very long agent label" } })),
      " a very long… ",
    )
  })

  it("says what each detail key holds, how a request failed, and coalesced denials", () => {
    assert.strictEqual(
      detailOf({ action: "item.create", detail: { title: "Key", fields: ["credential", "notes"] } }),
      "title Key; fields credential,notes",
    )
    assert.strictEqual(detailOf({ action: "item.list", vaults: ["Personal"] }), "")
    assert.strictEqual(detailOf({ action: "item.rename", detail: { from: "Old", to: "New" } }), "Old -> New")
    assert.strictEqual(
      detailOf({ action: "item.edit", detail: { set: "username", removed: "notes" } }),
      "set username; removed notes",
    )
    assert.strictEqual(
      detailOf({
        action: "token.issue",
        detail: {
          label: "bot",
          grants: [{ vault: "Work", access: "read+create" }],
          expiresAt: "2026-11-01T00:00:00.000Z",
          replaced: "bot",
        },
      }),
      "label bot; grants Work:read+create; expires 2026-11-01 00:00:00; replaced bot",
    )
    assert.strictEqual(detailOf({ action: "token.issue", detail: { expiresAt: null } }), "no expiry")
    assert.strictEqual(
      detailOf({ count: 3, lastAt: "2026-10-17T10:00:00.000Z" }, { outcome: "denied", error: "GrantMissing" }),
      "denied GrantMissing; x3 until 2026-10-17 10:00:00",
    )
    assert.strictEqual(detailOf({}, { outcome: "error", error: "IntegrityCheckFailed" }), "error IntegrityCheckFailed")
  })
})
