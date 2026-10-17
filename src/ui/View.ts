import { Data } from "effect"

import type { ItemMeta } from "../shared/Api.js"
import { Match } from "../shared/Match.js"
import type * as AuditView from "./Audit.js"
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

export type View = Data.TaggedEnum<{
  // The Server has no Vault.
  NoVaults: {}
  ItemList: { readonly vault: string; readonly filter: Filter; readonly items: Items }
  // The Audit Log from `top`, the first row shown (see `Audit`).
  Audit: {
    readonly filters: AuditView.Filters
    readonly form: AuditView.Form
    readonly log: AuditView.Log
    readonly top: number
  }
}>

const { NoVaults, ItemList, Audit, $is, $match } = Data.taggedEnum<View>()

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

export const View = { NoVaults, ItemList, Audit, $is, $match, Filter, Items, Modal, loading, visible } as const
