import { Result } from "effect"

import { PassphraseInvalid } from "./ApiError.js"
import { Utf8 } from "./Utf8.js"

// The new-Passphrase policy, shared so the CLI refuses a Passphrase the Server would refuse before sending it.
// The Server also refuses a string that is not well-formed UTF-16 as `InvalidValue`, in `Init`.

// The most UTF-8 bytes a Passphrase may have, on the wire and under the policy.
export const maxBytes = 1024

const minCodePoints = 12
const maxCodePoints = 1024

// Checked only at Init and change: NFC, 12 to 1024 code points, at most 1024 UTF-8 bytes, no composition
// rules. Returns the NFC form, which is what the key-encryption key is derived from.
export const policy = (passphrase: string): Result.Result<string, PassphraseInvalid> => {
  const nfc = passphrase.normalize("NFC")
  const codePoints = [...nfc].length
  if (codePoints < minCodePoints) return Result.fail(new PassphraseInvalid({ reason: "too-short" }))
  if (codePoints > maxCodePoints || Utf8.byteLength(nfc) > maxBytes)
    return Result.fail(new PassphraseInvalid({ reason: "too-long" }))
  return Result.succeed(nfc)
}

export * as Passphrase from "./Passphrase.js"
