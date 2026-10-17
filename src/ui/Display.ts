import { Data, Redacted } from "effect"

import { Audit } from "./Audit.js"
import { IssueForm } from "./IssueForm.js"
import { Problem } from "./Problem.js"
import { type Section, Sidebar } from "./Sidebar.js"
import { type Open, type Phase, State } from "./State.js"
import { type Modal, View } from "./View.js"

// What the screen shows for a state, as plain text: the model the sync layer (`Screen`) copies into renderables.
// It is pure and holds no secret but a Revealed value or a freshly issued Token, while the state holds one (ADR-0009:
// drawn on the alternate screen only): concealed input appears only as its mask, so a test can scan it.

export interface VaultRow {
  readonly name: string
  readonly items: number
  readonly underCursor: boolean
}

export interface SectionRow {
  readonly name: Section
  readonly underCursor: boolean
}

export interface ItemRow {
  readonly title: string
  readonly kind: string
  readonly underCursor: boolean
}

// One Retired title of the Item list: its key (NFC, lowercased), the only form the Server keeps.
export interface RetiredRow {
  readonly key: string
  readonly underCursor: boolean
}

// One row of the Token table; times are UTC dates.
export interface TokenRow {
  readonly label: string
  readonly grants: string
  readonly state: string
  readonly created: string
  readonly expires: string
  readonly underCursor: boolean
}

export type Display = Data.TaggedEnum<{
  Locked: { readonly prompt: string; readonly mask: string; readonly notice: string; readonly hints: string }
  Open: {
    readonly vaults: ReadonlyArray<VaultRow>
    // The sidebar rows below the Vaults.
    readonly sections: ReadonlyArray<SectionRow>
    // The Token table's rows in the Tokens view, else undefined.
    readonly tokens: ReadonlyArray<TokenRow> | undefined
    // The main pane's title: the Vault whose Items it lists, or empty.
    readonly title: string
    // The filter line: empty when no filter is applied or typed.
    readonly filter: string
    readonly rows: ReadonlyArray<ItemRow>
    // The Item list's Retired titles, drawn in their own section below the rows; empty in every other view.
    readonly retired: ReadonlyArray<RetiredRow>
    // Shown in place of rows: loading, refused or empty.
    readonly message: string
    // The Item detail, one line per entry; empty outside it.
    readonly detail: ReadonlyArray<string>
    // The Audit view's header and rows, each one line; empty in every other view.
    readonly log: ReadonlyArray<string>
    // The topmost modal's text, or undefined when there is none.
    readonly modal: string | undefined
    // The topmost modal's box title, or empty when there is none.
    readonly modalTitle: string
    readonly hints: string
  }
}>

const { Locked, Open: OpenDisplay, $match } = Data.taggedEnum<Display>()

// The CLI's own prompt text, so the Owner meets the same words in both.
const prompt = "hush Passphrase: "

const lockedHints = "Enter unlock  Ctrl-C quit"
const listHints = "Up/Down move  Enter open  Tab Items  c create Vault  d delete Vault  / filter  q quit"
const rowsHints = "Up/Down move  Enter open  n rename  d delete  Tab Vaults  / filter  q quit"
const retiredHints = "Up/Down move  x release  Tab Vaults  / filter  q quit"
const detailHints = "Up/Down move  r reveal  n rename  d delete  Esc back  q quit"
const renameHints = "Type the new title  Enter rename  Esc cancel"
const shownHints = "Any key hides the value"
const filterHints = "Type to filter titles  Enter apply  Esc clear"
const modalHints = "Enter or Esc dismiss  Ctrl-C quit"
const auditHints = "Up/Down move  Enter open  / filter  PgUp/PgDn scroll  Esc clear filters  q quit"
const auditFilterHints = "Type a filter  Tab next field  Enter apply  Esc cancel"
const confirmHints = "y confirm  any other key cancels"
const tableHints = "Up/Down move  i issue  d revoke  Tab or Esc sidebar  q quit"
const tokensSidebarHints = "Up/Down move  Enter open  Tab Tokens  i issue  q quit"
const issueFormHints = "Up/Down move  Space change  Enter issue  Esc cancel"
const vaultNameHints = "Type a name  Enter create  Esc cancel"

const lockedNotice = (phase: Phase): string =>
  State.Phase.$match(phase, {
    Ready: () => "",
    Empty: () => "Type the Passphrase, then press Enter.",
    Checking: () => "Checking the Passphrase...",
    Refused: ({ problem }) => Problem.message(problem),
  })

