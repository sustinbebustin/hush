import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { type Headless, headless } from "./headless.js"
import { passphraseSentinel, valueSentinel } from "./leaks.js"
import { type Call, type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// `hush ui`'s Item detail and Reveal under the headless renderer against a real Server: what each Kind's detail
// shows, the one request and audit row per Reveal, that the value is drawn only until it is hidden, and that a
// refused Reveal reads as the CLI's message.

const value = valueSentinel.text
const username = "fictional plain username 4Hd"

// The sentinel spans two lines, and a frame draws each on its own row.
const valueLines = value.split("\n")
const showsValue = (frame: string) => valueLines.every((line) => frame.includes(line))
const showsAnyOfValue = (frame: string) => valueLines.some((line) => frame.includes(line))

// A frame's text with box borders and line breaks folded to single spaces, so a wrapped message reads whole.
const flat = (frame: string) => frame.replaceAll(/[│\s]+/g, " ")

const withUi = async (body: (ui: Headless, box: Sandbox) => Promise<void>): Promise<void> => {
  const box = await sandbox()

  try {
    await box.seed({
      items: [
        { kind: "api-credential", title: "Stripe live key", value, plain: { notes: "billing" } },
        { kind: "login", title: "GitHub", value, plain: { username } },
        {
          kind: "database",
          title: "Orders DB",
          value,
          plain: { username, host: "db.internal", port: "5432", database: "orders", notes: "primary" },
        },
      ],
    })

    const ui = await headless(box)

    try {
      await ui.waitFor("hush Passphrase:")
      await ui.type(seedPassphrase)
      ui.keys.pressEnter()
      await ui.waitFor("Stripe live key")
      await body(ui, box)
    } finally {
      await ui.close()
    }
  } finally {
    await box.close()
  }
}

// Opens the detail of the one Item whose title matches `title`: filter, then Tab to the rows and Enter.
const open = async (ui: Headless, title: string) => {
  await ui.type(`/${title}`)
  ui.keys.pressEnter()
  await ui.waitFor(`Filter: ${title}`)
  ui.keys.pressTab()
  ui.keys.pressEnter()

  return ui.waitFor("Created")
}

// Where each of `texts` starts in `frame`, in the order given.
const positions = (frame: string, texts: ReadonlyArray<string>) => texts.map((text) => frame.indexOf(text))

const reveals = (calls: ReadonlyArray<Call>) => calls.filter(({ path }) => path === "/v1/admin/items/reveal")

const AuditPage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      entries: Schema.Array(Schema.Struct({ action: Schema.String, references: Schema.Array(Schema.String) })),
    }),
  ),
)

const noSecretIn = (frames: ReadonlyArray<string>) => {
  for (const frame of frames) {
    assert.isFalse(showsAnyOfValue(frame), frame)
    assert.notInclude(frame, seedPassphrase)
    assert.notInclude(frame, passphraseSentinel.text)
  }
}

describe.skipIf(!serverSupported)("hush ui Item detail", () => {
  const kinds = [
    { title: "Stripe live key", kind: "api-credential", fields: ["credential", "notes"] },
    { title: "GitHub", kind: "login", fields: ["password", "username"] },
    { title: "Orders DB", kind: "database", fields: ["password", "username", "host", "port", "database", "notes"] },
  ] as const

  for (const { title, kind, fields } of kinds)
    it(`shows a ${kind} Item's metadata and every Field in Kind order with its Reference, the concealed one masked`, () =>
      withUi(async (ui) => {
        const frame = await open(ui, title)

        assert.include(frame, `Kind     ${kind}`)
        assert.match(frame, /Created {2}\d{4}-\d{2}-\d{2}T/)
        assert.match(frame, /Updated {2}\d{4}-\d{2}-\d{2}T/)
        assert.match(frame, new RegExp(`> ${fields[0]} +\\*{8}`))

        const references = fields.map((field) => `hush://Personal/${title}/${field}`)
        const at = positions(frame, references)
        assert.notInclude(at, -1)
        assert.deepStrictEqual(
          at,
          at.toSorted((a, b) => a - b),
        )
        noSecretIn(ui.frames())
      }))

  it("returns to the Item list on Esc", () =>
    withUi(async (ui) => {
      await open(ui, "GitHub")
      ui.keys.pressEscape()

      assert.include(await ui.waitUntil((frame) => !frame.includes("Created")), "Filter: GitHub")
    }))
})

