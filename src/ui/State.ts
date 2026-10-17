import { Data, type Redacted } from "effect"

import type { VaultList } from "../shared/Api.js"
import { Concealed } from "./Concealed.js"
import type { Problem } from "./Problem.js"
import type { Modal, View } from "./View.js"

// The UI's one state: Locked (the Passphrase prompt; holds no Passphrase) or Open (holds it as Redacted, with the
// Vaults, the view and its modals). Every transition to Locked builds a fresh Locked, so nothing Open held survives.

// Where the Locked prompt is: waiting for input, told the Passphrase was empty, checking one, or refused.
export type Phase = Data.TaggedEnum<{
  Ready: {}
  Empty: {}
  Checking: {}
  Refused: { readonly problem: Problem }
}>

const Phase = Data.taggedEnum<Phase>()

export type Vault = VaultList["vaults"][number]

// The sidebar rows below the Vaults, in order: the cursor counts the Vaults first, then these.
export type Entry = "Tokens"

const entries: ReadonlyArray<Entry> = ["Tokens"]

export type State = Data.TaggedEnum<{
  Locked: {
    readonly entered: Concealed
    readonly phase: Phase
    // Counts Passphrase submissions, so a wait tick from an earlier attempt is ignored.
    readonly attempt: number
  }
  Open: {
    readonly passphrase: Redacted.Redacted<string>
    readonly vaults: ReadonlyArray<Vault>
    // The sidebar row under the cursor.
    readonly cursor: number
    readonly view: View
    // Topmost last; keys go to the topmost modal.
    readonly modals: ReadonlyArray<Modal>
  }
}>

const { Locked, Open, $is, $match } = Data.taggedEnum<State>()

export type Locked = Extract<State, { readonly _tag: "Locked" }>

export type Open = Extract<State, { readonly _tag: "Open" }>

// A Locked UI with an empty prompt: the start, and every Lock or quit.
const locked = (attempt = 0): State => Locked({ entered: Concealed.empty, phase: Phase.Ready(), attempt })

const initial: State = locked()

// The Passphrase the state holds, if any.
const passphrase = (state: State): Redacted.Redacted<string> | undefined =>
  $is("Open")(state) ? state.passphrase : undefined

export const State = { Locked, Open, $is, $match, Phase, entries, locked, initial, passphrase } as const
