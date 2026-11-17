//! MCP over HTTP: the bridge's second surface, `POST /mcp` on loopback — ported from
//! `bridge/http-transport.mjs` (stage 2e of `docs/38`).
//!
//! The transport does exactly three things — route, check the bearer token, hand one
//! JSON-RPC text to the seam stdio already uses ([`crate::mcp::handle_message_text`]).
//! It owns no tool logic: a second copy of the tool table would be a second contract to
//! keep in sync, and the first one is already pinned by tests.
//!
//! [`ToolSet`] is the injected seam, the same shape the template's `toolSet` had: the hub
//! stays outside, which is what makes the transport testable with a stub and what keeps
//! the number of ways into the extension at one.
//!
//! Bodies and headers never reach the log: an `Authorization` header is a secret, and a
//! body can carry whatever the operator was reading. The one line written when the tool
//! layer fails carries the status and not the handler's message — an exception message
//! can quote the body (`JSON.parse` failures carry a fragment of their input).
//!
//! The `500` is reached by a *panic*, not by the seam's `Err`: the production wiring is
//! `Ok(mcp::handle_message_text(…))`, which cannot fail. So the handler is polled under
//! [`std::panic::catch_unwind`] here, in this module, and the transport answers instead of
//! the connection dying — the template's `.catch()` had the same job.

