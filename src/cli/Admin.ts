import { Clock, Effect, Redacted, Result, Schema } from "effect"

import type { Access, Grant } from "../shared/Access.js"
import {
  Api,
  auditLimit,
  type AuditRequest,
  maxTtlSeconds,
  type TokenIssueReceipt,
  type TokenRevoked,
} from "../shared/Api.js"
import { type InvalidName, parseName } from "../shared/ApiError.js"
import { Name } from "../shared/Name.js"
import { Passphrase } from "../shared/Passphrase.js"
import { Token } from "../shared/Token.js"
import { Client } from "./Client.js"
import {
  AuditFlagsInvalid,
  CliError,
  ChangeUnverified,
  InitCodeEmpty,
  IssueFlagsInvalid,
  NoToken,
  PassphraseMismatch,
  ServerUnreachable,
  TokenInputInvalid,
  TokenNotSaved,
  UnexpectedResponse,
} from "./CliError.js"
import { PassphraseStdin } from "./PassphraseStdin.js"
import { PrivateInput } from "./PrivateInput.js"
import type { Target } from "./Target.js"
import { Terminal } from "./Terminal.js"
import type { EnvVars } from "./LaunchEnv.js"
import { TokenStore } from "./TokenStore.js"

// The Owner's commands: `init`, then every Passphrase command, each built on `passphraseCommand`.

// Where the secrets come from: piped stdin or hidden prompts on `/dev/tty`.
export type SecretSource = "stdin" | "prompt"

// A secret read before the new Passphrase: its hidden prompt, and its `--passphrase-stdin` line for messages.
export interface FirstSecret {
  readonly prompt: string
  readonly line: string
}

// The prompt for the current Passphrase, alone or before a new one.
const passphrasePrompt = "hush Passphrase: "

// The two-secret sequences: `init` (code, new Passphrase) and `passphrase change` (current, new); every other
// Passphrase command reads the Passphrase alone.
export const sequences = {
  init: { prompt: "Init code: ", line: "the Init code" },
  change: { prompt: passphrasePrompt, line: "the current Passphrase" },
} as const satisfies Record<string, FirstSecret>

const newPassphrase = { prompt: "New Passphrase: ", repeat: "Repeat new Passphrase: ", line: "the new Passphrase" }

export interface Secrets {
  readonly first: Redacted.Redacted<string>
  // Passed the new-Passphrase policy, in NFC.
  readonly passphrase: Redacted.Redacted<string>
}

// One hidden line at `/dev/tty`, decoded as strictly as piped input.
const ask = (command: string, prompt: string) =>
  Terminal.hidden(prompt, { for: "passphrase", command }).pipe(
    Effect.flatMap((bytes) =>
      Effect.fromResult(
        PrivateInput.decode(Redacted.value(bytes), { noun: "input at the prompt", outcome: "changed" }),
      ),
    ),
  )

// The first secret, then the new Passphrase typed twice.
const prompted = (command: string, first: FirstSecret) =>
  Effect.gen(function* () {
    const typed = yield* ask(command, first.prompt)
    const entered = yield* ask(command, newPassphrase.prompt)

    if ((yield* ask(command, newPassphrase.repeat)) !== entered) return yield* new PassphraseMismatch()

    return [typed, entered] as const
  })

// How a Passphrase command reads its secrets, given the command's name (for messages) and the source.
export type SecretReader<S, E> = (command: string, source: SecretSource) => Effect.Effect<S, E>

// `first`, then the new Passphrase typed twice, from piped stdin or hidden prompts; then the new Passphrase
// policy, so no request is sent that must fail.
export const withNewPassphrase = (first: FirstSecret) => (command: string, source: SecretSource) =>
  Effect.gen(function* () {
    const [typed, entered] =
      source === "stdin"
        ? yield* PassphraseStdin.read(command, [first.line, newPassphrase.line])
        : yield* prompted(command, first)

    const passphrase = yield* Effect.fromResult(Passphrase.policy(entered))
    const secrets: Secrets = { first: Redacted.make(typed), passphrase: Redacted.make(passphrase) }

    return secrets
  })

