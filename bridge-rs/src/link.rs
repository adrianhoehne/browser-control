//! The socket glue of one accepted connection: handshake, then the hub's protocol
//! until either side ends it.
//!
//! Three pieces, and each has one owner: the reader half here, the writer half in a
//! task, and the hub in the middle. That split is not decoration — [`Transport`] is
//! synchronous (a disconnect must be reportable without an `await`) while a socket
//! write is not, so the connection queues its bytes and the writer task puts them on
//! the wire.
//!
//! It lives in the library, not in `main.rs`, because of what the last round got
//! wrong: a start path that only the binary can see is a start path no `tests/` case
//! can measure, and the two dead ends that cost the most (a `hello` swallowed because
//! nobody drained the handshake's leftover bytes, and a plain `curl` answered with the
//! wrong status) both live in exactly this code. `tests/head.rs` drives
//! [`serve_connection`] over an in-memory duplex pipe, which is a real wire as far as
//! this module is concerned.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::head::{self, Head};
use crate::hub::{ConnectionId, Hub, Outbound};
use crate::ws::{self, ConnectionEvent, Transport, WebSocketConnection};

/// One read from the socket per loop turn. Small enough that a `hello` is handed to
/// the codec promptly, large enough that a page-sized frame is not read byte by byte.
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// Serves one accepted connection from the first byte to the last.
///
/// `deadline` bounds the request head — it is the caller's `hello` timeout, see
/// [`head::read_request_head`]. The two halves are taken by value because their
/// owners differ: the reader stays in this task, the writer moves into the writer
/// task.
pub async fn serve_connection<R, W>(
    hub: Arc<Hub>,
    mut reader: R,
    writer: W,
    peer: String,
    deadline: Duration,
) where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    // The writer task exists before the first byte is written, because the answers to
    // a bad head go through the same queue as the frames do — one path to the socket
    // is one place where ordering and shutdown can go wrong.
    let (wire, wire_queue) = mpsc::unbounded_channel();
    tokio::spawn(write_frames(writer, wire_queue));
    let mut sink = SocketSink { wire };

    let (request, pending) = match head::read_request_head(&mut reader, deadline).await {
        Head::Upgrade { request, rest } => (request, rest),
        Head::PlainHttp => {
            // Not an upgrade but a working request: the peer gets the status that
            // says so, with the one sentence that explains it.
            answer(&mut sink, head::UPGRADE_REQUIRED);
            return;
        }
        Head::Broken => {
            answer(&mut sink, head::BAD_REQUEST);
            return;
        }
        // Nobody left to answer: the sender drops below and the writer shuts the
        // socket down.
        Head::Closed => return,
    };

    // A handshake that is not one has already been answered with `400` and ended by
    // `upgrade_socket`; the writer task flushes that answer and shuts down.
    let Some(mut connection) = ws::upgrade_socket(&request, sink, &pending) else {
        return;
    };

    let (outbound, mut hub_frames) = mpsc::unbounded_channel();
    let open = Arc::new(AtomicBool::new(true));
    let id = hub.handle_connection(outbound, Arc::clone(&open), peer);

    pump(&hub, id, &mut connection, &mut reader, &mut hub_frames).await;

    // Exactly one close for the hub, whichever way the loop ended: the transport is
    // over, so every pending request of this session fails and no timer survives.
    open.store(false, Ordering::SeqCst);
    let events = connection.transport_closed();
    deliver(&hub, id, events);
}

/// Reads from the socket and from the hub until one of them ends the connection.
async fn pump<R>(
    hub: &Arc<Hub>,
    id: ConnectionId,
    connection: &mut WebSocketConnection<SocketSink>,
    reader: &mut R,
    hub_frames: &mut mpsc::UnboundedReceiver<Outbound>,
) where
    R: AsyncRead + Unpin,
{
    // The bytes behind the head belong to this connection, and `receive` is the only
    // path that hands them to the hub — `transport_closed` is the other one, and it
    // runs when it is far too late. Without this call an extension that sends its
    // `hello` in the same packet as the upgrade and then says nothing waits for a
    // socket read that never comes, and the hello timer closes a healthy connection
    // with `4408`. `push(&[])` on the decoder is a no-op, so nothing else moves here.
    if !deliver(hub, id, connection.receive(&[])) {
        return;
    }

    let mut chunk = [0_u8; READ_CHUNK_BYTES];
    loop {
        tokio::select! {
            read = reader.read(&mut chunk) => match read {
                // A peer that vanished is normal operation for a browser extension,
                // and a read error is the same event one step later.
                Ok(0) | Err(_) => return,
                Ok(count) => {
                    if !deliver(hub, id, connection.receive(&chunk[..count])) {
                        return;
                    }
                }
            },
            frame = hub_frames.recv() => {
                let Some(frame) = frame else {
                    return;
                };
                match frame {
                    Outbound::Text(text) => {
                        // A frame the transport will not take is a socket that is
                        // already gone. Stopping here is what the template's
                        // rejection did: the hub must not believe a request went out
                        // when it did not, and the caller must not wait out the call
                        // timeout for an answer that can never come.
                        if !connection.send(&text) {
                            return;
                        }
                    }
                    Outbound::Close { code, reason } => {
                        connection.close(code, &reason);
                        // The hub asked for the end (4401, 4408, 4409 …). What it
                        // still has to say is for a connection that is gone, so the
                        // loop stops here and the close event below is ours.
                        return;
                    }
                }
            }
        }
    }
}

/// Answers a request that never became a connection: the bytes, then the end.
fn answer(sink: &mut SocketSink, bytes: &[u8]) {
    sink.write(bytes);
    sink.end();
}

/// Hands the connection's events to the hub. Returns `false` once a `Close` went
/// through — after that the connection is over and the caller stops reading.
fn deliver(hub: &Arc<Hub>, id: ConnectionId, events: Vec<ConnectionEvent>) -> bool {
    for event in events {
        match event {
            ConnectionEvent::Message(text) => hub.on_message(id, &text),
            ConnectionEvent::Close(info) => {
                hub.on_close(id, &info);
                return false;
            }
        }
    }
    true
}

/// What the connection queues for the writer task.
enum Wire {
    Bytes(Vec<u8>),
    /// `Transport::end`: the close frame is queued and nothing follows it.
    End,
}

/// The [`Transport`] under one connection.
///
/// Synchronous by contract, so it cannot write to the socket itself; it hands the
/// bytes to [`write_frames`]. A `true` from `write` means "queued", exactly as much
/// as the template's `socket.write` promised.
struct SocketSink {
    wire: mpsc::UnboundedSender<Wire>,
}

impl Transport for SocketSink {
    fn write(&mut self, bytes: &[u8]) -> bool {
        self.wire.send(Wire::Bytes(bytes.to_vec())).is_ok()
    }

    fn end(&mut self) {
        let _ = self.wire.send(Wire::End);
    }
}

/// Writes what the connection queued, in order, and shuts the socket down at `End`.
/// A failed write ends the task: the socket half is gone, and every further frame
/// would fail the same way.
async fn write_frames<W>(mut writer: W, mut wire: mpsc::UnboundedReceiver<Wire>)
where
    W: AsyncWrite + Unpin,
{
    while let Some(item) = wire.recv().await {
        let Wire::Bytes(bytes) = item else {
            break;
        };
        if writer.write_all(&bytes).await.is_err() {
            return;
        }
    }
    let _ = writer.shutdown().await;
}