use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{
    HeaderValue, ALLOW, AUTHORIZATION, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE,
    TRANSFER_ENCODING, WWW_AUTHENTICATE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::hub::{verify_token, LogSink};
use crate::log;

/// The one path this surface serves.
const MCP_PATH: &str = "/mcp";

/// The host this surface binds to. Loopback only, and deliberately not taken from
/// `BC_BIND`: `BC_BIND` is the extension port's address, and this endpoint steers the
/// operator's browser — it belongs on `127.0.0.1` and nowhere else.
pub const DEFAULT_HOST: &str = "127.0.0.1";

/// The one status this module decides itself, and only when the tool layer fails instead
/// of answering. It is also the value the failure line carries: stderr is journald, and
/// journald is forever.
const INTERNAL_ERROR_STATUS: StatusCode = StatusCode::INTERNAL_SERVER_ERROR;

/// One number, and deliberately not the extension's message limit. A request is one call
/// — a tool name, a few arguments — while a response can be a picture of several
/// megabytes. Tying the two together would let a 5 MiB socket limit turn into a 5 MiB
/// request body nobody asked for. So: an oversized HTTP body answers 413, an oversized
/// stdio line answers `-32700` — transport failures and protocol failures are different
/// layers and say so differently.
pub const MAX_BODY_BYTES: usize = 1_048_576;

/// How long a client may take to deliver a complete request head.
///
/// The template's value: Node's `headersTimeout` is 60 s, and a head that is still
/// trickling in after that is not a slow caller but a socket held open for free. hyper's
/// own default is 30 s, but only when a timer is installed — without one it silently
/// installs no deadline at all, which is the gap this constant exists to close.
pub const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(60);

const AUTH_FAILED_LINE: &str = "http auth failed";
const REQUEST_FAILED_LINE: &str = "http request failed, answering 500";

/// The largest head fragment the tap keeps before it gives up on a connection.
const MAX_TAPPED_HEAD_BYTES: usize = 64 * 1024;

/// How many complete heads the tap may queue ahead of the requests that read them. hyper
/// reads ahead by at most one buffer, so this is generous; a pipelining client that runs past
/// it gets the header map's answer instead of the raw head's, not a wrong one.
const MAX_QUEUED_HEADS: usize = 8;

/// One JSON-RPC text in, at most one message out.
///
/// `Ok(None)` is a notification (JSON-RPC forbids an answer, HTTP still wants an end);
/// `Err` is the "the tool layer threw" case, which is a `500` and a log line. The template
/// had a real exception there; Rust has no hidden control flow, so the seam says it in its
/// type instead of relying on a panic that hyper would turn into a dropped connection.
pub type ToolAnswer = Result<Option<Value>, Box<dyn std::error::Error + Send + Sync>>;

/// What one request produces: an answer to write, or an error that ends the connection
/// without writing anything.
///
/// The second case is not a status, because the template has none for it: a client that
/// gave up mid-body gets no reply at all, and hyper does exactly that when the service
/// returns an error — no bytes, no invented `400`.
type Answer = Result<Response<Full<Bytes>>, io::Error>;

type BoxedHandler =
    Box<dyn Fn(String) -> Pin<Box<dyn Future<Output = ToolAnswer> + Send>> + Send + Sync>;

/// The injected half of the transport: whatever turns one request text into one answer.
///
/// A struct around a boxed closure rather than a trait with an `async fn`: the hub, the
/// tool layer and both call sites pass one shape, and an object-safe boxed future is the
/// smaller of the two ways to say it.
pub struct ToolSet {
    handler: BoxedHandler,
}

impl ToolSet {
    pub fn new<F, Fut>(handler: F) -> ToolSet
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ToolAnswer> + Send + 'static,
    {
        ToolSet {
            handler: Box::new(move |text| Box::pin(handler(text))),
        }
    }

    async fn handle_message_text(&self, text: String) -> ToolAnswer {
        (self.handler)(text).await
    }
}

/// A bound `/mcp` listener and the task serving it.
pub struct Transport {
    /// Read back from the listener instead of echoed from the request: with `port: 0`
    /// only the kernel knows the number, and a caller that logged its own input would log
    /// a lie.
    pub host: String,
    pub port: u16,
    /// Dropping this sender is a stop request, so a `Transport` nobody closed does not
    /// keep its port either.
    stop: Option<watch::Sender<()>>,
    task: JoinHandle<std::io::Result<()>>,
}

impl Transport {
    /// Stops the listener and the connections it still holds.
    ///
    /// Idle keep-alive sockets would otherwise outlive the caller; the template's
    /// `closeAllConnections()` exists for the same reason.
    pub async fn close(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = self.task.await;
    }

    /// Waits for the accept loop to end on its own: `Ok(())` after [`Transport::close`],
    /// the listener's error when it died. `main` watches this the way it watches the
    /// extension listener — a bridge that answers one surface and not the other is half
    /// alive, and half alive is what `systemctl status` calls healthy.
    pub async fn joined(&mut self) -> std::io::Result<()> {
        match (&mut self.task).await {
            Ok(result) => result,
            Err(error) => Err(std::io::Error::other(error)),
        }
    }
}

/// Binds the default host and serves `/mcp` in the background.
///
/// `port: 0` is allowed and useful: it is how a test learns the address the kernel picked
/// instead of guessing one.
pub async fn start(
    port: u16,
    token: &str,
    tool_set: Arc<ToolSet>,
    log: LogSink,
) -> std::io::Result<Transport> {
    bind(DEFAULT_HOST, port, token, tool_set, log, HEAD_READ_TIMEOUT).await
}

/// [`start`] with the head deadline named.
///
/// Exists for the one case that has to prove the deadline: 60 s is the value the template
/// uses, and a test that waited for it would be a minute long. The production path cannot
/// reach this with anything but [`HEAD_READ_TIMEOUT`].
pub async fn start_with_head_deadline(
    port: u16,
    token: &str,
    tool_set: Arc<ToolSet>,
    log: LogSink,
    head_deadline: Duration,
) -> std::io::Result<Transport> {
    bind(DEFAULT_HOST, port, token, tool_set, log, head_deadline).await
}

/// Private on purpose: the host is not part of the public surface, and a start path with two
/// entry points only needs one of them to be reachable from outside.
async fn bind(
    host: &str,
    port: u16,
    token: &str,
    tool_set: Arc<ToolSet>,
    log: LogSink,
    head_deadline: Duration,
) -> std::io::Result<Transport> {
    let listener = TcpListener::bind((host, port)).await?;
    let local = listener.local_addr()?;
    let address = log::format_address(&local.ip().to_string(), local.port());
    let (stop, stopped) = watch::channel(());

    let task = tokio::spawn(accept_loop(
        listener,
        address,
        Arc::new(token.to_string()),
        tool_set,
        log,
        stopped,
        head_deadline,
    ));

    Ok(Transport {
        host: local.ip().to_string(),
        port: local.port(),
        stop: Some(stop),
        task,
    })
}

async fn accept_loop(
    listener: TcpListener,
    address: String,
    token: Arc<String>,
    tool_set: Arc<ToolSet>,
    log: LogSink,
    mut stop: watch::Receiver<()>,
    head_deadline: Duration,
) -> std::io::Result<()> {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let stream = match accepted {
                    Ok((stream, _peer)) => stream,
                    // A connection aborted between the SYN and our accept is not an
                    // error: the extension listener ignores `ECONNABORTED` for exactly
                    // the same reason, and a line per aborted handshake would be a log
                    // flood from any port scan. `Interrupted` is the same story one
                    // network layer down: a signal arrived while we waited, and the next
                    // `accept` picks the caller up again.
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionAborted
                                | std::io::ErrorKind::Interrupted
                        ) => continue,
                    Err(error) => {
                        // The template's server had no `error` listener, so an accept
                        // error was an uncaught event and killed the process. Here the
                        // caller decides: the line names the failure, `joined()` hands it
                        // on, and `main` ends the process with 1 the way it does for the
                        // extension listener.
                        log(&format!(
                            "http listener failed on {address}: {}",
                            log::error_code(&error)
                        ));
                        return Err(error);
                    }
                };

                // One task per connection: a client that stalls mid-body must not delay
                // the next caller.
                tokio::spawn(serve_connection(
                    stream,
                    Arc::clone(&token),
                    Arc::clone(&tool_set),
                    Arc::clone(&log),
                    stop.clone(),
                    head_deadline,
                ));
            }
            // Also reached when the `Transport` was dropped: a dropped `watch::Sender`
            // makes `changed()` return an error, which is the same stop.
            _ = stop.changed() => return Ok(()),
        }
    }
}

