import { Match, Schema } from "effect"

import { auditLimit } from "../shared/Api.js"
import type { ApiError, Damaged, TokenRejected } from "../shared/ApiError.js"
import { FileWriteFailed, OutputExists } from "../shared/OutputFile.js"
import { Reference } from "../shared/Reference.js"
import { RouteView } from "./Route.js"

// CLI errors. Each carries only typed, non-secret fields; `render` builds the message,
// which `cli.ts` prints as `hush: <message>` with exit 1. `FileWriteFailed` and `OutputExists` live with the
// file step the host commands share (`OutputFile`).

export { FileWriteFailed, OutputExists }

// The create receipt was lost after the write was sent, so the write is unverified and must not be retried.
export class CreationMayHaveSucceeded extends Schema.TaggedError<CreationMayHaveSucceeded>()(
  "CreationMayHaveSucceeded",
  { title: Schema.String, vault: Schema.String },
) {}

// The read-back after a create failed or differed from what was sent.
export class CreationUnverified extends Schema.TaggedError<CreationUnverified>()("CreationUnverified", {
  title: Schema.String,
  vault: Schema.String,
  // `Reference.format` of the created Item's primary Field; `ref` is the receipt's field name.
  ref: Schema.String,
}) {}

// The connection failed after a Passphrase write was sent, so it may or may not have happened.
export class ChangeUnverified extends Schema.TaggedError<ChangeUnverified>()("ChangeUnverified", {}) {}

// A transport failure before any response. `route` is the way the request took, with a proxy as `host:port` only
// (its URL may carry credentials); `address` is the Server's `host:port`, for a sandbox's allowed domains.
export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()("ServerUnreachable", {
  url: Schema.String,
  address: Schema.String,
  route: RouteView,
  reason: Schema.Literals(["refused", "timed out", "other"]),
}) {}

// An undeclared status or an undecodable body; the body itself is never shown (invariant 2).
export class UnexpectedResponse extends Schema.TaggedError<UnexpectedResponse>()("UnexpectedResponse", {
  url: Schema.String,
  status: Schema.Number,
}) {}

// Bun's empty 413 for a body over the Server's 1 MiB limit.
export class RequestTooLarge extends Schema.TaggedError<RequestTooLarge>()("RequestTooLarge", {}) {}

// Where a CLI setting came from: the environment (`HUSH_SERVER`, `HUSH_PROXY`), the config file, or the argument
// of `hush config set`.
const EnvSource = Schema.Struct({ from: Schema.Literal("env") })
const ConfigSource = Schema.Struct({ from: Schema.Literal("config"), path: Schema.String })

export class ServerUrlInvalid extends Schema.TaggedError<ServerUrlInvalid>()("ServerUrlInvalid", {
  source: Schema.Union([EnvSource, ConfigSource, Schema.Struct({ from: Schema.Literal("argument") })]),
  // A fixed text from `Target`, never the URL itself.
  reason: Schema.String,
}) {}

// The config file cannot be used, or a proxy mode (from `HUSH_PROXY` or the file) is not `auto` or `direct`.
export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  problem: Schema.Union([
    Schema.Struct({ reason: Schema.Literal("unreadable"), path: Schema.String, code: Schema.String }),
    Schema.Struct({ reason: Schema.Literals(["not-json", "invalid"]), path: Schema.String }),
    Schema.Struct({ reason: Schema.Literal("proxy-mode"), source: Schema.Union([EnvSource, ConfigSource]) }),
  ]),
}) {}

// What a refused command leaves untouched, as the catalogue words it: "nothing was <outcome>".
export const Outcome = Schema.Literals(["created", "changed", "saved"])

export type Outcome = typeof Outcome.Type

// Private input that cannot be sent: not strict UTF-8, holding a NUL, or over 64 KiB.
export class InvalidValue extends Schema.TaggedError<InvalidValue>()("InvalidValue", {
  noun: Schema.String,
  reason: Schema.Literals(["not-utf8", "nul", "too-long"]),
  outcome: Outcome,
}) {}

// Private input that is empty or whitespace once one trailing newline is stripped.
export class InputEmpty extends Schema.TaggedError<InputEmpty>()("InputEmpty", {
  noun: Schema.String,
  outcome: Outcome,
}) {}

// No value source flag, or several; both are refused before any input is read.
export class InputSourceRequired extends Schema.TaggedError<InputSourceRequired>()("InputSourceRequired", {
  outcome: Outcome,
}) {}

export class InputSourceConflict extends Schema.TaggedError<InputSourceConflict>()("InputSourceConflict", {
  outcome: Outcome,
}) {}

// An argument that is not a Reference, refused before any request. `input` is what was typed.
export class InvalidReference extends Schema.TaggedError<InvalidReference>()("InvalidReference", {
  input: Schema.String,
  reason: Schema.Literals(Reference.invalidReasons),
}) {}

// Why an `--env` or `env write` argument is not `NAME=hush://Vault/Item/field`.
export const AssignmentReason = Schema.Literals([
  "not-assignment",
  "op-reference",
  ...Reference.invalidReasons.map((reason) => `reference-${reason}` as const),
])

