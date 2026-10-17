import { assert, describe, it } from "@effect/vitest"
import { Redacted } from "effect"

import { Event } from "../src/ui/Event.js"
import { Reducer } from "../src/ui/Reducer.js"
import { Size } from "../src/ui/Size.js"
import { State, type Vault } from "../src/ui/State.js"
import { View } from "../src/ui/View.js"

// How the sidebar and main pane settle when a fresh `vaults/list` arrives after a create or a delete.

const vault = (name: string): Vault => ({
  vault: name,
  items: 0,
  activeTokens: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
})

const open = (cursor: number, view: View, ...names: ReadonlyArray<string>): State =>
  State.Open({
    size: Size.minimum,
    passphrase: Redacted.make("right"),
    vaults: names.map(vault),
    cursor,
    view,
    modals: [],
    idle: State.Idle.Active(),
    clipboard: false,
  })

const listed = (state: State, ...names: ReadonlyArray<string>) =>
  Reducer.reduce(state, Event.VaultsListed({ vaults: names.map(vault) }))

const cursorOf = (state: State): number | undefined => (State.$is("Open")(state) ? state.cursor : undefined)

describe("the sidebar after a Vault list", () => {
  it("keeps the cursor on its Vault when another Vault appears above it, and the pane as it was", () => {
    const view = View.loading("Work")
    const step = listed(open(1, view, "Personal", "Work"), "Archive", "Personal", "Work")

    assert.strictEqual(cursorOf(step.state), 2)
    assert.deepStrictEqual(step.effects, [])
    assert.isTrue(State.$is("Open")(step.state) && step.state.view === view)
  })

  it("selects the Vault now under the cursor when the listed Vault was deleted", () => {
    const step = listed(open(0, View.loading("Personal"), "Personal", "Work"), "Work")

    assert.strictEqual(cursorOf(step.state), 0)
    assert.deepStrictEqual(
      step.effects.map(({ _tag }) => _tag),
      ["ListItems"],
    )
  })

  it("shows the empty pane when the last Vault is deleted", () => {
    const step = listed(open(0, View.loading("Personal"), "Personal"))

    assert.deepStrictEqual(step.effects, [])
    assert.isTrue(State.$is("Open")(step.state) && View.$is("NoVaults")(step.state.view))
  })

  it("opens the first Vault created on a Server that had none", () => {
    const step = listed(open(0, View.NoVaults()), "Archive")

    assert.strictEqual(cursorOf(step.state), 0)
    assert.deepStrictEqual(
      step.effects.map(({ _tag }) => _tag),
      ["ListItems"],
    )
  })

  it("keeps the cursor on its section", () => {
    const step = listed(open(2, View.loading("Personal"), "Personal", "Work"), "Personal", "Work", "Zed")

    assert.strictEqual(cursorOf(step.state), 3)
  })
})
