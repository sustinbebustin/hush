import { Effect } from "effect"

import type { Access } from "../shared/Access.js"
import { Api, type ItemList } from "../shared/Api.js"
import { parseName } from "../shared/ApiError.js"
import type { Kind } from "../shared/Kind.js"
import { Match } from "../shared/Match.js"
import { Reference } from "../shared/Reference.js"
import { Client } from "./Client.js"
import type { Target } from "./Target.js"
import type { EnvVars } from "./LaunchEnv.js"
import { TokenStore } from "./TokenStore.js"

// `hush find` and `hush inventory`: one `items/list`, for every granted Vault or
// the one `--vault` names, then title matching and the output shapes over the metadata. No value is ever sent.

type ListedItem = ItemList["vaults"][number]["items"][number] & { readonly vault: string }

// A concealed Field's Reference, the secret `find` addresses. The Vault and Field are already part of `ref`.
export interface SecretMatch {
  readonly ref: string
  readonly title: string
  readonly kind: Kind
}

export interface FindResult {
  readonly matches: ReadonlyArray<SecretMatch & { readonly queries?: ReadonlyArray<string> }>
  readonly suggestions?: ReadonlyArray<SecretMatch & { readonly query: string }>
}

export interface Inventory {
  readonly vaults: ReadonlyArray<{ readonly vault: string; readonly access: Access }>
  readonly items: ReadonlyArray<{
    readonly title: string
    readonly vault: string
    readonly kind: Kind
    readonly createdAt: string
    readonly updatedAt: string
    readonly fields: ReadonlyArray<{ readonly label: string; readonly concealed: boolean; readonly ref: string }>
  }>
}

const byText = (a: string, b: string) => a.localeCompare(b)

// The listing carries the Server's stored display names as plain strings, so the Reference is built from them as
// sent rather than through `Reference.format`, which takes parsed Names.
const ref = (vault: string, title: string, field: string) => `${Reference.scheme}${vault}/${title}/${field}`

const itemsOf = (listing: ItemList): ReadonlyArray<ListedItem> =>
  listing.vaults.flatMap(({ vault, items }) => items.map((item) => ({ ...item, vault })))

const secretsOf = (item: ListedItem): ReadonlyArray<SecretMatch> =>
  item.fields.flatMap(({ label, concealed }) =>
    concealed ? [{ ref: ref(item.vault, item.title, label), title: item.title, kind: item.kind }] : [],
  )

// `find` over a listing: queries de-duplicated as given; a title matches a query when it holds every
// term. A query that matches nothing suggests up to three close titles instead. Each concealed Field appears once,
// with the queries it answers when several were asked; matches sorted by `ref`.
export const search = (listing: ItemList, queries: ReadonlyArray<string>): FindResult => {
  const listed = itemsOf(listing)
  const searches = [...new Set(queries)].map((query) => {
    const items = listed.filter(({ title }) => Match.matches(query, title))
    return { query, items, suggested: items.length > 0 ? [] : Match.suggest(Match.terms(query), listed) }
  })
  const matches = new Map<string, SecretMatch & { readonly queries: Array<string> }>()
  for (const { query, items } of searches)
    for (const match of items.flatMap(secretsOf)) {
      const existing = matches.get(match.ref)
      if (existing === undefined) matches.set(match.ref, { ...match, queries: [query] })
      else existing.queries.push(query)
    }
  const suggestions = searches.flatMap(({ query, suggested }) =>
    suggested.flatMap(secretsOf).map((match) => ({ query, ...match })),
  )
  return {
    matches: [...matches.values()]
      .map(({ queries: answered, ...match }) => (searches.length === 1 ? match : { ...match, queries: answered }))
      .toSorted((a, b) => byText(a.ref, b.ref)),
    ...(suggestions.length === 0 ? {} : { suggestions }),
  }
}

// Every listed Vault with its Access, by name, and every Item with all its Fields, by Vault then title.
export const catalogue = (listing: ItemList): Inventory => ({
  vaults: listing.vaults.map(({ vault, access }) => ({ vault, access })).toSorted((a, b) => byText(a.vault, b.vault)),
  items: itemsOf(listing)
    .map(({ title, vault, kind, createdAt, updatedAt, fields }) => ({
      title,
      vault,
      kind,
      createdAt,
      updatedAt,
      fields: fields.map(({ label, concealed }) => ({ label, concealed, ref: ref(vault, title, label) })),
    }))
    .toSorted((a, b) => byText(a.vault, b.vault) || byText(a.title, b.title)),
})

// One `items/list`: with `vault`, that Vault only (checked locally first), else every granted Vault.
const list = (target: Target, vault: string | undefined, env: EnvVars) =>
  Effect.gen(function* () {
    const name = vault === undefined ? undefined : yield* Effect.fromResult(parseName("vault", vault))
    const choice = yield* TokenStore.current(target, env, name)
    return yield* Client.request(
      Api,
      target,
      (client) => client.token.list({ payload: name === undefined ? {} : { vaults: [name] } }),
      choice.token,
    )
  })

export const find = (target: Target, queries: ReadonlyArray<string>, vault: string | undefined, env: EnvVars) =>
  Effect.map(list(target, vault, env), (listing) => search(listing, queries))

export const inventory = (target: Target, vault: string | undefined, env: EnvVars) =>
  Effect.map(list(target, vault, env), catalogue)

export * as Discover from "./Discover.js"
