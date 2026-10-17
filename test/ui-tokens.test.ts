import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { type FakeClipboard, fakeClipboard, type Headless, headless } from "./headless.js"
import { scan, valueSentinel } from "./leaks.js"
import { type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// The Tokens view of `hush ui` under the headless renderer against a real Server: the table, issuing (with its
// one-time Token modal and copy key), replacing and revoking, each checked through the Server's request log and,
// for issued Tokens, through the CLI.

const withUi = async (
  seed: (box: Sandbox) => Promise<void>,
  body: (ui: Headless, box: Sandbox, clipboard: FakeClipboard) => Promise<void>,
): Promise<void> => {
  const box = await sandbox()
  const clipboard = fakeClipboard()

  try {
    await seed(box)
    const ui = await headless(box, { clipboard: clipboard.clipboard })

    try {
      await body(ui, box, clipboard)
    } finally {
      await ui.close()
    }
  } finally {
    await box.close()
  }
}

const createVault = async (box: Sandbox, name: string) => {
  const created = await box.run(["vault", "create", name, "--passphrase-stdin"], { input: `${seedPassphrase}\n` })
  assert.strictEqual(created.code, 0, created.stderr)
}

// Personal (one Item, and the seed's Read+Create Token "agent on box") and an empty Work.
const seeded = async (box: Sandbox) => {
  await box.seed({ items: [{ kind: "api-credential", title: "Stripe live key", value: valueSentinel.text }] })
  await createVault(box, "Work")
}

const unlock = async (ui: Headless) => {
  await ui.waitFor("hush Passphrase:")
  await ui.type(seedPassphrase)
  ui.keys.pressEnter()
  await ui.waitFor("api-credential")
}

// Down from the first Vault to the Tokens entry below the Vaults, then Enter.
const openTokens = async (ui: Headless, vaults: number) => {
  for (let row = 0; row < vaults; row += 1) ui.keys.pressArrow("down")
  ui.keys.pressEnter()

  return ui.waitUntil((frame) => frame.includes("Label") && !frame.includes("Loading..."))
}

// The newest-first `hush token list` output, as far as these tests read it.
const TokenGrants = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      tokens: Schema.Array(
        Schema.Struct({
          state: Schema.String,
          grants: Schema.Array(Schema.Struct({ vault: Schema.String, access: Schema.String })),
        }),
      ),
    }),
  ),
)

const paths = (calls: ReadonlyArray<{ readonly path: string }>) => calls.map(({ path }) => path)

const tokenPattern = /hush_[A-Za-z0-9_-]{43}/

// The Token the issued modal shows.
const shownToken = (frame: string): string => {
  const [token] = tokenPattern.exec(frame) ?? []

  if (token === undefined) throw new Error(`no Token in the frame:\n${frame}`)

  return token
}

// Every frame that draws `token` also draws the issued modal around it.
const assertOnlyInModal = (ui: Headless, token: string) => {
  const drawn = ui.frames().filter((frame) => frame.includes(token))

  assert.isNotEmpty(drawn)

  for (const frame of drawn) assert.include(frame, "Token issued")
  assert.notInclude(ui.frame(), token)
}

// `hush find` with `token` as `HUSH_TOKEN`.
const findWith = (box: Sandbox, token: string) => box.run(["find", "Stripe"], { env: { HUSH_TOKEN: token } })

