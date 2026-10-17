// First, so the environment is snapshotted before any other module runs.
import { LaunchEnv } from "./LaunchEnv.js"

import { BunServices } from "@effect/platform-bun"
import { Array as Arr, Console, Effect, Option, Redacted } from "effect"
import { Argument, CliConfig, Command, Flag, GlobalFlag } from "effect/cli"
import { Server } from "../server/main.js"
import { StartupError } from "../server/StartupError.js"
import { auditLimit } from "../shared/Api.js"
import { type ApiError, isApiError } from "../shared/ApiError.js"
import { Kind, type PlainLabel } from "../shared/Kind.js"
import { Version } from "../shared/Version.js"
import { Admin } from "./Admin.js"
import { decodeTrailingArguments, normalizeTrailingArguments } from "./arguments.js"
import { Backup } from "./Backup.js"
import { CliError } from "./CliError.js"
import { Create } from "./Create.js"
import { Discover } from "./Discover.js"
import { Doctor } from "./Doctor.js"
import { Env } from "./Env.js"
import { HostCommand } from "./HostCommand.js"
import { ItemAdmin } from "./ItemAdmin.js"
import { Read } from "./Read.js"
import { Route } from "./Route.js"
import { Settings } from "./Settings.js"
import { Status } from "./Status.js"
import { Target } from "./Target.js"
import { TokenStore } from "./TokenStore.js"

// The command table: flags in, one module call, JSON out.

// Every expected error: `hush: <message>` on stderr, nothing on stdout, exit 1 (invariant 7).
const fail = (message: string) =>
  Console.error(`hush: ${message}`).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1
      }),
    ),
  )

// Every result is one JSON object; fields left `undefined` are omitted.
const printJson = <Receipt extends object>(receipt: Receipt) => Console.log(JSON.stringify(receipt, null, 2))

// A receipt on stdout, then each notice on stderr.
const printWithNotices = ({
  receipt,
  notices,
}: {
  readonly receipt: object
  readonly notices: ReadonlyArray<string>
}) =>
  Effect.andThen(
    printJson(receipt),
    Effect.forEach(notices, (notice) => Console.error(`hush: ${notice}`)),
  )

const booleanFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.withDescription(description))

// Resolves the Server, runs `command` against it and renders every expected error as `hush: <message>`. A Token
// command passes the Grant flag it needs, so its errors render a complete `hush token issue` command.
const withTarget = <A, R>(
  command: (target: Target) => Effect.Effect<A, CliError.CliError | ApiError, R>,
  flag?: CliError.GrantFlag,
) =>
  Target.load(LaunchEnv.snapshot).pipe(
    Effect.flatMap((target) =>
      command(target).pipe(
        Effect.asVoid,
        Effect.catch((error) => {
          const token = flag === undefined ? undefined : TokenStore.context(LaunchEnv.snapshot, flag)

          return fail(
            isApiError(error) ? CliError.renderServer(error, target.origin, token) : CliError.render(error, token),
          )
        }),
      ),
    ),
    Effect.catch((error) => fail(CliError.render(error))),
  )

const status = Command.make("status", {}, () =>
  withTarget((target) => Status.run(target).pipe(Effect.flatMap(printJson))),
).pipe(Command.withDescription("Show the Server's state and versions"))

// Exit 0 always:every problem it finds is a note in the report.
const doctor = Command.make("doctor", {}, () => Doctor.run(LaunchEnv.snapshot).pipe(Effect.flatMap(printJson))).pipe(
  Command.withDescription("Check the setup without authenticating; safe to paste into an issue"),
)

const init = Command.make(
  "init",
  {
    passphraseStdin: booleanFlag(
      "passphrase-stdin",
      "Read the secrets from piped stdin: line 1 the Init code, line 2 the new Passphrase, nothing after",
    ),
    vault: Flag.String("vault").pipe(
      Flag.optional,
      Flag.withDescription("Also create this first Vault and a Read+Create Token for it, saved for this Server"),
    ),
    label: Flag.String("label").pipe(
      Flag.optional,
      Flag.withDescription('With --vault: the Token\'s Label; default "<user> on <hostname>"'),
    ),
    print: booleanFlag("print", "With --vault: print the Token in the receipt instead of saving it"),
    replace: booleanFlag("replace", "With --vault: replace the Token already saved for this Server"),
  },
  ({ passphraseStdin, vault, label, print, replace }) =>
    withTarget((target) =>
      Admin.init({
        target,
        source: passphraseStdin ? "stdin" : "prompt",
        firstVault: Option.match(vault, {
          onNone: () => undefined,
          onSome: (name) => ({
            vault: name,
            label: Option.getOrUndefined(label),
            delivery: print ? Admin.Delivery.Print() : Admin.Delivery.Save({ replace }),
          }),
        }),
        env: LaunchEnv.snapshot,
      }).pipe(Effect.flatMap(printJson), Effect.andThen(Console.error(`hush: ${Admin.writeDownNotice}`))),
    ),
).pipe(Command.withDescription("Initialise a new Server with the Init code from its state directory and a Passphrase"))

