//! The life cycle of the real process: what the end of stdin means, and what it must not
//! mean.
//!
//! Stage 2f of `docs/38`. Three cases, and each one is a rule the service depends on:
//!
//! - a pipe that ends is a client saying goodbye: exit `0`, exactly one line
//!   `stdin closed, shutting down`, and nothing but JSON-RPC on stdout, without a fragment
//!   at the end;
//! - the same end with a live extension session — a socket, a `welcome`, the automatic
//!   `status` request the hub sends on its own — must not change that answer;
//! - stdin on `/dev/null`, which is exactly what `INSTALL.md` and the unit give the
//!   standalone service, is *not* a goodbye: the process keeps running, keeps listening and
//!   writes no shutdown line. Without that rule `Restart=on-failure` turns the service into
//!   a restart loop, which is the one failure a life-cycle bug can cause in production.
//!
//! The three names are the Node ones (`test/mcp.test.js`), so the mapping stays readable;
//! `docs/38`, `### What could go wrong` names the allow for the missing snake case.
//!
//! **Ports.** `BC_BIND=127.0.0.1:0` is not usable here: `config::parse_bind` maps port `0`
//! to `8110` (the documented silent lie, ported and not fixed), and `8110` is the
//! operator's own bridge. So the number comes from a temporary bind — the kernel hands out
//! an ephemeral port, far above the 18110–18119 range `tests/common/mod.rs` reserves for
//! the Node suite — and that bind is closed before the child starts.
//!
//! **Cleanup is by PID.** Every child is killed through its own `Child` handle in `Drop`,
//! so a failing assertion still leaves no bridge behind. `pkill -f` is not an option
//! anywhere in this tree: the operator's service has the same command line
//! (`CONTRIBUTING.md`, "Clean up by PID, never by pattern").

#![allow(non_snake_case)]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use browser_control_bridge::ws::opcode;

/// The binary Cargo built for this test file. A case that started `target/debug/…` by hand
/// would measure whatever happened to be lying there.
const BRIDGE_BINARY: &str = env!("CARGO_BIN_EXE_browser-control-bridge");

/// How long the child gets to end the process once stdin is closed. Generous on purpose: the
/// case is about the answer, not about speed, and a red case should mean "it never ended"
/// rather than "the machine was busy".
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the child gets to report its listener. The token check and the bind come before
/// it, and both are local work.
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a `/dev/null` EOF gets to be acted upon. The Node template waits 300 ms; the EOF
/// is delivered with the first read, so this is a generous lower bound and not a measurement.
const IGNORED_STDIN_SETTLE: Duration = Duration::from_millis(300);

/// How long the fake extension waits for `welcome` and the automatic `status` request.
const WELCOME_TIMEOUT: Duration = Duration::from_secs(10);

/// One poll step. Ten milliseconds keeps the whole suite responsive without spinning a core.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// A single blocking socket operation may not hold the case past its own deadline.
const SOCKET_TIMEOUT: Duration = Duration::from_secs(1);

/// The token, built at runtime instead of written as a literal: a 32-character hex string in
/// the tree would be a finding for the secret grep (`CONTRIBUTING.md`).
fn token() -> String {
    "ab".repeat(16)
}

/* --------------------------------------------------------------------- bridge */

/// Which stdin the child gets. The two variants are the two contracts.
#[derive(Clone, Copy)]
enum Stdin {
    /// A pipe: a client that speaks stdio, and whose EOF is a goodbye.
    Pipe,
    /// `/dev/null`: what the service gets under systemd, and what must never end it.
    Null,
}

/// One running bridge, plus everything a case needs to judge it.
///
/// stdout and stderr are drained by their own threads from the first byte: the child blocks
/// on a full pipe otherwise, and the assertions read a stream that must not be truncated. The
/// lock is held for the append only, so the polling helpers below stay lock-free between
/// reads.
struct Bridge {
    process: Child,
    stdin: Option<ChildStdin>,
    port: u16,
    directory: PathBuf,
    stdout: Arc<Mutex<String>>,
    stderr: Arc<Mutex<String>>,
    readers: Vec<JoinHandle<()>>,
}

