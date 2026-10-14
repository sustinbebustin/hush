import { Effect, Result } from "effect"
import { argon2 } from "node:crypto"

import { Name, type NameKey } from "../src/shared/Name.js"
import { Token } from "../src/shared/Token.js"
import { Crypto } from "../src/server/Crypto.js"
import { Keys } from "../src/server/Keys.js"

// The fixed crypto vectors, as one table so `test/vectors.test.ts` runs them under vitest and
// `scripts/crypto-vectors.ts` runs them inside a `bun build --compile` binary. Expected values were
// computed independently (Python stdlib: hashlib, hmac per RFC 5869, struct) or come from RFC 9106.

export interface Vector {
  readonly name: string
  readonly actual: Effect.Effect<string>
  readonly expected: string
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")

const fixedToken = Result.getOrThrow(Token.parse("hush_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"))
const fixedSalt = new Uint8Array(Array.from({ length: 16 }, (_, index) => 0xa0 + index))

const key = (label: string): NameKey => Name.key(Result.getOrThrow(Name.parse(label)))

export const vectors: ReadonlyArray<Vector> = [
  {
    name: "lp length-prefixes each part with 4 big-endian bytes, integers as decimal strings",
    actual: Effect.sync(() => hex(Crypto.lp("hush", 12, String.fromCodePoint(0x00e9)))),
    expected: "000000046875736800000002313200000002c3a9",
  },
  {
    name: "the master-key AAD is lp('hush', 'v1', 'mk', 1)",
    actual: Effect.sync(() => hex(Keys.masterAad(1))),
    expected: "0000000468757368000000027631000000026d6b0000000131",
  },
  {
    name: "the Vault-key wrap under the master key is bound to the Vault id",
    actual: Effect.sync(() => hex(Keys.vaultAad(7))),
    expected: "0000000468757368000000027631000000087661756c746b65790000000137000000026d6b",
  },
  {
    name: "the Grant wrap is bound to the Vault id, the Token id and the Access",
    actual: Effect.sync(() => hex(Keys.grantAad(7, 3, "read+create"))),
    expected: "0000000468757368000000027631000000087661756c746b6579000000013700000001330000000b726561642b637265617465",
  },
  {
    name: "a Field is bound to its Vault, Item and Field ids, the Kind and the label key",
    actual: Effect.sync(() =>
      hex(Keys.fieldAad({ vaultId: 7, itemId: 11, fieldId: 13, kind: "login", labelKey: key("Password") })),
    ),
    expected:
      "0000000468757368000000027631000000056669656c640000000137000000023131000000023133000000056c6f67696e0000000870617373776f7264",
  },
  {
    name: "the Token auth hash is SHA-256 of the UTF-8 Token string",
    actual: Effect.sync(() => hex(Keys.authHash(fixedToken))),
    expected: "8638a45c4485824da6fa3070d60a421d8d9820eafc9069a4ac02b2a308e7f0f2",
  },
  {
    name: "the token wrap key is HKDF-SHA256 deriveBits over the secret bytes, the salt and hush-token-wrap-v1",
    actual: Crypto.tokenWrapBits(Token.secret(fixedToken), fixedSalt).pipe(Effect.map(hex)),
    expected: "45d088c4a64ac5e50b78b5cae26b7fd06605bf161fa4d30611ce7c617b0f840d",
  },
  {
    // RFC 9106 section 5.3. hush never sets `secret` or `associatedData`; the vector checks the runtime's
    // implementation, which `Crypto.deriveKek` calls.
    name: "Argon2id reproduces the RFC 9106 test vector",
    actual: Effect.callback<string>((resume) =>
      argon2(
        "argon2id",
        {
          message: Buffer.alloc(32, 0x01),
          nonce: Buffer.alloc(16, 0x02),
          secret: Buffer.alloc(8, 0x03),
          associatedData: Buffer.alloc(12, 0x04),
          memory: 32,
          passes: 3,
          parallelism: 4,
          tagLength: 32,
        },
        (error, tag) => resume(error === null ? Effect.succeed(tag.toString("hex")) : Effect.die(error)),
      ),
    ),
    expected: "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
  },
]