// The flag of every command that reads the Passphrase alone.
const passphraseLineFlags = {
  passphraseStdin: booleanFlag("passphrase-stdin", "Read the Passphrase from piped stdin: one line, nothing after"),
}

const secretSource = (stdin: boolean): Admin.SecretSource => (stdin ? "stdin" : "prompt")

const vaultName = Argument.String("name").pipe(Argument.withDescription("The Vault's name"))

const vault = Command.make("vault").pipe(
  Command.withDescription("Manage Vaults"),
  Command.withSubcommands([
    Command.make("create", { name: vaultName, ...passphraseLineFlags }, ({ name, passphraseStdin }) =>
      withTarget((target) =>
        Admin.vaultCreate({ target, source: secretSource(passphraseStdin), vault: name }).pipe(
          Effect.flatMap(printJson),
        ),
      ),
    ).pipe(Command.withDescription("Create a Vault; no existing Token gains it")),
    Command.make("list", passphraseLineFlags, ({ passphraseStdin }) =>
      withTarget((target) =>
        Admin.vaultList({ target, source: secretSource(passphraseStdin) }).pipe(Effect.flatMap(printJson)),
      ),
    ).pipe(Command.withDescription("List Vaults with their Item and active Token counts")),
    Command.make("delete", { name: vaultName, ...passphraseLineFlags }, ({ name, passphraseStdin }) =>
      withTarget((target) =>
        Admin.vaultDelete({ target, source: secretSource(passphraseStdin), vault: name }).pipe(
          Effect.flatMap(printJson),
        ),
      ),
    ).pipe(Command.withDescription("Delete a Vault with no Items and no unrevoked Token granted to it")),
  ]),
)

// effect/cli needs each flag by name, so the record below lists `Kind.plainLabels` one by one.
const plainFlag = (label: PlainLabel) =>
  Flag.String(label).pipe(Flag.optional, Flag.withDescription(`The plain \`${label}\` Field, where the Kind has it`))

// The flags of `hush create` and `hush item create`: the Kind, the names, one private source, the plain Fields.
const createFlags = {
  kind: Argument.Literals("kind", Kind.all).pipe(
    Argument.withDescription("api-credential (credential), login (password) or database (password)"),
  ),
  title: Flag.String("title").pipe(Flag.withDescription("The new Item's title")),
  vault: Flag.String("vault").pipe(Flag.withDescription("The Vault to create it in")),
  stdin: booleanFlag("stdin", "Read the secret value from piped stdin"),
  prompt: booleanFlag("prompt", "Read the secret value from a hidden prompt"),
  clipboard: booleanFlag("clipboard", "Read the secret value from the clipboard (macOS)"),
  username: plainFlag("username"),
  host: plainFlag("host"),
  port: plainFlag("port"),
  database: plainFlag("database"),
  notes: plainFlag("notes"),
}

type CreateFlags = Command.Command.Config.Infer<typeof createFlags>

// What both create commands send, from their shared flags.
const createInput = (flags: CreateFlags) => ({
  kind: flags.kind,
  title: flags.title,
  vault: flags.vault,
  sources: { stdin: flags.stdin, prompt: flags.prompt, clipboard: flags.clipboard },
  plain: Kind.plainLabels.flatMap((label) =>
    Option.match(flags[label], {
      onNone: () => [],
      onSome: (value) => [{ label, value }],
    }),
  ),
})

const itemArguments = {
  vault: Argument.String("vault").pipe(Argument.withDescription("The Item's Vault")),
  title: Argument.String("title").pipe(Argument.withDescription("The Item's title")),
}

