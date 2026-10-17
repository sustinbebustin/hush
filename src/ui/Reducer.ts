import { Redacted, Result } from "effect"

import type { TokenIssueReceipt } from "../shared/Api.js"
import type { Written } from "./Clipboard.js"
import { Concealed } from "./Concealed.js"
import { Event } from "./Event.js"
import { IssueForm } from "./IssueForm.js"
import { Key } from "./Key.js"
import { Problem } from "./Problem.js"
import { State, type Locked, type Open, type Vault } from "./State.js"
import { UiEffect } from "./UiEffect.js"
import { type Filter, type Modal, View } from "./View.js"

type ItemList = Extract<View, { readonly _tag: "ItemList" }>

type TokensView = Extract<View, { readonly _tag: "Tokens" }>

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

// The text a paste adds to a one-line input: everything before its first line break.
const firstLine = (text: string) => text.split(/[\r\n]/, 1)[0] ?? ""

const oneSecond = 1_000

const tick = (attempt: number) => UiEffect.After({ millis: oneSecond, event: Event.WaitTick({ attempt }) })

// A refusal shown at the prompt, with the next tick of its wait while one remains.
const refusedWith = (state: Locked, problem: Problem): Step => {
  const refused = { ...state, phase: State.Phase.Refused({ problem }) }

  return Problem.wait(problem) === 0 ? stay(refused) : { state: refused, effects: [tick(state.attempt)] }
}

// The view for the Vault at `cursor`, and its one Item request.
const select = (state: Open, cursor: number): Step => {
  const selected = state.vaults[cursor]

  if (selected === undefined) return stay({ ...state, view: View.NoVaults() })

  return {
    state: { ...state, cursor, view: View.loading(selected.vault) },
    effects: [UiEffect.ListItems({ passphrase: state.passphrase, vault: selected.vault })],
  }
}

// The Tokens view, and its one `tokens/list`; a refresh keeps the table's row.
const listTokens = (state: Open): Step => {
  const { view } = state
  const row = View.$is("Tokens")(view) && View.TokenTable.$is("Loaded")(view.table) ? view.table.row : 0

  return {
    state: { ...state, view: View.tokensLoading(row) },
    effects: [UiEffect.ListTokens({ passphrase: state.passphrase })],
  }
}

// The view for the sidebar row at `cursor`: a Vault, or an entry below the Vaults.
const selectRow = (state: Open, cursor: number): Step => {
  const entry = State.entries[cursor - state.vaults.length]

  return entry === "Tokens" ? listTokens({ ...state, cursor }) : select(state, cursor)
}

// Open on the first Vault.
const openOn = (passphrase: Redacted.Redacted<string>, vaults: ReadonlyArray<Vault>): Step =>
  select(State.Open({ passphrase, vaults, cursor: 0, view: View.NoVaults(), modals: [] }), 0)