// The Passphrase alone, at `hush Passphrase: ` or as the one line of `--passphrase-stdin`.
export const passphraseOnly = (command: string, source: SecretSource) =>
  Effect.gen(function* () {
    const entered = source === "stdin" ? yield* PassphraseStdin.readOne(command) : yield* ask(command, passphrasePrompt)

    return Redacted.make(entered)
  })

// Every Passphrase command in one order: `prepare` validates flags and names and runs every check that needs no
// secret, so a doomed command never prompts; then the secrets are read (`NoTerminal` at once with no terminal and
// no `--passphrase-stdin`); then `send` checks them and makes the one request.
export const passphraseCommand = <P, E1, R1, S, ES, A, E2, R2>(spec: {
  readonly command: string
  readonly source: SecretSource
  readonly secrets: SecretReader<S, ES>
  readonly prepare: Effect.Effect<P, E1, R1>
  readonly send: (prepared: P, secrets: S) => Effect.Effect<A, E2, R2>
}) =>
  Effect.gen(function* () {
    const prepared = yield* spec.prepare
    const secrets = yield* spec.secrets(spec.command, spec.source)

    return yield* spec.send(prepared, secrets)
  })

// A Passphrase write sent but not answered: it may or may not have happened. A refused connection
// never carried the request, so it stays `ServerUnreachable`.
export const unverifiedOnTransport = <A, E, R>(effect: Effect.Effect<A, E | ServerUnreachable, R>) =>
  Effect.catchIf(
    effect,
    (error): error is ServerUnreachable => error instanceof ServerUnreachable && error.reason !== "refused",
    () => Effect.fail(new ChangeUnverified()),
  )

// `hush vault create <name>`: one `admin/vaults/create`.
export const vaultCreate = (input: {
  readonly target: Target
  readonly source: SecretSource
  readonly vault: string
}) =>
  passphraseCommand({
    command: "vault create",
    source: input.source,
    secrets: passphraseOnly,
    prepare: parse("vault", input.vault),
    send: (vault, passphrase) =>
      unverifiedOnTransport(
        Client.request(Api, input.target, (client) => client.admin.vaultsCreate({ payload: { passphrase, vault } })),
      ),
  })

// `hush vault list`: one `admin/vaults/list`.
export const vaultList = (input: { readonly target: Target; readonly source: SecretSource }) =>
  passphraseCommand({
    command: "vault list",
    source: input.source,
    secrets: passphraseOnly,
    prepare: Effect.void,
    send: (_, passphrase) =>
      Client.request(Api, input.target, (client) => client.admin.vaultsList({ payload: { passphrase } })),
  })

// `hush vault delete <name>`: one `admin/vaults/delete`.
export const vaultDelete = (input: {
  readonly target: Target
  readonly source: SecretSource
  readonly vault: string
}) =>
  passphraseCommand({
    command: "vault delete",
    source: input.source,
    secrets: passphraseOnly,
    prepare: parse("vault", input.vault),
    send: (vault, passphrase) =>
      unverifiedOnTransport(
        Client.request(Api, input.target, (client) => client.admin.vaultsDelete({ payload: { passphrase, vault } })),
      ),
  })

// `hush token list`: one `admin/tokens/list`.
export const tokenList = (input: { readonly target: Target; readonly source: SecretSource }) =>
  passphraseCommand({
    command: "token list",
    source: input.source,
    secrets: passphraseOnly,
    prepare: Effect.void,
    send: (_, passphrase) =>
      Client.request(Api, input.target, (client) => client.admin.tokensList({ payload: { passphrase } })),
  })

export interface RevokeReceipt extends TokenRevoked {
  // Whether the saved entry for this Server held the revoked Label and was removed.
  readonly forgotLocally: boolean
}

// The receipt for stdout and the notices for stderr.
export interface Revoked {
  readonly receipt: RevokeReceipt
  readonly notices: ReadonlyArray<string>
}

