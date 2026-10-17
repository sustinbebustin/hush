import { Redacted } from "effect"

import type { ItemEditReceipt, ItemMeta, ItemRenamed } from "../shared/Api.js"
import { Audit, type Move } from "./Audit.js"
import { Clipboard, type Pasted } from "./Clipboard.js"
import { Concealed } from "./Concealed.js"
import { Event } from "./Event.js"
import { IssueForm } from "./IssueForm.js"
import { ItemForm } from "./ItemForm.js"
import { Key } from "./Key.js"
import { Problem } from "./Problem.js"
import { Sidebar } from "./Sidebar.js"
import { Size } from "./Size.js"
import { State, type Locked, type Open, type Vault } from "./State.js"
import { Step } from "./Step.js"
import { Tokens } from "./Tokens.js"
import { UiEffect } from "./UiEffect.js"
import { Vaults } from "./Vaults.js"
import { type Filter, type ItemListOf, type Modal, View } from "./View.js"

type ItemList = Extract<View, { readonly _tag: "ItemList" }>

type AuditView = Extract<View, { readonly _tag: "Audit" }>

// The pure reducer: one event and the current state in, the next state and the effects to run out. It never
// imports the renderer or the Client; `Ui` runs the effects and draws the state. It dispatches each event and key,
// and owns the Locked prompt and the Open core (sidebar cursor, Item list and detail, Item form, modals, idle,
// suspend and quit). The Tokens view, the Vault sidebar's create and delete, and the Audit view have their
// transitions in `Tokens`, `Vaults` and `Audit`.

export type { Step } from "./Step.js"

const { stay, dismissed, withTop, withNotice, confirming } = Step

// Quitting drops everything Open held before the renderer goes.
const quit = (): Step => ({ state: State.locked(), effects: [UiEffect.Quit()] })

const isQuitChord = (key: Key) => Key.is(key, "c", { ctrl: true })

const isSuspendChord = (key: Key) => Key.is(key, "z", { ctrl: true })

// Ctrl-Z or SIGTSTP: Lock first, so nothing Open held survives the suspension, then suspend. `attempt` carries a
// Locked prompt's count over, so a wait tick or an answer of an earlier attempt stays stale.
const suspend = (size: Size, attempt?: number): Step => ({
  state: State.locked(attempt, size),
  effects: [UiEffect.Suspend()],
})

