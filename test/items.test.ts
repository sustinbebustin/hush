import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { chmod, mkdir, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { onPty, sandbox, type Sandbox, type Seeded, type Tty } from "./sandbox.js"

const passphrase = passphraseSentinel.text
const value = valueSentinel.text

// The account the CLI runs as, which its rendered `hush token issue` commands name. Bun takes the user
// name from `USER`, which the seam leaves unset unless a run passes `account`.
const user = "agent"
const account = { USER: user }
const host = hostname()

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in: the token file may hold the Token, and `secretStdout` runs are not scanned.
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

// `seed`, with its Token and the Init code it used registered as sentinels.
const seeded = async (box: Sandbox, seen: (sentinel: Sentinel) => void, spec?: Parameters<Sandbox["seed"]>[0]) => {
  const code = await box.server.initCode()

  if (code !== undefined) seen({ kind: "initCode", text: code })
  const result = await box.seed(spec)
  seen({ kind: "token", text: result.token })

  return result
}

const call = (path: string, status: number) => ({ method: "POST", path, status })
const configDir = (box: Sandbox) => join(box.home, ".config", "hush")
const tokenFile = (box: Sandbox) => join(configDir(box), "tokens.json")
const mode = async (path: string) => ((await stat(path)).mode & 0o777).toString(8)

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())
const itemCount = async (box: Sandbox) => (await rows(box, "SELECT id FROM items")).length

const initVault = async (box: Sandbox, seen: (sentinel: Sentinel) => void, args: ReadonlyArray<string> = []) => {
  const code = await box.server.initCode()

  if (code === undefined) throw new Error("the Uninitialised Server wrote no init-code file")
  seen({ kind: "initCode", text: code })

  return box.run(["init", "--vault", "Personal", "--passphrase-stdin", ...args], {
    input: `${code}\n${passphrase}\n`,
    secretStdout: args.includes("--print"),
  })
}

const SavedTokens = Schema.fromJsonString(
  Schema.Struct({ tokens: Schema.Tuple([Schema.Struct({ token: Schema.String })]) }),
)

// The one Token the token file holds.
const savedToken = async (box: Sandbox) =>
  Schema.decodeUnknownSync(SavedTokens)(await Bun.file(tokenFile(box)).text()).tokens[0].token

const createStdin = (
  box: Sandbox,
  args: ReadonlyArray<string>,
  input: string | Uint8Array,
  env?: Record<string, string>,
) => box.run(["create", ...args, "--stdin"], { input, env })

const apiCredential = (title: string, vault = "Personal") => ["api-credential", "--title", title, "--vault", vault]

// The state a refused command must not have changed: no Item, and the same audit rows.
const snapshot = async (box: Sandbox) => ({
  items: await rows(box, "SELECT * FROM items"),
  fields: await rows(box, "SELECT id FROM fields"),
  audit: await rows(box, "SELECT id FROM audit"),
})

