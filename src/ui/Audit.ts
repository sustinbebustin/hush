import { Data } from "effect"

import type { AuditQuery } from "../cli/Admin.js"
import type { AuditEntry, AuditPage } from "../shared/Api.js"
import { Key } from "./Key.js"
import { Size } from "./Size.js"
import { View } from "./View.js"

// The Audit view: the Audit Log newest first under three filters (Vault, Label, since), read a page at a time.
// Its transitions are pure and say which request, if any, to send; the reducer adds the Passphrase.

type AuditView = Extract<View, { readonly _tag: "Audit" }>

// The filters as typed; an empty text filters nothing.
export interface Filters {
  readonly vault: string
  readonly label: string
  readonly since: string
}

export type Field = keyof Filters

// Tab moves through the fields in this order.
const fields: ReadonlyArray<Field> = ["vault", "label", "since"]

const noFilters: Filters = { vault: "", label: "", since: "" }

const sameFilters = (a: Filters, b: Filters) => fields.every((field) => a[field] === b[field])

// The filter row: shut, or being typed into `draft` (applied only on Enter).
export type Form = Data.TaggedEnum<{
  Shut: {}
  Editing: { readonly draft: Filters; readonly field: Field }
}>

const Form = Data.taggedEnum<Form>()

// What lies below the loaded entries: nothing, a page from `next`, or that page being fetched.
export type Rest = Data.TaggedEnum<{
  End: {}
  More: { readonly next: number }
  Fetching: { readonly before: number }
}>

const Rest = Data.taggedEnum<Rest>()

// The entries asked for, answered (with the query the Server was sent, so every later page uses the same instant
// for a relative since), or refused (the refusal itself is a modal).
export type Log = Data.TaggedEnum<{
  Loading: {}
  Refused: {}
  Loaded: { readonly query: AuditQuery; readonly entries: ReadonlyArray<AuditEntry>; readonly rest: Rest }
}>

const Log = Data.taggedEnum<Log>()

// One `admin/audit` request: the first page of the filters as typed, or the page below `before` of the query the
// first page resolved them to.
export type Ask = Data.TaggedEnum<{
  First: { readonly filters: Filters }
  Next: { readonly query: AuditQuery; readonly before: number }
}>

const Ask = Data.taggedEnum<Ask>()

// A transition: the next view and the request it sends, if any.
export interface Move {
  readonly view: AuditView
  readonly ask: Ask | undefined
}

// How many lines `text` takes word-wrapped to `width` columns.
const wrappedLines = (text: string, width: number): number =>
  text
    .split(" ")
    .reduce(
      ({ lines, used }, word) =>
        used + 1 + word.length <= width
          ? { lines, used: used + 1 + word.length }
          : { lines: lines + 1, used: word.length },
      { lines: 1, used: -1 },
    ).lines

// The Audit rows the main pane shows at least at `size`, and so how far PageUp and PageDown move: the frame less the
// hint bar, the pane's border, its filter line, the status line as the longest status wraps at the pane's width,
// and the column header; never fewer than one. When the last loaded entry is within this many rows of the top, the
// bottom is in view and the next page is fetched.
const rowsAt = (size: Size): number => Math.max(1, size.height - 5 - wrappedLines(longestStatus, Size.paneWidth(size)))

const firstPage = (filters: Filters): Move => ({
  view: View.Audit({ filters, form: Form.Shut(), log: Log.Loading(), top: 0 }),
  ask: Ask.First({ filters }),
})

// Selecting Audit in the sidebar: the newest page with no filter.
const start = (): Move => firstPage(noFilters)

const stay = (view: AuditView): Move => ({ view, ask: undefined })

// The view scrolled to `top` in a pane of `rows` rows; reaching the bottom with a page left below fetches it, once.
const scrolled = (view: AuditView, top: number, rows: number): Move => {
  const { log } = view

  if (!Log.$is("Loaded")(log)) return stay(view)
  const clamped = Math.max(0, Math.min(top, log.entries.length - rows))
  const moved = { ...view, top: clamped }

  if (clamped + rows < log.entries.length || !Rest.$is("More")(log.rest)) return stay(moved)

  return {
    view: { ...moved, log: { ...log, rest: Rest.Fetching({ before: log.rest.next }) } },
    ask: Ask.Next({ query: log.query, before: log.rest.next }),
  }
}

