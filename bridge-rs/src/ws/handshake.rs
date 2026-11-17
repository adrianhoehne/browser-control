//! The HTTP upgrade that turns a request into a WebSocket connection.
//!
//! `Sec-WebSocket-Extensions` and `Sec-WebSocket-Protocol` are never echoed: no
//! compression, no subprotocol. A client that offers them is not rejected, it
//! simply does not get them, which is what RFC 6455 prescribes.
//!
//! The request arrives as a [`RequestHead`] instead of Node's `IncomingMessage`:
//! the upgrade reads a method and five headers, and a hand-written HTTP head reader
//! (`docs/38`, stage 2e) produces exactly that. Nothing here needs the socket-level
//! framing of an HTTP library.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use sha1::{Digest, Sha1};

use crate::ws::{Transport, WebSocketConnection};

/// RFC 6455 §1.3: the fixed GUID that turns the client key into the accept key.
const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const HEADER_KEY: &str = "sec-websocket-key";
const HEADER_UPGRADE: &str = "upgrade";
const HEADER_CONNECTION: &str = "connection";
const HEADER_VERSION: &str = "sec-websocket-version";

/// The four header lines of a `101`, in the template's order. Nothing else is
/// negotiated, so nothing else is written.
const SWITCHING_PROTOCOLS: &str = concat!(
    "HTTP/1.1 101 Switching Protocols\r\n",
    "Upgrade: websocket\r\n",
    "Connection: Upgrade\r\n",
    "Sec-WebSocket-Accept: ",
);

const REJECTION: &str =
    "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/// Computes the `Sec-WebSocket-Accept` value for a client's `Sec-WebSocket-Key`.
pub fn accept_key(key: &str) -> String {
    let mut digest = Sha1::new();
    digest.update(key.as_bytes());
    digest.update(WEBSOCKET_GUID.as_bytes());
    STANDARD.encode(digest.finalize())
}

/// The request headers the upgrade reads.
///
/// Two behaviours of Node's `req.headers` are kept, because the upgrade depends on
/// both: names are case-insensitive, and a repeated header arrives as one
/// comma-joined value. `Connection: keep-alive` next to `Connection: Upgrade` is a
/// legal request and must still be accepted.
///
/// Surrounding whitespace is stripped on the way in, which is the third behaviour of
/// that struct: Node's HTTP parser removes optional whitespace (RFC 9110 §5.5) before
/// the header reaches `req.headers`. Measured against the template, `Upgrade:
/// websocket ` and `Sec-WebSocket-Version: 13` are accepted with `101` — a `Headers`
/// that claims to be `req.headers` and then answers `400` to them would be lying.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers(Vec<(String, String)>);

impl Headers {
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Headers {
        let mut headers = Headers::default();
        for (name, value) in pairs {
            headers.push(name, value);
        }
        headers
    }

    /// Adds one header line, folding a repeated name into the existing value.
    ///
    /// The trim happens here and not at the call site: every producer of a
    /// `RequestHead` — a test today, the head reader of stage 2e tomorrow — would
    /// otherwise have to remember it, and one that forgets breaks a browser that
    /// pads a header.
    pub fn push(&mut self, name: &str, value: &str) {
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if let Some((_, existing)) = self.0.iter_mut().find(|(key, _)| *key == name) {
            existing.push_str(", ");
            existing.push_str(value);
            return;
        }
        self.0.push((name, value.to_string()));
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.0
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// The parts of an HTTP request the upgrade decides on — the same three facts
/// `upgradeSocket()` read from `req`, and deliberately nothing more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHead {
    pub method: String,
    pub headers: Headers,
}

/// Completes the HTTP upgrade and returns the connection, or `None` when the
/// request is not a valid WebSocket handshake — in that case the socket has been
/// answered with `400` and closed.
///
/// `head` holds the bytes that arrived together with the request; they belong to
/// the connection, not to the handshake, so they are handed over untouched.
pub fn upgrade_socket<T: Transport>(
    request: &RequestHead,
    mut transport: T,
    head: &[u8],
) -> Option<WebSocketConnection<T>> {
    let key = match request.headers.get(HEADER_KEY) {
        Some(key) if !key.is_empty() => key,
        _ => return reject(transport),
    };
    if !is_websocket_upgrade(request) {
        return reject(transport);
    }

    transport.write(
        format!("{SWITCHING_PROTOCOLS}{}\r\n\r\n", accept_key(key)).as_bytes(),
    );

    Some(WebSocketConnection::new(transport, head))
}

/// Answers `400` and closes. The empty `Content-Length` is what makes the answer
/// complete rather than a promise that never ends.
fn reject<T: Transport>(mut transport: T) -> Option<WebSocketConnection<T>> {
    transport.write(REJECTION.as_bytes());
    transport.end();
    None
}

fn is_websocket_upgrade(request: &RequestHead) -> bool {
    request.method == "GET"
        && request
            .headers
            .get(HEADER_UPGRADE)
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        && request.headers.get(HEADER_VERSION) == Some("13")
        && header_has_token(request.headers.get(HEADER_CONNECTION), "upgrade")
}

/// Whether this request is an upgrade at all — the decision Node's HTTP parser makes
/// before it decides to emit `upgrade` instead of calling the request handler.
///
/// Everything that is *not* an upgrade is a plain HTTP request and belongs on the
/// `426` path; an upgrade attempt that fails its checks belongs on the `400` path.
/// The trigger is the same pair the parser uses: an `Upgrade` header, and the
/// `upgrade` token in `Connection`. The version and the key are deliberately not part
/// of it — a `Sec-WebSocket-Version: 8` request is a browser that tried, and telling
/// it `426 Upgrade Required` would hide the version mismatch behind "you did not
/// ask for an upgrade at all".
pub fn is_upgrade_attempt(request: &RequestHead) -> bool {
    request.headers.get(HEADER_UPGRADE).is_some()
        && header_has_token(request.headers.get(HEADER_CONNECTION), "upgrade")
}

fn header_has_token(value: Option<&str>, token: &str) -> bool {
    let Some(value) = value else {
        return false;
    };
    value
        .split(',')
        .any(|part| part.trim().eq_ignore_ascii_case(token))
}