const item = Command.make("item").pipe(
  Command.withDescription("Create, change and reveal Items with the Passphrase (the Owner only)"),
  Command.withSubcommands([
    Command.make("create", { ...createFlags, ...passphraseLineFlags }, (flags) =>
      withTarget((target) =>
        ItemAdmin.itemCreate({ target, source: secretSource(flags.passphraseStdin), ...createInput(flags) }).pipe(
          Effect.flatMap(printJson),
        ),
      ),
    ).pipe(
      Command.withDescription(
        "Create an Item with the Passphrase, verified before commit; an agent with a Token uses `hush create`",
      ),
    ),
    Command.make(
      "edit",
      {
        ...itemArguments,
        field: Flag.String("field").pipe(
          Flag.optional,
          Flag.withDescription("Set this Field of the Item's Kind to a value from --stdin, --prompt or --clipboard"),
        ),
        remove: Flag.String("remove").pipe(
          Flag.optional,
          Flag.withDescription("Remove this optional plain Field; the Kind's secret Field cannot be removed"),
        ),
        stdin: booleanFlag(
          "stdin",
          "Read the value from piped stdin; with --passphrase-stdin, everything after the Passphrase line",
        ),
        prompt: booleanFlag("prompt", "Read the value from a hidden prompt"),
        clipboard: booleanFlag("clipboard", "Read the value from the clipboard (macOS)"),
        ...passphraseLineFlags,
      },
      (flags) =>
        withTarget((target) =>
          ItemAdmin.itemEdit({
            target,
            source: secretSource(flags.passphraseStdin),
            vault: flags.vault,
            title: flags.title,
            field: Option.getOrUndefined(flags.field),
            remove: Option.getOrUndefined(flags.remove),
            sources: { stdin: flags.stdin, prompt: flags.prompt, clipboard: flags.clipboard },
          }).pipe(Effect.flatMap(printJson)),
        ),
    ).pipe(Command.withDescription("Set one Field of an Item, verified before commit, or remove a plain Field")),
    Command.make(
      "rename",
      {
        ...itemArguments,
        newTitle: Argument.String("new-title").pipe(Argument.withDescription("The Item's new title")),
        ...passphraseLineFlags,
      },
      (flags) =>
        withTarget((target) =>
          ItemAdmin.itemRename({
            target,
            source: secretSource(flags.passphraseStdin),
            vault: flags.vault,
            title: flags.title,
            newTitle: flags.newTitle,
          }).pipe(Effect.flatMap(printWithNotices)),
        ),
    ).pipe(
      Command.withDescription(
        "Rename an Item: prints its old and new References; Tokens cannot create the old title until `item release`",
      ),
    ),
    Command.make("delete", { ...itemArguments, ...passphraseLineFlags }, (flags) =>
      withTarget((target) =>
        ItemAdmin.itemDelete({
          target,
          source: secretSource(flags.passphraseStdin),
          vault: flags.vault,
          title: flags.title,
        }).pipe(Effect.flatMap(printWithNotices)),
      ),
    ).pipe(
      Command.withDescription("Delete an Item and its Fields; Tokens cannot create its title until `item release`"),
    ),
    Command.make("release", { ...itemArguments, ...passphraseLineFlags }, (flags) =>
      withTarget((target) =>
        ItemAdmin.itemRelease({
          target,
          source: secretSource(flags.passphraseStdin),
          vault: flags.vault,
          title: flags.title,
        }).pipe(Effect.flatMap(printJson)),
      ),
    ).pipe(Command.withDescription("Let Tokens create a title that a rename or delete retired")),
    Command.make(
      "reveal",
      { reference: Argument.String("reference"), ...passphraseLineFlags },
      ({ reference, passphraseStdin }) =>
        withTarget((target) =>
          ItemAdmin.itemReveal({ target, source: secretSource(passphraseStdin), reference }).pipe(
            // Byte-exact, with nothing appended, as `read` writes it.
            Effect.flatMap((value) => Effect.promise(() => Bun.write(Bun.stdout, Redacted.value(value)))),
          ),
        ),
    ).pipe(
      Command.withDescription("Reveal one Field's value on stdout under the Passphrase; audited by its Reference"),
    ),
  ]),
)

