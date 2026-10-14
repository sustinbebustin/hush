import { assert, describe, it } from "@effect/vitest"
import { readFile } from "node:fs/promises"

import { tags } from "./catalogue.js"
import { checkInvocations, invocations, isPositional, snippets } from "./commands.js"

// skills/hush/SKILL.md, which agents load, names only commands, flags and error tags the CLI has.

const skill = await readFile(new URL("../skills/hush/SKILL.md", import.meta.url), "utf8")

// A backticked CamelCase word of two or more parts, as error tags are written.
const errorTags = (markdown: string) =>
  [...new Set(snippets(markdown))].filter((span) => /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(span))

describe("skills/hush/SKILL.md", () => {
  it("has the hush frontmatter and triggers", () => {
    assert.match(
      skill,
      /^---\nname: hush\ndescription: [^\n]*password[^\n]*API key[^\n]*\.env files\.\n[\s\S]*?^---\n/m,
    )
  })

  it("names every command an agent uses", () => {
    const named = new Set(invocations(skill).map(({ args }) => args.filter(isPositional).slice(0, 2).join(" ")))
    for (const command of [
      "find",
      "inventory",
      "run",
      "env write",
      "env run",
      "env resolve",
      "create api-credential",
      "read",
      "token status",
      "doctor",
    ])
      assert.isTrue(
        [...named].some((name) => name === command || name.startsWith(`${command} `)),
        `skill never shows \`hush ${command}\``,
      )
  })

  it("names only commands and flags the CLI implements", async () => {
    assert.isNotEmpty(await checkInvocations(skill))
  })

  it("names only error tags of the error catalogues", () => {
    const named = errorTags(skill)
    assert.isNotEmpty(named)
    for (const tag of named) assert.isTrue(tags.has(tag), `${tag} is in no error catalogue`)
  })

  it("keeps none of the 1Password text of the skill it was adapted from", () => {
    for (const gone of ["op://", "service-account", "2password", "hush password", "--account", "--desktop"])
      assert.notInclude(skill, gone)
  })
})
