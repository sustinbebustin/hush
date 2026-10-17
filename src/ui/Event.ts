import { Data, type Redacted } from "effect"

import type { AuditQuery } from "../cli/Admin.js"
import type { AuditPage, VaultItems, VaultList } from "../shared/Api.js"
import type { Ask } from "./Audit.js"
import type { Key as Keypress } from "./Key.js"
import type { Problem } from "./Problem.js"

// Everything the reducer reacts to: input, timer ticks, the renderer closing, and the Server's answers.
export type Event = Data.TaggedEnum<{
  Key: { readonly key: Keypress }
  // Bracketed paste, decoded as UTF-8.
  Paste: { readonly text: string }
  // `vaults/list` accepted the Passphrase it carried; the answer brings it back, so Locked never holds it.
  Unlocked: { readonly passphrase: Redacted.Redacted<string>; readonly vaults: VaultList["vaults"] }
  UnlockRefused: { readonly problem: Problem }
  ItemsLoaded: { readonly list: VaultItems }
  ItemsRefused: { readonly vault: string; readonly problem: Problem }
  // The page `ask` asked for, and the query sent for it.
  AuditListed: { readonly ask: Ask; readonly query: AuditQuery; readonly page: AuditPage }
  AuditRefused: { readonly ask: Ask; readonly problem: Problem }
  // One second of a Passphrase wait passed; `attempt` is the attempt that started it, so a stale tick is ignored.
  WaitTick: { readonly attempt: number }
  // The idle clock's tick, every second for the UI's whole run: `now` is the wall clock in Unix milliseconds, so time
  // the host spent asleep counts as idle.
  IdleTick: { readonly now: number }
  // SIGTSTP from outside (Ctrl-Z itself arrives as a key, the terminal being raw): Lock, then suspend.
  Suspend: {}
  // An exit signal (SIGHUP when the terminal detaches, SIGTERM and the rest), or the renderer destroyed from outside
  // the reducer.
  Closed: {}
  // `admin/items/reveal` answered the Reveal numbered `generation` of `reference`.
  Revealed: {
    readonly reference: string
    readonly generation: number
    readonly value: Redacted.Redacted<string>
  }
  RevealRefused: { readonly reference: string; readonly generation: number; readonly problem: Problem }
  // The Revealed value numbered `generation` has been drawn long enough.
  RevealExpired: { readonly generation: number }
}>

const {
  Key,
  Paste,
  Unlocked,
  UnlockRefused,
  ItemsLoaded,
  ItemsRefused,
  AuditListed,
  AuditRefused,
  WaitTick,
  IdleTick,
  Suspend,
  Closed,
  Revealed,
  RevealRefused,
  RevealExpired,
  $is,
  $match,
} = Data.taggedEnum<Event>()

export const Event = {
  Key,
  Paste,
  Unlocked,
  UnlockRefused,
  ItemsLoaded,
  ItemsRefused,
  AuditListed,
  AuditRefused,
  WaitTick,
  IdleTick,
  Suspend,
  Closed,
  Revealed,
  RevealRefused,
  RevealExpired,
  $is,
  $match,
} as const
