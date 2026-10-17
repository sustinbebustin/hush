import { assert, describe, it } from "@effect/vitest"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// The Owner's Reveal through the seam: `hush item reveal <reference>` over `admin/items/reveal`, one Field's value on
// stdout and one audit row naming its Reference.

const passphrase = passphraseSentinel.text
const value = valueSentinel.text
const username = "fictional plain username 9Kp"

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in. Revealed values are on stdout only, which `secretStdout` leaves out of the scan.
const withSandbox = async (test: (box: Sandbox, token: string) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, passphraseSentinel, { kind: "value", text: username }]

  try {
    const code = await box.server.initCode()

    if (code !== undefined) sentinels.push({ kind: "initCode", text: code })

    const { token } = await box.seed({
      items: [
        { kind: "api-credential", title: "Stripe", value },
        { kind: "login", title: "GitHub", value, plain: { username } },
      ],
    })

    sentinels.push({ kind: "token", text: token })
    await test(box, token)
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

const call = (path: string, status: number) => ({ method: "POST", path, status })

const reveal = (box: Sandbox, reference: string) =>
  box.run(["item", "reveal", reference, "--passphrase-stdin"], { input: `${passphrase}\n`, secretStdout: true })

describe("hush item reveal", () => {
  it("prints a concealed Field's value byte-exact on stdout, nothing on stderr, in one admin/items/reveal", () =>
    withSandbox(async (box) => {
      const result = await reveal(box, "hush://personal/stripe/CREDENTIAL")
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, value)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/reveal", 200)])
    }))

  it("prints a plain Field's value the same way", () =>
    withSandbox(async (box) => {
      const result = await reveal(box, "hush://Personal/GitHub/username")
      assert.strictEqual(result.code, 0, result.stderr)
      assert.strictEqual(result.stdout, username)
      assert.strictEqual(result.stderr, "")
    }))

  it("writes one item.reveal row: actor passphrase, the stored Reference, no detail", () =>
    withSandbox(async (box) => {
      const before = (await rows(box, "SELECT id FROM audit")).length
      await reveal(box, "hush://personal/stripe/CREDENTIAL")
      const added = (await rows(box, auditColumns)).slice(before)
      assert.deepStrictEqual(added, [
        {
          actor: "passphrase",
          action: "item.reveal",
          vaults: '["Personal"]',
          refs: '["hush://Personal/Stripe/credential"]',
          detail: null,
          outcome: "ok",
          error: null,
        },
      ])
    }))
})

const auditColumns = "SELECT actor, action, vaults, refs, detail, outcome, error FROM audit ORDER BY id"

const rows = (box: Sandbox, query: string) => box.inspect((db) => db.query(query).all())

