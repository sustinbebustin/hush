# Toolchain

Every dependency in `package.json` is pinned exactly, and Bun is pinned in CI and the Dockerfile. Bump versions deliberately, never with a range.

- Tests run under Bun (`bun run --bun vitest run`), not Node, because `bun:sqlite` needs it.
- `@effect/platform-bun` depends on `@effect/platform-node-shared` with a caret range, which floats to versions that peer a newer effect. `overrides` in `package.json` pins it to the effect version here, and a direct dependency on the same version pins it for npm installs, which ignore a package's `overrides`; bump both together with effect.
- The npm package ships the TypeScript source (`files` in `package.json`) and runs under the installer's Bun, so `engines.bun` is a minimum, not a pin.
- `@effect/vitest` 4.x declares peer `vitest >=5.0.0 <6.0.0`; keep vitest inside that range.
- `.scratch` is ignored by git through the Owner's global ignore only, so `.oxfmtrc.json` ignores it explicitly: otherwise `bun run format` rewrites the planning docs.
- `@oxlint/plugins` is pinned to the `oxlint` version for the vendored anti-slop plugin in `tools/oxlint/anti-slop/` (provenance in its `UPSTREAM.md`); bump them together. `.oxlintrc.json` and `.oxfmtrc.json` ignore that directory.
- `@opentui/core` (the `hush ui` renderer) is pinned exactly because its releases are frequent and often breaking; it needs Bun 1.3.14 or later. Its native library ships as one optional package per platform (`@opentui/core-<os>-<cpu>[-musl]`), and `bun build --compile` embeds it only when that package is installed, so the lockfile holds every one: after changing the version, run `bun install --os="*" --cpu="*"` and commit the lockfile. A plain `bun install` installs only the host's, so building every target (as `release.yml` does, and the Dockerfile's builder when it cross-compiles for the other architecture) needs `bun install --os="*" --cpu="*"` first.
- `scripts/build.sh` passes `--define 'process.env.OPENTUI_LIBC="glibc"'` for the Linux targets, so each embeds only the glibc native library; without it OpenTUI keeps its runtime libc choice and the build embeds the musl one too. musl is not a shipped target, and the Docker runtime image must have a glibc (Debian slim, never distroless).
- The pty tests and both smoke scripts drive `hush ui` through util-linux `script` (and `timeout`), present on the Linux CI runners; the pty tests run on Linux only.
- `.claude/worktrees` is in `.gitignore` so oxfmt, oxlint and vitest skip agent worktrees.
