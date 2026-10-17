import { Data, type Redacted } from "effect"

import type { ItemMeta, TokenInfo } from "../shared/Api.js"
import { Match } from "../shared/Match.js"
import { Reference } from "../shared/Reference.js"
import type { IssueForm } from "./IssueForm.js"
import type { Problem } from "./Problem.js"
import type { UiEffect } from "./UiEffect.js"

// What the main pane of an Open UI shows, and the modals stacked above it. Later views (forms, Tokens,
// Audit) join `View`; later modals (confirm, help) join `Modal`.

// The Item list's filter over titles: being typed, or applied (an empty text shows every Item).
export type Filter = Data.TaggedEnum<{
  Applied: { readonly text: string }
  Editing: { readonly text: string }
}>

const Filter = Data.taggedEnum<Filter>()

// One Vault's Items: asked for, answered, or refused (the refusal itself is a modal).
export type Items = Data.TaggedEnum<{
  Loading: {}
  Loaded: { readonly items: ReadonlyArray<ItemMeta> }
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
// cursor (an index into the visible rows).
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
  // `focus` is the sidebar or a table row; a refresh keeps the row.
  Tokens: { readonly table: TokenTable; readonly focus: Focus }
}>

const { NoVaults, ItemList, ItemDetail, $is, $match } = Data.taggedEnum<View>()

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

// The row under the cursor, kept on a visible row when the filter narrowed the list; undefined on the sidebar or
// with no row shown.
const cursorRow = (list: ItemListOf): number | undefined => {
  const count = shown(list).length

  return Focus.$is("Rows")(list.focus) && count > 0 ? Math.min(list.focus.row, count - 1) : undefined
}

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
  reference,
  detail,
  selectedField,
  tokensLoading,
  selectedToken,
} as const
