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

Never guess at Effect APIs.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
