# Vendored anti-slop Oxlint plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), path `skills/install-anti-slop/assets/anti-slop/`, commit `d2a9aea3b896ffcb291a85f2c1301aa2543ad8c8` ("feat: keep consecutive single-line bindings grouped in require-readable-spacing"). Every file here except this record is byte-identical to that commit's assets (`diff -r` against `git archive`). The copies came through the skill in [sustinbebustin/.dotfiles](https://github.com/sustinbebustin/.dotfiles) (`home/.claude/skills/tools/install-anti-slop/`).

History:

- 2026-10-14: installed from `e6676e8d0bf17c678cb45b9dacb2bd6ca8dea53a`.
- 2026-10-14: updated to `d2a9aea` by three-way merge with `e6676e8` as base. The local copy had no changes, so all three incoming files were applied as-is: `rules/require-readable-spacing.ts`, `vendor/eslint-stylistic/padding-line-between-statements.ts` and `vendor/eslint-stylistic/UPSTREAM.md`. Consecutive single-line bindings no longer need a blank line between them. The rule never removes blank lines, so a one-off codemod removed the 93 that the first autofix had added between such bindings. Blank lines the authors wrote were kept. Upstream's RuleTester suite (`src/rules/require-readable-spacing.test.ts`, whose rule source matches these assets) was not run here. Verification was a probe through the registered plugin plus `bun run check`.

Installed paths:

- `index.ts`: generic plugin, registered as `anti-slop` in `.oxlintrc.json`.
- `effect/index.ts`: Effect plugin, registered as `anti-slop-effect` because `effect` is a direct dependency.
- `vendor/eslint-stylistic/`: vendored rule with its own `LICENSE` and `UPSTREAM.md`.

Every bundled rule is enabled at `error`, with the native `oxc/no-accumulating-spread` companion. `@oxlint/plugins` is pinned to the `oxlint` version; bump both together.

## Local deviations

None in the plugin source. Repository integration only:

- `.oxlintrc.json` ignores this directory and agent tooling directories.
- `.oxfmtrc.json` ignores this directory so `bun run format` does not rewrite vendored code.
- `tsconfig.json` does not include `tools/`, so `tsc --noEmit` does not typecheck the plugin; Oxlint loads it directly.
