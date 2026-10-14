import { Data, Effect, Redacted, Result, Schema } from "effect"
import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { hostname, userInfo } from "node:os"
import { dirname } from "node:path"

import { Name } from "../shared/Name.js"
import { PlatformCause } from "../shared/PlatformCause.js"
import { Token } from "../shared/Token.js"
import type { EnvVars } from "./LaunchEnv.js"
import {
  type Account,
  FileWriteFailed,
  type GrantFlag,
  type TokenContext,
  NoToken,
  TokenAlreadySaved,
  TokenEnvInvalid,
  TokenFileInsecure,
  TokenFileInvalid,
} from "./CliError.js"
import { PrivateFile } from "./PrivateFile.js"
import type { Target } from "./Target.js"

// Which Token a command sends:`HUSH_TOKEN` when set, and then the token file is
// never opened; otherwise this Server origin's entry in `~/.config/hush/tokens.json`. Every failure is reported
// and no other source is tried (invariant 6).

export type TokenChoice = Data.TaggedEnum<{
  Env: { readonly token: Redacted.Redacted<Token> }
  Saved: { readonly token: Redacted.Redacted<Token>; readonly label: string; readonly path: string }
}>

export const TokenChoice = Data.taggedEnum<TokenChoice>()

// One entry of the file: unique by `server`, the Server origin that issued it.
export interface SavedToken {
  readonly server: string
  readonly label: Name
  readonly token: Redacted.Redacted<Token>
}

const Entry = Schema.Struct({ server: Schema.String, label: Schema.String, token: Token.schema })

const TokenFile = Schema.Struct({ version: Schema.Literal(1), tokens: Schema.Array(Entry) }).check(
  Schema.makeFilter(({ tokens }) => new Set(tokens.map(({ server }) => server)).size === tokens.length),
)

type TokenFile = typeof TokenFile.Type

export const path = (env: EnvVars) => PrivateFile.path(env, "tokens.json")

// What reading the file found, before its content is parsed.
type Opened = Data.TaggedEnum<{
  Missing: {}
  Insecure: { readonly mode: string }
  Read: { readonly text: string }
}>

const Opened = Data.taggedEnum<Opened>()

// The parsed file, or undefined when it does not exist. Group or other bits fail before the content is read.
const load = (file: string): Effect.Effect<TokenFile | undefined, TokenFileInvalid | TokenFileInsecure> =>
  Effect.gen(function* () {
    const read = yield* Effect.tryPromise({
      try: async () => {
        const { mode } = await stat(file)
        const bits = mode & 0o777

        if ((bits & 0o077) !== 0) return Opened.Insecure({ mode: bits.toString(8) })

        return Opened.Read({ text: await readFile(file, "utf8") })
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        PlatformCause.code(cause) === "ENOENT"
          ? Effect.succeed(Opened.Missing())
          : Effect.fail(
              new TokenFileInvalid({
                path: file,
                problem: { reason: "unreadable", code: PlatformCause.codeOrUnknown(cause) },
              }),
            ),
      ),
    )

    return yield* Opened.$match(read, {
      Missing: () => Effect.succeed(undefined),
      Insecure: ({ mode }) => Effect.fail(new TokenFileInsecure({ path: file, mode })),
      Read: ({ text }) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
          Effect.mapError(() => new TokenFileInvalid({ path: file, problem: { reason: "not-json" } })),
          Effect.flatMap((json) =>
            Schema.decodeUnknownEffect(TokenFile)(json).pipe(
              Effect.mapError(() => new TokenFileInvalid({ path: file, problem: { reason: "invalid" } })),
            ),
          ),
        ),
    })
  })

// Which command saves: one issuing a Token, or `token save` with a Token it was given; `TokenAlreadySaved` says it.
export type SaveCommand = TokenAlreadySaved["command"]

// The file and the Label already saved for `origin`, refusing it with `TokenAlreadySaved` unless `replace`.
const loadForSave = (file: string, origin: string, replace: boolean, command: SaveCommand) =>
  Effect.gen(function* () {
    const previous = yield* load(file)
    const existing = previous?.tokens.find(({ server }) => server === origin)?.label

    if (existing !== undefined && !replace) return yield* new TokenAlreadySaved({ label: existing, command })

    return { previous, existing }
  })

// Trimmed, with empty meaning unset.
const fromEnv = (env: EnvVars): string | undefined => {
  const value = env.HUSH_TOKEN?.trim()

  return value === undefined || value === "" ? undefined : value
}

