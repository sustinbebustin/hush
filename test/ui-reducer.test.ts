import { assert, describe, it } from "@effect/vitest"
import { Redacted } from "effect"
import * as fc from "fast-check"

import type { ItemMeta, TokenInfo, TokenIssueReceipt } from "../src/shared/Api.js"
import { Audit } from "../src/ui/Audit.js"
import { Display } from "../src/ui/Display.js"
import { Event } from "../src/ui/Event.js"
import { Key } from "../src/ui/Key.js"
import { Problem } from "../src/ui/Problem.js"
import { Reducer } from "../src/ui/Reducer.js"
import { Sidebar } from "../src/ui/Sidebar.js"
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

// The Locked prompt with `text` pasted into it.
const promptWith = (text: string) => Reducer.reduce(State.initial, Event.Paste({ text })).state

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
      attempt: 1,
      passphrase: Redacted.make("right"),
      vaults: [vault("Personal", titles.length), vault("Work", 0)],
      clipboard: false,
    }),
  ).state

  return Reducer.reduce(open, Event.ItemsLoaded({ list: { vault: "Personal", items: titles.map(item), retired: [] } }))
    .state
}

const tokenInfo = (label: string): TokenInfo => ({
  label,
  grants: [{ vault: "Personal", access: "read+create" }],
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  state: "active",
})

// The Tokens view of `opened()`, its table answered with `labels` and focused.
const tokensOpened = (labels: ReadonlyArray<string> = ["agent on box"]): State => {
  const listing = press(opened(), Key.named("down"), Key.named("down"), Key.named("return")).state

  return Reducer.reduce(listing, Event.TokensLoaded({ list: { tokens: labels.map(tokenInfo) } })).state
}

const issuedToken = `hush_${"A".repeat(42)}A`

const receipt = (token: string): TokenIssueReceipt => ({
  token: Redacted.make(token),
  label: "deploy bot",
  grants: [{ vault: "Personal", access: "read" }],
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  replaced: false,
})

// Whether the state holds the issued Token `text`: only an Issued modal can hold one.
const holds = (state: State, text: string): boolean =>
  State.$is("Open")(state) &&
  state.modals.some((modal) => View.Modal.$is("Issued")(modal) && Redacted.value(modal.token) === text)

// Opens the issue form on `tokensOpened()`, presses `keys`, then Enter.
const submitted = (...keys: ReadonlyArray<Key>) => press(tokensOpened(), Key.char("i"), ...keys, Key.named("return"))

const modalText = (state: State): string =>
  Display.$match(Display.of(state), { Locked: () => "", Open: ({ modal }) => modal ?? "", TooSmall: () => "" })

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
      Event.Unlocked({
        attempt: 1,
        passphrase: Redacted.make("right"),
        vaults: [vault("Personal", 2), vault("Work", 0)],
        clipboard: false,
      }),
    )

    assert.strictEqual(state._tag, "Open")
    assert.strictEqual(Redacted.value(State.passphrase(state) ?? Redacted.make("")), "right")
    assert.deepStrictEqual(asked(effects), ["Personal"])
  })

  it("opens with no Item request when the Server has no Vault", () => {
    const checking = press(State.initial, ...typing("right"), Key.named("return")).state
    const unlocked = Event.Unlocked({ attempt: 1, passphrase: Redacted.make("right"), vaults: [], clipboard: false })
    const { state, effects } = Reducer.reduce(checking, unlocked)

    assert.strictEqual(State.$is("Open")(state) ? state.view._tag : undefined, "NoVaults")
    assert.deepStrictEqual(effects, [])
  })

  it("counts a refusal's wait down one tick a second and stops at zero", () => {
    const checking = press(State.initial, ...typing("wrong"), Key.named("return")).state
    const backoff = Event.UnlockRefused({ attempt: 1, problem: Problem.Backoff({ retryAfterSeconds: 2 }) })
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

    const refused = Reducer.reduce(
      first,
      Event.UnlockRefused({ attempt: 1, problem: Problem.Incorrect({ retryAfterSeconds: 5 }) }),
    )

    const second = press(refused.state, ...typing("b"), Key.named("return")).state

    const again = Reducer.reduce(
      second,
      Event.UnlockRefused({ attempt: 2, problem: Problem.Incorrect({ retryAfterSeconds: 9 }) }),
    )

    assert.deepStrictEqual(Reducer.reduce(again.state, Event.WaitTick({ attempt: 1 })), {
      state: again.state,
      effects: [],
    })
  })

  it("sends no Passphrase over the 1024-byte wire limit and says so at the prompt", () => {
    // 513 two-byte code points: 1026 bytes, short of the 1024 code points the length limit counts.
    const { state, effects } = press(promptWith("é".repeat(513)), Key.named("return"))

    assert.deepStrictEqual(effects, [])
    assert.strictEqual(State.$is("Locked")(state) ? state.phase._tag : undefined, "Refused")
    assert.strictEqual(State.$is("Locked")(state) ? state.entered.length : undefined, 0)
    assert.include(
      Display.$match(Display.of(state), { Locked: ({ notice }) => notice, Open: () => "", TooSmall: () => "" }),
      "1024 bytes",
    )

    assert.deepStrictEqual(asked(press(promptWith("é".repeat(512)), Key.named("return")).effects), ["ListVaults"])
  })

  it("types q into the prompt rather than quitting, and quits on Ctrl-C", () => {
    assert.deepStrictEqual(press(State.initial, Key.char("q")).effects, [])
    assert.deepStrictEqual(asked(press(State.initial, Key.named("c", { ctrl: true })).effects), ["Quit"])
  })
})