async fn serve_connection(
    stream: TcpStream,
    token: Arc<String>,
    tool_set: Arc<ToolSet>,
    log: LogSink,
    mut stop: watch::Receiver<()>,
    head_deadline: Duration,
) {
    let heads = Arc::new(Mutex::new(VecDeque::new()));
    let service = service_fn({
        let heads = Arc::clone(&heads);
        move |request: Request<Incoming>| {
            let token = Arc::clone(&token);
            let tool_set = Arc::clone(&tool_set);
            let log = Arc::clone(&log);
            let heads = Arc::clone(&heads);
            async move {
                let log = log.as_ref();
                catch_panics(handle_request(request, &token, &tool_set, log, &heads), log).await
            }
        }
    });

    let connection = http1::Builder::new()
        // `header_read_timeout` is dead weight without a timer: hyper's `Dur::check`
        // returns `None` and installs no deadline at all, which is how a client that sent
        // half a head held a socket for as long as it liked — the 30 s default never
        // applied either.
        .timer(TokioTimer::new())
        .header_read_timeout(head_deadline)
        .serve_connection(TokioIo::new(HeadTap::new(stream, heads)), service);

    // Both futures are cancel-safe here in the only sense that matters: stopping means the
    // connection is dropped, and a dropped connection is a closed socket.
    tokio::select! {
        _ = connection => {}
        _ = stop.changed() => {}
    }
}

