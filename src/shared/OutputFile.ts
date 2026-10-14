import { Effect, Schema } from "effect"
import { chmod, link, lstat, open, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"

import { PlatformCause } from "./PlatformCause.js"

// A file written whole or not at all and never over an existing one: it is written as a 0600
// temp file in the target's own directory, then `link`ed into place, which fails rather than overwrite. Both
// `hush backup` and `hush server backup` write through it.

// Anything already at the target path, a dangling symlink included.
export class OutputExists extends Schema.TaggedError<OutputExists>()("OutputExists", { path: Schema.String }) {}

// A file could not be written. `consequence` picks the error message for which file failed and when: for the
// token file, `before-prompt` is the pre-prompt check of a Token-saving command and
// `not-saved` the write itself; `template` is `env write`'s file; `resolved` is `env resolve`'s target, whose temp
// file was removed; `backup` is either backup command's target; `config` is the CLI config file of `hush config set`.
export class FileWriteFailed extends Schema.TaggedError<FileWriteFailed>()("FileWriteFailed", {
  path: Schema.String,
  code: Schema.String,
  consequence: Schema.Literals(["before-prompt", "not-saved", "template", "resolved", "backup", "config"]),
}) {}

// A backup at `path` was not written, for the system or SQLite error `cause`.
export const writeFailed = (path: string) => (cause: unknown) =>
  new FileWriteFailed({ path, code: PlatformCause.codeOrUnknown(cause), consequence: "backup" })

// Refuses a target that exists, before anything is asked or written.
export const checkAbsent = (target: string): Effect.Effect<void, OutputExists | FileWriteFailed> =>
  Effect.tryPromise({ try: () => lstat(target), catch: (cause) => cause }).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.fail(new OutputExists({ path: target })),
      onFailure: (cause) =>
        PlatformCause.code(cause) === "ENOENT" ? Effect.void : Effect.fail(writeFailed(target)(cause)),
    }),
  )

const randomSuffix = () => Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")

// A new empty file at a fresh name in `directory`, mode 0600 whatever the umask or a default ACL says. It is
// created exclusively, so nothing else's file is ever reused.
export const createPrivate = (directory: string, name: (suffix: string) => string) =>
  Effect.tryPromise({
    try: async () => {
      const path = join(directory, name(randomSuffix()))
      const handle = await open(path, "wx", 0o600)
      await handle.close()
      await chmod(path, 0o600)

      return path
    },
    catch: (cause) => cause,
  })

// Deletes `path` if it is there; a failure leaves a 0600 file behind, which is no reason to fail what succeeded.
export const remove = (path: string): Effect.Effect<void> => Effect.promise(() => unlink(path).catch(() => undefined))

// `write` fills an empty 0600 temp file beside `target`; its result is kept only if `write` succeeds, by linking
// the temp file to `target` (`OutputExists` if something got there first). The temp file is deleted either way.
export const place = <A, E, R>(
  target: string,
  write: (temp: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OutputExists | FileWriteFailed, R> =>
  Effect.gen(function* () {
    yield* checkAbsent(target)

    return yield* Effect.acquireUseRelease(
      createPrivate(dirname(target), (suffix) => `.hush-backup-${suffix}.tmp`).pipe(
        Effect.mapError(writeFailed(target)),
      ),
      (temp) =>
        Effect.gen(function* () {
          const written = yield* write(temp)
          yield* Effect.tryPromise({ try: () => link(temp, target), catch: (cause) => cause }).pipe(
            Effect.mapError((cause) =>
              PlatformCause.code(cause) === "EEXIST" ? new OutputExists({ path: target }) : writeFailed(target)(cause),
            ),
          )

          return written
        }),
      remove,
    )
  })

export * as OutputFile from "./OutputFile.js"
