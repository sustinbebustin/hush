// The leak scanner: which sentinel kinds each observable target is scanned for.
// Some targets must hold some secrets (the token file holds the saved Token, the database its hash and wraps),
// so the scan is per target rather than one flat list.

export type LeakTarget = "cli" | "server" | "proxy" | "audit" | "config" | "database" | "tokenFile"

export type SentinelKind = "value" | "passphrase" | "token" | "initCode" | "proxyUserinfo" | "envLine"

export interface Sentinel {
  readonly kind: SentinelKind
  readonly text: string
}

export interface Observed {
  readonly target: LeakTarget
  readonly text: string
}

export interface Leak {
  readonly target: LeakTarget
  readonly sentinel: Sentinel
}

const everything: ReadonlySet<SentinelKind> = new Set([
  "value",
  "passphrase",
  "token",
  "initCode",
  "proxyUserinfo",
  "envLine",
])

const scannedFor: Record<LeakTarget, ReadonlySet<SentinelKind>> = {
  cli: everything,
  server: everything,
  proxy: everything,
  audit: everything,
  config: everything,
  database: new Set(["value", "passphrase", "token", "initCode"]),
  tokenFile: new Set(["value", "passphrase", "initCode"]),
}

// A fictional secret with quotes, a backslash, a newline and non-ASCII, so escaping bugs show up as leaks.
export const valueSentinel: Sentinel = { kind: "value", text: 'fictional-only-"credential"-\\-line\nsecond-line-é' }

export const passphraseSentinel: Sentinel = { kind: "passphrase", text: "fictional passphrase sentinel 7Qx" }

// The raw text and its JSON-escaped form, since most targets hold JSON.
const forms = (text: string): ReadonlyArray<string> => [text, JSON.stringify(text).slice(1, -1)]

export const scan = (observed: ReadonlyArray<Observed>, sentinels: ReadonlyArray<Sentinel>): ReadonlyArray<Leak> =>
  observed.flatMap(({ target, text }) =>
    sentinels
      .filter((sentinel) => scannedFor[target].has(sentinel.kind))
      .filter((sentinel) => forms(sentinel.text).some((form) => text.includes(form)))
      .map((sentinel) => ({ target, sentinel })),
  )
