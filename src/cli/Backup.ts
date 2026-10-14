import { Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { resolve } from "node:path"

import { OutputFile } from "../shared/OutputFile.js"
import { Admin, type SecretSource } from "./Admin.js"
import { Client } from "./Client.js"
import { BackupCorrupt } from "./CliError.js"
import type { Target } from "./Target.js"

// `hush backup <file>`:the target must not exist, checked before the Passphrase is
// asked for; then one request to the raw backup route, its body written to a 0600 temp file beside the target while
// it is counted and hashed, compared with the Server's headers, and only then linked into place.

export interface Receipt {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

// The body into `temp`, synced to disk; a size or hash that differs from the headers is `BackupCorrupt`.
const receive = (file: string, temp: string, download: Client.Download) => {
  const writeFailed = OutputFile.writeFailed(file)
  return Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(temp, "r+"), catch: writeFailed }),
    (handle) =>
      Effect.gen(function* () {
        const hash = createHash("sha256")
        let bytes = 0
        yield* Stream.runForEach(download.body, (chunk) =>
          Effect.tryPromise({ try: () => handle.write(chunk), catch: writeFailed }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                hash.update(chunk)
                bytes += chunk.byteLength
              }),
            ),
          ),
        )
        yield* Effect.tryPromise({ try: () => handle.sync(), catch: writeFailed })
        const sha256 = hash.digest("hex")
        if (bytes !== download.bytes || sha256 !== download.sha256) return yield* new BackupCorrupt()
        return { bytes, sha256 }
      }),
    (handle) => Effect.promise(() => handle.close()),
  )
}

export const run = (input: { readonly target: Target; readonly source: SecretSource; readonly file: string }) => {
  const file = resolve(input.file)
  return Admin.passphraseCommand({
    command: "backup",
    source: input.source,
    secrets: Admin.passphraseOnly,
    prepare: OutputFile.checkAbsent(file),
    send: (_, passphrase) =>
      Client.backup(input.target, passphrase, (download) =>
        OutputFile.place(file, (temp) => receive(file, temp, download)),
      ).pipe(Effect.map((digest): Receipt => ({ file, ...digest }))),
  })
}

export * as Backup from "./Backup.js"
