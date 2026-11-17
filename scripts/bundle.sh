#!/usr/bin/env bash
# Builds the portable zip: one per target, from the binaries that cargo built and
# the XPI that `scripts/package.sh` builds.
#
# Nothing is compiled here. A missing binary is an error that names the command
# which produces it, because "no file at that path" is the least useful sentence
# a build script can print.
#
# Usage: scripts/bundle.sh [--binary <target>=<path>]...
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
MANIFEST="$REPO_ROOT/extension/manifest.json"
CARGO_TARGET_DIR="$REPO_ROOT/bridge-rs/target"
PORTABLE_DIR="$REPO_ROOT/deploy/portable"
GUIDE_DIR="$REPO_ROOT/docs/portable"

# The two targets this bundle ships. The triple is the cargo directory; the label
# is the platform half of the artefact name. Two names on purpose — renaming the
# artefact is not renaming a cargo target.
TARGETS=(x86_64-unknown-linux-musl x86_64-pc-windows-gnu)

usage() {
  cat <<'EOF'
usage: scripts/bundle.sh [--binary <target>=<path>]...

Writes dist/browser-control-<version>-<linux|windows>-x86_64.zip for both targets.
  --binary TARGET=PATH  take the bridge for TARGET from PATH instead of
                        bridge-rs/target/TARGET/release/ (repeatable)
  --help                this text

TARGET is one of: x86_64-unknown-linux-musl, x86_64-pc-windows-gnu
EOF
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

platform_of() {
  case "$1" in
    x86_64-unknown-linux-musl) printf 'linux' ;;
    x86_64-pc-windows-gnu) printf 'windows' ;;
    *) fail "unknown target: $1" ;;
  esac
}

binary_name_of() {
  case "$1" in
    x86_64-pc-windows-gnu) printf 'browser-control-bridge.exe' ;;
    *) printf 'browser-control-bridge' ;;
  esac
}

start_script_of() {
  case "$1" in
    x86_64-pc-windows-gnu) printf 'start.cmd' ;;
    *) printf 'start.sh' ;;
  esac
}

is_known_target() {
  local candidate="$1" target
  for target in "${TARGETS[@]}"; do
    [[ "$candidate" == "$target" ]] && return 0
  done
  return 1
}

declare -A BINARY_PATH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      [[ $# -ge 2 ]] || fail "--binary needs <target>=<path>"
      target="${2%%=*}"
      path="${2#*=}"
      [[ "$target" != "$2" && -n "$path" ]] || fail "--binary needs <target>=<path>, got: $2"
      is_known_target "$target" \
        || fail "unknown target for --binary: $target (known: ${TARGETS[*]})"
      BINARY_PATH["$target"]="$path"
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

[[ -f "$MANIFEST" ]] || fail "no extension/manifest.json under $REPO_ROOT/extension"
command -v zip >/dev/null 2>&1 || fail "zip is not installed"
command -v unzip >/dev/null 2>&1 || fail "unzip is not installed (it verifies the archive)"

# One version, one source: the manifest. The XPI and both zip names read it here,
# so two artefacts of one run cannot carry different versions.
version="$(node -e '
  const fs = require("fs");
  process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version);
' "$MANIFEST")"
[[ -n "$version" ]] || fail "could not read the version from extension/manifest.json"

# Resolve every binary before the first artefact is written: a run that stops
# halfway leaves a dist/ that looks built and is not.
for target in "${TARGETS[@]}"; do
  binary="${BINARY_PATH[$target]:-$CARGO_TARGET_DIR/$target/release/$(binary_name_of "$target")}"
  if [[ ! -f "$binary" ]]; then
    fail "no binary for $target at $binary
build it with: cargo build --release --manifest-path bridge-rs/Cargo.toml --target $target
or point at one with: scripts/bundle.sh --binary $target=<path>"
  fi
  BINARY_PATH["$target"]="$binary"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

xpi="$work/browser-control-$version.xpi"
if ! bash "$REPO_ROOT/scripts/package.sh" --out-dir "$work" >/dev/null; then
  fail "the XPI could not be built — run scripts/package.sh to see why"
fi
[[ -f "$xpi" ]] || fail "no XPI at $xpi — run scripts/package.sh"

mkdir -p "$DIST_DIR"

for target in "${TARGETS[@]}"; do
  platform="$(platform_of "$target")"
  root="browser-control-$version-$platform-x86_64"
  stage="$work/$root"
  start_script="$(start_script_of "$target")"

  mkdir -p "$stage"

  # 0755 on the binary and on start.sh. `upload-artifact` hands back files
  # without their mode, and `zip` stores whatever mode it finds: a -rw-r--r--
  # bridge is a zip the user cannot start, which is only noticed on their
  # machine.
  cp "${BINARY_PATH[$target]}" "$stage/$(binary_name_of "$target")"
  chmod 0755 "$stage/$(binary_name_of "$target")"
  cp "$PORTABLE_DIR/$start_script" "$stage/$start_script"
  chmod 0755 "$stage/$start_script"

  cp "$xpi" "$stage/"
  cp "$PORTABLE_DIR/README.txt" "$stage/"
  cp "$GUIDE_DIR/FIREFOX.md" "$stage/"
  cp "$GUIDE_DIR/CLIENTS.md" "$stage/"

  artifact="$DIST_DIR/$root.zip"
  rm -f "$artifact"
  (cd "$work" && zip -q -r "$artifact" "$root")

  # Verify the archive instead of trusting the zip call: six files plus the
  # folder entry, and nothing else — no data/, no target/ leftovers, no .git.
  entries="$(unzip -Z1 "$artifact")"
  count="$(printf '%s\n' "$entries" | grep -c .)"
  [[ "$count" -eq 7 ]] || fail "$artifact has $count entries, expected 7"

  expected=(
    "$root/"
    "$root/$(binary_name_of "$target")"
    "$root/browser-control-$version.xpi"
    "$root/$start_script"
    "$root/README.txt"
    "$root/FIREFOX.md"
    "$root/CLIENTS.md"
  )
  for name in "${expected[@]}"; do
    printf '%s\n' "$entries" | grep -qxF "$name" || fail "$artifact has no entry $name"
  done

  printf 'built %s (%s entries, version %s)\n' "$artifact" "$count" "$version"
done
