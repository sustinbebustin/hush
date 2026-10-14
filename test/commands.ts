import { assert } from "@effect/vitest"

import { cli } from "./sandbox.js"

// The `hush` commands a Markdown document shows, checked against the CLI's `--help`.

// Every inline code span and every line of a fenced block.
export const snippets = (markdown: string): ReadonlyArray<string> => {
  const fenced = [...markdown.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].flatMap(([, body]) => (body ?? "").split("\n"))
  const prose = markdown.replace(/^```[a-z]*\n[\s\S]*?^```$/gm, "")
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span ?? "")

  return [...fenced, ...inline]
}

// Shell words of one snippet, quotes removed, a `#` comment dropped; `|`, `&&` and `;` are their own words.
const words = (snippet: string): ReadonlyArray<string> => {
  const found: Array<string> = []

  for (const [word] of snippet.matchAll(/"[^"]*"|'[^']*'|\|\||&&|[|;]|[^\s|;"']+/g)) {
    if (word.startsWith("#")) break
    found.push(word.replace(/^["']|["']$/g, ""))
  }

  return found
}

export interface Invocation {
  readonly snippet: string
  // Everything after `hush` up to the end of its pipeline stage, and before `--`.
  readonly args: ReadonlyArray<string>
}

const separators = new Set(["|", "||", "&&", ";"])

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)

// The index after `from` and every option word at it; `-u` and `-g` (sudo's) take a value.
const skipOptions = (all: ReadonlyArray<string>, from: number): number => {
  let index = from

  for (let word = all[index]; word?.startsWith("-") === true && word !== "--"; word = all[index])
    index += word === "-u" || word === "-g" ? 2 : 1

  return index
}

// The argument lists of every `hush` run in command position: first in a pipeline stage, after variable
// assignments and `sudo` or `exec`, or as the command of `docker exec <container>`, `pct exec <id> --`,
// `ssh <host>` and `sh -c '...'`. Other commands, and `hush` as a mere argument (a container or user name), are
// skipped.
const commandArgs = (all: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
  const found: Array<ReadonlyArray<string>> = []
  let index = 0
  let atCommand = true

  while (index < all.length) {
    const word = all[index] ?? ""
    const next = all[index + 1]

    if (separators.has(word)) {
      atCommand = true
      index += 1
    } else if (!atCommand) index += 1
    else if (isAssignment(word) || word === "exec") index += 1
    else if (word === "sudo") index = skipOptions(all, index + 1)
    else if (word === "docker" && next === "exec") index = skipOptions(all, index + 2) + 1
    else if (word === "ssh") index = skipOptions(all, index + 1) + 1
    else if (word === "pct" && next === "exec") {
      const end = all.indexOf("--", index)
      index = end === -1 ? all.length : end + 1
    } else if ((word === "sh" || word.endsWith("/sh")) && next === "-c") {
      found.push(...commandArgs(words(all[index + 2] ?? "")))
      atCommand = false
      index += 3
    } else {
      if (word === "hush" || word.endsWith("/hush")) {
        const rest = all.slice(index + 1)
        const end = rest.findIndex((arg) => separators.has(arg) || arg === "--")
        found.push(end === -1 ? rest : rest.slice(0, end))
      }

      atCommand = false
      index += 1
    }
  }

  return found
}

export const invocations = (markdown: string): ReadonlyArray<Invocation> =>
  snippets(markdown).flatMap((snippet) => commandArgs(words(snippet)).map((args) => ({ snippet, args })))

type FlagShape = "switch" | "valued"

interface Help {
  readonly subcommands: ReadonlyArray<string>
  readonly flags: ReadonlyMap<string, FlagShape>
}

// The names in the `SUBCOMMANDS` section and the leading `--flag` of each line of `FLAGS` and `GLOBAL FLAGS` in
// effect/cli's help, `valued` when a type such as `string` follows it.
const parseHelp = (text: string): Help => {
  const section = (title: string) => {
    const match = new RegExp(`^${title}\\n((?:  .*\\n?)*)`, "m").exec(text)

    return (match?.[1] ?? "").split("\n").filter((line) => line.trim() !== "")
  }

  return {
    subcommands: section("SUBCOMMANDS").flatMap((line) => /^ {2}(\S+)/.exec(line)?.[1] ?? []),
    flags: new Map(
      [...section("FLAGS"), ...section("GLOBAL FLAGS")].flatMap((line): ReadonlyArray<[string, FlagShape]> => {
        const match = /^ {2}(--[a-z-]+)(?:, -[a-z])?( [a-z]+)? {2}/.exec(line)

        return match?.[1] === undefined ? [] : [[match[1], match[2] === undefined ? "switch" : "valued"]]
      }),
    ),
  }
}

// A subcommand or positional argument: not a flag, a `<placeholder>` or `...`.
export const isPositional = (arg: string) => !arg.startsWith("-") && !arg.startsWith("<") && arg !== "..."

const flagName = (arg: string) => arg.split("=")[0] ?? arg

// Fails unless every invocation names subcommands, implemented, and flags that `hush ... --help` lists. Returns
// the subcommand paths it saw, so a caller can check the document was read at all.
export const checkInvocations = async (markdown: string): Promise<ReadonlyArray<string>> => {
  const box = await cli()

  try {
    const helps = new Map<string, Help>()

    const help = async (path: ReadonlyArray<string>) => {
      const key = path.join(" ")
      const known = helps.get(key)

      if (known !== undefined) return known
      const result = await box.run([...path, "--help"])
      assert.strictEqual(result.code, 0, `hush ${key} --help failed: ${result.stderr}`)
      const parsed = parseHelp(result.stdout)
      helps.set(key, parsed)

      return parsed
    }

    // A help layout `parseHelp` no longer reads would otherwise pass every snippet vacuously.
    assert.include((await help([])).subcommands, "find")
    assert.strictEqual((await help(["find"])).flags.get("--vault"), "valued")
    assert.strictEqual((await help(["init"])).flags.get("--print"), "switch")
    const paths: Array<string> = []

    for (const { snippet, args } of invocations(markdown)) {
      const path: Array<string> = []

      // Each flag belongs to the command it follows; a valued flag's argument is never a subcommand.
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? ""
        const { subcommands, flags } = await help(path)

        if (arg.startsWith("--")) {
          const shape = flags.get(flagName(arg))
          assert.isDefined(shape, `\`${snippet}\`: \`hush ${path.join(" ")}\` has no flag ${flagName(arg)}`)

          if (shape === "valued" && !arg.includes("=")) index += 1
        } else if (isPositional(arg) && subcommands.length > 0) {
          assert.include(subcommands, arg, `\`${snippet}\`: \`hush ${path.join(" ")}\` has no subcommand ${arg}`)
          path.push(arg)
        }
      }

      paths.push(path.join(" "))
    }

    return paths
  } finally {
    await box.close()
  }
}