describe("hush init --vault", () => {
  it("creates the Vault and saves a Read+Create Token, then create and read round-trip the value byte-exact", () =>
    withSandbox(async (box, seen) => {
      const init = await initVault(box, seen, ["--label", "agent on box"])
      assert.strictEqual(init.code, 0, init.stderr)
      assert.deepStrictEqual(JSON.parse(init.stdout), {
        state: "ready",
        vault: "Personal",
        label: "agent on box",
        grants: [{ vault: "Personal", access: "read+create" }],
        saved: tokenFile(box),
      })
      assert.deepStrictEqual(init.calls, [call("/v1/admin/init", 200)])
      const token = await savedToken(box)
      seen({ kind: "token", text: token })
      assert.strictEqual(await mode(configDir(box)), "700")
      assert.strictEqual(await mode(tokenFile(box)), "600")
      // The token file holds the Token and nothing else secret (the leak scan covers values and the Passphrase).
      assert.deepStrictEqual(JSON.parse(await Bun.file(tokenFile(box)).text()), {
        version: 1,
        tokens: [{ server: box.server.url, label: "agent on box", token }],
      })
      const audit = await rows(box, "SELECT actor, action, vaults, refs, detail, outcome FROM audit")
      assert.deepStrictEqual(audit, [
        {
          actor: "init",
          action: "init",
          vaults: '["Personal"]',
          refs: "[]",
          detail: JSON.stringify({ label: "agent on box", grants: [{ vault: "Personal", access: "read+create" }] }),
          outcome: "ok",
        },
      ])

      const created = await createStdin(box, apiCredential("Stripe API Key", "personal"), `${value}\n`)
      assert.strictEqual(created.code, 0, created.stderr)
      assert.deepStrictEqual(JSON.parse(created.stdout), {
        title: "Stripe API Key",
        vault: "Personal",
        kind: "api-credential",
        field: "credential",
        ref: "hush://Personal/Stripe API Key/credential",
        verified: true,
      })
      assert.deepStrictEqual(created.calls, [call("/v1/items/create", 200), call("/v1/secrets/resolve", 200)])

      const read = await box.run(["read", "hush://personal/stripe api key/CREDENTIAL"], { secretStdout: true })
      assert.strictEqual(read.code, 0, read.stderr)
      assert.strictEqual(read.stdout, value)
      assert.strictEqual(read.stderr, "")
      assert.deepStrictEqual(read.calls, [call("/v1/secrets/resolve", 200)])

      // The first Vault, Item, Field and Token of a fresh database all have id 1 and open.
      for (const table of ["vaults", "items", "fields", "tokens"])
        assert.deepStrictEqual(await rows(box, `SELECT id FROM ${table}`), [{ id: 1 }], table)
    }))

  it("defaults the Label to <user> on <hostname>", () =>
    withSandbox(async (box, seen) => {
      const init = await initVault(box, seen)
      assert.strictEqual(init.code, 0, init.stderr)
      seen({ kind: "token", text: await savedToken(box) })
      const { label } = JSON.parse(init.stdout)
      assert.match(label, /^.+ on .+$/)
      assert.deepStrictEqual(await rows(box, "SELECT label FROM tokens"), [{ label }])
    }))

  it("with --print returns the Token in the receipt and saves nothing; HUSH_TOKEN then works with the file unreadable", () =>
    withSandbox(async (box, seen) => {
      const init = await initVault(box, seen, ["--print"])
      assert.strictEqual(init.code, 0, init.stderr)
      const receipt = JSON.parse(init.stdout)
      seen({ kind: "token", text: receipt.token })
      assert.match(receipt.token, /^hush_[A-Za-z0-9_-]{43}$/)
      assert.deepStrictEqual(
        { ...receipt, token: "" },
        {
          state: "ready",
          vault: "Personal",
          label: receipt.label,
          grants: [{ vault: "Personal", access: "read+create" }],
          token: "",
        },
      )
      assert.strictEqual(await Bun.file(tokenFile(box)).exists(), false)
      // A token file that cannot be read: `HUSH_TOKEN` means it is never opened.
      await mkdir(configDir(box), { recursive: true })
      await writeFile(tokenFile(box), "not json", { mode: 0o000 })
      await chmod(tokenFile(box), 0o000)
      const created = await createStdin(box, apiCredential("Key"), "v4lue\n", { HUSH_TOKEN: receipt.token })
      assert.strictEqual(created.code, 0, created.stderr)
      assert.strictEqual(JSON.parse(created.stdout).verified, true)
    }))

  it("refuses an already saved Token with TokenAlreadySaved before reading stdin or sending anything", () =>
    withSandbox(async (box, seen) => {
      await mkdir(configDir(box), { recursive: true, mode: 0o700 })

      const existing = {
        version: 1,
        tokens: [{ server: box.server.url, label: "old", token: `hush_${"A".repeat(43)}` }],
      }

      await writeFile(tokenFile(box), JSON.stringify(existing), { mode: 0o600 })
      const before = await snapshot(box)
      const code = await box.server.initCode()
      const result = await initVault(box, seen)
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: A Token for this Server is already saved (Label old); nothing was issued or saved. Pass `--replace`, or `--print` to print the new Token instead.\n",
      )
      assert.deepStrictEqual(result.calls, [])
      assert.deepStrictEqual(await snapshot(box), before)
      assert.strictEqual(await box.server.initCode(), code)
      assert.deepStrictEqual(JSON.parse(await Bun.file(tokenFile(box)).text()), existing)
    }))

  it.skipIf(process.getuid?.() === 0)(
    "refuses an unwritable home with FileWriteFailed before reading stdin or sending anything",
    () =>
      withSandbox(async (box, seen) => {
        await chmod(box.home, 0o500)

        try {
          const before = await snapshot(box)
          const result = await initVault(box, seen)
          assert.strictEqual(result.code, 1)
          assert.strictEqual(result.stdout, "")
          assert.match(
            result.stderr,
            /^hush: Could not write the token file .*tokens\.json \(EACCES\); nothing was issued and no prompt was shown\. Run this command from a CLI machine, or add `--print` to print the Token instead of saving it\.\n$/,
          )
          assert.deepStrictEqual(result.calls, [])
          assert.deepStrictEqual(await snapshot(box), before)
        } finally {
          await chmod(box.home, 0o700)
        }
      }),
  )

  it("refuses an invalid Vault name with InvalidName before any request", () =>
    withSandbox(async (box, seen) => {
      const code = await box.server.initCode()

      if (code === undefined) throw new Error("no init-code file")
      seen({ kind: "initCode", text: code })

      const result = await box.run(["init", "--vault", "a/b", "--passphrase-stdin"], {
        input: `${code}\n${passphrase}\n`,
      })

      assert.strictEqual(result.code, 1)
      assert.strictEqual(
        result.stderr,
        "hush: vault is not a valid name (slash); nothing was changed. Names are 1-128 characters without `/` or control characters, not starting with `-` or with a space at either end.\n",
      )
      assert.deepStrictEqual(result.calls, [])
    }))

  it("keeps the saved Token working after a restart on the same port", () =>
    withSandbox(async (box, seen) => {
      const { references } = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      await box.server.restart()
      const read = await box.run(["read", references[0] ?? ""], { secretStdout: true })
      assert.strictEqual(read.code, 0, read.stderr)
      assert.strictEqual(read.stdout, value)
    }))
})

