import type { Problem } from "./Problem.js"
import type { Open, State } from "./State.js"
import type { UiEffect } from "./UiEffect.js"
import { type Modal, View } from "./View.js"

// One transition's outcome: the next state and the effects to run. The reducer and its sibling transition modules
// (`Tokens`, `Vaults`) build them with these helpers, and the modal-stack moves they share.

export interface Step {
  readonly state: State
  readonly effects: ReadonlyArray<UiEffect>
}

const stay = (state: State): Step => ({ state, effects: [] })

// The state without its topmost modal.
const dismissed = (state: Open): Open => ({ ...state, modals: state.modals.slice(0, -1) })

// The state with its topmost modal replaced by `modal`.
const withTop = (state: Open, modal: Modal): Open => ({ ...state, modals: [...state.modals.slice(0, -1), modal] })

const withNotice = (state: Open, problem: Problem): Open => ({
  ...state,
  modals: [...state.modals, View.Modal.Notice({ problem })],
})

// A Confirm modal over the state, held until `y` runs `effect`.
const confirming = (state: Open, description: string, effect: UiEffect): Step =>
  stay({ ...state, modals: [...state.modals, View.Modal.Confirm({ description, effect })] })

export const Step = { stay, dismissed, withTop, withNotice, confirming } as const
