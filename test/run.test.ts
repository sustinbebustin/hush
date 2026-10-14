import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { cli, onPty, sandbox, type Sandbox, seedPassphrase } from "./sandbox.js"

// `hush run`, `hush env run|write|resolve`: injection asserted by the child's exit code, never
// by printing a value, unless the test expects masking.

const value = valueSentinel.text

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in.
const withSandbox = async (test: (box: Sandbox, seen: (sentinel: Sentinel) => void) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, passphraseSentinel]
  try {
    await test(box, (sentinel) => sentinels.push(sentinel))
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

// `seed` with the Item `Key` holding `value`, its Token and Init code registered as sentinels.
const seeded = async (box: Sandbox, seen: (sentinel: Sentinel) => void, spec?: Parameters<Sandbox["seed"]>[0]) => {
  const code = await box.server.initCode()
  if (code !== undefined) seen({ kind: "initCode", text: code })
  const result = await box.seed(spec ?? { items: [{ kind: "api-credential", title: "Key", value }] })
  seen({ kind: "token", text: result.token })
  return result
}

const call = (path: string, status: number) => ({ method: "POST", path, status })
const resolved = [call("/v1/secrets/resolve", 200)]
const key = "hush://Personal/Key/credential"
const concealed = "<concealed by hush>"

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())
const auditCount = async (box: Sandbox) => (await rows(box, "SELECT id FROM audit")).length
// The audit rows after the first `count`, as action, References and outcome.
const auditSince = async (box: Sandbox, count: number) =>
  (await rows(box, "SELECT action, refs, outcome FROM audit ORDER BY id")).slice(count)

describe("hush run", () => {
  it("injects the value intact in one secrets/resolve, with the Init-saved Token and no Passphrase", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      // The expected value reaches the child through the launch environment, so nothing prints it.
      const result = await box.run(["run", "--env", `X=${key}`, "--", "sh", "-c", 'test "$X" = "$EXPECTED"'], {
        env: { EXPECTED: value },
      })
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, resolved)
    }))

  it("strips HUSH_TOKEN from the child", () =>
    withSandbox(async (box, seen) => {
      const { token } = await seeded(box, seen)
      const result = await box.run(["run", "--env", `X=${key}`, "--", "sh", "-c", 'test -z "${HUSH_TOKEN+x}"'], {
        env: { HUSH_TOKEN: token },
      })
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, resolved)
    }))

  it("keeps HUSH_SERVER and the launch proxy variables on the direct route", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const script =
        'test "$HUSH_SERVER" = "$EXPECTED_SERVER" && test "$NO_PROXY" = keep.example && test "$HTTP_PROXY" = http://proxy.example:3128'
      const result = await box.run(["run", "--env", `X=${key}`, "--", "sh", "-c", script], {
        env: { EXPECTED_SERVER: box.server.url, NO_PROXY: "keep.example", HTTP_PROXY: "http://proxy.example:3128" },
      })
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, resolved)
    }))

  it("passes the argv through unchanged, without a shell", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      // Each argument is compared with its copy in the environment, which no shell expanded either.
      const script =
        'test "$#" = 5 && test "$1" = "$E1" && test "$2" = "$E2" && test "$3" = "$E3" && test -z "$4" && test "$5" = "$E5"'
      const result = await box.run(
        ["run", "--env", `X=${key}`, "--", "sh", "-c", script, "sh", "a b", "c'd", "$HOME", "", "*"],
        { env: { E1: "a b", E2: "c'd", E3: "$HOME", E5: "*" } },
      )
      assert.strictEqual(result.code, 0, result.stderr)
    }))

  it("passes the child's exit code through", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await box.run(["run", "--env", `X=${key}`, "--", "sh", "-c", "exit 7"])
      assert.strictEqual(result.code, 7)
      assert.strictEqual(result.stderr, "")
    }))

  it("reports a signalled child as ChildSignalled naming the signal, with exit 1", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await box.run(["run", "--env", `X=${key}`, "--", "sh", "-c", "kill -TERM $$"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: sh was killed by signal SIGTERM before it exited, so its result is unknown.\n",
      )
    }))

  it("reports a missing executable as ChildNotFound after resolving", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await box.run(["run", "--env", `X=${key}`, "--", "no-such-tool", "--flag"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: Could not start no-such-tool: not found; nothing was run (secrets were resolved but not exposed).\n",
      )
      assert.deepStrictEqual(result.calls, resolved)
    }))

  it("injects one Reference under two names with it sent once, and audits one secrets.resolve row", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await auditCount(box)
      const result = await box.run(
        [
          "run",
          "--env",
          `A=${key}`,
          "--env",
          `B=${key}`,
          "--",
          "sh",
          "-c",
          'test "$A" = "$EXPECTED" && test "$B" = "$A"',
        ],
        { env: { EXPECTED: value } },
      )
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, resolved)
      assert.deepStrictEqual(await auditSince(box, before), [
        { action: "secrets.resolve", refs: JSON.stringify([key]), outcome: "ok" },
      ])
    }))

  it("refuses an assignment that is not NAME=hush://... with InvalidAssignment, before any request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      for (const [assignment, reason] of [
        ["X=plaintext", "the Reference is invalid: scheme"],
        ["X=op://Personal/Key/credential", "the value is a 1Password reference; replace `op://` with `hush://`"],
        ["1X=hush://Personal/Key/credential", "expected a variable name, `=` and a Reference"],
      ] as const) {
        const result = await box.run(["run", "--env", assignment, "--", "sh", "-c", "echo spawned"])
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(
          result.stderr,
          `hush: Assignment 1 is not NAME=hush://Vault/Item/field (${reason}); nothing was read or run.\n`,
        )
        assert.deepStrictEqual(result.calls, [])
      }
    }))

  it("refuses a pasted secret as an assignment with InvalidAssignment, naming its position and never its text", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      for (const assignment of [`X=${value}`, value, `${value}==`]) {
        const run = await box.run(["run", "--env", `A=${key}`, "--env", assignment, "--", "sh", "-c", "echo spawned"])
        const write = await box.run(["env", "write", join(box.home, ".env.tpl"), `A=${key}`, assignment])
        for (const result of [run, write]) {
          assert.strictEqual(result.code, 1)
          assert.strictEqual(result.stdout, "")
          assert.match(result.stderr, /^hush: Assignment 2 is not NAME=hush:\/\/Vault\/Item\/field \(/)
          assert.deepStrictEqual(result.calls, [])
        }
      }
    }))

  it("fails a missing Reference with ReferenceNotFound and its suggestion, spawning nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await auditCount(box)
      const result = await box.run([
        "run",
        "--env",
        `X=${key}`,
        "--env",
        "Y=hush://Personal/Key/notes",
        "--",
        "sh",
        "-c",
        "echo spawned",
      ])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: hush://Personal/Key/notes does not exist (no such field); nothing was read and no command was run. Did you mean: hush://Personal/Key/credential? Renaming an Item breaks old References; `hush find` gives current ones.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/secrets/resolve", 404)])
      assert.strictEqual(await auditCount(box), before + 1)
    }))

  it("refuses 257 References with LimitExceeded naming 256, running nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const assignments = Array.from({ length: 257 }, (_, index) => [
        "--env",
        `X${index}=hush://Personal/Key${index}/credential`,
      ])
      const result = await box.run(["run", ...assignments.flat(), "--", "sh", "-c", "echo spawned"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: One command can resolve at most 256 References; nothing was read or run. Split them across several commands.\n",
      )
      assert.deepStrictEqual(result.calls, [call("/v1/secrets/resolve", 400)])
    }))
})

