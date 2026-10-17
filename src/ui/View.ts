import { Data, type Redacted } from "effect"

import type { ItemMeta, ItemRenamed, TokenInfo } from "../shared/Api.js"
import { Match } from "../shared/Match.js"
import { Reference } from "../shared/Reference.js"
import type * as AuditView from "./Audit.js"
import type { IssueForm } from "./IssueForm.js"
import type { Problem } from "./Problem.js"
import type { UiEffect } from "./UiEffect.js"

// What the main pane of an Open UI shows, and the modals stacked above it. Later views (forms) join `View`;
// later modals (help) join `Modal`.

// The Item list's filter over titles: being typed, or applied (an empty text shows every Item).
export type Filter = Data.TaggedEnum<{
  Applied: { readonly text: string }
  Editing: { readonly text: string }
}>

const Filter = Data.taggedEnum<Filter>()

// One Vault's Items: asked for, answered, or refused (the refusal itself is a modal). `retired` holds the Vault's
// Retired title keys (NFC, lowercased), as the list receipt sends them.
export type Items = Data.TaggedEnum<{
  Loading: {}
  Loaded: { readonly items: ReadonlyArray<ItemMeta>; readonly retired: ReadonlyArray<string> }
  Refused: {}
}>

const Items = Data.taggedEnum<Items>()

// Every Token, newest first: asked for, answered, or refused (the refusal itself is a modal).
export type TokenTable = Data.TaggedEnum<{
  Loading: {}
  Loaded: { readonly tokens: ReadonlyArray<TokenInfo> }
  Refused: {}
}>

const TokenTable = Data.taggedEnum<TokenTable>()

// The issued Token's copy key: absent (no host clipboard), ready, writing, or done.
export type Copy = "absent" | "ready" | "copying" | "copied"

// Where Up/Down and Enter act while the Item list shows: the Vault sidebar, or the Item rows with the row under the
// cursor (an index into the visible rows, then the Retired titles below them).
export type Focus = Data.TaggedEnum<{
  Sidebar: {}
  Rows: { readonly row: number }
}>

const Focus = Data.taggedEnum<Focus>()

// The Item list's own fields, kept by the Item detail so `Esc` returns to the list as it was.
export interface ItemListOf {
  readonly vault: string
  readonly filter: Filter
  readonly items: Items
  readonly focus: Focus
}

// One Reveal of one Field in the Item detail: none, asked for, or answered and drawn until hidden. `generation`
// numbers the detail's Reveals, so the hide tick of an earlier one is ignored; `reference` ties an answer to the
// Field it was asked for. The value is held only while `Shown`.
export type Reveal = Data.TaggedEnum<{
  Hidden: {}
  Asking: { readonly generation: number; readonly reference: string }
  Shown: { readonly generation: number; readonly reference: string; readonly value: Redacted.Redacted<string> }
}>

const Reveal = Data.taggedEnum<Reveal>()

export type View = Data.TaggedEnum<{
  // The Server has no Vault.
  NoVaults: {}
  ItemList: ItemListOf
  // One Item of `list.vault`: `field` is the Field under the cursor, an index into `item.fields` (Kind order).
  ItemDetail: {
    readonly list: ItemListOf
    readonly item: ItemMeta
    readonly field: number
    readonly reveal: Reveal
    // Reveals asked for in this detail so far: the next one's generation.
    readonly reveals: number
  }
  // The Audit Log from `top`, the first row shown (see `Audit`).
  Audit: {
    readonly filters: AuditView.Filters
    readonly form: AuditView.Form
    readonly log: AuditView.Log
    readonly top: number
  }
  // `focus` is the sidebar or a table row; a refresh keeps the row.
  Tokens: { readonly table: TokenTable; readonly focus: Focus }
}>

const { NoVaults, ItemList, ItemDetail, Audit, $is, $match } = Data.taggedEnum<View>()

const { Tokens } = Data.taggedEnum<View>()

