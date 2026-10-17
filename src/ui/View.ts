import { Data } from "effect"

import type { ItemMeta, TokenInfo } from "../shared/Api.js"
import { Match } from "../shared/Match.js"
import type { Problem } from "./Problem.js"

// What the main pane of an Open UI shows, and the modals stacked above it. Later views (Item detail, forms, Tokens,
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

// Every Token, newest first: asked for, answered (with the row under the table cursor), or refused.
export type TokenTable = Data.TaggedEnum<{
  Loading: {}
  Loaded: { readonly tokens: ReadonlyArray<TokenInfo>; readonly row: number }
  Refused: {}
}>

const TokenTable = Data.taggedEnum<TokenTable>()

// Where Up and Down go in the Tokens view: the sidebar, or the table's rows.
export type Focus = "sidebar" | "table"

export type View = Data.TaggedEnum<{
  // The Server has no Vault.
  NoVaults: {}
  ItemList: { readonly vault: string; readonly filter: Filter; readonly items: Items }
  Tokens: { readonly table: TokenTable; readonly focus: Focus }
}>

const { NoVaults, ItemList, Tokens, $is, $match } = Data.taggedEnum<View>()

export type Modal = Data.TaggedEnum<{
  Notice: { readonly problem: Problem }
}>

const Modal = Data.taggedEnum<Modal>()

// A Vault's Item list being fetched, with no filter.
const loading = (vault: string): View =>
  ItemList({ vault, filter: Filter.Applied({ text: "" }), items: Items.Loading() })

// The Items whose title matches the filter, by the title matching rules of `hush find`.
const visible = (items: ReadonlyArray<ItemMeta>, filter: Filter): ReadonlyArray<ItemMeta> =>
  items.filter(({ title }) => Match.matches(filter.text, title))

// The Token table being fetched, with the table focused.
const tokensLoading = (): View => Tokens({ table: TokenTable.Loading(), focus: "table" })

export const View = {
  NoVaults,
  ItemList,
  Tokens,
  $is,
  $match,
  Filter,
  Items,
  TokenTable,
  Modal,
  loading,
  tokensLoading,
  visible,
} as const
