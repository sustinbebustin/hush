import { Data, type Redacted } from "effect"

import type { VaultList } from "../shared/Api.js"
import { Concealed } from "./Concealed.js"
import type { Problem } from "./Problem.js"
import { Size } from "./Size.js"
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

// How long an Open UI has gone without a keypress, as the idle clock's ticks saw it: a key since the last tick (or
// none yet since it opened), or none since the tick at `since` (Unix milliseconds). Keys carry no time, so the idle
// time starts at the first tick after the last key: the UI never locks early, and late by at most one tick.
export type Idle = Data.TaggedEnum<{
  Active: {}
  Since: { readonly since: number }
}>

const Idle = Data.taggedEnum<Idle>()

// How long an Open UI goes without a keypress before it Locks: ten minutes, the figure ADR-0010 sets.
const idleLimitMillis = 10 * 60 * 1_000

export type Vault = VaultList["vaults"][number]

export type State = Data.TaggedEnum<{
  Locked: {
    readonly entered: Concealed
    readonly phase: Phase
    // Counts Passphrase submissions, so a wait tick or an answer from an earlier attempt is ignored.
    readonly attempt: number
    readonly size: Size
  }
  Open: {
    readonly size: Size
    readonly passphrase: Redacted.Redacted<string>
    readonly vaults: ReadonlyArray<Vault>
    // The sidebar row under the cursor.
    readonly cursor: number
    readonly view: View
    // Topmost last; keys go to the topmost modal.
    readonly modals: ReadonlyArray<Modal>
    readonly idle: Idle
    // Whether the host has a clipboard: the paste key is offered only then.
    readonly clipboard: boolean
  }
}>

const { Locked, Open, $is, $match } = Data.taggedEnum<State>()

export type Locked = Extract<State, { readonly _tag: "Locked" }>

export type Open = Extract<State, { readonly _tag: "Open" }>

// A Locked UI with an empty prompt: the start, and every Lock or quit. It keeps only the attempt count and the
// terminal's size.
const locked = (attempt = 0, size: Size = Size.minimum): Locked =>
  Locked({ entered: Concealed.empty, phase: Phase.Ready(), attempt, size })

const initial: State = locked()

// The Passphrase the state holds, if any.
const passphrase = (state: State): Redacted.Redacted<string> | undefined =>
  $is("Open")(state) ? state.passphrase : undefined

export const State = { Locked, Open, $is, $match, Phase, Idle, idleLimitMillis, locked, initial, passphrase } as const