const noVaults = "This Server has no Vault yet. Press c to create one."

// A concealed Field as the detail shows it while hidden: a fixed mask, so its length is not shown either.
const concealedMask = "********"

// A plain Field's value is not in the Item list's answer; Reveal shows it as it shows the concealed one.
const plainHidden = "(r shows it)"

type ItemDetail = Extract<View, { readonly _tag: "ItemDetail" }>

// The Item detail: Kind and times, then each Field in Kind order with its value or mask and its Reference.
const detailLines = ({ list, item, field, reveal }: ItemDetail): ReadonlyArray<string> => {
  const width = Math.max(...item.fields.map(({ label }) => label.length))

  const fields = item.fields.flatMap(({ label, concealed }, index) => {
    const reference = View.reference(list.vault, item, label)

    const value = View.Reveal.$match(reveal, {
      Hidden: () => undefined,
      Asking: (asking) => (asking.reference === reference ? "Revealing..." : undefined),
      Shown: (shown) => (shown.reference === reference ? Redacted.value(shown.value) : undefined),
    })

    const drawn = value ?? (concealed ? concealedMask : plainHidden)

    return [`${index === field ? ">" : " "} ${label.padEnd(width)}  ${drawn}`, `    ${reference}`]
  })

  return [`Kind     ${item.kind}`, `Created  ${item.createdAt}`, `Updated  ${item.updatedAt}`, "", ...fields]
}

const pane = (
  view: View,
): Pick<Extract<Display, { _tag: "Open" }>, "title" | "filter" | "rows" | "message" | "detail"> =>
  View.$match(view, {
    NoVaults: () => ({ title: "", filter: "", rows: [], message: noVaults, detail: [] }),
    ItemList: (list) => {
      const { vault, filter, items } = list

      const filterLine = View.Filter.$match(filter, {
        Applied: ({ text }) => (text === "" ? "" : `Filter: ${text}`),
        Editing: ({ text }) => `/${text}_`,
      })

      return View.Items.$match(items, {
        Loading: () => ({ title: vault, filter: filterLine, rows: [], message: "Loading...", detail: [] }),
        Refused: () => ({
          title: vault,
          filter: filterLine,
          rows: [],
          message: "Could not list this Vault's Items.",
          detail: [],
        }),
        Loaded: ({ items: all }) => {
          const cursor = View.cursorRow(list)

          const rows = View.visible(all, filter).map(({ title, kind }, index) => ({
            title,
            kind,
            underCursor: index === cursor,
          }))

          const message =
            rows.length > 0 ? "" : all.length === 0 ? "No Items in this Vault." : "No Items match the filter."

          return { title: vault, filter: filterLine, rows, message, detail: [] }
        },
      })
    },
    ItemDetail: (detail) => ({
      title: `${detail.list.vault} / ${detail.item.title}`,
      filter: "",
      rows: [],
      message: "",
      detail: detailLines(detail),
    }),
    Audit: (audit) => ({
      title: "Audit Log",
      filter: Audit.filterLine(audit),
      rows: [],
      message: Audit.status(audit),
      detail: [],
    }),
    Tokens: ({ table }) => ({
      title: "Tokens",
      filter: "",
      rows: [],
      message: View.TokenTable.$match(table, {
        Loading: () => "Loading...",
        Refused: () => "Could not list the Tokens.",
        Loaded: ({ tokens }) => (tokens.length === 0 ? "No Tokens yet. Press i to issue one." : ""),
      }),
      detail: [],
    }),
  })

const date = (time: string) => time.slice(0, "YYYY-MM-DD".length)

const tokenRows = (view: View): ReadonlyArray<TokenRow> | undefined => {
  if (!View.$is("Tokens")(view)) return undefined
  const { table } = view
  const selected = View.selectedToken(view)

  if (!View.TokenTable.$is("Loaded")(table)) return []

  return table.tokens.map((token) => ({
    label: token.label,
    grants: token.grants.map(({ vault, access }) => `${vault} (${access})`).join(", "),
    state: token.state,
    created: date(token.createdAt),
    expires: token.expiresAt === null ? "never" : date(token.expiresAt),
    underCursor: token === selected,
  }))
}