const passphrase = Command.make("passphrase").pipe(
  Command.withDescription("Manage the Passphrase"),
  Command.withSubcommands([
    Command.make(
      "change",
      {
        passphraseStdin: booleanFlag(
          "passphrase-stdin",
          "Read the secrets from piped stdin: line 1 the current Passphrase, line 2 the new one, nothing after",
        ),
      },
      ({ passphraseStdin }) =>
        withTarget((target) =>
          Admin.passphraseChange({ target, source: secretSource(passphraseStdin) }).pipe(Effect.flatMap(printJson)),
        ),
    ).pipe(Command.withDescription("Change the Passphrase; Vaults, Tokens and values are untouched")),
  ]),
)

const create = Command.make("create", createFlags, (flags) =>
  withTarget(
    (target) => Create.run(target, createInput(flags), LaunchEnv.snapshot).pipe(Effect.flatMap(printJson)),
    "--create",
  ),
).pipe(Command.withDescription("Create an Item from private input with the Token and verify it"))

const read = Command.make("read", { reference: Argument.String("reference") }, ({ reference }) =>
  withTarget(
    (target) =>
      Read.run(target, reference, LaunchEnv.snapshot).pipe(
        // Byte-exact, with nothing appended.
        Effect.flatMap((value) => Effect.promise(() => Bun.write(Bun.stdout, Redacted.value(value)))),
      ),
    "--read",
  ),
).pipe(Command.withDescription("Explicitly write one secret value to stdout"))

// The command after `--`, argv unchanged. effect/cli guarantees at least one argument.
const trailingCommand = Argument.String("command").pipe(
  Argument.atLeast(1),
  Argument.withDescription("The command to run, after `--`; spawned without a shell"),
)

const childCommand = (command: ReadonlyArray<string>) => {
  const decoded = decodeTrailingArguments(command)

  return Arr.isReadonlyArrayNonEmpty(decoded)
    ? Effect.succeed(decoded)
    : Effect.die(new Error("effect/cli passed an empty command despite Argument.atLeast(1)"))
}

// The child's exit code becomes hush's own.
const exitWith = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code
  })

const maskingNote =
  "Concealed values of 8 bytes or more are masked on piped stdout and stderr, best effort (exact bytes only): never treat it as permission to print a secret"

const run = Command.make(
  "run",
  {
    env: Flag.String("env").pipe(
      Flag.atLeast(1),
      Flag.withDescription("NAME=hush://Vault/Item/field; repeat for each secret"),
    ),
    command: trailingCommand,
  },
  ({ env, command }) =>
    withTarget(
      (target) =>
        childCommand(command).pipe(
          Effect.flatMap((child) => Env.run(target, env, child, LaunchEnv.snapshot)),
          Effect.flatMap(exitWith),
        ),
      "--read",
    ),
).pipe(Command.withDescription(`Run a command with secret references injected into its environment. ${maskingNote}.`))

const templateFile = Argument.String("file").pipe(Argument.withDescription("The env template"))

const envWrite = Command.make(
  "write",
  {
    file: templateFile,
    assignments: Argument.String("assignment").pipe(
      Argument.atLeast(1),
      Argument.withDescription("NAME=hush://Vault/Item/field; one per secret"),
    ),
  },
  ({ file, assignments }) =>
    Env.write(file, assignments).pipe(
      Effect.flatMap((count) => Console.error(`hush: Wrote ${count} secret references to ${file}`)),
      Effect.catch((error) => fail(CliError.render(error))),
    ),
).pipe(Command.withDescription("Replace an env file with secret references; contacts no Server"))

const envResolve = Command.make(
  "resolve",
  {
    file: templateFile,
    output: Flag.String("output").pipe(Flag.optional, Flag.withDescription("Write the plaintext file here")),
    inPlace: booleanFlag("in-place", "Replace the template itself with the plaintext file"),
  },
  ({ file, output, inPlace }) =>
    withTarget(
      (target) =>
        Env.resolveFile(target, file, { output: Option.getOrUndefined(output), inPlace }, LaunchEnv.snapshot).pipe(
          Effect.flatMap(({ output: written, count }) =>
            Console.error(
              `hush: Resolved ${count} secret references into ${written}; this file now contains plaintext secrets`,
            ),
          ),
        ),
      "--read",
    ),
).pipe(
  Command.withDescription(
    "Materialize secret references into a plaintext 0600 env file, only when a tool insists on a file; never masked",
  ),
)

