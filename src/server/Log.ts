import { Console, type Effect } from "effect"

// The Server's log: one JSON object per line on stderr. Stdout carries only the startup line.
// Entries hold names, paths and statuses only, never a header, body, value, Token, Passphrase or Init code.
export type Entry =
  | { readonly event: "request"; readonly method: string; readonly path: string; readonly status: number }
  | { readonly event: "stale-snapshot-deleted"; readonly path: string }
  | { readonly event: "checkpoint-busy" }
  // A checkpoint after a committed write failed; `code` is SQLite's reason. The next one retries it.
  | { readonly event: "checkpoint-failed"; readonly code: string }
  // The path and how to read it, never the code.
  | { readonly event: "init-code-written"; readonly path: string; readonly readWith: string; readonly next: string }
  // Init committed but the file stayed; the next start deletes it.
  | { readonly event: "init-code-delete-failed"; readonly path: string; readonly code: string }
  // SQLite's code for an audit insert that failed, so the request was refused (`AuditUnavailable`).
  | { readonly event: "audit-write-failed"; readonly code: string }
  // `--allow-any-listen` is in effect, logged at every start so it is never forgotten; `addresses` are the
  // listeners outside loopback and the tailnet.
  | { readonly event: "cleartext-listen"; readonly addresses: ReadonlyArray<string>; readonly message: string }

export const write = (entry: Entry): Effect.Effect<void> => Console.error(JSON.stringify(entry))

export * as Log from "./Log.js"
