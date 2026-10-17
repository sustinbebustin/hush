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
  // The renderer was destroyed from outside the reducer: an exit signal such as SIGHUP or SIGTERM.
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
  Closed,
  Revealed,
  RevealRefused,
  RevealExpired,
  $is,
  $match,
} as const
