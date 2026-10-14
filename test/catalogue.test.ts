import { assert, describe, expectTypeOf, it } from "@effect/vitest"
import { readdir, readFile } from "node:fs/promises"

import type { CliError } from "../src/cli/CliError.js"
import type { StartupError } from "../src/server/StartupError.js"
import type { ApiError } from "../src/shared/ApiError.js"
import { type ExportedTags, modules, tags } from "./catalogue.js"

// Every tag of the three error catalogues (Server, CLI, startup) is named by some test, in its title or in an
// assertion on the tag, never only in a comment.

const testDir = new URL("./", import.meta.url)

// Block and line comments removed; a `//` inside a string such as a URL is kept.
const withoutComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^((?:[^"'`\n/]|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\/(?!\/))*)\/\/.*$/gm, "$1")

const testSources = async (): Promise<ReadonlyArray<string>> => {
  const names = (await readdir(testDir)).filter((name) => name.endsWith(".test.ts") && name !== "catalogue.test.ts")

  return Promise.all(names.map(async (name) => withoutComments(await readFile(new URL(name, testDir), "utf8"))))
}

const literal = String.raw`(["'\x60])((?:\\.|(?!\1)[\s\S])*?)\1`

// Where a test's title comes from: the first argument of `it`, `test` or `describe` (with `.skip`, `.skipIf(...)`
// and the like), a table entry's `name:`, or the first element of a table row that a loop turns into titles.
const titleSources = [
  new RegExp(String.raw`\b(?:it|test|describe)\b(?:\.\w+)*(?:\([^()]*\))?\(\s*${literal}`, "g"),
  new RegExp(String.raw`\bname:\s*${literal}`, "g"),
  new RegExp(String.raw`\[\s*${literal}\s*,`, "g"),
]

const titles = (source: string): ReadonlyArray<string> =>
  titleSources.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[2] ?? ""))

// A line that asserts or expects a tag: it mentions `_tag` or a table's `tag:`.
const tagAssertions = (source: string): ReadonlyArray<string> =>
  source.split("\n").filter((line) => /\b_tag\b|\btag:/.test(line))

describe("error catalogues", () => {
  it("enumerates exactly the tags of each union", () => {
    expectTypeOf<ExportedTags<typeof modules.ApiErrors>>().toEqualTypeOf<ApiError["_tag"]>()
    expectTypeOf<ExportedTags<typeof modules.CliErrors>>().toEqualTypeOf<CliError["_tag"]>()
    expectTypeOf<ExportedTags<typeof modules.StartupErrors>>().toEqualTypeOf<StartupError["_tag"]>()

    for (const tag of ["IntegrityCheckFailed", "BackupCorrupt", "MetaInvalid"]) assert.isTrue(tags.has(tag), tag)
  })

  it("names every tag in a test title or a tag assertion", async () => {
    const sources = await testSources()
    const named = [...sources.flatMap(titles), ...sources.flatMap(tagAssertions)]
    const untested = [...tags].filter((tag) => !named.some((text) => new RegExp(`\\b${tag}\\b`).test(text)))
    assert.deepStrictEqual(untested, [], `error tags in no test title or tag assertion: ${untested.join(", ")}`)
  })

  it("does not count a tag named only in a comment", () => {
    const source = withoutComments(
      '// HostNotAllowed\n/* VaultNotFound */\nit("fetches http://x", () => {}) // ItemExists\n',
    )

    const named = [...titles(source), ...tagAssertions(source)].join("\n")
    assert.notMatch(named, /HostNotAllowed|VaultNotFound|ItemExists/)
    assert.include(named, "fetches http://x")
  })
})
