import { Redacted, Result } from "effect"

import type { ItemRenamed, TokenIssueReceipt } from "../shared/Api.js"
import { Audit, type Move } from "./Audit.js"
import type { Written } from "./Clipboard.js"
import { Concealed } from "./Concealed.js"
import { Event } from "./Event.js"
import { IssueForm } from "./IssueForm.js"
import { Key } from "./Key.js"
import { Problem } from "./Problem.js"
import { Sidebar } from "./Sidebar.js"
import { State, type Locked, type Open, type Vault } from "./State.js"
import { UiEffect } from "./UiEffect.js"
import { type Filter, type Modal, View } from "./View.js"

type ItemList = Extract<View, { readonly _tag: "ItemList" }>

type AuditView = Extract<View, { readonly _tag: "Audit" }>

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

// The Tokens view, and its one `tokens/list`; a refresh keeps the table's row.
const listTokens = (state: Open): Step => {
  const { view } = state
  const row = View.$is("Tokens")(view) && View.Focus.$is("Rows")(view.focus) ? view.focus.row : 0

  return {
    state: { ...state, view: View.tokensLoading(row) },
    effects: [UiEffect.ListTokens({ passphrase: state.passphrase })],
  }
}

// The view for the sidebar row at `cursor`: a Vault and its one Item request, or a section and its first request.
const select = (state: Open, cursor: number): Step => {
  const selected = state.vaults[cursor]
  const section = Sidebar.section(state.vaults.length, cursor)

  if (section === "Tokens") return listTokens({ ...state, cursor })

  if (section === "Audit") return auditStep({ ...state, cursor }, Audit.start())

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
    TokensLoaded: () => stay(state),
    TokensRefused: () => stay(state),
    TokenRevoked: () => stay(state),
    RevokeRefused: () => stay(state),
    // An issue answered after a Lock: the Token is dropped unseen, and stays valid until revoked.
    TokenIssued: () => stay(state),
    IssueRefused: () => stay(state),
    TokenCopied: () => stay(state),
    // Vault answers after a Lock: dropped.
    VaultChanged: () => stay(state),
    VaultRefused: () => stay(state),
    VaultsListed: () => stay(state),
    Closed: quit,
    // A Reveal answered after a Lock: dropped, value and all.
    Revealed: () => stay(state),
    RevealRefused: () => stay(state),
    RevealExpired: () => stay(state),
    // A rename, delete or release answered after a Lock: the change stands; the next Open lists it.
    Renamed: () => stay(state),
    ItemsChanged: () => stay(state),
    ChangeRefused: () => stay(state),
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

type VaultNameModal = Extract<Modal, { readonly _tag: "VaultName" }>

// Keys in the Vault name prompt: Escape cancels it, Enter sends its one `vaults/create` (a name the CLI would refuse
// comes back as that refusal, unsent), anything else edits the name. While the request is out, nothing does anything.
const vaultNameKey = (state: Open, top: VaultNameModal, key: Key): Step => {
  if (top.phase === "sending") return stay(state)
  const edit = (text: string) => stay(withTop(state, { ...top, text }))

  if (Key.is(key, "escape")) return stay(dismissed(state))

  if (Key.is(key, "return"))
    return {
      state: withTop(state, { ...top, phase: "sending" }),
      effects: [UiEffect.CreateVault({ passphrase: state.passphrase, vault: top.text })],
    }

  if (Key.is(key, "backspace")) return edit([...top.text].slice(0, -1).join(""))
  const typed = Key.printable(key)

  return typed === undefined ? stay(state) : edit(top.text + typed)
}

// `c` and `d` act on the Vaults only while the sidebar has the focus: on the Item list's sidebar, or with no Vault.
const sidebarFocused = (view: View): boolean =>
  View.$is("NoVaults")(view) || (View.$is("ItemList")(view) && View.Focus.$is("Sidebar")(view.focus))

// `c` asks for a new Vault's name; `d` asks to delete the Vault under the sidebar cursor. Undefined for any other key.
const vaultKey = (state: Open, key: Key): Step | undefined => {
  if (Key.is(key, "c"))
    return stay({ ...state, modals: [...state.modals, View.Modal.VaultName({ text: "", phase: "editing" })] })
  const vault = state.vaults[state.cursor]

  if (!Key.is(key, "d") || vault === undefined) return undefined

  return stay({
    ...state,
    modals: [
      ...state.modals,
      View.Modal.Confirm({
        description: `Delete Vault ${vault.vault}? An empty Vault is removed for good; one that still has Items or unrevoked Tokens granted to it is refused.`,
        effect: UiEffect.DeleteVault({ passphrase: state.passphrase, vault: vault.vault }),
      }),
    ],
  })
}

// A Vault request was refused: the name prompt, if it sent the request, takes keys again under the notice.
const vaultRefused = (state: Open, problem: Problem): Step => {
  const modals = state.modals.map((modal) =>
    View.Modal.$is("VaultName")(modal) ? View.Modal.VaultName({ ...modal, phase: "editing" }) : modal,
  )

  return stay(withNotice({ ...state, modals }, problem))
}

// A Vault was created or deleted: the prompt is done, and the sidebar is listed anew.
const vaultChanged = (state: Open): Step => ({
  state: { ...state, modals: state.modals.filter((modal) => !View.Modal.$is("VaultName")(modal)) },
  effects: [UiEffect.RefreshVaults({ passphrase: state.passphrase })],
})

// The Vault the main pane lists, if it lists one.
const viewedVault = (view: View): string | undefined =>
  View.$is("ItemList")(view) ? view.vault : View.$is("ItemDetail")(view) ? view.list.vault : undefined

// The sidebar with its Vaults replaced. The cursor stays on its Vault, or on its section; when its Vault is gone it
// moves to the Vault now at its row. The main pane stays unless its Vault is gone (or there was none and now is
// one), which selects the Vault under the cursor.
const vaultsListed = (state: Open, vaults: ReadonlyArray<Vault>): Step => {
  const was = state.vaults[state.cursor]?.vault
  const found = was === undefined ? -1 : vaults.findIndex(({ vault }) => vault === was)

  const cursor =
    was === undefined
      ? vaults.length + (state.cursor - state.vaults.length)
      : found >= 0
        ? found
        : Math.min(state.cursor, Math.max(0, vaults.length - 1))

  const next = { ...state, vaults, cursor }
  const viewed = viewedVault(state.view)
  const stale = viewed === undefined ? View.$is("NoVaults")(state.view) : !vaults.some(({ vault }) => vault === viewed)

  if (!stale) return stay(next)

  return vaults.length === 0
    ? stay({ ...next, view: View.NoVaults() })
    : select(next, Math.min(cursor, vaults.length - 1))
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
    Rename: (rename) => renameKey(state, rename, key),
    Renamed: () => (Key.is(key, "escape") || Key.is(key, "return") ? stay(dismissed(state)) : stay(state)),
    VaultName: (prompt) => vaultNameKey(state, prompt, key),
  })