describe("hush create", () => {
  it("creates a three-Field login whose every Field resolves, in one create and one read-back", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const created = await box.run(
        [
          "create",
          "login",
          "--title",
          "GitHub",
          "--vault",
          "Personal",
          "--stdin",
          "--username",
          "octo",
          "--notes",
          "two\nlines",
        ],
        { input: `${value}\r\n` },
      )

      assert.strictEqual(created.code, 0, created.stderr)
      assert.deepStrictEqual(JSON.parse(created.stdout), {
        title: "GitHub",
        vault: "Personal",
        kind: "login",
        field: "password",
        ref: "hush://Personal/GitHub/password",
        verified: true,
      })
      assert.deepStrictEqual(created.calls, [call("/v1/items/create", 200), call("/v1/secrets/resolve", 200)])

      for (const [field, expected] of [
        ["password", value],
        ["username", "octo"],
        ["notes", "two\nlines"],
      ] as const) {
        const read = await box.run(["read", `hush://Personal/GitHub/${field}`], { secretStdout: true })
        assert.strictEqual(read.stdout, expected, field)
      }

      // Kind order, ids from nextIds, every sealed length a multiple of 64 plus 16: values are padded before sealing.
      assert.deepStrictEqual(await rows(box, "SELECT id, label, length(sealed) % 64 AS tail FROM fields ORDER BY id"), [
        { id: 1, label: "password", tail: 16 },
        { id: 2, label: "username", tail: 16 },
        { id: 3, label: "notes", tail: 16 },
      ])
    }))

  it("writes items.create and secrets.resolve audit rows naming Vault, References and Fields, never values", () =>
    withSandbox(async (box, seen) => {
      const { label, references } = await seeded(box, seen, {
        items: [{ kind: "api-credential", title: "Key", value, plain: { notes: "n" } }],
      })

      await box.run(["read", "hush://personal/key/credential"], { secretStdout: true })

      const audit = await rows(
        box,
        "SELECT actor, token_id, token_label, action, vaults, refs, detail, outcome, error, peer FROM audit WHERE actor = 'token' ORDER BY id",
      )

      const token = { actor: "token", token_id: 1, token_label: label, outcome: "ok", error: null, peer: "127.0.0.1" }
      assert.deepStrictEqual(audit, [
        {
          ...token,
          action: "items.create",
          vaults: '["Personal"]',
          refs: "[]",
          detail: JSON.stringify({ title: "Key", fields: ["credential", "notes"] }),
        },
        {
          ...token,
          action: "secrets.resolve",
          vaults: '["Personal"]',
          refs: JSON.stringify(["hush://Personal/Key/credential", "hush://Personal/Key/notes"]),
          detail: null,
        },
        {
          ...token,
          action: "secrets.resolve",
          vaults: '["Personal"]',
          refs: '["hush://personal/key/credential"]',
          detail: null,
        },
      ])
      assert.deepStrictEqual(references, ["hush://Personal/Key/credential"])
      const [used] = await rows(box, "SELECT last_used_at FROM tokens")
      assert.isNotNull(used)
    }))

  it("refuses a case variant of a taken title with ItemExists, leaving one Item", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Stripe Key", value }] })
      const before = await rows(box, "SELECT * FROM items")
      const result = await createStdin(box, apiCredential("STRIPE key"), "other value\n")
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        'hush: An Item titled STRIPE key already exists in Vault Personal; nothing was created or overwritten. Run hush find "STRIPE key" --vault Personal, or choose another title.\n',
      )
      assert.deepStrictEqual(result.calls, [call("/v1/items/create", 409)])
      assert.deepStrictEqual(await rows(box, "SELECT * FROM items"), before)
      const [row] = await rows(box, "SELECT outcome, error FROM audit ORDER BY id DESC LIMIT 1")
      assert.deepStrictEqual(row, { outcome: "error", error: "ItemExists" })
    }))

  it("leaves exactly one Item when two creates of one title race", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)

      const results = await Promise.all([
        createStdin(box, apiCredential("Race"), "first value\n"),
        createStdin(box, apiCredential("race"), "second value\n"),
      ])

      assert.deepStrictEqual(results.map(({ code }) => code).toSorted(), [0, 1])
      assert.strictEqual(await itemCount(box), 1)
    }))
})