export type AssignmentReason = typeof AssignmentReason.Type

// An assignment argument refused before any request. `position` is its 1-based place among the assignments; the
// text itself is never kept, since a refused assignment may be a pasted secret (invariant 1).
export class InvalidAssignment extends Schema.TaggedError<InvalidAssignment>()("InvalidAssignment", {
  position: Schema.Number,
  reason: AssignmentReason,
}) {}

// A template line that `env run` or `env resolve` cannot use: the path, the 1-based line number and a
// fixed reason code, never the line's text, which may be a stray pasted secret.
export class EnvFileInvalid extends Schema.TaggedError<EnvFileInvalid>()("EnvFileInvalid", {
  path: Schema.String,
  line: Schema.Number,
  reason: AssignmentReason,
}) {}

// `env resolve` without exactly one of `--output` and `--in-place`; refused before the template is read.
export class EnvTargetInvalid extends Schema.TaggedError<EnvTargetInvalid>()("EnvTargetInvalid", {}) {}

export class EnvFileUnreadable extends Schema.TaggedError<EnvFileUnreadable>()("EnvFileUnreadable", {
  path: Schema.String,
  code: Schema.String,
}) {}

// The command `run` was given; never its arguments.
const childFields = { command: Schema.String }

// Secrets were resolved, but the executable was not found, so nothing saw them.
export class ChildNotFound extends Schema.TaggedError<ChildNotFound>()("ChildNotFound", childFields) {}

// The child died from a signal; `signal` is its name, or `unknown` when Effect's message did not name one.
export class ChildSignalled extends Schema.TaggedError<ChildSignalled>()("ChildSignalled", {
  ...childFields,
  signal: Schema.String,
}) {}

// Any other spawner failure; its details are suppressed.
export class ChildFailed extends Schema.TaggedError<ChildFailed>()("ChildFailed", childFields) {}

// No `HUSH_TOKEN` and no token-file entry for this Server; `vault` is the Vault the command was for, when it names
// one.
export class NoToken extends Schema.TaggedError<NoToken>()("NoToken", {
  server: Schema.String,
  vault: Schema.optionalKey(Schema.String),
}) {}

// `hush token issue` flags that cannot make a request; refused before any prompt.
export const IssueProblem = Schema.Union([
  Schema.Struct({ reason: Schema.Literal("vault-twice"), vault: Schema.String }),
  Schema.Struct({ reason: Schema.Literals(["no-grants", "keep-grants-needs-replace"]) }),
  Schema.Struct({ reason: Schema.Literal("ttl"), ttl: Schema.String }),
])

export type IssueProblem = typeof IssueProblem.Type

export class IssueFlagsInvalid extends Schema.TaggedError<IssueFlagsInvalid>()("IssueFlagsInvalid", {
  problem: IssueProblem,
}) {}

// A `hush audit` flag that cannot make a request; refused before any prompt. `input` is the flag's text.
export const AuditProblem = Schema.Struct({
  flag: Schema.Literals(["since", "limit", "before"]),
  input: Schema.String,
})

export type AuditProblem = typeof AuditProblem.Type

export class AuditFlagsInvalid extends Schema.TaggedError<AuditFlagsInvalid>()("AuditFlagsInvalid", {
  problem: AuditProblem,
}) {}

// `hush item edit` without exactly one of `--field` and `--remove`, or with a value source beside `--remove`;
// refused before any prompt.
export class EditFlagsInvalid extends Schema.TaggedError<EditFlagsInvalid>()("EditFlagsInvalid", {}) {}

// `HUSH_TOKEN` is not a well-formed Token (`hush_` plus 43 base64url characters); the token file is not tried
// (invariant 6).
export class TokenEnvInvalid extends Schema.TaggedError<TokenEnvInvalid>()("TokenEnvInvalid", {}) {}

// Why the token file could not be used; its content is never shown.
const TokenFileProblem = Schema.Union([
  Schema.Struct({ reason: Schema.Literal("unreadable"), code: Schema.String }),
  Schema.Struct({ reason: Schema.Literals(["not-json", "invalid"]) }),
])

export class TokenFileInvalid extends Schema.TaggedError<TokenFileInvalid>()("TokenFileInvalid", {
  path: Schema.String,
  problem: TokenFileProblem,
}) {}

// Group or other permission bits on the token file; `mode` is the octal permission bits, e.g. `644`.
export class TokenFileInsecure extends Schema.TaggedError<TokenFileInsecure>()("TokenFileInsecure", {
  path: Schema.String,
  mode: Schema.String,
}) {}

// A Token for this Server is saved and `--replace` was not given; `label` is the saved entry's. `command` is what
// was saving: a Token being issued (`init --vault`, `token issue`), which `--print` could print instead, or one
// given to `token save`.
export class TokenAlreadySaved extends Schema.TaggedError<TokenAlreadySaved>()("TokenAlreadySaved", {
  label: Schema.String,
  command: Schema.Literals(["issue", "save"]),
}) {}