describe.skipIf(!serverSupported)("hush ui Reveal", () => {
  it("draws the value after one admin/items/reveal, removes it on the next key, and audits its Reference", () =>
    withUi(async (ui, box) => {
      await open(ui, "Stripe live key")
      const before = reveals(await ui.calls()).length
      noSecretIn(ui.frames())

      await ui.type("r")
      const shown = await ui.waitUntil(showsValue)
      assert.include(shown, "Any key hides the value")
      assert.deepStrictEqual(reveals(await ui.calls()).slice(before), [
        { method: "POST", path: "/v1/admin/items/reveal", status: 200 },
      ])

      await ui.type("x")
      const hidden = await ui.waitUntil((frame) => !showsAnyOfValue(frame))
      assert.match(hidden, /> credential +\*{8}/)
      assert.strictEqual(reveals(await ui.calls()).length, before + 1)

      const audit = await box.run(["audit", "--passphrase-stdin"], { input: `${seedPassphrase}\n` })
      assert.strictEqual(audit.code, 0, audit.stderr)

      assert.deepStrictEqual(
        AuditPage(audit.stdout).entries.filter(({ action }) => action === "item.reveal"),
        [{ action: "item.reveal", references: ["hush://Personal/Stripe live key/credential"] }],
      )
    }))

  it("hides the value on its timer tick without a key", () =>
    withUi(async (ui) => {
      await open(ui, "GitHub")
      await ui.type("r")
      await ui.waitUntil(showsValue)

      const hidden = await ui.waitUntil((frame) => !showsAnyOfValue(frame))
      assert.match(hidden, /> password +\*{8}/)
      assert.include(hidden, "r reveal")
    }))

  it("Reveals the plain Field under the cursor the same way", () =>
    withUi(async (ui) => {
      await open(ui, "GitHub")
      ui.keys.pressArrow("down")
      await ui.waitFor("> username")
      await ui.type("r")

      assert.match(await ui.waitFor(username), /> username +fictional plain username 4Hd/)
    }))

  it("shows the CLI's integrity message when the stored value was modified, and no value", () =>
    withUi(async (ui, box) => {
      await box.inspect((db) => db.run("UPDATE fields SET sealed = zeroblob(length(sealed)) WHERE label = 'password'"))
      await open(ui, "GitHub")
      await ui.type("r")

      const refused = await ui.waitUntil((frame) =>
        flat(frame).includes(
          'Stored data for hush://Personal/GitHub/password failed its integrity check, so the database file was modified or corrupted; nothing was returned or changed. Restore the Server from a backup: see "Backup and restore" in the hush README.',
        ),
      )

      assert.match(refused, /> password +\*{8}/)
      noSecretIn(ui.frames())
    }))

  it("locks at the prompt saying the Passphrase is incorrect after the Passphrase was changed elsewhere", () =>
    withUi(async (ui, box) => {
      const changed = await box.run(["passphrase", "change", "--passphrase-stdin"], {
        input: `${seedPassphrase}\nfictional new passphrase 2Wd\n`,
      })

      assert.strictEqual(changed.code, 0, changed.stderr)
      await open(ui, "GitHub")
      await ui.type("r")

      const locked = await ui.waitFor("The Passphrase is incorrect.")
      assert.include(locked, "hush Passphrase:")
      assert.notInclude(locked, "GitHub")
      assert.lengthOf(reveals(await box.calls()), 1)

      noSecretIn(ui.frames())
    }))
})