// Asserts a refusal: exit 1, nothing on stdout, exactly `message`, the expected calls and an unchanged store.
const assertRefused = async (
  box: Sandbox,
  run: () => Promise<{
    readonly code: number
    readonly stdout: string
    readonly stderr: string
    readonly calls: ReadonlyArray<unknown>
  }>,
  message: string,
  calls: ReadonlyArray<unknown> = [],
  audited = false,
) => {
  const before = await snapshot(box)
  const result = await run()
  assert.strictEqual(result.code, 1)
  assert.strictEqual(result.stdout, "")
  assert.strictEqual(result.stderr, `hush: ${message}\n`)
  assert.deepStrictEqual(result.calls, calls)
  const after = await snapshot(box)
  assert.deepStrictEqual({ ...after, audit: [] }, { ...before, audit: [] })
  assert.strictEqual(after.audit.length, before.audit.length + (audited ? 1 : 0))
}

describe("errors refused by the CLI before any request", () => {
  const sourceMessage =
    "Pass exactly one of `--stdin` (piped value), `--prompt` (hidden prompt) or `--clipboard` (macOS); nothing was created."

  for (const [name, args, input, message] of [
    ["no source flag with InputSourceRequired", apiCredential("K"), "v\n", sourceMessage],
    ["two source flags with InputSourceConflict", [...apiCredential("K"), "--stdin", "--prompt"], "v\n", sourceMessage],
    [
      "a plain flag the Kind lacks with UnknownField",
      [...apiCredential("K"), "--stdin", "--username", "u"],
      "v\n",
      "api-credential Items have no Field username; nothing was changed. Allowed: notes.",
    ],
    [
      "a blank title with InvalidName",
      ["api-credential", "--title", " ", "--vault", "Personal", "--stdin"],
      "v\n",
      "title is not a valid name (whitespace-edge); nothing was changed. Names are 1-128 characters without `/` or control characters, not starting with `-` or with a space at either end.",
    ],
    [
      "input that is not UTF-8 with InvalidValue",
      [...apiCredential("K"), "--stdin"],
      new Uint8Array([0x61, 0xff, 0x0a]),
      "The value for credential is not valid UTF-8; nothing was created.",
    ],
    [
      "a NUL byte with InvalidValue",
      [...apiCredential("K"), "--stdin"],
      "a\0b\n",
      "The value for credential contains a NUL byte; nothing was created.",
    ],
    [
      "a value over 64 KiB with InvalidValue",
      [...apiCredential("K"), "--stdin"],
      `${"x".repeat(65537)}\n`,
      "The value for credential is over 64 KiB; nothing was created.",
    ],
    [
      "a blank value with InputEmpty",
      [...apiCredential("K"), "--stdin"],
      " \t\n",
      "The value for credential is empty; nothing was created.",
    ],
    [
      "--prompt without a terminal with NoTerminal, at once",
      [...apiCredential("K"), "--prompt"],
      "",
      "`--prompt` needs a terminal and there is none; nothing was created. Pipe the value with `--stdin` instead.",
    ],
  ] as const)
    it(`create refuses ${name}`, () =>
      withSandbox(async (box, seen) => {
        await seeded(box, seen)
        await assertRefused(box, () => box.run(["create", ...args], { input }), message)
      }))

  it("create refuses a 64 KiB value only above the limit: exactly 65536 bytes is stored", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const result = await createStdin(box, apiCredential("Big"), `${"x".repeat(65536)}\n`)
      assert.strictEqual(result.code, 0, result.stderr)
    }))

  it("read refuses a string that is not a Reference with InvalidReference", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefused(
        box,
        () => box.run(["read", "op://Personal/Key/credential"]),
        "op://Personal/Key/credential is not a hush Reference (scheme); nothing was read or run. References look like `hush://Vault/Item/field`.",
      )
      await assertRefused(
        box,
        () => box.run(["read", "hush://Personal/Key"]),
        "hush://Personal/Key is not a hush Reference (segments); nothing was read or run. References look like `hush://Vault/Item/field`.",
      )
    }))

  it("refuses an invalid HUSH_TOKEN with TokenEnvInvalid, without trying the token file", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefused(
        box,
        () => box.run(["read", "hush://Personal/Key/credential"], { env: { HUSH_TOKEN: "hush_short" } }),
        "`HUSH_TOKEN` does not hold a hush Token (expected `hush_` and 43 characters); nothing was read and the token file was not tried. Fix or unset it.",
      )
    }))

  it("refuses with NoToken when no Token is saved for this Server", () =>
    withSandbox(async (box, seen) => {
      const init = await initVault(box, seen, ["--print"])
      seen({ kind: "token", text: JSON.parse(init.stdout).token })
      await assertRefused(
        box,
        () => createStdin(box, apiCredential("K"), "v\n", account),
        `No hush Token is available for ${box.server.url} (\`HUSH_TOKEN\` unset, none saved for this Server); nothing was read. A human can run \`hush token issue --label "${user} on ${host}" --create Personal\` as ${user} on ${host} (the Token is saved to that account's token file), or from another account \`hush token issue --label "${user} on ${host}" --create Personal --print | sudo -u ${user} hush token save --stdin\`, or set \`HUSH_TOKEN\`.`,
      )
    }))

  it.skipIf(process.platform === "darwin")("create refuses --clipboard off macOS with ClipboardUnsupported", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefused(
        box,
        () => box.run(["create", ...apiCredential("K"), "--clipboard"]),
        "`--clipboard` works on macOS only; use `--stdin` or `--prompt`; nothing was created.",
      )
    }),
  )
})