type RenameModal = Extract<Modal, { readonly _tag: "Rename" }>

// Keys in the rename prompt: text edits the new title, Enter sends its one `items/rename` (nothing for an empty
// title), Escape cancels. While the request is out, nothing but Ctrl-C does anything.
const renameKey = (state: Open, top: RenameModal, key: Key): Step => {
  if (top.phase === "sending") return stay(state)

  if (Key.is(key, "escape")) return stay(dismissed(state))

  if (Key.is(key, "return") && top.text !== "")
    return {
      state: withTop(state, { ...top, phase: "sending" }),
      effects: [
        UiEffect.RenameItem({ passphrase: state.passphrase, vault: top.vault, item: top.item, newTitle: top.text }),
      ],
    }

  if (Key.is(key, "backspace")) return stay(withTop(state, { ...top, text: [...top.text].slice(0, -1).join("") }))
  const typed = Key.printable(key)

  return typed === undefined ? stay(state) : stay(withTop(state, { ...top, text: top.text + typed }))
}

// A Confirm modal over the state, held until `y` runs `effect`.
const confirming = (state: Open, description: string, effect: UiEffect): Step =>
  stay({ ...state, modals: [...state.modals, View.Modal.Confirm({ description, effect })] })

// `n` prompts for a new title for `item` of `vault`, `d` asks to delete it; undefined for every other key.
const itemKey = (state: Open, vault: string, item: string, key: Key): Step | undefined => {
  if (Key.is(key, "n"))
    return stay({
      ...state,
      modals: [...state.modals, View.Modal.Rename({ vault, item, text: "", phase: "editing" })],
    })

  if (!Key.is(key, "d")) return undefined

  return confirming(
    state,
    `Delete Item "${item}" from Vault ${vault}? Its values are destroyed and its title is retired; this cannot be undone.`,
    UiEffect.DeleteItem({ passphrase: state.passphrase, vault, item }),
  )
}

