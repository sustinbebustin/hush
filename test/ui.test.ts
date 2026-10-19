import { assert, describe, it } from "@effect/vitest"
import { Exit, Predicate, Schema } from "effect"

import { type Headless, headless } from "./headless.js"
import { passphraseSentinel, valueSentinel } from "./leaks.js"
import { garbledMarker } from "./proxy.js"
import { cli, jobStopped, onPty, type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// `hush ui` under the headless renderer against a real Server: what the Owner sees, what the Server is asked,
// and that no secret is ever drawn.

const prompt = "hush Passphrase:"

const withUi = async (
  seed: (box: Sandbox) => Promise<void>,
  body: (ui: Headless, box: Sandbox) => Promise<void>,
  options: { readonly viaProxy?: boolean; readonly width?: number; readonly height?: number } = {},
): Promise<void> => {
  const box = await sandbox()

  try {
    await seed(box)
    const { viaProxy, ...size } = options
    const ui = await headless(box, viaProxy === true ? { server: box.proxy.url, ...size } : size)

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

const WrongPassphraseAnswer = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.TaggedStruct("PassphraseIncorrect", { retryAfterSeconds: Schema.Number }),
    Schema.TaggedStruct("BackoffActive", { retryAfterSeconds: Schema.Number }),
  ]),
)

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

