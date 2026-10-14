import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { passphraseSentinel, scan, type Sentinel, valueSentinel } from "./leaks.js"
import { sandbox, type Sandbox } from "./sandbox.js"

// `hush audit`, the Audit Log reader, through the seam: filters, paging, outcomes, what is never recorded, and
// that nothing secret reaches the log or its output.

const passphrase = passphraseSentinel.text
const value = valueSentinel.text

// Runs `test`, then asserts that no sentinel, Init code or Token seen during the test reached anything observable
// it does not belong in, `hush audit` output included.
const withSandbox = async (test: (box: Sandbox, seen: (sentinel: Sentinel) => void) => Promise<void>) => {
  const box = await sandbox()
  const sentinels: Array<Sentinel> = [valueSentinel, passphraseSentinel]

  try {
    await test(box, (sentinel) => sentinels.push(sentinel))
    assert.deepStrictEqual(scan(await box.observable(), sentinels), [])
  } finally {
    await box.close()
  }
}

// `seed`, with its Token and the Init code it used registered as sentinels.
const seeded = async (box: Sandbox, seen: (sentinel: Sentinel) => void, spec?: Parameters<Sandbox["seed"]>[0]) => {
  const code = await box.server.initCode()

  if (code !== undefined) seen({ kind: "initCode", text: code })
  const result = await box.seed(spec)
  seen({ kind: "token", text: result.token })

  return result
}

const call = (path: string, status: number) => ({ method: "POST", path, status })

const Entry = Schema.Struct({
  id: Schema.Number,
  at: Schema.String,
  lastAt: Schema.String,
  count: Schema.Number,
  actor: Schema.Unknown,
  action: Schema.String,
  vaults: Schema.Array(Schema.String),
  references: Schema.Array(Schema.String),
  detail: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.String,
  error: Schema.optionalKey(Schema.String),
  peer: Schema.optionalKey(Schema.String),
})

type Entry = typeof Entry.Type

const Page = Schema.fromJsonString(
  Schema.Struct({ entries: Schema.Array(Entry), next: Schema.optionalKey(Schema.Number) }),
)

// `hush audit` with the Passphrase piped; a successful run's page decoded.
const audit = async (box: Sandbox, args: ReadonlyArray<string> = []) => {
  const result = await box.run(["audit", ...args, "--passphrase-stdin"], { input: `${passphrase}\n` })
  assert.strictEqual(result.code, 0, result.stderr)

  return { ...result, page: Schema.decodeUnknownSync(Page)(result.stdout) }
}

const Printed = Schema.fromJsonString(Schema.Struct({ token: Schema.String }))

// `token issue ... --print`: the issued Token.
const issuePrinted = async (box: Sandbox, args: ReadonlyArray<string>) => {
  const result = await box.run(["token", "issue", ...args, "--print", "--passphrase-stdin"], {
    input: `${passphrase}\n`,
    secretStdout: true,
  })

  assert.strictEqual(result.code, 0, result.stderr)

  return Schema.decodeUnknownSync(Printed)(result.stdout)
}

// What an entry says, without its id and times.
const gist = ({ actor, action, vaults, references, detail, outcome, error, count }: Entry) => ({
  actor,
  action,
  vaults,
  references,
  ...(detail === undefined ? {} : { detail }),
  outcome,
  ...(error === undefined ? {} : { error }),
  count,
})

describe("hush audit", () => {
  it("lists entries newest first under the Passphrase, its own read recorded as audit.read", () =>
    withSandbox(async (box, seen) => {
      const { references } = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const first = await audit(box)
      assert.deepStrictEqual(first.calls, [call("/v1/admin/audit", 200)])
      assert.deepStrictEqual(first.page.entries.map(gist), [
        {
          actor: { type: "token", label: "agent on box" },
          action: "secrets.resolve",
          vaults: ["Personal"],
          references,
          outcome: "ok",
          count: 1,
        },
        {
          actor: { type: "token", label: "agent on box" },
          action: "items.create",
          vaults: ["Personal"],
          references: [],
          detail: { title: "Key", fields: ["credential"] },
          outcome: "ok",
          count: 1,
        },
        {
          actor: { type: "init" },
          action: "init",
          vaults: ["Personal"],
          references: [],
          detail: { label: "agent on box", grants: [{ vault: "Personal", access: "read+create" }] },
          outcome: "ok",
          count: 1,
        },
      ])
      assert.strictEqual(first.page.next, undefined)
      const [newest] = first.page.entries
      assert.strictEqual(newest?.peer, "127.0.0.1")
      assert.strictEqual(newest?.lastAt, newest?.at)

      const second = await audit(box)
      assert.deepStrictEqual(second.page.entries.map(gist)[0], {
        actor: { type: "passphrase" },
        action: "audit.read",
        vaults: [],
        references: [],
        outcome: "ok",
        count: 1,
      })
      assert.strictEqual(second.page.entries.length, 4)
    }))
})

