import { assert, describe, it } from "@effect/vitest"

import { Access } from "../src/shared/Access.js"

describe("Access.allowsCreate", () => {
  it("allows create only for read+create", () => {
    assert.isFalse(Access.allowsCreate("read"))
    assert.isTrue(Access.allowsCreate("read+create"))
  })
})
