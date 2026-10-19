import {
  BoxRenderable,
  type CliRenderer,
  InputRenderable,
  type KeyEvent,
  type PasteEvent,
  TextRenderable,
} from "@opentui/core"

import { Display, type RetiredRow, type TokenColumn, type TokenRow } from "./Display.js"
import { ItemForm, type Line as FormLine } from "./ItemForm.js"
import type { Key } from "./Key.js"
import { Size } from "./Size.js"

// The thin sync layer: one renderable tree built once, then each `Display` copied into it. It knows OpenTUI and
// `Display`, never the reducer or the state. Layout: a Vault sidebar and the main pane side by side, a modal over
// them, a one-line key hint bar at the bottom; no gaps or decorative padding. Down to `Size.minimum`, every box of
// rows takes the height left above the hint bar and cuts what does not fit at its edges.

export interface Screen {
  readonly draw: (display: Display) => void
}

const countWidth = 5
const kindWidth = 16

// An issued Token's length: `hush_` and 43 base64url characters (`src/shared/Token.ts`).
const tokenLength = 48

// A box of rows that takes the height left in its column and cuts what does not fit, instead of growing past the
// pane's border: a zero basis, so it never squeezes out the filter and status lines above it.
const clipped = { flexGrow: 1, flexBasis: 0, overflow: "hidden" } as const

// A column of text that never wraps, so each row stays on its line.
const column = (renderer: CliRenderer, options: { readonly width?: number; readonly flexGrow?: number } = {}) =>
  new TextRenderable(renderer, { content: "", wrapMode: "none", truncate: true, ...options })

const tokenColumns = Display.tokenColumnWidths

// The Token table: a header line, then one line per Token from the window's first; Grants take the width left
// over. Only the columns `Display` says fit are drawn; Label always is.
const mountTokenTable = (renderer: CliRenderer) => {
  const box = new BoxRenderable(renderer, { ...clipped, flexDirection: "row" })

  const columns: ReadonlyArray<readonly [TokenColumn | "label", TextRenderable, string, (row: TokenRow) => string]> = [
    [
      "label",
      column(renderer, { width: tokenColumns.label }),
      "  Label",
      (row) => `${row.underCursor ? ">" : " "} ${row.label}`,
    ],
    ["state", column(renderer, { width: tokenColumns.state }), "State", (row) => row.state],
    ["created", column(renderer, { width: tokenColumns.created }), "Created", (row) => row.created],
    ["expires", column(renderer, { width: tokenColumns.expires }), "Expires", (row) => row.expires],
    ["grants", column(renderer, { flexGrow: 1 }), "Grants", (row) => row.grants],
  ]

  for (const [, text] of columns) box.add(text)

  const draw = (rows: ReadonlyArray<TokenRow> | undefined, shown: ReadonlyArray<TokenColumn>, top: number) => {
    box.visible = rows !== undefined

    for (const [name, text, header, cell] of columns) {
      text.visible = name === "label" || shown.includes(name)
      text.content = [header, ...(rows ?? []).slice(top).map(cell)].join("\n")
    }
  }

  return { box, draw }
}

// The most rows an Item form has: the Kind, the title and a database's six Fields.
const formRows = 8
const formLabelWidth = 14

