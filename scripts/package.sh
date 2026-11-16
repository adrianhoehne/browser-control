#!/usr/bin/env bash
# Builds the extension as an XPI: a zip whose root is extension/manifest.json.
#
# No web-ext, no dependencies — `zip` is all it needs. The artifact is unsigned:
# release Firefox refuses it, so it is meant for the Developer Edition, Nightly
# or ESR with `xpinstall.signatures.required` set to false (see INSTALL.md).
#
# Usage: scripts/package.sh [--out-dir DIR]
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_DIR="$REPO_ROOT/extension"
OUT_DIR="$REPO_ROOT/dist"

usage() {
  cat <<'EOF'
usage: scripts/package.sh [--out-dir DIR]

Builds extension/ into dist/browser-control-<version>.xpi (unsigned).
  --out-dir DIR   write the artifact there instead of dist/
  --help          this text
EOF
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      [[ $# -ge 2 ]] || fail "--out-dir needs a directory"
      OUT_DIR="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -f "$EXTENSION_DIR/manifest.json" ]] || fail "no extension/manifest.json under $EXTENSION_DIR"
command -v zip >/dev/null 2>&1 || fail "zip is not installed"

# The version is read, never guessed: the file name has to match what Firefox
# will show in about:addons, or two builds are indistinguishable.
version="$(node -e '
  const fs = require("fs");
  process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version);
' "$EXTENSION_DIR/manifest.json")"
[[ -n "$version" ]] || fail "could not read the version from extension/manifest.json"

artifact="$OUT_DIR/browser-control-$version.xpi"
mkdir -p "$OUT_DIR"
rm -f "$artifact"

# `-x '.*'` keeps dotfiles out: a .DS_Store or an editor swap file inside the
# archive is a review finding, not a cosmetic detail. The leading `./` is what
# `zip -r … .` writes, and `unzip -Z1` shows entries without it.
(cd "$EXTENSION_DIR" && zip -q -r "$artifact" . -x '.*' '*/.*')

# Verify what was written instead of trusting the zip. `unzip -Z1` lists the
# archive's entry names, one per line.
entries="$(unzip -Z1 "$artifact")"
printf '%s\n' "$entries" | grep -qx 'manifest.json' \
  || fail "the archive has no manifest.json at its root — Firefox would refuse it"
if printf '%s\n' "$entries" | grep -q '^extension/'; then
  fail "the archive carries an extension/ prefix — zip the contents, not the folder"
fi
if printf '%s\n' "$entries" | grep -qE '(^|/)\.'; then
  fail "the archive carries dotfiles"
fi
printf '%s\n' "$entries" | grep -qx 'background.js' \
  || fail "the archive has no background.js at its root"

size="$(du -h "$artifact" | cut -f1)"
count="$(printf '%s\n' "$entries" | grep -c .)"

printf 'built %s (%s, %s entries, version %s)\n' "$artifact" "$size" "$count" "$version"
printf '\nnext steps\n'
printf '  1. Developer Edition, Nightly or ESR: about:config →\n'
printf '     xpinstall.signatures.required = false\n'
printf '  2. about:addons → gear → "Install Add-on From File…" → %s\n' "$artifact"
printf '  3. release Firefox refuses unsigned XPIs; signing needs AMO (INSTALL.md)\n'
