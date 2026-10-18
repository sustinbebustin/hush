import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"

import { Target } from "../src/cli/Target.js"
import { Clipboard } from "../src/ui/Clipboard.js"
import { Event } from "../src/ui/Event.js"
import { Interpreter } from "../src/ui/Interpreter.js"
import { ItemWrite } from "../src/ui/ItemWrite.js"
import { Problem } from "../src/ui/Problem.js"
import { UiEffect } from "../src/ui/UiEffect.js"
import { type FakeClipboard, fakeClipboard, type Headless, headless } from "./headless.js"
import { passphraseSentinel } from "./leaks.js"
import { type Call, type Sandbox, sandbox, seedPassphrase, serverSupported } from "./sandbox.js"

// Creating and editing Items in `hush ui` under the headless renderer against a real Server: the form for each Kind,
// the hidden concealed input (typed, pasted from the host clipboard, or a bracketed paste), the one write request per
// submit, the CLI's messages for each refusal, and that the concealed value never reaches a frame.

// One line, so it can be typed (a line break would submit the form).
const secret = "fictional-typed-secret-9Kp-é"

// On the fake host clipboard.
const pasted = "fictional-clipboard-secret-3Wq"

// A bracketed paste may span lines, as a private key does.
const multiline = "fictional-pasted-line-one-8Lz\nfictional-pasted-line-two-8Lz"

const withUi = async (
  body: (ui: Headless, box: Sandbox, clipboard: FakeClipboard) => Promise<void>,
  // `host` in place of the fake clipboard, or none.
  options: { readonly viaProxy?: boolean; readonly noClipboard?: boolean; readonly host?: Clipboard } = {},
): Promise<void> => {
  const box = await sandbox()
  const clipboard = fakeClipboard()

  try {
    await box.seed({ items: [{ kind: "login", title: "GitHub", value: secret, plain: { username: "octo" } }] })

    const ui = await headless(box, {
      clipboard: options.noClipboard === true ? Clipboard.none : (options.host ?? clipboard.clipboard),
      server: options.viaProxy === true ? box.proxy.url : box.server.url,
    })

    try {
      await ui.waitFor("hush Passphrase:")
      await ui.type(seedPassphrase)
      ui.keys.pressEnter()
      await ui.waitFor("GitHub")
      await body(ui, box, clipboard)
    } finally {
      await ui.close()
    }
  } finally {
    await box.close()
  }
}

// Whether the frame is the Item list again, listing `title`.
const listed = (title: string) => (frame: string) =>
  !frame.includes("New Item in") && !frame.includes("Loading...") && frame.includes(title)

const writes = (calls: ReadonlyArray<Call>, path: string) => calls.filter((call) => call.path === path)

// The stored value of `reference`, read back under the seed's Token.
const stored = async (box: Sandbox, reference: string) => {
  const read = await box.run(["read", reference], { secretStdout: true })
  assert.strictEqual(read.code, 0, read.stderr)

  return read.stdout
}

// A frame's text with box borders and line breaks folded to single spaces, so a wrapped message reads whole.
const flat = (frame: string) => frame.replaceAll(/[│\s]+/g, " ")

// The message the CLI prints for the same refusal, without its `hush: ` prefix: what the UI must show word for word.
// `value` follows the Passphrase on stdin for a command with `--stdin`; undefined for one without.
const cliMessage = async (box: Sandbox, args: ReadonlyArray<string>, value: string | undefined) => {
  const input = value === undefined ? `${seedPassphrase}\n` : `${seedPassphrase}\n${value}\n`
  const refused = await box.run([...args, "--passphrase-stdin"], { input })
  assert.strictEqual(refused.code, 1, refused.stdout)

  return refused.stderr.replace(/^hush: /, "").trim()
}

// From the sidebar, Tab to the Item rows (where `c` creates an Item; on the sidebar it creates a Vault), then `c`.
const openCreate = async (ui: Headless, vault = "Personal") => {
  ui.keys.pressTab()
  await ui.type("c")
  await ui.waitFor(`New Item in ${vault}`)
}

