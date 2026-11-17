# browser-control-bridge (Rust)

The Rust bridge: a `[[bin]]` named `browser-control-bridge` that builds for Linux
and Windows and ports the Node bridge — read the environment, refuse to start
without a usable token, bind the extension listener, serve the extension's
WebSocket connection and its JSON protocol, log what it did, and stop cleanly on
SIGTERM/SIGINT.

What it does today, in the order it happens:

1. Reads `BC_BIND` (`host:port`, default `127.0.0.1:8110`), `BC_LOG`
   (`info`|`debug`), `BC_HTTP_PORT`, `BC_HELLO_TIMEOUT_MS` and
   `BC_CALL_TIMEOUT_MS`. Invalid values fall back to the default instead of
   failing the start.
2. Reads the token from `BC_TOKEN_FILE`, else
   `$HOME/.config/browser-control/token`. A missing or unusable token — at least
   32 hexadecimal characters after trimming — exits `2`, which the systemd unit
   is written to *not* restart for.
3. Binds the extension listener and logs
   `listening on 127.0.0.1:8110 log=info`. A bind that fails logs the symbolic
   error code Node prints (`EADDRINUSE`, …), the port's owner when it can be
   found, and exits `1`, which the unit *does* restart for. An `accept` that fails
   afterwards ends the process the same way (`listener failed on …`); an aborted
   connection is ignored in silence, as Node ignores `ECONNABORTED`.
4. Reads one HTTP request head per accepted connection, bounded by the `hello`
   timeout and by a 16 KiB ceiling. A valid upgrade gets `101` and the WebSocket
   frame codec; a plain HTTP request is refused with `426 Upgrade Required` and the
   body `WebSocket upgrade required`; a head that cannot be read, or an upgrade
   that fails its checks, gets `400`.
5. Serves the hub's protocol on that connection: `hello` with the token (close
   `4401` on a mismatch, `4408` when it never arrives), `welcome`, the automatic
   `status` request, and one response per request. Results, errors and close codes
   are logged the way the Node bridge logs them.

What is *not* there yet: `/mcp` over stdio and over HTTP, so `--http` is still not
read. Until those land, the Node bridge under `../bridge/` is the implementation
that actually runs.

stdout stays untouched: it is the JSON-RPC channel. Every line this binary writes
goes to stderr, timestamped with `toISOString()`'s format.

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

Six crates, all named in `docs/38`, `## Dependency changes`:

| Crate | Why |
|---|---|
| `tokio` (`rt-multi-thread`, `net`, `time`, `signal`, `sync`, `io-util`, `io-std`, `process`, `macros`) | async runtime, listener, deadlines, signals, channels |
| `sha1` + `base64` | `Sec-WebSocket-Accept` = Base64 of SHA-1(key + GUID) |
| `sha2` + `subtle` | the token compare: SHA-256 of both sides, then a constant-time compare |
| `serde_json` (`preserve_order`) | the hub's JSON protocol; `preserve_order` pulls `indexmap` in, because the unlisted fields of a debug block keep result order |

No WebSocket crate and no HTTP crate: the frame codec, the head reader and the
two refusal answers are ours, because the close codes, the message limit and the
bytes behind the handshake are part of the contract.

`Cargo.lock` is committed, so a build uses the versions the measurements used
unless someone updates them on purpose.

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