// The pty merges stdout and stderr, so a refusal is asserted by its line, its exit code and an unchanged store.
const assertRefusedOnPty = async (box: Sandbox, args: ReadonlyArray<string>, keys: Tty["keys"], message: string) => {
  const before = await snapshot(box)
  const result = await box.run(args, { tty: { keys } })
  assert.strictEqual(result.code, 1)
  assert.include(result.stdout, `hush: ${message}`)
  assert.deepStrictEqual(result.calls, [])
  assert.deepStrictEqual(await snapshot(box), before)
}

describe.skipIf(!onPty)("hush create at a terminal", () => {
  it("stores a value typed at `--prompt`, never shown, that read returns byte-exact", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      // One line, as a prompt takes; registered so the pty output is scanned for it.
      const typed = "fictional typed sentinel é✓ 9Zk"
      seen({ kind: "value", text: typed })

      const created = await box.run(["create", ...apiCredential("Typed"), "--prompt"], {
        tty: { keys: [{ after: "Value for credential: ", keys: `${typed}\r` }] },
      })

      assert.strictEqual(created.code, 0, created.stdout)
      assert.include(created.stdout, '"verified": true')
      assert.deepStrictEqual(
        created.calls.map(({ path }) => path),
        ["/v1/items/create", "/v1/secrets/resolve"],
      )
      const read = await box.run(["read", "hush://Personal/Typed/credential"], { secretStdout: true })
      assert.strictEqual(read.stdout, typed)
    }))

  it("refuses a blank line at `--prompt` with InputEmpty", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefusedOnPty(
        box,
        ["create", ...apiCredential("K"), "--prompt"],
        [{ after: "Value for credential: ", keys: "  \r" }],
        "The value for credential is empty; nothing was created.",
      )
    }))

  it("cancels `--prompt` at Ctrl-C with PromptCancelled", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefusedOnPty(
        box,
        ["create", ...apiCredential("K"), "--prompt"],
        [{ after: "Value for credential: ", keys: "abc\x03" }],
        "Cancelled at the prompt; nothing was changed.",
      )
    }))

  it("never prompts implicitly: no source flag exits 1 at once with InputSourceRequired", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefusedOnPty(
        box,
        ["create", ...apiCredential("K")],
        [],
        "Pass exactly one of `--stdin` (piped value), `--prompt` (hidden prompt) or `--clipboard` (macOS); nothing was created.",
      )
    }))

  it("refuses a terminal stdin for `--stdin` with StdinIsTerminal", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefusedOnPty(
        box,
        ["create", ...apiCredential("K"), "--stdin"],
        [],
        "`--stdin` reads piped input but stdin is a terminal; nothing was created. Pipe the input, or use `--prompt`.",
      )
    }))
})