// Opens the create form, chooses the Kind `steps` Space presses from api-credential, and types the title and the
// concealed value.
const fill = async (ui: Headless, { steps = 0, title }: { readonly steps?: number; readonly title: string }) => {
  await openCreate(ui)
  await ui.type(" ".repeat(steps))
  ui.keys.pressArrow("down")
  await ui.type(title)
  ui.keys.pressArrow("down")
  await ui.type(secret)
  await ui.waitFor("*".repeat([...secret].length))
}

const noSecretIn = (frames: ReadonlyArray<string>, ...secrets: ReadonlyArray<string>) => {
  for (const frame of frames) {
    for (const text of [secret, ...secrets]) assert.notInclude(frame, text)
    assert.notInclude(frame, seedPassphrase)
    assert.notInclude(frame, passphraseSentinel.text)
  }
}

describe.skipIf(!serverSupported)("hush ui create", () => {
  it("creates an api-credential Item from a typed hidden value with one admin/items/create, then lists it", () =>
    withUi(async (ui, box) => {
      await openCreate(ui)
      ui.keys.pressArrow("down")
      await ui.type("Stripe live key")
      ui.keys.pressArrow("down")
      await ui.type(secret)
      await ui.waitFor("*".repeat([...secret].length))
      ui.keys.pressEnter()

      await ui.waitUntil(listed("Stripe live key"))
      assert.strictEqual(writes(await ui.calls(), "/v1/admin/items/create").length, 1)
      assert.strictEqual(await stored(box, "hush://Personal/Stripe live key/credential"), secret)
      noSecretIn(ui.frames())
    }))

  it("creates a login Item with its password read from the host clipboard by the paste key, never drawn", () =>
    withUi(async (ui, box, clipboard) => {
      clipboard.put(pasted)
      await openCreate(ui)
      await ui.type(" ")
      await ui.waitUntil((frame) => /> kind +login/.test(frame))
      ui.keys.pressArrow("down")
      await ui.type("Mail")
      ui.keys.pressArrow("down")
      assert.include(await ui.waitFor("> password"), "Ctrl-V paste")
      ui.keys.pressKey("v", { ctrl: true })
      await ui.waitFor("*".repeat(pasted.length))
      ui.keys.pressArrow("down")
      await ui.type("someone@example.com")
      const form = await ui.waitFor("someone@example.com")
      assert.match(form, /> username +someone@example\.com/)
      assert.match(form, / {2}notes +\(optional\)/)
      ui.keys.pressEnter()

      await ui.waitUntil(listed("Mail"))
      assert.strictEqual(clipboard.reads(), 1)
      assert.strictEqual(writes(await ui.calls(), "/v1/admin/items/create").length, 1)
      assert.strictEqual(await stored(box, "hush://Personal/Mail/password"), pasted)
      assert.strictEqual(await stored(box, "hush://Personal/Mail/username"), "someone@example.com")
      noSecretIn(ui.frames(), pasted)
    }))

  it("creates a database Item with every plain Field, its password from a bracketed paste, never drawn", () =>
    withUi(async (ui, box) => {
      await openCreate(ui)
      await ui.type("  ")
      await ui.waitUntil((frame) => /> kind +database/.test(frame))
      ui.keys.pressArrow("down")
      await ui.type("Orders DB")
      ui.keys.pressArrow("down")
      await ui.keys.pasteBracketedText(multiline)
      // Both lines and the break between them, drawn as a mask.
      await ui.waitFor("(59 characters)")
      const plain = { username: "orders", host: "db.internal", port: "5432", database: "orders_main", notes: "primary" }

      for (const text of Object.values(plain)) {
        ui.keys.pressArrow("down")
        await ui.type(text)
      }

      await ui.waitFor("primary")
      ui.keys.pressEnter()

      await ui.waitUntil(listed("Orders DB"))
      assert.strictEqual(writes(await ui.calls(), "/v1/admin/items/create").length, 1)
      assert.strictEqual(await stored(box, "hush://Personal/Orders DB/password"), multiline)

      for (const [label, text] of Object.entries(plain))
        assert.strictEqual(await stored(box, `hush://Personal/Orders DB/${label}`), text)
      noSecretIn(ui.frames(), ...multiline.split("\n"))
    }))

  it("creates the first Item of an empty Vault", () =>
    withUi(async (ui, box) => {
      const created = await box.run(["vault", "create", "Work", "--passphrase-stdin"], { input: `${seedPassphrase}\n` })
      assert.strictEqual(created.code, 0, created.stderr)
      // The sidebar was listed before Work existed: it appears once the UI lists the Vaults again, on the next Open.
      await ui.type("q")
      await ui.ended

      const again = await headless(box)

      try {
        await again.waitFor("hush Passphrase:")
        await again.type(seedPassphrase)
        again.keys.pressEnter()
        await again.waitFor("Work")
        again.keys.pressArrow("down")
        again.keys.pressEnter()
        await again.waitFor("No Items in this Vault.")
        await openCreate(again, "Work")
        again.keys.pressArrow("down")
        await again.type("First key")
        again.keys.pressArrow("down")
        await again.type(secret)
        again.keys.pressEnter()

        await again.waitUntil(listed("First key"))

        // The seed's Token has no Grant on Work, so the value is read back under the Passphrase.
        const revealed = await box.run(["item", "reveal", "hush://Work/First key/credential", "--passphrase-stdin"], {
          input: `${seedPassphrase}\n`,
          secretStdout: true,
        })

        assert.strictEqual(revealed.code, 0, revealed.stderr)
        assert.strictEqual(revealed.stdout, secret)
      } finally {
        await again.close()
      }
    }))

  it("offers no paste key on a host without a clipboard, and a press says so without reading anything", () =>
    withUi(
      async (ui) => {
        await fill(ui, { title: "Stripe live key" })
        assert.notInclude(ui.frame(), "Ctrl-V")
        ui.keys.pressKey("v", { ctrl: true })

        await ui.waitUntil((frame) =>
          flat(frame).includes(
            "This machine has no clipboard the UI can read (it needs macOS, Wayland or X11), so nothing was pasted.",
          ),
        )

        ui.keys.pressEnter()
        await ui.waitUntil((frame) => !frame.includes("no clipboard"))
        assert.include(ui.frame(), "*".repeat([...secret].length))
      },
      { noClipboard: true },
    ))

  it("says when the host clipboard holds no text", () =>
    withUi(async (ui, _box, clipboard) => {
      clipboard.put(undefined)
      await fill(ui, { title: "Stripe live key" })
      ui.keys.pressKey("v", { ctrl: true })

      await ui.waitUntil((frame) => flat(frame).includes("The clipboard holds no text, so nothing was pasted."))
      assert.strictEqual(clipboard.reads(), 1)
    }))

  // `checked`: refused by a check the UI makes before sending, as the CLI does, so the concealed buffer is kept; the
  // Server's refusal comes after the buffer left with the write.
  const refusals = [
    {
      name: "ItemExists",
      checked: false,
      title: "GitHub",
      steps: 1,
      cli: ["item", "create", "login", "--vault", "Personal", "--title", "GitHub", "--stdin"],
    },
    {
      name: "InvalidValue",
      checked: true,
      title: "Stripe live key",
      notes: "   ",
      cli: [
        "item",
        "create",
        "api-credential",
        "--vault",
        "Personal",
        "--title",
        "Stripe live key",
        "--notes",
        "   ",
        "--stdin",
      ],
    },
  ] as const

  for (const { name, checked, title, cli, ...rest } of refusals)
    it(`shows the CLI's ${name} message and keeps the form, its concealed buffer ${checked ? "kept" : "dropped"}`, () =>
      withUi(async (ui, box) => {
        const message = await cliMessage(box, cli, secret)
        await fill(ui, { title, steps: "steps" in rest ? rest.steps : 0 })

        if ("notes" in rest) {
          ui.keys.pressArrow("down")
          await ui.type(rest.notes)
        }

        ui.keys.pressEnter()
        await ui.waitUntil((frame) => flat(frame).includes(message))
        ui.keys.pressEnter()

        const form = await ui.waitUntil((frame) => !frame.includes("nothing was"))
        assert.include(form, `New Item in Personal`)

        if (checked) assert.match(form, new RegExp(`credential +\\*{${[...secret].length}}`))
        else assert.match(form, /(password|credential) +\(required, hidden\)/)
        noSecretIn(ui.frames())
      }))

  it("shows the CLI's TitleRetired message for a title freed by a delete", () =>
    withUi(async (ui, box) => {
      const deleted = await box.run(["item", "delete", "Personal", "GitHub", "--passphrase-stdin"], {
        input: `${seedPassphrase}\n`,
      })

      assert.strictEqual(deleted.code, 0, deleted.stderr)

      const message = await cliMessage(
        box,
        ["item", "create", "login", "--vault", "Personal", "--title", "GitHub", "--stdin"],
        secret,
      )

      await fill(ui, { title: "GitHub", steps: 1 })
      ui.keys.pressEnter()

      await ui.waitUntil((frame) => flat(frame).includes(message))
      assert.include(message, "was freed by a rename or delete")
    }))

  it("says the create is unverified, not to retry, when the answer is lost, and does not refresh the list", () =>
    withUi(
      async (ui, box) => {
        await fill(ui, { title: "Stripe live key" })
        const before = await ui.calls()
        box.proxy.mode("drop-response")
        ui.keys.pressEnter()

        await ui.waitUntil((frame) =>
          flat(frame).includes(
            "The connection failed after the request was sent, so the change may or may not have happened. Do not retry blindly; check with `hush vault list`, `hush token list` or `hush inventory`.",
          ),
        )

        box.proxy.mode("pass")
        const after = (await ui.calls()).slice(before.length)
        assert.deepStrictEqual(
          after.map(({ path }) => path),
          ["/v1/admin/items/create"],
        )
        assert.include(ui.frame(), "New Item in Personal")
      },
      { viaProxy: true },
    ))
})

