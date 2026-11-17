#!/usr/bin/env bash
# The `unit` and `bundle` jobs of `.github/workflows/test.yml`, run locally, in
# the same order as the table in `docs/40`.
#
# Not here: the `e2e` job. It needs Firefox and starts it; `node
# scripts/e2e/run.mjs` is that half, and `bash scripts/ci-local.sh` must not
# spawn a browser behind the operator's back.
#
# Two orderings are load-bearing and easy to get wrong:
#   - everything that builds comes before everything that tests, because
#     `scripts/parity.sh` and `scripts/bundle.sh` read `target/<triple>/release/`
#     and never build anything themselves;
#   - `scripts/bundle.sh` runs **before** `npm run test:bundle`, because the
#     bundle cases read the zips it writes.
#
# Requirements beyond the node/rust toolchain: the two cargo targets
# (`rustup target add x86_64-unknown-linux-musl x86_64-pc-windows-gnu`, plus
# `gcc-mingw-w64-x86-64` for the Windows link), `zip`/`unzip` and `bash`.
#
# **Do not run this at the same time as a second suite.** The Rust tests and
# `scripts/parity.sh` bind ports; this script runs them one after another for
# exactly that reason.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# rustup puts its shims in `~/.cargo/bin`, which a fresh non-login shell (a CI
# step, an editor task) does not necessarily have on `PATH`. Without this the
# script dies on the first build with "cargo: command not found".
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

CARGO_MANIFEST="bridge-rs/Cargo.toml"
LINUX_TARGET="x86_64-unknown-linux-musl"
WINDOWS_TARGET="x86_64-pc-windows-gnu"

step() {
  printf '\n==> %s\n' "$1"
  shift
  "$@"
}

# Builds first: a debug build next to a release build is a binary that exists and
# is not found, and `parity.sh` would report it as missing.
step "cargo build --release ($LINUX_TARGET)" \
  cargo build --release --manifest-path "$CARGO_MANIFEST" --target "$LINUX_TARGET"
step "cargo build --release ($WINDOWS_TARGET)" \
  cargo build --release --manifest-path "$CARGO_MANIFEST" --target "$WINDOWS_TARGET"

step "npm run check" npm run check
step "npm test" npm test
step "npm run test:ci" npm run test:ci

# `--test-threads=1`: the cases that start a real bridge bind ports.
step "cargo test -- --test-threads=1" \
  cargo test --manifest-path "$CARGO_MANIFEST" -- --test-threads=1
step "cargo clippy ($LINUX_TARGET)" \
  cargo clippy --manifest-path "$CARGO_MANIFEST" --all-targets --target "$LINUX_TARGET" -- -D warnings
step "cargo clippy ($WINDOWS_TARGET)" \
  cargo clippy --manifest-path "$CARGO_MANIFEST" --all-targets --target "$WINDOWS_TARGET" -- -D warnings

step "parity.sh --impl rust --check" bash scripts/parity.sh --impl rust --check
step "parity.sh --self-test" bash scripts/parity.sh --self-test

# The zips before their cases — the other way round tests a zip from an older run,
# or none at all.
step "scripts/bundle.sh" bash scripts/bundle.sh
step "npm run test:bundle" npm run test:bundle

printf '\nci-local: alle Schritte grün\n'
