import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"

import { Kind } from "../src/shared/Kind.js"
import { Name } from "../src/shared/Name.js"

// Field specs widened to plain strings so the expected Field specs per Kind are plain literals.
const fields = (kind: Kind) => Kind.fields(kind).map(({ label, role, flag }) => ({ label: String(label), role, flag }))

const key = (label: string) => Result.map(Name.parse(label), Name.key).pipe(Result.getOrThrow)

describe("Kind", () => {
  it("has exactly three Kinds", () => {
    assert.deepStrictEqual(Kind.all, ["api-credential", "login", "database"])
  })

  it("lists each Kind's Field specs in display order, notes optional on every Kind", () => {
    const notes = { label: "notes", role: "plain", flag: "--notes" }
    assert.deepStrictEqual(fields("api-credential"), [{ label: "credential", role: "primary", flag: undefined }, notes])
    assert.deepStrictEqual(fields("login"), [
      { label: "password", role: "primary", flag: undefined },
      { label: "username", role: "plain", flag: "--username" },
      notes,
    ])
    assert.deepStrictEqual(fields("database"), [
      { label: "password", role: "primary", flag: undefined },
      { label: "username", role: "plain", flag: "--username" },
      { label: "host", role: "plain", flag: "--host" },
      { label: "port", role: "plain", flag: "--port" },
      { label: "database", role: "plain", flag: "--database" },
      notes,
    ])
  })

  it("names the concealed primary Field of each Kind", () => {
    assert.strictEqual(String(Kind.primary("api-credential").label), "credential")
    assert.strictEqual(String(Kind.primary("login").label), "password")
    assert.strictEqual(String(Kind.primary("database").label), "password")
  })

  it("finds a spec by label key and nothing for a label outside the Kind", () => {
    assert.strictEqual(String(Kind.spec("database", key("PORT"))?.label), "port")
    assert.strictEqual(Kind.spec("login", key("host")), undefined)
    assert.strictEqual(Kind.spec("api-credential", key("password")), undefined)
  })

  it("parses a Kind and lists the allowed Kinds on failure", () => {
    assert.deepStrictEqual(Kind.parse("login"), Result.succeed("login"))
    assert.deepStrictEqual(Kind.parse("ssh-key"), Result.fail({ allowed: ["api-credential", "login", "database"] }))
  })

  it("lists every plain Field label of any Kind once, as `create` declares its flags", () => {
    assert.deepStrictEqual(Kind.plainLabels, ["username", "host", "port", "database", "notes"])

    const fromSpecs = new Set(
      Kind.all.flatMap((kind) =>
        Kind.fields(kind).flatMap((spec) => (spec.role === "plain" ? [String(spec.label)] : [])),
      ),
    )

    assert.deepStrictEqual(new Set(Kind.plainLabels), fromSpecs)
  })
})