// `x` on a Retired title asks to release it; on an Item row it does nothing.
const releaseKey = (state: Open, view: ItemList): Step => {
  const title = View.selectedRetired(view)

  return title === undefined
    ? stay(state)
    : confirming(
        state,
        `Release the Retired title "${title}" in Vault ${view.vault}? Tokens can then create an Item with that title again.`,
        UiEffect.ReleaseTitle({ passphrase: state.passphrase, vault: view.vault, title }),
      )
}

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

// Keys on the Token rows: Up and Down move the row cursor, `d` asks to revoke the Token under it, and Escape or
// Tab (or Left) hand the focus back to the sidebar.
const tableKey = (state: Open, view: TokensView, row: number, key: Key): Step => {
  const withRow = (next: number) =>
    stay({ ...state, view: { ...view, focus: View.Focus.Rows({ row: Math.max(0, next) }) } })

  if (Key.is(key, "escape") || Key.is(key, "tab") || Key.is(key, "left") || Key.is(key, "h"))
    return stay({ ...state, view: { ...view, focus: View.Focus.Sidebar() } })
  const last = View.TokenTable.$is("Loaded")(view.table) ? view.table.tokens.length - 1 : 0

  if (Key.is(key, "up") || Key.is(key, "k")) return withRow(Math.min(row, last) - 1)

  if (Key.is(key, "down") || Key.is(key, "j")) return withRow(Math.min(last, row + 1))
  const token = View.selectedToken(view)

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

  return stay(state)
}

const openKey = (state: Open, key: Key): Step => {
  const { view } = state

  if (isQuitChord(key)) return quit()

  if (isSuspendChord(key)) return suspend()
  const top = state.modals.at(-1)

  if (top !== undefined) return modalKey(state, top, key)
  const audit = View.$is("Audit")(view) ? Audit.key(view, key) : undefined

  if (audit !== undefined) return auditStep(state, audit)

  if (View.$is("ItemList")(view) && View.Filter.$is("Editing")(view.filter))
    return filterKey(state, view, view.filter.text, key)

  if (View.$is("ItemDetail")(view)) return detailKey(state, view, key)

  if (Key.is(key, "q")) return quit()
  const onVaults = sidebarFocused(view) ? vaultKey(state, key) : undefined

  if (onVaults !== undefined) return onVaults

  if (View.$is("ItemList")(view) && View.Focus.$is("Rows")(view.focus)) {
    const onRows = rowsKey(state, view, view.focus.row, key)

    if (onRows !== undefined) return onRows
  }

  if (View.$is("ItemList")(view) && (Key.is(key, "tab") || Key.is(key, "right") || Key.is(key, "l")))
    return toRows(state, view)

  if (View.$is("Tokens")(view) && Key.is(key, "i")) return openIssueForm(state, view)

  if (View.$is("Tokens")(view) && View.Focus.$is("Rows")(view.focus)) return tableKey(state, view, view.focus.row, key)

  if (View.$is("Tokens")(view) && (Key.is(key, "tab") || Key.is(key, "right") || Key.is(key, "l")))
    return stay({ ...state, view: { ...view, focus: View.Focus.Rows({ row: 0 }) } })

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

  const last = View.rowCount(view) - 1

  if (Key.is(key, "up") || Key.is(key, "k")) return withRow(Math.min(row, last) - 1)

  if (Key.is(key, "down") || Key.is(key, "j")) return withRow(Math.min(last, row + 1))

  if (Key.is(key, "tab") || Key.is(key, "left") || Key.is(key, "h"))
    return stay({ ...state, view: { ...view, focus: View.Focus.Sidebar() } })
  const item = View.selectedItem(view)
  const onItem = item === undefined ? undefined : itemKey(state, view.vault, item.title, key)

  if (onItem !== undefined) return onItem

  if (Key.is(key, "x")) return releaseKey(state, view)

  if (!Key.is(key, "return")) return undefined

  return item === undefined ? stay(state) : stay({ ...state, view: View.detail(view, item) })
}

// Tab (or Right) from the sidebar moves to the rows once some are shown.
const toRows = (state: Open, view: ItemList): Step =>
  View.rowCount(view) === 0 ? stay(state) : stay({ ...state, view: { ...view, focus: View.Focus.Rows({ row: 0 }) } })

type ItemDetail = Extract<View, { readonly _tag: "ItemDetail" }>

