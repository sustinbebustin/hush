import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { vectors } from "./vectors.js"

describe("crypto vectors", () => {
  for (const vector of vectors)
    it.effect(vector.name, () => Effect.map(vector.actual, (actual) => assert.strictEqual(actual, vector.expected)))
})