// Opens GitHub's detail and the edit form on its Field `down` rows below the password.
const editing = async (ui: Headless, down = 0) => {
  await ui.type("/GitHub")
  ui.keys.pressEnter()
  ui.keys.pressTab()
  ui.keys.pressEnter()
  await ui.waitFor("Created")

  for (let row = 0; row < down; row += 1) ui.keys.pressArrow("down")
  await ui.type("e")

  return ui.waitFor("Edit Personal / GitHub")
}

// Back on the detail after a verified edit.
const detailShown = (frame: string) => frame.includes("Created") && !frame.includes("Edit Personal")

const edits = async (ui: Headless) => writes(await ui.calls(), "/v1/admin/items/edit").length

describe.skipIf(!serverSupported)("hush ui edit", () => {
  it("sets a plain Field with one admin/items/edit and returns to the detail", () =>
    withUi(async (ui, box) => {
      const form = await editing(ui, 1)
      assert.match(form, /> username +\(unchanged: type a new value\)/)
      assert.match(form, / {2}password +\*{8}/)
      await ui.type("hubot")
      await ui.waitFor("hubot")
      ui.keys.pressEnter()

      assert.match(await ui.waitUntil(detailShown), /> username/)
      assert.strictEqual(await edits(ui), 1)
      assert.strictEqual(await stored(box, "hush://Personal/GitHub/username"), "hubot")
      noSecretIn(ui.frames())
    }))

  it("adds an absent plain Field", () =>
    withUi(async (ui, box) => {
      await editing(ui)
      ui.keys.pressArrow("down")
      ui.keys.pressArrow("down")
      assert.match(await ui.waitFor("> notes"), /> notes +\(absent: type a value to add\)/)
      await ui.type("work account")
      await ui.waitFor("work account")
      ui.keys.pressEnter()

      assert.include(await ui.waitUntil(detailShown), "hush://Personal/GitHub/notes")
      assert.strictEqual(await edits(ui), 1)
      assert.strictEqual(await stored(box, "hush://Personal/GitHub/notes"), "work account")
    }))

  it("removes a present plain Field with Ctrl-D", () =>
    withUi(async (ui, box) => {
      await editing(ui, 1)
      ui.keys.pressKey("d", { ctrl: true })
      await ui.waitFor("(remove this Field)")
      ui.keys.pressEnter()

      assert.notInclude(await ui.waitUntil(detailShown), "hush://Personal/GitHub/username")
      assert.strictEqual(await edits(ui), 1)
      const read = await box.run(["read", "hush://Personal/GitHub/username"])
      assert.strictEqual(read.code, 1, read.stdout)
    }))

  it("replaces the concealed value through the hidden field and the paste key, never drawn", () =>
    withUi(async (ui, box, clipboard) => {
      clipboard.put(pasted)
      const form = await editing(ui)
      assert.match(form, /> password +\(unchanged: type a new value, hidden\)/)
      assert.include(form, "Ctrl-V paste")
      await ui.type("typed-")
      ui.keys.pressKey("v", { ctrl: true })
      await ui.waitFor("*".repeat("typed-".length + pasted.length))
      ui.keys.pressEnter()

      await ui.waitUntil(detailShown)
      assert.strictEqual(await edits(ui), 1)
      assert.strictEqual(await stored(box, "hush://Personal/GitHub/password"), `typed-${pasted}`)
      noSecretIn(ui.frames(), pasted, `typed-${pasted}`)
    }))

  it("shows the CLI's FieldRequired message when the concealed Field is removed, and stays on the form", () =>
    withUi(async (ui, box) => {
      const message = await cliMessage(box, ["item", "edit", "Personal", "GitHub", "--remove", "password"], undefined)
      await editing(ui)
      ui.keys.pressKey("d", { ctrl: true })
      await ui.waitFor("(remove this Field)")
      ui.keys.pressEnter()

      await ui.waitUntil((frame) => flat(frame).includes(message))
      assert.include(message, "need their password Field")
      assert.strictEqual(await stored(box, "hush://Personal/GitHub/password"), secret)
    }))

  it("shows the CLI's InvalidValue message for an empty replacement, sending nothing", () =>
    withUi(async (ui, box) => {
      const message = await cliMessage(
        box,
        ["item", "edit", "Personal", "GitHub", "--field", "password", "--stdin"],
        "",
      )

      await editing(ui)
      const before = await edits(ui)
      ui.keys.pressEnter()

      await ui.waitUntil((frame) => flat(frame).includes(message))
      assert.strictEqual(await edits(ui), before)
    }))

  it("returns to the detail on Esc without a request", () =>
    withUi(async (ui) => {
      await editing(ui, 1)
      await ui.type("draft")
      ui.keys.pressEscape()

      assert.match(await ui.waitUntil(detailShown), /> username/)
      assert.strictEqual(await edits(ui), 0)
    }))
})

