import { Result } from "effect"

import type { TokenIssueReceipt, TokenList } from "../shared/Api.js"
import type { Written } from "./Clipboard.js"
import { IssueForm } from "./IssueForm.js"
import { Key } from "./Key.js"
import { Problem } from "./Problem.js"
import type { Open } from "./State.js"
import { Step } from "./Step.js"
import { UiEffect } from "./UiEffect.js"
import { type Modal, View } from "./View.js"

// The Tokens view's transitions: the table and its row cursor, revoking the Token under it, the issue form and the
// issued Token's modal with its copy key, and the answers to each request. Late answers are dropped.

const { stay, dismissed, withTop, withNotice, confirming } = Step

type TokensView = Extract<View, { readonly _tag: "Tokens" }>

type IssueFormModal = Extract<Modal, { readonly _tag: "IssueForm" }>

type IssuedModal = Extract<Modal, { readonly _tag: "Issued" }>

// The Tokens view, and its one `tokens/list`; a refresh keeps the table's row.
const list = (state: Open): Step => {
  const { view } = state
  const row = View.$is("Tokens")(view) && View.Focus.$is("Rows")(view.focus) ? view.focus.row : 0

  return {
    state: { ...state, view: View.tokensLoading(row) },
    effects: [UiEffect.ListTokens({ passphrase: state.passphrase })],
  }
}

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

  return View.$is("Tokens")(next.view) ? list(next) : stay(next)
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

const copying = (modal: Modal): modal is IssuedModal => View.Modal.$is("Issued")(modal) && modal.copy === "copying"

// A copy's answer, for the issued Token still held, wherever it sits in the stack (the help or a notice may be over
// it); after a dismissal it is dropped.
const copied = (state: Open, written: Written): Step => {
  if (!state.modals.some(copying)) return stay(state)
  const copy = written === "written" ? "copied" : "ready"
  const modals = state.modals.map((modal) => (copying(modal) ? View.Modal.Issued({ ...modal, copy }) : modal))

  return written === "written"
    ? stay({ ...state, modals })
    : stay(withNotice({ ...state, modals }, copyFailed[written]))
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
    return confirming(
      state,
      `Revoke Token ${token.label}? Every use of it is refused from then on; this cannot be undone.`,
      UiEffect.RevokeToken({ passphrase: state.passphrase, label: token.label }),
    )

  return stay(state)
}

// A key in the Tokens view with no modal over it: `i` opens the issue form, the rows take keys while focused, and
// Tab (or Right) from the sidebar focuses them. Undefined for a key it leaves to the sidebar and the rest of the UI.
const key = (state: Open, view: TokensView, pressed: Key): Step | undefined => {
  if (Key.is(pressed, "i")) return openIssueForm(state, view)

  if (View.Focus.$is("Rows")(view.focus)) return tableKey(state, view, view.focus.row, pressed)

  if (Key.is(pressed, "tab") || Key.is(pressed, "right") || Key.is(pressed, "l"))
    return stay({ ...state, view: { ...view, focus: View.Focus.Rows({ row: 0 }) } })

  return undefined
}

// `update` applied to the Tokens view while its table is being fetched; an answer after the Owner moved on is dropped.
const answer = (state: Open, update: (view: TokensView) => Open): Step => {
  const { view } = state

  return View.$is("Tokens")(view) && View.TokenTable.$is("Loading")(view.table) ? stay(update(view)) : stay(state)
}

const loaded = (state: Open, tokens: TokenList): Step =>
  answer(state, (view) => ({ ...state, view: { ...view, table: View.TokenTable.Loaded(tokens) } }))

const refused = (state: Open, problem: Problem): Step =>
  answer(state, (view) => ({
    ...state,
    view: { ...view, table: View.TokenTable.Refused() },
    modals: [...state.modals, View.Modal.Notice({ problem })],
  }))

// A revoke answered while the Tokens view is up refreshes its table.
const revoked = (state: Open): Step => (View.$is("Tokens")(state.view) ? list(state) : stay(state))

export const Tokens = {
  list,
  key,
  issueFormKey,
  issuedKey,
  issued,
  issueRefused,
  copied,
  loaded,
  refused,
  revoked,
} as const