const envRun = Command.make("run", { file: templateFile, command: trailingCommand }, ({ file, command }) =>
  withTarget(
    (target) =>
      childCommand(command).pipe(
        Effect.flatMap((child) => Env.runFile(target, file, child, LaunchEnv.snapshot)),
        Effect.flatMap(exitWith),
      ),
    "--read",
  ),
).pipe(Command.withDescription(`Run a command with every NAME=value line of an env template. ${maskingNote}.`))

const env = Command.make("env").pipe(
  Command.withDescription("Create, resolve, and use env templates"),
  Command.withSubcommands([envWrite, envResolve, envRun]),
)

const scopeFlag = Flag.String("vault").pipe(
  Flag.optional,
  Flag.withDescription("Only this Vault; default every Vault the Token is granted"),
)

const find = Command.make(
  "find",
  {
    queries: Argument.String("query").pipe(
      Argument.variadic({ min: 1 }),
      Argument.withDescription("Words that must all appear in the title; several queries in one call"),
    ),
    scope: scopeFlag,
  },
  ({ queries, scope }) =>
    withTarget(
      (target) =>
        Discover.find(target, queries, Option.getOrUndefined(scope), LaunchEnv.snapshot).pipe(
          Effect.flatMap(printJson),
        ),
      "--read",
    ),
).pipe(Command.withDescription("Find secret references by title without revealing values"))

const inventory = Command.make("inventory", { scope: scopeFlag }, ({ scope }) =>
  withTarget(
    (target) =>
      Discover.inventory(target, Option.getOrUndefined(scope), LaunchEnv.snapshot).pipe(Effect.flatMap(printJson)),
    "--read",
  ),
).pipe(Command.withDescription("List granted Vaults and Item metadata without revealing values"))

const vaultFlags = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.atLeast(0), Flag.withDescription(description))

const token = Command.make("token").pipe(
  Command.withDescription("Issue and manage Tokens"),
  Command.withSubcommands([
    Command.make(
      "issue",
      {
        label: Flag.String("label").pipe(Flag.withDescription('The Token\'s Label, e.g. "claude on devbox"')),
        read: vaultFlags("read", "Grant Read on this Vault; repeatable"),
        create: vaultFlags("create", "Grant Read+Create on this Vault; repeatable"),
        keepGrants: booleanFlag(
          "keep-grants",
          "With --replace: keep the replaced Token's Grants; --read and --create add Vaults or change their Access",
        ),
        ttl: Flag.String("ttl").pipe(
          Flag.optional,
          Flag.withDescription("Expire after this long, e.g. 90d (s, m, h, d or w; at most 3650d); default never"),
        ),
        print: booleanFlag(
          "print",
          "Print the Token in the receipt instead of saving it (another machine, HUSH_TOKEN)",
        ),
        replace: booleanFlag(
          "replace",
          "Revoke the Token with this Label in the same step, and replace the Token saved for this Server",
        ),
        ...passphraseLineFlags,
      },
      (flags) =>
        withTarget((target) =>
          Admin.tokenIssue({
            target,
            source: secretSource(flags.passphraseStdin),
            label: flags.label,
            read: flags.read,
            create: flags.create,
            keepGrants: flags.keepGrants,
            ttl: Option.getOrUndefined(flags.ttl),
            replace: flags.replace,
            print: flags.print,
            env: LaunchEnv.snapshot,
          }).pipe(Effect.flatMap(printWithNotices)),
        ),
    ).pipe(Command.withDescription("Issue a Token with fixed Grants, saved for this Server unless --print")),
    Command.make("list", passphraseLineFlags, ({ passphraseStdin }) =>
      withTarget((target) =>
        Admin.tokenList({ target, source: secretSource(passphraseStdin) }).pipe(Effect.flatMap(printJson)),
      ),
    ).pipe(Command.withDescription("List every Token with its Grants, times and state, newest first")),
    Command.make(
      "revoke",
      { label: Argument.String("label").pipe(Argument.withDescription("The Token's Label")), ...passphraseLineFlags },
      ({ label, passphraseStdin }) =>
        withTarget((target) =>
          Admin.tokenRevoke({ target, source: secretSource(passphraseStdin), label, env: LaunchEnv.snapshot }).pipe(
            Effect.flatMap(printWithNotices),
          ),
        ),
    ).pipe(
      Command.withDescription(
        "Revoke a Token at once, keeping its row so later uses are refused and audited; also drops it locally when saved here",
      ),
    ),
    Command.make("status", {}, () =>
      withTarget(
        (target) => Admin.tokenStatus({ target, env: LaunchEnv.snapshot }).pipe(Effect.flatMap(printJson)),
        "--read",
      ),
    ).pipe(Command.withDescription("Show the current Token's Label, Grants and expiry, and where it came from")),
    Command.make(
      "save",
      {
        stdin: booleanFlag("stdin", "Read the Token, or a `token issue --print` receipt, from piped stdin"),
        prompt: booleanFlag("prompt", "Read the Token from a hidden prompt"),
        clipboard: booleanFlag("clipboard", "Read the Token from the clipboard (macOS)"),
        replace: booleanFlag("replace", "Replace the Token already saved for this Server"),
      },
      ({ stdin, prompt, clipboard, replace }) =>
        withTarget((target) =>
          Admin.tokenSave({
            target,
            sources: { stdin, prompt, clipboard },
            replace,
            env: LaunchEnv.snapshot,
          }).pipe(Effect.flatMap(printJson)),
        ),
    ).pipe(Command.withDescription("Save a printed Token for this Server after checking it with the Server")),
    Command.make("forget", {}, () =>
      withTarget((target) => Admin.tokenForget({ target, env: LaunchEnv.snapshot }).pipe(Effect.flatMap(printJson))),
    ).pipe(
      Command.withDescription("Remove the Token saved for this Server without contacting it; the Token is not revoked"),
    ),
  ]),
)

