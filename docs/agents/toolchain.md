# Toolchain

Every dependency in `package.json` is pinned exactly, and Bun is pinned in CI and the Dockerfile. Bump versions deliberately, never with a range.

- Tests run under Bun (`bun run --bun vitest run`), not Node, because `bun:sqlite` needs it.
- `@effect/platform-bun` depends on `@effect/platform-node-shared` with a caret range, which floats to versions that peer a newer effect. `overrides` in `package.json` pins it to the effect version here, and a direct dependency on the same version pins it for npm installs, which ignore a package's `overrides`; bump both together with effect.
- The npm package ships the TypeScript source (`files` in `package.json`) and runs under the installer's Bun, so `engines.bun` is a minimum, not a pin.
- `@effect/vitest` 4.x declares peer `vitest >=5.0.0 <6.0.0`; keep vitest inside that range.
- `.scratch` is ignored by git through the Owner's global ignore only, so `.oxfmtrc.json` ignores it explicitly: otherwise `bun run format` rewrites the planning docs.
- `@oxlint/plugins` is pinned to the `oxlint` version for the vendored anti-slop plugin in `tools/oxlint/anti-slop/` (provenance in its `UPSTREAM.md`); bump them together. `.oxlintrc.json` and `.oxfmtrc.json` ignore that directory.
- `.claude/worktrees` is in `.gitignore` so oxfmt, oxlint and vitest skip agent worktrees.
