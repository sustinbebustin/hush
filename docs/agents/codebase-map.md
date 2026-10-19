# Codebase map

What each module owns. Read it before working in an unfamiliar area; update the line when a module's responsibility changes.

## CLI (`src/cli/`)

```
bin/hush                    entry point; `hush server` runs src/server/main.ts through the command table
src/cli/cli.ts              command table: flags -> module call -> JSON on stdout; no logic
src/cli/arguments.ts        keeps arguments after `--` away from the flag parser
src/cli/LaunchEnv.ts        immutable snapshot of `process.env` taken at start, so `run` children inherit the original env; the `Snapshot` and `EnvVars` types modules take
src/cli/Target.ts           Server origin and proxy mode, each from env, else `config.json`, else the default; `load` gives the Target with its route
src/cli/Route.ts            the request route: loopback `HTTP_PROXY` in mode auto, else direct; in-process `NO_PROXY`; `host:port` display only
src/cli/Config.ts           `~/.config/hush/config.json` (`server`, `proxy`): load, and write through `PrivateFile`
src/cli/PrivateFile.ts      the token file and the config file: their path in `~/.config/hush`, atomic 0600 write in a 0700 directory
src/cli/Settings.ts         `hush config get|set`: no request
src/cli/Client.ts           typed client of the shared Api over the route; maps transport, 413 and undecodable answers to CLI errors; no retries; `backup` for the raw route (10 min to headers)
src/cli/Admin.ts            the Owner's commands, each through `passphraseCommand` (prepare, secrets, one request): `hush init [--vault]`, `vault`, `passphrase change`, `token issue|list|revoke`, `audit`; plus `token status|save|forget` (no Passphrase)
src/cli/Terminal.ts         the hidden reader on `/dev/tty`: the pure key reducer `feed` and `hidden`
src/cli/ItemAdmin.ts        the Owner's `item list|create|edit|rename|delete|release|reveal`, each through `passphraseCommand`
src/cli/PassphraseStdin.ts  `--passphrase-stdin`: TTY refusal, strict UTF-8, one secret per line, nothing after but an `--stdin` value
src/cli/PrivateInput.ts     one value from exactly one source flag: `--stdin`, `--prompt` or `--clipboard` (macOS)
src/cli/TokenStore.ts       `HUSH_TOKEN`, else this origin's entry in `~/.config/hush/tokens.json`; `checkSavable`, `checkReplaceable`, `save`, `forget`, `context`, `health`
src/cli/Create.ts           `hush create <kind>`: local checks, one `items/create`, then the read-back compare
src/cli/PlainField.ts       the pure check of a plain Field given to a create (a plain Field of the Kind, a non-blank value), shared by `hush create`, `hush item create` and the UI's Item form
src/cli/Read.ts             `hush read <reference>`: local parse, one `secrets/resolve`
src/cli/Discover.ts         `hush find` and `hush inventory`: one `items/list`, then title matching
src/cli/HostCommand.ts      `hush server revoke|backup` for the command table: state dir, `-` or a file, one `Host` call, error render
src/cli/Backup.ts           `hush backup <file>`: `OutputExists` before the prompt, one raw-route request, size and SHA-256 checked before the link
src/cli/Env.ts              env template parse, render and resolve (`hush://` values through `Reference.parse`; `op://` is refused); `run`, `env write|resolve|run`
src/cli/Child.ts            the `run` child: no shell, `detached: false`, exact env; piped streams through `Mask`; spawner failures mapped to tagged errors
src/cli/Mask.ts             the pure streaming byte replacer of concealed values
src/cli/CliError.ts         CLI tagged errors and `render`
src/cli/Doctor.ts           `hush doctor`: one unauthenticated `status` (5 s), token file health, notes; exit 0 always
```

## UI (`src/ui/`)

`hush ui`, on `@opentui/core` (Core API only). The reducer side (`State` to `Display`) imports neither OpenTUI nor the Client; `Screen`, `Interpreter` and `Clipboard` are the only modules that touch the outside.

```
src/ui/Ui.ts                `run({ renderer, target, clipboard })`: input, resizes (the renderer's size first), SIGTSTP, exit signals and the idle clock (Clock, every second) -> `Reducer` -> `Screen.draw` -> `Interpreter`, until `Quit`; a Lock interrupts every request in flight, and an effect's defect becomes `Defect`; `Suspend` (renderer suspend, SIGSTOP, resume on SIGCONT); `launch` (the command): TTY check (`UiNeedsTerminal`), host clipboard, alternate screen, `exitOnCtrlC` off, `exitSignals: []`, `useMouse: false` (the terminal keeps its own text selection)
src/ui/State.ts             the one state: `Locked` (prompt, `Phase`, attempt count; never a Passphrase) or `Open` (Passphrase as Redacted, Vaults, cursor, view, modal stack, `Idle`); both carry the terminal `Size`; `idleLimitMillis` (ten minutes, ADR-0010)
src/ui/Size.ts              the terminal's size, the 60x10 minimum the layout needs and the sidebar width; below the minimum the UI draws one notice and takes only Ctrl-C and Ctrl-Z
src/ui/View.ts              the main pane's views (`NoVaults`, `ItemList` with `Filter`, `Items` and `Focus`, `ItemDetail` with its `Reveal`, `Tokens` with its `TokenTable`, `Audit`, `ItemForm` with its phase), the `Modal`s (`Notice`, `Confirm`, `IssueForm`, `Issued`, `Rename`, `Renamed`, `VaultName`, `Help`), the Item rows then the Retired titles under one row cursor, the title filter (`Match.matches`) and Field References
src/ui/Sidebar.ts           the sidebar's rows: the Vaults, then the fixed sections (`Tokens`, `Audit`)
src/ui/Audit.ts             the Audit view's pure transitions (filters, PgUp/PgDn by the pane's rows at the current `Size`, the page below `next` at the bottom, late answers dropped) and its row text
src/ui/Event.ts             what the reducer reacts to: keys, pastes, `Resize`, Server answers (an unlock's tagged with its attempt), clipboard reads and writes, wait ticks, idle ticks (wall clock), `Suspend` (SIGTSTP), `Closed` (an exit signal, or the renderer destroyed)
src/ui/UiEffect.ts          what the reducer asks for: `ListVaults` (the unlock check), `ListItems`, `ListAudit`, `ListTokens`, `RevokeToken`, `IssueToken`, `CopyToken`, `CreateVault`, `DeleteVault`, `RefreshVaults`, `Reveal`, `SaveItem`, `ReadClipboard`, `RenameItem`, `DeleteItem`, `ReleaseTitle`, `After` (timer), `Quit`, `Suspend`; each request carries its Passphrase
src/ui/IssueForm.ts         the Token issue form as plain state: Label, one Grant choice per Vault, TTL, replacement; `submit` -> the `tokens/issue` fields or a `Problem`
src/ui/ItemForm.ts          the Item form as plain state: a create (Kind, title, the concealed `Concealed` buffer, plain drafts) or an edit (one `Entry` for the Field under the cursor); `submit` -> the one `Save`, `sent` drops the buffer, `lines` -> what the screen draws (plain text in `Input`s, the concealed value only as a mask)
src/ui/Clipboard.ts         the host clipboard (OpenTUI's native backends): `available`, `write`, `read` (`Pasted`); `none` where there is no backend, `host` for `launch`
src/ui/Reducer.ts           the pure `reduce(state, event) -> { state, effects }`: the dispatcher, the Locked prompt (every answer for an Open UI dropped) and the Open core (sidebar cursor and selection, Item list and detail, Item form, modals, idle, suspend, quit); every Lock (idle limit, Ctrl-Z or SIGTSTP, exit signal, quit) is a fresh `State.locked`
src/ui/Step.ts              a transition's `Step` (`{ state, effects }`) and the modal-stack moves the reducer, `Tokens` and `Vaults` share
src/ui/Tokens.ts            the Tokens view's transitions: the table and its row cursor, revoke (confirmed), the issue form, the issued Token's modal and its copy key, and their answers (late ones dropped)
src/ui/Vaults.ts            the Vault sidebar's transitions: the new Vault's name prompt, delete (confirmed), and the sidebar listed anew, keeping the cursor and the main pane where they still apply
src/ui/Problem.ts           a refused request as the reducer needs it: the Passphrase waits (counted down), or a message rendered from typed fields
src/ui/Key.ts               a keypress decoupled from OpenTUI's `KeyEvent`: `named`, `char`, `printable`, `is`
src/ui/Concealed.ts         concealed input owned by the state (Redacted), drawn only as a mask of its length
src/ui/Display.ts           pure `State -> Display`: the plain text the screen shows (`Locked`, `Open`, or `TooSmall` below 60x10), never a secret but a Revealed value or an issued Token while the state holds it; the hint bars (80 columns at most, whole keys dropped to fit a narrower frame) and the `?` help of each view and modal
src/ui/Screen.ts            the sync layer: one OpenTUI renderable tree, `draw(display)`; `KeyEvent` and paste to the reducer's types
src/ui/Interpreter.ts       runs each request through `Client` (one request, no retry; every write through `Admin.sentOnce`, so a lost or undecodable answer is `ChangeUnverified`; `ListAudit` filters resolved by `Admin.auditQuery`, as `hush audit` does), `SaveItem` of an `ItemWrite` the reducer already checked, `CopyToken` and `ReadClipboard` through `Clipboard`, and `After`; every outcome is one `Event`; a Passphrase refusal (`PassphraseIncorrect`, `BackoffActive`) is `PassphraseRejected`, which Locks an Open UI; every other refusal in an Open UI is a notice with the CLI's own message (`CliError.render` / `renderServer`)
src/ui/ItemWrite.ts         the Item form's one write, checked as `hush item create` / `item edit` check theirs before sending (`parseName`, `Create.plainField`, `PrivateInput.value`): the reducer runs `check` on Enter, so a refusal keeps the concealed buffer
```

## Shared (`src/shared/`)

```
src/shared/Api.ts           the one `HttpApi`, `TokenAuth` and `CurrentToken`; paths carry `/v1`
src/shared/ApiError.ts      Server error classes with `httpApiStatus`, their union, `isApiError` (by class) and `httpStatus`
src/shared/OutputFile.ts    a new file written whole or not at all: 0600 temp beside the target, then `link`; `OutputExists`, `FileWriteFailed`
src/shared/Token.ts         the Token string (`hush_` + 43 base64url characters): format, parse, secret bytes
src/shared/Value.ts         the Field value rule, checked by CLI and Server
src/shared/Passphrase.ts    the new-Passphrase policy, checked by the CLI before sending and by the Server
src/shared/PlatformCause.ts reads `code` and `message` off an error thrown by Bun, Node or bun:sqlite
src/shared/Name.ts          name rules and `Name.key` (NFC + full-Unicode lowercase identity)
src/shared/Reference.ts     `hush://vault/item/field` parse and format
src/shared/Kind.ts          the three Kinds and their Field specs
src/shared/Access.ts        Access (`read | read+create`) and Grant
src/shared/Version.ts       package version and API version
src/shared/Match.ts         title matching and near-miss suggestions
src/shared/Duration.ts      a typed duration such as `90d` in seconds (`--ttl`, `--since`, the UI's TTL)
```

## Server (`src/server/`)

```
src/server/main.ts          `Server.run`: config, listeners (bound first), state dir, database, state, startup line
src/server/ServerConfig.ts  `hush server` flags and env into a validated config
src/server/Listen.ts        bind addresses: IP literals only, classified loopback, tailnet, wildcard or other
src/server/StartupError.ts  startup tagged errors and `render`: one stderr line, exit 1
src/server/StateDir.ts      state dir and file modes, ownership check, stale snapshot cleanup
src/server/Database.ts      the one SQLite connection: pragmas, migrations, checkpoint, ids for AAD (`nextIds`); `openHost` for host commands (no migrations, `MigrationPending`)
src/server/Backup.ts        `VACUUM INTO` an empty 0600 file, its size and SHA-256; the state-dir snapshot deleted with its scope
src/server/Host.ts          `hush server revoke` and `hush server backup <file | ->` over their own connection: stale snapshots first, chown when root
src/server/migrations.ts    forward-only migrations, one statement per `sql` call
src/server/ServerState.ts   Uninitialised (Init code digest and file) or Ready, held in one Ref
src/server/Meta.ts          the `meta` row checked at a Ready start; `MetaInvalid` names the first bad column
src/server/InitCode.ts      the Init code file (0600, temp then rename), its digest and constant-time match
src/server/Init.ts          `admin/init`: code, policy, master key, `meta`, the `first` Vault and Token, audit row, one transaction
src/server/Crypto.ts        primitives only: Argon2id KEK, AES-256-GCM seal/open, HKDF (token wrap key), SHA-256, `lp`, random bytes
src/server/Keys.ts          the key hierarchy (defined in its header): master key, Vault keys, Token wraps, Field seal/open, every AAD
src/server/Backoff.ts       the pure Passphrase backoff schedule and reservation
src/server/Padding.ts       value padding before sealing, so ciphertext length hides the exact value length
src/server/Tokens.ts        `tokens/issue` (Grants, `replaces`, `keepGrants`), `TokenAuth`'s steps, the in-transaction revocation re-check, and `audited` (one row per Token request)
src/server/Items.ts         `items/list`, `secrets/resolve` (with `ReferenceNotFound` suggestions) and `items/create` under a Token (refuses a Retired title); `itemsOf`, the Item metadata both listings share
src/server/ItemAdmin.ts     `admin/items/list` (Items and Retired titles), `items/create` and `items/edit` (seals verified before commit), `items/rename|delete` (retire the title), `items/release` and `items/reveal` (one Field opened with K_v from MK) under the Passphrase
src/server/Vaults.ts        `vaults/create`, `vaults/list` and `vaults/delete` under the Passphrase
src/server/Audit.ts         audit row insert inside the caller's transaction; failure is `AuditUnavailable`
src/server/AuditLog.ts      `admin/audit`, the Audit Log reader under the Passphrase: Vault, Label and `since` filters, newest first, `before`/`next` paging
src/server/Guard.ts         request guard: pure `check` (Host, Funnel, Origin, media type, Uninitialised gate) and its middleware
src/server/Locks.ts         the meta lock and the Argon2 permit
src/server/Passphrase.ts    the Passphrase check under the backoff, `audited` (one row per evaluation) and `passphrase/change`
src/server/Http.ts          handlers per Api group, the `TokenAuth` layer, the raw backup route; the request log wraps the guard
src/server/Log.ts           the Server's stderr log: one JSON object per line, typed entries
```

## Tests (`test/`)

```
test/sandbox.ts             the seam: real CLI subprocess (temp HOME, PATH of sh, cat and fakes; `tty` runs on a pty, optionally as a job under `set -m` for Ctrl-Z and `fg`) against a real Server subprocess on a port below the ephemeral range, so a restart gets it back
test/headless.ts            the UI seam beside `sandbox()`: `Ui.run` in-process on OpenTUI's `createTestRenderer` against the sandbox Server; `keys` (mockInput), `frame`, `frames` (every committed frame, for leak scans), `waitFor`, `calls`, `advanceClock` (a skewed Effect Clock), `resize`, `width`/`height`, `server` (e.g. the proxy); no host clipboard unless a test passes one (`fakeClipboard` records writes)
test/proxy.ts               the loopback test proxy, as `HUSH_SERVER` (origin-form) or `HTTP_PROXY` (absolute-form): request-line log, dropped, altered, held or garbled (undecodable) answers
test/leaks.ts               per-target sentinel scan for `observable()`
test/arbitraries.ts         shared fast-check arbitraries and Unicode fixtures
test/vectors.ts             the fixed crypto vectors as one table, run by `vectors.test.ts` and `scripts/crypto-vectors.ts`
test/catalogue.ts           the tags of the three error catalogues, enumerated from their modules
test/catalogue.test.ts      the enumeration equals each tag union, and every tag is named in some test title or tag assertion
test/commands.ts            the `hush` commands a Markdown document shows (command position only) and their check against `--help`
test/skill.test.ts          checks every `hush ...` command, flag and error tag the skill names against `--help` and the error catalogues
test/deploy.test.ts         the shipped deploy files: unit directives, drop-in coverage, `systemd-analyze verify`, image pins, Compose
test/sandbox-spike.ts       the manual sandbox check (not in CI): `setup` starts throwaway Servers and prints the settings; `check` runs inside the sandbox
```

## Docs, scripts and deploy

```
README.md                   install, first run, deployment, backup and restore, recovery runbooks; error messages point to its sections by heading
SECURITY.md                 the threat model (ADR-0003) and the agent isolation recipe
skills/hush/SKILL.md        the agent skill we ship; keep it in sync with the CLI
scripts/build.sh            `bun run build`: `bun build --compile` per target into `dist/hush-<target>`; Linux targets define `OPENTUI_LIBC=glibc`
scripts/homebrew-formula.sh the Homebrew formula for a release from its `SHA256SUMS`, pushed to `sustinbebustin/homebrew-tap` by `release.yml`
scripts/smoke-binary.sh     compiled-binary smoke test (`bun run smoke [binary]`): crypto vectors compiled, start, Init, create, resolve, both backups, `hush ui` on a pty (Locked prompt, unlock, `q` exits 0), restart
scripts/crypto-vectors.ts   the crypto vectors outside vitest, compiled and run by the smoke test
scripts/smoke-docker.sh     Docker smoke test (`bun run smoke:docker <binary>`): image config, Compose up, Init, create, resolve, backup, core limit, Token-saving refusal, `hush ui` Locked prompt from the image on a host pty (the native library loads; needs an exec /tmp)
deploy/hush.service         the hardened systemd unit (DynamicUser); `hush-static-user.conf` its drop-in for LXC nesting=0
deploy/hush-backup.*        daily `hush server backup` as root into /var/backups/hush (service and timer)
deploy/Dockerfile           the multi-stage image (builder cross-compiles for TARGETARCH); base images pinned by digest
deploy/compose.yaml         host networking, read-only, core ulimit 0, volume `hush-data`; image tag = package.json version
.github/workflows/          `ci.yml` (check on Linux and macOS, compiled smoke on Linux), `release.yml` (on a `v*` tag: GitHub release and GHCR image, then npm and the Homebrew tap)
```