const lockedKey = (state: Locked, key: Key): Step => {
  if (isQuitChord(key)) return quit()

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
    TokensLoaded: () => stay(state),
    TokensRefused: () => stay(state),
    TokenRevoked: () => stay(state),
    RevokeRefused: () => stay(state),
    // An issue answered after a Lock: the Token is dropped unseen, and stays valid until revoked.
    TokenIssued: () => stay(state),
    IssueRefused: () => stay(state),
    TokenCopied: () => stay(state),
    Closed: quit,
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

// The state without its topmost modal.
const dismissed = (state: Open): Open => ({ ...state, modals: state.modals.slice(0, -1) })

// The state with its topmost modal replaced by `modal`.
const withTop = (state: Open, modal: Modal): Open => ({ ...state, modals: [...state.modals.slice(0, -1), modal] })

const withNotice = (state: Open, problem: Problem): Open => ({
  ...state,
  modals: [...state.modals, View.Modal.Notice({ problem })],
})

type IssueFormModal = Extract<Modal, { readonly _tag: "IssueForm" }>

type IssuedModal = Extract<Modal, { readonly _tag: "Issued" }>

// Keys in the issue form: Escape cancels it, Enter sends its one `tokens/issue` (or says why it cannot), anything
// else edits it. While the request is out, nothing but Ctrl-C does anything.
const issueFormKey = (state: Open, top: IssueFormModal, key: Key): Step => {
  if (top.phase === "sending") return stay(state)

  if (Key.is(key, "escape")) return stay(dismissed(state))

  if (!Key.is(key, "return")) return stay(withTop(state, { ...top, form: IssueForm.key(top.form, key) }))

  return Result.match(IssueForm.submit(top.form), {
    onFailure: (problem) => stay(withNotice(state, problem)),
    onSuccess: (fields) => ({
      state: withTop(state, { ...top, phase: "sending" }),
      effects: [UiEffect.IssueToken({ passphrase: state.passphrase, fields })],
    }),
  })
}

const noClipboard = Problem.Failed({
  message:
    "This machine has no clipboard the UI can write to (it needs macOS, Wayland or X11), so the Token was not copied. Copy it from the screen instead; it stays shown until you dismiss it.",
})

// Keys on the issued Token: Escape or Enter dismisses it for good; `c` copies it to the host clipboard.
const issuedKey = (state: Open, top: IssuedModal, key: Key): Step => {
  if (Key.is(key, "escape") || Key.is(key, "return")) return stay(dismissed(state))

  if (!Key.is(key, "c") || top.copy === "copying") return stay(state)

  if (top.copy === "absent") return stay(withNotice(state, noClipboard))

  return { state: withTop(state, { ...top, copy: "copying" }), effects: [UiEffect.CopyToken({ token: top.token })] }
}

// The topmost modal takes every key: Escape or Enter dismisses a notice; `y` runs a confirmation's effect and any
// other key cancels it.
const modalKey = (state: Open, top: Modal, key: Key): Step =>
  View.Modal.$match(top, {
    Notice: () => (Key.is(key, "escape") || Key.is(key, "return") ? stay(dismissed(state)) : stay(state)),
    Confirm: ({ effect }) =>
      Key.is(key, "y") ? { state: dismissed(state), effects: [effect] } : stay(dismissed(state)),
    IssueForm: (form) => issueFormKey(state, form, key),
    Issued: (issued) => issuedKey(state, issued, key),
  })

// The issue form over the Tokens view; Labels of the listed Tokens can be replaced.
const openIssueForm = (state: Open, view: TokensView): Step => {
  const tokens = View.TokenTable.$is("Loaded")(view.table) ? view.table.tokens : []

  return stay({
    ...state,
    modals: [
      ...state.modals,
      View.Modal.IssueForm({
        form: IssueForm.open(
          state.vaults.map(({ vault }) => vault),
          tokens,
        ),
        phase: "editing",
      }),
    ],
  })
}

// The issued Token's modal in place of the form that asked for it, and the table refreshed to list the Token.
const issued = (state: Open, receipt: TokenIssueReceipt, copyable: boolean): Step => {
  const shown = View.Modal.Issued({
    label: receipt.label,
    token: receipt.token,
    replaced: receipt.replaced,
    copy: copyable ? "ready" : "absent",
  })

  const next = { ...state, modals: [...state.modals.filter((modal) => !View.Modal.$is("IssueForm")(modal)), shown] }

  return View.$is("Tokens")(next.view) ? listTokens(next) : stay(next)
}

// A refused issue: the form takes keys again, under the notice saying why.
const issueRefused = (state: Open, problem: Problem): Step => {
  const modals = state.modals.map((modal) =>
    View.Modal.$is("IssueForm")(modal) ? View.Modal.IssueForm({ ...modal, phase: "editing" }) : modal,
  )

  return stay(withNotice({ ...state, modals }, problem))
}

const copyFailed = {
  unsupported: noClipboard,
  failed: Problem.Failed({
    message:
      "Could not write the Token to the clipboard (the write timed out or the platform refused it); it was not copied. Press c to try again, or copy it from the screen.",
  }),
} as const

// A copy's answer, for the issued Token still on screen; after a dismissal it is dropped.
const copied = (state: Open, written: Written): Step => {
  const top = state.modals.at(-1)

  if (top === undefined || !View.Modal.$is("Issued")(top) || top.copy !== "copying") return stay(state)

  return written === "written"
    ? stay(withTop(state, { ...top, copy: "copied" }))
    : stay(withNotice(withTop(state, { ...top, copy: "ready" }), copyFailed[written]))
}

// Keys while the Token table has the focus: Up and Down move its row, Escape hands the focus back to the sidebar.
const tableKey = (state: Open, view: TokensView, key: Key): Step => {
  const { table } = view
  const withView = (next: TokensView) => stay({ ...state, view: next })

  if (Key.is(key, "escape")) return withView({ ...view, focus: "sidebar" })

  if (!View.TokenTable.$is("Loaded")(table)) return stay(state)
  const token = table.tokens[table.row]

  if (Key.is(key, "d") && token !== undefined)
    return stay({
      ...state,
      modals: [
        ...state.modals,
        View.Modal.Confirm({
          description: `Revoke Token ${token.label}? Every use of it is refused from then on; this cannot be undone.`,
          effect: UiEffect.RevokeToken({ passphrase: state.passphrase, label: token.label }),
        }),
      ],
    })

  if (Key.is(key, "up") || Key.is(key, "k"))
    return withView({ ...view, table: { ...table, row: Math.max(0, table.row - 1) } })

  if (Key.is(key, "down") || Key.is(key, "j"))
    return withView({
      ...view,
      table: { ...table, row: Math.max(0, Math.min(table.tokens.length - 1, table.row + 1)) },
    })

  return stay(state)
}

const openKey = (state: Open, key: Key): Step => {
  const { view } = state

  if (isQuitChord(key)) return quit()
  const top = state.modals.at(-1)

  if (top !== undefined) return modalKey(state, top, key)

  if (View.$is("ItemList")(view) && View.Filter.$is("Editing")(view.filter))
    return filterKey(state, view, view.filter.text, key)

  if (Key.is(key, "q")) return quit()

  if (View.$is("Tokens")(view) && Key.is(key, "i")) return openIssueForm(state, view)

  if (View.$is("Tokens")(view) && view.focus === "table") return tableKey(state, view, key)

  if (Key.is(key, "up") || Key.is(key, "k")) return stay({ ...state, cursor: Math.max(0, state.cursor - 1) })

  if (Key.is(key, "down") || Key.is(key, "j"))
    return stay({ ...state, cursor: Math.min(state.vaults.length + State.entries.length - 1, state.cursor + 1) })

  if (Key.is(key, "return")) return selectRow(state, state.cursor)

  if (View.$is("ItemList")(view) && Key.is(key, "/"))
    return stay({ ...state, view: { ...view, filter: View.Filter.Editing({ text: view.filter.text }) } })

  if (View.$is("ItemList")(view) && Key.is(key, "escape"))
    return stay({ ...state, view: { ...view, filter: View.Filter.Applied({ text: "" }) } })

  return stay(state)
}

// A paste into the filter being typed or a text row of the issue form; ignored anywhere else.
const openPaste = (state: Open, text: string): Step => {
  const { view } = state
  const top = state.modals.at(-1)

  if (top !== undefined && View.Modal.$is("IssueForm")(top) && top.phase === "editing")
    return stay(withTop(state, { ...top, form: IssueForm.paste(top.form, firstLine(text)) }))

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

// `update` applied to the Tokens view while its table is being fetched; an answer after the Owner moved on is dropped.
// `row` is the row the table returns to.
const tokensAnswer = (state: Open, update: (view: TokensView, row: number) => Open): Step => {
  const { view } = state

  return View.$is("Tokens")(view) && View.TokenTable.$is("Loading")(view.table)
    ? stay(update(view, view.table.row))
    : stay(state)
}

const fromOpen = (state: Open, event: Event): Step =>
  Event.$match(event, {
    Key: ({ key }) => openKey(state, key),
    Paste: ({ text }) => openPaste(state, text),
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
    TokensLoaded: ({ list }) =>
      tokensAnswer(state, (view, row) => ({
        ...state,
        view: {
          ...view,
          table: View.TokenTable.Loaded({
            tokens: list.tokens,
            row: Math.max(0, Math.min(list.tokens.length - 1, row)),
          }),
        },
      })),
    TokensRefused: ({ problem }) =>
      tokensAnswer(state, (view) => ({
        ...state,
        view: { ...view, table: View.TokenTable.Refused() },
        modals: [...state.modals, View.Modal.Notice({ problem })],
      })),
    // A revoke answered while the Tokens view is up refreshes its table.
    TokenRevoked: () => (View.$is("Tokens")(state.view) ? listTokens(state) : stay(state)),
    RevokeRefused: ({ problem }) => stay(withNotice(state, problem)),
    TokenIssued: ({ receipt, copyable }) => issued(state, receipt, copyable),
    IssueRefused: ({ problem }) => issueRefused(state, problem),
    TokenCopied: ({ written }) => copied(state, written),
    // Locked-only events: none reaches an Open UI except late, and none changes it.
    Unlocked: () => stay(state),
    UnlockRefused: () => stay(state),
    WaitTick: () => stay(state),
    Closed: quit,
  })

export const reduce = (state: State, event: Event): Step =>
  State.$match(state, {
    Locked: (locked) => fromLocked(locked, event),
    Open: (open) => fromOpen(open, event),
  })

export * as Reducer from "./Reducer.js"