// Settings only: no Server is contacted and no Token is read.
const local = <A extends object>(effect: Effect.Effect<A, CliError.CliError>) =>
  effect.pipe(
    Effect.flatMap(printJson),
    Effect.catch((error) => fail(CliError.render(error))),
  )

const config = Command.make("config").pipe(
  Command.withDescription("Read and change the CLI configuration; contacts no Server"),
  Command.withSubcommands([
    Command.make("set").pipe(
      Command.withDescription("Save a setting to ~/.config/hush/config.json"),
      Command.withSubcommands([
        Command.make(
          "server",
          { url: Argument.String("url").pipe(Argument.withDescription("The Server, e.g. http://100.64.0.7:7787")) },
          ({ url }) => local(Settings.setServer(LaunchEnv.snapshot, url)),
        ).pipe(Command.withDescription("Use this Server when HUSH_SERVER is unset")),
        Command.make(
          "proxy",
          {
            mode: Argument.Literals("mode", Route.modes).pipe(
              Argument.withDescription(
                "auto: use a loopback HTTP_PROXY (an agent sandbox's) when set; direct: never use a proxy",
              ),
            ),
          },
          ({ mode }) => local(Settings.setProxy(LaunchEnv.snapshot, mode)),
        ).pipe(Command.withDescription("Choose the proxy mode when HUSH_PROXY is unset")),
      ]),
    ),
    Command.make("get", {}, () => local(Settings.get(LaunchEnv.snapshot))).pipe(
      Command.withDescription("Show the Server URL and proxy mode in use, and where each came from"),
    ),
  ]),
)

const backup = Command.make(
  "backup",
  {
    file: Argument.String("file").pipe(Argument.withDescription("A new file to write; never overwritten")),
    ...passphraseLineFlags,
  },
  ({ file, passphraseStdin }) =>
    withTarget((target) =>
      Backup.run({ target, source: secretSource(passphraseStdin), file }).pipe(Effect.flatMap(printJson)),
    ),
).pipe(
  Command.withDescription(
    "Download a consistent snapshot of the Server's database into a new 0600 file, checked against its size and SHA-256",
  ),
)

const stateDirFlag = Flag.String("state-dir").pipe(
  Flag.optional,
  Flag.withDescription("State directory (or HUSH_STATE_DIR); required"),
)

// Every expected host command error as `hush: <message>`.
const hostFailed = (error: HostCommand.HostCommandError) => fail(HostCommand.render(error))

const serverRevoke = Command.make(
  "revoke",
  { label: Argument.String("label").pipe(Argument.withDescription("The Token's Label")), stateDir: stateDirFlag },
  ({ label, stateDir }) =>
    HostCommand.revoke({ stateDir: Option.getOrUndefined(stateDir), env: LaunchEnv.snapshot, label }).pipe(
      Effect.flatMap(printJson),
      Effect.catch(hostFailed),
    ),
).pipe(
  Command.withDescription(
    "Revoke a Token on the Server host without the Passphrase, as the owner of hush.db or root; works while the Passphrase backoff is pinned",
  ),
)