// Two Vaults and two Tokens, oldest first: init (Personal), agent's create and read-back (Personal), vault.create
// (Work), token.issue (Work, Label worker), worker's create and read-back (Work). Returns worker's Token.
const twoVaults = async (box: Sandbox, seen: (sentinel: Sentinel) => void) => {
  await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
  const created = await box.run(["vault", "create", "Work", "--passphrase-stdin"], { input: `${passphrase}\n` })
  assert.strictEqual(created.code, 0, created.stderr)
  const { token } = await issuePrinted(box, ["--label", "worker", "--create", "Work"])
  seen({ kind: "token", text: token })

  const made = await box.run(["create", "api-credential", "--title", "Deploy", "--vault", "Work", "--stdin"], {
    input: `${value}\n`,
    env: { HUSH_TOKEN: token },
  })

  assert.strictEqual(made.code, 0, made.stderr)

  return token
}

// Each entry's Action and actor, newest first.
const actions = (entries: ReadonlyArray<Entry>) =>
  entries.map(({ action, actor }) => `${action} ${JSON.stringify(actor)}`)

const agent = JSON.stringify({ type: "token", label: "agent on box" })
const worker = JSON.stringify({ type: "token", label: "worker" })
const owner = JSON.stringify({ type: "passphrase" })

describe("hush audit filters and paging", () => {
  it("filters by Vault and by Label, each by name identity, alone and combined", () =>
    withSandbox(async (box, seen) => {
      await twoVaults(box, seen)
      assert.deepStrictEqual(actions((await audit(box, ["--vault", "WORK"])).page.entries), [
        `secrets.resolve ${worker}`,
        `items.create ${worker}`,
        `token.issue ${owner}`,
        `vault.create ${owner}`,
      ])
      assert.deepStrictEqual(actions((await audit(box, ["--label", "Worker"])).page.entries), [
        `secrets.resolve ${worker}`,
        `items.create ${worker}`,
      ])
      assert.deepStrictEqual(
        actions((await audit(box, ["--vault", "personal", "--label", "agent on box"])).page.entries),
        [`secrets.resolve ${agent}`, `items.create ${agent}`],
      )
      assert.deepStrictEqual((await audit(box, ["--vault", "Personal", "--label", "worker"])).page, { entries: [] })
    }))

  it("pages newest first with --limit, --before and next, alone and under a filter", () =>
    withSandbox(async (box, seen) => {
      await twoVaults(box, seen)
      const first = await audit(box, ["--vault", "Work", "--limit", "3"])
      assert.deepStrictEqual(actions(first.page.entries), [
        `secrets.resolve ${worker}`,
        `items.create ${worker}`,
        `token.issue ${owner}`,
      ])
      assert.strictEqual(first.page.next, first.page.entries[2]?.id)
      const second = await audit(box, ["--vault", "Work", "--limit", "3", "--before", String(first.page.next)])
      assert.deepStrictEqual(actions(second.page.entries), [`vault.create ${owner}`])
      assert.strictEqual(second.page.next, undefined)

      // Unfiltered, the two reads above are the newest entries.
      const all = await audit(box, ["--limit", "4"])
      assert.deepStrictEqual(actions(all.page.entries), [
        `audit.read ${owner}`,
        `audit.read ${owner}`,
        `secrets.resolve ${worker}`,
        `items.create ${worker}`,
      ])
      const older = await audit(box, ["--limit", "4", "--before", String(all.page.next)])
      assert.deepStrictEqual(actions(older.page.entries), [
        `token.issue ${owner}`,
        `vault.create ${owner}`,
        `secrets.resolve ${agent}`,
        `items.create ${agent}`,
      ])
      const oldest = await audit(box, ["--limit", "4", "--before", String(older.page.next)])
      assert.deepStrictEqual(actions(oldest.page.entries), [`init ${JSON.stringify({ type: "init" })}`])
      assert.strictEqual(oldest.page.next, undefined)
    }))

  it("filters by --since as an ISO time or a duration back from now", () =>
    withSandbox(async (box, seen) => {
      await twoVaults(box, seen)
      const work = (await audit(box, ["--vault", "Work"])).page.entries
      const issued = work.find(({ action }) => action === "token.issue")
      assert.isDefined(issued)
      const since = await audit(box, ["--vault", "Work", "--since", issued?.at ?? ""])
      assert.deepStrictEqual(actions(since.page.entries), [
        `secrets.resolve ${worker}`,
        `items.create ${worker}`,
        `token.issue ${owner}`,
      ])
      // The same instant with another offset is the same filter.
      const at = new Date(Date.parse(issued?.at ?? ""))
      const offset = new Date(at.getTime() + 2 * 3_600_000).toISOString().replace(/\.(\d{3})Z$/, ".$1+02:00")
      assert.deepStrictEqual((await audit(box, ["--vault", "Work", "--since", offset])).page, since.page)
      assert.deepStrictEqual((await audit(box, ["--vault", "Work", "--since", "1h"])).page.entries, work)
      assert.deepStrictEqual((await audit(box, ["--vault", "Work", "--since", "2099-01-01"])).page, { entries: [] })
    }))

  it("shows a dead Token's coalesced denials as one entry with its count and lastAt", () =>
    withSandbox(async (box, seen) => {
      const token = await twoVaults(box, seen)
      const revoked = await box.run(["token", "revoke", "worker", "--passphrase-stdin"], { input: `${passphrase}\n` })
      assert.strictEqual(revoked.code, 0, revoked.stderr)

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const refused = await box.run(["token", "status"], { env: { HUSH_TOKEN: token } })
        assert.strictEqual(refused.code, 1)
      }

      const [newest] = (await audit(box, ["--label", "worker", "--limit", "1"])).page.entries
      assert.isDefined(newest)
      assert.deepStrictEqual(newest === undefined ? undefined : gist(newest), {
        actor: { type: "token", label: "worker" },
        action: "token.describe",
        vaults: [],
        references: [],
        outcome: "denied",
        error: "TokenRejected",
        count: 3,
      })
      assert.isTrue((newest?.lastAt ?? "") > (newest?.at ?? ""))
    }))
})

