// One keypress as the reducer sees it, decoupled from OpenTUI's `KeyEvent` so the reducer imports nothing of the
// renderer. `name` is the canonical key name ("a", "return", "backspace", "up"), `text` the characters it types.
export interface Key {
  readonly name: string
  readonly text: string
  readonly ctrl: boolean
  readonly meta: boolean
}

interface Modifiers {
  readonly ctrl?: boolean
  readonly meta?: boolean
}

// C0 controls, DEL and C1 controls never reach a prompt or a filter.
const isControl = (character: string) => {
  const point = character.codePointAt(0) ?? 0

  return point < 0x20 || (point >= 0x7f && point < 0xa0)
}

// The text a key types, or undefined for a control key or a chord with Ctrl or Meta.
const printable = (key: Key): string | undefined =>
  key.ctrl || key.meta || key.text === "" || [...key.text].some(isControl) ? undefined : key.text

// A key without text, such as "return", or a chord such as Ctrl-C (`named("c", { ctrl: true })`).
const named = (name: string, { ctrl = false, meta = false }: Modifiers = {}): Key => ({ name, text: "", ctrl, meta })

// A key that types `text`.
const char = (text: string): Key => ({ name: text, text, ctrl: false, meta: false })

// Whether `key` is `name` with exactly the given modifiers.
const is = (key: Key, name: string, { ctrl = false, meta = false }: Modifiers = {}) =>
  key.name === name && key.ctrl === ctrl && key.meta === meta

export const Key = { named, char, printable, is } as const