// `pbpaste` is a fake on the sandbox PATH, so no test reads the real clipboard.
describe.skipIf(process.platform !== "darwin")("hush create --clipboard on macOS", () => {
  it("stores the clipboard's value, one trailing newline stripped, that read returns", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await box.tool("pbpaste", `printf '%s\\n' '${value}'`)
      const created = await box.run(["create", ...apiCredential("Pasted"), "--clipboard"])
      assert.strictEqual(created.code, 0, created.stderr)
      const read = await box.run(["read", "hush://Personal/Pasted/credential"], { secretStdout: true })
      assert.strictEqual(read.stdout, value)
    }))

  it("refuses with InputUnreadable when pbpaste fails, its output suppressed", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await box.tool("pbpaste", `printf '%s' '${value}' >&2; exit 1`)
      await assertRefused(
        box,
        () => box.run(["create", ...apiCredential("K"), "--clipboard"]),
        "The value for credential could not be read (details suppressed); nothing was created.",
      )
    }))
})

const post = (box: Sandbox, path: string, body: Schema.Json, token?: string) => {
  const headers = new Headers({ "content-type": "application/json" })

  if (token !== undefined) headers.set("authorization", `Bearer ${token}`)

  return box.fetch(path, { method: "POST", headers, body: JSON.stringify(body) })
}

