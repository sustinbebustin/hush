import { Data, Redacted } from "effect"

import { Audit } from "./Audit.js"
import { Problem } from "./Problem.js"
import { type Section, Sidebar } from "./Sidebar.js"
import { type Open, type Phase, State } from "./State.js"
import { View } from "./View.js"

// What the screen shows for a state, as plain text: the model the sync layer (`Screen`) copies into renderables.
// It is pure and holds no secret but a Revealed value, while the state holds one: concealed input appears only as
// its mask, so a test can scan it.

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

export type Display = Data.TaggedEnum<{
  Locked: { readonly prompt: string; readonly mask: string; readonly notice: string; readonly hints: string }
  Open: {
    readonly vaults: ReadonlyArray<VaultRow>
    // The sidebar rows below the Vaults.
    readonly sections: ReadonlyArray<SectionRow>
    // The main pane's title: the Vault whose Items it lists, or empty.
    readonly title: string
    // The filter line: empty when no filter is applied or typed.
    readonly filter: string
    readonly rows: ReadonlyArray<ItemRow>
    // Shown in place of rows: loading, refused or empty.
    readonly message: string
    // The Item detail, one line per entry; empty outside it.
    readonly detail: ReadonlyArray<string>
    // The Audit view's header and rows, each one line; empty in every other view.
    readonly log: ReadonlyArray<string>
    // The topmost modal's text, or undefined when there is none.
    readonly modal: string | undefined
    readonly hints: string
  }
}>

const { Locked, Open: OpenDisplay, $match } = Data.taggedEnum<Display>()

// The CLI's own prompt text, so the Owner meets the same words in both.
const prompt = "hush Passphrase: "

const lockedHints = "Enter unlock  Ctrl-C quit"
const listHints = "Up/Down move  Enter open Vault  Tab Items  / filter  Esc clear filter  q quit"
const rowsHints = "Up/Down move  Enter open Item  Tab Vaults  / filter  Esc clear filter  q quit"
const detailHints = "Up/Down move  r reveal  Esc back  q quit"
const shownHints = "Any key hides the value"
const filterHints = "Type to filter titles  Enter apply  Esc clear"
const modalHints = "Enter or Esc dismiss  Ctrl-C quit"
const auditHints = "Up/Down move  Enter open  / filter  PgUp/PgDn scroll  Esc clear filters  q quit"
const auditFilterHints = "Type a filter  Tab next field  Enter apply  Esc cancel"

const lockedNotice = (phase: Phase): string =>
  State.Phase.$match(phase, {
    Ready: () => "",
    Empty: () => "Type the Passphrase, then press Enter.",
    Checking: () => "Checking the Passphrase...",
    Refused: ({ problem }) => Problem.message(problem),
  })

const noVaults = "This Server has no Vault yet. Create one with `hush vault create <name>`."

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
  })

const hintsFor = (state: Open) => {
  if (state.modals.length > 0) return modalHints
  const { view } = state

  if (View.$is("ItemDetail")(view)) return View.Reveal.$is("Shown")(view.reveal) ? shownHints : detailHints

  if (View.$is("Audit")(view)) return Audit.editing(view) ? auditFilterHints : auditHints

  if (View.$is("ItemList")(view) && View.Filter.$is("Editing")(view.filter)) return filterHints

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
    ...pane(state.view),
    log: View.$is("Audit")(state.view) ? Audit.lines(state.view) : [],
    modal:
      top === undefined ? undefined : View.Modal.$match(top, { Notice: ({ problem }) => Problem.message(problem) }),
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
