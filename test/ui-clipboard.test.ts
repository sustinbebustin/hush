import { assert, describe, it } from "@effect/vitest"

import { Clipboard } from "../src/ui/Clipboard.js"

// Whether the UI offers its copy key: only where OpenTUI has a host clipboard backend to write to.
describe("Clipboard.hasBackend", () => {
  it("finds the macOS pasteboard, or a Wayland or X11 display on Linux, and nothing else", () => {
    assert.isTrue(Clipboard.hasBackend("darwin", {}))
    assert.isTrue(Clipboard.hasBackend("linux", { WAYLAND_DISPLAY: "wayland-0" }))
    assert.isTrue(Clipboard.hasBackend("linux", { WAYLAND_SOCKET: "3" }))
    assert.isTrue(Clipboard.hasBackend("linux", { DISPLAY: ":0" }))
    assert.isFalse(Clipboard.hasBackend("linux", {}))
    assert.isFalse(Clipboard.hasBackend("linux", { DISPLAY: "", WAYLAND_DISPLAY: "" }))
    assert.isFalse(Clipboard.hasBackend("freebsd", { DISPLAY: ":0" }))
  })
})
