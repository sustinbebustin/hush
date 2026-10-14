import { assert, describe, it } from "@effect/vitest"
import * as fc from "fast-check"

import { Discover } from "../src/cli/Discover.js"
import { Match } from "../src/shared/Match.js"

// The listing the matching cases run over.
const items = [
  { ref: "hush://Personal/Cloud API/credential", title: "Cloud API" },
  { ref: "hush://Work/Cloud Login/password", title: "Cloud Login" },
  { ref: "hush://Work/Database/password", title: "Database" },
]

const matching = (query: string) => items.filter(({ title }) => Match.matches(query, title)).map(({ ref }) => ref)

describe("Match.matches", () => {
  it("matches titles containing every term of a query, case-insensitively", () => {
    assert.deepStrictEqual(matching("database"), ["hush://Work/Database/password"])
    assert.deepStrictEqual(matching("cloud api"), ["hush://Personal/Cloud API/credential"])
    assert.deepStrictEqual(matching("CLOUD"), [
      "hush://Personal/Cloud API/credential",
      "hush://Work/Cloud Login/password",
    ])
    assert.deepStrictEqual(matching("databse"), [])
  })
})

describe("Match.suggest", () => {
  it("suggests close titles for a typo", () => {
    assert.deepStrictEqual(Match.suggest(Match.terms("databse"), items), [
      { ref: "hush://Work/Database/password", title: "Database" },
    ])
  })

  it("suggests nothing for a query unlike every title", () => {
    assert.deepStrictEqual(Match.suggest(Match.terms("nothing like this"), items), [])
  })

  it("keeps at most three suggestions, closest first, ties by title", () => {
    const candidates = ["Stripe Key E", "Stripe Key D", "Stripe Key C", "Stripe Key B", "Stripe"].map((title) => ({
      title,
    }))

    assert.deepStrictEqual(
      Match.suggest(Match.terms("strpe"), candidates).map(({ title }) => title),
      ["Stripe", "Stripe Key B", "Stripe Key C"],
    )
  })
})

// Matching cases over the same listing, as `items/list` returns it.
const meta = (title: string, kind: "api-credential" | "login" | "database") => ({
  title,
  kind,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  fields: [
    { label: kind === "api-credential" ? "credential" : "password", concealed: true },
    { label: "notes", concealed: false },
  ],
})

const listing = {
  vaults: [
    { vault: "Personal", access: "read+create", items: [meta("Cloud API", "api-credential")] },
    { vault: "Work", access: "read", items: [meta("Cloud Login", "login"), meta("Database", "database")] },
  ],
} as const

describe("Discover.search", () => {
  it("lists each concealed Field once, with the queries it answers", () => {
    assert.deepStrictEqual(Discover.search(listing, ["database", "cloud api", "cloud"]), {
      matches: [
        {
          ref: "hush://Personal/Cloud API/credential",
          title: "Cloud API",
          kind: "api-credential",
          queries: ["cloud api", "cloud"],
        },
        { ref: "hush://Work/Cloud Login/password", title: "Cloud Login", kind: "login", queries: ["cloud"] },
        { ref: "hush://Work/Database/password", title: "Database", kind: "database", queries: ["database"] },
      ],
    })
  })

  it("suggests close titles for a miss within the same batch", () => {
    assert.deepStrictEqual(Discover.search(listing, ["databse", "nothing like this"]), {
      matches: [],
      suggestions: [{ query: "databse", ref: "hush://Work/Database/password", title: "Database", kind: "database" }],
    })
  })

  it("lists a single query's matches without repeating the query", () => {
    assert.deepStrictEqual(Discover.search(listing, ["database"]), {
      matches: [{ ref: "hush://Work/Database/password", title: "Database", kind: "database" }],
    })
  })

  it("keeps queries that differ only in case apart: queries are de-duplicated by exact string", () => {
    assert.deepStrictEqual(Discover.search(listing, ["Database", "database", "Database"]).matches, [
      {
        ref: "hush://Work/Database/password",
        title: "Database",
        kind: "database",
        queries: ["Database", "database"],
      },
    ])
  })
})

describe("Match.closeness", () => {
  it("scores a contained word 1 and an unrelated one below the threshold", () => {
    assert.strictEqual(Match.closeness(["data"], "Database"), 1)
    assert.isBelow(Match.closeness(["zzzz"], "Database"), 0.6)
  })

  it("scores a typo by edit distance over the longer word", () => {
    // kitten -> sitting is the textbook Levenshtein distance of 3.
    assert.closeTo(Match.closeness(["kitten"], "Sitting"), 1 - 3 / 7, 1e-12)
    assert.closeTo(Match.closeness(["databse"], "Database"), 1 - 1 / 8, 1e-12)
  })

  it("is 0 for no terms", () => {
    assert.strictEqual(Match.closeness([], "Database"), 0)
  })

  it("always lies between 0 and 1", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 })), fc.string(), (terms, title) => {
        const score = Match.closeness(terms, title)

        return score >= 0 && score <= 1
      }),
    )
  })
})
