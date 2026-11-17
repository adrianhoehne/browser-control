#!/bin/sh
# Portable start: create the token on the first run, print the three lines the
# guides refer to, and become the bridge.
#
# Nothing is installed and nothing is written outside this folder. There is no
# PID file and no `nohup`: this script *is* the process, so Ctrl+C ends it — the
# same thing the systemd unit gets from `systemctl --user stop`.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
data="$here/data"
token_file="$data/token"
binary="$here/browser-control-bridge"

# Checked before the first write, so a broken archive leaves no half-made folder.
if [ ! -x "$binary" ]; then
  printf 'error: the bridge is missing or not executable: %s\n' "$binary" >&2
  exit 1
fi

mkdir -p "$data"

if [ ! -f "$token_file" ]; then
  # Written once, never replaced: a new token on every start would log the
  # extension out each time. 32 random bytes as lowercase hex, plus the trailing
  # newline `openssl` puts there; the bridge trims it either way.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$token_file"
  else
    # The fallback for a machine without openssl. Same shape, same source of
    # randomness, and no `$RANDOM`/`date`: neither is a CSPRNG.
    { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; printf '\n'; } > "$token_file"
  fi
  chmod 600 "$token_file"
fi

# The bridge reads the token from this path and nothing else; `HOME` stays out of
# it, so the file cannot land in ~/.config by accident.
BC_TOKEN_FILE="$token_file"
export BC_TOKEN_FILE

# BC_BIND and BC_HTTP_PORT are deliberately not set here: whatever the caller
# exported reaches the bridge unchanged. The values below are only what gets
# *printed*, and they have to be the values that will actually apply.
bind="${BC_BIND:-127.0.0.1:8110}"
case "$bind" in
  *:*) ;;
  *) bind="$bind:8110" ;;
esac
bind_host="${bind%:*}"
bind_port="${bind##*:}"

# A wildcard address is not an address anybody can type into the extension, so a
# wildcard is printed as loopback: what cannot be dialled must not be shown.
case "$bind_host" in
  ""|"0.0.0.0"|"::"|"[::]"|"0:0:0:0:0:0:0:0"|"[0:0:0:0:0:0:0:0]") bind_host=127.0.0.1 ;;
esac
case "$bind_port" in
  ""|*[!0-9]*) bind_port=8110 ;;
esac

http_port="${BC_HTTP_PORT:-8111}"
case "$http_port" in
  ""|*[!0-9]*) http_port=8111 ;;
esac

token=$(cat "$token_file")

printf 'endpoint: ws://%s:%s\n' "$bind_host" "$bind_port"
printf 'http: http://127.0.0.1:%s/mcp\n' "$http_port"
printf 'token: %s\n' "$token"

exec "$binary" --http
