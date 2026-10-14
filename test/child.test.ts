import { assert, describe, it } from "@effect/vitest"
import { PlatformError } from "effect"

import { Child } from "../src/cli/Child.js"
import { ChildFailed, ChildNotFound, ChildSignalled } from "../src/cli/CliError.js"

// Errors shaped as the Node spawner raises them (`toPlatformError` in NodeChildProcessSpawner.ts).
const raised = (method: string, cause: Error & { code?: string }) =>
  PlatformError.systemError({
    _tag: cause.code === "ENOENT" ? "NotFound" : "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: "tool --flag",
    cause,
  })

const errno = (code: string) => Object.assign(new Error(`spawn tool ${code}`), { code })

describe("Child.failure", () => {
  it("maps a spawn ENOENT to ChildNotFound", () => {
    assert.deepStrictEqual(
      Child.failure("tool", raised("spawn", errno("ENOENT"))),
      new ChildNotFound({ command: "tool" }),
    )
  })

  it("maps a signal death to ChildSignalled naming the signal", () => {
    const signalled = raised("exitCode", new Error("Process interrupted due to receipt of signal: 'SIGTERM'"))
    assert.deepStrictEqual(Child.failure("tool", signalled), new ChildSignalled({ command: "tool", signal: "SIGTERM" }))
  })

  it("names the signal unknown when Effect's message does not match", () => {
    const changed = raised("exitCode", new Error("killed by SIGTERM"))
    assert.deepStrictEqual(Child.failure("tool", changed), new ChildSignalled({ command: "tool", signal: "unknown" }))
  })

  it("maps any other spawner failure to ChildFailed", () => {
    assert.deepStrictEqual(
      Child.failure("tool", raised("spawn", errno("EACCES"))),
      new ChildFailed({ command: "tool" }),
    )
    assert.deepStrictEqual(
      Child.failure("tool", raised("fromReadable(stdout)", errno("EPIPE"))),
      new ChildFailed({ command: "tool" }),
    )
  })
})
