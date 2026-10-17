import { Data, type Redacted } from "effect"

import type { ItemMeta, TokenInfo } from "../shared/Api.js"
import { Match } from "../shared/Match.js"
import type { IssueForm } from "./IssueForm.js"
import type { Problem } from "./Problem.js"
import type { UiEffect } from "./UiEffect.js"

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

// Every Token, newest first: asked for (keeping the row a refresh returns to), answered (with the row under the
// table cursor), or refused.
export type TokenTable = Data.TaggedEnum<{
  Loading: { readonly row: number }
  Loaded: { readonly tokens: ReadonlyArray<TokenInfo>; readonly row: number }
  Refused: {}
}>

const TokenTable = Data.taggedEnum<TokenTable>()

// The issued Token's copy key: absent (no host clipboard), ready, writing, or done.
export type Copy = "absent" | "ready" | "copying" | "copied"

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
  ItemList({ vault, filter: Filter.Applied({ text: "" }), items: Items.Loading() })

// The Items whose title matches the filter, by the title matching rules of `hush find`.
const visible = (items: ReadonlyArray<ItemMeta>, filter: Filter): ReadonlyArray<ItemMeta> =>
  items.filter(({ title }) => Match.matches(filter.text, title))

// The Token table being fetched, with the table focused and its cursor to return to `row`.
const tokensLoading = (row = 0): View => Tokens({ table: TokenTable.Loading({ row }), focus: "table" })

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
