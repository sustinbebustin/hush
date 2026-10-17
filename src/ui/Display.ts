import { Data } from "effect"

import { Problem } from "./Problem.js"
import { type Open, type Phase, State } from "./State.js"
import { type Modal, View } from "./View.js"

// What the screen shows for a state, as plain text: the model the sync layer (`Screen`) copies into renderables.
// It is pure and holds no secret: concealed input appears only as its mask, so a test can scan it.

export interface VaultRow {
  readonly name: string
  readonly items: number
  readonly underCursor: boolean
}

export interface ItemRow {
  readonly title: string
  readonly kind: string
}

// A sidebar row below the Vaults, such as Tokens.
export interface EntryRow {
  readonly name: string
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
    readonly entries: ReadonlyArray<EntryRow>
    // The Token table's rows in the Tokens view, else undefined.
    readonly tokens: ReadonlyArray<TokenRow> | undefined
    // The main pane's title: the Vault whose Items it lists, or empty.
    readonly title: string
    // The filter line: empty when no filter is applied or typed.
    readonly filter: string
    readonly rows: ReadonlyArray<ItemRow>
    // Shown in place of rows: loading, refused or empty.
    readonly message: string
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
const listHints = "Up/Down move  Enter open Vault  / filter  Esc clear filter  q quit"
const filterHints = "Type to filter titles  Enter apply  Esc clear"
const modalHints = "Enter or Esc dismiss  Ctrl-C quit"
const confirmHints = "y confirm  any other key cancels"
const tableHints = "Up/Down move  d revoke  Esc sidebar  q quit"
const tokensSidebarHints = "Up/Down move  Enter open  q quit"

const lockedNotice = (phase: Phase): string =>
  State.Phase.$match(phase, {
    Ready: () => "",
    Empty: () => "Type the Passphrase, then press Enter.",
    Checking: () => "Checking the Passphrase...",
    Refused: ({ problem }) => Problem.message(problem),
  })

const noVaults = "This Server has no Vault yet. Create one with `hush vault create <name>`."

const pane = (view: View): Pick<Extract<Display, { _tag: "Open" }>, "title" | "filter" | "rows" | "message"> =>
  View.$match(view, {
    NoVaults: () => ({ title: "", filter: "", rows: [], message: noVaults }),
    ItemList: ({ vault, filter, items }) => {
      const filterLine = View.Filter.$match(filter, {
        Applied: ({ text }) => (text === "" ? "" : `Filter: ${text}`),
        Editing: ({ text }) => `/${text}_`,
      })

      return View.Items.$match(items, {
        Loading: () => ({ title: vault, filter: filterLine, rows: [], message: "Loading..." }),
        Refused: () => ({ title: vault, filter: filterLine, rows: [], message: "Could not list this Vault's Items." }),
        Loaded: ({ items: all }) => {
          const rows = View.visible(all, filter).map(({ title, kind }) => ({ title, kind }))

          const message =
            rows.length > 0 ? "" : all.length === 0 ? "No Items in this Vault." : "No Items match the filter."

          return { title: vault, filter: filterLine, rows, message }
        },
      })
    },
    Tokens: ({ table }) => ({
      title: "Tokens",
      filter: "",
      rows: [],
      message: View.TokenTable.$match(table, {
        Loading: () => "Loading...",
        Refused: () => "Could not list the Tokens.",
        Loaded: ({ tokens }) => (tokens.length === 0 ? "No Tokens yet. Press i to issue one." : ""),
      }),
    }),
  })

const date = (time: string) => time.slice(0, "YYYY-MM-DD".length)

const tokenRows = (view: View): ReadonlyArray<TokenRow> | undefined => {
  if (!View.$is("Tokens")(view)) return undefined
  const { table, focus } = view

  if (!View.TokenTable.$is("Loaded")(table)) return []

  return table.tokens.map((token, index) => ({
    label: token.label,
    grants: token.grants.map(({ vault, access }) => `${vault} (${access})`).join(", "),
    state: token.state,
    created: date(token.createdAt),
    expires: token.expiresAt === null ? "never" : date(token.expiresAt),
    underCursor: focus === "table" && index === table.row,
  }))
}

// The topmost modal's box title, text and key hints.
const modalShown = (top: Modal) =>
  View.Modal.$match(top, {
    Notice: ({ problem }) => ({ title: "Notice", text: Problem.message(problem), hints: modalHints }),
    Confirm: ({ description }) => ({ title: "Confirm", text: description, hints: confirmHints }),
  })

const hintsFor = (state: Open) => {
  const top = state.modals.at(-1)

  if (top !== undefined) return modalShown(top).hints
  const { view } = state

  if (View.$is("Tokens")(view)) return view.focus === "table" ? tableHints : tokensSidebarHints

  return View.$is("ItemList")(view) && View.Filter.$is("Editing")(view.filter) ? filterHints : listHints
}

const open = (state: Open): Display => {
  const top = state.modals.at(-1)

  return OpenDisplay({
    vaults: state.vaults.map(({ vault, items }, index) => ({
      name: vault,
      items,
      underCursor: index === state.cursor,
    })),
    entries: State.entries.map((name, index) => ({ name, underCursor: state.vaults.length + index === state.cursor })),
    tokens: tokenRows(state.view),
    ...pane(state.view),
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
