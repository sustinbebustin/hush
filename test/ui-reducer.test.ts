import { assert, describe, it } from "@effect/vitest"
import { Redacted } from "effect"
import * as fc from "fast-check"

import type { ItemMeta, TokenInfo, TokenIssueReceipt } from "../src/shared/Api.js"
import { Display } from "../src/ui/Display.js"
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
  Display.$match(Display.of(state), { Locked: () => "", Open: ({ modal }) => modal ?? "" })

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
  fc.constantFrom(..."qjk/idyc ".split("").map(Key.char)),
  fc.constantFrom("return", "backspace", "escape", "up", "down", "tab").map((name) => Key.named(name)),
  fc.constantFrom(Key.named("c", { ctrl: true }), Key.named("d", { ctrl: true }), Key.named("x", { meta: true })),
)

const anyProblem: fc.Arbitrary<Problem> = fc.oneof(
  fc.nat({ max: 3 }).map((retryAfterSeconds) => Problem.Incorrect({ retryAfterSeconds })),
  fc.nat({ max: 3 }).map((retryAfterSeconds) => Problem.Backoff({ retryAfterSeconds })),
  fc.constant(Problem.Failed({ message: "The hush Server at http://127.0.0.1:7787 has not been initialised." })),
)

const vaultName = fc.constantFrom("Personal", "Work")

// Every event but a correct Passphrase's answer (`Unlocked`).
const withoutUnlock: fc.Arbitrary<Event> = fc.oneof(
  anyKey.map((key) => Event.Key({ key })),
  fc.string().map((text) => Event.Paste({ text })),
  anyProblem.map((problem) => Event.UnlockRefused({ problem })),
  fc
    .tuple(vaultName, fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }))
    .map(([name, titles]) => Event.ItemsLoaded({ list: { vault: name, items: titles.map(item), retired: [] } })),
  fc.tuple(vaultName, anyProblem).map(([name, problem]) => Event.ItemsRefused({ vault: name, problem })),
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

  it("keeps the cursor on the sidebar: the Vaults, then the entries below them", () => {
    const top = press(opened(), Key.named("up"))
    const downs = Array.from({ length: 2 + State.entries.length + 2 }, () => Key.named("down"))
    const bottom = press(opened(), ...downs)

    assert.strictEqual(State.$is("Open")(top.state) ? top.state.cursor : undefined, 0)
    assert.strictEqual(State.$is("Open")(bottom.state) ? bottom.state.cursor : undefined, 1 + State.entries.length)
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
      Display.$match(Display.of(issue(false)), { Locked: () => "", Open: ({ hints }) => hints }),
      "c copy",
    )
    assert.include(Display.$match(Display.of(issue(true)), { Locked: () => "", Open: ({ hints }) => hints }), "c copy")
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
})