// Every key the UI binds, plus arbitrary typed text.
const anyKey: fc.Arbitrary<Key> = fc.oneof(
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 2 }).map(Key.char),
  fc.constantFrom(..."qjk/idycnx ".split("").map(Key.char)),
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
  fc
    .tuple(anyProblem, fc.integer({ min: 1, max: 3 }))
    .map(([problem, attempt]) => Event.UnlockRefused({ attempt, problem })),
  fc
    .tuple(vaultName, fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }))
    .map(([name, titles]) => Event.ItemsLoaded({ list: { vault: name, items: titles.map(item), retired: [] } })),
  fc.tuple(vaultName, anyProblem).map(([name, problem]) => Event.ItemsRefused({ vault: name, problem })),
  anyAsk.map((ask) => Event.AuditListed({ ask, query: {}, page: { entries: [], next: 1 } })),
  fc.tuple(anyAsk, anyProblem).map(([ask, problem]) => Event.AuditRefused({ ask, problem })),
  fc.nat({ max: 3 }).map((attempt) => Event.WaitTick({ attempt })),
  fc.constant(Event.Closed()),
  fc
    .array(fc.constantFrom("agent on box", "deploy bot"), { maxLength: 2 })
    .map((labels) => Event.TokensLoaded({ list: { tokens: labels.map(tokenInfo) } })),
  anyProblem.map((problem) => Event.TokensRefused({ problem })),
  fc.constant(Event.TokenRevoked({ label: "agent on box" })),
  anyProblem.map((problem) => Event.RevokeRefused({ problem })),
  fc.boolean().map((copyable) => Event.TokenIssued({ receipt: receipt(issuedToken), copyable })),
  anyProblem.map((problem) => Event.IssueRefused({ problem })),
  fc.constantFrom("written", "unsupported", "failed").map((written) => Event.TokenCopied({ written })),
  vaultName.map((name) => Event.ItemsChanged({ vault: name })),
  anyProblem.map((problem) => Event.ChangeRefused({ problem })),
  fc.constant(Event.Renamed({ receipt: { vault: "Personal", from: "a", to: "b", references: [] } })),
)

