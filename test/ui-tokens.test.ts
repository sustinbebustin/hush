import { assert, describe, it } from "@effect/vitest"

import { type Headless, headless } from "./headless.js"
import { type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// The Tokens view of `hush ui` under the headless renderer against a real Server: the table, issuing (with its
// one-time Token modal and copy key), replacing and revoking, each checked through the Server's request log and,
// for issued Tokens, through the CLI.

const withUi = async (
  seed: (box: Sandbox) => Promise<void>,
  body: (ui: Headless, box: Sandbox) => Promise<void>,
): Promise<void> => {
  const box = await sandbox()

  try {
    await seed(box)
    const ui = await headless(box)

    try {
      await body(ui, box)
    } finally {
      await ui.close()
    }
  } finally {
    await box.close()
  }
}

// Personal (with the seed's Read+Create Token "agent on box") and Work.
const seeded = async (box: Sandbox) => {
  await box.seed()
  const created = await box.run(["vault", "create", "Work", "--passphrase-stdin"], { input: `${seedPassphrase}\n` })
  assert.strictEqual(created.code, 0, created.stderr)
}

const unlock = async (ui: Headless) => {
  await ui.waitFor("hush Passphrase:")
  await ui.type(seedPassphrase)
  ui.keys.pressEnter()
  await ui.waitFor("No Items in this Vault.")
}

// Down from the first Vault to the Tokens entry below the Vaults, then Enter.
const openTokens = async (ui: Headless, vaults: number) => {
  for (let row = 0; row < vaults; row += 1) ui.keys.pressArrow("down")
  ui.keys.pressEnter()

  return ui.waitUntil((frame) => frame.includes("Label") && !frame.includes("Loading..."))
}

const paths = (calls: ReadonlyArray<{ readonly path: string }>) => calls.map(({ path }) => path)

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
})