describe("errors refused by the Server", () => {
  it("refuses a Vault outside the Grants with VaultNotGranted, naming the Grants and the closest one, audited denied", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      await assertRefused(
        box,
        () => box.run(["read", "hush://Personnal/Key/credential"], { env: account }),
        `Token agent on box is not granted Vault Personnal; nothing was read or changed. Did you mean Personal? It is granted: Personal (read+create). If Personnal is right, ask the human to run: \`hush token issue --label "agent on box" --read Personnal --keep-grants --replace\` as ${user} on ${host}, whose token file holds this Token; from another account: \`hush token issue --label "agent on box" --read Personnal --keep-grants --replace --print | sudo -u ${user} hush token save --stdin --replace\`.`,
        [call("/v1/secrets/resolve", 403)],
        true,
      )
      const [row] = await rows(box, "SELECT action, outcome, error FROM audit ORDER BY id DESC LIMIT 1")
      assert.deepStrictEqual(row, { action: "secrets.resolve", outcome: "denied", error: "VaultNotGranted" })
      await assertRefused(
        box,
        () => createStdin(box, apiCredential("K", "Work"), "v\n", account),
        `Token agent on box is not granted Vault Work; nothing was read or changed. It is granted: Personal (read+create). If Work is right, ask the human to run: \`hush token issue --label "agent on box" --create Work --keep-grants --replace\` as ${user} on ${host}, whose token file holds this Token; from another account: \`hush token issue --label "agent on box" --create Work --keep-grants --replace --print | sudo -u ${user} hush token save --stdin --replace\`.`,
        [call("/v1/items/create", 403)],
        true,
      )
    }))

  it("refuses a missing Item or Field with ReferenceNotFound, saying which, audited error", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      await assertRefused(
        box,
        () => box.run(["read", "hush://Personal/Nope/credential"]),
        "hush://Personal/Nope/credential does not exist (no such item); nothing was read and no command was run. Renaming an Item breaks old References; `hush find` gives current ones.",
        [call("/v1/secrets/resolve", 404)],
        true,
      )
      await assertRefused(
        box,
        () => box.run(["read", "hush://Personal/Key/notes"]),
        "hush://Personal/Key/notes does not exist (no such field); nothing was read and no command was run. Did you mean: hush://Personal/Key/credential? Renaming an Item breaks old References; `hush find` gives current ones.",
        [call("/v1/secrets/resolve", 404)],
        true,
      )
    }))

  it("suggests the close titles of the same Vault with the same Field for a mistyped Item", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, {
        items: [
          { kind: "api-credential", title: "Stripe API Key", value },
          { kind: "api-credential", title: "Stripe API Keys", value },
          // Close, but without a `credential` Field.
          { kind: "login", title: "Stripe API Kes", value },
          { kind: "api-credential", title: "Unrelated", value },
        ],
      })
      await assertRefused(
        box,
        () => box.run(["read", "hush://Personal/stripe api kye/credential"]),
        "hush://Personal/stripe api kye/credential does not exist (no such item); nothing was read and no command was run. Did you mean: hush://Personal/Stripe API Keys/credential, hush://Personal/Stripe API Key/credential? Renaming an Item breaks old References; `hush find` gives current ones.",
        [call("/v1/secrets/resolve", 404)],
        true,
      )
    }))

  it("suggests the Item's closest Field labels for a mistyped Field", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, {
        items: [{ kind: "database", title: "Postgres", value, plain: { username: "u", host: "h", port: "5432" } }],
      })
      await assertRefused(
        box,
        () => box.run(["read", "hush://Personal/Postgres/pasword"]),
        "hush://Personal/Postgres/pasword does not exist (no such field); nothing was read and no command was run. Did you mean: hush://Personal/Postgres/password, hush://Personal/Postgres/port, hush://Personal/Postgres/host? Renaming an Item breaks old References; `hush find` gives current ones.",
        [call("/v1/secrets/resolve", 404)],
        true,
      )
    }))

  it("refuses an unknown Token with TokenRejected, unaudited", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const unknownToken = `hush_${"B".repeat(42)}A`
      seen({ kind: "token", text: unknownToken })
      await assertRefused(
        box,
        () => box.run(["read", "hush://Personal/Key/credential"], { env: { HUSH_TOKEN: unknownToken } }),
        "This Server does not know the Token (issued by another Server, or the Server was restored from an older backup); nothing was read. Ask the human for a new Token.",
        [call("/v1/secrets/resolve", 401)],
      )
    }))

  it("refuses a missing or malformed credential with TokenRejected before decoding the body, unaudited", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const before = await snapshot(box)

      for (const [token, reason] of [
        [undefined, "missing"],
        ["hush_short", "malformed"],
      ] as const) {
        const response = await post(box, "/v1/secrets/resolve", { not: "a resolve body" }, token)
        assert.strictEqual(response.status, 401)
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
        assert.deepStrictEqual(await response.json(), { _tag: "TokenRejected", rejection: { reason } })
      }

      assert.deepStrictEqual(await snapshot(box), before)
    }))

  for (const [name, path, body, status, expected] of [
    [
      "a resolve string that is not a Reference with InvalidReference",
      "/v1/secrets/resolve",
      { references: ["hush://Personal/Key/credential", "op://x"] },
      400,
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      { _tag: "InvalidReference", reference: "op://x", reason: "scheme" },
    ],
    [
      "a label outside the Kind with UnknownField",
      "/v1/items/create",
      {
        vault: "Personal",
        title: "K",
        kind: "api-credential",
        fields: [
          { label: "credential", value: "v" },
          { label: "url", value: "u" },
        ],
      },
      400,
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      { _tag: "UnknownField", kind: "api-credential", field: "url", allowed: ["credential", "notes"] },
    ],
    [
      "a create without the primary Field with FieldRequired",
      "/v1/items/create",
      { vault: "Personal", title: "K", kind: "login", fields: [{ label: "username", value: "u" }] },
      400,
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      { _tag: "FieldRequired", kind: "login", field: "password" },
    ],
    [
      "an empty value with InvalidValue",
      "/v1/items/create",
      { vault: "Personal", title: "K", kind: "api-credential", fields: [{ label: "credential", value: "" }] },
      400,
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      { _tag: "InvalidValue", field: "credential", reason: "empty" },
    ],
    [
      "a value with U+0000 with InvalidValue",
      "/v1/items/create",
      { vault: "Personal", title: "K", kind: "api-credential", fields: [{ label: "credential", value: "a\0b" }] },
      400,
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      { _tag: "InvalidValue", field: "credential", reason: "nul" },
    ],
    [
      "a value with a lone surrogate with InvalidValue",
      "/v1/items/create",
      { vault: "Personal", title: "K", kind: "api-credential", fields: [{ label: "credential", value: "a\uD800" }] },
      400,
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      { _tag: "InvalidValue", field: "credential", reason: "not-utf8" },
    ],
    [
      "a title that breaks the name rules with InvalidName",
      "/v1/items/create",
      { vault: "Personal", title: "-K", kind: "api-credential", fields: [{ label: "credential", value: "v" }] },
      400,
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
      { _tag: "InvalidName", what: "title", reason: "leading-dash" },
    ],
  ] as const)
    it(`refuses ${name}, audited error, changing nothing`, () =>
      withSandbox(async (box, seen) => {
        const { token } = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
        const before = await snapshot(box)
        const response = await post(box, path, body, token)
        assert.strictEqual(response.status, status)
        assert.deepStrictEqual(await response.json(), expected)
        const after = await snapshot(box)
        assert.deepStrictEqual({ ...after, audit: [] }, { ...before, audit: [] })
        const [row] = await rows(box, "SELECT outcome, error FROM audit ORDER BY id DESC LIMIT 1")
        assert.deepStrictEqual(row, { outcome: "error", error: expected._tag })
      }))
})