/// The raw request heads of one connection, filed in arrival order as the bytes pass
/// through.
///
/// This exists for exactly one check. hyper deletes the `Content-Length` header from the map
/// as soon as a *later* `Transfer-Encoding` line shows up (its parser's `is_te && is_cl`
/// branch), so the one request shape RFC 7230 §3.3.3 says a server must refuse — both
/// framings at once — is invisible to [`Request::headers`]. Relying on the map would also make
/// the check depend on header order, which is worse than not having it.
///
/// The tap decides no framing of its own: it only remembers the head bytes and scans them for
/// two header names. hyper still parses, still owns the body, still answers.
struct HeadTap {
    stream: TcpStream,
    heads: Arc<Mutex<VecDeque<Vec<u8>>>>,
    /// The head currently arriving: everything after the last terminator seen.
    partial: Vec<u8>,
    /// Set when a fragment grew past [`MAX_TAPPED_HEAD_BYTES`] without a terminator. From then
    /// on this connection's heads are not filed at all — the queue also stays ordered, since
    /// nothing more is added to it.
    given_up: bool,
}

impl HeadTap {
    fn new(stream: TcpStream, heads: Arc<Mutex<VecDeque<Vec<u8>>>>) -> HeadTap {
        HeadTap {
            stream,
            heads,
            partial: Vec::new(),
            given_up: false,
        }
    }

    /// Files every head the new bytes completed.
    ///
    /// Past [`MAX_QUEUED_HEADS`] the new head is dropped instead of pushing the oldest one
    /// out, so the queue keeps naming the heads it was filed for: those later requests fall
    /// back to the header map, and there the `Content-Length`-and-`Transfer-Encoding` check
    /// becomes header-order dependent again — the very ambiguity this tap exists to remove.
    /// Degraded and documented, then, never silently wrong: a late request is answered from
    /// hyper's map, the same answer the transport gives without a tap at all, and a foreign
    /// head can never be read as this request's own.
    fn record(&mut self, chunk: &[u8]) {
        if self.given_up || chunk.is_empty() {
            return;
        }
        self.partial.extend_from_slice(chunk);

        while let Some(end) = head_end(&self.partial) {
            let head: Vec<u8> = self.partial.drain(..end).collect();
            if let Ok(mut heads) = self.heads.lock() {
                if heads.len() < MAX_QUEUED_HEADS {
                    heads.push_back(head);
                }
            }
        }

        // Whatever is left is a head that has not finished arriving; a body read-ahead is
        // one too, so this only ever trips on a client that sends no terminator at all.
        if self.partial.len() > MAX_TAPPED_HEAD_BYTES {
            self.given_up = true;
            self.partial = Vec::new();
        }
    }
}

impl AsyncRead for HeadTap {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let filled_before = buffer.filled().len();
        let polled = Pin::new(&mut this.stream).poll_read(context, buffer);
        if polled.is_ready() {
            // Borrowed, not copied: this runs once per read of every body too, and a copy per
            // read would be a cost the handshake never asked for.
            this.record(&buffer.filled()[filled_before..]);
        }
        polled
    }
}

impl AsyncWrite for HeadTap {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(context, buffer)
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(context)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(context)
    }
}

/// The end of the first complete head in `buffer`, terminator included.
fn head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|start| start + 4)
}

/// Takes this request's head off the queue. An empty result means the tap could not file it,
/// and the header map answers alone — degraded, never wrong.
fn take_tapped_head(heads: &Mutex<VecDeque<Vec<u8>>>) -> Vec<u8> {
    heads
        .lock()
        .ok()
        .and_then(|mut queued| queued.pop_front())
        .unwrap_or_default()
}

