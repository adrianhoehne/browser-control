# browser-control-bridge (Rust)

The Rust bridge: a `[[bin]]` named `browser-control-bridge` that builds for Linux
and Windows and ports the Node bridge — read the environment, refuse to start
without a usable token, bind the extension listener, serve the extension's
WebSocket connection and its JSON protocol, answer MCP on stdin/stdout, log what
it did, and stop cleanly on SIGTERM/SIGINT.

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
6. Serves MCP on its own stdin/stdout, beside the listener: `initialize`, `ping`,
   `tools/list` and `tools/call` for the thirteen tools, one JSON line per answer.
   The tool table and the German sentences are copied from `bridge/mcp.mjs`
   character for character; `scripts/parity.sh` compares comparisons 1–3 against
   the recorded Node answers. A refused call never reaches the extension, and every
   failure is a tool result with `isError: true` and a German sentence — a
   protocol error is reserved for a malformed *request*. When stdin ends, the last
   answer is still written: the end of the input is not the end of the answers, so
   a single `tools/list` line piped in and followed by EOF still comes back.
7. Stops on SIGTERM/SIGINT, and on a stdin that belongs to a client. Under systemd
   stdin is `/dev/null`, and its EOF is not a shutdown request: a pipe or a
   socketpair is, `/dev/null` and a terminal are not (`std::fs::metadata` on
   `/proc/self/fd/0`). Without that distinction `Restart=on-failure` would turn the
   service into a restart loop.

What is *not* there yet: `/mcp` over **HTTP**, so `--http` is still not read, and
parity comparison 7 stays red. Until the HTTP transport lands (stage 2e), the Node
bridge under `../bridge/` is the implementation that runs as a service.

stdout is the JSON-RPC channel and nothing else: one JSON line per answer, no BOM,
no blank line, no log line. Everything diagnostic goes to stderr, timestamped with
`toISOString()`'s format.

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

Seven crates, all named in `docs/38`, `## Dependency changes`:

| Crate | Why |
|---|---|
| `tokio` (`rt-multi-thread`, `net`, `time`, `signal`, `sync`, `io-util`, `io-std`, `process`, `macros`) | async runtime, listener, deadlines, signals, channels |
| `sha1` + `base64` | `Sec-WebSocket-Accept` = Base64 of SHA-1(key + GUID) |
| `sha2` + `subtle` | the token compare: SHA-256 of both sides, then a constant-time compare |
| `serde_json` (`preserve_order`) | the hub's JSON protocol and the tool layer's answers; `preserve_order` pulls `indexmap` in, because the unlisted fields of a debug block keep result order and the tool table keeps the order of `bridge/mcp.mjs` |
| `serde` (`derive`) | the JSON-RPC error object serialises itself, so its wire names cannot drift from its fields |

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
`protocol.rs` case reads `extension/protocol.js` as text, the cases that need a
socket bind an ephemeral one on loopback, and `tests/mcp.rs` puts the tool layer in
front of a real hub whose "extension" is the test itself — a request goes out, an
answer comes back, and the MCP answer is what is compared.

`tests/mcp.rs` also reads `scripts/parity/expected/1-initialize-and-tools-list.txt`
and compares the whole `tools/list` answer with it byte for byte; that file is the
yardstick of `docs/37` and must stay in the tree.

One case in `tests/mcp.rs` starts the real binary (`CARGO_BIN_EXE_…`) rather than
the library: it writes one `tools/list` line to the child's stdin, closes it and
reads stdout. That is the only place where the answer to the last line before EOF
can be measured, because a test runtime outlives `serve()` and a process runtime
does not. It needs a token file and a port of its own — a temporary one and an
ephemeral one, never the reserved range — and it runs the same in `cargo test`.

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