// `token save` input that is neither a Token nor a `token issue --print` receipt holding one;
// refused before any request. The input is never shown.
export class TokenInputInvalid extends Schema.TaggedError<TokenInputInvalid>()("TokenInputInvalid", {}) {}

// The backup stream's size or SHA-256 differs from the Server's headers; nothing was written.
export class BackupCorrupt extends Schema.TaggedError<BackupCorrupt>()("BackupCorrupt", {}) {}

// The Server issued a Token that the CLI then failed to save; it cannot be shown again. `cause` is why the save
// failed, though the checks before the request had passed.
export class TokenNotSaved extends Schema.TaggedError<TokenNotSaved>()("TokenNotSaved", {
  label: Schema.String,
  path: Schema.String,
  cause: Schema.Union([FileWriteFailed, TokenAlreadySaved, TokenFileInvalid, TokenFileInsecure]),
}) {}

// `--passphrase-stdin` framing broken: a secret line missing, or anything after the last one.
export class StdinFramingInvalid extends Schema.TaggedError<StdinFramingInvalid>()("StdinFramingInvalid", {
  command: Schema.String,
  // The secret lines in order, e.g. "the Init code".
  expected: Schema.Array(Schema.String),
}) {}

export class StdinIsTerminal extends Schema.TaggedError<StdinIsTerminal>()("StdinIsTerminal", {
  flag: Schema.Literals(["--stdin", "--passphrase-stdin"]),
  outcome: Outcome,
}) {}

// The Init code is empty after stripping; refused before any request.
export class InitCodeEmpty extends Schema.TaggedError<InitCodeEmpty>()("InitCodeEmpty", {}) {}

// No `/dev/tty` to prompt on: a Passphrase command without `--passphrase-stdin`, or `--prompt` for a
// value, whose message points to `--stdin` instead.
export class NoTerminal extends Schema.TaggedError<NoTerminal>()("NoTerminal", {
  prompt: Schema.Union([
    Schema.Struct({ for: Schema.Literal("passphrase"), command: Schema.String }),
    Schema.Struct({ for: Schema.Literal("value"), outcome: Outcome }),
  ]),
}) {}

// `hush ui` started with stdin or stdout piped or redirected, as an agent's shell runs it.
export class UiNeedsTerminal extends Schema.TaggedError<UiNeedsTerminal>()("UiNeedsTerminal", {
  stream: Schema.Literals(["stdin", "stdout", "stdin and stdout"]),
}) {}

// Ctrl-C, or Ctrl-D on an empty line, at a hidden prompt; the terminal mode is restored.
export class PromptCancelled extends Schema.TaggedError<PromptCancelled>()("PromptCancelled", {}) {}

// The repeat of a new Passphrase differs from it; nothing is sent.
export class PassphraseMismatch extends Schema.TaggedError<PassphraseMismatch>()("PassphraseMismatch", {}) {}

// `--clipboard` anywhere but macOS, where `pbpaste` exists.
export class ClipboardUnsupported extends Schema.TaggedError<ClipboardUnsupported>()("ClipboardUnsupported", {
  outcome: Outcome,
}) {}

// Private input that could not be read: an I/O error on stdin, or `pbpaste` failing. The cause is left out, as
// it may echo the input.
export class InputUnreadable extends Schema.TaggedError<InputUnreadable>()("InputUnreadable", {
  noun: Schema.String,
  outcome: Outcome,
}) {}

export type CliError =
  | CreationMayHaveSucceeded
  | CreationUnverified
  | ChangeUnverified
  | ServerUnreachable
  | UnexpectedResponse
  | RequestTooLarge
  | ServerUrlInvalid
  | ConfigInvalid
  | InvalidValue
  | StdinFramingInvalid
  | StdinIsTerminal
  | InitCodeEmpty
  | NoTerminal
  | UiNeedsTerminal
  | PromptCancelled
  | PassphraseMismatch
  | ClipboardUnsupported
  | InputUnreadable
  | InputEmpty
  | InputSourceRequired
  | InputSourceConflict
  | InvalidReference
  | InvalidAssignment
  | EnvFileInvalid
  | EnvFileUnreadable
  | EnvTargetInvalid
  | ChildNotFound
  | ChildSignalled
  | ChildFailed
  | NoToken
  | IssueFlagsInvalid
  | AuditFlagsInvalid
  | EditFlagsInvalid
  | TokenEnvInvalid
  | TokenFileInvalid
  | TokenFileInsecure
  | TokenAlreadySaved
  | TokenInputInvalid
  | FileWriteFailed
  | TokenNotSaved
  | OutputExists
  | BackupCorrupt

const invalidInputText = {
  "not-utf8": "is not valid UTF-8",
  nul: "contains a NUL byte",
  "too-long": "is over 64 KiB",
} as const

const tokenFileReasonText = ({ problem }: TokenFileInvalid) => {
  switch (problem.reason) {
    case "unreadable":
      return `unreadable: ${problem.code}`
    case "not-json":
      return "not JSON"
    case "invalid":
      return "not a hush token file"
  }
}

