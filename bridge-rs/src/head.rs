//! The extension port's own HTTP/1.1 head reader.
//!
//! `docs/38` keeps `hyper` off this port on purpose: the reader sees exactly two
//! shapes — a `GET` with `Upgrade`, everything else is answered with `426` — and the
//! bytes after the head must reach the frame codec untouched, which is the one place
//! where an HTTP library saves work or swallows bytes.
//!
//! The three answers this port has are the three answers the template had, and they
//! are not interchangeable:
//!
//! - a valid handshake goes to [`crate::ws::upgrade_socket`] (`101`), or `400` when
//!   the upgrade itself is broken;
//! - valid HTTP that never asked for an upgrade gets [`UPGRADE_REQUIRED`] (`426`)
//!   with a body, exactly as `bridge.mjs`'s `rejectPlainRequest` answers a lost
//!   `curl`;
//! - a head this reader cannot use gets [`BAD_REQUEST`] (`400`).
//!
//! Everything here is a pure function over a byte buffer, or a read loop that
//! produces one, so `tests/head.rs` can pin the shapes without a port and without a
//! browser. That is the whole reason the module lives in the library instead of
//! `main.rs`: in the binary crate these functions were invisible to `tests/`.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

use crate::ws::{handshake, Headers, RequestHead};

/// Ceiling for one HTTP request head. Far above the ~200 bytes a browser sends and
/// far below the frame limit: a peer that never sends the blank line must not be
/// able to grow a buffer.
///
/// A head that ends *behind* this ceiling is over it as well — the ceiling bounds
/// the search for the blank line, not only the buffer.
pub const HEAD_LIMIT_BYTES: usize = 16 * 1024;

/// One read per turn. The head of a handshake is a few hundred bytes; a bigger chunk
/// would only move bytes from the socket into a buffer that is thrown away.
const READ_CHUNK_BYTES: usize = 1024;

/// The answer for valid HTTP that is not an upgrade.
///
/// `Content-Length` is spelled out instead of trusted to the close: the body is the
/// only thing that tells a client *why* its request was refused, and a client that
/// reads until the close would otherwise have to guess whether the body is complete.
/// The wording and the status are the template's (`rejectPlainRequest`).
pub const UPGRADE_REQUIRED: &[u8] = concat!(
    "HTTP/1.1 426 Upgrade Required\r\n",
    "Content-Type: text/plain; charset=utf-8\r\n",
    "Connection: close\r\n",
    "Content-Length: 27\r\n",
    "\r\n",
    "WebSocket upgrade required\n",
)
.as_bytes();

/// The answer for a head this reader cannot use: a request line without its version,
/// a header line without a colon, or a head that grew past [`HEAD_LIMIT_BYTES`].
///
/// The empty `Content-Length` is what makes the answer complete rather than a promise
/// that never ends — the same bytes `upgrade_socket` writes for an upgrade it refuses.
pub const BAD_REQUEST: &[u8] =
    b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/// What the head reader made of the bytes a peer sent.
#[derive(Debug, Clone, PartialEq)]
pub enum Head {
    /// A head for [`upgrade_socket`](crate::ws::upgrade_socket) to decide on, plus
    /// the bytes that arrived behind it. Those belong to the frame codec, not to the
    /// handshake: a `hello` that shared a packet with the upgrade starts here.
    Upgrade { request: RequestHead, rest: Vec<u8> },
    /// Valid HTTP without an upgrade: answer `426`.
    PlainHttp,
    /// Unusable: answer `400`. A peer that stayed silent for the whole deadline lands
    /// here too — the request never arrived, and nothing else is going to happen on
    /// that socket.
    Broken,
    /// The peer went away before it sent a head. There is nobody left to answer.
    Closed,
}

/// Reads one request head, and only one: the bytes behind it are returned, never
/// consumed, because the frame codec owns them.
///
/// `deadline` is the caller's `hello` timeout. That value is the right one for two
/// reasons: it already means "an unauthenticated peer must prove itself within X",
/// and the head is the first half of exactly that proof — a second, longer deadline
/// for the head would hand a silent socket two windows instead of one. Node's 60 s
/// `headersTimeout` guards a general-purpose HTTP server; this listener has one
/// shape of request and no reason to sit on a dead socket for a minute.
pub async fn read_request_head<R>(reader: &mut R, deadline: Duration) -> Head
where
    R: AsyncRead + Unpin,
{
    match tokio::time::timeout(deadline, read_head(reader)).await {
        Ok(head) => head,
        // A peer that sends nothing, or a byte every few seconds, holds a task and a
        // file descriptor for as long as it likes. The deadline is the only thing
        // that bounds that.
        Err(_) => Head::Broken,
    }
}