// The Item form: one line per row, a label then its cell. A plain text cell is an OpenTUI `Input` whose value is
// copied from the `Display`; it is never focused, so the reducer alone owns what is typed. Every other cell (the
// Kind, the concealed Field's mask, a state) is plain text: no secret is ever put in an `Input`.
const mountForm = (renderer: CliRenderer) => {
  const box = new BoxRenderable(renderer, { ...clipped, flexDirection: "column" })

  const lines = Array.from({ length: formRows }, () => {
    const line = new BoxRenderable(renderer, { height: 1, flexDirection: "row" })
    const label = column(renderer, { width: formLabelWidth })
    const input = new InputRenderable(renderer, { flexGrow: 1, placeholderColor: "#888888" })
    input.focusable = false
    const shown = column(renderer, { flexGrow: 1 })
    line.add(label)
    line.add(input)
    line.add(shown)
    box.add(line)

    return { line, label, input, shown }
  })

  const draw = (form: ReadonlyArray<FormLine> | undefined) => {
    box.visible = form !== undefined

    for (const [index, { line, label, input, shown }] of lines.entries()) {
      const row = form?.[index]
      line.visible = row !== undefined

      if (row === undefined) {
        // An unused row keeps nothing an earlier form typed.
        label.content = ""
        input.value = ""
        shown.content = ""
        continue
      }

      label.content = `${row.focused ? ">" : " "} ${row.label}`
      input.visible = ItemForm.Cell.$is("Input")(row.cell)
      shown.visible = !input.visible
      ItemForm.Cell.$match(row.cell, {
        Input: ({ text, placeholder }) => {
          input.value = text
          input.placeholder = placeholder
        },
        Shown: ({ text }) => {
          input.value = ""
          shown.content = text
        },
      })
    }
  }

  return { box, draw }
}

// The Retired titles section under the Item rows, after a blank line and its heading; nothing when there is none.
const retiredLines = (retired: ReadonlyArray<RetiredRow>): ReadonlyArray<string> =>
  retired.length === 0
    ? []
    : ["", "Retired titles", ...retired.map(({ key, underCursor }) => `${underCursor ? ">" : " "} ${key}`)]

type OpenShown = Extract<Display, { readonly _tag: "Open" }>