// Locks once the idle limit has passed since the first tick after the last keypress.
const idleTick = (state: Open, now: number): Step =>
  State.Idle.$match(state.idle, {
    Active: () => stay({ ...state, idle: State.Idle.Since({ since: now }) }),
    Since: ({ since }) => (now - since >= State.idleLimitMillis ? stay(State.locked(0, state.size)) : stay(state)),
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
  const section = Sidebar.section(state.vaults.length, cursor)

  if (section === "Tokens") return Tokens.list({ ...state, cursor })

  if (section === "Audit") return auditStep({ ...state, cursor }, Audit.start())

  if (selected === undefined) return stay({ ...state, view: View.NoVaults() })

  return {
    state: { ...state, cursor, view: View.loading(selected.vault) },
    effects: [UiEffect.ListItems({ passphrase: state.passphrase, vault: selected.vault })],
  }
}

// Open on the first Vault, if any.
const openOn = (
  size: Size,
  passphrase: Redacted.Redacted<string>,
  vaults: ReadonlyArray<Vault>,
  clipboard: boolean,
): Step => {
  const open = State.Open({
    size,
    passphrase,
    vaults,
    cursor: 0,
    view: View.NoVaults(),
    modals: [],
    idle: State.Idle.Active(),
    clipboard,
  })

  return vaults.length === 0 ? stay(open) : select(open, 0)
}

const lockedKey = (state: Locked, key: Key): Step => {
  if (isQuitChord(key)) return quit()

  if (isSuspendChord(key)) return suspend(state.size, state.attempt)

  if (State.Phase.$is("Checking")(state.phase)) return stay(state)

  if (Key.is(key, "return")) {
    if (state.entered.length === 0) return stay({ ...state, phase: State.Phase.Empty() })
    const attempt = state.attempt + 1

    return {
      state: State.Locked({ entered: Concealed.empty, phase: State.Phase.Checking(), attempt, size: state.size }),
      effects: [UiEffect.ListVaults({ passphrase: Redacted.make(Redacted.value(state.entered.value)), attempt })],
    }
  }

  if (Key.is(key, "backspace")) return stay({ ...state, entered: Concealed.backspace(state.entered) })
  const text = Key.printable(key)

  return text === undefined ? stay(state) : stay({ ...state, entered: Concealed.append(state.entered, text) })
}

const fromLocked = (state: Locked, event: Event): Step => {
  const checking = State.Phase.$is("Checking")(state.phase)
  // Whether the check of `attempt` is the one the prompt waits for.
  const awaits = (attempt: number) => checking && attempt === state.attempt
  // An answer asked for by an Open UI that Locked meanwhile: dropped, values, Tokens and all. An issued Token so
  // dropped is never seen and stays valid until revoked; a write so dropped stands, and the next Open lists it.
  const drop = () => stay(state)

  return Event.$match(event, {
    Key: ({ key }) => lockedKey(state, key),
    Paste: ({ text }) =>
      checking ? stay(state) : stay({ ...state, entered: Concealed.append(state.entered, firstLine(text)) }),
    // An unlock answered after a quit, or for an attempt made before a Lock or before a newer one, is dropped,
    // Passphrase and all.
    Unlocked: ({ attempt, passphrase, vaults, clipboard }) =>
      awaits(attempt) ? openOn(state.size, passphrase, vaults, clipboard) : stay(state),
    UnlockRefused: ({ attempt, problem }) => (awaits(attempt) ? refusedWith(state, problem) : stay(state)),
    Resize: ({ width, height }) => stay({ ...state, size: { width, height } }),
    WaitTick: ({ attempt }) =>
      attempt === state.attempt && State.Phase.$is("Refused")(state.phase)
        ? refusedWith(state, Problem.tick(state.phase.problem))
        : stay(state),
    // Nothing to time out: Locked holds no Passphrase.
    IdleTick: drop,
    // The typed input goes too, and a check in flight is dropped when it answers.
    Suspend: () => suspend(state.size, state.attempt),
    Closed: quit,
    ItemsLoaded: drop,
    ItemsRefused: drop,
    AuditListed: drop,
    AuditRefused: drop,
    TokensLoaded: drop,
    TokensRefused: drop,
    TokenRevoked: drop,
    RevokeRefused: drop,
    TokenIssued: drop,
    IssueRefused: drop,
    TokenCopied: drop,
    VaultChanged: drop,
    VaultRefused: drop,
    VaultsListed: drop,
    Revealed: drop,
    RevealRefused: drop,
    RevealExpired: drop,
    ItemCreated: drop,
    ItemEdited: drop,
    ItemSaveRefused: drop,
    ClipboardRead: drop,
    Renamed: drop,
    ItemsChanged: drop,
    ChangeRefused: drop,
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

// The topmost modal takes every key: Escape or Enter dismisses a notice; `y` runs a confirmation's effect and any
// other key cancels it.
const modalKey = (state: Open, top: Modal, key: Key): Step =>
  View.Modal.$match(top, {
    Notice: () => (Key.is(key, "escape") || Key.is(key, "return") ? stay(dismissed(state)) : stay(state)),
    Confirm: ({ effect }) =>
      Key.is(key, "y") ? { state: dismissed(state), effects: [effect] } : stay(dismissed(state)),
    IssueForm: (form) => Tokens.issueFormKey(state, form, key),
    Issued: (issued) => Tokens.issuedKey(state, issued, key),
    Rename: (rename) => renameKey(state, rename, key),
    Renamed: () => (Key.is(key, "escape") || Key.is(key, "return") ? stay(dismissed(state)) : stay(state)),
    VaultName: (prompt) => Vaults.nameKey(state, prompt, key),
    Help: () => stay(dismissed(state)),
  })

// Whether `?` opens the help: not where it is typed (a prompt, a form, a filter being edited), not on a
// confirmation (where it cancels, as any key but `y` does), and not over a Revealed value (which any key hides).
const helpable = (state: Open): boolean => {
  const top = state.modals.at(-1)
  const { view } = state

  if (top !== undefined)
    return View.Modal.$is("Notice")(top) || View.Modal.$is("Issued")(top) || View.Modal.$is("Renamed")(top)

  if (View.$is("ItemList")(view)) return !View.Filter.$is("Editing")(view.filter)

  if (View.$is("ItemDetail")(view)) return !View.Reveal.$is("Shown")(view.reveal)

  if (View.$is("Audit")(view)) return !Audit.editing(view)

  return !View.$is("ItemForm")(view)
}

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

const openKey = (state: Open, key: Key): Step => {
  const { view } = state

  if (isQuitChord(key)) return quit()

  if (isSuspendChord(key)) return suspend(state.size)

  if (Key.printable(key) === "?" && helpable(state))
    return stay({ ...state, modals: [...state.modals, View.Modal.Help()] })
  const top = state.modals.at(-1)

  if (top !== undefined) return modalKey(state, top, key)
  const audit = View.$is("Audit")(view) ? Audit.key(view, key, Audit.rowsAt(state.size)) : undefined

  if (audit !== undefined) return auditStep(state, audit)

  if (View.$is("ItemList")(view) && View.Filter.$is("Editing")(view.filter))
    return filterKey(state, view, view.filter.text, key)

  if (View.$is("ItemDetail")(view)) return detailKey(state, view, key)

  if (View.$is("ItemForm")(view)) return formKey(state, view, key)

  if (Key.is(key, "q")) return quit()
  const onVaults = Vaults.key(state, key)

  if (onVaults !== undefined) return onVaults

  if (View.$is("ItemList")(view) && Key.is(key, "c"))
    return stay({ ...state, view: View.ItemForm({ list: view, form: ItemForm.create(view.vault), phase: "editing" }) })

  if (View.$is("ItemList")(view) && View.Focus.$is("Rows")(view.focus)) {
    const onRows = rowsKey(state, view, view.focus.row, key)

    if (onRows !== undefined) return onRows
  }

  if (View.$is("ItemList")(view) && (Key.is(key, "tab") || Key.is(key, "right") || Key.is(key, "l")))
    return toRows(state, view)

  const onTokens = View.$is("Tokens")(view) ? Tokens.key(state, view, key) : undefined

  if (onTokens !== undefined) return onTokens

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

// Tab (or Right) from the sidebar moves to the rows once the Vault's Items are answered, even none, so `c` can
// create a Vault's first Item.
const toRows = (state: Open, view: ItemList): Step =>
  View.rowCount(view) === 0 && !View.Items.$is("Loaded")(view.items)
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
  const onItem = itemKey(state, view.list.vault, view.item.title, key)

  if (onItem !== undefined) return onItem

  if (Key.is(key, "up") || Key.is(key, "k")) return withDetail({ ...view, field: Math.max(0, view.field - 1) })

  if (Key.is(key, "down") || Key.is(key, "j"))
    return withDetail({ ...view, field: Math.min(view.item.fields.length - 1, view.field + 1) })
  const field = View.selectedField(view)

  if (Key.is(key, "e"))
    return stay({
      ...state,
      view: View.ItemForm({
        list: view.list,
        form: ItemForm.edit(view.list.vault, view.item, field?.label),
        phase: "editing",
      }),
    })

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

  // Into the Item form: all of it into the concealed buffer, never drawn, or a first line into a text row.
  if (state.modals.length === 0 && View.$is("ItemForm")(view))
    return view.phase === "editing"
      ? stay({ ...state, view: { ...view, form: ItemForm.paste(view.form, text) } })
      : stay(state)

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

type ItemFormView = Extract<View, { readonly _tag: "ItemForm" }>

const noPaste = Problem.Failed({
  message:
    "This machine has no clipboard the UI can read (it needs macOS, Wayland or X11), so nothing was pasted. Type the value, or use your terminal's own paste.",
})

const pasteFailed = {
  Empty: Problem.Failed({
    message: "The clipboard holds no text, so nothing was pasted. Copy the value first, then press Ctrl-V again.",
  }),
  Unsupported: noPaste,
  Failed: Problem.Failed({
    message:
      "Could not read the clipboard (the read timed out, the text was too large, or the platform refused it); nothing was pasted. Press Ctrl-V to try again, or type the value.",
  }),
} as const

const isPasteChord = (key: Key) => Key.is(key, "v", { ctrl: true })

// The detail of `item`, its cursor on the Field labelled `label` (the first when the Item has no such Field).
const detailOn = (list: ItemListOf, item: ItemMeta, label: string): View =>
  View.ItemDetail({
    list,
    item,
    field: Math.max(
      0,
      item.fields.findIndex((field) => field.label === label),
    ),
    reveal: View.Reveal.Hidden(),
    reveals: 0,
  })

// Where Escape leaves the form: the Item list a create was opened from, or the detail of the Item an edit changes.
const leftForm = ({ list, form }: ItemFormView): View =>
  ItemForm.$match(form, {
    Create: () => View.ItemList(list),
    Edit: (editing) => detailOn(list, editing.item, ItemForm.focusedLabel(editing)),
  })

// Keys in the Item form: Escape leaves it, Enter sends its one write (the concealed buffer leaves the state with
// it), Ctrl-V reads the host clipboard into the concealed buffer, anything else edits it. While a write or a read
// is out, nothing but Ctrl-C and Ctrl-Z does anything.
const formKey = (state: Open, view: ItemFormView, key: Key): Step => {
  if (view.phase !== "editing") return stay(state)

  if (Key.is(key, "escape")) return stay({ ...state, view: leftForm(view) })

  if (isPasteChord(key)) {
    if (!ItemForm.hiddenFocused(view.form)) return stay(state)

    if (!state.clipboard) return stay(withNotice(state, noPaste))

    return { state: { ...state, view: { ...view, phase: "pasting" } }, effects: [UiEffect.ReadClipboard()] }
  }

  if (!Key.is(key, "return")) return stay({ ...state, view: { ...view, form: ItemForm.key(view.form, key) } })

  return {
    state: { ...state, view: { ...view, form: ItemForm.sent(view.form), phase: "sending" } },
    effects: [UiEffect.SaveItem({ passphrase: state.passphrase, save: ItemForm.submit(view.form) })],
  }
}

// `update` applied to the Item form while it waits in `phase`; an answer after the Owner left it is dropped.
const formAnswer = (state: Open, phase: ItemFormView["phase"], update: (view: ItemFormView) => Step): Step => {
  const { view } = state

  return View.$is("ItemForm")(view) && view.phase === phase ? update(view) : stay(state)
}

// A verified create: the Vault's Item list fetched again to show the new Item, and its count one higher.
const created = (state: Open, view: ItemFormView): Step => {
  const { vault } = view.list
  const vaults = state.vaults.map((row) => (row.vault === vault ? { ...row, items: row.items + 1 } : row))

  return {
    state: { ...state, vaults, view: View.loading(vault) },
    effects: [UiEffect.ListItems({ passphrase: state.passphrase, vault })],
  }
}

// A verified edit: the Item's detail as the receipt describes it, in the list too.
const edited = (state: Open, view: ItemFormView, receipt: ItemEditReceipt): Step => {
  const { form, list } = view

  if (!ItemForm.$is("Edit")(form)) return stay(state)
  const old = form.item

  const item: ItemMeta = {
    title: receipt.title,
    kind: receipt.kind,
    createdAt: old.createdAt,
    updatedAt: receipt.updatedAt,
    fields: receipt.fields,
  }

  const items = View.Items.$is("Loaded")(list.items)
    ? View.Items.Loaded({ ...list.items, items: list.items.items.map((each) => (each === old ? item : each)) })
    : list.items

  return stay({ ...state, view: detailOn({ ...list, items }, item, ItemForm.focusedLabel(form)) })
}

const pastedInto = (state: Open, view: ItemFormView, pasted: Pasted): Step => {
  const editing = { ...view, phase: "editing" as const }

  return Clipboard.Pasted.$match(pasted, {
    Text: ({ text }) =>
      stay({ ...state, view: { ...editing, form: ItemForm.appendHidden(view.form, Redacted.value(text)) } }),
    Empty: () => stay(withNotice({ ...state, view: editing }, pasteFailed.Empty)),
    Unsupported: () => stay(withNotice({ ...state, view: editing }, pasteFailed.Unsupported)),
    Failed: () => stay(withNotice({ ...state, view: editing }, pasteFailed.Failed)),
  })
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
    TokensLoaded: ({ list }) => Tokens.loaded(state, list),
    TokensRefused: ({ problem }) => Tokens.refused(state, problem),
    TokenRevoked: () => Tokens.revoked(state),
    RevokeRefused: ({ problem }) => stay(withNotice(state, problem)),
    TokenIssued: ({ receipt, copyable }) => Tokens.issued(state, receipt, copyable),
    IssueRefused: ({ problem }) => Tokens.issueRefused(state, problem),
    TokenCopied: ({ written }) => Tokens.copied(state, written),
    VaultChanged: () => Vaults.changed(state),
    VaultRefused: ({ problem }) => Vaults.refused(state, problem),
    VaultsListed: ({ vaults }) => Vaults.listed(state, vaults, select),
    // Locked-only events: none reaches an Open UI except late, and none changes it.
    Unlocked: () => stay(state),
    UnlockRefused: () => stay(state),
    WaitTick: () => stay(state),
    IdleTick: ({ now }) => idleTick(state, now),
    Resize: ({ width, height }) => stay({ ...state, size: { width, height } }),
    Suspend: () => suspend(state.size),
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
    ItemCreated: () => formAnswer(state, "sending", (view) => created(state, view)),
    ItemEdited: ({ receipt }) => formAnswer(state, "sending", (view) => edited(state, view, receipt)),
    ItemSaveRefused: ({ problem }) =>
      formAnswer(state, "sending", (view) =>
        stay(withNotice({ ...state, view: { ...view, phase: "editing" } }, problem)),
      ),
    ClipboardRead: ({ pasted }) => formAnswer(state, "pasting", (view) => pastedInto(state, view, pasted)),
    Renamed: ({ receipt }) => renamed(state, receipt),
    ItemsChanged: ({ vault }) => refreshed(state, vault),
    ChangeRefused: ({ problem }) => changeRefused(state, problem),
  })

// Input the Owner cannot see the effect of: a key or paste while the frame is below 80x24, which draws only its
// notice. Ctrl-C and Ctrl-Z still work.
const unseen = (state: State, event: Event): boolean =>
  !Size.fits(state.size) &&
  (Event.$is("Paste")(event) || (Event.$is("Key")(event) && !isQuitChord(event.key) && !isSuspendChord(event.key)))

export const reduce = (state: State, event: Event): Step =>
  unseen(state, event)
    ? stay(state)
    : State.$match(state, {
        Locked: (locked) => fromLocked(locked, event),
        Open: (open) => fromOpen(open, event),
      })

export * as Reducer from "./Reducer.js"