/// Polls the handler under [`std::panic::catch_unwind`], so a panic in the tool layer is a
/// `500` instead of a connection that closes without a word.
///
/// This is the template's `.catch()` in Rust form, and it wraps the whole handler for the
/// same reason: a body read, a JSON parse or a tool call can all throw in there, and none
/// of them may take the socket down silently. `AssertUnwindSafe` is honest here — the panic
/// abandons the request future at its await point, and the only state behind it is that one
/// request's own.
async fn catch_panics<H>(handler: H, log: &(dyn Fn(&str) + Send + Sync)) -> Answer
where
    H: Future<Output = Answer>,
{
    let mut handler = std::pin::pin!(handler);
    let outcome = std::future::poll_fn(|context| {
        match std::panic::catch_unwind(AssertUnwindSafe(|| handler.as_mut().poll(context))) {
            Ok(Poll::Ready(answer)) => Poll::Ready(Ok(answer)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(payload) => Poll::Ready(Err(payload)),
        }
    })
    .await;

    match outcome {
        Ok(answer) => answer,
        // The payload is dropped, not logged: a panic message can quote the body the
        // operator was reading, and stderr is journald.
        Err(_payload) => {
            log(REQUEST_FAILED_LINE);
            Ok(rejection(INTERNAL_ERROR_STATUS))
        }
    }
}

/// The routing order is fixed and deliberate: path, method, token, body.
///
/// Token last-but-one means an unauthenticated caller learns nothing about the endpoint
/// beyond its existence — no tool data, no reason for the rejection.
async fn handle_request(
    request: Request<Incoming>,
    token: &str,
    tool_set: &ToolSet,
    log: &(dyn Fn(&str) + Send + Sync),
    heads: &Mutex<VecDeque<Vec<u8>>>,
) -> Answer {
    // One head per request, in arrival order: with pipelining several are queued by the time
    // the first one is served, so this has to happen here and not in the check below.
    let raw_head = take_tapped_head(heads);

    // Origin-form only, and that is the template's rule rather than a courtesy: Node reads
    // `request.url` and compares it with `/mcp`, so an absolute target
    // (`POST http://host/mcp`) never matches and answers 404. `Uri::path()` happily hands
    // out `/mcp` for that form too, which is why the authority is checked as well.
    if !is_origin_form(&request) || request.uri().path() != MCP_PATH {
        return Ok(rejection(StatusCode::NOT_FOUND));
    }

    if request.method() != Method::POST {
        // No server-initiated stream, so `GET` is not a lesser request, it is the wrong
        // one — and `Allow` says which one would have worked. Decided before the token,
        // so a caller without one still learns the method.
        let mut response = rejection(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(ALLOW, HeaderValue::from_static("POST"));
        return Ok(response);
    }

    if !has_valid_bearer_token(request.headers().get(AUTHORIZATION), token) {
        log(AUTH_FAILED_LINE);
        let mut response = rejection(StatusCode::UNAUTHORIZED);
        response
            .headers_mut()
            .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return Ok(response);
    }

    // A request that announces its length *and* its chunking has no unambiguous body, and
    // RFC 7230 §3.3.3 makes that a `400` that closes the connection — the
    // request-smuggling case. Decided before the size check, because that check reads the
    // very header which must not be trusted here.
    if has_ambiguous_framing(&request, &raw_head) {
        return Ok(rejection(StatusCode::BAD_REQUEST));
    }

    // Read before the first body frame: a client that announces an oversized body is
    // refused without a single byte of it being buffered.
    if declares_oversized_body(&request) {
        return Ok(rejection(StatusCode::PAYLOAD_TOO_LARGE));
    }

    let body = match read_body(request.into_body()).await {
        BodyRead::Text(text) => text,
        BodyRead::TooLarge => return Ok(rejection(StatusCode::PAYLOAD_TOO_LARGE)),
        // The client gave up mid-body. The template answers nothing at all here — there is
        // nobody left to answer — so the error travels out and hyper closes the connection
        // without writing a byte: no invented status, no log line.
        BodyRead::Aborted => {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "the client aborted the request body",
            ))
        }
    };

    match tool_set.handle_message_text(body).await {
        // A notification: JSON-RPC forbids a response, HTTP still wants an end.
        Ok(None) => Ok(respond_empty(StatusCode::ACCEPTED)),
        Ok(Some(message)) => Ok(respond_json(StatusCode::OK, &message)),
        Err(_error) => {
            log(REQUEST_FAILED_LINE);
            Ok(rejection(INTERNAL_ERROR_STATUS))
        }
    }
}

/// Whether the request target is origin-form, which is all a server may receive from a
/// conforming client (RFC 7230 §5.3.1).
fn is_origin_form(request: &Request<Incoming>) -> bool {
    request.uri().scheme().is_none() && request.uri().authority().is_none()
}