const serverBackup = Command.make(
  "backup",
  {
    file: Argument.String("file").pipe(Argument.withDescription("A new file to write, or - for the bytes on stdout")),
    stateDir: stateDirFlag,
  },
  ({ file, stateDir }) =>
    HostCommand.backup({ stateDir: Option.getOrUndefined(stateDir), env: LaunchEnv.snapshot, file }).pipe(
      // `-` put the bytes alone on stdout.
      Effect.flatMap(
        HostCommand.BackupOutcome.$match({ Written: ({ receipt }) => printJson(receipt), Streamed: () => Effect.void }),
      ),
      Effect.catch(hostFailed),
    ),
).pipe(
  Command.withDescription(
    "Back up the database on the Server host without the Passphrase, as the owner of hush.db or root; never overwrites",
  ),
)

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(description))

const audit = Command.make(
  "audit",
  {
    vault: optionalString("vault", "Only entries naming this Vault"),
    label: optionalString("label", "Only requests made with the Token of this Label"),
    since: optionalString("since", "Only entries active since then: a duration back from now (7d) or an ISO 8601 time"),
    limit: optionalString("limit", `At most this many entries, 1 to ${auditLimit.max}; default ${auditLimit.default}`),
    before: optionalString("before", "Only entries older than this id: pass a page's `next` for the next page"),
    ...passphraseLineFlags,
  },
  ({ passphraseStdin, ...flags }) =>
    withTarget((target) =>
      Admin.audit({
        target,
        source: secretSource(passphraseStdin),
        flags: {
          vault: Option.getOrUndefined(flags.vault),
          label: Option.getOrUndefined(flags.label),
          since: Option.getOrUndefined(flags.since),
          limit: Option.getOrUndefined(flags.limit),
          before: Option.getOrUndefined(flags.before),
        },
      }).pipe(Effect.flatMap(printJson)),
    ),
).pipe(Command.withDescription("Read the Audit Log, newest first, with a `next` cursor; never holds a value"))

const server = Command.make(
  "server",
  {
    stateDir: stateDirFlag,
    port: Flag.String("port").pipe(Flag.optional, Flag.withDescription("Port (or HUSH_PORT); default 7787")),
    listen: Flag.String("listen").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Also listen on this IP address, e.g. the tailnet IP from `tailscale ip -4`; repeatable (or HUSH_LISTEN, comma-separated)",
      ),
    ),
    allowAnyListen: booleanFlag(
      "allow-any-listen",
      "Allow --listen addresses outside loopback and the tailnet, sent in cleartext (or HUSH_ALLOW_ANY_LISTEN=true)",
    ),
    allowedHost: Flag.String("allowed-host").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Also accept requests addressed to this hostname, e.g. a `tailscale serve` name; repeatable (or HUSH_ALLOWED_HOSTS, comma-separated)",
      ),
    ),
  },
  ({ stateDir, port, listen, allowAnyListen, allowedHost }) =>
    Server.run(
      {
        stateDir: Option.getOrUndefined(stateDir),
        port: Option.getOrUndefined(port),
        listen,
        allowAnyListen,
        allowedHost,
      },
      LaunchEnv.snapshot,
    ).pipe(Effect.catch((error) => fail(StartupError.render(error)))),
).pipe(Command.withDescription("Run the hush Server"), Command.withSubcommands([serverRevoke, serverBackup]))

const root = Command.make("hush").pipe(
  Command.withDescription("Find, create, and use secrets without exposing them"),
  Command.withSubcommands([
    find,
    inventory,
    run,
    env,
    create,
    read,
    status,
    doctor,
    init,
    vault,
    item,
    passphrase,
    token,
    config,
    audit,
    backup,
    server,
  ]),
)

export const program = Effect.suspend(() =>
  Command.runWith(root, { version: Version.current })(normalizeTrailingArguments(process.argv.slice(2))),
).pipe(
  Effect.provide(BunServices.layer),
  // Only --help and --version: effect/cli's --wizard, --completions and --log-level are not part of hush.
  Effect.provide(CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] })),
)
