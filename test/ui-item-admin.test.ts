import { assert, describe, it } from "@effect/vitest"

import { type Headless, headless } from "./headless.js"
import { valueSentinel } from "./leaks.js"
import { garbledMarker } from "./proxy.js"
import { type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// Rename, delete and release in `hush ui` under the headless renderer against a real Server: one write per action
// and one Item list after it, the confirm modal's `y`, the Retired titles section, and refusals in the CLI's words.

const value = valueSentinel.text

// The Passphrase-authorised CLI, for changes made behind the UI's back.
const admin = (box: Sandbox, args: ReadonlyArray<string>) =>
  box.run([...args, "--passphrase-stdin"], { input: `${seedPassphrase}\n` })

// `viaProxy`: the UI talks to the Server through the test proxy, for fault injection.
const withUi = async (
  seed: (box: Sandbox) => Promise<void>,
  body: (ui: Headless, box: Sandbox) => Promise<void>,
  options: { readonly viaProxy?: boolean } = {},
): Promise<void> => {
  const box = await sandbox()

  try {
    await box.seed({
      items: [
        { kind: "api-credential", title: "Stripe live key", value, plain: { notes: "billing" } },
        { kind: "login", title: "GitHub", value, plain: { username: "fictional user" } },
      ],
    })
    await seed(box)
    const ui = await headless(box, options.viaProxy === true ? { server: box.proxy.url } : {})

    try {
      await ui.waitFor("hush Passphrase:")
      await ui.type(seedPassphrase)
      ui.keys.pressEnter()
      await ui.waitFor("GitHub")
      await body(ui, box)

      // No value is ever drawn: nothing here Reveals.
      for (const frame of ui.frames()) for (const line of value.split("\n")) assert.notInclude(frame, line)
    } finally {
      await ui.close()
    }
  } finally {
    await box.close()
  }
}

const unchanged = async () => {}

// Narrows the list to `title` and puts the row cursor on it.
const onRow = async (ui: Headless, title: string) => {
  await ui.type(`/${title}`)
  ui.keys.pressEnter()
  await ui.waitFor(`Filter: ${title}`)
  ui.keys.pressTab()
  await ui.waitFor(`> ${title}`)
}

// The request paths since `before` requests.
const pathsSince = async (ui: Headless, before: number) => (await ui.calls()).slice(before).map(({ path }) => path)

// A frame's text with box borders and line breaks folded to single spaces, so a wrapped message reads whole.
const flat = (frame: string) => frame.replaceAll(/[│\s]+/g, " ")

const waitForText = (ui: Headless, text: string) => ui.waitUntil((frame) => flat(frame).includes(text))

describe.skipIf(!serverSupported)("hush ui rename, delete and release", () => {
  it("renames with one `items/rename`, shows every old and new Reference until dismissed, then the new title", () =>
    withUi(unchanged, async (ui) => {
      await onRow(ui, "Stripe")
      const before = (await ui.calls()).length

      await ui.type("n")
      await ui.waitFor('Rename Item "Stripe live key"')
      await ui.type("Stripe prod key")
      ui.keys.pressEnter()
      const receipt = await ui.waitFor("Update every template")

      for (const field of ["credential", "notes"]) {
        assert.include(receipt, `hush://Personal/Stripe live key/${field}`)
        assert.include(receipt, `-> hush://Personal/Stripe prod key/${field}`)
      }

      await ui.waitUntil((frame) => !frame.includes("Loading..."))
      assert.include(ui.frame(), "Update every template")
      ui.keys.pressEscape()
      const list = await ui.waitUntil((frame) => !frame.includes("Update every template"))

      assert.match(list, /> Stripe prod key/)
      assert.include(list, "Retired titles")
      assert.include(list, "stripe live key")
      assert.deepStrictEqual(await pathsSince(ui, before), ["/v1/admin/items/rename", "/v1/admin/items/list"])
    }))

  it("deletes only on y in a modal naming the exact title, then lists the Vault once", () =>
    withUi(unchanged, async (ui, box) => {
      await onRow(ui, "Stripe")
      const before = (await ui.calls()).length

      await ui.type("d")
      assert.include(await ui.waitFor('Delete Item "Stripe live key" from Vault Personal?'), "y confirm")
      await ui.type("n")
      await ui.waitUntil((frame) => !frame.includes("Delete Item"))
      assert.strictEqual((await ui.calls()).length, before)

      await ui.type("d")
      await ui.waitFor("Delete Item")
      await ui.type("y")
      const list = await ui.waitFor("Retired titles")

      assert.notInclude(list, "Stripe live key")
      assert.include(list, "stripe live key")
      assert.deepStrictEqual(await pathsSince(ui, before), ["/v1/admin/items/delete", "/v1/admin/items/list"])
      const listed = await admin(box, ["item", "list", "Personal"])
      assert.notInclude(listed.stdout, "Stripe live key")
    }))

  it("releases a Retired title only on y, after which it leaves the section and a Token can create it again", () =>
    withUi(
      async (box) => {
        assert.strictEqual((await admin(box, ["item", "delete", "Personal", "Stripe live key"])).code, 0)
      },
      async (ui, box) => {
        ui.keys.pressTab()
        ui.keys.pressArrow("down")
        const frame = await ui.waitFor("> stripe live key")
        assert.include(frame, "x release")
        const before = (await ui.calls()).length

        await ui.type("x")
        await ui.waitFor('Release the Retired title "stripe live key"')
        ui.keys.pressEscape()
        await ui.waitUntil((shown) => !shown.includes("Release the Retired"))
        assert.strictEqual((await ui.calls()).length, before)

        await ui.type("x")
        await ui.waitFor("Release the Retired")
        await ui.type("y")
        await ui.waitUntil((shown) => !shown.includes("Retired titles") && shown.includes("GitHub"))
        assert.deepStrictEqual(await pathsSince(ui, before), ["/v1/admin/items/release", "/v1/admin/items/list"])

        const created = await box.run(
          ["create", "api-credential", "--title", "Stripe live key", "--vault", "Personal", "--stdin"],
          { input: "fictional replacement value" },
        )

        assert.strictEqual(created.code, 0, created.stderr)
      },
    ))

  it("shows TitleNotRetired with the CLI's message when the title was released elsewhere", () =>
    withUi(
      async (box) => {
        assert.strictEqual((await admin(box, ["item", "delete", "Personal", "Stripe live key"])).code, 0)
      },
      async (ui, box) => {
        assert.strictEqual((await admin(box, ["item", "release", "Personal", "stripe live key"])).code, 0)
        ui.keys.pressTab()
        ui.keys.pressArrow("down")
        await ui.waitFor("> stripe live key")
        await ui.type("x")
        await ui.waitFor("Release the Retired")
        await ui.type("y")

        await waitForText(ui, "The title stripe live key is not retired in Vault Personal; nothing was changed.")
        assert.include(ui.frame(), "Notice")
      },
    ))

  it("shows ItemNotFound with the CLI's message when the Item was deleted elsewhere", () =>
    withUi(unchanged, async (ui, box) => {
      await onRow(ui, "Stripe")
      assert.strictEqual((await admin(box, ["item", "delete", "Personal", "Stripe live key"])).code, 0)
      ui.keys.pressEnter()
      await ui.waitFor("Created")
      await ui.type("d")
      await ui.waitFor("Delete Item")
      await ui.type("y")

      await waitForText(ui, "Item Stripe live key does not exist in Vault Personal; nothing was changed.")
    }))
})

const unverified = "the change may or may not have happened. Do not retry blindly"

const titles = (box: Sandbox) => box.inspect((db) => db.query("SELECT title FROM items ORDER BY id").all())

const retired = (box: Sandbox) =>
  box.inspect((db) => db.query("SELECT title_key FROM retired_titles ORDER BY title_key").all())

// Sends the write `act` starts with the proxy garbling its answer, then waits for the unverified notice.
const garbledWrite = async (ui: Headless, box: Sandbox, act: () => Promise<void>) => {
  box.proxy.mode("garble-response")
  await act()
  await waitForText(ui, unverified)
  box.proxy.mode("pass")

  for (const frame of ui.frames()) assert.notInclude(frame, garbledMarker)
}

describe.skipIf(!serverSupported)("hush ui Item writes whose answer cannot be decoded", () => {
  it("says a rename is unverified, never draws the body, and renames exactly once", () =>
    withUi(
      unchanged,
      async (ui, box) => {
        await onRow(ui, "Stripe")
        const before = (await ui.calls()).length

        await ui.type("n")
        await ui.waitFor('Rename Item "Stripe live key"')
        await ui.type("Stripe prod key")
        await garbledWrite(ui, box, async () => ui.keys.pressEnter())

        assert.deepStrictEqual(await pathsSince(ui, before), ["/v1/admin/items/rename"])
        assert.deepStrictEqual(await titles(box), [{ title: "Stripe prod key" }, { title: "GitHub" }])
      },
      { viaProxy: true },
    ))

  it("says a delete is unverified, never draws the body, and deletes exactly once", () =>
    withUi(
      unchanged,
      async (ui, box) => {
        await onRow(ui, "Stripe")
        const before = (await ui.calls()).length

        await ui.type("d")
        await ui.waitFor("Delete Item")
        await garbledWrite(ui, box, () => ui.type("y"))

        assert.deepStrictEqual(await pathsSince(ui, before), ["/v1/admin/items/delete"])
        assert.deepStrictEqual(await titles(box), [{ title: "GitHub" }])
      },
      { viaProxy: true },
    ))

  it("says a release is unverified, never draws the body, and releases exactly once", () =>
    withUi(
      async (box) => {
        assert.strictEqual((await admin(box, ["item", "delete", "Personal", "Stripe live key"])).code, 0)
      },
      async (ui, box) => {
        ui.keys.pressTab()
        ui.keys.pressArrow("down")
        await ui.waitFor("> stripe live key")
        const before = (await ui.calls()).length

        await ui.type("x")
        await ui.waitFor("Release the Retired")
        await garbledWrite(ui, box, () => ui.type("y"))

        assert.deepStrictEqual(await pathsSince(ui, before), ["/v1/admin/items/release"])
        assert.deepStrictEqual(await retired(box), [])
      },
      { viaProxy: true },
    ))
})
