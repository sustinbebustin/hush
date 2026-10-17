import { BoxRenderable, type CliRenderer, type KeyEvent, type PasteEvent, TextRenderable } from "@opentui/core"

import { Display } from "./Display.js"
import type { Key } from "./Key.js"

// The thin sync layer: one renderable tree built once, then each `Display` copied into it. It knows OpenTUI and
// `Display`, never the reducer or the state. Layout: a Vault sidebar and the main pane side by side, a modal over
// them, a one-line key hint bar at the bottom; no gaps or decorative padding (minimum 80x24).

export interface Screen {
  readonly draw: (display: Display) => void
}

const sidebarWidth = 28
const countWidth = 5
const kindWidth = 16

// A column of text that never wraps, so each row stays on its line.
const column = (renderer: CliRenderer, options: { readonly width?: number; readonly flexGrow?: number } = {}) =>
  new TextRenderable(renderer, { content: "", wrapMode: "none", truncate: true, ...options })

const mount = (renderer: CliRenderer): Screen => {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" })

  const locked = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column", border: true, title: "hush" })
  const promptLine = column(renderer)
  const lockedNotice = new TextRenderable(renderer, { content: "", wrapMode: "word" })
  locked.add(promptLine)
  locked.add(lockedNotice)

  const open = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })

  const sidebar = new BoxRenderable(renderer, {
    width: sidebarWidth,
    flexShrink: 0,
    flexDirection: "row",
    border: true,
    title: "Vaults",
  })

  const vaultNames = column(renderer, { flexGrow: 1 })
  const vaultCounts = new TextRenderable(renderer, { content: "", width: countWidth, textAlign: "right" })
  sidebar.add(vaultNames)
  sidebar.add(vaultCounts)

  const main = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column", border: true })
  const filterLine = column(renderer)
  const rows = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
  const titles = column(renderer, { flexGrow: 1 })
  const kinds = column(renderer, { width: kindWidth })
  const message = new TextRenderable(renderer, { content: "", wrapMode: "word" })
  const detail = new TextRenderable(renderer, { content: "", wrapMode: "char" })
  rows.add(titles)
  rows.add(kinds)
  main.add(filterLine)
  main.add(message)
  main.add(rows)
  main.add(detail)
  open.add(sidebar)
  open.add(main)

  const modal = new BoxRenderable(renderer, {
    position: "absolute",
    top: "30%",
    left: "15%",
    width: "70%",
    border: true,
    title: "Notice",
    backgroundColor: "#000000",
    shouldFill: true,
  })

  const modalText = new TextRenderable(renderer, { content: "", wrapMode: "word" })
  modal.add(modalText)

  const hints = column(renderer, { flexGrow: 0 })
  root.add(locked)
  root.add(open)
  root.add(hints)
  root.add(modal)
  renderer.root.add(root)

  const draw = (display: Display) =>
    Display.$match(display, {
      Locked: (shown) => {
        locked.visible = true
        open.visible = false
        modal.visible = false
        promptLine.content = shown.prompt + shown.mask
        lockedNotice.content = shown.notice
        hints.content = shown.hints
      },
      Open: (shown) => {
        locked.visible = false
        open.visible = true
        vaultNames.content = shown.vaults
          .map(({ name, underCursor }) => `${underCursor ? ">" : " "} ${name}`)
          .join("\n")
        vaultCounts.content = shown.vaults.map(({ items }) => String(items)).join("\n")
        main.title = shown.title
        filterLine.content = shown.filter
        filterLine.visible = shown.filter !== ""
        message.content = shown.message
        message.visible = shown.message !== ""
        titles.content = shown.rows.map(({ title, underCursor }) => `${underCursor ? ">" : " "} ${title}`).join("\n")
        kinds.content = shown.rows.map(({ kind }) => kind).join("\n")
        rows.visible = shown.detail.length === 0
        detail.content = shown.detail.join("\n")
        detail.visible = shown.detail.length > 0
        modal.visible = shown.modal !== undefined
        modalText.content = shown.modal ?? ""
        hints.content = shown.hints
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