// `hush token revoke <label>`: one `admin/tokens/revoke`, then the saved entry for this Server is removed when it
// has the revoked Label. The Revoke has happened by then, so a token file that cannot be changed is a notice
// beside the receipt, not a failure.
export const tokenRevoke = (input: {
  readonly target: Target
  readonly source: SecretSource
  readonly label: string
  readonly env: EnvVars
}) =>
  passphraseCommand({
    command: "token revoke",
    source: input.source,
    secrets: passphraseOnly,
    prepare: parse("label", input.label),
    send: (label, passphrase) =>
      Effect.gen(function* () {
        const revoked = yield* unverifiedOnTransport(
          Client.request(Api, input.target, (client) => client.admin.tokensRevoke({ payload: { passphrase, label } })),
        )

        const forgotten = yield* Effect.result(TokenStore.forget(input.target, input.env, label))

        const delivered: Revoked = Result.match(forgotten, {
          onSuccess: (dropped) => ({ receipt: { ...revoked, forgotLocally: dropped !== undefined }, notices: [] }),
          onFailure: (error) => ({
            receipt: { ...revoked, forgotLocally: false },
            notices: [`The Token was revoked, but its saved entry was not removed: ${CliError.render(error)}`],
          }),
        })

        return delivered
      }),
  })

// `hush token status`: the Token this CLI would send, described by one `token/describe`.
export const tokenStatus = (input: { readonly target: Target; readonly env: EnvVars }) =>
  Effect.gen(function* () {
    const choice = yield* TokenStore.current(input.target, input.env)

    const described = yield* Client.request(
      Api,
      input.target,
      (client) => client.token.describe({ payload: {} }),
      choice.token,
    )

    return { ...described, source: choice._tag === "Env" ? "env" : "file" } as const
  })

const Receipt = Schema.Struct({ token: Token.schema })

// `token save` input: text that parses as JSON must be an object whose `token` is a Token,
// as in a `token issue --print` receipt; any other text, trimmed, must be a Token.
export const tokenInput = (text: string): Result.Result<Token, TokenInputInvalid> =>
  Result.match(Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(text), {
    onSuccess: (json) =>
      Result.match(Schema.decodeUnknownResult(Receipt)(json), {
        onSuccess: ({ token }) => Result.succeed(token),
        onFailure: () => Result.fail(new TokenInputInvalid()),
      }),
    onFailure: () => Result.mapError(Token.parse(text.trim()), () => new TokenInputInvalid()),
  })

// `hush token save (--stdin | --prompt | --clipboard) [--replace]`: the Token from exactly one
// source, verified by one `token/describe` (the operation itself, not a preflight), then saved for this Server
// under the Label the Server gave it.
export const tokenSave = (input: {
  readonly target: Target
  readonly sources: PrivateInput.SourceFlags
  readonly replace: boolean
  readonly env: EnvVars
}) =>
  Effect.gen(function* () {
    const wording = { noun: "Token", outcome: "saved" } as const
    const source = yield* Effect.fromResult(PrivateInput.source(input.sources, wording.outcome))
    yield* TokenStore.checkReplaceable(input.target, input.replace, input.env, "save")
    const text = yield* PrivateInput.read({ source, wording, prompt: "Token: " })
    const token = Redacted.make(yield* Effect.fromResult(tokenInput(Redacted.value(text))))

    const described = yield* Client.request(
      Api,
      input.target,
      (client) => client.token.describe({ payload: {} }),
      token,
    )

    const label = Name.parse(described.label)

    if (Result.isFailure(label)) return yield* new UnexpectedResponse({ url: input.target.origin, status: 200 })

    const saved = yield* TokenStore.save(
      { server: input.target.origin, label: label.success, token },
      input.replace,
      input.env,
      "save",
    )

    return {
      saved: saved.path,
      label: described.label,
      grants: described.grants,
      expiresAt: described.expiresAt,
      ...(saved.replaced === undefined ? {} : { replaced: saved.replaced }),
    }
  })

