import { createHostClipboard } from "@opentui/core"
import { Effect, Redacted, type Scope } from "effect"

// The host clipboard as the UI uses it: whether this machine has a backend, and a write of one secret. The reducer
// never sees it; the interpreter writes through it and reports whether a backend exists, so the copy key is offered
// only where it can work. Tests pass a fake in place of `host`.

// How a write ended: on the clipboard, refused because the host has no clipboard, or failed (timed out, cancelled,
// or a platform error, whose text is not shown).
export type Written = "written" | "unsupported" | "failed"

export interface Clipboard {
  // Whether the host has a clipboard backend (macOS, Wayland or X11).
  readonly available: boolean
  readonly write: (text: Redacted.Redacted<string>) => Effect.Effect<Written>
}

// OpenTUI's native backends: the macOS pasteboard, else Wayland or X11 when the session names a display (its own
// selection rules: Wayland first, X11 on `DISPLAY`).
const hasBackend = (platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): boolean =>
  platform === "darwin" ||
  (platform === "linux" && [env.WAYLAND_DISPLAY, env.WAYLAND_SOCKET, env.DISPLAY].some((name) => (name ?? "") !== ""))

// A host without a clipboard: the copy key is absent.
const none: Clipboard = { available: false, write: () => Effect.succeed("unsupported") }

// The host clipboard of this process, disposed when `scope` closes. On Linux the process serves pastes of what it
// wrote until then, so a copied Token stays pasteable only while the UI runs.
const host = (
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Clipboard, never, Scope.Scope> => {
  if (!hasBackend(platform, env)) return Effect.succeed(none)

  return Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => createHostClipboard()),
      (service) => Effect.promise(() => service.dispose()),
    ),
    (service): Clipboard => ({
      available: true,
      write: (text) =>
        Effect.tryPromise(() => service.writeText(Redacted.value(text))).pipe(
          Effect.map(({ status }): Written => (status === "written" || status === "unsupported" ? status : "failed")),
          Effect.orElseSucceed((): Written => "failed"),
        ),
    }),
  )
}

export const Clipboard = { none, host, hasBackend } as const
