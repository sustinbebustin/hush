import { assert, describe, it } from "@effect/vitest"
import { stat } from "node:fs/promises"
import { join } from "node:path"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { onPty, sandbox, type Sandbox } from "./sandbox.js"

// Runs `test`, then asserts no sentinel, and no Init code seen during the test, reached anything observable.
const withSandbox = async (test: (box: Sandbox, seen: (code: string) => void) => Promise<void>) => {
  const box = await sandbox()
  const codes: Array<Sentinel> = []

  try {
    await test(box, (code) => codes.push({ kind: "initCode", text: code }))
    assert.deepStrictEqual(scan(await box.observable(), [valueSentinel, passphraseSentinel, ...codes]), [])
  } finally {
    await box.close()
  }
}

const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8)

const auditRows = (box: Sandbox) => box.inspect((db) => db.query("SELECT * FROM audit ORDER BY id").all())

const currentCode = async (box: Sandbox) => {
  const code = await box.server.initCode()

  if (code === undefined) throw new Error("the Uninitialised Server wrote no init-code file")

  return code
}

describe("an Uninitialised Server", () => {
  it("writes a new 32-hex Init code to <state-dir>/init-code with mode 0600 at every start, logging only its path", () =>
    withSandbox(async (box, seen) => {
      const path = join(box.server.stateDir, "init-code")
      const first = await currentCode(box)
      seen(first)
      assert.match(first, /^[0-9a-f]{32}$/)
      assert.strictEqual(await mode(path), "600")

      const startup = box.server
        .output()
        .split("\n")
        .find((line) => line.includes('"listening"'))

      assert.strictEqual(JSON.parse(startup ?? "").initCodeFile, path)
      assert.include(box.server.output(), JSON.stringify(`cat ${path}`))
      await box.server.restart()
      const second = await currentCode(box)
      seen(second)
      assert.match(second, /^[0-9a-f]{32}$/)
      assert.notStrictEqual(second, first)
    }))

  it("becomes Ready at a start with a meta row, deleting a stale code file and writing none", () =>
    withSandbox(async (box, seen) => {
      seen(await currentCode(box))
      await box.inspect((db) =>
        db.run(
          `INSERT INTO meta VALUES (1, 1, 1, 65536, 3, 4, zeroblob(16), zeroblob(12), zeroblob(48), 'now', 'now')`,
        ),
      )
      await box.server.restart()
      assert.strictEqual(await box.server.initCode(), undefined)

      const startup = box.server
        .output()
        .split("\n")
        .findLast((line) => line.includes('"listening"'))

      assert.notProperty(JSON.parse(startup ?? ""), "initCodeFile")
      assert.strictEqual(JSON.parse((await box.run(["status"])).stdout).state, "ready")
    }))

  it("refuses a raw Token-endpoint call with NotInitialised, unaudited, and still serves status", () =>
    withSandbox(async (box) => {
      const response = await box.fetch("/v1/items/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })

      assert.strictEqual(response.status, 409)
      assert.deepStrictEqual(await response.json(), { _tag: "NotInitialised" })
      assert.strictEqual((await box.fetch("/v1/status")).status, 200)
      assert.deepStrictEqual(await auditRows(box), [])
    }))
})

const passphrase = passphraseSentinel.text
const initCall = (status: number) => ({ method: "POST", path: "/v1/admin/init", status })
const metaRows = (box: Sandbox) => box.inspect((db) => db.query("SELECT id FROM meta").all())

// The state Init must not have changed: Uninitialised, no meta or audit row, the code file still there.
const assertUninitialised = async (box: Sandbox, code: string) => {
  assert.deepStrictEqual(await metaRows(box), [])
  assert.deepStrictEqual(await auditRows(box), [])
  assert.strictEqual(await box.server.initCode(), code)
  assert.strictEqual(JSON.parse((await box.run(["status"])).stdout).state, "uninitialised")
}

const wrongCodeMessage =
  "hush: The Init code is wrong; nothing was changed. Read the current code again on the Server host (same commands as for an uninitialised Server; it changes at every restart until Init succeeds) and run `hush init` again.\n"

describe("hush init --passphrase-stdin", () => {
  it("refuses a wrong code with InitCodeInvalid, unaudited, then initialises with the right one uppercased and padded", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)
      const wrong = await box.run(["init", "--passphrase-stdin"], { input: `${"0".repeat(32)}\n${passphrase}\n` })
      assert.strictEqual(wrong.code, 1)
      assert.strictEqual(wrong.stdout, "")
      assert.strictEqual(wrong.stderr, wrongCodeMessage)
      assert.deepStrictEqual(wrong.calls, [initCall(403)])
      await assertUninitialised(box, code)

      const result = await box.run(["init", "--passphrase-stdin"], {
        input: ` ${code.toUpperCase()}\t \r\n${passphrase}\n`,
      })

      assert.strictEqual(result.code, 0)
      assert.strictEqual(result.stdout, `${JSON.stringify({ state: "ready" }, null, 2)}\n`)
      assert.strictEqual(
        result.stderr,
        "hush: Write the Passphrase down now and keep it offline: there is no reset, and without it nobody can manage Vaults, Tokens or Items on this Server again.\n",
      )
      assert.deepStrictEqual(result.calls, [initCall(200)])
      assert.strictEqual(await box.server.initCode(), undefined)
      assert.deepStrictEqual(await metaRows(box), [{ id: 1 }])
      const rows = await auditRows(box)
      assert.strictEqual(rows.length, 1)
      assert.deepInclude(rows[0], {
        count: 1,
        actor: "init",
        token_id: null,
        token_label: null,
        action: "init",
        vaults: "[]",
        refs: "[]",
        detail: null,
        outcome: "ok",
        error: null,
        peer: "127.0.0.1",
      })

      await box.server.restart()
      assert.strictEqual(await box.server.initCode(), undefined)
      assert.strictEqual(JSON.parse((await box.run(["status"])).stdout).state, "ready")
    }))

  it("refuses a second Init with AlreadyInitialised, leaving the Passphrase and data unchanged", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)
      assert.strictEqual((await box.run(["init", "--passphrase-stdin"], { input: `${code}\n${passphrase}\n` })).code, 0)
      const meta = () => box.inspect((db) => db.query("SELECT * FROM meta").all())
      const before = { meta: await meta(), audit: await auditRows(box) }
      const again = await box.run(["init", "--passphrase-stdin"], { input: `${code}\nanother passphrase 1234\n` })
      assert.strictEqual(again.code, 1)
      assert.strictEqual(again.stdout, "")
      assert.strictEqual(
        again.stderr,
        `hush: The hush Server at ${box.server.url} is already initialised; its Passphrase and data are unchanged. If you did not initialise it, someone else did: stop it and investigate. Otherwise use \`hush vault create\`.\n`,
      )
      assert.deepStrictEqual(again.calls, [initCall(409)])
      assert.deepStrictEqual({ meta: await meta(), audit: await auditRows(box) }, before)
    }))

  for (const [name, entered, reason] of [
    ["under 12 characters", "short pass", "too short (at least 12 characters)"],
    ["empty", "", "too short (at least 12 characters)"],
    ["over 1024 bytes", "a".repeat(1025), "too long"],
  ] as const)
    it(`refuses a Passphrase ${name} with PassphraseInvalid at the CLI, before any request`, () =>
      withSandbox(async (box, seen) => {
        const code = await currentCode(box)
        seen(code)
        const result = await box.run(["init", "--passphrase-stdin"], { input: `${code}\n${entered}\n` })
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(
          result.stderr,
          `hush: The new Passphrase is ${reason}; nothing was changed. Choose another.\n`,
        )
        assert.deepStrictEqual(result.calls, [])
        await assertUninitialised(box, code)
      }))

  it("refuses a Passphrase under the policy at the Server too, with PassphraseInvalid, changing nothing", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)

      const response = await box.fetch("/v1/admin/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initCode: code, passphrase: "short pass" }),
      })

      assert.strictEqual(response.status, 400)
      assert.deepStrictEqual(await response.json(), { _tag: "PassphraseInvalid", reason: "too-short" })
      await assertUninitialised(box, code)
    }))

  it("fails closed with AuditUnavailable when the audit row cannot be written, staying Uninitialised", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)
      await box.inspect((db) =>
        db.run("CREATE TRIGGER t BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'test'); END"),
      )
      const result = await box.run(["init", "--passphrase-stdin"], { input: `${code}\n${passphrase}\n` })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: The hush Server could not write its Audit Log, so it refused the request and returned nothing. Check its disk space and logs (`journalctl -u hush` or `docker logs`).\n",
      )
      assert.deepStrictEqual(result.calls, [initCall(503)])
      await assertUninitialised(box, code)
    }))

  for (const [name, input, message] of [
    [
      "an empty code (after stripping) with InitCodeEmpty",
      ` \t\n${passphrase}\n`,
      "No Init code was entered; nothing was changed. Read the current code again on the Server host (same commands as for an uninitialised Server; it changes at every restart until Init succeeds) and run `hush init` again.",
    ],
    [
      "a missing Passphrase line with StdinFramingInvalid",
      "0123\n",
      "stdin did not contain the Init code, then the new Passphrase, one per line and nothing after; nothing was changed. See `hush init --help`.",
    ],
    [
      "anything after the Passphrase line with StdinFramingInvalid",
      `0123\n${passphrase}\nextra\n`,
      "stdin did not contain the Init code, then the new Passphrase, one per line and nothing after; nothing was changed. See `hush init --help`.",
    ],
    [
      "input that is not UTF-8 with InvalidValue",
      new Uint8Array([0x30, 0x0a, 0xff, 0x0a]),
      "The input on stdin is not valid UTF-8; nothing was changed.",
    ],
  ] as const)
    it(`refuses ${name} at the CLI, before any request`, () =>
      withSandbox(async (box, seen) => {
        const code = await currentCode(box)
        seen(code)
        const result = await box.run(["init", "--passphrase-stdin"], { input })
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(result.stderr, `hush: ${message}\n`)
        assert.deepStrictEqual(result.calls, [])
        await assertUninitialised(box, code)
      }))

  it.skipIf(!onPty)("refuses a terminal stdin with StdinIsTerminal, before any request", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)
      const result = await box.run(["init", "--passphrase-stdin"], { tty: { keys: [] } })
      assert.strictEqual(result.code, 1)
      assert.include(
        result.stdout,
        "hush: `--passphrase-stdin` reads piped input but stdin is a terminal; nothing was changed. Pipe the input, or use the default prompt.",
      )
      assert.deepStrictEqual(result.calls, [])
      await assertUninitialised(box, code)
    }),
  )

  it("fails NoTerminal at once without --passphrase-stdin, before any request", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)
      const result = await box.run(["init"], { input: `${code}\n${passphrase}\n` })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: hush init needs a human with the Passphrase at a terminal; nothing was changed. Run it from an interactive terminal (or pipe secrets with `--passphrase-stdin`). Agents cannot run it.\n",
      )
      assert.deepStrictEqual(result.calls, [])
      await assertUninitialised(box, code)
    }))
})