const mount = (renderer: CliRenderer): Screen => {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" })

  const locked = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexDirection: "column",
    overflow: "hidden",
    border: true,
    title: "hush",
  })

  const promptLine = column(renderer)
  const lockedNotice = new TextRenderable(renderer, { content: "", wrapMode: "word" })
  locked.add(promptLine)
  locked.add(lockedNotice)

  const open = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })

  const sidebar = new BoxRenderable(renderer, {
    width: Size.sidebarWidth,
    flexShrink: 0,
    flexDirection: "row",
    overflow: "hidden",
    border: true,
    title: "Vaults",
  })

  const vaultNames = column(renderer, { flexGrow: 1 })
  const vaultCounts = new TextRenderable(renderer, { content: "", width: countWidth, textAlign: "right" })
  sidebar.add(vaultNames)
  sidebar.add(vaultCounts)

  const main = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column", border: true })
  const filterLine = column(renderer)
  const rows = new BoxRenderable(renderer, { ...clipped, flexDirection: "row" })
  const titles = column(renderer, { flexGrow: 1 })
  const kinds = column(renderer, { width: kindWidth + 1 })
  const message = new TextRenderable(renderer, { content: "", wrapMode: "word" })
  const detailBox = new BoxRenderable(renderer, clipped)
  const detail = new TextRenderable(renderer, { content: "", wrapMode: "char" })
  detailBox.add(detail)
  rows.add(titles)
  rows.add(kinds)
  // The Audit rows from the scroll position down.
  const logBox = new BoxRenderable(renderer, clipped)
  // Cut at the right edge too, not truncated in the middle, so the columns stay in place and only detail is lost.
  const log = new TextRenderable(renderer, { content: "", wrapMode: "none" })
  logBox.add(log)
  main.add(filterLine)
  main.add(message)
  main.add(rows)
  main.add(detailBox)
  main.add(logBox)
  const tokenTable = mountTokenTable(renderer)
  main.add(tokenTable.box)
  const itemForm = mountForm(renderer)
  main.add(itemForm.box)
  open.add(sidebar)
  open.add(main)

  // The modal, centred over the panes and cut to the rows above the hint bar. It is never narrower than an issued
  // Token and its border, so the Token stays on one line to select and copy.
  const modalArea = new BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 1,
    justifyContent: "center",
    alignItems: "center",
  })

  const modal = new BoxRenderable(renderer, {
    width: "70%",
    minWidth: tokenLength + 2,
    maxWidth: "100%",
    maxHeight: "100%",
    overflow: "hidden",
    border: true,
    title: "Notice",
    backgroundColor: "#000000",
    shouldFill: true,
  })

  const modalText = new TextRenderable(renderer, { content: "", wrapMode: "word" })
  modal.add(modalText)
  modalArea.add(modal)

  // One line, cut at the right edge: `Display` already fitted it to the width.
  const hints = new TextRenderable(renderer, { content: "", wrapMode: "none", height: 1, flexShrink: 0 })
  // A frame below the minimum shows this alone, wrapped to the width there is.
  const small = new TextRenderable(renderer, { content: "", wrapMode: "word", flexGrow: 1 })
  root.add(small)
  root.add(locked)
  root.add(open)
  root.add(hints)
  root.add(modalArea)
  renderer.root.add(root)

  // The Open layout's text, and which of its parts show.
  const fillOpen = (shown: OpenShown) => {
    const { windows } = shown
    vaultNames.content = [...shown.vaults, ...shown.sections]
      .map(({ name, underCursor }) => `${underCursor ? ">" : " "} ${name}`)
      .slice(windows.sidebar.line)
      .join("\n")
    vaultCounts.content = shown.vaults
      .map(({ items }) => String(items))
      .slice(windows.sidebar.line)
      .join("\n")
    // An empty bottom title would still draw its padding.
    sidebar.bottomTitle = shown.sidebarHidden === "" ? undefined : shown.sidebarHidden
    main.bottomTitle = shown.paneHidden === "" ? undefined : shown.paneHidden
    logBox.visible = shown.log.length > 0
    log.content = shown.log.join("\n")
    tokenTable.draw(shown.tokens, shown.tokenColumns, windows.tokens.line)
    itemForm.draw(shown.form)
    main.title = shown.title
    filterLine.content = shown.filter
    filterLine.visible = shown.filter !== ""
    message.content = shown.message
    message.visible = shown.message !== ""
    titles.content = [
      ...shown.rows.map(({ title, underCursor }) => `${underCursor ? ">" : " "} ${title}`),
      ...retiredLines(shown.retired),
    ]
      .slice(windows.rows.line)
      .join("\n")
    // Each Kind after a one-column gap, so a cut title never runs into it.
    kinds.content = shown.rows
      .map(({ kind }) => ` ${kind}`)
      .slice(windows.rows.line)
      .join("\n")
    rows.visible =
      shown.detail.length === 0 && shown.log.length === 0 && shown.tokens === undefined && shown.form === undefined
    detail.content = shown.detail.slice(windows.detail.line).join("\n")
    detailBox.visible = shown.detail.length > 0
    modalArea.visible = shown.modal !== undefined
    modalText.content = shown.modal ?? ""
    modal.title = shown.modalTitle
    hints.content = shown.hints
  }

  const draw = (display: Display) =>
    Display.$match(display, {
      // Nothing Open held (a Revealed value, an issued Token, typed text) stays in a hidden renderable's buffer.
      TooSmall: ({ notice }) => {
        fillOpen(Display.blank)
        small.visible = true
        small.content = notice
        locked.visible = false
        open.visible = false
        modalArea.visible = false
        hints.visible = false
      },
      Locked: (shown) => {
        fillOpen(Display.blank)
        small.visible = false
        small.content = ""
        hints.visible = true
        locked.visible = true
        open.visible = false
        modalArea.visible = false
        promptLine.content = shown.prompt + shown.mask
        lockedNotice.content = shown.notice
        hints.content = shown.hints
      },
      Open: (shown) => {
        small.visible = false
        small.content = ""
        hints.visible = true
        locked.visible = false
        open.visible = true
        promptLine.content = ""
        lockedNotice.content = ""
        fillOpen(shown)
      },
    })

  return { draw }
}

// The reducer's view of a keypress.
const key = (event: KeyEvent): Key => ({ name: event.name, text: event.sequence, ctrl: event.ctrl, meta: event.meta })

const decoder = new TextDecoder()

// A bracketed paste's text; invalid UTF-8 becomes U+FFFD.
const pasted = (event: PasteEvent): string => decoder.decode(event.bytes)

export const Screen = { mount, key, pasted } as const
