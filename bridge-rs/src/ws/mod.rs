//! The WebSocket side of the extension link: handshake, frame codec, connection.
//!
//! Only the server side exists, because the only peer is the extension:
//! consequently every incoming frame must be masked and every outgoing frame is
//! not. No WebSocket library is used, and the three reasons are `docs/38`
//! (`## Dev plan`, stage 2b):
//!
//! - the close codes are part of the contract (`4401`/`4408`/`4409`,
//!   `1002`/`1003`/`1009`), and a library owns its own;
//! - the message limit has to fire before the payload is buffered;
//! - the bytes that arrive together with the handshake belong into the codec, not
//!   into a library's leftover buffer.
//!
//! One difference in *when*, not in *what*: Node emitted `close` only from
//! `socket.on("close")`, so the frame it had queued was already flushed. Here the
//! `Close` event can come back from the same call that wrote the close frame, while
//! that frame may still sit in the transport's queue. Anything downstream (stage 2c)
//! that sees `Close` must therefore not assume the transport is drained yet.

pub mod frame;
pub mod handshake;

pub use frame::{
    decode_close_payload, encode_close_payload, encode_frame, opcode, CloseInfo, Event,
    FrameDecoder, ProtocolError,
};
pub use handshake::{accept_key, upgrade_socket, Headers, RequestHead};

/// RFC 6455 §7.1.5: the connection died without a close frame. Not a wire code;
/// this is what the bridge reports.
const ABNORMAL_CLOSURE: u16 = 1006;

/// The reason reported when the socket went away without a close frame and
/// without an error — the template's "connection lost".
const CONNECTION_LOST: &str = "connection lost";

/// The reason reported when the socket failed mid-frame.
const SOCKET_ERROR: &str = "socket error";

/// What the connection needs from the socket underneath it.
///
/// Node's `net.Socket` offered `write`, `end`, `writable` and `destroyed`; these
/// two methods are the whole of what the wrapper used. Keeping the trait this small
/// is what lets a caller — a test today, the hub's writer task in stage 2c — put
/// anything socket-shaped underneath without the wrapper knowing the difference.
pub trait Transport {
    /// Queues bytes for the peer. `false` when the socket is gone: a failed write is
    /// the one failure the wrapper reports instead of raising, because callers race
    /// with disconnects.
    fn write(&mut self, bytes: &[u8]) -> bool;

    /// Half-closes the socket: the close frame is already queued and nothing
    /// follows it.
    fn end(&mut self);
}

/// What a caller learns from an accepted connection. Node's `EventEmitter` emitted
/// `message` and `close`; these two variants are that pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionEvent {
    /// One whole text message.
    Message(String),
    /// The connection is over. Exactly once per connection: the code is the peer's
    /// when the peer closed, ours when we closed, and `1006` when the socket died
    /// without a close frame.
    Close(CloseInfo),
}

/// One accepted WebSocket connection.
///
/// The template pushed its events into an `EventEmitter`; here they are returned,
/// because a Rust caller has no listener to attach and no `close` event to wait
/// for. Everything else is the same: the decoder owns the frame state, the wrapper
/// owns the close handshake, and a violation is answered with a close frame on the
/// wire instead of a panic.
pub struct WebSocketConnection<T: Transport> {
    transport: T,
    decoder: FrameDecoder,
    open: bool,
    close_info: Option<CloseInfo>,
    close_emitted: bool,
    /// Bytes that arrived together with the handshake. Decoding them in `new()`
    /// would deliver messages before the caller has the connection in hand — the
    /// template deferred them to a microtask for exactly that reason. Rust has no
    /// listener window to keep open, so the equivalent is an explicit step: the
    /// first [`receive`](Self::receive) delivers them, or
    /// [`transport_closed`](Self::transport_closed) when the socket dies before the
    /// caller gets another chance. Nothing is lost meanwhile.
    pending_head: Vec<u8>,
}