// Keys while the filter row is typed into: text edits the field, Tab moves to the next, Enter applies (one
// request, only when the filters changed), Escape drops the draft.
const editingKey = (view: AuditView, draft: Filters, field: Field, key: Key): Move => {
  const edit = (text: string) => stay({ ...view, form: Form.Editing({ draft: { ...draft, [field]: text }, field }) })

  if (Key.is(key, "return"))
    return sameFilters(draft, view.filters) ? stay({ ...view, form: Form.Shut() }) : firstPage(draft)

  if (Key.is(key, "escape")) return stay({ ...view, form: Form.Shut() })

  if (Key.is(key, "tab"))
    return stay({
      ...view,
      form: Form.Editing({ draft, field: fields[(fields.indexOf(field) + 1) % fields.length] ?? field }),
    })

  if (Key.is(key, "backspace")) return edit([...draft[field]].slice(0, -1).join(""))
  const typed = Key.printable(key)

  return typed === undefined ? stay(view) : edit(draft[field] + typed)
}

// A key in the Audit view showing `rows` rows, or undefined for one it leaves to the sidebar and the rest of the UI.
const key = (view: AuditView, pressed: Key, rows: number): Move | undefined => {
  const { form } = view

  if (Form.$is("Editing")(form)) return editingKey(view, form.draft, form.field, pressed)

  if (Key.is(pressed, "/")) return stay({ ...view, form: Form.Editing({ draft: view.filters, field: "vault" }) })

  if (Key.is(pressed, "pagedown")) return scrolled(view, view.top + rows, rows)

  if (Key.is(pressed, "pageup")) return scrolled(view, view.top - rows, rows)

  if (Key.is(pressed, "escape")) return sameFilters(view.filters, noFilters) ? stay(view) : firstPage(noFilters)

  return undefined
}

// A paste into the field being typed; ignored otherwise.
const paste = (view: AuditView, text: string): AuditView => {
  const { form } = view

  if (!Form.$is("Editing")(form)) return view

  return {
    ...view,
    form: Form.Editing({ draft: { ...form.draft, [form.field]: form.draft[form.field] + text }, field: form.field }),
  }
}

// Whether the view is still waiting for the answer to `ask`; any other answer is late and dropped.
const awaits = (view: AuditView, ask: Ask): boolean =>
  Ask.$match(ask, {
    First: ({ filters }) => Log.$is("Loading")(view.log) && sameFilters(view.filters, filters),
    Next: ({ before }) =>
      Log.$is("Loaded")(view.log) && Rest.$is("Fetching")(view.log.rest) && view.log.rest.before === before,
  })

const restOf = (page: AuditPage): Rest => (page.next === undefined ? Rest.End() : Rest.More({ next: page.next }))

// The answer to `ask`: the first page replaces the log, a later one is appended.
const listed = (view: AuditView, ask: Ask, query: AuditQuery, page: AuditPage): AuditView | undefined => {
  if (!awaits(view, ask)) return undefined
  const { log } = view
  const before = Log.$is("Loaded")(log) ? log.entries : []

  return { ...view, log: Log.Loaded({ query, entries: [...before, ...page.entries], rest: restOf(page) }) }
}

// The refusal of `ask`: a first page leaves the log refused, a later one keeps the entries and the page to fetch.
const refused = (view: AuditView, ask: Ask): AuditView | undefined => {
  if (!awaits(view, ask)) return undefined
  const { log } = view

  return Log.$is("Loaded")(log) && Ask.$is("Next")(ask)
    ? { ...view, log: { ...log, rest: Rest.More({ next: ask.before }) } }
    : { ...view, log: Log.Refused() }
}

const editing = (view: AuditView): boolean => Form.$is("Editing")(view.form)

const fieldNames: Readonly<Record<Field, string>> = { vault: "Vault", label: "Label", since: "Since" }

// The filter row: each field and its text, the one being typed marked by a cursor.
const filterLine = (view: AuditView): string =>
  Form.$match(view.form, {
    Shut: () => fields.map((field) => `${fieldNames[field]}: ${view.filters[field]}`).join("  "),
    Editing: ({ draft, field: typing }) =>
      `/ ${fields.map((field) => `${fieldNames[field]}: ${draft[field]}${field === typing ? "_" : ""}`).join("  ")}`,
  })

