import { Redacted } from "effect"

import { Audit, type Move } from "./Audit.js"
import { Concealed } from "./Concealed.js"
import { Event } from "./Event.js"
import { Key } from "./Key.js"
import { Problem } from "./Problem.js"
import { Sidebar } from "./Sidebar.js"
import { State, type Locked, type Open, type Vault } from "./State.js"
import { UiEffect } from "./UiEffect.js"
import { type Filter, type Modal, View } from "./View.js"

type ItemList = Extract<View, { readonly _tag: "ItemList" }>

type AuditView = Extract<View, { readonly _tag: "Audit" }>

// The pure reducer: one event and the current state in, the next state and the effects to run out. It never
// imports the renderer or the Client; `Ui` runs the effects and draws the state.

export interface Step {
  readonly state: State
  readonly effects: ReadonlyArray<UiEffect>
}

const stay = (state: State): Step => ({ state, effects: [] })

// Quitting drops everything Open held before the renderer goes.
const quit = (): Step => ({ state: State.locked(), effects: [UiEffect.Quit()] })

const isQuitChord = (key: Key) => Key.is(key, "c", { ctrl: true })

const isSuspendChord = (key: Key) => Key.is(key, "z", { ctrl: true })

// Ctrl-Z or SIGTSTP: Lock first, so nothing Open held survives the suspension, then suspend. `attempt` carries a
// Locked prompt's count over, so a wait tick of an earlier attempt stays stale.
const suspend = (attempt?: number): Step => ({ state: State.locked(attempt), effects: [UiEffect.Suspend()] })

const idleLimit = 10 * 60 * 1_000

// Locks once ten minutes have passed since the first tick after the last keypress.
const idleTick = (state: Open, now: number): Step =>
  State.Idle.$match(state.idle, {
    Active: () => stay({ ...state, idle: State.Idle.Since({ since: now }) }),
    Since: ({ since }) => (now - since >= idleLimit ? stay(State.locked()) : stay(state)),
  })

// The text a paste adds to a one-line input: everything before its first line break.
const firstLine = (text: string) => text.split(/[\r\n]/, 1)[0] ?? ""

const oneSecond = 1_000

const tick = (attempt: number) => UiEffect.After({ millis: oneSecond, event: Event.WaitTick({ attempt }) })

// A refusal shown at the prompt, with the next tick of its wait while one remains.
const refusedWith = (state: Locked, problem: Problem): Step => {
  const refused = { ...state, phase: State.Phase.Refused({ problem }) }

  return Problem.wait(problem) === 0 ? stay(refused) : { state: refused, effects: [tick(state.attempt)] }
}

// The Audit view's move as a step: its view, and its request with the held Passphrase.
const auditStep = (state: Open, { view, ask }: Move): Step => ({
  state: { ...state, view },
  effects: ask === undefined ? [] : [UiEffect.ListAudit({ passphrase: state.passphrase, ask })],
})

// The view for the sidebar row at `cursor`: a Vault and its one Item request, or a section and its first request.
const select = (state: Open, cursor: number): Step => {
  const selected = state.vaults[cursor]

  if (Sidebar.section(state.vaults.length, cursor) === "Audit") return auditStep({ ...state, cursor }, Audit.start())

  if (selected === undefined) return stay({ ...state, view: View.NoVaults() })

  return {
    state: { ...state, cursor, view: View.loading(selected.vault) },
    effects: [UiEffect.ListItems({ passphrase: state.passphrase, vault: selected.vault })],
  }
}

// Open on the first Vault, if any.
const openOn = (passphrase: Redacted.Redacted<string>, vaults: ReadonlyArray<Vault>): Step => {
  const open = State.Open({
    passphrase,
    vaults,
    cursor: 0,
    view: View.NoVaults(),
    modals: [],
    idle: State.Idle.Active(),
  })

  return vaults.length === 0 ? stay(open) : select(open, 0)
}

