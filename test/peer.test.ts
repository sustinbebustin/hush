import { assert, describe, it } from "@effect/vitest"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

// No security decision uses the peer address or a forwarded header, so Docker bridge, userspace Tailscale and
// `tailscale serve` cannot weaken the Server. The peer is read in one place only, to record it in the Audit Log
// as information.

const serverSources = join(import.meta.dirname, "..", "src", "server")

const sourcesMatching = async (pattern: RegExp) => {
  const names = (await readdir(serverSources)).filter((name) => name.endsWith(".ts"))
  const texts = await Promise.all(names.map(async (name) => [name, await readFile(join(serverSources, name), "utf8")]))

  return texts.flatMap(([name, text]) => (name !== undefined && text !== undefined && pattern.test(text) ? [name] : []))
}

describe("the Server's use of the peer address", () => {
  it("reads the peer address only in Audit, for the row's information-only `peer`", async () => {
    assert.deepStrictEqual(await sourcesMatching(/remoteAddress|requestIP|\.socket\b/), ["Audit.ts"])
  })

  it("never reads a forwarded header", async () => {
    assert.deepStrictEqual(await sourcesMatching(/x-forwarded|x-real-ip|["']forwarded["']|tailscale-user/i), [])
  })
})