// `hush token forget`: drops the saved entry for this Server and contacts nothing, so the Token stays valid on the
// Server. With no entry, `NoToken`.
export const tokenForget = (input: { readonly target: Target; readonly env: EnvVars }) =>
  Effect.gen(function* () {
    const forgotten = yield* TokenStore.forget(input.target, input.env)

    if (forgotten === undefined) return yield* new NoToken({ server: input.target.origin })

    return { forgotten: true, label: forgotten.label, revoked: false } as const
  })

// `hush passphrase change`: the current Passphrase, then the new one twice; one `admin/passphrase/change`.
export const passphraseChange = (input: { readonly target: Target; readonly source: SecretSource }) =>
  passphraseCommand({
    command: "passphrase change",
    source: input.source,
    secrets: withNewPassphrase(sequences.change),
    prepare: Effect.void,
    send: (_, secrets) =>
      unverifiedOnTransport(
        Client.request(Api, input.target, (client) =>
          client.admin.passphraseChange({
            payload: { passphrase: secrets.first, newPassphrase: secrets.passphrase },
          }),
        ),
      ),
  })

// Told on stderr after a successful Init.
export const writeDownNotice =
  "Write the Passphrase down now and keep it offline: there is no reset, and without it nobody can manage Vaults, Tokens or Items on this Server again."

// Where an issued Token goes: saved for this Server (over an existing entry only with `replace`), or printed in
// the receipt and saved nowhere.
export type Delivery = { readonly _tag: "Save"; readonly replace: boolean } | { readonly _tag: "Print" }

// `init --vault`: the first Vault and the Read+Create Token Init issues for it.
export interface FirstVault {
  readonly vault: string
  // Defaults to `<user> on <hostname>`.
  readonly label: string | undefined
  readonly delivery: Delivery
}

export const defaultLabel = () => CliError.accountLabel(TokenStore.account())

const parse = (what: string, input: string) => Effect.fromResult(parseName(what, input))

// Saves a Token the Server has just issued. It cannot be shown again, so any failure is `TokenNotSaved`, which
// tells the human to Revoke it.
export const saveIssued = (input: {
  readonly target: Target
  readonly label: Name
  readonly token: Redacted.Redacted<Token>
  readonly replace: boolean
  readonly env: EnvVars
}) =>
  TokenStore.save(
    { server: input.target.origin, label: input.label, token: input.token },
    input.replace,
    input.env,
    "issue",
  ).pipe(Effect.mapError((cause) => new TokenNotSaved({ label: input.label, path: TokenStore.path(input.env), cause })))

// `hush init`: validates names and runs the token-file checks, then reads the code and the new
// Passphrase, refuses an empty code, then sends one request. The code is stripped of surrounding
// whitespace and lowercased, so a pasted code works. The Server checks the policy and the names again.
export const init = (input: {
  readonly target: Target
  readonly source: SecretSource
  readonly firstVault: FirstVault | undefined
  readonly env: EnvVars
}) => {
  const { target, source, firstVault, env } = input

  return passphraseCommand({
    command: "init",
    source,
    secrets: withNewPassphrase(sequences.init),
    prepare: Effect.gen(function* () {
      if (firstVault === undefined) return undefined

      const first = {
        vault: yield* parse("vault", firstVault.vault),
        label: yield* parse("label", firstVault.label ?? defaultLabel()),
        delivery: firstVault.delivery,
      }

      if (first.delivery._tag === "Save") yield* TokenStore.checkSavable(target, first.delivery.replace, env)

      return first
    }),
    send: (first, secrets) => sendInit({ target, env, first, secrets }),
  })
}