describe("masking", () => {
  it("masks a concealed value on piped stdout and stderr", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await box.run(["run", "--env", `X=${key}`, "--", "sh", "-c", 'printf %s "$X"; printf %s "$X" >&2'])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, concealed)
      assert.strictEqual(result.stderr, concealed)
    }))

  it("masks a value written in two halves with a pause between", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await box.tool("sleep", 'exec /bin/sleep "$@"')
      // The first 8 characters, a pause, then the rest.
      const script = 'rest="${X#????????}"; printf %s "${X%"$rest"}"; sleep 0.3; printf %s "$rest"'
      const result = await box.run(["run", "--env", `X=${key}`, "--", "sh", "-c", script])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, concealed)
    }))

  it("leaves a 7-byte value alone", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Short", value: "seven77" }] })
      const result = await box.run([
        "run",
        "--env",
        "X=hush://Personal/Short/credential",
        "--",
        "sh",
        "-c",
        'printf %s "$X"',
      ])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, "seven77")
    }))

  it.skipIf(!onPty)("leaves output on a TTY untouched", () =>
    withSandbox(async (box, seen) => {
      const shown = "fictional-tty-shown-value"
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Shown", value: shown }] })
      const result = await box.run(
        ["run", "--env", "X=hush://Personal/Shown/credential", "--", "sh", "-c", 'printf "%s\\n" "$X"'],
        { tty: { keys: [] } },
      )
      assert.strictEqual(result.code, 0, result.stderr)
      assert.include(result.stdout, shown)
      assert.notInclude(result.stdout, concealed)
    }),
  )
})

// A template under the sandbox's HOME; the CLI runs in the repository, so paths are absolute.
const template = async (box: Sandbox, lines: ReadonlyArray<string>, name = ".env.tpl") => {
  const path = join(box.home, name)
  await writeFile(path, lines.join("\n"))
  return path
}