const lockedKey = (state: Locked, key: Key): Step => {
  if (isQuitChord(key)) return quit()

  if (isSuspendChord(key)) return suspend(state.attempt)

  if (State.Phase.$is("Checking")(state.phase)) return stay(state)

  if (Key.is(key, "return")) {
    if (state.entered.length === 0) return stay({ ...state, phase: State.Phase.Empty() })
    const attempt = state.attempt + 1

    return {
      state: State.Locked({ entered: Concealed.empty, phase: State.Phase.Checking(), attempt }),
      effects: [UiEffect.ListVaults({ passphrase: Redacted.make(Redacted.value(state.entered.value)) })],
    }
  }

  if (Key.is(key, "backspace")) return stay({ ...state, entered: Concealed.backspace(state.entered) })
  const text = Key.printable(key)

  return text === undefined ? stay(state) : stay({ ...state, entered: Concealed.append(state.entered, text) })
}

const fromLocked = (state: Locked, event: Event): Step => {
  const checking = State.Phase.$is("Checking")(state.phase)

  return Event.$match(event, {
    Key: ({ key }) => lockedKey(state, key),
    Paste: ({ text }) =>
      checking ? stay(state) : stay({ ...state, entered: Concealed.append(state.entered, firstLine(text)) }),
    // An unlock answered after a quit or a newer attempt is dropped, Passphrase and all.
    Unlocked: ({ passphrase, vaults }) => (checking ? openOn(passphrase, vaults) : stay(state)),
    UnlockRefused: ({ problem }) => (checking ? refusedWith(state, problem) : stay(state)),
    WaitTick: ({ attempt }) =>
      attempt === state.attempt && State.Phase.$is("Refused")(state.phase)
        ? refusedWith(state, Problem.tick(state.phase.problem))
        : stay(state),
    // Answers for an Open UI that Locked meanwhile: dropped.
    ItemsLoaded: () => stay(state),
    ItemsRefused: () => stay(state),
    AuditListed: () => stay(state),
    AuditRefused: () => stay(state),
    // Nothing to time out: Locked holds no Passphrase.
    IdleTick: () => stay(state),
    // The typed input goes too, and a check in flight is dropped when it answers.
    Suspend: () => suspend(state.attempt),
    Closed: quit,
    // A Reveal answered after a Lock: dropped, value and all.
    Revealed: () => stay(state),
    RevealRefused: () => stay(state),
    RevealExpired: () => stay(state),
  })
}

// Keys while the filter is being typed: text edits it, Enter applies it, Escape clears it.
const filterKey = (state: Open, view: ItemList, text: string, key: Key): Step => {
  const withFilter = (filter: Filter) => stay({ ...state, view: { ...view, filter } })

  if (Key.is(key, "return")) return withFilter(View.Filter.Applied({ text }))

  if (Key.is(key, "escape")) return withFilter(View.Filter.Applied({ text: "" }))

  if (Key.is(key, "backspace")) return withFilter(View.Filter.Editing({ text: [...text].slice(0, -1).join("") }))
  const typed = Key.printable(key)

  return typed === undefined ? stay(state) : withFilter(View.Filter.Editing({ text: text + typed }))
}

// The topmost modal takes every key; Escape or Enter dismisses it.
const modalKey = (state: Open, key: Key): Step =>
  Key.is(key, "escape") || Key.is(key, "return") ? stay({ ...state, modals: state.modals.slice(0, -1) }) : stay(state)

const openKey = (state: Open, key: Key): Step => {
  const { view } = state

  if (isQuitChord(key)) return quit()

  if (isSuspendChord(key)) return suspend()

  if (state.modals.length > 0) return modalKey(state, key)
  const audit = View.$is("Audit")(view) ? Audit.key(view, key) : undefined

  if (audit !== undefined) return auditStep(state, audit)

  if (View.$is("ItemList")(view) && View.Filter.$is("Editing")(view.filter))
    return filterKey(state, view, view.filter.text, key)

  if (View.$is("ItemDetail")(view)) return detailKey(state, view, key)

  if (Key.is(key, "q")) return quit()

  if (View.$is("ItemList")(view) && View.Focus.$is("Rows")(view.focus)) {
    const onRows = rowsKey(state, view, view.focus.row, key)

    if (onRows !== undefined) return onRows
  }

  if (View.$is("ItemList")(view) && (Key.is(key, "tab") || Key.is(key, "right") || Key.is(key, "l")))
    return toRows(state, view)

  if (Key.is(key, "up") || Key.is(key, "k")) return stay({ ...state, cursor: Math.max(0, state.cursor - 1) })

  if (Key.is(key, "down") || Key.is(key, "j"))
    return stay({ ...state, cursor: Math.min(Sidebar.rows(state.vaults.length) - 1, state.cursor + 1) })

  if (Key.is(key, "return")) return select(state, state.cursor)

  if (View.$is("ItemList")(view) && Key.is(key, "/"))
    return stay({ ...state, view: { ...view, filter: View.Filter.Editing({ text: view.filter.text }) } })

  if (View.$is("ItemList")(view) && Key.is(key, "escape"))
    return stay({ ...state, view: { ...view, filter: View.Filter.Applied({ text: "" }) } })

  return stay(state)
}

