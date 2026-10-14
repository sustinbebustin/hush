import { assert, describe, it } from "@effect/vitest"

import packageJson from "../package.json" with { type: "json" }
import { Version } from "../src/shared/Version.js"

describe("Version", () => {
  it("is the package version and API version 1", () => {
    assert.strictEqual(Version.current, packageJson.version)
    assert.strictEqual(Version.api, 1)
  })
})
