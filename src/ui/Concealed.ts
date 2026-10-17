import { Redacted } from "effect"

// Concealed input owned by the UI's state, never by an OpenTUI `Input` (which cannot mask): the characters typed so
// far, Redacted so no log or inspection prints them. The screen draws only `length`, as a mask.
export interface Concealed {
  readonly value: Redacted.Redacted<string>
  // In code points, so the mask has one cell per character typed.
  readonly length: number
}

const of = (text: string): Concealed => ({ value: Redacted.make(text), length: [...text].length })

const empty: Concealed = of("")

const append = (concealed: Concealed, text: string): Concealed => of(Redacted.value(concealed.value) + text)

// Without its last code point; empty stays empty.
const backspace = (concealed: Concealed): Concealed => of([...Redacted.value(concealed.value)].slice(0, -1).join(""))

export const Concealed = { empty, append, backspace } as const