impl<T: Transport> WebSocketConnection<T> {
    pub fn new(transport: T, head: &[u8]) -> WebSocketConnection<T> {
        WebSocketConnection {
            transport,
            decoder: FrameDecoder::new(),
            open: true,
            close_info: None,
            close_emitted: false,
            pending_head: head.to_vec(),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Sends one text message. `false` instead of an error when the peer is already
    /// gone: callers in the hub race with disconnects and should not have to wrap
    /// every send.
    pub fn send(&mut self, text: &str) -> bool {
        self.write_frame(opcode::TEXT, text.as_bytes())
    }

    pub fn ping(&mut self, payload: &[u8]) -> bool {
        self.write_frame(opcode::PING, payload)
    }

    /// Closes from our side: the close frame carries our code and reason, and the
    /// `close` event that follows reports them.
    pub fn close(&mut self, code: u16, reason: &str) {
        if !self.open {
            return;
        }
        self.close_info = Some(CloseInfo {
            code,
            reason: reason.to_string(),
        });
        self.shutdown(code, reason);
    }

    /// Feeds one chunk from the peer and returns the events it completed. The bytes
    /// that came with the handshake are delivered first, in order.
    pub fn receive(&mut self, chunk: &[u8]) -> Vec<ConnectionEvent> {
        let mut events = Vec::new();
        self.dispatch_pending_head(&mut events);
        self.dispatch(chunk, &mut events);
        events
    }

    /// The socket failed. A peer that vanishes mid-frame is normal operation for a
    /// browser extension, so this only records the reason; the `close` event comes
    /// from [`transport_closed`](Self::transport_closed), as it did in Node.
    pub fn transport_failed(&mut self) {
        self.close_info.get_or_insert_with(|| CloseInfo {
            code: ABNORMAL_CLOSURE,
            reason: SOCKET_ERROR.to_string(),
        });
    }

    /// The socket is gone: `end()` completed, the peer reset it, or it died. Emits
    /// the `close` event if it has not been emitted yet.
    ///
    /// The bytes that arrived with the handshake are decoded here first, because a
    /// socket that closes straight after the upgrade never gives the caller another
    /// chance to call [`receive`](Self::receive). A `hello` in the head plus an
    /// immediate disconnect is a race the extension can lose; reporting only `Close`
    /// would swallow the message the template delivered from its microtask.
    pub fn transport_closed(&mut self) -> Vec<ConnectionEvent> {
        let mut events = Vec::new();
        self.dispatch_pending_head(&mut events);
        if let Some(event) = self.emit_close_once() {
            events.push(event);
        }
        events
    }

    fn dispatch_pending_head(&mut self, events: &mut Vec<ConnectionEvent>) {
        if self.pending_head.is_empty() {
            return;
        }
        let head = std::mem::take(&mut self.pending_head);
        self.dispatch(&head, events);
    }

    fn dispatch(&mut self, chunk: &[u8], events: &mut Vec<ConnectionEvent>) {
        match self.decoder.push(chunk) {
            Ok(decoder_events) => {
                for decoder_event in decoder_events {
                    self.handle_event(decoder_event, events);
                }
            }
            Err(error) => self.close_with_error(&error, events),
        }
    }

    fn close_with_error(&mut self, error: &ProtocolError, events: &mut Vec<ConnectionEvent>) {
        if !self.open {
            return;
        }
        self.close_info = Some(CloseInfo {
            code: error.code,
            reason: error.message.clone(),
        });
        self.shutdown(error.code, &error.message);
        if let Some(event) = self.emit_close_once() {
            events.push(event);
        }
    }

    fn handle_event(&mut self, decoder_event: Event, events: &mut Vec<ConnectionEvent>) {
        match decoder_event {
            Event::Message(text) => events.push(ConnectionEvent::Message(text)),
            Event::Ping(payload) => {
                self.write_frame(opcode::PONG, &payload);
            }
            Event::Close(payload) => self.echo_close(&payload, events),
            // Incoming pongs are ignored: the bridge never pings on its own, so
            // there is nobody waiting for an answer.
            Event::Pong(_) => {}
        }
    }

    fn echo_close(&mut self, payload: &[u8], events: &mut Vec<ConnectionEvent>) {
        self.close_info = Some(decode_close_payload(payload));
        // RFC 6455 §5.5.1 asks for the peer's status code back; echoing the whole
        // payload is the shortest way to do that.
        self.open = false;
        self.write_frame_raw(opcode::CLOSE, payload);
        self.transport.end();
        if let Some(event) = self.emit_close_once() {
            events.push(event);
        }
    }

    fn shutdown(&mut self, code: u16, reason: &str) {
        self.open = false;
        self.write_frame_raw(opcode::CLOSE, &encode_close_payload(code, reason));
        self.transport.end();
    }

    fn write_frame(&mut self, opcode: u8, payload: &[u8]) -> bool {
        if !self.open {
            return false;
        }
        self.write_frame_raw(opcode, payload)
    }

    fn write_frame_raw(&mut self, opcode: u8, payload: &[u8]) -> bool {
        // Unconditional on purpose: the close frame of a shutdown is written after
        // `open` went false, and it is the one frame that must still go out.
        self.transport.write(&encode_frame(opcode, payload))
    }

    fn emit_close_once(&mut self) -> Option<ConnectionEvent> {
        if self.close_emitted {
            return None;
        }
        self.close_emitted = true;
        self.open = false;
        let info = self.close_info.clone().unwrap_or(CloseInfo {
            code: ABNORMAL_CLOSURE,
            reason: CONNECTION_LOST.to_string(),
        });
        Some(ConnectionEvent::Close(info))
    }
}
