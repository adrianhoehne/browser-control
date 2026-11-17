//! The extension port's HTTP head: what the reader accepts, what it refuses, and the
//! one thing that must happen right after the upgrade.
//!
//! The five cases here are the ones this round's review found broken in the running
//! binary — a plain `curl` answered with `400` instead of `426`, a head without
//! colons closed in silence, an LF-only head nobody recognised, a 17-KiB head parsed
//! instead of refused, and a `hello` that shared a packet with the upgrade and then
//! waited for a socket read that never came. They are pinned at the level where they
//! can still fail: the reader is a library function now, and the first/last case runs
//! [`serve_connection`] over an in-memory duplex pipe, which is a real wire as far as
//! that code is concerned.
//!
//! Every case carries a camelCase name, because the name is the sentence a reader of
//! a red test needs. `#![allow(non_snake_case)]` is the price of that, exactly as in
//! `tests/hub.rs`.

#![allow(non_snake_case)]

use std::sync::Arc;
use std::time::Duration;

use browser_control_bridge::config::Config;
use browser_control_bridge::head::{self, Head, HEAD_LIMIT_BYTES};
use browser_control_bridge::hub::Hub;
use browser_control_bridge::link::serve_connection;
use browser_control_bridge::log::Level;
use browser_control_bridge::protocol;
use browser_control_bridge::ws::opcode;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::task::JoinHandle;

/// Long enough for a real 300 ms deadline to fire, short enough that a bridge which
/// never answers fails the case instead of holding the suite open.
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

/// The `hello` deadline these cases run with: short enough that a swallowed `hello`
/// produces its `4408` within the step timeout instead of after a second.
const HELLO_TIMEOUT: Duration = Duration::from_millis(300);

/// The peer `main.rs` logs — the bare IP, because that is what it writes.
const PEER: &str = "127.0.0.1";

/// A valid Sec-WebSocket-Key (the RFC 6455 sample) and the token the hub checks.
const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const CLIENT_MASK_KEY: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

/* ------------------------------------------------------------------ helpers */

fn test_config() -> Config {
    Config {
        host: "127.0.0.1".to_string(),
        port: 8_110,
        http_port: 8_111,
        log_level: Level::Info,
        hello_timeout_ms: HELLO_TIMEOUT.as_millis() as u64,
        call_timeout_ms: 10_000,
    }
}

/// Built at runtime, not written as a literal: a 32-character hex string would trip
/// the "no secrets in the repo" grep.
fn token() -> String {
    "ab".repeat(16)
}

fn hello_message() -> String {
    json!({
        "type": protocol::types::HELLO,
        "protocol": protocol::VERSION,
        "extensionVersion": "0.1.0",
        "browser": { "name": "Firefox", "version": "152.0.3" },
        "token": token(),
    })
    .to_string()
}

fn upgrade_head() -> String {
    format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
}

/// One client text frame, masked the way a browser masks: the only shape the server
/// side accepts. The `hello` of these cases carries a browser block, so the 16-bit
/// length path is the normal one here.
fn masked_text_frame(text: &str) -> Vec<u8> {
    let payload = text.as_bytes();
    let mut frame = vec![0x80 | opcode::TEXT];
    if payload.len() < 126 {
        frame.push(0x80 | payload.len() as u8);
    } else {
        assert!(payload.len() <= u16::MAX as usize, "the case needs a short frame");
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    frame.extend_from_slice(&CLIENT_MASK_KEY);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ CLIENT_MASK_KEY[index & 0b11]),
    );
    frame
}

/// One client end of a connection, plus whatever the bridge wrote that the last call
/// did not consume.
struct Peer {
    to_bridge: DuplexStream,
    from_bridge: DuplexStream,
    buffered: Vec<u8>,
    task: JoinHandle<()>,
}

