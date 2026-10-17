import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { type Headless, headless } from "./headless.js"
import { passphraseSentinel, valueSentinel } from "./leaks.js"
import { type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// The Audit view of `hush ui` against a real Server holding more entries than one page: what the frame shows,
// and how many `admin/audit` requests filtering and paging send.

const prompt = "hush Passphrase:"

const withUi = async (body: (ui: Headless, box: Sandbox, logged: number) => Promise<void>): Promise<void> => {
  const box = await sandbox()

  try {
    const logged = await seeded(box)
    const ui = await headless(box)

    try {
      await body(ui, box, logged)
    } finally {
      await ui.close()
    }
  } finally {
    await box.close()
  }
}

const Printed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ token: Schema.String })))

const Page = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ entries: Schema.Array(Schema.Unknown), next: Schema.optionalKey(Schema.Number) }),
  ),
)

// One `token.describe` entry made with `token`: a cheap audited request, no Passphrase involved.
const describeWith = async (box: Sandbox, token: string) => {
  const response = await box.fetch("/v1/token/describe", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  })

  assert.strictEqual(response.status, 200)
}

// Personal with one Item and the Token "agent on box"; Work, and the Token "deploy bot" reading it; 110 describes
// by "agent on box", then one by "deploy bot": more than the Server's default page of 100. Returns how many
// entries the log held before the UI opened, counted by `hush audit` (whose own read is one more).
const seeded = async (box: Sandbox): Promise<number> => {
  const { token } = await box.seed({
    items: [{ kind: "api-credential", title: "Stripe live key", value: valueSentinel.text }],
  })

  const admin = (args: ReadonlyArray<string>, secretStdout = false) =>
    box.run([...args, "--passphrase-stdin"], { input: `${seedPassphrase}\n`, secretStdout })

  assert.strictEqual((await admin(["vault", "create", "Work"])).code, 0)
  const issued = await admin(["token", "issue", "--label", "deploy bot", "--read", "Work", "--print"], true)
  assert.strictEqual(issued.code, 0, issued.stderr)

  for (let n = 0; n < 110; n += 1) await describeWith(box, token)
  await describeWith(box, Printed(issued.stdout).token)

  const counted = await admin(["audit", "--limit", "1000"])
  assert.strictEqual(counted.code, 0, counted.stderr)

  return Page(counted.stdout).entries.length + 1
}

// The UI's `admin/audit` requests so far: every one after the seed's own `hush audit`.
const auditCalls = async (ui: Headless) =>
  (await ui.calls()).filter(({ path }) => path === "/v1/admin/audit").length - 1

// Unlocks, then moves past Personal and Work to Audit and selects it.
const openAudit = async (ui: Headless) => {
  await ui.waitFor(prompt)
  await ui.type(seedPassphrase)
  ui.keys.pressEnter()
  await ui.waitFor("Stripe live key")
  ui.keys.pressArrow("down")
  ui.keys.pressArrow("down")
  ui.keys.pressEnter()

  return ui.waitFor("token.describe")
}

const pageDown = "\x1b[6~"
const pageUp = "\x1b[5~"

describe.skipIf(!serverSupported)("hush ui Audit", () => {
  it("lists the Audit Log newest first from one request, a row per entry", () =>
    withUi(async (ui) => {
      const frame = await openAudit(ui)

      assert.match(frame, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+deploy bot\s+token\.describe/)
      assert.notInclude(frame, "init ")
      assert.strictEqual(await auditCalls(ui), 1)
    }))

  it("loads the next page at the bottom with one request, appending until no page is left", () =>
    withUi(async (ui, _box, logged) => {
      assert.include(await openAudit(ui), "100 entries, from row 1, older entries load at the bottom")

      // PgDn moves ten rows; the bottom of the first page is in view from row 91.
      for (let row = 11; row <= 81; row += 10) {
        ui.keys.pressKey(pageDown)
        await ui.waitFor(`from row ${row}, older entries`)
      }

      assert.strictEqual(await auditCalls(ui), 1)
      ui.keys.pressKey(pageDown)

      // Every entry exactly once: the seeded ones, the UI's unlock (`vault.list`) and Personal's `item.list`, from
      // the first page and the one below its `next`; never the UI's own reads, which each page's request writes.
      const total = logged + 2
      await ui.waitFor(`${total} entries, from row 91, end of the log`)
      assert.strictEqual(await auditCalls(ui), 2)

      ui.keys.pressKey(pageDown)
      ui.keys.pressKey(pageDown)
      const end = await ui.waitFor(`from row ${total - 9}, end of the log`)
      assert.match(end, /init\s+init\s+Personal/, end)
      assert.strictEqual(await auditCalls(ui), 2)

      for (let n = 0; n < 30; n += 1) ui.keys.pressKey(pageUp)
      assert.match(await ui.waitFor("deploy bot  "), /deploy bot\s+token\.describe/)
    }))

  it("narrows the rows to a Vault, then to a Label, with one first-page request per change", () =>
    withUi(async (ui) => {
      await openAudit(ui)

      await ui.type("/Work")
      ui.keys.pressEnter()
      const work = await ui.waitFor("vault.create")
      assert.include(work, "Vault: Work")
      assert.notInclude(work, "token.describe")
      assert.notInclude(work, "items.create")
      assert.strictEqual(await auditCalls(ui), 2)

      ui.keys.pressKey("/")

      for (let n = 0; n < 4; n += 1) ui.keys.pressBackspace()

      ui.keys.pressTab()
      await ui.type("deploy bot")
      ui.keys.pressEnter()
      const bot = await ui.waitUntil((frame) => frame.includes("token.describe") && !frame.includes("vault.create"))
      assert.include(bot, "Label: deploy bot")
      assert.notInclude(bot, "agent on box")
      assert.include(bot, "1 entry, from row 1, end of the log")
      assert.strictEqual(await auditCalls(ui), 3)

      ui.keys.pressEscape()
      await ui.waitFor("agent on box")
      assert.strictEqual(await auditCalls(ui), 4)

      for (const frame of ui.frames()) {
        assert.notInclude(frame, seedPassphrase)
        assert.notInclude(frame, passphraseSentinel.text)
        assert.notInclude(frame, valueSentinel.text)
      }
    }))
})
