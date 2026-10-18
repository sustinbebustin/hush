import { Data, type Redacted } from "effect"

import type { AuditQuery } from "../cli/Admin.js"
import type {
  AuditPage,
  ItemCreateReceipt,
  ItemEditReceipt,
  ItemRenamed,
  TokenIssueReceipt,
  TokenList,
  VaultItems,
  VaultList,
} from "../shared/Api.js"
import type { Ask } from "./Audit.js"
import type { Pasted, Written } from "./Clipboard.js"
import type { Key as Keypress } from "./Key.js"
import type { Problem } from "./Problem.js"

// Everything the reducer reacts to: input, timer ticks, the renderer closing, and the Server's answers.
export type Event = Data.TaggedEnum<{
  Key: { readonly key: Keypress }
  // Bracketed paste, decoded as UTF-8.
  Paste: { readonly text: string }
  // `vaults/list` accepted the Passphrase it carried; the answer brings it back, so Locked never holds it.
  // `clipboard` says whether the host has a clipboard, so the paste key is offered only where it can work.
  // `attempt` is the submission it answers, so an answer to one made before a Lock is dropped.
  Unlocked: {
    readonly attempt: number
    readonly passphrase: Redacted.Redacted<string>
    readonly vaults: VaultList["vaults"]
    readonly clipboard: boolean
  }
  UnlockRefused: { readonly attempt: number; readonly problem: Problem }
  // The terminal's new size, in cells.
  Resize: { readonly width: number; readonly height: number }
  ItemsLoaded: { readonly list: VaultItems }
  ItemsRefused: { readonly vault: string; readonly problem: Problem }
  // The page `ask` asked for, and the query sent for it.
  AuditListed: { readonly ask: Ask; readonly query: AuditQuery; readonly page: AuditPage }
  AuditRefused: { readonly ask: Ask; readonly problem: Problem }
  TokensLoaded: { readonly list: TokenList }
  TokensRefused: { readonly problem: Problem }
  TokenRevoked: { readonly label: string }
  RevokeRefused: { readonly problem: Problem }
  // `tokens/issue` answered; `copyable` says whether the host has a clipboard to copy the Token to.
  TokenIssued: { readonly receipt: TokenIssueReceipt; readonly copyable: boolean }
  IssueRefused: { readonly problem: Problem }
  TokenCopied: { readonly written: Written }
  // `vaults/create` or `vaults/delete` succeeded: the sidebar is stale.
  VaultChanged: {}
  // A Vault request, or the refresh after it, was refused.
  VaultRefused: { readonly problem: Problem }
  // The sidebar's Vaults, freshly listed.
  VaultsListed: { readonly vaults: VaultList["vaults"] }
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
  // `admin/items/create` answered with `verified: true`.
  ItemCreated: { readonly receipt: ItemCreateReceipt }
  // `admin/items/edit` answered with `verified: true`.
  ItemEdited: { readonly receipt: ItemEditReceipt }
  // The Item form's write was refused before sending (a CLI check) or by the Server, or may not have happened.
  ItemSaveRefused: { readonly problem: Problem }
  // The host clipboard's answer to the paste key.
  ClipboardRead: { readonly pasted: Pasted }
  // `admin/items/rename` answered, with the old and new Reference of every Field.
  Renamed: { readonly receipt: ItemRenamed }
  // `admin/items/delete` or `admin/items/release` changed `vault`'s Items or Retired titles.
  ItemsChanged: { readonly vault: string }
  // A rename, delete or release refused.
  ChangeRefused: { readonly problem: Problem }
  // An Open UI's request refused for its Passphrase (changed elsewhere) or by the backoff: the UI Locks.
  PassphraseRejected: { readonly problem: Problem }
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

const { TokensLoaded, TokensRefused, TokenRevoked, RevokeRefused, TokenIssued, IssueRefused, TokenCopied } =
  Data.taggedEnum<Event>()

const { ItemCreated, ItemEdited, ItemSaveRefused, ClipboardRead } = Data.taggedEnum<Event>()

const { Renamed, ItemsChanged, ChangeRefused } = Data.taggedEnum<Event>()

const { VaultChanged, VaultRefused, VaultsListed } = Data.taggedEnum<Event>()

const { Resize, PassphraseRejected } = Data.taggedEnum<Event>()

export const Event = {
  Resize,
  PassphraseRejected,
  VaultChanged,
  VaultRefused,
  VaultsListed,
  Key,
  Paste,
  Unlocked,
  UnlockRefused,
  ItemsLoaded,
  ItemsRefused,
  AuditListed,
  AuditRefused,
  TokensLoaded,
  TokensRefused,
  TokenRevoked,
  RevokeRefused,
  TokenIssued,
  IssueRefused,
  TokenCopied,
  WaitTick,
  IdleTick,
  Suspend,
  Closed,
  Revealed,
  RevealRefused,
  RevealExpired,
  ItemCreated,
  ItemEdited,
  ItemSaveRefused,
  ClipboardRead,
  Renamed,
  ItemsChanged,
  ChangeRefused,
  $is,
  $match,
} as const