export type Modal = Data.TaggedEnum<{
  Notice: { readonly problem: Problem }
  // A destructive step held until the Owner answers: `y` runs `effect`, any other key cancels it.
  Confirm: { readonly description: string; readonly effect: UiEffect }
  // The Token issue form; while its one request is out it takes no key, so it cannot be sent twice.
  IssueForm: { readonly form: IssueForm; readonly phase: "editing" | "sending" }
  // A Token just issued, its only showing: dismissing the modal drops the last reference to it.
  Issued: {
    readonly label: string
    readonly token: Redacted.Redacted<string>
    // Whether the issue revoked a Token with the same Label.
    readonly replaced: boolean
    readonly copy: Copy
  }
  // The new title for `item` of `vault`, being typed; while its one request is out it takes no key.
  Rename: {
    readonly vault: string
    readonly item: string
    readonly text: string
    readonly phase: "editing" | "sending"
  }
  // A rename's old and new References, shown until dismissed so the Owner can update the templates that used them.
  Renamed: { readonly receipt: ItemRenamed }
}>

const Modal = Data.taggedEnum<Modal>()

// A Vault's Item list being fetched, with no filter.
const loading = (vault: string): View =>
  ItemList({ vault, filter: Filter.Applied({ text: "" }), items: Items.Loading(), focus: Focus.Sidebar() })

// The Items whose title matches the filter, by the title matching rules of `hush find`.
const visible = (items: ReadonlyArray<ItemMeta>, filter: Filter): ReadonlyArray<ItemMeta> =>
  items.filter(({ title }) => Match.matches(filter.text, title))

// The Items the list shows: none until they are answered.
const shown = (list: ItemListOf): ReadonlyArray<ItemMeta> =>
  Items.$is("Loaded")(list.items) ? visible(list.items.items, list.filter) : []

// The Retired title keys the list shows below its Items: none until they are answered. The filter does not narrow
// them, so a blocked name stays in sight.
const retired = (list: ItemListOf): ReadonlyArray<string> => (Items.$is("Loaded")(list.items) ? list.items.retired : [])

// How many rows the cursor can be on: the visible Items, then the Retired titles.
const rowCount = (list: ItemListOf): number => shown(list).length + retired(list).length

// The row under the cursor, kept on a shown row when the filter narrowed the list; undefined on the sidebar or
// with no row shown.
const cursorRow = (list: ItemListOf): number | undefined => {
  const count = rowCount(list)

  return Focus.$is("Rows")(list.focus) && count > 0 ? Math.min(list.focus.row, count - 1) : undefined
}

// The Retired title under the row cursor, if any.
const selectedRetired = (list: ItemListOf): string | undefined => {
  const row = cursorRow(list)

  return row === undefined ? undefined : retired(list)[row - shown(list).length]
}

// The same list asked for again, keeping its filter and row cursor.
const reloading = (list: ItemListOf): View => ItemList({ ...list, items: Items.Loading() })

// The Item under the row cursor, if any.
const selectedItem = (list: ItemListOf): ItemMeta | undefined => {
  const row = cursorRow(list)

  return row === undefined ? undefined : shown(list)[row]
}

// A Field's Reference, built from the stored display names as the Server sent them.
const reference = (vault: string, item: ItemMeta, label: string): string =>
  `${Reference.scheme}${vault}/${item.title}/${label}`

// The detail of `item`, opened from `list` with the cursor on its first Field and nothing Revealed.
const detail = (list: ItemListOf, item: ItemMeta): View =>
  ItemDetail({ list, item, field: 0, reveal: Reveal.Hidden(), reveals: 0 })

// The Field under the detail's cursor.
const selectedField = (view: Extract<View, { readonly _tag: "ItemDetail" }>) => view.item.fields[view.field]

// The Token table being fetched, its rows focused at `row`.
const tokensLoading = (row = 0): View => Tokens({ table: TokenTable.Loading(), focus: Focus.Rows({ row }) })

// The Token under the table's row cursor, if any; the row is kept within the table.
const selectedToken = (view: Extract<View, { readonly _tag: "Tokens" }>): TokenInfo | undefined => {
  const { table, focus } = view

  if (!TokenTable.$is("Loaded")(table) || !Focus.$is("Rows")(focus)) return undefined

  return table.tokens[Math.min(focus.row, table.tokens.length - 1)]
}

export const View = {
  NoVaults,
  ItemList,
  ItemDetail,
  Audit,
  Tokens,
  $is,
  $match,
  Filter,
  Items,
  TokenTable,
  Modal,
  Focus,
  Reveal,
  loading,
  visible,
  shown,
  cursorRow,
  selectedItem,
  retired,
  rowCount,
  selectedRetired,
  reloading,
  reference,
  detail,
  selectedField,
  tokensLoading,
  selectedToken,
} as const