// Why an issued Token's save failed, as the parenthesis of `TokenNotSaved`.
const notSavedReasonText = ({ cause }: TokenNotSaved) =>
  Match.valueTags(cause, {
    FileWriteFailed: ({ code }) => code,
    TokenAlreadySaved: ({ label }) => `a Token labelled ${label} was saved meanwhile`,
    TokenFileInvalid: (invalid) => `the token file is ${tokenFileReasonText(invalid)}`,
    TokenFileInsecure: ({ mode }) => `the token file has mode ${mode}`,
  })

// Read again on the Server host: the code changes at every restart until Init succeeds.
const readInitCodeAgain =
  "Read the current code again on the Server host (same commands as for an uninitialised Server; it changes at every restart until Init succeeds) and run `hush init` again."

const listOf = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")}, then ${items.at(-1)}`

// The count and the noun, singular only for exactly 1.
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

const seconds = (n: number) => count(n, "second")

const findCommand = (title: string, vault: string) => `hush find "${title}" --vault ${vault}`

// The command that frees a Retired title, in backticks.
export const releaseCommand = (vault: string, title: string) => `\`hush item release ${vault} "${title}"\``

// The OS account running this CLI, whose token file `hush token issue` saves to. `user` is undefined when the OS
// has no name for it (a uid without a passwd entry, as in a container).
export interface Account {
  readonly user: string | undefined
  readonly hostname: string
}

// The account as the rendered command names it.
const accountName = ({ user }: Account) => user ?? "this CLI's account"

// The default Label for a Token this account saves: `<user> on <hostname>`, or `agent on <hostname>` without a name.
export const accountLabel = ({ user, hostname }: Account) => `${user ?? "agent"} on ${hostname}`

// The Grant flag a Token command needs: `--create` for `create`, `--read` otherwise.
export type GrantFlag = "--read" | "--create"

// What a Token command's errors need to render a complete `hush token issue` command: where
// its Token came from (`HUSH_TOKEN` wins when set), the account and the Grant flag. Absent for other commands.
export interface TokenContext {
  readonly source: "env" | "file"
  readonly account: Account
  readonly flag: GrantFlag
}

// `issue` (a `hush token issue` command without `--print`) for the Token's source: `--print` and `HUSH_TOKEN`
// for an env Token; for a file Token, the account whose file holds it and the form that saves into that file
// from another account.
const replacementCommand = (issue: string, token: TokenContext | undefined): string => {
  if (token === undefined) return `\`${issue}\``

  switch (token.source) {
    case "env":
      return `\`${issue} --print\`, then put the printed Token in \`HUSH_TOKEN\``
    case "file":
      return `\`${issue}\` as ${accountName(token.account)} on ${token.account.hostname}, whose token file holds this Token; from another account: ${savedFor(issue, token.account, true)}`
  }
}

// `issue` run from another account, its printed Token saved into `account`'s token file.
// With `replace`, it overwrites the Token saved there. Without a user name there is no `sudo -u` target to give.
const savedFor = (issue: string, account: Account, replace: boolean) => {
  const save = `hush token save --stdin${replace ? " --replace" : ""}`

  return account.user === undefined
    ? `\`${issue} --print\`, then pipe the printed Token to \`${save}\` run as ${accountName(account)}`
    : `\`${issue} --print | sudo -u ${account.user} ${save}\``
}

const issueText = ({ problem }: IssueFlagsInvalid): string => {
  switch (problem.reason) {
    case "vault-twice":
      return `Vault ${problem.vault} is named twice; name each Vault once, with \`--read\` or \`--create\``
    case "no-grants":
      return "Pass at least one `--read <vault>` or `--create <vault>` (or `--keep-grants --replace` to keep the Grants of the Token being replaced)"
    case "keep-grants-needs-replace":
      return "`--keep-grants` copies the Grants of the Token being replaced, so it needs `--replace`"
    case "ttl":
      return `\`--ttl ${problem.ttl}\` is not a duration such as 90d (a whole number and one of s, m, h, d, w), at most 3650 days`
  }
}

const fileWriteText = ({ path, code, consequence }: FileWriteFailed): string => {
  switch (consequence) {
    case "before-prompt":
      return `Could not write the token file ${path} (${code}); nothing was issued and no prompt was shown. Run this command from a CLI machine, or add \`--print\` to print the Token instead of saving it.`
    case "not-saved":
      return `Could not write the token file ${path} (${code}); nothing was saved.`
    case "template":
      return `Could not write ${path} (${code}); no Server was contacted. Fix the path or its permissions and run \`hush env write\` again.`
    case "resolved":
      return `Could not write ${path} (${code}); it was not changed and no plaintext copy was left behind. Fix the path or its permissions and run \`hush env resolve\` again.`
    case "backup":
      return `Could not write ${path} (${code}); nothing was written. Check that its directory exists and is writable, and its free space.`
    case "config":
      return `Could not write the CLI config ${path} (${code}); it was not changed. Fix its directory's permissions and run \`hush config set\` again.`
  }
}

const replaceOp = "is a 1Password reference; replace `op://` with `hush://`"