// The topmost modal's box title, text and key hints.
const modalShown = (top: Modal) =>
  View.Modal.$match(top, {
    Notice: ({ problem }) => ({ title: "Notice", text: Problem.message(problem), hints: modalHints }),
    Confirm: ({ description }) => ({ title: "Confirm", text: description, hints: confirmHints }),
    IssueForm: ({ form, phase }) => ({
      title: "Issue a Token",
      text: phase === "sending" ? `${IssueForm.lines(form)}\n\nIssuing the Token...` : IssueForm.lines(form),
      hints: phase === "sending" ? "Issuing the Token...  Ctrl-C quit" : issueFormHints,
    }),
    Issued: ({ label, token, replaced, copy }) => ({
      title: "Token issued",
      text: [
        `Token ${label}${replaced ? " (the Token it replaces was revoked)" : ""}:`,
        "",
        Redacted.value(token),
        "",
        "Shown once: hand it to the agent now. It is saved nowhere, and dismissing this wipes it from the UI.",
        ...(copy === "copied" ? ["Copied to the clipboard."] : []),
      ].join("\n"),
      hints: copy === "absent" ? "Enter or Esc dismiss" : "c copy  Enter or Esc dismiss",
    }),
    Rename: ({ vault, item, text, phase }) => ({
      title: "Rename",
      text: [
        `Rename Item "${item}" in Vault ${vault}. Its old title is then retired.`,
        "",
        `New title: ${text}${phase === "editing" ? "_" : ""}`,
        ...(phase === "sending" ? ["", "Renaming..."] : []),
      ].join("\n"),
      hints: phase === "sending" ? "Renaming...  Ctrl-C quit" : renameHints,
    }),
    Renamed: ({ receipt }) => ({
      title: "Renamed",
      text: [
        `Renamed "${receipt.from}" to "${receipt.to}" in Vault ${receipt.vault}. Update every template that used the old References:`,
        "",
        ...receipt.references.flatMap((reference) => [`  ${reference.old}`, `  -> ${reference.new}`]),
      ].join("\n"),
      hints: "Enter or Esc dismiss",
    }),
    VaultName: ({ text, phase }) => ({
      title: "Create a Vault",
      text: phase === "sending" ? `Name: ${text}\n\nCreating the Vault...` : `Name: ${text}_`,
      hints: phase === "sending" ? "Creating the Vault...  Ctrl-C quit" : vaultNameHints,
    }),
  })

const retiredRows = (view: View): ReadonlyArray<RetiredRow> => {
  if (!View.$is("ItemList")(view)) return []
  const cursor = View.cursorRow(view)
  const items = View.shown(view).length

  return View.retired(view).map((key, index) => ({ key, underCursor: items + index === cursor }))
}

const hintsFor = (state: Open) => {
  const top = state.modals.at(-1)

  if (top !== undefined) return modalShown(top).hints
  const { view } = state

  if (View.$is("Tokens")(view)) return View.Focus.$is("Rows")(view.focus) ? tableHints : tokensSidebarHints

  if (View.$is("ItemDetail")(view)) return View.Reveal.$is("Shown")(view.reveal) ? shownHints : detailHints

  if (View.$is("Audit")(view)) return Audit.editing(view) ? auditFilterHints : auditHints

  if (View.$is("ItemList")(view) && View.Filter.$is("Editing")(view.filter)) return filterHints

  if (View.$is("ItemList")(view) && View.selectedRetired(view) !== undefined) return retiredHints

  return View.$is("ItemList")(view) && View.Focus.$is("Rows")(view.focus) ? rowsHints : listHints
}

const open = (state: Open): Display => {
  const top = state.modals.at(-1)

  return OpenDisplay({
    vaults: state.vaults.map(({ vault, items }, index) => ({
      name: vault,
      items,
      underCursor: index === state.cursor,
    })),
    sections: Sidebar.sections.map((name, index) => ({
      name,
      underCursor: state.vaults.length + index === state.cursor,
    })),
    tokens: tokenRows(state.view),
    ...pane(state.view),
    retired: retiredRows(state.view),
    log: View.$is("Audit")(state.view) ? Audit.lines(state.view) : [],
    modal: top === undefined ? undefined : modalShown(top).text,
    modalTitle: top === undefined ? "" : modalShown(top).title,
    hints: hintsFor(state),
  })
}

const of = (state: State): Display =>
  State.$match(state, {
    Locked: ({ entered, phase }) =>
      Locked({ prompt, mask: "*".repeat(entered.length), notice: lockedNotice(phase), hints: lockedHints }),
    Open: open,
  })

export const Display = { of, $match } as const
