import { Match, Result } from "effect"
import { isIP } from "node:net"

import { ListenInvalid } from "./StartupError.js"

// Bind addresses: IP literals only, classified so the Server binds outside the
// loopback and tailnet ranges only with `--allow-any-listen`.

// `tailnet` is 100.64.0.0/10 and fd7a:115c:a1e0::/48, the ranges Tailscale documents for device addresses.
export type ListenClass = "loopback" | "tailnet" | "wildcard" | "other"

export interface ListenAddress {
  // As the Deployer wrote it: the Server binds and reports this exact text.
  readonly ip: string
  readonly class: ListenClass
}

const loopback: ListenAddress = { ip: "127.0.0.1", class: "loopback" }

const classifyV4 = (ip: string): ListenClass => {
  const [a, b] = ip.split(".").map(Number)

  if (ip === "0.0.0.0") return "wildcard"

  if (a === 127) return "loopback"

  return a === 100 && b !== undefined && b >= 64 && b <= 127 ? "tailnet" : "other"
}

// The colon-separated groups of one side of `::`.
const groupsOf = (part: string) => (part === "" ? [] : part.split(":"))

// The eight 16-bit groups of an IPv6 literal that `isIP` accepted and that has no zone.
const hextets = (ip: string): ReadonlyArray<number> => {
  const lastColon = ip.lastIndexOf(":")
  const last = ip.slice(lastColon + 1)
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) becomes its two groups.
  const [a = 0, b = 0, c = 0, d = 0] = last.includes(".") ? last.split(".").map(Number) : []

  const text = last.includes(".")
    ? `${ip.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
    : ip

  const [head = "", tail] = text.split("::")

  const fill =
    tail === undefined ? [] : Array.from({ length: 8 - groupsOf(head).length - groupsOf(tail).length }, () => "0")

  return [...groupsOf(head), ...fill, ...groupsOf(tail ?? "")].map((group) => Number.parseInt(group, 16))
}

// Link-local (fe80::/10), scoped and IPv4-mapped addresses are refused: none binds as a Deployer would expect.
const classifyV6 = (ip: string): ListenClass | undefined => {
  if (ip.includes("%")) return undefined
  const groups = hextets(ip)
  const startsWith = (prefix: ReadonlyArray<number>) => prefix.every((group, index) => groups[index] === group)
  const linkLocal = ((groups[0] ?? 0) & 0xffc0) === 0xfe80 // fe80::/10
  const ipv4Mapped = startsWith([0, 0, 0, 0, 0, 0xffff]) // ::ffff:0:0/96

  if (linkLocal || ipv4Mapped) return undefined

  if (startsWith([0, 0, 0, 0, 0, 0, 0, 0])) return "wildcard" // ::

  if (startsWith([0, 0, 0, 0, 0, 0, 0, 1])) return "loopback" // ::1

  return startsWith([0xfd7a, 0x115c, 0xa1e0]) ? "tailnet" : "other" // fd7a:115c:a1e0::/48
}

const parse = (source: ListenInvalid["source"], text: string): Result.Result<ListenAddress, ListenInvalid> => {
  const kind = Match.value(isIP(text)).pipe(
    Match.when(4, () => classifyV4(text)),
    Match.when(6, () => classifyV6(text)),
    Match.orElse(() => undefined),
  )

  return kind === undefined
    ? Result.fail(new ListenInvalid({ source, value: text }))
    : Result.succeed({ ip: text, class: kind })
}

// Inside the ranges that need no opt-in.
const allowed = (address: ListenAddress): boolean => address.class === "loopback" || address.class === "tailnet"

// What the Server binds, in order: 127.0.0.1 unless a wildcard replaces it, then each `--listen` address once.
// Never a wildcard that was not asked for.
const listeners = (listen: ReadonlyArray<ListenAddress>): ReadonlyArray<ListenAddress> => {
  const first = listen.some((address) => address.class === "wildcard") ? [] : [loopback]

  return [...first, ...listen].filter(
    (address, index, all) => all.findIndex((other) => other.ip === address.ip) === index,
  )
}

export const Listen = { parse, allowed, listeners } as const