// The OS account running this CLI, whose token file this is. `userInfo` throws for a uid without a passwd entry.
const userName = (): string | undefined => {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

export const account = (): Account => ({ user: userName(), hostname: hostname() })

// What a Token command's errors render with: where `current` takes the Token from without reading it
// (`HUSH_TOKEN` when set, else the token file), this account, and the Grant flag the command needs.
export const context = (env: EnvVars, flag: GrantFlag): TokenContext => ({
  source: fromEnv(env) === undefined ? "file" : "env",
  account: account(),
  flag,
})

// The Token to send. `vault` is the Vault the command is for, which `NoToken` names; commands that name none
// (`inventory` without `--vault`, `token status`) leave it out.
export const current = (
  target: Target,
  env: EnvVars,
  vault?: Name,
): Effect.Effect<TokenChoice, NoToken | TokenEnvInvalid | TokenFileInvalid | TokenFileInsecure> =>
  Effect.gen(function* () {
    const variable = fromEnv(env)

    if (variable !== undefined)
      return yield* Result.match(Token.parse(variable), {
        onSuccess: (token) => Effect.succeed(TokenChoice.Env({ token: Redacted.make(token) })),
        onFailure: () => Effect.fail(new TokenEnvInvalid()),
      })
    const file = path(env)
    const entry = (yield* load(file))?.tokens.find(({ server }) => server === target.origin)

    if (entry === undefined)
      return yield* vault === undefined
        ? new NoToken({ server: target.origin })
        : new NoToken({ server: target.origin, vault })

    return TokenChoice.Saved({ token: Redacted.make(entry.token), label: entry.label, path: file })
  })

// Where `current` would take a Token from and the token file's state, for `doctor`. With `HUSH_TOKEN` set the file
// is not read; the variable itself is only checked for presence, never parsed. `origin` is undefined when the
// Server URL is invalid, so no entry can match.
export interface Health {
  readonly source: "env" | "file" | "none"
  readonly file: "ok" | "missing" | "insecure" | "invalid" | "not-read"
}

export const health = (origin: string | undefined, env: EnvVars): Effect.Effect<Health> => {
  if (fromEnv(env) !== undefined) return Effect.succeed({ source: "env", file: "not-read" })

  return load(path(env)).pipe(
    Effect.map((file): Health => {
      if (file === undefined) return { source: "none", file: "missing" }
      const saved = file.tokens.some(({ server }) => server === origin)

      return { source: saved ? "file" : "none", file: "ok" }
    }),
    Effect.catchTags({
      TokenFileInsecure: () => Effect.succeed<Health>({ source: "none", file: "insecure" }),
      TokenFileInvalid: () => Effect.succeed<Health>({ source: "none", file: "invalid" }),
    }),
  )
}

// Whether a write would land: the file itself when it exists, else the nearest existing ancestor directory.
const writable = (file: string): Effect.Effect<void, FileWriteFailed> =>
  Effect.tryPromise({
    try: async () => {
      const exists = await access(file).then(
        () => true,
        () => false,
      )

      if (exists) {
        await access(file, constants.W_OK)
        await access(dirname(file), constants.W_OK | constants.X_OK)

        return
      }

      let directory = dirname(file)

      for (;;) {
        const found = await stat(directory).then(
          () => true,
          (cause: unknown) => {
            if (PlatformCause.code(cause) === "ENOENT") return false
            throw cause
          },
        )

        if (found) return await access(directory, constants.W_OK | constants.X_OK)

        if (dirname(directory) === directory) return
        directory = dirname(directory)
      }
    },
    catch: (cause) =>
      new FileWriteFailed({ path: file, code: PlatformCause.codeOrUnknown(cause), consequence: "before-prompt" }),
  })

// `TokenAlreadySaved` for an existing entry for this Server unless `replace`, checked before any input is read.
export const checkReplaceable = (
  target: Target,
  replace: boolean,
  env: EnvVars,
  command: SaveCommand,
): Effect.Effect<void, TokenAlreadySaved | TokenFileInvalid | TokenFileInsecure> =>
  Effect.asVoid(loadForSave(path(env), target.origin, replace, command))

// The local checks a Token-issuing command runs before it reads any secret.
export const checkSavable = (
  target: Target,
  replace: boolean,
  env: EnvVars,
): Effect.Effect<
  { readonly existing: string | undefined },
  TokenAlreadySaved | TokenFileInvalid | TokenFileInsecure | FileWriteFailed
> =>
  Effect.gen(function* () {
    const file = path(env)
    const { existing } = yield* loadForSave(file, target.origin, replace, "issue")
    yield* writable(file)

    return { existing }
  })

// Writes the entry for its origin, keeping every other origin's.
export const save = (
  entry: SavedToken,
  replace: boolean,
  env: EnvVars,
  command: SaveCommand,
): Effect.Effect<
  { readonly replaced: string | undefined; readonly path: string },
  TokenAlreadySaved | TokenFileInvalid | TokenFileInsecure | FileWriteFailed
> =>
  Effect.gen(function* () {
    const file = path(env)
    const { previous, existing: replaced } = yield* loadForSave(file, entry.server, replace, command)

    const next: TokenFile = {
      version: 1,
      tokens: [
        ...(previous?.tokens.filter(({ server }) => server !== entry.server) ?? []),
        { server: entry.server, label: entry.label, token: Redacted.value(entry.token) },
      ],
    }

    yield* write(file, next)

    return { replaced, path: file }
  })

const write = (file: string, next: TokenFile): Effect.Effect<void, FileWriteFailed> =>
  PrivateFile.write(file, `${JSON.stringify(next, null, 2)}\n`).pipe(
    Effect.mapError(({ code }) => new FileWriteFailed({ path: file, code, consequence: "not-saved" })),
  )

// Drops this origin's entry, keeping every other origin's; with `label`, only when the entry has that Label by
// name identity. Returns the dropped entry's Label, or undefined when nothing was dropped. Never contacts the
// Server.
export const forget = (
  target: Target,
  env: EnvVars,
  label?: Name,
): Effect.Effect<{ readonly label: string } | undefined, TokenFileInvalid | TokenFileInsecure | FileWriteFailed> =>
  Effect.gen(function* () {
    const file = path(env)
    const previous = yield* load(file)
    const entry = previous?.tokens.find(({ server }) => server === target.origin)

    if (previous === undefined || entry === undefined) return undefined

    if (label !== undefined && !sameLabel(entry.label, label)) return undefined
    yield* write(file, { version: 1, tokens: previous.tokens.filter((other) => other !== entry) })

    return { label: entry.label }
  })

// A saved Label is a plain string in the file, so one that is not a Name matches nothing.
const sameLabel = (saved: string, label: Name) =>
  Result.match(Name.parse(saved), { onFailure: () => false, onSuccess: (name) => Name.key(name) === Name.key(label) })

export * as TokenStore from "./TokenStore.js"