// Typed at the three Init prompts, each answer sent once its prompt is on the pty.
const initKeys = (code: string, entered: string, repeated: string) => [
  { after: "Init code: ", keys: `${code}\r` },
  { after: "New Passphrase: ", keys: `${entered}\r` },
  { after: "Repeat new Passphrase: ", keys: `${repeated}\r` },
]

// A word of `stty -a` output, set (`icanon`) and not negated (`-icanon`). Linux `stty -a` prints no `raw` word, so
// a mode out of raw shows as `icanon` and `echo` both set.
const sttySet = (output: string, flag: string) => new RegExp(`(^|\\s)${flag}(\\s|$)`).test(output)

describe.skipIf(!onPty)("hush init at a terminal", () => {
  it("runs the first run: code, Passphrase and repeat typed at hidden prompts save a Token for the user", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)

      const result = await box.run(["init", "--vault", "Personal"], {
        tty: { keys: initKeys(code.toUpperCase(), passphrase, passphrase) },
      })

      assert.strictEqual(result.code, 0, result.stdout)
      assert.include(result.stdout, `"saved": ${JSON.stringify(join(box.home, ".config", "hush", "tokens.json"))}`)
      assert.include(result.stdout, "hush: Write the Passphrase down now")
      assert.deepStrictEqual(result.calls, [initCall(200)])
      const lookup = await box.run(["read", "hush://Personal/Missing/credential"])
      assert.include(lookup.stderr, "hush://Personal/Missing/credential does not exist (no such item)")
    }))

  it("cancels with PromptCancelled at Ctrl-C, restoring the terminal mode and sending nothing", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)

      const result = await box.run(["init"], {
        tty: {
          keys: [
            { after: "Init code: ", keys: `${code}\r` },
            { after: "New Passphrase: ", keys: "abc\x03" },
          ],
          sttyAfter: true,
        },
      })

      assert.strictEqual(result.code, 1)
      assert.include(result.stdout, "hush: Cancelled at the prompt; nothing was changed.")
      assert.isTrue(sttySet(result.stdout, "icanon"), result.stdout)
      assert.isTrue(sttySet(result.stdout, "echo"), result.stdout)
      assert.deepStrictEqual(result.calls, [])
      await assertUninitialised(box, code)
    }))

  it("cancels with PromptCancelled at Ctrl-D on an empty line", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)
      const result = await box.run(["init"], { tty: { keys: [{ after: "Init code: ", keys: "\x04" }] } })
      assert.strictEqual(result.code, 1)
      assert.include(result.stdout, "hush: Cancelled at the prompt; nothing was changed.")
      assert.deepStrictEqual(result.calls, [])
      await assertUninitialised(box, code)
    }))

  it("refuses a repeat that differs with PassphraseMismatch, sending nothing", () =>
    withSandbox(async (box, seen) => {
      const code = await currentCode(box)
      seen(code)

      const result = await box.run(["init"], {
        tty: { keys: initKeys(code, passphrase, `${passphrase}x`) },
      })

      assert.strictEqual(result.code, 1)
      assert.include(result.stdout, "hush: The two new Passphrases differ; nothing was changed.")
      assert.deepStrictEqual(result.calls, [])
      await assertUninitialised(box, code)
    }))
})