// How long a Revealed value stays drawn unless a key hides it first.
const revealMillis = 10_000

// Keys on the Item rows that move the row cursor, open the Item under it, or go back to the sidebar; undefined for
// every other key, which the Item list handles as on the sidebar.
const rowsKey = (state: Open, view: ItemList, row: number, key: Key): Step | undefined => {
  const withRow = (next: number) =>
    stay({ ...state, view: { ...view, focus: View.Focus.Rows({ row: Math.max(0, next) }) } })

  const last = View.shown(view).length - 1

  if (Key.is(key, "up") || Key.is(key, "k")) return withRow(Math.min(row, last) - 1)

  if (Key.is(key, "down") || Key.is(key, "j")) return withRow(Math.min(last, row + 1))

  if (Key.is(key, "tab") || Key.is(key, "left") || Key.is(key, "h"))
    return stay({ ...state, view: { ...view, focus: View.Focus.Sidebar() } })

  if (!Key.is(key, "return")) return undefined
  const item = View.selectedItem(view)

  return item === undefined ? stay(state) : stay({ ...state, view: View.detail(view, item) })
}

// Tab (or Right) from the sidebar moves to the Item rows once some are shown.
const toRows = (state: Open, view: ItemList): Step =>
  View.shown(view).length === 0
    ? stay(state)
    : stay({ ...state, view: { ...view, focus: View.Focus.Rows({ row: 0 }) } })

type ItemDetail = Extract<View, { readonly _tag: "ItemDetail" }>

// Keys in the Item detail. While a value is drawn, any key only hides it; otherwise Up/Down move the Field cursor,
// `r` Reveals the Field under it (one request), Escape returns to the Item list and `q` quits.
const detailKey = (state: Open, view: ItemDetail, key: Key): Step => {
  const withDetail = (next: ItemDetail) => stay({ ...state, view: next })

  if (View.Reveal.$is("Shown")(view.reveal)) return withDetail({ ...view, reveal: View.Reveal.Hidden() })

  if (Key.is(key, "escape")) return stay({ ...state, view: View.ItemList(view.list) })

  if (Key.is(key, "q")) return quit()

  if (View.Reveal.$is("Asking")(view.reveal)) return stay(state)

  if (Key.is(key, "up") || Key.is(key, "k")) return withDetail({ ...view, field: Math.max(0, view.field - 1) })

  if (Key.is(key, "down") || Key.is(key, "j"))
    return withDetail({ ...view, field: Math.min(view.item.fields.length - 1, view.field + 1) })
  const field = View.selectedField(view)

  if (!Key.is(key, "r") || field === undefined) return stay(state)
  const generation = view.reveals + 1
  const reference = View.reference(view.list.vault, view.item, field.label)

  return {
    state: { ...state, view: { ...view, reveal: View.Reveal.Asking({ generation, reference }), reveals: generation } },
    effects: [UiEffect.Reveal({ passphrase: state.passphrase, reference, generation })],
  }
}

// `update` applied to the Item detail while it waits for the Reveal numbered `generation` of `reference`; an answer
// for any other Reveal, or after the Owner left the detail, is dropped with its value.
const revealAnswer = (
  state: Open,
  answer: { readonly reference: string; readonly generation: number },
  update: (view: ItemDetail) => Step,
): Step => {
  const { view } = state

  return View.$is("ItemDetail")(view) &&
    View.Reveal.$is("Asking")(view.reveal) &&
    view.reveal.generation === answer.generation &&
    view.reveal.reference === answer.reference
    ? update(view)
    : stay(state)
}

