# Start from a selective copy of 2password, on Bun + TypeScript + Effect

hush copies (does not fork) the parts of kitlangton/2password (MIT) that took iteration to get right for agents: the command-table pattern, `find` matching and near-miss suggestions, the env template grammar and resolution, write-once-then-verify for `create` and its fixed "unverified" messages, trailing-argument handling, the `doctor` shape, its seven invariants, the sandbox test pattern with sentinel-leak checks, the tooling and the skill structure. Everything that talks to 1Password (`op.ts`, the service-account, Keychain and Windows credential code, the `password` and hygiene `audit` commands) is left behind, and a typed HTTP client for the hush Server takes `op.ts`'s place. The Server lives in the same repo and stack so the CLI and Server share one HTTP contract. 2password's MIT notice is kept beside hush's own.

## Considered Options

- psst (MIT) as the base: it is local-only, with no Tokens, scoping or Audit Log, and its CLI is not shaped like 2password's.
- OpenBao with a thin CLI: the only existing store with path-scoped read-only and create-only tokens, Revoke, audit and a sealed start, but it is a Go service the Owner does not control, has no batch read or `run`, and cannot issue non-root tokens that never expire.
- A fork with a pluggable backend: excluded by the hard requirement that hush is the Owner's own repo.

## Consequences

Upstream 2password fixes are ported by hand.