// The parenthesis of `InvalidAssignment`.
const assignmentText = (reason: AssignmentReason): string => {
  switch (reason) {
    case "not-assignment":
      return "expected a variable name, `=` and a Reference"
    case "op-reference":
      return `the value ${replaceOp}`
    default:
      return `the Reference is invalid: ${reason.slice("reference-".length)}`
  }
}

// The fixed text for a template line's reason code; never the line itself.
const lineText = (reason: AssignmentReason): string => {
  switch (reason) {
    case "not-assignment":
      return "is not blank, a comment or NAME=value"
    case "op-reference":
      return replaceOp
    default:
      return `holds a hush:// value that is not a valid Reference (${reason.slice("reference-".length)})`
  }
}

// What to check when the Server does not answer a direct connection, after "check"; `hush doctor` says it too.
export const directCheck =
  "that it is running and that `HUSH_SERVER` or `server` in `~/.config/hush/config.json` points to it"

// A loopback proxy that `HUSH_PROXY=direct` turned off, and how to turn it back on; `hush doctor` says it too.
export const proxyDisabled =
  "A loopback HTTP_PROXY is set but HUSH_PROXY=direct (or config proxy: direct) disables it; inside an agent sandbox unset HUSH_PROXY (or run `hush config set proxy auto`)."

const unreachableText = ({ url, address, route, reason }: ServerUnreachable): string => {
  const failed = `Could not reach the hush Server at ${url}`
  const nothing = "nothing was read or changed"
  const doctor = "`hush doctor` shows the route."

  return Match.valueTags(route, {
    Direct: ({ unused }) =>
      `${failed} directly (${reason}); ${nothing}. Check ${directCheck}.${unused === "disabled" ? ` ${proxyDisabled}` : ""} ${doctor}`,
    Proxy: ({ proxy }) =>
      `${failed} through the loopback proxy at ${proxy} (${reason}); ${nothing}. Inside an agent sandbox, add \`${address}\` to its allowed domains; if that proxy is not a sandbox's, set HUSH_PROXY=direct, since it would otherwise receive Tokens in cleartext. ${doctor}`,
  })
}

const unusable = (path: string, why: string) =>
  `Could not read the CLI config ${path} (${why}); nothing was contacted or changed. Fix or remove the file, then run \`hush config set server http://<ip>:7787\` if needed.`

const configInvalidText = ({ problem }: ConfigInvalid): string => {
  switch (problem.reason) {
    case "proxy-mode":
      return problem.source.from === "env"
        ? "HUSH_PROXY must be `auto` or `direct`; nothing was contacted. Set `HUSH_PROXY=direct` to turn a loopback proxy off, or unset it."
        : `${problem.source.path} sets \`proxy\` to something other than \`auto\` or \`direct\`; nothing was contacted. Run \`hush config set proxy auto\` (or \`direct\`).`
    case "unreadable":
      return unusable(problem.path, `unreadable: ${problem.code}`)
    case "not-json":
      return unusable(problem.path, "not JSON")
    case "invalid":
      return unusable(problem.path, "not a hush config file")
  }
}

const auditText = ({ problem }: AuditFlagsInvalid): string => {
  switch (problem.flag) {
    case "since":
      return `\`--since ${problem.input}\` is neither a duration such as 7d (a whole number and one of s, m, h, d, w) nor an ISO 8601 time such as 2026-10-01 or 2026-10-01T09:00:00Z`
    case "limit":
      return `\`--limit ${problem.input}\` is not a whole number from 1 to ${auditLimit.max}`
    case "before":
      return `\`--before ${problem.input}\` is not an entry id (a whole number from 1, as a page's \`next\` gives it)`
  }
}

const inputSourceText = (error: InputSourceRequired | InputSourceConflict) =>
  `Pass exactly one of \`--stdin\` (piped value), \`--prompt\` (hidden prompt) or \`--clipboard\` (macOS); nothing was ${error.outcome}.`