// The local check on the code, then the one `admin/init` request and the Token's delivery.
const sendInit = (input: {
  readonly target: Target
  readonly env: EnvVars
  readonly first: { readonly vault: Name; readonly label: Name; readonly delivery: Delivery } | undefined
  readonly secrets: Secrets
}) =>
  Effect.gen(function* () {
    const { target, env, first, secrets } = input
    const initCode = Redacted.value(secrets.first).trim().toLowerCase()

    if (initCode === "") return yield* new InitCodeEmpty()

    const receipt = yield* Client.request(Api, target, (client) =>
      client.admin.init({
        payload: {
          initCode: Redacted.make(initCode),
          passphrase: secrets.passphrase,
          ...(first === undefined ? {} : { first: { vault: first.vault, label: first.label } }),
        },
      }),
    )

    if (first === undefined) return { state: receipt.state }

    if (receipt.first === undefined) return yield* new UnexpectedResponse({ url: target.origin, status: 200 })
    const { vault, label, grants } = receipt.first
    const parsed = Token.parse(Redacted.value(receipt.first.token))

    if (Result.isFailure(parsed)) return yield* new UnexpectedResponse({ url: target.origin, status: 200 })

    switch (first.delivery._tag) {
      case "Print":
        return { state: receipt.state, vault, label, grants, token: parsed.success }
      case "Save": {
        const saved = yield* saveIssued({
          target,
          label: first.label,
          token: Redacted.make(parsed.success),
          replace: first.delivery.replace,
          env,
        })

        return { state: receipt.state, vault, label, grants, saved: saved.path }
      }
    }
  })

const ttlUnits = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 } as const

const isTtlUnit = (unit: string): unit is keyof typeof ttlUnits => Object.hasOwn(ttlUnits, unit)

// A duration such as `90d` (`^[1-9]\d*[smhdw]$`) in seconds; undefined for anything else.
const durationSeconds = (text: string): number | undefined => {
  const [, count, unit] = /^([1-9]\d*)([smhdw])$/.exec(text) ?? []

  if (count === undefined || unit === undefined || !isTtlUnit(unit)) return undefined

  return Number(count) * ttlUnits[unit]
}

// `--ttl`: a duration of at most 3650 days, in seconds.
export const parseTtl = (ttl: string): Result.Result<number, IssueFlagsInvalid> => {
  const seconds = durationSeconds(ttl)

  return seconds === undefined || seconds > maxTtlSeconds
    ? Result.fail(new IssueFlagsInvalid({ problem: { reason: "ttl", ttl } }))
    : Result.succeed(seconds)
}

// The `hush audit` flags as typed; each optional.
export interface AuditFlags {
  readonly vault: string | undefined
  readonly label: string | undefined
  readonly since: string | undefined
  readonly limit: string | undefined
  readonly before: string | undefined
}

// The request's filters, as `admin/audit` takes them.
export type AuditQuery = Omit<AuditRequest, "passphrase">

// A date, or a date and time with a zone; seconds and milliseconds optional. A date alone is midnight UTC.
const isoTime = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/

// `--since`: a duration back from `nowMs`, or an ISO 8601 time, as the instant the Server compares.
// A duration reaching back before 1970 means from the start of the log.
export const parseSince = (since: string, nowMs: number): Result.Result<string, AuditFlagsInvalid> => {
  const seconds = durationSeconds(since)
  const ms = seconds === undefined ? (isoTime.test(since) ? Date.parse(since) : Number.NaN) : nowMs - seconds * 1000

  return Number.isNaN(ms)
    ? Result.fail(new AuditFlagsInvalid({ problem: { flag: "since", input: since } }))
    : Result.succeed(new Date(Math.max(ms, 0)).toISOString())
}

// A whole number from 1 to `max` in plain decimal digits.
const wholeNumber = (text: string, max: number): number | undefined => {
  if (!/^[1-9]\d*$/.test(text)) return undefined
  const parsed = Number(text)

  return parsed <= max ? parsed : undefined
}

// `--limit` or `--before`, when given: a whole number from 1 to `max`.
const numberFlag = (
  flags: AuditFlags,
  flag: "limit" | "before",
  max: number,
): Result.Result<number | undefined, AuditFlagsInvalid> => {
  const input = flags[flag]

  if (input === undefined) return Result.succeed(undefined)
  const parsed = wholeNumber(input, max)

  return parsed === undefined
    ? Result.fail(new AuditFlagsInvalid({ problem: { flag, input } }))
    : Result.succeed(parsed)
}