const auditRows = (box: Sandbox) =>
  box
    .inspect((db) => db.query("SELECT count(*) AS n FROM audit").get())
    .then((row) => Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Number }))(row).n)

const post = (box: Sandbox, path: string, body: unknown, headers: Record<string, string> = {}) =>
  box.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

// A well-formed Token (`hush_` plus 43 base64url characters) this Server never issued.
const unknownToken = `hush_${"A".repeat(43)}`

describe("what the Audit Log never records", () => {
  it("records no status, gate refusal or wrong Init code on a fresh Server, then the Init", () =>
    withSandbox(async (box, seen) => {
      const code = await box.server.initCode()

      if (code !== undefined) seen({ kind: "initCode", text: code })
      assert.strictEqual((await box.run(["status"])).code, 0)
      const gated = await post(box, "/v1/admin/vaults/list", { passphrase })
      assert.strictEqual(gated.status, 409)
      assert.include(await gated.text(), "NotInitialised")
      const wrongCode = await post(box, "/v1/admin/init", { initCode: "0".repeat(32), passphrase })
      assert.strictEqual(wrongCode.status, 403)
      assert.include(await wrongCode.text(), "InitCodeInvalid")
      assert.strictEqual(await auditRows(box), 0)
      await seeded(box, seen)
      assert.strictEqual(await auditRows(box), 1)
    }))

  it("records no status, guard refusal, bad Token, Token-carrying audit read or BackoffActive; rows survive a restart", () =>
    withSandbox(async (box, seen) => {
      const { token } = await seeded(box, seen, { items: [{ kind: "api-credential", title: "Key", value }] })
      const before = await audit(box)
      const rows = await auditRows(box)

      assert.strictEqual((await box.run(["status"])).code, 0)
      const guarded = await post(box, "/v1/admin/audit", { passphrase }, { origin: "https://evil.test" })
      assert.strictEqual(guarded.status, 403)
      const malformed = await post(box, "/v1/items/list", {}, { authorization: "Bearer not-a-token" })
      assert.strictEqual(malformed.status, 401)
      const unrecognised = await post(box, "/v1/items/list", {}, { authorization: `Bearer ${unknownToken}` })
      assert.strictEqual(unrecognised.status, 401)
      // No Token of any Access reads the log: without a Passphrase the body does not decode.
      const withToken = await post(box, "/v1/admin/audit", {}, { authorization: `Bearer ${token}` })
      assert.strictEqual(withToken.status, 400)
      assert.strictEqual(await withToken.text(), "")
      assert.strictEqual(await auditRows(box), rows)

      // Three free failures, then a delay: the fourth wrong Passphrase is evaluated, the fifth is not.
      const wrong = () => post(box, "/v1/admin/vaults/list", { passphrase: "wrong passphrase guess" })

      for (let attempt = 0; attempt < 4; attempt += 1) assert.strictEqual((await wrong()).status, 401)
      assert.strictEqual(await auditRows(box), rows + 4)
      const backoff = await wrong()
      assert.strictEqual(backoff.status, 429)
      assert.include(await backoff.text(), "BackoffActive")
      assert.strictEqual(await auditRows(box), rows + 4)

      // A restart clears the backoff and keeps every row.
      await box.server.restart()
      const after = await audit(box)
      assert.strictEqual(await auditRows(box), rows + 5)
      assert.deepStrictEqual(after.page.entries.slice(5), before.page.entries)
      assert.deepStrictEqual(
        after.page.entries.slice(0, 5).map(({ action, outcome, ...rest }) => ({
          action,
          outcome,
          error: outcome === "ok" ? undefined : rest.error,
        })),
        [
          ...Array.from({ length: 4 }, () => ({
            action: "vault.list",
            outcome: "denied",
            error: "PassphraseIncorrect",
          })),
          { action: "audit.read", outcome: "ok", error: undefined },
        ],
      )
    }))

  it("refuses hush audit without a Passphrase source even with a Token at hand, sending nothing", () =>
    withSandbox(async (box, seen) => {
      const { token } = await seeded(box, seen)
      const rows = await auditRows(box)
      const result = await box.run(["audit"], { env: { HUSH_TOKEN: token } })
      assert.strictEqual(result.code, 1)
      assert.strictEqual(result.stdout, "")
      assert.include(result.stderr, "hush audit needs a human with the Passphrase at a terminal")
      assert.deepStrictEqual(result.calls, [])
      assert.strictEqual(await auditRows(box), rows)
    }))
})

