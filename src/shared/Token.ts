import { Brand, Result, Schema } from "effect"

// A Token string:`hush_` and the unpadded base64url of 32 random bytes, 48 characters in all.
// Checked by the CLI on `HUSH_TOKEN` and the token file, and by the Server's `TokenAuth` before any lookup.
export type Token = string & Brand.Brand<"Token">

const prefix = "hush_"
const shape = /^hush_[A-Za-z0-9_-]{43}$/
const secretBytes = 32

const make = Brand.nominal<Token>()

const format = (secret: Uint8Array): Token => make(`${prefix}${Buffer.from(secret).toString("base64url")}`)

// The 43 characters must be the canonical encoding of 32 bytes: a last character with stray low bits decodes to
// the same bytes as another string, so it is refused rather than accepted as an alias.
const is = (input: unknown): input is Token => {
  if (typeof input !== "string" || !shape.test(input)) return false
  const secret = Buffer.from(input.slice(prefix.length), "base64url")

  return secret.length === secretBytes && format(secret) === input
}

const parse = (input: string): Result.Result<Token, "malformed"> =>
  is(input) ? Result.succeed(input) : Result.fail("malformed")

// The secret bytes a parsed Token encodes: the HKDF input of its wrap key.
const secret = (token: Token): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(token.slice(prefix.length), "base64url"))

export const Token = {
  prefix,
  format,
  parse,
  // Decodes a Token held in a file (the token file) straight to a `Token`.
  schema: Schema.declare(is, { title: "Token" }),
  secret,
} as const