// The form offers only its Kind's Fields, so no key reaches `UnknownField`; the write it would send is run here
// through the interpreter against the real Server instead.
describe.skipIf(!serverSupported)("hush ui internal errors", () => {
  it("locks with a fixed notice when an effect dies, instead of waiting on it forever", () =>
    withUi(
      async (ui) => {
        await openCreate(ui)
        ui.keys.pressArrow("down")
        ui.keys.pressArrow("down")
        await ui.waitFor("> credential")
        ui.keys.pressKey("v", { ctrl: true })

        const locked = await ui.waitFor("internal error")
        assert.include(locked, "hush Passphrase:")
        assert.notInclude(locked, "Reading the clipboard")
      },
      {
        host: {
          available: true,
          write: () => Effect.succeed("unsupported"),
          read: Effect.die(new Error("fictional clipboard defect")),
        },
      },
    ))
})

describe.skipIf(!serverSupported)("hush ui Item write refusals", () => {
  it("shows the CLI's UnknownField message for a Field the Kind lacks", async () => {
    const box = await sandbox()

    try {
      await box.seed({ items: [{ kind: "login", title: "GitHub", value: secret }] })
      const message = await cliMessage(box, ["item", "edit", "Personal", "GitHub", "--remove", "nosuch"], undefined)

      const target = await Effect.runPromise(
        Target.load({ HOME: box.home, HUSH_SERVER: box.server.url, HUSH_PROXY: "direct" }),
      )

      const write = ItemWrite.Edit({ vault: "Personal", item: "GitHub", change: { remove: "nosuch" } })

      const answer = await Effect.runPromise(
        Interpreter.run(
          target,
          UiEffect.SaveItem({ passphrase: Redacted.make(seedPassphrase), write }),
          Clipboard.none,
        ),
      )

      assert.deepStrictEqual(answer, Event.ItemSaveRefused({ problem: Problem.Failed({ message }) }))
      assert.include(message, "have no Field nosuch")
    } finally {
      await box.close()
    }
  })
})