// The `hush audit` flags into the request's filters, checked before any secret is read.
export const auditQuery = (
  flags: AuditFlags,
  nowMs: number,
): Result.Result<AuditQuery, AuditFlagsInvalid | InvalidName> =>
  Result.gen(function* () {
    const vault = flags.vault === undefined ? undefined : yield* parseName("vault", flags.vault)
    const label = flags.label === undefined ? undefined : yield* parseName("label", flags.label)
    const since = flags.since === undefined ? undefined : yield* parseSince(flags.since, nowMs)
    const limit = yield* numberFlag(flags, "limit", auditLimit.max)
    const before = yield* numberFlag(flags, "before", Number.MAX_SAFE_INTEGER)

    const query: AuditQuery = {
      ...(vault === undefined ? {} : { vault }),
      ...(label === undefined ? {} : { label }),
      ...(since === undefined ? {} : { since }),
      ...(limit === undefined ? {} : { limit }),
      ...(before === undefined ? {} : { before }),
    }

    return query
  })

// `hush audit`: the flags, then the Passphrase, then one `admin/audit`. It never sends a Token.
export const audit = (input: { readonly target: Target; readonly source: SecretSource; readonly flags: AuditFlags }) =>
  passphraseCommand({
    command: "audit",
    source: input.source,
    secrets: passphraseOnly,
    prepare: Effect.gen(function* () {
      return yield* Effect.fromResult(auditQuery(input.flags, yield* Clock.currentTimeMillis))
    }),
    send: (query, passphrase) =>
      Client.request(Api, input.target, (client) => client.admin.audit({ payload: { passphrase, ...query } })),
  })

export interface TokenIssueInput {
  readonly target: Target
  readonly source: SecretSource
  readonly label: string
  readonly read: ReadonlyArray<string>
  readonly create: ReadonlyArray<string>
  readonly keepGrants: boolean
  readonly ttl: string | undefined
  // `--replace`: revoke the Server's Token with this Label, and overwrite the saved entry for this Server.
  readonly replace: boolean
  readonly print: boolean
  readonly env: EnvVars
}

// What happens to the Token with the same Label: nothing (a live one is `TokenLabelExists`), or revoked in the
// issue transaction, optionally handing its Grants on.
type Replacement = { readonly _tag: "None" } | { readonly _tag: "Replace"; readonly keepGrants: boolean }

const replacementOf = (input: TokenIssueInput): Result.Result<Replacement, IssueFlagsInvalid> => {
  if (input.replace) return Result.succeed({ _tag: "Replace", keepGrants: input.keepGrants })

  return input.keepGrants
    ? Result.fail(new IssueFlagsInvalid({ problem: { reason: "keep-grants-needs-replace" } }))
    : Result.succeed({ _tag: "None" })
}

// The flags and names of `token issue`, checked before any secret is read; a Vault named twice, by name identity,
// is refused here and never sent.
const issueFlags = (input: TokenIssueInput) =>
  Effect.gen(function* () {
    const replacement = yield* Effect.fromResult(replacementOf(input))
    const keepGrants = replacement._tag === "Replace" && replacement.keepGrants

    if (input.read.length + input.create.length === 0 && !keepGrants)
      return yield* new IssueFlagsInvalid({ problem: { reason: "no-grants" } })
    const ttlSeconds = input.ttl === undefined ? undefined : yield* Effect.fromResult(parseTtl(input.ttl))
    const label = yield* parse("label", input.label)

    const requested: ReadonlyArray<{ readonly vault: string; readonly access: Access }> = [
      ...input.read.map((vault) => ({ vault, access: "read" as const })),
      ...input.create.map((vault) => ({ vault, access: "read+create" as const })),
    ]

    const grants: Array<Grant> = []

    for (const { vault: name, access } of requested) {
      const vault = yield* parse("vault", name)

      if (grants.some((grant) => Name.key(grant.vault) === Name.key(vault)))
        return yield* new IssueFlagsInvalid({ problem: { reason: "vault-twice", vault } })
      grants.push({ vault, access })
    }

    return { label, grants, ttlSeconds, replacement }
  })