describe("a refused item reveal prints nothing on stdout", () => {
  const refusals = [
    {
      name: "VaultNotFound for an unknown Vault",
      reference: "hush://Nope/Stripe/credential",
      status: 404,
      tag: "VaultNotFound",
      stderr:
        "hush: Vault Nope does not exist on this Server; nothing was changed. `hush vault list` shows the Vaults.\n",
    },
    {
      name: "ItemNotFound for an unknown Item",
      reference: "hush://Personal/Nope/credential",
      status: 404,
      tag: "ItemNotFound",
      stderr:
        'hush: Item Nope does not exist in Vault Personal; nothing was changed. `hush find "Nope" --vault Personal` shows exact titles.\n',
    },
    {
      name: "FieldNotFound for a Field the Item does not have",
      reference: "hush://Personal/Stripe/notes",
      status: 404,
      tag: "FieldNotFound",
      stderr:
        "hush: Item Stripe has no Field notes; nothing was changed. `hush inventory --vault Personal` lists its Fields.\n",
    },
  ] as const

  for (const refusal of refusals)
    it(`${refusal.name}: exit 1, audited error naming the Reference as requested`, () =>
      withSandbox(async (box) => {
        const result = await reveal(box, refusal.reference)
        assert.strictEqual(result.code, 1)
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(result.stderr, refusal.stderr)
        assert.deepStrictEqual(result.calls, [call("/v1/admin/items/reveal", refusal.status)])
        const [vault = ""] = refusal.reference.slice("hush://".length).split("/")
        assert.deepStrictEqual((await rows(box, auditColumns)).at(-1), {
          actor: "passphrase",
          action: "item.reveal",
          vaults: JSON.stringify([vault]),
          refs: JSON.stringify([refusal.reference]),
          detail: null,
          outcome: "error",
          error: refusal.tag,
        })
      }))

  it("IntegrityCheckFailed for a sealed value modified in the file, naming the Reference", () =>
    withSandbox(async (box) => {
      await box.inspect((db) =>
        db.run("UPDATE fields SET sealed = zeroblob(length(sealed)) WHERE label = 'credential'"),
      )
      const result = await reveal(box, "hush://Personal/Stripe/credential")
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        'hush: Stored data for hush://Personal/Stripe/credential failed its integrity check, so the database file was modified or corrupted; nothing was returned or changed. Restore the Server from a backup: see "Backup and restore" in the hush README.\n',
      )
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/reveal", 500)])
      assert.deepStrictEqual((await rows(box, "SELECT outcome, error FROM audit ORDER BY id")).at(-1), {
        outcome: "error",
        error: "IntegrityCheckFailed",
      })
    }))

  it("PassphraseIncorrect for a wrong Passphrase, audited denied, no value opened", () =>
    withSandbox(async (box) => {
      const result = await box.run(["item", "reveal", "hush://Personal/Stripe/credential", "--passphrase-stdin"], {
        input: "fictional wrong passphrase 3Lm\n",
      })

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.include(result.stderr, "hush: The Passphrase is incorrect; nothing was changed.")
      assert.deepStrictEqual(result.calls, [call("/v1/admin/items/reveal", 401)])
      assert.deepStrictEqual((await rows(box, auditColumns)).at(-1), {
        actor: "passphrase",
        action: "item.reveal",
        vaults: '["Personal"]',
        refs: '["hush://Personal/Stripe/credential"]',
        detail: null,
        outcome: "denied",
        error: "PassphraseIncorrect",
      })
    }))

  it("the CLI's InvalidReference for a malformed Reference, before any prompt or request", () =>
    withSandbox(async (box) => {
      const result = await box.run(["item", "reveal", "Personal/Stripe/credential"])
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: Personal/Stripe/credential is not a hush Reference (scheme); nothing was read or run. References look like `hush://Vault/Item/field`.\n",
      )
      assert.deepStrictEqual(result.calls, [])
    }))
})

const post = (box: Sandbox, body: object, token?: string) => {
  const headers = new Headers({ "content-type": "application/json" })

  if (token !== undefined) headers.set("authorization", `Bearer ${token}`)

  return box.fetch("/v1/admin/items/reveal", { method: "POST", headers, body: JSON.stringify(body) })
}

describe("admin/items/reveal over raw HTTP", () => {
  it("answers the Server's InvalidReference for a malformed Reference, audited error naming nothing", () =>
    withSandbox(async (box) => {
      const response = await post(box, { passphrase, reference: "hush://Personal/Stripe" })
      assert.strictEqual(response.status, 400)
      assert.deepStrictEqual(await response.json(), {
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- pins the wire JSON, independent of the schema
        _tag: "InvalidReference",
        reference: "hush://Personal/Stripe",
        reason: "segments",
      })
      assert.deepStrictEqual((await rows(box, auditColumns)).at(-1), {
        actor: "passphrase",
        action: "item.reveal",
        vaults: "[]",
        refs: "[]",
        detail: null,
        outcome: "error",
        error: "InvalidReference",
      })
    }))

  it("refuses a Token without the Passphrase: an empty 400, no value, no audit row", () =>
    withSandbox(async (box, token) => {
      const before = await rows(box, auditColumns)
      const response = await post(box, { reference: "hush://Personal/Stripe/credential" }, token)
      assert.strictEqual(response.status, 400)
      assert.strictEqual(await response.text(), "")
      assert.deepStrictEqual(await rows(box, auditColumns), before)
    }))
})