impl Bridge {
    fn start(stdin: Stdin) -> Bridge {
        let directory = temporary_directory();
        let token_file = directory.join("token");
        std::fs::write(&token_file, token()).expect("the token file could not be written");

        let port = free_port();
        let mut command = Command::new(BRIDGE_BINARY);
        command
            .env("BC_BIND", format!("127.0.0.1:{port}"))
            .env("BC_TOKEN_FILE", &token_file)
            .env("BC_LOG", "info")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match stdin {
            Stdin::Pipe => command.stdin(Stdio::piped()),
            // `Stdio::null()` is `/dev/null`, not a pipe to nowhere: `stdin: "ignore"` in the
            // Node suite, and the file type the shutdown rule has to read as "not a client".
            Stdin::Null => command.stdin(Stdio::null()),
        };

        let mut process = command.spawn().expect("the bridge binary could not be started");
        let stdout = Arc::new(Mutex::new(String::new()));
        let stderr = Arc::new(Mutex::new(String::new()));
        let mut readers = Vec::new();
        if let Some(pipe) = process.stdout.take() {
            readers.push(spawn_reader(pipe, Arc::clone(&stdout)));
        }
        if let Some(pipe) = process.stderr.take() {
            readers.push(spawn_reader(pipe, Arc::clone(&stderr)));
        }

        let mut bridge = Bridge {
            stdin: process.stdin.take(),
            process,
            port,
            directory,
            stdout,
            stderr,
            readers,
        };
        bridge.wait_for_listener();
        bridge
    }

