import { Data, type Redacted } from "effect"

import type { TokenList, VaultItems, VaultList } from "../shared/Api.js"
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
  TokensLoaded: { readonly list: TokenList }
  TokensRefused: { readonly problem: Problem }
  TokenRevoked: { readonly label: string }
  RevokeRefused: { readonly problem: Problem }
  // One second of a Passphrase wait passed; `attempt` is the attempt that started it, so a stale tick is ignored.
  WaitTick: { readonly attempt: number }
  // The renderer was destroyed from outside the reducer: an exit signal such as SIGHUP or SIGTERM.
  Closed: {}
}>

const { Key, Paste, Unlocked, UnlockRefused, ItemsLoaded, ItemsRefused, WaitTick, Closed, $is, $match } =
  Data.taggedEnum<Event>()

const { TokensLoaded, TokensRefused, TokenRevoked, RevokeRefused } = Data.taggedEnum<Event>()

export const Event = {
  Key,
  Paste,
  Unlocked,
  UnlockRefused,
  ItemsLoaded,
  ItemsRefused,
  TokensLoaded,
  TokensRefused,
  TokenRevoked,
  RevokeRefused,
  WaitTick,
  Closed,
  $is,
  $match,
} as const