// Keys in the Item detail. While a value is drawn, any key only hides it; otherwise Up/Down move the Field cursor,
// `r` Reveals the Field under it (one request), Escape returns to the Item list and `q` quits.
const detailKey = (state: Open, view: ItemDetail, key: Key): Step => {
  const withDetail = (next: ItemDetail) => stay({ ...state, view: next })

  if (View.Reveal.$is("Shown")(view.reveal)) return withDetail({ ...view, reveal: View.Reveal.Hidden() })

  if (Key.is(key, "escape")) return stay({ ...state, view: View.ItemList(view.list) })

  if (Key.is(key, "q")) return quit()

  if (View.Reveal.$is("Asking")(view.reveal)) return stay(state)
  const onItem = itemKey(state, view.list.vault, view.item.title, key)

  if (onItem !== undefined) return onItem

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

// A paste into the filter being typed or a text row of the issue form; ignored anywhere else.
const openPaste = (state: Open, text: string): Step => {
  const { view } = state
  const top = state.modals.at(-1)

  if (top !== undefined && View.Modal.$is("IssueForm")(top) && top.phase === "editing")
    return stay(withTop(state, { ...top, form: IssueForm.paste(top.form, firstLine(text)) }))

  if (top !== undefined && View.Modal.$is("Rename")(top) && top.phase === "editing")
    return stay(withTop(state, { ...top, text: top.text + firstLine(text) }))

  if (top !== undefined && View.Modal.$is("VaultName")(top) && top.phase === "editing")
    return stay(withTop(state, { ...top, text: top.text + firstLine(text) }))

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

// `update` applied to the Tokens view while its table is being fetched; an answer after the Owner moved on is dropped.
const tokensAnswer = (state: Open, update: (view: TokensView) => Open): Step => {
  const { view } = state

  return View.$is("Tokens")(view) && View.TokenTable.$is("Loading")(view.table) ? stay(update(view)) : stay(state)
}

// The Item list of `vault` asked for again after a change to it, from the list or from one of its Items' detail;
// any other view is left as it is.
const refreshed = (state: Open, vault: string): Step => {
  const { view } = state
  const list = View.$is("ItemList")(view) ? view : View.$is("ItemDetail")(view) ? view.list : undefined

  if (list === undefined || list.vault !== vault) return stay(state)

  return {
    state: { ...state, view: View.reloading(list) },
    effects: [UiEffect.ListItems({ passphrase: state.passphrase, vault })],
  }
}

// The rename's References in place of the prompt that asked for it, and the list refreshed under the new title.
const renamed = (state: Open, receipt: ItemRenamed): Step =>
  refreshed(
    {
      ...state,
      modals: [...state.modals.filter((modal) => !View.Modal.$is("Rename")(modal)), View.Modal.Renamed({ receipt })],
    },
    receipt.vault,
  )

// A refused rename, delete or release: a rename prompt takes keys again, under the notice saying why.
const changeRefused = (state: Open, problem: Problem): Step => {
  const modals = state.modals.map((modal) =>
    View.Modal.$is("Rename")(modal) ? View.Modal.Rename({ ...modal, phase: "editing" }) : modal,
  )

  return stay(withNotice({ ...state, modals }, problem))
}

const fromOpen = (state: Open, event: Event): Step =>
  Event.$match(event, {
    Key: ({ key }) => openKey(active(state), key),
    Paste: ({ text }) => openPaste(active(state), text),
    ItemsLoaded: ({ list }) =>
      answerFor(state, list.vault, (view) => ({
        ...state,
        view: { ...view, items: View.Items.Loaded({ items: list.items, retired: list.retired }) },
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
    TokensLoaded: ({ list }) =>
      tokensAnswer(state, (view) => ({ ...state, view: { ...view, table: View.TokenTable.Loaded(list) } })),
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
    VaultChanged: () => vaultChanged(state),
    VaultRefused: ({ problem }) => vaultRefused(state, problem),
    VaultsListed: ({ vaults }) => vaultsListed(state, vaults),
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
    Renamed: ({ receipt }) => renamed(state, receipt),
    ItemsChanged: ({ vault }) => refreshed(state, vault),
    ChangeRefused: ({ problem }) => changeRefused(state, problem),
  })

export const reduce = (state: State, event: Event): Step =>
  State.$match(state, {
    Locked: (locked) => fromLocked(locked, event),
    Open: (open) => fromOpen(open, event),
  })

export * as Reducer from "./Reducer.js"