const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8)

const admin = async (box: Sandbox, args: ReadonlyArray<string>) => {
  const result = await box.run([...args, "--passphrase-stdin"], { input: `${seedPassphrase}\n` })
  assert.strictEqual(result.code, 0, result.stderr)
  return result
}

const SavedTokens = Schema.fromJsonString(
  Schema.Struct({ tokens: Schema.Tuple([Schema.Struct({ token: Schema.String })]) }),
)

describe("hush env write", () => {
  it("writes the template with no Token read and no request, and counts on stderr", () =>
    withSandbox(async (box) => {
      const path = join(box.home, ".env.tpl")
      // An invalid HUSH_TOKEN would fail any command that reads a Token.
      const result = await box.run(["env", "write", path, `A=${key}`, "B=hush://Work/Db/password"], {
        env: { HUSH_TOKEN: "not-a-token" },
      })
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(result.stderr, `hush: Wrote 2 secret references to ${path}\n`)
      assert.deepStrictEqual(result.calls, [])
      assert.strictEqual(await readFile(path, "utf8"), `A=${key}\nB=hush://Work/Db/password\n`)
    }))

  it("refuses a literal value with InvalidAssignment and leaves the file unchanged", () =>
    withSandbox(async (box) => {
      const path = await template(box, ["OLD=1"])
      const result = await box.run(["env", "write", path, `A=${key}`, "B=plain"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: Assignment 2 is not NAME=hush://Vault/Item/field (the Reference is invalid: scheme); nothing was read or run.\n",
      )
      assert.strictEqual(await readFile(path, "utf8"), "OLD=1")
    }))

  it("reports a file it cannot write with FileWriteFailed", () =>
    withSandbox(async (box) => {
      const path = join(box.home, "missing", ".env.tpl")
      const result = await box.run(["env", "write", path, `A=${key}`])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        `hush: Could not write ${path} (ENOENT); no Server was contacted. Fix the path or its permissions and run \`hush env write\` again.\n`,
      )
      assert.deepStrictEqual(result.calls, [])
    }))
})