describe("Audit Log outcomes", () => {
  it("reads back denied for authorisation refusals and error for other failures after authentication", () =>
    withSandbox(async (box, seen) => {
      const workerToken = await twoVaults(box, seen)
      const asWorker = { env: { HUSH_TOKEN: workerToken } }
      const { token: readerToken } = await issuePrinted(box, ["--label", "reader", "--read", "Work"])
      seen({ kind: "token", text: readerToken })
      const { token: briefToken } = await issuePrinted(box, ["--label", "brief", "--read", "Work", "--ttl", "1s"])
      seen({ kind: "token", text: briefToken })

      const refused = async (args: ReadonlyArray<string>, options: Parameters<Sandbox["run"]>[1]) =>
        assert.strictEqual((await box.run(args, options)).code, 1)

      await refused(["read", "hush://Personal/Key/credential"], asWorker)
      await refused(["create", "api-credential", "--title", "New", "--vault", "Work", "--stdin"], {
        input: `${value}\n`,
        env: { HUSH_TOKEN: readerToken },
      })
      await new Promise((wait) => setTimeout(wait, 1_100))
      await refused(["token", "status"], { env: { HUSH_TOKEN: briefToken } })
      await refused(["vault", "list", "--passphrase-stdin"], { input: "wrong passphrase guess\n" })
      await refused(["read", "hush://Work/Nope/credential"], asWorker)
      await refused(["create", "api-credential", "--title", "Deploy", "--vault", "Work", "--stdin"], {
        input: `${value}\n`,
        ...asWorker,
      })

      const { entries } = (await audit(box, ["--limit", "6"])).page
      assert.deepStrictEqual(
        entries.map((entry) => ({
          action: entry.action,
          actor: entry.actor,
          outcome: entry.outcome,
          error: entry.error,
        })),
        [
          { action: "items.create", actor: { type: "token", label: "worker" }, outcome: "error", error: "ItemExists" },
          {
            action: "secrets.resolve",
            actor: { type: "token", label: "worker" },
            outcome: "error",
            error: "ReferenceNotFound",
          },
          { action: "vault.list", actor: { type: "passphrase" }, outcome: "denied", error: "PassphraseIncorrect" },
          {
            action: "token.describe",
            actor: { type: "token", label: "brief" },
            outcome: "denied",
            error: "TokenRejected",
          },
          {
            action: "items.create",
            actor: { type: "token", label: "reader" },
            outcome: "denied",
            error: "CreateNotAllowed",
          },
          {
            action: "secrets.resolve",
            actor: { type: "token", label: "worker" },
            outcome: "denied",
            error: "VaultNotGranted",
          },
        ],
      )
    }))
})

