import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { type Headless, headless } from "./headless.js"
import { valueSentinel } from "./leaks.js"
import { type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// Creating and deleting Vaults from the sidebar of `hush ui` under the headless renderer against a real Server,
// each checked through the Server's request log and the CLI.

const withUi = async (seed: (box: Sandbox) => Promise<void>, body: (ui: Headless, box: Sandbox) => Promise<void>) => {
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

const admin = (box: Sandbox, args: ReadonlyArray<string>) =>
  box.run([...args, "--passphrase-stdin"], { input: `${seedPassphrase}\n` })

// Personal (one Item, and the seed's Token "agent on box") and an empty Work.
const seeded = async (box: Sandbox) => {
  await box.seed({ items: [{ kind: "api-credential", title: "Stripe live key", value: valueSentinel.text }] })
  const created = await admin(box, ["vault", "create", "Work"])
  assert.strictEqual(created.code, 0, created.stderr)
}

const unlock = async (ui: Headless) => {
  await ui.waitFor("hush Passphrase:")
  await ui.type(seedPassphrase)
  ui.keys.pressEnter()
  await ui.waitFor("api-credential")
}

const paths = (calls: ReadonlyArray<{ readonly path: string }>) => calls.map(({ path }) => path)

// `hush vault list` output, as far as these tests read it.
const VaultNames = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ vaults: Schema.Array(Schema.Struct({ vault: Schema.String })) })),
)

const vaultNames = async (box: Sandbox): Promise<ReadonlyArray<string>> => {
  const listed = await admin(box, ["vault", "list"])
  assert.strictEqual(listed.code, 0, listed.stderr)

  return VaultNames(listed.stdout).vaults.map(({ vault }) => vault)
}

describe.skipIf(!serverSupported)("hush ui Vaults", () => {
  it("creates a Vault with one `vaults/create` and one `vaults/list`, and the sidebar lists it", () =>
    withUi(seeded, async (ui, box) => {
      await unlock(ui)
      const before = (await ui.calls()).length

      await ui.type("c")
      await ui.waitFor("Create a Vault")
      await ui.type("Archive")
      await ui.waitFor("Name: Archive")
      ui.keys.pressEnter()
      const frame = await ui.waitUntil((shown) => !shown.includes("Create a Vault") && shown.includes("Archive"))

      assert.match(frame, /Archive\s+0/)
      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), [
        "/v1/admin/vaults/create",
        "/v1/admin/vaults/list",
      ])
      assert.deepStrictEqual(await vaultNames(box), ["Archive", "Personal", "Work"])
    }))

  it("sends nothing when the create prompt is cancelled", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      const before = (await ui.calls()).length

      await ui.type("c")
      await ui.waitFor("Create a Vault")
      await ui.type("Archive")
      ui.keys.pressEscape()
      await ui.waitUntil((frame) => !frame.includes("Create a Vault"))

      assert.strictEqual((await ui.calls()).length, before)
    }))

  it("refuses an existing name with the CLI's message and keeps the prompt", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      const before = (await ui.calls()).length

      await ui.type("c")
      await ui.waitFor("Create a Vault")
      await ui.type("work")
      ui.keys.pressEnter()
      const refused = await ui.waitFor("A Vault named work already exists; nothing was changed.")

      assert.include(refused, "Notice")
      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), ["/v1/admin/vaults/create"])
      ui.keys.pressEnter()
      await ui.waitUntil((frame) => !frame.includes("Notice") && frame.includes("Name: work"))
    }))

  it("refuses an invalid name with the CLI's message before sending anything", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      const before = (await ui.calls()).length

      await ui.type("c")
      await ui.waitFor("Create a Vault")
      await ui.type("-bad")
      ui.keys.pressEnter()
      const refused = await ui.waitFor("vault is not a valid name (leading-dash); nothing was changed.")

      assert.include(refused, "Notice")
      assert.strictEqual((await ui.calls()).length, before)
    }))

  it("deletes an empty Vault only on y, with one `vaults/delete` and one `vaults/list`", () =>
    withUi(seeded, async (ui, box) => {
      await unlock(ui)
      ui.keys.pressArrow("down")
      const before = (await ui.calls()).length

      await ui.type("d")
      assert.include(await ui.waitFor("Delete Vault Work?"), "y confirm")
      await ui.type("n")
      await ui.waitUntil((frame) => !frame.includes("Delete Vault"))
      assert.strictEqual((await ui.calls()).length, before)

      await ui.type("d")
      await ui.waitFor("Delete Vault Work?")
      await ui.type("y")
      const frame = await ui.waitUntil((shown) => !shown.includes("Delete Vault") && !shown.includes("Work"))

      assert.include(frame, "Personal")
      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), [
        "/v1/admin/vaults/delete",
        "/v1/admin/vaults/list",
      ])
      assert.deepStrictEqual(await vaultNames(box), ["Personal"])
    }))

  it("shows VaultNotEmpty with the CLI's message and changes nothing", () =>
    withUi(seeded, async (ui, box) => {
      await unlock(ui)
      const before = (await ui.calls()).length

      await ui.type("d")
      await ui.waitFor("Delete Vault Personal?")
      await ui.type("y")
      const refused = await ui.waitFor("Vault Personal still has 1 Item and 1 unrevoked Token granted to it")

      assert.include(refused, "nothing was deleted")
      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), ["/v1/admin/vaults/delete"])
      assert.deepStrictEqual(await vaultNames(box), ["Personal", "Work"])
    }))

  it("shows VaultNotFound with the CLI's message when the Vault went away meanwhile", () =>
    withUi(seeded, async (ui, box) => {
      await unlock(ui)
      ui.keys.pressArrow("down")
      const gone = await admin(box, ["vault", "delete", "Work"])
      assert.strictEqual(gone.code, 0, gone.stderr)
      const before = (await ui.calls()).length

      await ui.type("d")
      await ui.waitFor("Delete Vault Work?")
      await ui.type("y")
      await ui.waitFor("Vault Work does not exist on this Server; nothing was changed.")

      assert.deepStrictEqual(paths((await ui.calls()).slice(before)), ["/v1/admin/vaults/delete"])
    }))

  it("leaves `c` and `d` to the Item rows once they hold the focus", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      ui.keys.pressTab()
      // The Item rows' hint bar.
      await ui.waitFor("n rename")
      const before = (await ui.calls()).length

      await ui.type("c")
      await ui.type("d")
      await ui.type("x")

      assert.notInclude(ui.frame(), "Create a Vault")
      assert.notInclude(ui.frame(), "Delete Vault")
      assert.strictEqual((await ui.calls()).length, before)
    }))
})
