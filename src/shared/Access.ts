import type { Name } from "./Name.js"

const all = ["read", "read+create"] as const

// What a Token may do in a granted Vault: read, or also create new Items with `read+create`.
export type Access = (typeof all)[number]

export const Access = {
  all,
  allowsCreate: (access: Access): boolean => access === "read+create",
} as const

// One Vault a Token is granted, by its stored display name (ADR-0007).
export type Grant = { readonly vault: Name; readonly access: Access }