describe("hush audit refusals", () => {
  const nothingRead = "nothing was read and no prompt was shown. See `hush audit --help`."

  const flagCases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
    [
      ["--since", "yesterday"],
      `\`--since yesterday\` is neither a duration such as 7d (a whole number and one of s, m, h, d, w) nor an ISO 8601 time such as 2026-10-01 or 2026-10-01T09:00:00Z; ${nothingRead}`,
    ],
    [["--limit", "1001"], `\`--limit 1001\` is not a whole number from 1 to 1000; ${nothingRead}`],
    [["--limit", "0"], `\`--limit 0\` is not a whole number from 1 to 1000; ${nothingRead}`],
    [
      ["--before", "-3"],
      `\`--before -3\` is not an entry id (a whole number from 1, as a page's \`next\` gives it); ${nothingRead}`,
    ],
    [
      ["--vault", "a/b"],
      "vault is not a valid name (slash); nothing was changed. Names are 1-128 characters without `/` or control characters, not starting with `-` or with a space at either end.",
    ],
  ]

  it("refuses each bad flag with its tag before reading the Passphrase, sending nothing and recording nothing", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const rows = await auditRows(box)

      for (const [args, message] of flagCases) {
        const result = await box.run(["audit", ...args, "--passphrase-stdin"], { input: `${passphrase}\n` })
        assert.strictEqual(result.code, 1, args.join(" "))
        assert.strictEqual(result.stdout, "")
        assert.strictEqual(result.stderr, `hush: ${message}\n`)
        assert.deepStrictEqual(result.calls, [])
      }

      assert.strictEqual(await auditRows(box), rows)
    }))

  it("answers a name that is not a Name with InvalidName, recorded as an error", () =>
    withSandbox(async (box, seen) => {
      await seeded(box, seen)
      const response = await post(box, "/v1/admin/audit", { passphrase, label: "a/b" })
      assert.strictEqual(response.status, 400)
      assert.deepStrictEqual(await response.json(), { _tag: "InvalidName", what: "label", reason: "slash" })
      const [newest] = (await audit(box, ["--limit", "1"])).page.entries
      assert.deepStrictEqual(newest === undefined ? undefined : gist(newest), {
        actor: { type: "passphrase" },
        action: "audit.read",
        vaults: [],
        references: [],
        outcome: "error",
        error: "InvalidName",
        count: 1,
      })
    }))
})

describe("Audit Log leak check", () => {
  it("scans every hush audit output as the audit target, and the audit table holds no secret", () =>
    withSandbox(async (box, seen) => {
      const secrets: Array<Sentinel> = [valueSentinel, passphraseSentinel]

      const see = (sentinel: Sentinel) => {
        secrets.push(sentinel)
        seen(sentinel)
      }

      await seeded(box, see, { items: [{ kind: "login", title: "Mail", value, plain: { username: "me" } }] })
      const issued = await issuePrinted(box, ["--label", "reader", "--read", "Personal"])
      see({ kind: "token", text: issued.token })
      const read = await audit(box)
      assert.deepStrictEqual(await box.observable(["audit"]), [{ target: "audit", text: read.stdout }])
      const table = await box.inspect((db) => JSON.stringify(db.query("SELECT * FROM audit").all()))
      assert.include(table, "token.issue")
      assert.deepStrictEqual(scan([{ target: "audit", text: table }], secrets), [])
    }))
})