/// Whether the request carries both `Content-Length` and `Transfer-Encoding`.
///
/// Two sources, and the raw head is the one that counts: hyper has already dropped the
/// `Content-Length` header by the time a handler sees the request when `Transfer-Encoding`
/// came after it, so the map alone answers `false` for the very request this check exists for.
/// The map is still asked first because it is free, and because it is the only source left
/// when the tap could not file the head.
fn has_ambiguous_framing(request: &Request<Incoming>, raw_head: &[u8]) -> bool {
    let declares = |name: &str| {
        request.headers().contains_key(name) || head_declares(raw_head, name)
    };
    declares(CONTENT_LENGTH.as_str()) && declares(TRANSFER_ENCODING.as_str())
}

/// Whether a head line names `name`, case-insensitively, as its own header.
///
/// Leading token only, on lines *after* the request line: a header value that happens to
/// spell another header's name is not a declaration, and that is why this does not simply
/// search the bytes.
///
/// The request line is found from the end, because the recorded fragment can start mid-body:
/// the tap knows where a head *ends*, not where it begins, so the bytes of a previous
/// request's body sit in front of the next head. Scanning from the last request line keeps a
/// body that happens to contain a `content-length: …` line from being read as one.
fn head_declares(raw_head: &[u8], name: &str) -> bool {
    let Ok(head) = std::str::from_utf8(raw_head) else {
        return false;
    };
    let lines: Vec<&str> = head.split("\r\n").collect();
    let after_request_line = lines
        .iter()
        .rposition(|line| is_request_line(line))
        .map_or(lines.len(), |index| index + 1);

    lines[after_request_line..].iter().any(|line| {
        line.split_once(':')
            .is_some_and(|(header_name, _)| header_name.trim().eq_ignore_ascii_case(name))
    })
}

/// Whether a line is an HTTP/1 request line — `METHOD target HTTP/1.1`.
fn is_request_line(line: &str) -> bool {
    line.ends_with(" HTTP/1.0") || line.ends_with(" HTTP/1.1")
}

/// Answers a request that will not be served.
///
/// The status and `Connection: close`, nothing else: no reason line, no tool data.
/// Closing is the point — a local process could otherwise hold a connection with a body
/// that trickles in forever just under the limit.
fn rejection(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONNECTION, HeaderValue::from_static("close"));
    response
        .headers_mut()
        .insert(CONTENT_LENGTH, HeaderValue::from_static("0"));
    response
}

fn respond_json(status: StatusCode, message: &Value) -> Response<Full<Bytes>> {
    // `serde_json`'s compact form is the same text `JSON.stringify` produces for the
    // values this layer hands out — and it is the form `stdio` writes, which is what makes
    // the two ways in answer with the same bytes.
    let body = message.to_string();
    // Measured before the move: a body can be several megabytes, and cloning it per answer
    // copies all of them for a number that is already in hand.
    let length = body.len();
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response.headers_mut().insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string())
            .expect("a decimal length is a valid header value"),
    );
    response
}

fn respond_empty(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_LENGTH, HeaderValue::from_static("0"));
    response
}

/// Whether the declared `Content-Length` is already over the limit.
///
/// A `Transfer-Encoding: chunked` request has no such header; that case is caught while
/// streaming instead.
///
/// Digits only, because hyper has already thrown everything else out: a `Content-Length` of
/// `1e7`, `2097152.0` or `-1` is answered with `400` while the head is parsed, so no such
/// value reaches this check. A value that still fails to parse therefore means the header is
/// unusable, and the body gets read — and counted — instead.
fn declares_oversized_body(request: &Request<Incoming>) -> bool {
    request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .is_some_and(|declared| declared > MAX_BODY_BYTES as u64)
}

enum BodyRead {
    Text(String),
    TooLarge,
    Aborted,
}

