# browser-control-bridge (Rust)

The Rust bridge: a `[[bin]]` named `browser-control-bridge` that builds for Linux
and Windows and ports the start path of the Node bridge — read the environment,
refuse to start without a usable token, bind the extension listener, log what it
did, and stop cleanly on SIGTERM/SIGINT.

What it does today, in the order it happens:

1. Reads `BC_BIND` (`host:port`, default `127.0.0.1:8110`), `BC_LOG`
   (`info`|`debug`) and `BC_HTTP_PORT`. Invalid values fall back to the default
   instead of failing the start.
2. Reads the token from `BC_TOKEN_FILE`, else
   `$HOME/.config/browser-control/token`. A missing or unusable token — at least
   32 hexadecimal characters after trimming — exits `2`, which the systemd unit
   is written to *not* restart for.
3. Binds the extension listener and logs
   `listening on 127.0.0.1:8110 log=info`. A bind that fails logs the symbolic
   error code Node prints (`EADDRINUSE`, …), the port's owner when it can be
   found, and exits `1`, which the unit *does* restart for. Nothing is accepted
   from the listener yet.

stdout stays untouched: it is the JSON-RPC channel. Every line this binary writes
goes to stderr, timestamped with `toISOString()`'s format.

The Node bridge under `../bridge/` is unchanged and stays the implementation that
actually runs.

## Toolchain

Cross-built from Linux, no `.cargo/config.toml` in this directory (see below).

| Piece | Why |
|---|---|
| `rustup` / `rustc` (stable) | compiler; installed into `$HOME` |
| target `x86_64-unknown-linux-musl` | statically linked Linux binary (musl lands in the binary) |
| target `x86_64-pc-windows-gnu` | Windows binary |
| `x86_64-w64-mingw32-gcc` (GCC 13) | **linker only** for the Windows target; no code in the product |
| `clippy` (rustup component) | lints, run with `--all-targets` |

Setup:

```bash
rustup toolchain install stable
rustup target add x86_64-unknown-linux-musl x86_64-pc-windows-gnu
rustup component add clippy
sudo apt install gcc-mingw-w64-x86-64   # provides x86_64-w64-mingw32-gcc
```

## Dependencies

One: `tokio` (async runtime, net, signals), with the features listed in
`Cargo.toml`. `Cargo.lock` is committed, so a build uses the versions the
measurements used unless someone updates them on purpose.

## Building

```bash
. "$HOME/.cargo/env"

cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu
```

The artefacts land in `target/<target>/release/`:

- `bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge`
- `bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe`

`scripts/install.sh` copies the Linux binary from exactly the first path to
`$HOME/.local/bin`, so the artefact name is load-bearing.

## Why `--target` is in every command

Cargo reads its configuration starting at the **working directory** and walking
upwards. A `[build] target = …` in `bridge-rs/.cargo/config.toml` would
therefore be invisible to a command run from the repository root with
`--manifest-path bridge-rs/Cargo.toml`, and the build would silently produce a
host binary instead of the musl one. There is no `.cargo/config.toml` here for
that reason; every command names its `--target` explicitly.

## Tests

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path bridge-rs/Cargo.toml
```

Unit tests live next to the modules (`src/*.rs`), integration tests under
`tests/`. They need no Node, no network and no port of the reserved range: the
`protocol.rs` case reads `extension/protocol.js` as text, and the cases that need
a socket bind an ephemeral one on loopback.

The port numbers in `tests/common/mod.rs` are the same as in `test/ports.js`, so
`cargo test` and `npm test` must not run side by side — the second run's bridge
would find the first run's port taken. `tests/ports.rs` keeps that table honest.

`scripts/parity.sh` is the yardstick that compares this binary with the Node
bridge; it does not build anything, so build the musl release first.

## Checking the build

```bash
file -b bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge
file -b bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe
```

The first should report `statically linked` (or `static-pie linked`), the second
`PE32+ executable (console) x86-64`.