const count = (n: number) => `${n} ${n === 1 ? "entry" : "entries"}`

const loadedStatus = (entries: number, row: number, rest: string) => `${count(entries)}, from row ${row}, ${rest}`

const moreBelow = "older entries load at the bottom (PgDn)"

// The line above the rows: loading, refused, or how many entries are loaded and what lies below them.
const status = (view: AuditView): string =>
  Log.$match(view.log, {
    Loading: () => "Loading...",
    Refused: () => "Could not read the Audit Log.",
    Loaded: ({ entries, rest }) =>
      loadedStatus(
        entries.length,
        view.top + 1,
        Rest.$match(rest, {
          End: () => "end of the log",
          More: () => moreBelow,
          Fetching: () => "loading older entries...",
        }),
      ),
  })

// The longest status line, for up to six-digit counts: what `rowsAt` leaves room for.
const longestStatus = loadedStatus(999_999, 999_999, moreBelow)

// The action column fits the longest action, `passphrase.change`.
const widths = { time: 19, actor: 12, action: 17, vaults: 12 } as const

// `text` in exactly `width` cells' worth of characters: padded, or cut with an ellipsis.
const cell = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)

const actorNames = { init: "init", passphrase: "Passphrase", host: "host" } as const

// A Token by its Label; the Passphrase, Init code and host by name.
const actorOf = ({ actor }: AuditEntry): string => (actor.type === "token" ? actor.label : actorNames[actor.type])

// What else an entry says: its References, the names its detail holds, how it failed, and how many denials it
// coalesced. Names only: the Audit Log never holds a value.
const detailOf = (entry: AuditEntry): string => {
  const { detail } = entry
  const parts: Array<string> = [...entry.references]

  if (detail?.title !== undefined) parts.push(`title ${detail.title}`)

  if (detail?.from !== undefined || detail?.to !== undefined) parts.push(`${detail.from ?? ""} -> ${detail.to ?? ""}`)

  if (detail?.fields !== undefined) parts.push(`fields ${detail.fields.join(",")}`)

  if (detail?.set !== undefined) parts.push(`set ${detail.set}`)

  if (detail?.removed !== undefined) parts.push(`removed ${detail.removed}`)

  if (detail?.label !== undefined) parts.push(`label ${detail.label}`)

  if (detail?.grants !== undefined)
    parts.push(`grants ${detail.grants.map(({ vault, access }) => `${vault}:${access}`).join(",")}`)

  if (detail?.expiresAt !== undefined)
    parts.push(detail.expiresAt === null ? "no expiry" : `expires ${time(detail.expiresAt)}`)

  if (detail?.replaced !== undefined) parts.push(`replaced ${detail.replaced}`)

  if (entry.outcome !== "ok") parts.push(`${entry.outcome} ${entry.error}`)

  if (entry.count > 1) parts.push(`x${entry.count} until ${time(entry.lastAt)}`)

  return parts.join("; ")
}

// An ISO instant to the second, as UTC: `2026-10-17 18:57:17`.
const time = (iso: string) => iso.slice(0, 19).replace("T", " ")

// One entry as one row: time, actor, action, Vaults, detail.
const row = (entry: AuditEntry): string =>
  [
    cell(time(entry.at), widths.time),
    cell(actorOf(entry), widths.actor),
    cell(entry.action, widths.action),
    cell(entry.vaults.join(","), widths.vaults),
    detailOf(entry),
  ].join(" ")

const header = [
  cell("Time", widths.time),
  cell("Actor", widths.actor),
  cell("Action", widths.action),
  cell("Vaults", widths.vaults),
  "Detail",
].join(" ")

// The header and the rows from the scroll position down; empty until a page is loaded.
const lines = (view: AuditView): ReadonlyArray<string> =>
  Log.$is("Loaded")(view.log) && view.log.entries.length > 0
    ? [header, ...view.log.entries.slice(view.top).map(row)]
    : []

export const Audit = {
  Form,
  Rest,
  Log,
  Ask,
  start,
  rowsAt,
  key,
  paste,
  listed,
  refused,
  editing,
  filterLine,
  status,
  row,
  lines,
} as const