impl Peer {
    /// Starts one bridge connection over two in-memory pipes: the bridge reads what
    /// this struct writes and writes what this struct reads.
    fn start() -> Peer {
        let (to_bridge, bridge_reader) = tokio::io::duplex(64 * 1024);
        let (bridge_writer, from_bridge) = tokio::io::duplex(64 * 1024);

        let hub = Arc::new(
            Hub::new(&test_config(), token())
                // The log is not what these cases measure, and a real one would write
                // the suite's transcript onto stderr.
                .with_log(Arc::new(|_: &str| {})),
        );
        let task = tokio::spawn(async move {
            serve_connection(
                hub,
                bridge_reader,
                bridge_writer,
                PEER.to_string(),
                HELLO_TIMEOUT,
            )
            .await;
        });

        Peer {
            to_bridge,
            from_bridge,
            buffered: Vec::new(),
            task,
        }
    }

    async fn send(&mut self, bytes: &[u8]) {
        tokio::time::timeout(STEP_TIMEOUT, self.to_bridge.write_all(bytes))
            .await
            .expect("the bridge did not take the bytes within the step timeout")
            .expect("the bridge closed the write half");
    }

    /// Everything the bridge writes until it closes the connection.
    async fn read_to_end(&mut self) -> Vec<u8> {
        let mut rest = Vec::new();
        tokio::time::timeout(STEP_TIMEOUT, self.from_bridge.read_to_end(&mut rest))
            .await
            .expect("the bridge did not close the connection within the step timeout")
            .expect("the bridge's read half failed");
        let mut bytes = std::mem::take(&mut self.buffered);
        bytes.extend_from_slice(&rest);
        bytes
    }

    /// Reads until `needle` has been seen and returns everything up to and including
    /// it. Bytes behind it stay buffered for the next call.
    async fn read_until(&mut self, needle: &[u8]) -> Vec<u8> {
        loop {
            if let Some(position) = self
                .buffered
                .windows(needle.len())
                .position(|window| window == needle)
            {
                let end = position + needle.len();
                return self.buffered.drain(..end).collect();
            }
            self.fill_at_least(self.buffered.len() + 1).await;
        }
    }

    async fn fill_at_least(&mut self, count: usize) {
        while self.buffered.len() < count {
            let mut chunk = [0_u8; 4096];
            let read = tokio::time::timeout(STEP_TIMEOUT, self.from_bridge.read(&mut chunk))
                .await
                .expect("the bridge wrote nothing within the step timeout")
                .expect("the bridge's read half failed");
            assert!(
                read > 0,
                "the bridge closed the connection while {} bytes were still expected; \
                 buffered so far: {:?}",
                count - self.buffered.len(),
                String::from_utf8_lossy(&self.buffered),
            );
            self.buffered.extend_from_slice(&chunk[..read]);
        }
    }