export const render = (cliError: CliError, token?: TokenContext): string =>
  Match.valueTags(cliError, {
    ServerUnreachable: unreachableText,
    UnexpectedResponse: (error) =>
      `The hush Server at ${error.url} answered with something this CLI does not understand (HTTP ${error.status}); nothing is known to have changed. CLI and Server versions may differ; \`hush status\` shows both.`,
    RequestTooLarge: () =>
      "The request was larger than the Server accepts (1 MiB); nothing was changed. Values are limited to 64 KiB.",
    ServerUrlInvalid: (error) =>
      error.source.from === "argument"
        ? `That is not a valid Server URL (${error.reason}); nothing was saved. Use \`hush config set server http://<ip>:7787\`.`
        : `${error.source.from === "env" ? "HUSH_SERVER" : error.source.path} holds an invalid Server URL (${error.reason}); nothing was contacted. Use \`hush config set server http://<ip>:7787\`.`,
    ConfigInvalid: configInvalidText,
    CreationMayHaveSucceeded: (error) =>
      `Creation may have succeeded, but its receipt could not be verified. Do not retry creation; inspect the destination with ${findCommand(error.title, error.vault)} first.`,
    CreationUnverified: (error) =>
      `Creation is unverified. Do not retry creation; inspect the destination by title with ${findCommand(error.title, error.vault)} first. Item reference: ${error.ref}.`,
    ChangeUnverified: () =>
      "The connection failed after the request was sent, so the change may or may not have happened. Do not retry blindly; check with `hush vault list`, `hush token list` or `hush inventory`.",
    InvalidValue: (error) => `The ${error.noun} ${invalidInputText[error.reason]}; nothing was ${error.outcome}.`,
    InputEmpty: (error) => `The ${error.noun} is empty; nothing was ${error.outcome}.`,
    InputSourceRequired: inputSourceText,
    InputSourceConflict: inputSourceText,
    InvalidReference: (error) =>
      `${error.input} is not a hush Reference (${error.reason}); nothing was read or run. References look like \`hush://Vault/Item/field\`.`,
    NoToken: (error) => {
      const missing = `No hush Token is available for ${error.server} (\`HUSH_TOKEN\` unset, none saved for this Server); nothing was read.`

      if (token === undefined) return `${missing} A human can run \`hush token issue\`, or set \`HUSH_TOKEN\`.`
      const issue = `hush token issue --label "${accountLabel(token.account)}" ${token.flag} ${error.vault ?? "<vault>"}`

      return `${missing} A human can run \`${issue}\` as ${accountName(token.account)} on ${token.account.hostname} (the Token is saved to that account's token file), or from another account ${savedFor(issue, token.account, false)}, or set \`HUSH_TOKEN\`.`
    },
    IssueFlagsInvalid: (error) =>
      `${issueText(error)}; nothing was issued and no prompt was shown. See \`hush token issue --help\`.`,
    AuditFlagsInvalid: (error) =>
      `${auditText(error)}; nothing was read and no prompt was shown. See \`hush audit --help\`.`,
    EditFlagsInvalid: () =>
      "Pass either `--field <label>` with one of `--stdin`, `--prompt` or `--clipboard`, or `--remove <label>` alone; nothing was changed and no prompt was shown. See `hush item edit --help`.",
    TokenEnvInvalid: () =>
      "`HUSH_TOKEN` does not hold a hush Token (expected `hush_` and 43 characters); nothing was read and the token file was not tried. Fix or unset it.",
    TokenFileInvalid: (error) =>
      `Could not read the token file ${error.path} (${tokenFileReasonText(error)}); nothing was read and no other Token was tried. Fix or remove the file, or set \`HUSH_TOKEN\`.`,
    TokenFileInsecure: (error) =>
      `The token file ${error.path} has mode ${error.mode}, so other users may read its Token; nothing was read. Run \`chmod 600 ${error.path}\` and Revoke the Token if it may have been copied.`,
    TokenAlreadySaved: (error) =>
      error.command === "issue"
        ? `A Token for this Server is already saved (Label ${error.label}); nothing was issued or saved. Pass \`--replace\`, or \`--print\` to print the new Token instead.`
        : `A Token for this Server is already saved (Label ${error.label}); nothing was saved. Pass \`--replace\` to replace it.`,
    TokenInputInvalid: () =>
      "The input is not a hush Token (expected `hush_` and 43 characters) or a `hush token issue --print` receipt; nothing was saved.",
    FileWriteFailed: fileWriteText,
    OutputExists: (error) =>
      `${error.path} already exists; nothing was written. Choose a new file name; a backup never overwrites a file.`,
    BackupCorrupt: () =>
      "The backup stream did not match its size or SHA-256; nothing was written. Run `hush backup` again.",
    InvalidAssignment: (error) =>
      `Assignment ${error.position} is not NAME=hush://Vault/Item/field (${assignmentText(error.reason)}); nothing was read or run.`,
    EnvFileInvalid: (error) =>
      `${error.path} line ${error.line}: ${lineText(error.reason)}; nothing was resolved or run.`,
    EnvTargetInvalid: () => "Pass exactly one of `--output <path>` or `--in-place`; nothing was resolved or written.",
    EnvFileUnreadable: (error) => `Could not read ${error.path} (${error.code}); nothing was resolved or run.`,
    ChildNotFound: (error) =>
      `Could not start ${error.command}: not found; nothing was run (secrets were resolved but not exposed).`,
    ChildSignalled: (error) =>
      `${error.command} was killed by signal ${error.signal} before it exited, so its result is unknown.`,
    ChildFailed: (error) =>
      `Could not run ${error.command} (details suppressed); secrets were resolved but not exposed.`,
    TokenNotSaved: (error) =>
      `Token ${error.label} was issued but could not be saved to ${error.path} (${notSavedReasonText(error)}) and cannot be shown again. Revoke it with \`hush token revoke "${error.label}"\` and issue a new one.`,
    StdinFramingInvalid: (error) =>
      `stdin did not contain ${listOf(error.expected)}, one per line and nothing after; nothing was changed. See \`hush ${error.command} --help\`.`,
    StdinIsTerminal: (error) =>
      `\`${error.flag}\` reads piped input but stdin is a terminal; nothing was ${error.outcome}. Pipe the input, or use ${error.flag === "--stdin" ? "`--prompt`" : "the default prompt"}.`,
    InitCodeEmpty: () => `No Init code was entered; nothing was changed. ${readInitCodeAgain}`,
    NoTerminal: (error) =>
      error.prompt.for === "passphrase"
        ? `hush ${error.prompt.command} needs a human with the Passphrase at a terminal; nothing was changed. Run it from an interactive terminal (or pipe secrets with \`--passphrase-stdin\`). Agents cannot run it.`
        : `\`--prompt\` needs a terminal and there is none; nothing was ${error.prompt.outcome}. Pipe the value with \`--stdin\` instead.`,
    UiNeedsTerminal: (error) =>
      `\`hush ui\` needs an interactive terminal, but ${error.stream} ${error.stream === "stdin and stdout" ? "are" : "is"} not one; nothing was started. Run it yourself in a terminal, without pipes or redirection; agents cannot run it. Scripts use \`hush vault list\` and \`hush item list <vault>\` with \`--passphrase-stdin\`.`,
    PromptCancelled: () => "Cancelled at the prompt; nothing was changed.",
    PassphraseMismatch: () => "The two new Passphrases differ; nothing was changed.",
    ClipboardUnsupported: (error) =>
      `\`--clipboard\` works on macOS only; use \`--stdin\` or \`--prompt\`; nothing was ${error.outcome}.`,
    InputUnreadable: (error) =>
      `The ${error.noun} could not be read (details suppressed); nothing was ${error.outcome}.`,
  })

