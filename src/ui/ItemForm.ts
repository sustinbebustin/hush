import { Data, Redacted } from "effect"

import type { ItemMeta } from "../shared/Api.js"
import { Kind } from "../shared/Kind.js"
import type { Name } from "../shared/Name.js"
import { Concealed } from "./Concealed.js"
import { Key } from "./Key.js"

// The Item form as plain state, for a create (a Kind, a title, the concealed Field and the plain ones) or an edit
// of one Item (one change per submit, to the Field under the cursor). The concealed value is a `Concealed` buffer
// the screen draws only as a mask, never text an OpenTUI `Input` holds. `submit` turns the form into the one write
// it sends; every check of the values is the CLI's own, made by the interpreter before sending.

// A plain Field of a create: its label (the Kind's) and the text typed so far (empty: not sent).
export interface Draft {
  readonly label: Name
  readonly text: string
}

// The edit's one change to the Field under the cursor: a new value typed in the clear (a plain Field) or hidden
// (the concealed one), or the Field's removal.
export type Entry = Data.TaggedEnum<{
  Typed: { readonly text: string }
  Hidden: { readonly concealed: Concealed }
  Remove: {}
}>

const Entry = Data.taggedEnum<Entry>()

export type ItemForm = Data.TaggedEnum<{
  // `row` indexes `rows`: the Kind, the title, then the Kind's Fields in Kind order.
  Create: {
    readonly vault: string
    readonly kind: Kind
    readonly title: string
    readonly concealed: Concealed
    // The Kind's plain Fields, in Kind order.
    readonly plain: ReadonlyArray<Draft>
    readonly row: number
  }
  // `row` indexes the Kind's Fields in Kind order, present on the Item or not.
  Edit: { readonly vault: string; readonly item: ItemMeta; readonly row: number; readonly entry: Entry }
}>

const { Create, Edit, $is, $match } = Data.taggedEnum<ItemForm>()

// A row of the form: the Kind picker, the title, the concealed Field, or a plain Field (`index` into a create's
// drafts). Field labels are the Kind's, parsed once in `Kind`.
export type Row = Data.TaggedEnum<{
  Kind: {}
  Title: {}
  Hidden: { readonly label: Name }
  Plain: { readonly label: Name; readonly index: number }
}>

const Row = Data.taggedEnum<Row>()

// What a submit sends, without the Passphrase the request adds: a whole Item, or one change to one Field.
export type Save = Data.TaggedEnum<{
  Create: {
    readonly vault: string
    readonly title: string
    readonly kind: Kind
    readonly value: Redacted.Redacted<string>
    // The plain Fields typed into, in Kind order.
    readonly plain: ReadonlyArray<Draft>
  }
  Edit: { readonly vault: string; readonly item: ItemMeta; readonly label: string; readonly change: Change }
}>

const Save = Data.taggedEnum<Save>()

export type Change = Data.TaggedEnum<{
  Set: { readonly value: Redacted.Redacted<string> }
  Remove: {}
}>

const Change = Data.taggedEnum<Change>()

// How one row draws: in an OpenTUI `Input` (plain text only), or as fixed text (the Kind, a mask, a state).
export type Cell = Data.TaggedEnum<{
  Input: { readonly text: string; readonly placeholder: string }
  Shown: { readonly text: string }
}>

const Cell = Data.taggedEnum<Cell>()

export interface Line {
  readonly label: string
  readonly focused: boolean
  readonly cell: Cell
}

// The Kind's Fields as rows, primary first.
const fieldRows = (kind: Kind): ReadonlyArray<Row> => {
  let index = 0

  return Kind.fields(kind).map(({ label, role }) => {
    if (role === "primary") return Row.Hidden({ label })
    const row = Row.Plain({ label, index })
    index += 1

    return row
  })
}

const plainDrafts = (kind: Kind, kept: ReadonlyArray<Draft> = []): ReadonlyArray<Draft> =>
  Kind.fields(kind).flatMap(({ label, role }) =>
    role === "plain" ? [{ label, text: kept.find((draft) => draft.label === label)?.text ?? "" }] : [],
  )

const rows = (form: ItemForm): ReadonlyArray<Row> =>
  $match(form, {
    Create: ({ kind }) => [Row.Kind(), Row.Title(), ...fieldRows(kind)],
    Edit: ({ item }) => fieldRows(item.kind),
  })

const focused = (form: ItemForm): Row => rows(form)[form.row] ?? Row.Title()

// A create in `vault`, on the Kind picker with the first Kind.
const create = (vault: string): ItemForm => {
  const [kind] = Kind.all

  return Create({ vault, kind, title: "", concealed: Concealed.empty, plain: plainDrafts(kind), row: 0 })
}

// A fresh entry for `row`: nothing typed yet.
const freshEntry = (row: Row): Entry =>
  Row.$is("Hidden")(row) ? Entry.Hidden({ concealed: Concealed.empty }) : Entry.Typed({ text: "" })