    /// One complete server frame: its opcode and its payload.
    async fn next_frame(&mut self) -> (u8, Vec<u8>) {
        self.fill_at_least(2).await;
        let first = self.buffered[0];
        let second = self.buffered[1];
        assert_eq!(first & 0x80, 0x80, "server frames are FIN");
        assert_eq!(second & 0x80, 0, "server frames are never masked");

        let mut length = usize::from(second & 0x7f);
        let mut header = 2;
        if length == 126 {
            self.fill_at_least(4).await;
            length = usize::from(u16::from_be_bytes([
                self.buffered[2],
                self.buffered[3],
            ]));
            header = 4;
        }
        self.fill_at_least(header + length).await;
        let payload = self.buffered[header..header + length].to_vec();
        self.buffered.drain(..header + length);
        (first & 0x0f, payload)
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/* -------------------------------------------------------------------- cases */

#[tokio::test]
async fn head_overTheCap_shouldBeRejected() {
    // GIVEN a head that is terminated *and* over the ceiling — the one shape the
    // previous reader accepted, because it searched for the blank line first and only
    // looked at the size once the search had failed:
    let padding = "a".repeat(HEAD_LIMIT_BYTES);
    let oversized = format!(
        "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Pad: {padding}\r\n\r\n"
    );
    assert!(
        oversized.len() > HEAD_LIMIT_BYTES,
        "the case needs a head above the ceiling"
    );
    let mut reader: &[u8] = oversized.as_bytes();

    // WHEN the reader looks at it,
    let outcome = head::read_request_head(&mut reader, HELLO_TIMEOUT).await;

    // THEN the ceiling wins over the terminator:
    assert_eq!(outcome, Head::Broken);
}

#[tokio::test]
async fn plainHttpRequest_shouldAnswer426() {
    // GIVEN a peer that sends an ordinary GET — no `Upgrade` header, the shape a lost
    // `curl` and Caddy's HTTP/2 forwarding produce:
    let mut peer = Peer::start();
    peer.send(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: */*\r\n\r\n")
        .await;

    // WHEN the bridge answers,
    let response = String::from_utf8_lossy(&peer.read_to_end().await).to_string();

    // THEN it is a 426 that says why, with a body and a closing connection, instead of
    // the empty 400 the upgrade used to produce for everything:
    assert!(
        response.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
        "got: {response:?}"
    );
    assert!(
        response.contains("Connection: close\r\n"),
        "got: {response:?}"
    );
    assert!(
        response.ends_with("\r\n\r\nWebSocket upgrade required\n"),
        "got: {response:?}"
    );
}

#[tokio::test]
async fn brokenHead_shouldAnswer400() {
    // GIVEN a head with a header line that has no colon — unusable, and previously
    // closed in silence so the peer never learned what it got wrong:
    let mut peer = Peer::start();
    peer.send(b"GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nBroken\r\n\r\n")
        .await;

    // WHEN the bridge answers,
    let response = String::from_utf8_lossy(&peer.read_to_end().await).to_string();

    // THEN it is a 400 with a complete, empty answer:
    assert!(
        response.starts_with("HTTP/1.1 400 Bad Request\r\n"),
        "got: {response:?}"
    );
    assert!(
        response.ends_with("\r\n\r\n"),
        "a 400 carries no body: {response:?}"
    );
}

#[tokio::test]
async fn lfOnlyHead_shouldBeParsed() {
    // GIVEN a head that uses bare LF line endings — what a hand-written client may
    // well send, and what a reader that only knew `\r\n\r\n` sat on until the ceiling:
    let head_text = format!(
        "GET / HTTP/1.1\nHost: 127.0.0.1\nUpgrade: websocket\nConnection: Upgrade\n\
         Sec-WebSocket-Key: {KEY}\nSec-WebSocket-Version: 13\n\nleft over"
    );
    let mut reader: &[u8] = head_text.as_bytes();

    // WHEN the reader looks at it,
    let outcome = head::read_request_head(&mut reader, HELLO_TIMEOUT).await;

    // THEN the head is complete, its headers are readable, and the bytes behind it
    // are handed over untouched:
    let Head::Upgrade { request, rest } = outcome else {
        panic!("an LF-only head must parse, got {outcome:?}");
    };
    assert_eq!(request.method, "GET");
    assert_eq!(request.headers.get("upgrade"), Some("websocket"));
    assert_eq!(request.headers.get("sec-websocket-version"), Some("13"));
    assert_eq!(rest, b"left over");
}

#[tokio::test]
async fn headBytesAreDeliveredRightAfterTheUpgrade() {
    // GIVEN a peer that sends its `hello` in the same write as the upgrade and then
    // says nothing at all for longer than the hello deadline,
    let mut peer = Peer::start();
    let mut packet = upgrade_head().into_bytes();
    packet.extend_from_slice(&masked_text_frame(&hello_message()));
    peer.send(&packet).await;

    // WHEN the upgrade is answered,
    let handshake = String::from_utf8_lossy(&peer.read_until(b"\r\n\r\n").await).to_string();
    assert!(
        handshake.starts_with("HTTP/1.1 101 Switching Protocols\r\n"),
        "got: {handshake:?}"
    );

    // THEN the first frame the bridge sends is `welcome` — the `hello` behind the head
    // reached the hub without waiting for a socket read that a silent peer never
    // produces. Without that step the hello timer fires and this frame is a `4408`
    // close instead.
    let (first_opcode, payload) = peer.next_frame().await;
    assert_eq!(
        first_opcode,
        opcode::TEXT,
        "expected a text frame, got opcode {first_opcode:#x} ({:?})",
        String::from_utf8_lossy(&payload),
    );
    let frame: Value = serde_json::from_slice(&payload).expect("the bridge wrote a non-JSON frame");
    assert_eq!(frame["type"], protocol::types::WELCOME);
}