// The Server errors (`ApiError`), rendered from their typed fields and the Server origin; a response body
// never reaches the user verbatim (invariant 2).
export const renderServer = (apiError: ApiError, server: string, token?: TokenContext): string =>
  Match.valueTags(apiError, {
    HostNotAllowed: (error) =>
      error.host === null
        ? "The hush Server refused the request because it carried no Host header; nothing was read or changed. Point `HUSH_SERVER` at the Server's IP address."
        : `The hush Server refused the request because it was addressed as ${error.host}, which is not on its allowed list; nothing was read or changed. Start it with \`--allowed-host ${error.host.replace(/:\d*$/, "")}\` (or \`HUSH_ALLOWED_HOSTS\`), or point \`HUSH_SERVER\` at its IP address.`,
    FunnelRequestRefused: () =>
      "The hush Server refuses requests from Tailscale Funnel (the public internet); nothing was read or changed. Turn Funnel off for this port; use the tailnet.",
    BrowserRequestRefused: () =>
      "The hush Server refuses requests carrying an Origin header, which browsers send; nothing was read or changed. Use the hush CLI.",
    UnsupportedContentType: (error) =>
      `The hush Server accepts only JSON request bodies (got ${error.received ?? "none"}); nothing was read or changed. Send \`Content-Type: application/json\`.`,
    NotInitialised: () =>
      `The hush Server at ${server} has not been initialised; nothing was read or changed. A human reads the Init code on the Server host (systemd: \`sudo cat /var/lib/hush/init-code\`; Docker: \`docker exec hush cat /data/init-code\`; Proxmox LXC: \`pct enter <CTID>\`, then \`cat /var/lib/hush/init-code\`; the Server's startup log prints the exact path) and runs \`hush init --vault <name>\`.`,
    AlreadyInitialised: () =>
      `The hush Server at ${server} is already initialised; its Passphrase and data are unchanged. If you did not initialise it, someone else did: stop it and investigate. Otherwise use \`hush vault create\`.`,
    InitCodeInvalid: () => `The Init code is wrong; nothing was changed. ${readInitCodeAgain}`,
    PassphraseInvalid: (error) =>
      `The new Passphrase is ${error.reason === "too-short" ? "too short (at least 12 characters)" : "too long"}; nothing was changed. Choose another.`,
    PassphraseIncorrect: (error) =>
      `The Passphrase is incorrect; nothing was changed. You can try again ${error.retryAfterSeconds === 0 ? "now" : `in ${seconds(error.retryAfterSeconds)}`}; repeated failures slow every Passphrase operation on this Server.`,
    BackoffActive: (error) =>
      `Too many incorrect Passphrase attempts; the Server will check the next one in ${seconds(error.retryAfterSeconds)}. Nothing was checked or changed. Wait, or restart the Server to clear the delay. If the delay keeps returning, someone is guessing: to Revoke a Token now, run \`hush server revoke <label>\` on the Server host, then block the source (README, "Incident").`,
    VaultNotFound: (error) =>
      `Vault ${error.vault} does not exist on this Server; nothing was changed. \`hush vault list\` shows the Vaults.`,
    VaultExists: (error) => `A Vault named ${error.vault} already exists; nothing was changed.`,
    VaultNotEmpty: (error) =>
      `Vault ${error.vault} still has ${count(error.items, "Item")} and ${count(error.activeTokens, "unrevoked Token")} granted to it; nothing was deleted. Delete its Items and Revoke those Tokens first.`,
    AuditUnavailable: () =>
      "The hush Server could not write its Audit Log, so it refused the request and returned nothing. Check its disk space and logs (`journalctl -u hush` or `docker logs`).",
    TokenRejected: tokenRejectedText,
    VaultNotGranted: (error) =>
      `Token ${error.label} is not granted Vault ${error.vault}; nothing was read or changed.${error.suggestion === undefined ? "" : ` Did you mean ${error.suggestion}?`} It is granted: ${error.granted.map(({ vault, access }) => `${vault} (${access})`).join(", ")}. If ${error.vault} is right, ask the human to run: ${replacementCommand(`hush token issue --label "${error.label}" ${token?.flag ?? "--read"} ${error.vault} --keep-grants --replace`, token)}.`,
    CreateNotAllowed: (error) =>
      `Token ${error.label} has Read Access to Vault ${error.vault}, which cannot create Items; nothing was created. Ask the human to run: ${replacementCommand(`hush token issue --label "${error.label}" --create ${error.vault} --keep-grants --replace`, token)}.`,
    TokenLabelExists: (error) =>
      `A Token labelled ${error.label} already exists (active or expired); nothing was issued. To replace it in one step, add \`--replace\` (and \`--keep-grants\` to keep its Grants), or choose another Label.`,
    TokenNotFound: (error) =>
      `No unrevoked Token is labelled ${error.label}; nothing was revoked or issued. \`hush token list\` shows Tokens.`,
    LimitExceeded: (error) =>
      error.what === "grants"
        ? `A Token can hold at most ${error.max} Grants; nothing was issued. Grant fewer Vaults (with \`--keep-grants\`, the kept Grants count too).`
        : `One command can resolve at most ${error.max} References; nothing was read or run. Split them across several commands.`,
    InvalidName: (error) =>
      `${error.what} is not a valid name (${error.reason}); nothing was changed. Names are 1-128 characters without \`/\` or control characters, not starting with \`-\` or with a space at either end.`,
    ItemExists: (error) =>
      `An Item titled ${error.item} already exists in Vault ${error.vault}; nothing was created or overwritten. Run ${findCommand(error.item, error.vault)}, or choose another title.`,
    ItemNotFound: (error) =>
      `Item ${error.item} does not exist in Vault ${error.vault}; nothing was changed. \`${findCommand(error.item, error.vault)}\` shows exact titles.`,
    FieldNotFound: (error) =>
      `Item ${error.item} has no Field ${error.field}; nothing was changed. \`hush inventory --vault ${error.vault}\` lists its Fields.`,
    TitleRetired: (error) =>
      `The title ${error.item} in Vault ${error.vault} was freed by a rename or delete, and Tokens cannot reuse it until the human releases it; nothing was created. Choose another title, or ask the human to run ${releaseCommand(error.vault, error.item)}.`,
    TitleNotRetired: (error) => `The title ${error.item} is not retired in Vault ${error.vault}; nothing was changed.`,
    UnknownField: (error) =>
      `${error.kind} Items have no Field ${error.field}; nothing was changed. Allowed: ${error.allowed.join(", ")}.`,
    FieldRequired: (error) => `${error.kind} Items need their ${error.field} Field; nothing was changed.`,
    InvalidValue: (error) =>
      `The value for ${error.field} ${error.reason === "empty" ? "is empty" : invalidInputText[error.reason]}; nothing was changed.`,
    InvalidReference: (error) =>
      `${error.reference} is not a hush Reference (${error.reason}); nothing was read. References look like \`hush://Vault/Item/field\`.`,
    ReferenceNotFound: (error) =>
      `${error.reference} does not exist (no such ${error.missing}); nothing was read and no command was run.${error.suggestions.length === 0 ? "" : ` Did you mean: ${error.suggestions.join(", ")}?`} Renaming an Item breaks old References; \`hush find\` gives current ones.`,
    IntegrityCheckFailed: (error) =>
      `Stored data for ${damagedText(error.damaged)} failed its integrity check, so the database file was modified or corrupted; nothing was returned or changed. Restore the Server from a backup: see "Backup and restore" in the hush README.`,
  })

const damagedText = (damaged: Damaged): string => {
  switch (damaged.what) {
    case "field":
      return damaged.reference
    case "item":
      return `Item ${damaged.item} in Vault ${damaged.vault}`
    case "vault-key":
      return `Vault ${damaged.vault}`
    case "master-key":
      return "the master key"
  }
}

const tokenRejectedText = ({ rejection }: TokenRejected): string => {
  switch (rejection.reason) {
    case "missing":
    case "malformed":
      return "The request had no valid hush Token (expected `hush_...`); nothing was read. Check `HUSH_TOKEN` or the token file."
    case "unknown":
      return "This Server does not know the Token (issued by another Server, or the Server was restored from an older backup); nothing was read. Ask the human for a new Token."
    case "revoked":
    case "expired":
      return `Token ${rejection.label} was ${rejection.reason} at ${rejection.at}; nothing was read. Ask the human to issue a new Token (\`hush token issue\`), then run \`hush token save --replace\` or update \`HUSH_TOKEN\`.`
  }
}

export * as CliError from "./CliError.js"