/// Collects the body, or [`BodyRead::TooLarge`] once it is larger than what may be parsed.
///
/// Counting while streaming is what makes the limit fire on a chunked body: there is no
/// header to look at, and waiting for the last chunk would mean buffering the payload the
/// limit exists to refuse. Returning early also stops polling the body, which is what lets
/// hyper close the connection instead of reading the rest of the upload.
async fn read_body(body: Incoming) -> BodyRead {
    let mut body = body;
    let mut joined: Vec<u8> = Vec::new();
    let mut received_bytes = 0_usize;

    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            return BodyRead::Aborted;
        };
        // Trailers are not body bytes; a frame without data is nothing to count.
        let Ok(data) = frame.into_data() else {
            continue;
        };
        received_bytes += data.len();
        if received_bytes > MAX_BODY_BYTES {
            return BodyRead::TooLarge;
        }
        joined.extend_from_slice(&data);
    }

    // `from_utf8_lossy` is the UTF-8 decode `Buffer.concat(chunks).toString("utf8")` did:
    // invalid bytes become U+FFFD instead of failing the request.
    BodyRead::Text(String::from_utf8_lossy(&joined).into_owned())
}

/// `Authorization: Bearer <token>`, case-insensitive in the scheme as RFC 6750 says.
///
/// Anything else — no header, another scheme, an empty token — fails the same way, and the
/// comparison itself is timing-safe through [`verify_token`].
fn has_valid_bearer_token(header_value: Option<&HeaderValue>, token: &str) -> bool {
    let Some(header_value) = header_value.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let Some((scheme, credentials)) = header_value.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    verify_token(token, credentials.trim())
}

#[cfg(test)]
mod tests {
    use super::head_declares;

    /// One raw head, both framings declared.
    fn ambiguous_head() -> Vec<u8> {
        b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:8111\r\nContent-Length: 4\r\n\
          Transfer-Encoding: chunked\r\n\r\n"
            .to_vec()
    }

    #[test]
    fn head_declares_with_both_framings_should_find_both() {
        // GIVEN a head that announces a length and a chunking,
        let head = ambiguous_head();

        // WHEN the scan looks for each name,
        // THEN it finds both — the one mechanism the framing check rests on:
        assert!(head_declares(&head, "content-length"));
        assert!(head_declares(&head, "transfer-encoding"));
        assert!(!head_declares(&head, "authorization"));
    }

    #[test]
    fn head_declares_with_another_case_should_still_find_it() {
        // GIVEN the same declaration in another spelling, which HTTP allows,
        let head = b"POST /mcp HTTP/1.1\r\nCONTENT-LENGTH: 4\r\nTrAnSfEr-EnCoDiNg: chunked\r\n\r\n";

        // WHEN the scan looks for the lower-case names,
        // THEN it finds them: header names are case-insensitive,
        assert!(head_declares(head, "content-length"));
        assert!(head_declares(head, "transfer-encoding"));
    }

    #[test]
    fn head_declares_with_body_junk_before_the_request_line_should_not_count_it() {
        // GIVEN the previous request's body in front of this head — the tap files everything
        // up to a terminator, and a body can look like a header block,
        let mut head = b"content-length: 7\r\nTransfer-Encoding: chunked\r\n".to_vec();
        head.extend_from_slice(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:8111\r\n\r\n");

        // WHEN the scan looks for the two framing names,
        // THEN the body's lines do not count — the scan starts after the request line, so a
        // body cannot turn a well-formed request into a `400`:
        assert!(!head_declares(&head, "content-length"));
        assert!(!head_declares(&head, "transfer-encoding"));
    }

    #[test]
    fn head_declares_with_a_value_spelling_a_header_name_should_not_count_it() {
        // GIVEN a head whose *value* mentions the other header,
        let head = b"POST /mcp HTTP/1.1\r\nX-Note: content-length: 4\r\n\r\n";

        // WHEN the scan looks for `content-length`,
        // THEN it does not count: only the name before the colon decides,
        assert!(!head_declares(head, "content-length"));
    }
}