// The Revealed value of the Reveal numbered `generation`, drawn until its hide tick.
const shownValue = (
  state: Open,
  view: ItemDetail,
  { reference, generation, value }: Extract<Event, { readonly _tag: "Revealed" }>,
): Step => ({
  state: { ...state, view: { ...view, reveal: View.Reveal.Shown({ generation, reference, value }) } },
  effects: [UiEffect.After({ millis: revealMillis, event: Event.RevealExpired({ generation }) })],
})

// The hide tick of the value drawn now; a tick of an earlier Reveal changes nothing.
const expired = (state: Open, generation: number): Step => {
  const { view } = state

  return View.$is("ItemDetail")(view) && View.Reveal.$is("Shown")(view.reveal) && view.reveal.generation === generation
    ? stay({ ...state, view: { ...view, reveal: View.Reveal.Hidden() } })
    : stay(state)
}

// A paste into the filter being typed; ignored anywhere else.
const openPaste = (state: Open, text: string): Step => {
  const { view } = state

  if (state.modals.length === 0 && View.$is("Audit")(view))
    return stay({ ...state, view: Audit.paste(view, firstLine(text)) })

  if (state.modals.length > 0 || !View.$is("ItemList")(view) || !View.Filter.$is("Editing")(view.filter))
    return stay(state)

  return stay({
    ...state,
    view: { ...view, filter: View.Filter.Editing({ text: view.filter.text + firstLine(text) }) },
  })
}

// `update` applied to the Item list of `vault` while it is still being fetched; any other view is left alone,
// so an answer for a Vault no longer selected is dropped.
const answerFor = (state: Open, vault: string, update: (view: ItemList) => Open): Step => {
  const { view } = state

  return View.$is("ItemList")(view) && view.vault === vault && View.Items.$is("Loading")(view.items)
    ? stay(update(view))
    : stay(state)
}

// An Audit answer applied by `update`, with `notices` stacked on top; dropped when the Audit view is gone or no
// longer waiting for it.
const auditAnswer = (
  state: Open,
  update: (view: AuditView) => AuditView | undefined,
  notices: ReadonlyArray<Modal>,
): Step => {
  const { view } = state
  const answered = View.$is("Audit")(view) ? update(view) : undefined

  return answered === undefined
    ? stay(state)
    : stay({ ...state, view: answered, modals: [...state.modals, ...notices] })
}

// Input restarts the idle time.
const active = (state: Open): Open => ({ ...state, idle: State.Idle.Active() })

const fromOpen = (state: Open, event: Event): Step =>
  Event.$match(event, {
    Key: ({ key }) => openKey(active(state), key),
    Paste: ({ text }) => openPaste(active(state), text),
    ItemsLoaded: ({ list }) =>
      answerFor(state, list.vault, (view) => ({
        ...state,
        view: { ...view, items: View.Items.Loaded({ items: list.items }) },
      })),
    ItemsRefused: ({ vault, problem }) =>
      answerFor(state, vault, (view) => ({
        ...state,
        view: { ...view, items: View.Items.Refused() },
        modals: [...state.modals, View.Modal.Notice({ problem })],
      })),
    AuditListed: ({ ask, query, page }) => auditAnswer(state, (view) => Audit.listed(view, ask, query, page), []),
    AuditRefused: ({ ask, problem }) =>
      auditAnswer(state, (view) => Audit.refused(view, ask), [View.Modal.Notice({ problem })]),
    // Locked-only events: none reaches an Open UI except late, and none changes it.
    Unlocked: () => stay(state),
    UnlockRefused: () => stay(state),
    WaitTick: () => stay(state),
    IdleTick: ({ now }) => idleTick(state, now),
    Suspend: () => suspend(),
    Closed: quit,
    Revealed: (answer) => revealAnswer(state, answer, (view) => shownValue(state, view, answer)),
    RevealRefused: (answer) =>
      revealAnswer(state, answer, (view) =>
        stay({
          ...state,
          view: { ...view, reveal: View.Reveal.Hidden() },
          modals: [...state.modals, View.Modal.Notice({ problem: answer.problem })],
        }),
      ),
    RevealExpired: ({ generation }) => expired(state, generation),
  })

export const reduce = (state: State, event: Event): Step =>
  State.$match(state, {
    Locked: (locked) => fromLocked(locked, event),
    Open: (open) => fromOpen(open, event),
  })

export * as Reducer from "./Reducer.js"