describe.skipIf(!serverSupported)("hush ui Tokens", () => {
  it("lists every Token with its Grants, state, created and expiry from one `tokens/list`", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      const before = (await ui.calls()).length

      const frame = await openTokens(ui, 2)

      assert.match(frame, /> Tokens/)
      assert.include(frame, "agent on box")
      assert.include(frame, "Personal (read+create)")
      assert.include(frame, "active")
      assert.match(frame, /\d{4}-\d{2}-\d{2}/)
      assert.include(frame, "never")
      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), ["/v1/admin/tokens/list"])
    }))

  it("issues a Token with one `tokens/issue`, draws it only in its modal, copies it, and it works for `hush find`", () =>
    withUi(seeded, async (ui, box, clipboard) => {
      await unlock(ui)
      await openTokens(ui, 2)
      const before = (await ui.calls()).length

      await ui.type("i")
      await ui.waitFor("Issue a Token")
      await ui.type("deploy bot")
      ui.keys.pressArrow("down")
      await ui.type(" ")
      ui.keys.pressArrow("down")
      ui.keys.pressArrow("down")
      await ui.type("30d")
      await ui.waitFor("TTL: 30d")
      ui.keys.pressEnter()
      const issued = await ui.waitFor("Token issued")
      const token = shownToken(issued)

      assert.include(issued, "c copy")
      await ui.type("c")
      await ui.waitFor("Copied")
      assert.deepStrictEqual(clipboard.copies(), [token])
      ui.keys.pressEscape()
      const table = await ui.waitUntil((frame) => !frame.includes("Token issued") && frame.includes("deploy bot"))

      assert.match(table, /deploy bot\s+active/)
      assert.include(table, "Personal (read)")
      assertOnlyInModal(ui, token)
      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), [
        "/v1/admin/tokens/issue",
        "/v1/admin/tokens/list",
      ])

      const found = await findWith(box, token)
      assert.strictEqual(found.code, 0, found.stderr)
      assert.include(found.stdout, "hush://Personal/Stripe live key/credential")
      assert.deepStrictEqual(scan(await box.observable(), [{ kind: "token", text: token }]), [])
    }))

  it("refuses an existing Label with the CLI's message, then replaces it keeping its Grants and revoking the old", () =>
    withUi(seeded, async (ui, box) => {
      await unlock(ui)
      await openTokens(ui, 2)
      const before = (await ui.calls()).length

      await ui.type("i")
      await ui.waitFor("Issue a Token")
      await ui.type("agent on box")
      ui.keys.pressArrow("down")
      ui.keys.pressArrow("down")
      await ui.type(" ")
      ui.keys.pressEnter()
      await ui.waitFor("A Token labelled agent on box already exists")
      ui.keys.pressEscape()
      await ui.waitFor("Issue a Token")

      ui.keys.pressArrow("down")
      ui.keys.pressArrow("down")
      await ui.type(" ")
      await ui.waitFor("Replace agent on box: yes, keeping its Grants")
      ui.keys.pressEnter()
      const issued = await ui.waitFor("Token issued")
      const token = shownToken(issued)

      assert.include(issued, "revoked")
      ui.keys.pressEscape()
      const table = await ui.waitUntil((frame) => !frame.includes("Token issued") && frame.includes("revoked"))

      assert.match(table, /agent on box\s+active/)
      assert.match(table, /agent on box\s+revoked/)
      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), [
        "/v1/admin/tokens/issue",
        "/v1/admin/tokens/issue",
        "/v1/admin/tokens/list",
      ])
      // The Grants column is cut to the pane's width, so the kept Grants are read back through the CLI.
      const listed = await box.run(["token", "list", "--passphrase-stdin"], { input: `${seedPassphrase}\n` })
      assert.deepStrictEqual(TokenGrants(listed.stdout).tokens[0], {
        state: "active",
        grants: [
          { vault: "Personal", access: "read+create" },
          { vault: "Work", access: "read" },
        ],
      })

      const old = await box.run(["find", "Stripe"])
      assert.strictEqual(old.code, 1)
      assert.include(old.stderr, "Token agent on box was revoked")
      const found = await findWith(box, token)
      assert.strictEqual(found.code, 0, found.stderr)
      assertOnlyInModal(ui, token)
    }))

  it("refuses a TTL beyond the API maximum before sending anything", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      await openTokens(ui, 2)
      const before = (await ui.calls()).length

      await ui.type("i")
      await ui.waitFor("Issue a Token")
      await ui.type("deploy bot")
      ui.keys.pressArrow("down")
      await ui.type(" ")
      ui.keys.pressArrow("down")
      ui.keys.pressArrow("down")
      await ui.type("3651d")
      ui.keys.pressEnter()
      const refused = await ui.waitFor("TTL 3651d is longer than")

      assert.include(refused, "at most 3650")
      assert.strictEqual((await ui.calls()).length, before)
    }))

  it("shows LimitExceeded with the CLI's message when the chosen Grants pass 64", () =>
    withUi(
      async (box) => {
        await seeded(box)

        // Over raw HTTP: a CLI process per Vault would make this the slowest test by far.
        for (let index = 0; index < 64; index += 1) {
          const response = await box.fetch("/v1/admin/vaults/create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ passphrase: seedPassphrase, vault: `V${String(index).padStart(2, "0")}` }),
          })

          assert.strictEqual(response.status, 200, await response.text())
        }
      },
      async (ui) => {
        await unlock(ui)
        await openTokens(ui, 66)
        await ui.type("i")
        await ui.waitFor("Issue a Token")
        await ui.type("wide")

        for (let row = 0; row < 66; row += 1) {
          ui.keys.pressArrow("down")
          await ui.type(" ")
        }

        ui.keys.pressEnter()

        assert.include(await ui.waitFor("A Token can hold at most 64 Grants"), "Notice")
      },
    ))

  it("revokes the Token under the cursor only on y, then lists the Tokens once more", () =>
    withUi(seeded, async (ui, box) => {
      await unlock(ui)
      await openTokens(ui, 2)
      const before = (await ui.calls()).length

      await ui.type("d")
      assert.include(await ui.waitFor("Revoke Token agent on box?"), "y confirm")
      await ui.type("n")
      await ui.waitUntil((frame) => !frame.includes("Revoke Token"))
      assert.strictEqual((await ui.calls()).length, before)
      await ui.type("d")
      await ui.waitFor("Revoke Token agent on box?")
      await ui.type("y")
      const revoked = await ui.waitFor("revoked")

      assert.notInclude(revoked, "active")
      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), [
        "/v1/admin/tokens/revoke",
        "/v1/admin/tokens/list",
      ])
      const find = await box.run(["find", "anything"])
      assert.strictEqual(find.code, 1)
      assert.include(find.stderr, "Token agent on box was revoked")
    }))

  it("tells the Owner when the Token was already revoked, with the CLI's message", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      await openTokens(ui, 2)
      await ui.type("d")
      await ui.waitFor("Revoke Token agent on box?")
      await ui.type("y")
      await ui.waitFor("revoked")

      await ui.type("d")
      await ui.waitFor("Revoke Token agent on box?")
      await ui.type("y")
      const refused = await ui.waitFor("No unrevoked Token is labelled agent on box")

      assert.include(refused, "Notice")
    }))
})
