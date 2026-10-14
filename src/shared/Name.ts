import { Brand, Predicate, Result, Schema } from "effect"

// A Vault, Item, Field or Token Label name:NFC-normalised, 1-128 code points, no `/`,
// no control characters (Cc), no whitespace at either end and no leading `-`.
export type Name = string & Brand.Brand<"Name">

// The identity of a Name: NFC then full-Unicode lowercase, so `Stripe` and `STRIPE` collide.
export type NameKey = string & Brand.Brand<"NameKey">

const invalidReasons = ["empty", "too-long", "slash", "control", "whitespace-edge", "leading-dash"] as const

export type InvalidNameReason = (typeof invalidReasons)[number]

const MAX_CODE_POINTS = 128

const control = /\p{Cc}/u
const edgeWhitespace = /^\p{White_Space}|\p{White_Space}$/u

const makeName = Brand.nominal<Name>()
const makeKey = Brand.nominal<NameKey>()

const invalidReason = (name: string): InvalidNameReason | undefined => {
  if (name === "") return "empty"

  if ([...name].length > MAX_CODE_POINTS) return "too-long"

  if (name.includes("/")) return "slash"

  if (control.test(name)) return "control"

  if (edgeWhitespace.test(name)) return "whitespace-edge"

  if (name.startsWith("-")) return "leading-dash"

  return undefined
}

// A Name as stored: already NFC and within the rules, so it decodes unchanged.
const is = (input: unknown): input is Name =>
  Predicate.isString(input) && input === input.normalize("NFC") && invalidReason(input) === undefined

export const Name = {
  // Every reason `parse` can fail with, at runtime, so error schemas can list them as literals.
  invalidReasons,
  parse: (input: string): Result.Result<Name, { readonly reason: InvalidNameReason }> => {
    const name = input.normalize("NFC")
    const reason = invalidReason(name)

    return reason === undefined ? Result.succeed(makeName(name)) : Result.fail({ reason })
  },
  is,
  // Decodes a stored name (a database column) to a `Name` without re-normalising it.
  schema: Schema.declare(is, { title: "Name" }),
  key: (name: Name): NameKey => makeKey(name.normalize("NFC").toLowerCase()),
} as const