// An edit of `item` in `vault`, on the Field labelled `label` (the first Field when the Kind has none such).
const edit = (vault: string, item: ItemMeta, label: string | undefined): ItemForm => {
  const all = fieldRows(item.kind)

  const at = Math.max(
    0,
    all.findIndex((row) => labelOf(row) === label),
  )

  return Edit({ vault, item, row: at, entry: freshEntry(all[at] ?? Row.Title()) })
}

// Whether keys type into the concealed buffer: the paste key and a bracketed paste go there only then.
const hiddenFocused = (form: ItemForm): boolean => Row.$is("Hidden")(focused(form))

// A text after `key`: Backspace erases one character, a printable key appends it.
const edited = (text: string, key: Key): string => {
  if (Key.is(key, "backspace")) return [...text].slice(0, -1).join("")

  return text + (Key.printable(key) ?? "")
}

const concealedAfter = (concealed: Concealed, key: Key): Concealed => {
  if (Key.is(key, "backspace")) return Concealed.backspace(concealed)
  const text = Key.printable(key)

  return text === undefined ? concealed : Concealed.append(concealed, text)
}

const stepOf = (key: Key): number | undefined => {
  if (Key.is(key, "space") || Key.is(key, "right") || Key.is(key, " ")) return 1

  return Key.is(key, "left") ? -1 : undefined
}

// The Kind `step` places after `current`, wrapping around.
const cycle = (current: Kind, step: number): Kind =>
  Kind.all[(Kind.all.indexOf(current) + step + Kind.all.length) % Kind.all.length] ?? current

const isRemoveChord = (key: Key) => Key.is(key, "d", { ctrl: true })

// The form on row `row`; an edit starts that row's entry afresh, so a submit changes only the Field shown.
const atRow = (form: ItemForm, row: number): ItemForm =>
  $match(form, {
    Create: (creating) => ({ ...creating, row }),
    Edit: (editing) => ({ ...editing, row, entry: freshEntry(rows(form)[row] ?? Row.Title()) }),
  })

type CreateForm = Extract<ItemForm, { readonly _tag: "Create" }>

type EditForm = Extract<ItemForm, { readonly _tag: "Edit" }>

const createKey = (form: CreateForm, pressed: Key): ItemForm =>
  Row.$match(focused(form), {
    Kind: () => {
      const step = stepOf(pressed)

      if (step === undefined) return form
      const kind = cycle(form.kind, step)

      return { ...form, kind, plain: plainDrafts(kind, form.plain) }
    },
    Title: () => ({ ...form, title: edited(form.title, pressed) }),
    Hidden: () => ({ ...form, concealed: concealedAfter(form.concealed, pressed) }),
    Plain: ({ index }) => ({
      ...form,
      plain: form.plain.map((draft, at) => (at === index ? { ...draft, text: edited(draft.text, pressed) } : draft)),
    }),
  })

// Ctrl-D marks the Field for removal, and again unmarks it.
const editKey = (form: EditForm, pressed: Key): ItemForm => {
  if (isRemoveChord(pressed))
    return {
      ...form,
      entry: Entry.$is("Remove")(form.entry) ? freshEntry(focused(form)) : Entry.Remove(),
    }

  return Entry.$match(form.entry, {
    Typed: ({ text }) => ({ ...form, entry: Entry.Typed({ text: edited(text, pressed) }) }),
    Hidden: ({ concealed }) => ({ ...form, entry: Entry.Hidden({ concealed: concealedAfter(concealed, pressed) }) }),
    Remove: () => form,
  })
}

// The form after one key other than Enter, Escape, the paste key and Ctrl-C (the reducer's). Up and Down (or Tab)
// move between rows; text rows take typing; Space, Left and Right change the Kind; Ctrl-D marks an edit's Field
// for removal.
const key = (form: ItemForm, pressed: Key): ItemForm => {
  const last = rows(form).length - 1

  if (Key.is(pressed, "up")) return atRow(form, Math.max(0, form.row - 1))

  if (Key.is(pressed, "down") || Key.is(pressed, "tab")) return atRow(form, Math.min(last, form.row + 1))

  return $match(form, {
    Create: (creating) => createKey(creating, pressed),
    Edit: (editing) => editKey(editing, pressed),
  })
}

// Text appended to the concealed buffer, from the clipboard or a bracketed paste; on any other row nothing changes.
const appendHidden = (form: ItemForm, text: string): ItemForm => {
  if (!hiddenFocused(form)) return form

  return $match(form, {
    Create: (creating) => ({ ...creating, concealed: Concealed.append(creating.concealed, text) }),
    Edit: (editing) =>
      Entry.$is("Hidden")(editing.entry)
        ? { ...editing, entry: Entry.Hidden({ concealed: Concealed.append(editing.entry.concealed, text) }) }
        : editing,
  })
}

