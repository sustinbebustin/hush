import { createHostClipboard } from "@opentui/core"
import { Data, Effect, Redacted, type Scope } from "effect"

// The host clipboard as the UI uses it: whether this machine has a backend, a write of one secret, and a read of
// one. The reducer never sees it; the interpreter reads and writes through it and reports whether a backend exists,
// so the copy and paste keys are offered only where they can work. Tests pass a fake in place of `host`.

// How a write ended: on the clipboard, refused because the host has no clipboard, or failed (timed out, cancelled,
// or a platform error, whose text is not shown).
export type Written = "written" | "unsupported" | "failed"

// How a read ended: the clipboard's text, Redacted since it is usually a secret; nothing to paste as text; refused
// because the host has no clipboard; or failed (timed out, cancelled, too large, or a platform error, not shown).
export type Pasted = Data.TaggedEnum<{
  Text: { readonly text: Redacted.Redacted<string> }
  Empty: {}
  Unsupported: {}
  Failed: {}
}>

const Pasted = Data.taggedEnum<Pasted>()

export interface Clipboard {
  // Whether the host has a clipboard backend (macOS, Wayland or X11).
  readonly available: boolean
  readonly write: (text: Redacted.Redacted<string>) => Effect.Effect<Written>
  readonly read: Effect.Effect<Pasted>
}

// OpenTUI's native backends: the macOS pasteboard, else Wayland or X11 when the session names a display (its own
// selection rules: Wayland first, X11 on `DISPLAY`).
const hasBackend = (platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): boolean =>
  platform === "darwin" ||
  (platform === "linux" && [env.WAYLAND_DISPLAY, env.WAYLAND_SOCKET, env.DISPLAY].some((name) => (name ?? "") !== ""))

// A host without a clipboard: the copy and paste keys are absent.
const none: Clipboard = {
  available: false,
  write: () => Effect.succeed("unsupported"),
  read: Effect.succeed(Pasted.Unsupported()),
}

const decoder = new TextDecoder()

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
      read: Effect.tryPromise(() => service.read({ preferredTypes: ["text/plain"] })).pipe(
        Effect.map((result): Pasted => {
          if (result.status === "read")
            return Pasted.Text({ text: Redacted.make(decoder.decode(result.representation.bytes)) })

          if (result.status === "empty") return Pasted.Empty()

          return result.status === "unsupported" ? Pasted.Unsupported() : Pasted.Failed()
        }),
        Effect.orElseSucceed(() => Pasted.Failed()),
      ),
    }),
  )
}

export const Clipboard = { none, host, hasBackend, Pasted } as const