describe("hush env run", () => {
  it("injects every NAME=value line in file order, last one wins, in one secrets/resolve audited once", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const path = await template(box, [
        "# comment",
        "",
        "export MODE='dev'",
        `SECRET="${key}"`,
        "MODE=prod",
        `AGAIN = ${key}`,
      ])
      const before = await auditCount(box)
      const script = 'test "$MODE" = prod && test "$SECRET" = "$EXPECTED" && test "$AGAIN" = "$SECRET"'
      const result = await box.run(["env", "run", path, "--", "sh", "-c", script], { env: { EXPECTED: value } })
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, "")
      assert.deepStrictEqual(result.calls, resolved)
      assert.deepStrictEqual(await auditSince(box, before), [
        { action: "secrets.resolve", refs: JSON.stringify([key]), outcome: "ok" },
      ])
    }))

  it("masks the template's concealed values on a pipe and passes the exit code through", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const path = await template(box, [`X=${key}`])
      const result = await box.run(["env", "run", path, "--", "sh", "-c", 'printf %s "$X"; exit 3'])
      assert.strictEqual(result.code, 3)
      assert.strictEqual(result.stdout, concealed)
    }))

  it("spawns a template without References with no Token read and no request", () =>
    withSandbox(async (box) => {
      const path = await template(box, ["NODE_ENV=development"])
      const result = await box.run(["env", "run", path, "--", "sh", "-c", 'test "$NODE_ENV" = development'], {
        env: { HUSH_TOKEN: "not-a-token" },
      })
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, [])
    }))

  it("resolves a cross-Vault template with one Token", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await admin(box, ["vault", "create", "Work"])
      await admin(box, ["token", "issue", "--label", "agent on box", "--create", "Work", "--keep-grants", "--replace"])
      const saved = Schema.decodeUnknownSync(SavedTokens)(
        await readFile(join(box.home, ".config", "hush", "tokens.json"), "utf8"),
      )
      seen({ kind: "token", text: saved.tokens[0].token })
      const work = "fictional-work-value-42"
      seen({ kind: "value", text: work })
      const created = await box.run(["create", "api-credential", "--title", "Office", "--vault", "Work", "--stdin"], {
        input: `${work}\n`,
      })
      assert.strictEqual(created.code, 0, created.stderr)
      const path = await template(box, [`A=${key}`, "B=hush://Work/Office/credential"])
      const result = await box.run(
        ["env", "run", path, "--", "sh", "-c", 'test "$A" = "$EXPECTED" && test "$B" = "$EXPECTED_WORK"'],
        { env: { EXPECTED: value, EXPECTED_WORK: work } },
      )
      assert.strictEqual(result.code, 0, result.stderr)
      assert.deepStrictEqual(result.calls, resolved)
    }))

  it("fails a line that is not NAME=value with EnvFileInvalid, never showing the line, before any request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const line = "fictional-pasted-secret-line-8Wd"
      seen({ kind: "envLine", text: line })
      const path = await template(box, [`X=${key}`, line])
      const result = await box.run(["env", "run", path, "--", "sh", "-c", "echo spawned"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        `hush: ${path} line 2: is not blank, a comment or NAME=value; nothing was resolved or run.\n`,
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it("fails an op:// value with the replace-op:// message, never showing the line", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const item = "fictional-op-item-3Jk"
      seen({ kind: "envLine", text: item })
      const path = await template(box, ["# first", `TOKEN=op://Personal/${item}/credential`])
      const result = await box.run(["env", "run", path, "--", "sh", "-c", "echo spawned"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        `hush: ${path} line 2: is a 1Password reference; replace \`op://\` with \`hush://\`; nothing was resolved or run.\n`,
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it("fails an unreadable template with EnvFileUnreadable", () =>
    withSandbox(async (box) => {
      const path = join(box.home, "absent.env")
      const result = await box.run(["env", "run", path, "--", "sh", "-c", "echo spawned"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(result.stderr, `hush: Could not read ${path} (ENOENT); nothing was resolved or run.\n`)
    }))
})

describe("hush env resolve", () => {
  const escaped = `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`

  it("writes a 0600 file with each Reference quoted and every other line verbatim, in one request", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const path = await template(box, ["# keep", `A=${key}`, "not an assignment", `B='${key}'`, ""])
      const output = join(box.home, ".env")
      const result = await box.run(["env", "resolve", path, "--output", output])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        `hush: Resolved 2 secret references into ${output}; this file now contains plaintext secrets\n`,
      )
      assert.deepStrictEqual(result.calls, resolved)
      assert.strictEqual(
        await readFile(output, "utf8"),
        ["# keep", `A=${escaped}`, "not an assignment", `B=${escaped}`, ""].join("\n"),
      )
      assert.strictEqual(await mode(output), "600")
      assert.deepStrictEqual(
        (await readdir(box.home)).filter((name) => name.endsWith(".tmp")),
        [],
      )
    }))

  it("replaces the template itself with --in-place", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const path = await template(box, [`A=${key}`])
      const result = await box.run(["env", "resolve", path, "--in-place"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(await readFile(path, "utf8"), `A=${escaped}`)
      assert.strictEqual(await mode(path), "600")
    }))

  it("writes a template without References unchanged, with count 0 and no request", () =>
    withSandbox(async (box) => {
      const path = await template(box, ["NODE_ENV=development", ""])
      const output = join(box.home, ".env")
      const result = await box.run(["env", "resolve", path, "--output", output], { env: { HUSH_TOKEN: "not-a-token" } })
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(
        result.stderr,
        `hush: Resolved 0 secret references into ${output}; this file now contains plaintext secrets\n`,
      )
      assert.deepStrictEqual(result.calls, [])
      assert.strictEqual(await readFile(output, "utf8"), "NODE_ENV=development\n")
    }))

  it("refuses with EnvTargetInvalid unless exactly one of --output and --in-place is given", () =>
    withSandbox(async (box) => {
      const path = await template(box, [`A=${key}`])
      for (const flags of [[], ["--in-place", "--output", join(box.home, "out")]]) {
        const result = await box.run(["env", "resolve", path, ...flags])
        assert.strictEqual(result.code, 1)
        assert.strictEqual(
          result.stderr,
          "hush: Pass exactly one of `--output <path>` or `--in-place`; nothing was resolved or written.\n",
        )
        assert.deepStrictEqual(result.calls, [])
      }
      assert.strictEqual(await readFile(path, "utf8"), `A=${key}`)
    }))

  it("reports a target it cannot write with FileWriteFailed, leaving no temp file behind", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const path = await template(box, [`A=${key}`])
      const directory = join(box.home, "locked")
      await mkdir(directory, { mode: 0o500 })
      const output = join(directory, ".env")
      const result = await box.run(["env", "resolve", path, "--output", output])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        `hush: Could not write ${output} (EACCES); it was not changed and no plaintext copy was left behind. Fix the path or its permissions and run \`hush env resolve\` again.\n`,
      )
      assert.deepStrictEqual(await readdir(directory), [])
    }))
})

describe("hush run --help", () => {
  it("says masking is best effort", async () => {
    const box = await cli()
    try {
      const result = await box.run(["run", "--help"])
      assert.strictEqual(result.code, 0, result.stderr)
      assert.include(result.stdout, "best effort")
    } finally {
      await box.close()
    }
  })
})