async fn read_head<R>(reader: &mut R) -> Head
where
    R: AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; READ_CHUNK_BYTES];

    loop {
        let count = match reader.read(&mut chunk).await {
            Ok(count) => count,
            // A reset socket is a peer that left: nothing to answer, nothing to log.
            Err(_) => return Head::Closed,
        };
        if count == 0 {
            return Head::Closed;
        }
        buffer.extend_from_slice(&chunk[..count]);

        // The ceiling comes before the search, and bounds it: a head whose blank line
        // sits at 17 KiB is 17 KiB of head, and a search over the whole buffer would
        // find an end this reader must not accept. Searching only the admissible
        // window keeps a terminated *and* oversized head from slipping through — the
        // shape the earlier in-binary reader accepted.
        let admissible = buffer.len().min(HEAD_LIMIT_BYTES);
        if let Some(end) = find_head_end(&buffer[..admissible]) {
            return classify(&buffer[..end], buffer[end..].to_vec());
        }
        if buffer.len() > HEAD_LIMIT_BYTES {
            return Head::Broken;
        }
    }
}

/// The offset just past the blank line that ends the head, in either line ending.
///
/// `\r\n\r\n` is what every browser sends and what RFC 9112 asks for. `\n\n` is
/// accepted as well because a hand-written client (`nc`, a shell script, a test) may
/// well use it, and a reader that only knew `\r\n\r\n` would sit on such a head until
/// the ceiling or the deadline closed a socket that had already said everything.
fn find_head_end(buffer: &[u8]) -> Option<usize> {
    (0..buffer.len()).find_map(|index| {
        let rest = &buffer[index..];
        if rest.starts_with(b"\r\n\r\n") {
            Some(index + 4)
        } else if rest.starts_with(b"\n\n") {
            Some(index + 2)
        } else {
            None
        }
    })
}

fn classify(head: &[u8], rest: Vec<u8>) -> Head {
    let Some(request) = parse_request_head(head) else {
        return Head::Broken;
    };
    // Node's parser emits `upgrade` for a request that carries an `Upgrade` header
    // and the `upgrade` token in `Connection`; everything else reaches the request
    // handler and is refused with `426` there. The same split is kept here, so an
    // upgrade attempt with a wrong version still ends in `upgrade_socket`'s `400`
    // instead of being mistaken for a plain request.
    if handshake::is_upgrade_attempt(&request) {
        Head::Upgrade { request, rest }
    } else {
        Head::PlainHttp
    }
}

/// Splits a complete head into the one request line the upgrade reads and its
/// headers.
///
/// `None` means "not a head at all": no request line, a request line without its HTTP
/// version, or a header line without the colon that separates name from value. Each
/// of those used to be either a silent close or a header that vanished, and neither
/// tells a client what went wrong.
fn parse_request_head(bytes: &[u8]) -> Option<RequestHead> {
    // Lossy on purpose: a header value with a stray byte must not become a silent
    // "no request" when it can only ever cost one rejected field.
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.split('\n').map(strip_carriage_return);
    let request_line = lines.next()?;

    let mut parts = request_line.split(' ');
    let method = parts.next()?;
    // The path is not read: this listener has exactly one, and a request for a
    // different one is not a handshake either.
    parts.next()?;
    // The version *is* checked: without it `this is not http` would parse as a method
    // and a path and reach the upgrade as if it were a request.
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }

    let mut headers = Headers::default();
    for line in lines {
        // The blank line that ends the head is part of the slice, so the loop stops
        // there instead of tripping over an empty line.
        if line.is_empty() {
            break;
        }
        // A malformed header line makes the whole head unusable: `upgrade_socket`
        // decides on `Upgrade`, `Sec-WebSocket-Key` and `Connection`, and a head it
        // cannot read is one it must not accept.
        let (name, value) = line.split_once(':')?;
        headers.push(name, value);
    }

    Some(RequestHead {
        method: method.to_string(),
        headers,
    })
}

fn strip_carriage_return(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

#[cfg(test)]
// The case names are the schema `function_withCondition_shouldOutcome`, which is what
// a red test has to say; `tests/*.rs` allow the same style at file level.
#[allow(non_snake_case)]
mod tests {
    use super::*;

    /// The reader is exercised through `tests/head.rs`; these two cases exist because
    /// the functions that decide them are private, and the fastest place to pin a
    /// private function is next to it.
    #[test]
    fn find_head_end_withACrlfTerminator_shouldReturnTheOffsetBehindIt() {
        // GIVEN a head that ends with the blank line a browser sends,
        let buffer = b"GET / HTTP/1.1\r\nHost: x\r\n\r\nleft over";

        // WHEN we look for the end of the head,
        let end = find_head_end(buffer).expect("the head is terminated");

        // THEN the offset points at the first byte behind the blank line:
        assert_eq!(&buffer[end..], b"left over");
    }

    #[test]
    fn find_head_end_withAnLfOnlyTerminator_shouldReturnTheOffsetBehindIt() {
        // GIVEN a head that uses bare LF line endings,
        let buffer = b"GET / HTTP/1.1\nHost: x\n\n";

        // WHEN we look for the end of the head,
        // THEN it is found at the very end of the buffer:
        assert_eq!(find_head_end(buffer), Some(buffer.len()));
    }
}