// Told on stderr when a save overwrote the entry of a Token with another Label, which this issue did not revoke.
const stillActiveNotice = (label: string) =>
  `The Token labelled ${label}, whose saved entry was replaced, is still active on the Server; revoke it with \`hush token revoke "${label}"\`.`

// The receipts of `token issue`. The printed one is the only place a Token reaches stdout.
interface IssuedShown {
  readonly label: string
  readonly grants: TokenIssueReceipt["grants"]
  readonly expiresAt: string | null
  readonly revokedOnServer: boolean
}

export interface PrintedReceipt extends IssuedShown {
  readonly token: Token
}

export interface SavedReceipt extends IssuedShown {
  readonly saved: string
  // The Label of the saved entry this save overwrote, and again under `stillActive` when it was another Label.
  readonly replacedLocally?: string
  readonly stillActive?: string
}

// The receipt for stdout and the notices for stderr.
export interface Delivered {
  readonly receipt: PrintedReceipt | SavedReceipt
  readonly notices: ReadonlyArray<string>
}

// `hush token issue`: flags and names, then the token-file checks unless `--print`, then the Passphrase, then one
// `admin/tokens/issue`, then the Token's delivery.
export const tokenIssue = (input: TokenIssueInput) => {
  const delivery: Delivery = input.print ? { _tag: "Print" } : { _tag: "Save", replace: input.replace }

  return passphraseCommand({
    command: "token issue",
    source: input.source,
    secrets: passphraseOnly,
    prepare: Effect.gen(function* () {
      const flags = yield* issueFlags(input)

      if (delivery._tag === "Save") yield* TokenStore.checkSavable(input.target, delivery.replace, input.env)

      return flags
    }),
    send: ({ label, grants, ttlSeconds, replacement }, passphrase) =>
      Effect.gen(function* () {
        const issued = yield* unverifiedOnTransport(
          Client.request(Api, input.target, (client) =>
            client.admin.tokensIssue({
              payload: {
                passphrase,
                label,
                grants,
                ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
                ...(replacement._tag === "Replace" ? { replaces: true } : {}),
                ...(replacement._tag === "Replace" && replacement.keepGrants ? { keepGrants: true } : {}),
              },
            }),
          ),
        )

        return yield* deliverIssued({ target: input.target, issued, label, delivery, env: input.env })
      }),
  })
}

// An issued Token printed in the receipt, or saved for this Server over its existing entry (the pre-prompt check
// allowed it); a failed save is `TokenNotSaved` and never prints the Token. `label` is the Label sent.
export const deliverIssued = (input: {
  readonly target: Target
  readonly issued: TokenIssueReceipt
  readonly label: Name
  readonly delivery: Delivery
  readonly env: EnvVars
}) =>
  Effect.gen(function* () {
    const { target, issued, label, delivery } = input
    const parsed = Token.parse(Redacted.value(issued.token))

    if (Result.isFailure(parsed)) return yield* new UnexpectedResponse({ url: target.origin, status: 200 })

    const shown: IssuedShown = {
      label: issued.label,
      grants: issued.grants,
      expiresAt: issued.expiresAt,
      revokedOnServer: issued.replaced,
    }

    if (delivery._tag === "Print") {
      const printed: Delivered = { receipt: { ...shown, token: parsed.success }, notices: [] }

      return printed
    }

    const token = Redacted.make(parsed.success)
    const saved = yield* saveIssued({ target, label, token, replace: delivery.replace, env: input.env })
    const previous = saved.replaced

    const stillActive =
      previous === undefined ||
      Result.match(Name.parse(previous), {
        onFailure: () => false,
        onSuccess: (old) => Name.key(old) === Name.key(label),
      })
        ? undefined
        : previous

    const receipt: SavedReceipt = {
      ...shown,
      saved: saved.path,
      ...(previous === undefined ? {} : { replacedLocally: previous }),
      ...(stillActive === undefined ? {} : { stillActive }),
    }

    const delivered: Delivered = {
      receipt,
      notices: stillActive === undefined ? [] : [stillActiveNotice(stillActive)],
    }

    return delivered
  })

export * as Admin from "./Admin.js"
