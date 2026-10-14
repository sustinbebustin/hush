import packageJson from "../../package.json" with { type: "json" }

export const Version = {
  // The package version, reported by `--version` and `status`.
  current: packageJson.version,
  // The HTTP API version; a breaking change to the HTTP API in Api.ts bumps it.
  api: 1,
} as const
