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
src/cli/ItemAdmin.ts        the Owner's `item edit|rename|delete|release`, each through `passphraseCommand`
src/cli/PassphraseStdin.ts  `--passphrase-stdin`: TTY refusal, strict UTF-8, one secret per line, nothing after but an `--stdin` value
src/cli/PrivateInput.ts     one value from exactly one source flag: `--stdin`, `--prompt` or `--clipboard` (macOS)
src/cli/TokenStore.ts       `HUSH_TOKEN`, else this origin's entry in `~/.config/hush/tokens.json`; `checkSavable`, `checkReplaceable`, `save`, `forget`, `context`, `health`
src/cli/Create.ts           `hush create <kind>`: local checks, one `items/create`, then the read-back compare
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
src/server/Items.ts         `items/list`, `secrets/resolve` (with `ReferenceNotFound` suggestions) and `items/create` under a Token (refuses a Retired title)
src/server/ItemAdmin.ts     `items/edit` (seal verified before commit), `items/rename|delete` (retire the title) and `items/release` under the Passphrase
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
test/sandbox.ts             the seam: real CLI subprocess (temp HOME, PATH of sh, cat and fakes; `tty` runs on a pty) against a real Server subprocess on a port below the ephemeral range, so a restart gets it back
test/proxy.ts               the loopback test proxy, as `HUSH_SERVER` (origin-form) or `HTTP_PROXY` (absolute-form): request-line log, dropped or altered answers
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
scripts/build.sh            `bun run build`: `bun build --compile` per target into `dist/hush-<target>`
scripts/homebrew-formula.sh the Homebrew formula for a release from its `SHA256SUMS`, pushed to `sustinbebustin/homebrew-tap` by `release.yml`
scripts/smoke-binary.sh     compiled-binary smoke test (`bun run smoke [binary]`): crypto vectors compiled, start, Init, create, resolve, both backups, restart
scripts/crypto-vectors.ts   the crypto vectors outside vitest, compiled and run by the smoke test
scripts/smoke-docker.sh     Docker smoke test (`bun run smoke:docker <binary>`): image config, Compose up, Init, create, resolve, backup, core limit, Token-saving refusal
deploy/hush.service         the hardened systemd unit (DynamicUser); `hush-static-user.conf` its drop-in for LXC nesting=0
deploy/hush-backup.*        daily `hush server backup` as root into /var/backups/hush (service and timer)
deploy/Dockerfile           the multi-stage image (builder cross-compiles for TARGETARCH); base images pinned by digest
deploy/compose.yaml         host networking, read-only, core ulimit 0, volume `hush-data`; image tag = package.json version
.github/workflows/          `ci.yml` (check on Linux and macOS, compiled smoke on Linux), `release.yml` (on a `v*` tag: GitHub release and GHCR image, then npm and the Homebrew tap)
```
