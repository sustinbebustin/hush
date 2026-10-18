#!/bin/sh
# Docker smoke test, run by the release workflow: builds the image from deploy/Dockerfile
# as `ghcr.io/sustinbebustin/hush:<package.json version>`, inspects its config, runs it under the shipped
# deploy/compose.yaml (host networking, read-only rootfs), then from the host CLI runs Init (the code read with
# `docker exec`), create, resolve and `hush backup`. It also checks that core dumps are off in the container and
# that `hush init --vault` and `hush ui` inside it fail before any prompt with the message naming the fix, and that
# the image's binary can load OpenTUI's native library on its libc (a throwaway `docker run` on a host pty).
# Usage, from the repository root on Linux: `sh scripts/smoke-docker.sh <host hush binary>`.
# It needs the container name `hush`, the volume `hush-data` and 127.0.0.1:7787 free, and removes both at the end.
set -eu

if [ $# -ne 1 ]; then
  echo "usage: sh scripts/smoke-docker.sh <host hush binary>, for example dist/hush-linux-x64" >&2
  exit 1
fi
hush=$(realpath "$1")
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)
image="ghcr.io/sustinbebustin/hush:$version"
compose="docker compose --project-name hush-smoke --file deploy/compose.yaml"

fail() {
  echo "smoke-docker: $*" >&2
  exit 1
}

unset HUSH_SERVER HUSH_TOKEN
if docker container inspect hush >/dev/null 2>&1; then fail "a container named hush exists; remove it first"; fi
if docker volume inspect hush-data >/dev/null 2>&1; then fail "the volume hush-data exists; this test would delete it"; fi
if "$hush" status >/dev/null 2>&1; then fail "a Server already answers on 127.0.0.1:7787; stop it first"; fi

root=$(mktemp -d)
cleanup() {
  $compose down --volumes >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT

docker build --quiet --file deploy/Dockerfile --tag "$image" . >/dev/null

# The image config: non-root, the state dir, the health check and the entrypoint, and no listen opt-in.
test "$(docker image inspect --format '{{.Config.User}}' "$image")" = hush || fail "image user is not hush"
test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")" = '["hush","server"]' ||
  fail "image entrypoint is not hush server"
test "$(docker image inspect --format '{{json .Config.Healthcheck.Test}}' "$image")" = '["CMD","hush","status"]' ||
  fail "image health check is not hush status"
docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" >"$root/env"
grep -qx 'HUSH_STATE_DIR=/data' "$root/env" || fail "image does not set HUSH_STATE_DIR=/data"
if grep -q '^HUSH_ALLOW_ANY_LISTEN=\|^HUSH_LISTEN=' "$root/env"; then fail "image pre-sets a listen opt-in"; fi
test "$(docker run --rm --entrypoint id "$image")" = "uid=10001(hush) gid=10001(hush) groups=10001(hush)" ||
  fail "image does not run as uid and gid 10001"
test "$(docker run --rm --entrypoint stat "$image" -c '%a %u' /data)" = "700 10001" || fail "/data is not 0700 hush"

$compose up --detach >/dev/null
tries=0
until [ "$(docker inspect --format '{{.State.Health.Status}}' hush)" = healthy ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    docker logs hush >&2
    fail "the container was not healthy within 60 s"
  fi
  sleep 1
done

test "$(docker exec hush sh -c 'ulimit -c')" = 0 || fail "core dumps are not off in the container"

# The container has no writable home, so the Token-saving check fails before the prompt.
if docker exec hush hush init --vault X >"$root/inside.out" 2>"$root/inside.err"; then
  fail "hush init --vault inside the container succeeded"
fi
grep -qF 'nothing was issued and no prompt was shown. Run this command from a CLI machine, or add `--print`' \
  "$root/inside.err" || fail "unexpected message from hush init inside the container: $(cat "$root/inside.err")"

# The UI is a CLI command run from a CLI machine, never a Server-side one: inside the container, with no terminal,
# it must refuse with the tagged message and exit 1 before touching the terminal or the native library.
if docker exec hush hush ui >"$root/ui-inside.out" 2>"$root/ui-inside.err" </dev/null; then
  fail "hush ui inside the container succeeded"
fi
grep -qF '`hush ui` needs an interactive terminal' "$root/ui-inside.err" ||
  fail "unexpected message from hush ui inside the container: $(cat "$root/ui-inside.err")"
test ! -s "$root/ui-inside.out" || fail "hush ui inside the container wrote to stdout: $(cat "$root/ui-inside.out")"

HOME="$root/home"
export HOME
mkdir -p "$HOME"
passphrase="smoke test passphrase 4Rt"
code=$(docker exec hush cat /data/init-code)
printf '%s\n%s\n' "$code" "$passphrase" | "$hush" init --vault Smoke --passphrase-stdin >/dev/null
printf 'smoke-value\n' | "$hush" create api-credential --title Key --vault Smoke --stdin >/dev/null
test "$("$hush" read hush://Smoke/Key/credential)" = smoke-value || fail "resolve did not return the created value"
printf '%s\n' "$passphrase" | "$hush" backup "$root/backup.db" --passphrase-stdin >/dev/null
test "$(head -c 15 "$root/backup.db")" = "SQLite format 3" || fail "the backup is not a SQLite database"

# Native library check only, not a way to run the UI: a throwaway container from the same image draws the Locked
# prompt on a host pty (util-linux `script`), which proves the binary loads OpenTUI's native library on the image's
# libc. Bun extracts that library to /tmp and maps it from there, so this one container's /tmp allows exec. Ctrl-C,
# typed once the prompt is up, quits it with exit 0. The match is one word: the renderer redraws only the cells that
# changed.
{
  tries=0
  until grep -q 'Passphrase:' "$root/ui.out" 2>/dev/null || [ "$tries" -gt 300 ]; do
    tries=$((tries + 1))
    sleep 0.1
  done
  printf '\003'
} | timeout 40 script -qec "docker run --rm -it --read-only --tmpfs /tmp:exec --entrypoint hush $image ui" /dev/null \
  >"$root/ui.out" || fail "hush ui in the image did not exit 0 on Ctrl-C: $(cat "$root/ui.out")"
grep -q 'hush Passphrase:' "$root/ui.out" || fail "hush ui in the image drew no Locked prompt: $(cat "$root/ui.out")"

echo "smoke-docker: ok"
