import { Data, type Redacted } from "effect"

import type { Ask } from "./Audit.js"
import type { Event } from "./Event.js"
import type { IssueFields } from "./IssueForm.js"

// What the reducer asks the interpreter to do. Each request carries the Passphrase it is sent with, so the state
// that asked for it need not hold it (Locked never does).
export type UiEffect = Data.TaggedEnum<{
  // `admin/vaults/list`: the unlock check and the sidebar in one request (no preflight).
  ListVaults: { readonly passphrase: Redacted.Redacted<string> }
  // `admin/items/list` for one Vault.
  ListItems: { readonly passphrase: Redacted.Redacted<string>; readonly vault: string }
  // One `admin/audit` page.
  ListAudit: { readonly passphrase: Redacted.Redacted<string>; readonly ask: Ask }
  // `admin/tokens/list`.
  ListTokens: { readonly passphrase: Redacted.Redacted<string> }
  // `admin/tokens/revoke` for one Label.
  RevokeToken: { readonly passphrase: Redacted.Redacted<string>; readonly label: string }
  // `admin/tokens/issue`, once.
  IssueToken: { readonly passphrase: Redacted.Redacted<string>; readonly fields: IssueFields }
  // The issued Token onto the host clipboard.
  CopyToken: { readonly token: Redacted.Redacted<string> }
  // `event` after `millis`.
  After: { readonly millis: number; readonly event: Event }
  // Destroy the renderer and end the UI.
  Quit: {}
  // Suspend the renderer (restoring the terminal) and stop the process; on SIGCONT, resume the renderer.
  Suspend: {}
  // `admin/items/reveal` of one Field; `generation` comes back with the answer.
  Reveal: { readonly passphrase: Redacted.Redacted<string>; readonly reference: string; readonly generation: number }
}>

const { ListVaults, ListItems, ListAudit, After, Quit, Suspend, Reveal, $is, $match } = Data.taggedEnum<UiEffect>()

const { ListTokens, RevokeToken, IssueToken, CopyToken } = Data.taggedEnum<UiEffect>()

export const UiEffect = {
  ListVaults,
  ListItems,
  ListAudit,
  ListTokens,
  RevokeToken,
  IssueToken,
  CopyToken,
  After,
  Quit,
  Suspend,
  Reveal,
  $is,
  $match,
} as const