const anyEvent: fc.Arbitrary<Event> = fc.oneof(
  { arbitrary: withoutUnlock, weight: 5 },
  {
    arbitrary: fc
      .tuple(fc.subarray([vault("Personal", 1), vault("Work", 0)]), fc.integer({ min: 1, max: 3 }))
      .map(([vaults, attempt]) =>
        Event.Unlocked({ attempt, passphrase: Redacted.make("held passphrase"), vaults, clipboard: false }),
      ),
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
          assert.isFalse(holds(state, issuedToken))
        }
      }),
    )
  })

  it("holds no Passphrase, issued Token or prompt text after a quit from any state", () => {
    const quitting = fc.constantFrom(Event.Key({ key: Key.named("c", { ctrl: true }) }), Event.Closed())

    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 40 }), quitting, (events, last) => {
        const quitSteps = run([...events, last]).filter(quits)
        assert.isNotEmpty(quitSteps)

        for (const { state, effects } of quitSteps) {
          assert.isUndefined(State.passphrase(state))
          assert.isFalse(holds(state, issuedToken))
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

  it("keeps the cursor on the sidebar: the Vaults, then Tokens and Audit", () => {
    const top = press(opened(), Key.named("up"))
    const downs = Array.from({ length: 2 + Sidebar.sections.length + 2 }, () => Key.named("down"))
    const bottom = press(opened(), ...downs)

    assert.strictEqual(State.$is("Open")(top.state) ? top.state.cursor : undefined, 0)
    assert.strictEqual(State.$is("Open")(bottom.state) ? bottom.state.cursor : undefined, 1 + Sidebar.sections.length)
  })

  it("revokes through a Confirm modal only on y; any other key cancels it with no request", () => {
    const confirming = press(tokensOpened(), Key.char("d")).state
    const modal = State.$is("Open")(confirming) ? confirming.modals.at(-1) : undefined
    assert.strictEqual(modal?._tag, "Confirm")

    const confirmed = press(confirming, Key.char("y"))
    assert.deepStrictEqual(asked(confirmed.effects), ["RevokeToken"])
    const [revoke] = confirmed.effects
    assert.strictEqual(revoke?._tag === "RevokeToken" ? revoke.label : undefined, "agent on box")
    assert.deepStrictEqual(State.$is("Open")(confirmed.state) ? confirmed.state.modals : undefined, [])

    const others = anyKey.filter((key) => !Key.is(key, "y") && !Key.is(key, "c", { ctrl: true }))

    fc.assert(
      fc.property(others, (key) => {
        const cancelled = press(confirming, key)

        assert.deepStrictEqual(cancelled.effects, [])
        assert.deepStrictEqual(State.$is("Open")(cancelled.state) ? cancelled.state.modals : undefined, [])
      }),
    )
  })

  it("holds an issued Token as Redacted in its modal only, and drops it from state on dismissal", () => {
    const sent = submitted(...typing("deploy bot"), Key.named("down"), Key.char(" "))
    assert.deepStrictEqual(asked(sent.effects), ["IssueToken"])

    const issued = Reducer.reduce(sent.state, Event.TokenIssued({ receipt: receipt(issuedToken), copyable: true }))
    const modals = State.$is("Open")(issued.state) ? issued.state.modals : []
    assert.deepStrictEqual(asked(issued.effects), ["ListTokens"])
    assert.deepStrictEqual(
      modals.map(({ _tag }) => _tag),
      ["Issued"],
    )
    const [modal] = modals
    assert.isTrue(modal?._tag === "Issued" && Redacted.isRedacted(modal.token))
    assert.isTrue(holds(issued.state, issuedToken))

    for (const dismiss of [Key.named("escape"), Key.named("return")]) {
      const dismissed = press(issued.state, dismiss).state
      assert.deepStrictEqual(State.$is("Open")(dismissed) ? dismissed.modals : undefined, [])
      assert.isFalse(holds(dismissed, issuedToken))
    }
  })

  it("copies the issued Token on c through one CopyToken, and shows a notice instead when there is no clipboard", () => {
    const issue = (copyable: boolean) =>
      Reducer.reduce(tokensOpened(), Event.TokenIssued({ receipt: receipt(issuedToken), copyable })).state

    const copying = press(issue(true), Key.char("c"))
    const [copy] = copying.effects
    assert.strictEqual(copy?._tag === "CopyToken" ? Redacted.value(copy.token) : undefined, issuedToken)
    assert.deepStrictEqual(press(copying.state, Key.char("c")).effects, [])
    const copied = Reducer.reduce(copying.state, Event.TokenCopied({ written: "written" })).state
    assert.include(modalText(copied), "Copied to the clipboard.")
    assert.include(modalText(copied), issuedToken)

    const absent = press(issue(false), Key.char("c"))
    assert.deepStrictEqual(absent.effects, [])
    const modals = State.$is("Open")(absent.state) ? absent.state.modals : []
    assert.deepStrictEqual(
      modals.map(({ _tag }) => _tag),
      ["Issued", "Notice"],
    )
    assert.notInclude(
      Display.$match(Display.of(issue(false)), { Locked: () => "", Open: ({ hints }) => hints, TooSmall: () => "" }),
      "c copy",
    )
    assert.include(
      Display.$match(Display.of(issue(true)), { Locked: () => "", Open: ({ hints }) => hints, TooSmall: () => "" }),
      "c copy",
    )
  })

  it("applies a copy's answer to the issued Token under the help opened while it was copying", () => {
    const issued = Reducer.reduce(tokensOpened(), Event.TokenIssued({ receipt: receipt(issuedToken), copyable: true }))
    const helped = press(issued.state, Key.char("c"), Key.char("?")).state
    const copied = Reducer.reduce(helped, Event.TokenCopied({ written: "written" })).state
    const closed = press(copied, Key.char("x")).state

    assert.include(modalText(closed), "Copied to the clipboard.")
    assert.deepStrictEqual(asked(press(closed, Key.char("c")).effects), ["CopyToken"])
  })

  it("offers to replace a listed Label, keeping its Grants or starting the picker from them", () => {
    // Personal, Work, TTL, then the replace row that a listed Label adds.
    const toReplace = [...typing("AGENT ON BOX"), ...Array.from({ length: 4 }, () => Key.named("down"))]
    const [kept] = submitted(...toReplace, Key.char(" ")).effects
    assert.deepStrictEqual(kept?._tag === "IssueToken" ? kept.fields : undefined, {
      label: "AGENT ON BOX",
      grants: [],
      replaces: true,
      keepGrants: true,
    })

    const [edited] = submitted(...toReplace, Key.char(" "), Key.char(" ")).effects
    assert.deepStrictEqual(edited?._tag === "IssueToken" ? edited.fields : undefined, {
      label: "AGENT ON BOX",
      grants: [{ vault: "Personal", access: "read+create" }],
      replaces: true,
    })

    const [fresh] = submitted(...typing("other"), Key.named("down"), Key.char(" ")).effects
    assert.deepStrictEqual(fresh?._tag === "IssueToken" ? fresh.fields : undefined, {
      label: "other",
      grants: [{ vault: "Personal", access: "read" }],
    })
  })

  it("sends nothing for a form without a Label, a Grant or a valid TTL", () => {
    const grant = [Key.named("down"), Key.char(" ")]
    const ttl = (text: string) => [...typing("bot"), ...grant, Key.named("down"), Key.named("down"), ...typing(text)]
    const refusals = [submitted(...grant), submitted(...typing("bot")), submitted(...ttl("90 days"))]

    for (const refused of [...refusals, submitted(...ttl("3651d"))]) {
      assert.deepStrictEqual(refused.effects, [])
      const modals = State.$is("Open")(refused.state) ? refused.state.modals : []
      assert.deepStrictEqual(
        modals.map(({ _tag }) => _tag),
        ["IssueForm", "Notice"],
      )
    }

    const [sent] = submitted(...ttl("3650d")).effects
    assert.strictEqual(sent?._tag === "IssueToken" ? sent.fields.ttlSeconds : undefined, 3650 * 86_400)
  })

  it("asks for one Token list when Enter selects the Tokens entry, and drops a late Item answer", () => {
    const { state, effects } = press(opened(), Key.named("down"), Key.named("down"), Key.named("return"))

    assert.deepStrictEqual(asked(effects), ["ListTokens"])
    assert.deepStrictEqual(State.$is("Open")(state) ? state.view : undefined, View.tokensLoading())
    const late = Reducer.reduce(state, Event.ItemsLoaded({ list: { vault: "Personal", items: [], retired: [] } }))
    assert.deepStrictEqual(late, { state, effects: [] })
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

  it("locks on a Passphrase refusal of any request, showing it at the prompt with its wait, so nothing more is sent", () => {
    const work = press(opened(["a"]), Key.named("down"), Key.named("return")).state
    const problem = Problem.Incorrect({ retryAfterSeconds: 2 })
    const { state, effects } = Reducer.reduce(work, Event.PassphraseRejected({ problem }))

    assert.isUndefined(State.passphrase(state))
    assert.deepStrictEqual(State.$is("Locked")(state) ? state.phase : undefined, State.Phase.Refused({ problem }))
    assert.deepStrictEqual(asked(effects), ["After"])
    assert.include(
      Display.$match(Display.of(state), { Locked: ({ notice }) => notice, Open: () => "", TooSmall: () => "" }),
      "The Passphrase is incorrect.",
    )

    const late = Reducer.reduce(state, Event.PassphraseRejected({ problem: Problem.Backoff({ retryAfterSeconds: 9 }) }))
    assert.deepStrictEqual(late, { state, effects: [] })
  })
})

// Personal listed again with `titles` and the Retired title keys `retired`, the Item rows focused.
const listed = (titles: ReadonlyArray<string>, retired: ReadonlyArray<string> = []): State => {
  const asking = press(opened(), Key.named("return")).state

  const answered = Reducer.reduce(
    asking,
    Event.ItemsLoaded({ list: { vault: "Personal", items: titles.map(item), retired } }),
  )

  return press(answered.state, Key.named("tab")).state
}

// Every key but `y` and Ctrl-C (which quits from anywhere).
const notYes = anyKey.filter((key) => !Key.is(key, "y") && !Key.is(key, "c", { ctrl: true }))

// From `before`, `open` opens a Confirm modal; every key but `y` dismisses it and leaves `before` as it was.
const assertCancels = (before: State, ...open: ReadonlyArray<Key>) => {
  const confirming = press(before, ...open)

  assert.deepStrictEqual(confirming.effects, [])

  fc.assert(
    fc.property(notYes, (key) => {
      assert.deepStrictEqual(press(confirming.state, key), { state: before, effects: [] })
    }),
  )
}

const pane = (state: State) =>
  Display.$match(Display.of(state), {
    Locked: () => undefined,
    Open: ({ rows, retired, detail }) => ({ rows: rows.map(({ title }) => title), retired, detail }),
    TooSmall: () => undefined,
  })

// The sidebar's Item counts, Vault by Vault.
const counts = (state: State) => (State.$is("Open")(state) ? state.vaults.map(({ items }) => items) : undefined)

describe("Reducer rename, delete and release", () => {
  it("deletes the Item under the cursor through a Confirm modal naming its title, only on y", () => {
    const before = listed(["GitHub token", "Stripe live key"])
    const confirming = press(before, Key.named("down"), Key.char("d"))

    assert.include(modalText(confirming.state), '"Stripe live key"')
    assert.include(modalText(confirming.state), "Personal")
    const confirmed = press(confirming.state, Key.char("y"))
    assert.deepStrictEqual(confirmed.effects, [
      UiEffect.DeleteItem({ passphrase: Redacted.make("right"), vault: "Personal", item: "Stripe live key" }),
    ])
    assert.deepStrictEqual(State.$is("Open")(confirmed.state) ? confirmed.state.modals : undefined, [])
    assertCancels(press(before, Key.named("down")).state, Key.char("d"))
  })

  it("deletes from the Item detail too, and refreshes the Vault's list once the delete is answered", () => {
    const detail = press(listed(["Stripe live key"]), Key.named("return"), Key.char("d"), Key.char("y"))
    assert.deepStrictEqual(asked(detail.effects), ["DeleteItem"])

    const refreshed = Reducer.reduce(detail.state, Event.ItemsChanged({ vault: "Personal" }))
    assert.deepStrictEqual(asked(refreshed.effects), ["Personal"])
    assert.strictEqual(State.$is("Open")(refreshed.state) ? refreshed.state.view._tag : undefined, "ItemList")
    assertCancels(press(listed(["Stripe live key"]), Key.named("return")).state, Key.char("d"))
  })

  it("sends one confirmed write until it is answered: d and y again while it is out send nothing", () => {
    const twice = press(listed(["a", "b"]), Key.char("d"), Key.char("y"), Key.char("d"), Key.char("y"))
    assert.deepStrictEqual(asked(twice.effects), ["DeleteItem"])
    assert.include(
      Display.$match(Display.of(twice.state), { Locked: () => "", Open: ({ hints }) => hints, TooSmall: () => "" }),
      "Sending",
    )

    const refused = Reducer.reduce(twice.state, Event.ChangeRefused({ problem: Problem.Failed({ message: "no" }) }))
    const again = press(refused.state, Key.named("escape"), Key.char("d"), Key.char("y"))
    assert.deepStrictEqual(asked(again.effects), ["DeleteItem"])

    const revoking = press(tokensOpened(), Key.char("d"), Key.char("y"), Key.char("d"), Key.char("y"))
    assert.deepStrictEqual(asked(revoking.effects), ["RevokeToken"])
    const revoked = Reducer.reduce(revoking.state, Event.TokenRevoked({ label: "agent on box" }))
    const listedAgain = Reducer.reduce(revoked.state, Event.TokensLoaded({ list: { tokens: [tokenInfo("b")] } }))
    assert.deepStrictEqual(asked(press(listedAgain.state, Key.char("d"), Key.char("y")).effects), ["RevokeToken"])
  })

  it("checks the Item form as the CLI does before sending, keeping the hidden value when a check refuses", () => {
    const filled = press(
      listed(["a"]),
      Key.char("c"),
      Key.named("down"),
      ...typing("-bad title"),
      Key.named("down"),
      ...typing("fictional-kept-secret"),
    ).state

    const refused = press(filled, Key.named("return"))
    assert.deepStrictEqual(refused.effects, [])
    assert.include(modalText(refused.state), "title is not a valid name")

    const form =
      State.$is("Open")(refused.state) && View.$is("ItemForm")(refused.state.view) ? refused.state.view : undefined

    assert.strictEqual(form?.phase, "editing")
    assert.strictEqual(
      form?.form._tag === "Create" ? Redacted.value(form.form.concealed.value) : undefined,
      "fictional-kept-secret",
    )

    const fixed = press(
      refused.state,
      Key.named("escape"),
      Key.named("up"),
      ...Array.from({ length: 10 }, () => Key.named("backspace")),
      ...typing("good title"),
      Key.named("return"),
    )

    assert.deepStrictEqual(asked(fixed.effects), ["SaveItem"])
  })

  it("counts the Vault's Items in the sidebar as its list answers, so a delete lowers the count", () => {
    const before = press(opened(["a", "b"]), Key.named("tab"))
    assert.deepStrictEqual(counts(before.state), [2, 0])

    const deleted = press(before.state, Key.char("d"), Key.char("y")).state
    const reloading = Reducer.reduce(deleted, Event.ItemsChanged({ vault: "Personal" })).state

    const answered = Reducer.reduce(
      reloading,
      Event.ItemsLoaded({ list: { vault: "Personal", items: [item("b")], retired: ["a"] } }),
    )

    assert.deepStrictEqual(counts(answered.state), [1, 0])
  })

  it("opens no create form while the list is asked for again, so its answer is not dropped behind the form", () => {
    const deleted = press(listed(["a", "b"]), Key.char("d"), Key.char("y")).state
    const reloading = Reducer.reduce(deleted, Event.ItemsChanged({ vault: "Personal" })).state
    const pressed = press(reloading, Key.char("c"))
    assert.deepStrictEqual(pressed, { state: reloading, effects: [] })

    const answered = Reducer.reduce(
      pressed.state,
      Event.ItemsLoaded({ list: { vault: "Personal", items: [item("b")], retired: [] } }),
    ).state

    assert.deepStrictEqual(shown(answered), ["b"])
    const creating = press(answered, Key.char("c")).state
    assert.strictEqual(State.$is("Open")(creating) ? creating.view._tag : undefined, "ItemForm")
  })

  it("lists the Retired titles below the Items and releases the one under the cursor only on y", () => {
    const before = listed(["Stripe live key"], ["old key", "spare"])

    assert.deepStrictEqual(pane(before)?.retired, [
      { key: "old key", underCursor: false },
      { key: "spare", underCursor: false },
    ])
    const onRetired = press(before, Key.named("down"), Key.named("down"))
    assert.deepStrictEqual(pane(onRetired.state)?.retired, [
      { key: "old key", underCursor: false },
      { key: "spare", underCursor: true },
    ])
    assert.deepStrictEqual(press(onRetired.state, Key.char("d")).state, onRetired.state)

    const confirming = press(onRetired.state, Key.char("x"))
    assert.include(modalText(confirming.state), '"spare"')
    assert.deepStrictEqual(press(confirming.state, Key.char("y")).effects, [
      UiEffect.ReleaseTitle({ passphrase: Redacted.make("right"), vault: "Personal", title: "spare" }),
    ])
    assertCancels(onRetired.state, Key.char("x"))
    assert.deepStrictEqual(press(before, Key.char("x")).state, before)
  })

  it("renames from a prompt with one request, then shows every old and new Reference until dismissed", () => {
    const prompted = press(listed(["Stripe key"]), Key.char("n"), ...typing("Stripe live"))
    assert.include(modalText(prompted.state), "Stripe live")

    const sent = press(prompted.state, Key.named("return"))
    assert.deepStrictEqual(sent.effects, [
      UiEffect.RenameItem({
        passphrase: Redacted.make("right"),
        vault: "Personal",
        item: "Stripe key",
        newTitle: "Stripe live",
      }),
    ])
    assert.deepStrictEqual(press(sent.state, Key.char("x"), Key.named("return")).effects, [])

    const renamed = Reducer.reduce(
      sent.state,
      Event.Renamed({
        receipt: {
          vault: "Personal",
          from: "Stripe key",
          to: "Stripe live",
          references: [{ old: "hush://Personal/Stripe key/credential", new: "hush://Personal/Stripe live/credential" }],
        },
      }),
    )

    assert.deepStrictEqual(asked(renamed.effects), ["Personal"])
    assert.include(modalText(renamed.state), "hush://Personal/Stripe key/credential")
    assert.include(modalText(renamed.state), "hush://Personal/Stripe live/credential")
    const dismissed = press(renamed.state, Key.named("escape")).state
    assert.deepStrictEqual(State.$is("Open")(dismissed) ? dismissed.modals : undefined, [])
  })

  it("sends no rename for an empty title, cancels on Escape, and takes keys again under a refusal's notice", () => {
    const before = listed(["Stripe key"])

    assert.deepStrictEqual(press(before, Key.char("n"), Key.named("return")).effects, [])
    assert.deepStrictEqual(press(before, Key.char("n"), Key.char("a"), Key.named("escape")).state, before)

    const sent = press(before, Key.char("n"), Key.char("a"), Key.named("return")).state
    const problem = Problem.Failed({ message: "An Item titled a already exists in Vault Personal." })
    const refused = Reducer.reduce(sent, Event.ChangeRefused({ problem })).state
    assert.include(modalText(refused), "already exists")

    const editing = press(refused, Key.named("escape"), Key.char("b"), Key.named("return"))
    assert.deepStrictEqual(asked(editing.effects), ["RenameItem"])
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

    const late = Event.Unlocked({
      attempt: 1,
      passphrase: Redacted.make("right"),
      vaults: [vault("Personal", 0)],
      clipboard: false,
    })

    assert.deepStrictEqual(Reducer.reduce(suspended.state, late), { state: State.locked(1), effects: [] })

    // Submitted again before the first check answers: the first check's answer is still dropped.
    const again = press(suspended.state, ...typing("other"), Key.named("return")).state
    assert.deepStrictEqual(Reducer.reduce(again, late), { state: again, effects: [] })
    assert.deepStrictEqual(
      Reducer.reduce(again, Event.UnlockRefused({ attempt: 1, problem: Problem.Incorrect({ retryAfterSeconds: 0 }) })),
      {
        state: again,
        effects: [],
      },
    )

    const current = Event.Unlocked({ attempt: 2, passphrase: Redacted.make("other"), vaults: [], clipboard: false })
    assert.strictEqual(Reducer.reduce(again, current).state._tag, "Open")

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

// The hint bar, and the topmost modal's title and text, as drawn; a frame too small for the UI is its notice.
const drawn = (state: State) =>
  Display.$match(Display.of(state), {
    Locked: ({ hints }) => ({ hints, title: "", modal: "" }),
    Open: ({ hints, modalTitle, modal }) => ({ hints, title: modalTitle, modal: modal ?? "" }),
    TooSmall: ({ notice }) => ({ hints: notice, title: "", modal: "" }),
  })

// Every Key event `anyKey` makes, plus `?` and the view keys it leaves out.
const withHelpKeys: fc.Arbitrary<Event> = fc.oneof(
  anyEvent,
  fc.constantFrom(..."?relhe".split("").map(Key.char)).map((key) => Event.Key({ key })),
)

// The modal box is 70% of an 80-column frame, less its border.
const modalColumns = 54

describe("Reducer help and hints", () => {
  it("fits the hint bar in 80 columns, and each help line in the modal, in every state any events reach", () => {
    fc.assert(
      fc.property(fc.array(withHelpKeys, { maxLength: 40 }), (events) => {
        for (const { state } of run(events)) {
          const { hints, title, modal } = drawn(state)
          assert.isAtMost(hints.length, 80, hints)

          if (title === "Help") for (const line of modal.split("\n")) assert.isAtMost(line.length, modalColumns, line)
        }
      }),
    )
  })

  it("opens the help for the Item rows on ?, and any key but Ctrl-C and Ctrl-Z closes it with nothing sent", () => {
    const rows = listed(["a"], ["old title"])
    const help = press(rows, Key.char("?"))
    const shownHelp = drawn(help.state)

    assert.deepStrictEqual(help.effects, [])
    assert.strictEqual(shownHelp.title, "Help")
    assert.include(shownHelp.modal, "rename the Item")
    assert.include(shownHelp.modal, "release the Retired title")
    assert.notInclude(shownHelp.modal, "create a Vault")
    assert.include(shownHelp.hints, "Any key")

    const closing = anyKey.filter((key) => !Key.is(key, "c", { ctrl: true }) && !Key.is(key, "z", { ctrl: true }))

    fc.assert(
      fc.property(closing, (key) => {
        assert.deepStrictEqual(press(help.state, key), { state: rows, effects: [] })
      }),
    )
  })

  it("lists the keys of the view under it: the sidebar, the Item detail, the Token table and the Audit Log", () => {
    const helpOf = (state: State) => drawn(press(state, Key.char("?")).state).modal

    assert.include(helpOf(opened()), "create a Vault")
    assert.include(helpOf(press(listed(["a"]), Key.named("return")).state), "reveal the Field")
    assert.include(helpOf(tokensOpened()), "revoke the Token")

    const audit = press(opened(), Key.named("down"), Key.named("down"), Key.named("down"), Key.named("return")).state
    assert.include(helpOf(audit), "PgUp, PgDn")
  })

  it("lists a notice's keys over the notice, which stays once the help closes", () => {
    const problem = Problem.Failed({ message: "Vault Work does not exist on this Server." })
    const work = press(opened(), Key.named("down"), Key.named("return")).state
    const refused = Reducer.reduce(work, Event.ItemsRefused({ vault: "Work", problem })).state
    const help = press(refused, Key.char("?")).state

    assert.include(drawn(help).modal, "Enter, Esc")
    assert.strictEqual(drawn(press(help, Key.char("x")).state).modal, problem.message)
  })

  it("types ? into the filter and the rename prompt, and cancels a Confirm on ?, instead of opening the help", () => {
    const filtering = press(opened(["a"]), Key.char("/"), Key.char("?")).state
    assert.notStrictEqual(drawn(filtering).title, "Help")
    assert.strictEqual(
      Display.$match(Display.of(filtering), { Locked: () => "", Open: ({ filter }) => filter, TooSmall: () => "" }),
      "/?_",
    )

    const renaming = press(listed(["a"]), Key.char("n"), Key.char("?")).state
    assert.include(drawn(renaming).modal, "New title: ?_")

    const rows = listed(["a"])
    assert.deepStrictEqual(press(rows, Key.char("d"), Key.char("?")), { state: rows, effects: [] })
  })
})

const resized = (state: State, width: number, height: number) => Reducer.reduce(state, Event.Resize({ width, height }))

describe("Reducer resize", () => {
  it("draws one notice below 80x24, takes no key but Ctrl-C and Ctrl-Z there, and redraws the view at 80x24", () => {
    const rows = listed(["a"])

    for (const [width, height] of [
      [79, 24],
      [80, 23],
      [20, 5],
    ] as const) {
      const small = resized(rows, width, height)
      assert.deepStrictEqual(small.effects, [])
      const { hints } = drawn(small.state)
      assert.include(hints, `${width}x${height}`)
      assert.include(hints, "80x24")
      assert.notInclude(hints, "\n")

      fc.assert(
        fc.property(
          anyKey.filter((key) => !Key.is(key, "c", { ctrl: true })),
          (key) => {
            assert.deepStrictEqual(press(small.state, key), { state: small.state, effects: [] })
          },
        ),
      )

      assert.deepStrictEqual(asked(press(small.state, Key.named("c", { ctrl: true })).effects), ["Quit"])
      assert.deepStrictEqual(asked(press(small.state, Key.named("z", { ctrl: true })).effects), ["Suspend"])
      assert.deepStrictEqual(drawn(resized(small.state, 80, 24).state), drawn(rows))
    }
  })

  it("keeps the frame size through a Lock, so the prompt is drawn at the size the terminal has", () => {
    const small = resized(opened(), 60, 20).state
    const locked = press(small, Key.named("z", { ctrl: true })).state

    assert.strictEqual(locked._tag, "Locked")
    assert.include(drawn(locked).hints, "60x20")
  })
})