    /// Waits for the line that proves *this* child bound *this* port.
    ///
    /// Matching the log line instead of a successful connect is what keeps the case honest: a
    /// connect would also succeed against a foreign bridge that happens to hold the number, and
    /// the case would then wait for a line its own child never writes.
    fn wait_for_listener(&mut self) {
        let bound = format!("listening on 127.0.0.1:{} log=", self.port);
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if self.stderr_text().contains(&bound) {
                return;
            }
            if !self.is_running() {
                panic!(
                    "the bridge exited before it listened on port {} — is the ephemeral port taken?\n\
                     --- bridge stderr ---\n{}",
                    self.port,
                    self.stderr_text(),
                );
            }
            if Instant::now() >= deadline {
                panic!(
                    "the bridge did not report port {} as listening within {} ms\n{}",
                    self.port,
                    READY_TIMEOUT.as_millis(),
                    self.stderr_text(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn stdout_text(&self) -> String {
        self.stdout
            .lock()
            .expect("the stdout collector was poisoned")
            .clone()
    }

    fn stderr_text(&self) -> String {
        self.stderr
            .lock()
            .expect("the stderr collector was poisoned")
            .clone()
    }

    fn is_running(&mut self) -> bool {
        self.process
            .try_wait()
            .expect("the bridge could not be waited for")
            .is_none()
    }

    /// Writes one JSON-RPC message as one line — the only shape the stdio transport reads.
    fn send(&mut self, message: &Value) {
        let stdin = self
            .stdin
            .as_mut()
            .expect("the bridge was started without a stdin pipe");
        writeln!(stdin, "{message}").expect("the bridge's stdin refused a write");
        stdin.flush().expect("the bridge's stdin refused a flush");
    }

    /// Drops the write end. The child sees EOF — the client saying goodbye.
    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    /// Waits for the process to be gone and returns its exit code, or panics with the stderr
    /// transcript when it outlives the deadline. `None` is "killed by a signal", which every
    /// case here would count as the failure it is.
    fn exit_within(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self
                .process
                .try_wait()
                .expect("the bridge could not be waited for")
            {
                // Both pipes are closed now, so the readers are one `read` away from done;
                // joining them is what makes the assertions below read the final transcript.
                self.drain_output();
                return status.code();
            }
            if Instant::now() >= deadline {
                panic!(
                    "the bridge was still running {} ms after its stdin ended\n\
                     --- bridge stderr ---\n{}",
                    timeout.as_millis(),
                    self.stderr_text(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn drain_output(&mut self) {
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }

    /// Polls stderr for a needle, reporting the transcript when it never arrives: "nothing
    /// arrived" is the least useful thing to know about a child process.
    fn wait_for_stderr(&mut self, needle: &str, description: &str) {
        let deadline = Instant::now() + WELCOME_TIMEOUT;
        loop {
            if self.stderr_text().contains(needle) {
                return;
            }
            if !self.is_running() {
                panic!(
                    "the bridge exited while waiting for {description}\n\
                     --- bridge stderr ---\n{}",
                    self.stderr_text(),
                );
            }
            if Instant::now() >= deadline {
                panic!(
                    "timed out after {} ms waiting for {description}\n\
                     --- bridge stderr ---\n{}\n--- bridge stdout ---\n{}",
                    WELCOME_TIMEOUT.as_millis(),
                    self.stderr_text(),
                    self.stdout_text(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// Proof that a finished process left no message without its newline: the fragment behind
    /// the last newline is empty.
    ///
    /// An empty transcript has an empty fragment, which is what the template's
    /// `assertNoUnfinishedTail` says as well — the rule is "no fragment", not "some bytes".
    fn assert_no_unfinished_tail(&self) {
        let stdout = self.stdout_text();
        let tail = stdout.rsplit('\n').next().unwrap_or("");
        assert_eq!(
            tail, "",
            "stdout ended with a message that has no closing newline: {stdout:?}",
        );
    }

    /// Polls stdout for the answer with `id`. Searched by `id`, never by position.
    fn wait_for_answer(&mut self, id: i64, description: &str) {
        let deadline = Instant::now() + WELCOME_TIMEOUT;
        loop {
            if self.rpc_lines().iter().any(|message| message["id"] == json!(id)) {
                return;
            }
            if !self.is_running() {
                panic!(
                    "the bridge exited while waiting for {description}\n\
                     --- bridge stdout ---\n{}",
                    self.stdout_text(),
                );
            }
            if Instant::now() >= deadline {
                panic!(
                    "timed out after {} ms waiting for {description}\n\
                     --- bridge stdout ---\n{}",
                    WELCOME_TIMEOUT.as_millis(),
                    self.stdout_text(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// Every complete line on stdout, parsed.
    ///
    /// A line that is not JSON is a failure, not a "nothing yet": stdout is the protocol
    /// channel, and the whole point of this file is that nothing else reaches it.
    fn rpc_lines(&self) -> Vec<Value> {
        completed_lines(&self.stdout_text())
    }

    /// Every stderr line announcing a shutdown — there must be exactly one.
    fn shutdown_lines(&self) -> Vec<String> {
        self.stderr_text()
            .lines()
            .filter(|line| line.contains("shutting down"))
            .map(str::to_owned)
            .collect()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // By PID, from the handle we spawned — even when a case above panicked. `kill` is
        // SIGKILL, which is the one signal a hung bridge cannot ignore.
        if self
            .process
            .try_wait()
            .ok()
            .flatten()
            .is_none()
        {
            let _ = self.process.kill();
            let _ = self.process.wait();
        }
        self.drain_output();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

/* -------------------------------------------------------------------- helpers */

/// Appends everything one pipe delivers to `sink`, until the pipe ends.
fn spawn_reader(mut pipe: impl Read + Send + 'static, sink: Arc<Mutex<String>>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0_u8; 4 * 1024];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => return,
                Ok(read) => {
                    let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
                    if let Ok(mut sink) = sink.lock() {
                        sink.push_str(&text);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                // A refused read means the pipe is gone, which is the same news as EOF.
                Err(_) => return,
            }
        }
    })
}

/// The finished lines of a stdout transcript, parsed; the fragment after the last newline is
/// dropped and read separately by the cases that care about it.
fn completed_lines(stdout: &str) -> Vec<Value> {
    stdout
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("stdout carried a line that is not JSON: \
                                                 {line:?} ({error})"))
        })
        .collect()
}

/// A token file's directory under the system temp dir, unique per process and per call.
///
/// Deliberately not the repository: a token inside the working tree is exactly the leftover a
/// secret grep finds a month later. No `tempfile` crate either — `docs/38` allows no new
/// dependency, and a directory named after the PID is the whole of what is needed.
fn temporary_directory() -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let name = format!(
        "bc-bridge-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed),
    );
    let directory = std::env::temp_dir().join(name);
    std::fs::create_dir_all(&directory).expect("no temporary directory for the token file");
    directory
}

/// A port the OS just handed out and nobody holds any more.
///
/// A race in theory — the port could be taken between the drop and the child's bind, and the
/// case then fails on a "listener failed" line instead of on its own subject. That is the
/// price of a binary that reads its port from the environment, and a visible wrong failure
/// beats a hidden right one.
fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("no ephemeral port to test with");
    listener
        .local_addr()
        .expect("the bound port has no address")
        .port()
}

fn can_connect(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("the port is not an address"),
        SOCKET_TIMEOUT,
    )
    .is_ok()
}

/* ------------------------------------------------------------- fake extension */

/// A stand-in for the extension: the handshake, the `hello`, and the answer to the one request
/// the hub sends on its own — the automatic `status` after `welcome`.
///
/// It reads the bridge with [`ServerFrames`] — the decoder in `ws::frame` is the *server*
/// side and rejects exactly the shape a server is allowed to send. Only the framing is written
/// here; the handshake bytes and the masking are the client's half, and `tests/ws.rs` pins the
/// server side against the RFC cases.
struct FakeExtension {
    stream: TcpStream,
    frames: ServerFrames,
    events: VecDeque<(u8, Vec<u8>)>,
}

impl FakeExtension {
    fn connect(port: u16, token: &str) -> FakeExtension {
        let stream = TcpStream::connect(("127.0.0.1", port))
            .unwrap_or_else(|error| panic!("the bridge did not accept a connection: {error}"));
        stream
            .set_read_timeout(Some(SOCKET_TIMEOUT))
            .expect("the socket refused a read timeout");
        stream
            .set_write_timeout(Some(SOCKET_TIMEOUT))
            .expect("the socket refused a write timeout");

        let mut extension = FakeExtension {
            stream,
            frames: ServerFrames::default(),
            events: VecDeque::new(),
        };
        extension.handshake();
        // The extension speaks first, like the browser does: the token travels in `hello`,
        // never in the URL.
        extension.send_text(&json!({
            "type": "hello",
            "protocol": 1,
            "extensionVersion": "0.1.0",
            "browser": { "name": "Firefox", "version": "152.0.3" },
            "token": token,
        })
        .to_string());
        extension
    }

    /// Sends the upgrade request and swallows the `101`, keeping the bytes behind the header
    /// for the codec — the seam stage 2c exists for.
    fn handshake(&mut self) {
        let request = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\
                       Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                       Sec-WebSocket-Version: 13\r\n\r\n";
        self.stream
            .write_all(request.as_bytes())
            .expect("the bridge's socket refused the handshake");

        let mut received = Vec::new();
        let mut chunk = [0_u8; 1024];
        let header_end = loop {
            let read = self
                .stream
                .read(&mut chunk)
                .expect("the handshake answer never arrived");
            assert!(read > 0, "the bridge closed the socket during the handshake");
            received.extend_from_slice(&chunk[..read]);
            if let Some(end) = find_end_of_head(&received) {
                break end;
            }
        };

        let answer = String::from_utf8_lossy(&received[..header_end]).into_owned();
        assert!(
            answer.starts_with("HTTP/1.1 101"),
            "the bridge refused the upgrade: {answer:?}"
        );

        // The bytes behind the header belong to the codec, not to the handshake.
        let rest = received[header_end..].to_vec();
        let frames = self.frames.push(&rest);
        self.events.extend(frames);
    }

    fn send_text(&mut self, text: &str) {
        let frame = masked_text_frame(text);
        self.stream
            .write_all(&frame)
            .expect("the bridge's socket refused a frame");
    }

    /// Reads until the next text message, or returns `None` once the deadline has passed or
    /// the bridge closed the socket.
    fn next_message(&mut self, deadline: Instant) -> Option<Value> {
        loop {
            while let Some((opcode, payload)) = self.events.pop_front() {
                if opcode == opcode::TEXT {
                    let text = String::from_utf8(payload)
                        .expect("the bridge sent a text frame that is not UTF-8");
                    return Some(serde_json::from_str(&text).unwrap_or_else(|error| {
                        panic!("the bridge sent a line that is not JSON: {text:?} ({error})")
                    }));
                }
                // Control frames are not answers; nothing here pings the bridge, so they are
                // simply not this helper's business.
            }
            if Instant::now() >= deadline {
                return None;
            }

            let mut chunk = [0_u8; 4 * 1024];
            match self.stream.read(&mut chunk) {
                Ok(0) => return None,
                Ok(read) => {
                    let frames = self.frames.push(&chunk[..read]);
                    self.events.extend(frames);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => panic!("the bridge's socket failed: {error}"),
            }
        }
    }

    /// Waits for `welcome`, answers the automatic `status` request that follows it, and
    /// returns. That leaves the session exactly as a browser leaves it: connected, nothing
    /// pending, one socket open.
    fn answer_the_automatic_status_request(&mut self) {
        let deadline = Instant::now() + WELCOME_TIMEOUT;
        loop {
            let message = self.next_message(deadline).unwrap_or_else(|| {
                panic!("no welcome and no status request within {} ms", WELCOME_TIMEOUT.as_millis())
            });
            match message["type"].as_str() {
                Some("welcome") => {}
                Some("request") if message["method"] == json!("status") => {
                    let answer = json!({
                        "type": "response",
                        "id": message["id"].clone(),
                        "ok": true,
                        "result": status_result(),
                    });
                    self.send_text(&answer.to_string());
                    return;
                }
                _ => panic!("the bridge sent an unexpected frame: {message}"),
            }
        }
    }

    /// Waits for the `welcome` that answers the `hello` — the proof *on the socket* that the
    /// listener still speaks the extension protocol and not merely TCP.
    fn wait_for_welcome(&mut self) {
        let deadline = Instant::now() + WELCOME_TIMEOUT;
        let message = self.next_message(deadline).unwrap_or_else(|| {
            panic!("no welcome within {} ms", WELCOME_TIMEOUT.as_millis())
        });
        assert_eq!(
            message["type"],
            json!("welcome"),
            "the bridge answered the hello with {message}",
        );
    }
}

/// Two windows with two tabs between them — enough for the automatic status line to name both
/// numbers (`status windows=2 tabs=2`), which is the proof that the session really connected.
fn status_result() -> Value {
    json!({
        "extension": { "version": "0.1.0", "connectedAt": "2026-10-23T09:12:31.004Z" },
        "windows": [
            {
                "id": 1,
                "focused": true,
                "type": "normal",
                "tabs": [
                    {
                        "id": 101,
                        "active": true,
                        "pinned": false,
                        "url": "https://example.org/",
                        "title": "Beispiel",
                    },
                ],
            },
            {
                "id": 2,
                "focused": false,
                "type": "normal",
                "tabs": [
                    {
                        "id": 201,
                        "active": true,
                        "pinned": false,
                        "url": "",
                        "title": "Neuer Tab",
                    },
                ],
            },
        ],
    })
}

/// Reads the *server* half of the wire: unmasked frames, never fragmented (`encode_frame` in
/// `ws::frame` sends whole messages).
///
/// The library's `FrameDecoder` is the server side of this seam and rejects an unmasked frame
/// with `1002` — correctly, because a client frame must be masked. Reading what the bridge
/// writes therefore needs this small counterpart instead of a borrowed decoder.
#[derive(Default)]
struct ServerFrames {
    buffer: Vec<u8>,
}

impl ServerFrames {
    /// Consumes one chunk and returns the `(opcode, payload)` pairs it completed.
    fn push(&mut self, chunk: &[u8]) -> Vec<(u8, Vec<u8>)> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some((frame, consumed)) = self.next_frame() {
            self.buffer.drain(..consumed);
            frames.push(frame);
        }
        frames
    }

    fn next_frame(&self) -> Option<((u8, Vec<u8>), usize)> {
        let available = &self.buffer[..];
        if available.len() < 2 {
            return None;
        }

        let first = available[0];
        let second = available[1];
        assert!(
            first & 0x80 != 0,
            "the bridge sent a fragmented server frame"
        );
        assert!(second & 0x80 == 0, "the bridge masked a server frame");

        // The 7-bit length, with the two escape values the codec uses for the longer forms.
        let (length, header) = match second & 0x7f {
            value @ 0..=125 => (usize::from(value), 2),
            126 => {
                if available.len() < 4 {
                    return None;
                }
                (usize::from(u16::from_be_bytes([available[2], available[3]])), 4)
            }
            _ => {
                if available.len() < 10 {
                    return None;
                }
                let bytes: [u8; 8] = available[2..10].try_into().expect("eight bytes");
                (
                    usize::try_from(u64::from_be_bytes(bytes))
                        .expect("a length this process can hold"),
                    10,
                )
            }
        };

        if available.len() < header + length {
            return None;
        }
        let payload = available[header..header + length].to_vec();
        Some(((first & 0x0f, payload), header + length))
    }
}

/// One client text frame, masked the way a browser masks: the only shape the server accepts
/// (an unmasked client frame is a `1002`, which `tests/ws.rs` pins).
fn masked_text_frame(text: &str) -> Vec<u8> {
    const MASK_KEY: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

    let payload = text.as_bytes();
    let mut frame = vec![0x80 | opcode::TEXT];
    if payload.len() < 126 {
        frame.push(0x80 | payload.len() as u8);
    } else {
        assert!(
            payload.len() <= usize::from(u16::MAX),
            "the case needs a short frame"
        );
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    frame.extend_from_slice(&MASK_KEY);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ MASK_KEY[index & 0b11]),
    );
    frame
}

/// The offset just behind the empty line that ends an HTTP head.
fn find_end_of_head(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

/// A `ping` — the cheapest proof of life there is, and one line the client can wait for.
fn ping_message(id: i64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "ping" })
}

/* ---------------------------------------------------------------------- cases */

#[test]
fn mcp_whenStdinEnds_shouldExitZeroAfterASingleShutdownLine() {
    // GIVEN a running bridge that has answered a request:
    let mut bridge = Bridge::start(Stdin::Pipe);
    bridge.send(&ping_message(40));
    bridge.wait_for_answer(40, "the answer to ping id=40");

    // WHEN the client closes stdin — the normal way a stdio client says goodbye,
    bridge.close_stdin();
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN the process ends with 0,
    assert_eq!(
        exit_code,
        Some(0),
        "the bridge ended with {exit_code:?} instead of 0\n{}",
        bridge.stderr_text(),
    );

    // ... exactly one shutdown line was written — the cleanup's SIGTERM must not add a
    // second one either,
    let shutdown = bridge.shutdown_lines();
    assert_eq!(
        shutdown.len(),
        1,
        "one shutdown line expected, got {shutdown:?}:\n{}",
        bridge.stderr_text(),
    );
    assert!(
        shutdown[0].ends_with(" stdin closed, shutting down"),
        "the shutdown line says something else: {:?}",
        shutdown[0],
    );

    // ... and stdout carried nothing but JSON-RPC, each line a whole message,
    let messages = bridge.rpc_lines();
    assert_eq!(messages.len(), 1, "stdout carried {messages:?}");
    for message in &messages {
        assert_eq!(message["jsonrpc"], "2.0", "a line is not JSON-RPC: {message}");
        assert!(
            message.get("id").is_some(),
            "a response without an id field: {message}"
        );
    }

    // ... with no fragment at the end — the message the client rejects by name.
    bridge.assert_no_unfinished_tail();
}

#[test]
fn mcp_whenStdinEndsWithAConnectedExtension_shouldAlsoExitZeroWithOneShutdownLine() {
    // GIVEN a bridge with a connected fake extension — a session that has a socket, a
    // `welcome`, an automatic `status` request and everything else to trip over:
    let mut bridge = Bridge::start(Stdin::Pipe);
    let mut extension = FakeExtension::connect(bridge.port, &token());
    extension.answer_the_automatic_status_request();
    bridge.wait_for_stderr("status windows=", "the automatic status line on stderr");

    // WHEN stdin ends — with the extension's socket still open,
    bridge.close_stdin();
    let exit_code = bridge.exit_within(EXIT_TIMEOUT);

    // THEN it still ends with 0 and still logs exactly once. The wording of the sentence is
    // pinned by the case above (the template compares only the count here, and one pin per
    // sentence is enough — this case is about the line *arriving* despite the session).
    assert_eq!(
        exit_code,
        Some(0),
        "the bridge ended with {exit_code:?} instead of 0\n{}",
        bridge.stderr_text(),
    );
    let shutdown = bridge.shutdown_lines();
    assert_eq!(
        shutdown.len(),
        1,
        "one shutdown line expected, got {shutdown:?}:\n{}",
        bridge.stderr_text(),
    );

    // ... and stdout stayed protocol-only, without a fragment at the end. No request travelled
    // this way in this case, so the transcript is empty — and an empty transcript is the
    // strongest form of "nothing but JSON-RPC". The session's own traffic is a hub matter:
    // its status line belongs on the log, and a line of it on stdout would make
    // `rpc_lines()` fail above.
    for message in &bridge.rpc_lines() {
        assert_eq!(message["jsonrpc"], "2.0", "a line is not JSON-RPC: {message}");
    }
    bridge.assert_no_unfinished_tail();
}

#[test]
fn mcp_withAnIgnoredStdin_shouldKeepRunningAndListeningAfterTheEof() {
    // GIVEN a bridge started the way `INSTALL.md` starts the standalone one, with stdin on
    // `/dev/null`:
    let mut bridge = Bridge::start(Stdin::Null);

    // WHEN the EOF that `/dev/null` produces has had time to be acted upon,
    std::thread::sleep(IGNORED_STDIN_SETTLE);

    // THEN the process is still alive — otherwise the standalone bridge would die seconds
    // after every start and `Restart=on-failure` would turn that into a loop:
    assert!(
        bridge.is_running(),
        "the bridge exited on its ignored stdin:\n{}",
        bridge.stderr_text(),
    );

    // ... the extension port still answers,
    assert!(
        can_connect(bridge.port),
        "the extension port {} does not accept a connection any more",
        bridge.port,
    );

    // ... it still speaks the extension protocol, not just a listening socket. The proof
    // stays on the socket on purpose: this case measures the life cycle and nothing else, so
    // a mutation that puts a log line on the wrong channel cannot make it red for a reason
    // that belongs to another case.
    let mut extension = FakeExtension::connect(bridge.port, &token());
    extension.wait_for_welcome();

    // ... and no shutdown was announced: the only line about the end of stdin would be a lie
    // here.
    assert_eq!(
        bridge.shutdown_lines(),
        Vec::<String>::new(),
        "the bridge logged a shutdown for an ignored stdin:\n{}",
        bridge.stderr_text(),
    );

    // The child is still running here on purpose — `Drop` kills it by PID, which is also the
    // proof that no case leaks a process onto the operator's machine.
    assert!(bridge.is_running(), "the bridge left the case on its own");
}
