#!/bin/sh
# Compiles `bin/hush` with `bun build --compile` into `dist/hush-<target>`: the one binary
# that is both CLI and Server. With no arguments it builds every release target; otherwise only the named ones.
# Usage: `bun run build`, or `sh scripts/build.sh linux-x64 linux-arm64`.
set -eu

targets=${*:-linux-x64 linux-arm64 darwin-arm64}
for target in $targets; do
  case $target in
    linux-x64 | linux-arm64 | darwin-arm64) ;;
    *)
      echo "build: unknown target $target; use linux-x64, linux-arm64 or darwin-arm64" >&2
      exit 1
      ;;
  esac
  # `bin/hush` has no extension, which Bun would bundle as an asset; `--loader :ts` makes it the TypeScript entry.
  bun build --compile --loader :ts --target="bun-$target" bin/hush --outfile "dist/hush-$target"
done
