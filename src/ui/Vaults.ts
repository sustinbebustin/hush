import { Key } from "./Key.js"
import type { Problem } from "./Problem.js"
import type { Open, Vault } from "./State.js"
import { Step } from "./Step.js"
import { UiEffect } from "./UiEffect.js"
import { type Modal, View } from "./View.js"

// The Vault sidebar's transitions: the name prompt of a new Vault, deleting the Vault under the cursor, and the
// sidebar listed anew after either, keeping the cursor and the main pane where they still apply.

const { stay, dismissed, withTop, withNotice, confirming } = Step

type VaultNameModal = Extract<Modal, { readonly _tag: "VaultName" }>

// `c` and `d` act on the Vaults only while the sidebar has the focus: on the Item list's sidebar, or with no Vault.
const focused = (view: View): boolean =>
  View.$is("NoVaults")(view) || (View.$is("ItemList")(view) && View.Focus.$is("Sidebar")(view.focus))

// With the sidebar focused, `c` asks for a new Vault's name and `d` asks to delete the Vault under the cursor.
// Undefined for any other key, or with the focus elsewhere.
const key = (state: Open, pressed: Key): Step | undefined => {
  if (!focused(state.view)) return undefined

  if (Key.is(pressed, "c"))
    return stay({ ...state, modals: [...state.modals, View.Modal.VaultName({ text: "", phase: "editing" })] })
  const vault = state.vaults[state.cursor]

  if (!Key.is(pressed, "d") || vault === undefined) return undefined

  return confirming(
    state,
    `Delete Vault ${vault.vault}? An empty Vault is removed for good; one that still has Items or unrevoked Tokens granted to it is refused.`,
    UiEffect.DeleteVault({ passphrase: state.passphrase, vault: vault.vault }),
  )
}

// Keys in the Vault name prompt: Escape cancels it, Enter sends its one `vaults/create` (a name the CLI would refuse
// comes back as that refusal, unsent), anything else edits the name. While the request is out, nothing does anything.
const nameKey = (state: Open, top: VaultNameModal, pressed: Key): Step => {
  if (top.phase === "sending") return stay(state)
  const edit = (text: string) => stay(withTop(state, { ...top, text }))

  if (Key.is(pressed, "escape")) return stay(dismissed(state))

  if (Key.is(pressed, "return"))
    return {
      state: withTop(state, { ...top, phase: "sending" }),
      effects: [UiEffect.CreateVault({ passphrase: state.passphrase, vault: top.text })],
    }

  if (Key.is(pressed, "backspace")) return edit([...top.text].slice(0, -1).join(""))
  const typed = Key.printable(pressed)

  return typed === undefined ? stay(state) : edit(top.text + typed)
}

// A Vault request was refused: the name prompt, if it sent the request, takes keys again under the notice.
const refused = (state: Open, problem: Problem): Step => {
  const modals = state.modals.map((modal) =>
    View.Modal.$is("VaultName")(modal) ? View.Modal.VaultName({ ...modal, phase: "editing" }) : modal,
  )

  return stay(withNotice({ ...state, modals }, problem))
}

// A Vault was created or deleted: the prompt is done, and the sidebar is listed anew.
const changed = (state: Open): Step => ({
  state: { ...state, modals: state.modals.filter((modal) => !View.Modal.$is("VaultName")(modal)) },
  effects: [UiEffect.RefreshVaults({ passphrase: state.passphrase })],
})

// The Vault the main pane lists, if it lists one.
const viewedVault = (view: View): string | undefined =>
  View.$is("ItemList")(view) ? view.vault : View.$is("ItemDetail")(view) ? view.list.vault : undefined

// The sidebar with its Vaults replaced. The cursor stays on its Vault, or on its section; when its Vault is gone it
// moves to the Vault now at its row. The main pane stays unless its Vault is gone (or there was none and now is
// one), which `select`s the sidebar row under the cursor (the reducer's, as Enter does).
const listed = (state: Open, vaults: ReadonlyArray<Vault>, select: (state: Open, cursor: number) => Step): Step => {
  const was = state.vaults[state.cursor]?.vault
  const found = was === undefined ? -1 : vaults.findIndex(({ vault }) => vault === was)

  const cursor =
    was === undefined
      ? vaults.length + (state.cursor - state.vaults.length)
      : found >= 0
        ? found
        : Math.min(state.cursor, Math.max(0, vaults.length - 1))

  const next = { ...state, vaults, cursor }
  const viewed = viewedVault(state.view)
  const stale = viewed === undefined ? View.$is("NoVaults")(state.view) : !vaults.some(({ vault }) => vault === viewed)

  if (!stale) return stay(next)

  return vaults.length === 0
    ? stay({ ...next, view: View.NoVaults() })
    : select(next, Math.min(cursor, vaults.length - 1))
}

export const Vaults = { key, nameKey, refused, changed, listed } as const