// A bracketed paste: all of it into the concealed buffer (a key may span lines), else its first line into a text row.
const paste = (form: ItemForm, text: string): ItemForm => {
  if (hiddenFocused(form)) return appendHidden(form, text)
  const line = text.split(/[\r\n]/, 1)[0] ?? ""

  return Row.$match(focused(form), {
    Kind: () => form,
    Hidden: () => form,
    Title: () => ($is("Create")(form) ? { ...form, title: form.title + line } : form),
    Plain: ({ index }) =>
      $match(form, {
        Create: (creating) => ({
          ...creating,
          plain: creating.plain.map((draft, at) => (at === index ? { ...draft, text: draft.text + line } : draft)),
        }),
        Edit: (editing) =>
          Entry.$is("Typed")(editing.entry)
            ? { ...editing, entry: Entry.Typed({ text: editing.entry.text + line }) }
            : editing,
      }),
  })
}

const labelOf = (row: Row): string => (Row.$is("Hidden")(row) || Row.$is("Plain")(row) ? row.label : "")

// The label of the Field under an edit's cursor.
const focusedLabel = (form: EditForm): string => labelOf(focused(form))

// The one write the form sends.
const submit = (form: ItemForm): Save =>
  $match(form, {
    Create: ({ vault, title, kind, concealed, plain }) =>
      Save.Create({ vault, title, kind, value: concealed.value, plain: plain.filter(({ text }) => text !== "") }),
    Edit: ({ vault, item, entry }) =>
      Save.Edit({
        vault,
        item,
        label: labelOf(focused(form)),
        change: Entry.$match(entry, {
          Typed: ({ text }) => Change.Set({ value: Redacted.make(text) }),
          Hidden: ({ concealed }) => Change.Set({ value: concealed.value }),
          Remove: () => Change.Remove(),
        }),
      }),
  })

// The form once its write is sent: the concealed buffer, and an edit's entry, are dropped.
const sent = (form: ItemForm): ItemForm =>
  $match(form, {
    Create: (creating) => ({ ...creating, concealed: Concealed.empty }),
    Edit: (editing) => ({ ...editing, entry: freshEntry(focused(form)) }),
  })

const maskCells = 40

// A concealed buffer as a mask, one cell per character up to a width, then the count.
const mask = ({ length }: Concealed): string =>
  length <= maskCells ? "*".repeat(length) : `${"*".repeat(maskCells)} (${length} characters)`

const hiddenCell = (concealed: Concealed, empty: string) =>
  Cell.Shown({ text: concealed.length === 0 ? empty : mask(concealed) })

const createLine = (form: CreateForm, row: Row, isFocused: boolean): Line =>
  Row.$match(row, {
    Kind: () => ({
      label: "kind",
      focused: isFocused,
      cell: Cell.Shown({ text: isFocused ? `${form.kind}  (Space: ${Kind.all.join(" / ")})` : form.kind }),
    }),
    Title: () => ({
      label: "title",
      focused: isFocused,
      cell: Cell.Input({ text: form.title, placeholder: "(required)" }),
    }),
    Hidden: ({ label }) => ({ label, focused: isFocused, cell: hiddenCell(form.concealed, "(required, hidden)") }),
    Plain: ({ label, index }) => ({
      label,
      focused: isFocused,
      cell: Cell.Input({ text: form.plain[index]?.text ?? "", placeholder: "(optional)" }),
    }),
  })

const editLine = (form: EditForm, row: Row, isFocused: boolean): Line => {
  const label = labelOf(row)
  const present = form.item.fields.some((field) => field.label === label)
  const state = present ? "(unchanged)" : "(absent)"

  if (!isFocused)
    return { label, focused: false, cell: Cell.Shown({ text: Row.$is("Hidden")(row) ? "********" : state }) }

  return {
    label,
    focused: true,
    cell: Entry.$match(form.entry, {
      Typed: ({ text }) =>
        Cell.Input({ text, placeholder: present ? "(unchanged: type a new value)" : "(absent: type a value to add)" }),
      Hidden: ({ concealed }) => hiddenCell(concealed, "(unchanged: type a new value, hidden)"),
      Remove: () => Cell.Shown({ text: "(remove this Field)" }),
    }),
  }
}

// The form as the screen draws it, one line per row.
const lines = (form: ItemForm): ReadonlyArray<Line> =>
  rows(form).map((row, index) =>
    $match(form, {
      Create: (creating) => createLine(creating, row, index === form.row),
      Edit: (editing) => editLine(editing, row, index === form.row),
    }),
  )

export const ItemForm = {
  Create,
  Edit,
  $is,
  $match,
  Entry,
  Save,
  Change,
  Cell,
  create,
  edit,
  hiddenFocused,
  focusedLabel,
  key,
  appendHidden,
  paste,
  submit,
  sent,
  lines,
} as const