const login = { kind: "login", title: "GitHub", value, plain: { username: "octo" } } as const

describe("stored data that fails its integrity check, and an Audit Log that cannot be written", () => {
  it("fails a fields.label swap between password and username with IntegrityCheckFailed naming the Reference", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen, { items: [login] })
      await box.inspect((db) => {
        const relabel = db.prepare("UPDATE fields SET label = ?, label_key = ? WHERE label = ?")
        relabel.run("swap", "swap", "password")
        relabel.run("password", "password", "username")
        relabel.run("username", "username", "swap")
      })

      for (const field of ["password", "username"])
        await assertRefused(
          box,
          () => box.run(["read", `hush://Personal/GitHub/${field}`]),
          `Stored data for hush://Personal/GitHub/${field} failed its integrity check, so the database file was modified or corrupted; nothing was returned or changed. Restore the Server from a backup: see "Backup and restore" in the hush README.`,
          [call("/v1/secrets/resolve", 500)],
          true,
        )
    }))

  it("fails closed with AuditUnavailable: resolve returns no value and create leaves no Item", () =>
    withSandbox(async (box, seen) => {
      const { references } = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      await box.inspect((db) =>
        db.run("CREATE TRIGGER t BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'test'); END"),
      )

      const message =
        "The hush Server could not write its Audit Log, so it refused the request and returned nothing. Check its disk space and logs (`journalctl -u hush` or `docker logs`)."

      await assertRefused(box, () => box.run(["read", references[0] ?? ""]), message, [
        call("/v1/secrets/resolve", 503),
      ])
      await assertRefused(box, () => createStdin(box, apiCredential("Other"), "v\n"), message, [
        call("/v1/items/create", 503),
      ])
      assert.deepStrictEqual(await rows(box, "SELECT title FROM items"), [{ title: "Key" }])
    }))
})

// A create sent through the test proxy in `fault` mode, with the seeded Token (saved Tokens are keyed by origin).
const viaProxy = async (box: Sandbox, seed: Seeded, fault: "drop-response" | "corrupt-response") => {
  box.proxy.mode(fault)

  return createStdin(box, apiCredential("K"), `${value}\n`, { HUSH_SERVER: box.proxy.url, HUSH_TOKEN: seed.token })
}

describe("a create whose answer is lost or altered on the way back", () => {
  it("reports CreationMayHaveSucceeded when the create's response is dropped, and creates exactly once", () =>
    withSandbox(async (box, seen) => {
      const result = await viaProxy(box, await seeded(box, seen), "drop-response")
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        'hush: Creation may have succeeded, but its receipt could not be verified. Do not retry creation; inspect the destination with hush find "K" --vault Personal first.\n',
      )
      assert.deepStrictEqual(result.calls, [call("/v1/items/create", 200)])
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/items/create HTTP/1.1"])
      assert.strictEqual(await itemCount(box), 1)
    }))

  it("reports CreationUnverified when the read-back differs, naming the Reference, and creates exactly once", () =>
    withSandbox(async (box, seen) => {
      const result = await viaProxy(box, await seeded(box, seen), "corrupt-response")
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        'hush: Creation is unverified. Do not retry creation; inspect the destination by title with hush find "K" --vault Personal first. Item reference: hush://Personal/K/credential.\n',
      )
      assert.deepStrictEqual(result.calls, [call("/v1/items/create", 200), call("/v1/secrets/resolve", 200)])
      assert.deepStrictEqual(box.proxy.log(), ["POST /v1/items/create HTTP/1.1", "POST /v1/secrets/resolve HTTP/1.1"])
      assert.strictEqual(await itemCount(box), 1)
    }))
})