// Sends wrong Passphrases over raw HTTP, each once the previous delay ran out, until one pins the backoff for at
// least `seconds`: long enough that the UI's next attempt runs into it however loaded the suite is.
const pinBackoff = async (box: Sandbox, seconds: number) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await box.fetch("/v1/admin/vaults/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "a wrong fictional passphrase" }),
    })

    const answer = WrongPassphraseAnswer(await response.json())

    if (Predicate.isTagged(answer, "PassphraseIncorrect") && answer.retryAfterSeconds >= seconds) return

    if (Predicate.isTagged(answer, "BackoffActive")) await sleep(answer.retryAfterSeconds)
  }

  throw new Error(`the backoff did not pin for ${seconds} s after 20 wrong Passphrases`)
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
    withUi(seeded, async (ui, box) => {
      await ui.waitFor(prompt)
      await pinBackoff(box, 4)

      await ui.type(seedPassphrase)
      ui.keys.pressEnter()
      const waiting = await ui.waitFor("Too many incorrect attempts. The Server checks the next attempt in")
      assert.match(waiting, /next attempt in \d+ seconds?\./)
      await ui.waitFor("Too many incorrect attempts. Try again now.")

      await ui.type(seedPassphrase)
      ui.keys.pressEnter()
      assert.include(await ui.waitFor("Stripe live key"), "Vaults")
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

const tenMinutes = 10 * 60 * 1_000

// Ten minutes idle on the UI's clock: one real tick first, so the idle time has started from the last keypress.
const idleTenMinutes = async (ui: Headless) => {
  await sleep(1.5)
  ui.advanceClock(tenMinutes)
}

describe.skipIf(!serverSupported)("hush ui lock paths", () => {
  it("locks after ten minutes without a keypress and opens again at the Vault sidebar on the Passphrase", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      await ui.waitFor("Stripe live key")
      ui.keys.pressArrow("down")
      await ui.waitFor("> Work")

      await idleTenMinutes(ui)
      const locked = await ui.waitFor(prompt)
      assert.notInclude(locked, "Stripe live key")
      assert.notInclude(locked, "Work")

      await ui.type(seedPassphrase)
      ui.keys.pressEnter()
      const reopened = await ui.waitFor("Stripe live key")
      assert.match(reopened, /> Personal\s+2/)

      assert.deepStrictEqual(
        (await ui.calls()).map(({ path }) => path).filter((path) => path.endsWith("/list")),
        ["/v1/admin/vaults/list", "/v1/admin/items/list", "/v1/admin/vaults/list", "/v1/admin/items/list"],
      )
    }))

  it("drops the answer to a request in flight when the UI locks", () =>
    withUi(
      seeded,
      async (ui, box) => {
        await unlock(ui)
        await ui.waitFor("Stripe live key")

        box.proxy.mode("hold-response")
        ui.keys.pressArrow("down")
        ui.keys.pressEnter()
        await ui.waitFor("Loading...")
        await idleTenMinutes(ui)
        await ui.waitFor(prompt)
        assert.lengthOf(itemListCalls(await ui.calls()), 2)

        box.proxy.mode("pass")
        await sleep(0.5)
        const after = await ui.waitFor(prompt)
        assert.notInclude(after, "No Items")

        await ui.type(seedPassphrase)
        ui.keys.pressEnter()
        assert.include(await ui.waitFor("Stripe live key"), "> Personal")

        for (const frame of ui.frames()) assert.notInclude(frame, "No Items in this Vault.")
      },
      { viaProxy: true },
    ))

  it("quits on an exit signal such as SIGHUP, ending the UI and destroying the renderer", () =>
    withUi(seeded, async (ui) => {
      await unlock(ui)
      await ui.waitFor("Stripe live key")
      process.emit("SIGHUP", "SIGHUP")

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

  it.skipIf(!onPty || !serverSupported)(
    "locks on Ctrl-Z, gives the terminal back while stopped, and shows the Locked prompt after `fg`",
    async () => {
      const box = await sandbox()

      try {
        await seeded(box)

        const result = await box.run(["ui"], {
          tty: {
            keys: [
              { after: prompt, keys: `${seedPassphrase}\r` },
              { after: "api-credential", keys: "\x1a" },
              // Past the shell's notice, so the prompt matched next is the one drawn after `fg`.
              { after: jobStopped, keys: "" },
              { after: "Passphrase", keys: `${seedPassphrase}\r` },
              { after: "api-credential", keys: "q" },
            ],
            jobControl: true,
            sttyAfter: true,
          },
        })

        assert.strictEqual(result.code, 0, result.stdout)
        // While stopped, the terminal is back in its own mode, off the alternate screen.
        const stopped = result.stdout.slice(0, result.stdout.indexOf(jobStopped))
        assert.isTrue(stopped.lastIndexOf("\x1b[?1049l") > stopped.lastIndexOf("\x1b[?1049h"), result.stdout)
        assert.isTrue(sttySet(result.stdout, "icanon"), result.stdout)
        assert.notInclude(result.stdout, seedPassphrase)
        assert.deepStrictEqual(
          result.calls.map(({ path }) => path),
          ["/v1/admin/vaults/list", "/v1/admin/items/list", "/v1/admin/vaults/list", "/v1/admin/items/list"],
        )
      } finally {
        await box.close()
      }
    },
  )
})

// The smallest frame the UI lays out.
const minimum = { width: 80, height: 24 } as const

describe.skipIf(!serverSupported)("hush ui help, resize and notices", () => {
  it("opens the help of the Item rows on ?, and closes it on the next key with nothing sent", () =>
    withUi(
      seeded,
      async (ui) => {
        await unlock(ui)
        await ui.waitFor("Stripe live key")
        ui.keys.pressTab()
        // The whole hint bar fits the 80 columns.
        assert.include(await ui.waitFor("n rename"), "? help  q quit")
        const before = (await ui.calls()).length

        ui.keys.pressKey("?")
        const help = await ui.waitFor("rename the Item")
        assert.include(help, "release the Retired title")
        assert.include(help, "Any key closes the help")

        ui.keys.pressKey("x")
        const closed = await ui.waitUntil((frame) => !frame.includes("rename the Item"))
        assert.include(closed, "Stripe live key")
        assert.strictEqual((await ui.calls()).length, before)
      },
      minimum,
    ))

  it("draws one notice below 80x24, takes no key there but Ctrl-C, and redraws the view on a resize back", () =>
    withUi(
      seeded,
      async (ui) => {
        await unlock(ui)
        await ui.waitFor("Stripe live key")
        const before = (await ui.calls()).length

        ui.resize(60, 20)
        const small = await ui.waitFor("needs 80x24")
        assert.include(small, "60x20")
        assert.notInclude(small, "Stripe live key")

        // Neither quits nor selects anything the Owner cannot see.
        ui.keys.pressKey("q")
        ui.keys.pressArrow("down")
        ui.keys.pressEnter()

        ui.resize(minimum.width, minimum.height)
        const back = await ui.waitFor("Stripe live key")
        assert.match(back, /> Personal\s+2/)
        assert.strictEqual((await ui.calls()).length, before)

        ui.resize(120, 40)
        assert.include(await ui.waitFor("Stripe live key"), "GitHub")
      },
      minimum,
    ))

  it("locks on a Passphrase changed elsewhere, at the prompt saying why, after the one request that found out", () =>
    withUi(seeded, async (ui, box) => {
      await unlock(ui)
      await ui.waitFor("Stripe live key")

      const changed = await box.run(["passphrase", "change", "--passphrase-stdin"], {
        input: `${seedPassphrase}\na new fictional passphrase\n`,
      })

      assert.strictEqual(changed.code, 0, changed.stderr)
      const before = (await ui.calls()).length

      ui.keys.pressArrow("down")
      ui.keys.pressEnter()
      const locked = await ui.waitFor("The Passphrase is incorrect.")
      assert.include(locked, prompt)
      assert.notInclude(locked, "Stripe live key")
      assert.notInclude(locked, "Notice")

      await sleep(0.5)
      assert.deepStrictEqual((await ui.calls()).slice(before), [
        { method: "POST", path: "/v1/admin/items/list", status: 401 },
      ])
    }))

  it("shows an answer it cannot decode as the CLI's fixed message, never the response body", () =>
    withUi(
      seeded,
      async (ui, box) => {
        await unlock(ui)
        await ui.waitFor("Stripe live key")

        box.proxy.mode("garble-response")
        ui.keys.pressArrow("down")
        ui.keys.pressEnter()
        const notice = await ui.waitFor("understand")
        assert.include(notice, "Notice")

        for (const frame of ui.frames()) assert.notInclude(frame, garbledMarker)
      },
      { viaProxy: true },
    ))
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
