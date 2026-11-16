#!/usr/bin/env bash
# Installs the Rust toolchain for the bridge port (spec 37, stage 0).
#
# Run it as YOUR user, not with sudo: rustup must land in your $HOME, and this
# script calls `sudo` itself for the one thing that needs root (the mingw
# cross-linker). Starting it via `sudo` would install rustup into /root and
# leave you with a toolchain your user cannot see.
#
# Idempotent: whatever is already there is left alone and reported.
set -euo pipefail

log() { printf '\n=== %s\n' "$1"; }

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  echo "error: run this as your own user, not with sudo — it calls sudo itself." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "error: sudo is not installed; install it or run the apt step by hand." >&2
  exit 1
fi

case "$(uname -s)" in
  Linux) ;;
  *) echo "error: this script handles Linux (apt). Elsewhere: install rustup and the targets by hand." >&2; exit 1 ;;
esac

# ---------------------------------------------------------------- apt (root)
if ! command -v apt-get >/dev/null 2>&1; then
  echo "error: apt-get not found; install 'gcc-mingw-w64-x86-64' with your package manager." >&2
  exit 1
fi

if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  log "mingw cross-linker already present: $(x86_64-w64-mingw32-gcc --version | head -1)"
else
  log "installing the mingw cross-linker (this asks for your password)"
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends gcc-mingw-w64-x86-64
fi

# ------------------------------------------------------------- rustup (user)
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
if [[ -f "$CARGO_HOME/env" ]]; then
  # shellcheck source=/dev/null
  . "$CARGO_HOME/env"
fi

if command -v rustup >/dev/null 2>&1; then
  log "rustup already present: $(rustup --version | head -1)"
else
  log "installing rustup (stable, minimal profile) into $CARGO_HOME"
  command -v curl >/dev/null 2>&1 || { echo "error: curl is missing" >&2; exit 1; }
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
  # shellcheck source=/dev/null
  . "$CARGO_HOME/env"
fi

# ------------------------------------------------------------------ targets
log "adding targets and clippy"
rustup target add x86_64-unknown-linux-musl x86_64-pc-windows-gnu
rustup component add clippy

# -------------------------------------------------------------------- verify
log "verify"
rustc --version
printf 'targets: '
rustup target list --installed | grep -E 'x86_64-(unknown-linux-musl|pc-windows-gnu)' | tr '\n' ' '
printf '\n'
x86_64-w64-mingw32-gcc --version | head -1

missing=0
rustup target list --installed | grep -qx 'x86_64-unknown-linux-musl' || { echo "MISSING: x86_64-unknown-linux-musl" >&2; missing=1; }
rustup target list --installed | grep -qx 'x86_64-pc-windows-gnu' || { echo "MISSING: x86_64-pc-windows-gnu" >&2; missing=1; }
command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || { echo "MISSING: mingw linken" >&2; missing=1; }

if [[ $missing -ne 0 ]]; then
  echo
  echo "Nicht alles ist da. Für Windows bleibt dann: unter Windows bauen."
  exit 1
fi

cat <<'DONE'

Fertig. Was noch fehlt: der PATH in dieser Shell.

  . "$HOME/.cargo/env"          # oder eine neue Shell öffnen

Dann (spec 37, Stufe 1):
  cargo build --release --manifest-path ~/browser-control/bridge-rs/Cargo.toml \
    --target x86_64-unknown-linux-musl

Ist `bridge-rs/` noch nicht da, ist Stufe 1 noch nicht gebaut — das ist der
nächste Schritt des Agenten, nicht dieser.
DONE
