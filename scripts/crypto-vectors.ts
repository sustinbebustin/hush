import { Effect } from "effect"

import { vectors } from "../test/vectors.js"

// The crypto vectors outside vitest, for `scripts/smoke-binary.sh` to compile with `bun build --compile` and run:
// the compiled runtime must compute what the tests' runtime does. Exits 1 on any mismatch.

const failed = await Effect.runPromise(
  Effect.forEach(vectors, (vector) =>
    Effect.map(vector.actual, (actual) => (actual === vector.expected ? [] : [`${vector.name}: got ${actual}`])),
  ).pipe(Effect.map((results) => results.flat())),
)

for (const failure of failed) console.error(`crypto-vectors: ${failure}`)
console.log(`crypto-vectors: ${vectors.length - failed.length} of ${vectors.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
