# hush

A self-hosted secret store for coding agents: one Bun + Effect v4 binary that is both the Server (`hush server`) and the CLI (`hush`).

An agent holds one Token with fixed Grants and passes `hush://` References, so secrets never enter the model's context; the Owner does every human-only operation with the Passphrase. When trade-offs conflict, optimize in this order:

1. **Plaintext in the model's context.** Zero by default; revealing a value is always an explicit, named command.
2. **Agent success on the first try.** One obvious command per goal, compact JSON, and errors that say what to do next.
3. **Trustworthy writes.** Never lose, duplicate or silently overwrite a secret.
4. **Human interruptions per task.** None for an agent with a Token; the Passphrase only for human-only operations.

Not goals: being a sandbox (a child given a secret by `run` can do anything with it) or multi-user sharing. Keep the interface small: it is the product.

```sh
bun install
bun run check                 # format check, lint, typecheck, tests: what CI runs
bun run format                # oxfmt
bun run test                  # bun run --bun vitest run (Bun, not Node: bun:sqlite)
bun run bin/hush --help
bun run build                 # compiled binaries into dist/
bun run smoke                 # compiled-binary smoke test (Linux)
```

Domain terms are defined in `GLOSSARY.md`; decisions in `docs/adr/`. The code, the ADRs and the glossary are the source of truth; `.scratch/` holds local working notes for features in progress and is never cited from tracked files.

## Effect

Target: Effect v4 stable.

Source of truth, in order:

1. The installed `node_modules/effect/src` for exact API names in the pinned version.
1. Effect source at `~/.local/share/effect-solutions/effect` (clone of `Effect-TS/effect` `main`). Check exports and types here before using any API.
1. `MIGRATION.md` and `migration/*.md` in that clone.
1. `effect-solutions show <topic>...` for patterns and conventions only. Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

WARNING: `effect-solutions` v0.5.3 targets `effect@4.0.0-beta.59`. Its snippets drift from 4.0.x; verify every API name against source. Known drift:

- Config constructors are capitalized: `Config.String`, `Int`, `Number`, `Boolean`, `Duration`, `Redacted`, `URL`. No `Config.mapOrFail`.
- `Schema.TaggedErrorClass` -> `Schema.TaggedError`.
- No `unstable` import segment: `effect/unstable/cli` -> `effect/cli`, `effect/unstable/http` -> `effect/http`.
- Install stable versions, not `@beta`.

Never guess at Effect APIs. Check every Effect API name you use (module, function, type, option) in the installed `node_modules/effect/src` (or the installed `@effect/*` package source) before writing it: the pins are exact (see Toolchain) and the `cli`, `http`, `http-api` and `sql` modules are `@stability unstable`.

## Invariants

Security properties. Do not weaken them.

1. Secret values never appear in argv, stdout (except `read`), stderr, error messages, Server logs or the Audit Log. Values reach the Server only in request bodies; `env resolve` writes them only to its target file; `run` children get them only in their env.
2. Server response bodies never reach a CLI error verbatim; the CLI renders messages from typed fields it decoded; anything undecodable is a fixed message. The Server never puts a value, Token, Passphrase or Init code in an error.
3. Writes run once. `create` is read back through resolve under the same Token and compared in memory; `item edit` opens and compares its new seal inside the transaction before commit; any failure after sending says unverified, do not retry. No automatic retries anywhere.
4. No preflight: the requested operation is the capability check.
5. One Server request per command: `find`/`inventory` one `items/list`; env resolution and `run` one `secrets/resolve` (plus `create`'s one write and one read-back).
6. Credential failures fail closed: a bad token file, an invalid `HUSH_TOKEN` or a rejected Token is reported and no other source is tried.
7. Results are JSON on stdout, notices on stderr; every expected error is tagged and printed `hush: <message>` with exit 1.

## Changing things

- Logic lives in module functions that return plain objects and fail with tagged errors as values. `src/cli/cli.ts` only parses flags, calls one function and prints. Type-centred modules use `export type X` plus `export const X = { ... } as const`; operation modules use `export * as X`.
- Decode every boundary (HTTP bodies, token and config files, env vars, stdin, flags) with `Schema`.
- Test through `sandbox()` (`test/sandbox.ts`): assert exit codes and output, and that sentinel secrets never appear in anything observable. Pure modules get unit tests, with fast-check where the input space is wide.
- Don't add a command to `cli.ts` until it works end to end.
- For a user-facing change, update `skills/hush/SKILL.md`, and `README.md` or `SECURITY.md` where they show the command (`test/skill.test.ts` checks the skill against `--help`).
- Comments, test titles and tracked docs state their reasons inline; they may cite `docs/adr/`, but never `.scratch/`.

## More

- [docs/agents/codebase-map.md](docs/agents/codebase-map.md): what each module owns. Update it when a module's responsibility changes.
- Agents never push or tag without the Owner's go-ahead.

## Toolchain

Every version is pinned exactly; see [docs/agents/toolchain.md](docs/agents/toolchain.md) for the overrides and ignore rules that keep the pins and tools working.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
