import { Data, type Redacted } from "effect"

import type { Event } from "./Event.js"

// What the reducer asks the interpreter to do. Each request carries the Passphrase it is sent with, so the state
// that asked for it need not hold it (Locked never does).
export type UiEffect = Data.TaggedEnum<{
  // `admin/vaults/list`: the unlock check and the sidebar in one request (no preflight).
  ListVaults: { readonly passphrase: Redacted.Redacted<string> }
  // `admin/items/list` for one Vault.
  ListItems: { readonly passphrase: Redacted.Redacted<string>; readonly vault: string }
  // `event` after `millis`.
  After: { readonly millis: number; readonly event: Event }
  // Destroy the renderer and end the UI.
  Quit: {}
  // Suspend the renderer (restoring the terminal) and stop the process; on SIGCONT, resume the renderer.
  Suspend: {}
}>

const { ListVaults, ListItems, After, Quit, Suspend, $is, $match } = Data.taggedEnum<UiEffect>()

export const UiEffect = { ListVaults, ListItems, After, Quit, Suspend, $is, $match } as const
