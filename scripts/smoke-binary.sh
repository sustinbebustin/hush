#!/bin/sh
# Compiled-binary smoke test: runs the crypto vectors compiled with `bun build --compile`, then
# starts the `hush` binary on a fresh state dir (migrations on a fresh database), Inits, creates, resolves, runs
# `hush backup` and `hush server backup`, restarts on the existing database and resolves again.
# Usage, from the repository root: `sh scripts/smoke-binary.sh [binary]`. Without a binary it compiles `bin/hush`
# for this host. Exits non-zero at the first failing step.
set -eu

root=$(mktemp -d)
server=""
cleanup() {
  if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; fi
  rm -rf "$root"
}
trap cleanup EXIT

if [ $# -gt 0 ]; then
  hush=$1
else
  case $(uname -m) in
    x86_64) target=linux-x64 ;;
    aarch64 | arm64) target=linux-arm64 ;;
    *)
      echo "smoke: no build target for $(uname -m); pass a binary" >&2
      exit 1
      ;;
  esac
  sh scripts/build.sh "$target" >/dev/null
  hush="dist/hush-$target"
fi

bun build --compile scripts/crypto-vectors.ts --outfile "$root/crypto-vectors" >/dev/null
"$root/crypto-vectors"

# Starts the Server on the state dir with the given port (0 for any) and sets `port` from its startup line.
start() {
  : >"$root/server.out"
  "$hush" server --state-dir "$root/state" --port "$1" >"$root/server.out" 2>"$root/server.err" &
  server=$!
  tries=0
  until [ -s "$root/server.out" ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 100 ] || ! kill -0 "$server" 2>/dev/null; then
      echo "smoke: the Server printed no startup line within 10 s" >&2
      cat "$root/server.err" >&2
      exit 1
    fi
    sleep 0.1
  done
  port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$root/server.out" | head -n 1)
}

stop() {
  kill "$server"
  wait "$server" || true
  server=""
}

start 0

HUSH_SERVER="http://127.0.0.1:$port"
HOME="$root/home"
export HUSH_SERVER HOME
mkdir -p "$HOME"
passphrase="smoke test passphrase 4Rt"

printf '%s\n%s\n' "$(cat "$root/state/init-code")" "$passphrase" | "$hush" init --vault Smoke --passphrase-stdin >/dev/null
printf 'smoke-value\n' | "$hush" create api-credential --title Key --vault Smoke --stdin >/dev/null
test "$("$hush" read hush://Smoke/Key/credential)" = smoke-value

printf '%s\n' "$passphrase" | "$hush" backup "$root/api.db" --passphrase-stdin >/dev/null
"$hush" server backup --state-dir "$root/state" "$root/host.db" >/dev/null
"$hush" server backup --state-dir "$root/state" - >"$root/stdout.db"
for name in api host stdout; do
  test "$(head -c 15 "$root/$name.db")" = "SQLite format 3"
done

# `hush ui` on a pty (util-linux `script`) loads OpenTUI's embedded native library and draws the Locked prompt;
# Ctrl-C, typed once the prompt is up, quits it. stdin stays open meanwhile, since `script` passes its end on.
{
  sleep 2
  printf '\003'
} | timeout 10 script -qec "$hush ui" /dev/null >"$root/ui.out"
if ! grep -q 'hush Passphrase:' "$root/ui.out"; then
  echo "smoke: hush ui drew no Locked prompt" >&2
  exit 1
fi

# The same port keeps the saved Token's origin.
stop
start "$port"
test "$("$hush" read hush://Smoke/Key/credential)" = smoke-value

echo "smoke: ok"
