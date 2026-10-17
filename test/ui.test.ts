import { assert, describe, it } from "@effect/vitest"
import { Exit } from "effect"

import { type Headless, headless } from "./headless.js"
import { passphraseSentinel, valueSentinel } from "./leaks.js"
import { cli, onPty, type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// `hush ui` under the headless renderer against a real Server: what the Owner sees, what the Server is asked,
// and that no secret is ever drawn.

const prompt = "hush Passphrase:"

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

// Personal (two Items, one holding the value sentinel) and an empty Work Vault.
const seeded = async (box: Sandbox) => {
  await box.seed({
    items: [
      { kind: "api-credential", title: "Stripe live key", value: valueSentinel.text },
      { kind: "login", title: "GitHub", value: "fictional github password", plain: { username: "octo" } },
    ],
  })

  const created = await box.run(["vault", "create", "Work", "--passphrase-stdin"], { input: `${seedPassphrase}\n` })
  assert.strictEqual(created.code, 0, created.stderr)
}

const unlock = async (ui: Headless) => {
  await ui.waitFor(prompt)
  await ui.type(seedPassphrase)
  ui.keys.pressEnter()
  await ui.waitFor("Vaults")
}

const itemListCalls = (calls: ReadonlyArray<{ readonly path: string }>) =>
  calls.filter(({ path }) => path === "/v1/admin/items/list")

describe.skipIf(!serverSupported)("hush ui", () => {
  it("starts Locked, draws the Passphrase as a mask, and opens on the right Passphrase", () =>
    withUi(seeded, async (ui) => {
      await ui.waitFor(prompt)
      await ui.type("wrong passphrase")
      const masked = await ui.waitFor("*".repeat("wrong passphrase".length))
      assert.notInclude(masked, "wrong")

      ui.keys.pressEnter()
      await ui.waitFor("The Passphrase is incorrect")

      await ui.type(seedPassphrase)
      ui.keys.pressEnter()
      const open = await ui.waitFor("Stripe live key")
      assert.include(open, "GitHub")
      assert.include(open, "login")
      assert.include(open, "api-credential")
    }))

  it("shows the Server's wait after a backoff refusal, then opens once it has passed", () =>
    withUi(seeded, async (ui) => {
      await ui.waitFor(prompt)

      // Three free failures, then the fourth sets a 1 s delay that the fifth attempt runs into. Each attempt waits
      // for its answer in the request log, since the notice of the one before reads the same.
      for (const attempt of [1, 2, 3, 4]) {
        await ui.type(`wrong ${attempt}`)
        ui.keys.pressEnter()

        while ((await ui.calls()).length < attempt) await new Promise((wait) => setTimeout(wait, 20))
        await ui.waitUntil((frame) => !frame.includes("Checking"))
      }

      assert.include(ui.frame(), "The Passphrase is incorrect.")

      await ui.type("wrong 5")
      ui.keys.pressEnter()
      await ui.waitFor("Too many incorrect attempts. The Server checks the next attempt in 1 second.")
      await ui.waitFor("Too many incorrect attempts. Try again now.")

      await ui.type(seedPassphrase)
      ui.keys.pressEnter()
      await ui.waitFor("Stripe live key")
    }))

  it("tells the Owner to run `hush init` on an Uninitialised Server and stays Locked", () =>
    withUi(
      async () => {},
      async (ui, box) => {
        await ui.waitFor(prompt)
        await ui.type(seedPassphrase)
        ui.keys.pressEnter()
        const frame = await ui.waitFor("has not been initialised")

        assert.include(frame.replaceAll(/\s+/g, " "), "hush init --vault <name>")
        assert.include(frame, prompt)
        assert.deepStrictEqual(
          (await box.calls()).map(({ path }) => path),
          ["/v1/admin/vaults/list"],
        )
      },
    ))

  it("lists every Vault with its Item count in the sidebar", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      const frame = await ui.waitFor("Stripe live key")

      assert.match(frame, /> Personal\s+2/)
      assert.match(frame, / {2}Work\s+0/)
    }))

  it("asks for exactly one Item list per Vault selection", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      await ui.waitFor("Stripe live key")
      const before = (await ui.calls()).length

      ui.keys.pressArrow("down")
      ui.keys.pressEnter()
      await ui.waitFor("No Items in this Vault.")
      const selected = (await ui.calls()).slice(before)

      assert.deepStrictEqual(selected, [{ method: "POST", path: "/v1/admin/items/list", status: 200 }])
    }))

  it("narrows the Item list as the filter is typed, by every word of the title", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      await ui.waitFor("Stripe live key")

      await ui.type("/live STRIPE")
      const filtered = await ui.waitFor("/live STRIPE_")
      assert.include(filtered, "Stripe live key")
      assert.notInclude(filtered, "GitHub")

      ui.keys.pressEscape()
      const cleared = await ui.waitUntil((frame) => frame.includes("GitHub"))
      assert.include(cleared, "Stripe live key")
      assert.deepStrictEqual(itemListCalls(await ui.calls()).length, 1)
    }))

  it("quits on q, ending the UI and destroying the renderer", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      await ui.type("q")

      assert.isTrue(Exit.isSuccess(await ui.ended))
    }))
})

// A flag of `stty -a` set (not `-flag`).
const sttySet = (output: string, flag: string) => new RegExp(`(^|\\s)${flag}(\\s|$)`).test(output)

describe("hush ui at the command line", () => {
  it("refuses with UiNeedsTerminal when stdin and stdout are not terminals, before any request", async () => {
    const box = await cli()

    try {
      const result = await box.run(["ui"], { env: { HUSH_SERVER: "http://127.0.0.1:9" } })

      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(
        result.stderr,
        "hush: `hush ui` needs an interactive terminal, but stdin and stdout are not one; nothing was started. Run it yourself in a terminal, without pipes or redirection; agents cannot run it. Scripts use `hush vault list` and `hush item list <vault>` with `--passphrase-stdin`.\n",
      )
    } finally {
      await box.close()
    }
  })

  it.skipIf(!onPty || !serverSupported)(
    "draws the Locked prompt on a pty, opens on the Passphrase, and restores the terminal on q",
    async () => {
      const box = await sandbox()

      try {
        await seeded(box)

        const result = await box.run(["ui"], {
          tty: {
            keys: [
              { after: prompt, keys: `${seedPassphrase}\r` },
              // The renderer redraws only changed cells, so the match is a word drawn in one run.
              { after: "api-credential", keys: "q" },
            ],
            sttyAfter: true,
          },
        })

        assert.strictEqual(result.code, 0, result.stdout)
        assert.isTrue(sttySet(result.stdout, "icanon"), result.stdout)
        assert.isTrue(sttySet(result.stdout, "echo"), result.stdout)
        assert.notInclude(result.stdout, seedPassphrase)
        assert.deepStrictEqual(
          result.calls.map(({ path }) => path),
          ["/v1/admin/vaults/list", "/v1/admin/items/list"],
        )
      } finally {
        await box.close()
      }
    },
  )
})

describe.skipIf(!serverSupported)("hush ui leaks", () => {
  it("never draws the Passphrase or a value in any frame", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      await ui.waitFor("Stripe live key")
      ui.keys.pressArrow("down")
      ui.keys.pressEnter()
      await ui.waitFor("No Items")

      for (const frame of ui.frames()) {
        assert.notInclude(frame, seedPassphrase)
        assert.notInclude(frame, passphraseSentinel.text)
        assert.notInclude(frame, "fictional-only")
        assert.notInclude(frame, "fictional github password")
      }
    }))
})
