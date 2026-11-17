//! The frame codec of RFC 6455, server side: unmask, reassemble, refuse.
//!
//! Deliberately narrow, like the template: this link carries JSON in text frames,
//! so `permessage-deflate` is never negotiated, subprotocols do not exist and
//! binary payloads are refused. Everything outside that scope is answered with a
//! close code instead of being supported — a partially correct implementation of a
//! big RFC is still cheaper to reason about than a dependency, but only as long as
//! the supported surface stays this small.
//!
//! [`FrameDecoder`] never touches a socket: it takes bytes and returns whole
//! events, which is what makes it testable without a network. It is also where the
//! message limit lives — a limit enforced by the connection instead would already
//! have let the decoder allocate the announced payload.

use std::fmt;

use crate::protocol;

const FIRST_BYTE_FIN: u8 = 0x80;
const FIRST_BYTE_RESERVED: u8 = 0x70;
const SECOND_BYTE_MASKED: u8 = 0x80;
const PAYLOAD_LENGTH_EXTENDED_16: u8 = 126;
const PAYLOAD_LENGTH_EXTENDED_64: u8 = 127;
const MAX_CONTROL_PAYLOAD_BYTES: usize = 125;
const MASK_KEY_BYTES: usize = 4;
const CLOSE_CODE_BYTES: usize = 2;

/// RFC 6455 §7.1.5: no status code was present. Not a wire code — this is the
/// value the bridge reports locally when a close frame carried less than two bytes.
const NO_STATUS_CODE: u16 = 1005;

/// Frame opcodes.
///
/// Constants rather than an enum: an unknown opcode must be *rejected*, and an enum
/// would need a fallible conversion whose error is the rejection itself — one extra
/// translation step with nothing behind it.
pub mod opcode {
    pub const CONTINUATION: u8 = 0x0;
    pub const TEXT: u8 = 0x1;
    pub const BINARY: u8 = 0x2;
    pub const CLOSE: u8 = 0x8;
    pub const PING: u8 = 0x9;
    pub const PONG: u8 = 0xa;
}

/// A wire violation that must be answered with a close frame instead of an
/// exception on the way to the caller. `code` is one of `protocol::close`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: u16,
    pub message: String,
}

impl ProtocolError {
    /// A protocol error proper: the default code is `1002`.
    fn protocol(message: impl Into<String>) -> ProtocolError {
        ProtocolError {
            code: protocol::close::PROTOCOL_ERROR,
            message: message.into(),
        }
    }

    fn with_code(code: u16, message: impl Into<String>) -> ProtocolError {
        ProtocolError {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProtocolError {}

/// One completed frame event: a whole reassembled text message, or a control frame
/// with the payload the peer sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Message(String),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close(Vec<u8>),
}

/// What a close handshake said: the status code and its reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseInfo {
    pub code: u16,
    pub reason: String,
}

/// One frame, as far as the decoder is concerned. Not public: the caller works in
/// events, not frames.
struct Frame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
}

/// Turns a byte stream from the client into frames and reassembles messages.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    /// Read offset into `buffer`, so consuming a frame does not move the rest of
    /// it. Draining per frame was measured at 66 s for 3 MB of tiny frames against
    /// 0.6 s of the template, which `subarray` gets for free; since every local
    /// process may push 3 MB before `hello`, quadratic here is a self-inflicted
    /// stall. The buffer is compacted once per `push` instead.
    start: usize,
    /// Set once the first frame of a fragmented message arrived; the chunks are
    /// joined only at `fin`, so a peer cannot split a message into arbitrary
    /// bookkeeping.
    fragments: Option<Vec<u8>>,
}

impl FrameDecoder {
    pub fn new() -> FrameDecoder {
        FrameDecoder::default()
    }

    /// Consumes one chunk and returns the events it completed. Partial frames stay
    /// buffered until the rest arrives.
    ///
    /// A violation comes back as a [`ProtocolError`] and the events of that chunk
    /// are lost with it — the same thing the template's `throw` did, because a
    /// connection that is about to close has no use for them.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Event>, ProtocolError> {
        // Compacted here rather than after the loop: an error path returns early,
        // and a decoder that is about to be dropped should not still hold the
        // bytes of a frame it already consumed.
        self.compact();
        if !chunk.is_empty() {
            self.buffer.extend_from_slice(chunk);
        }

        let mut events = Vec::new();
        while let Some(frame) = self.read_frame()? {
            if let Some(event) = self.handle_frame(frame)? {
                events.push(event);
            }
        }
        Ok(events)
    }

    /// Drops the frames already consumed and resets the read offset.
    fn compact(&mut self) {
        if self.start > 0 {
            self.buffer.drain(..self.start);
            self.start = 0;
        }
    }

    /// Reads one frame off the front of the buffer, or `None` when it is not
    /// complete yet.
    fn read_frame(&mut self) -> Result<Option<Frame>, ProtocolError> {
        let available = &self.buffer[self.start..];
        if available.len() < 2 {
            return Ok(None);
        }

        let first = available[0];
        let second = available[1];
        let fin = first & FIRST_BYTE_FIN != 0;
        let opcode = first & 0x0f;

        // Checked before the payload length is known, so a peer announcing garbage
        // is rejected even if it never sends the bytes it announced.
        if first & FIRST_BYTE_RESERVED != 0 {
            return Err(ProtocolError::protocol(
                "reserved bits set without a negotiated extension",
            ));
        }
        if !is_data_opcode(opcode) && !is_control_opcode(opcode) {
            return Err(ProtocolError::protocol(format!(
                "unknown opcode 0x{opcode:x}"
            )));
        }
        if second & SECOND_BYTE_MASKED == 0 {
            return Err(ProtocolError::protocol("client frame is not masked"));
        }

        let Some((length, payload_offset)) = read_payload_length(available, second)? else {
            return Ok(None);
        };

        if is_control_opcode(opcode) {
            if !fin {
                return Err(ProtocolError::protocol("control frame is fragmented"));
            }
            if length > MAX_CONTROL_PAYLOAD_BYTES {
                return Err(ProtocolError::protocol(
                    "control frame payload too long",
                ));
            }
        }
        // The 64-bit class was measured against the limit before its conversion;
        // this keeps the invariant local for the short classes, whose marker cannot
        // reach the limit at all.
        if length > protocol::MAX_MESSAGE_BYTES {
            return Err(ProtocolError::with_code(
                protocol::close::MESSAGE_TOO_BIG,
                "frame exceeds the message limit",
            ));
        }

        let payload_start = payload_offset + MASK_KEY_BYTES;
        let frame_end = payload_start + length;
        if available.len() < frame_end {
            return Ok(None);
        }

        let mask_key = [
            available[payload_offset],
            available[payload_offset + 1],
            available[payload_offset + 2],
            available[payload_offset + 3],
        ];
        let payload = available[payload_start..frame_end]
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask_key[index & 0b11])
            .collect();
        // The bytes stay where they are; only the offset moves. `compact()` in
        // `push` is the one place that reclaims them.
        self.start += frame_end;

        Ok(Some(Frame {
            fin,
            opcode,
            payload,
        }))
    }

    fn handle_frame(&mut self, frame: Frame) -> Result<Option<Event>, ProtocolError> {
        if is_control_opcode(frame.opcode) {
            return Ok(Some(match frame.opcode {
                opcode::CLOSE => Event::Close(frame.payload),
                opcode::PING => Event::Ping(frame.payload),
                _ => Event::Pong(frame.payload),
            }));
        }

        if frame.opcode == opcode::BINARY {
            return Err(ProtocolError::with_code(
                protocol::close::UNSUPPORTED_DATA,
                "binary frames are not supported",
            ));
        }

        if frame.opcode == opcode::CONTINUATION {
            // Eager, because a violation kills the decoder: the connection answers
            // it with a close frame and never asks for another event.
            let Some(mut message) = self.fragments.take() else {
                return Err(ProtocolError::protocol(
                    "continuation frame without a started message",
                ));
            };
            message.extend_from_slice(&frame.payload);
            if message.len() > protocol::MAX_MESSAGE_BYTES {
                return Err(ProtocolError::with_code(
                    protocol::close::MESSAGE_TOO_BIG,
                    "message exceeds the message limit",
                ));
            }
            if !frame.fin {
                self.fragments = Some(message);
                return Ok(None);
            }
            return Ok(Some(Event::Message(decode_text(&message)?)));
        }

        // TEXT. A new message while fragments are pending means the peer lost track.
        if self.fragments.is_some() {
            return Err(ProtocolError::protocol(
                "new message started before the fragmented one finished",
            ));
        }
        if !frame.fin {
            self.fragments = Some(frame.payload);
            return Ok(None);
        }
        Ok(Some(Event::Message(decode_text(&frame.payload)?)))
    }
}

/// The payload length and where the mask key starts, or `None` when the length
/// field itself is not complete yet. `available` starts at the first byte of the
/// frame, not at the start of the buffer.
fn read_payload_length(
    available: &[u8],
    second: u8,
) -> Result<Option<(usize, usize)>, ProtocolError> {
    let marker = second & 0x7f;
    if marker == PAYLOAD_LENGTH_EXTENDED_16 {
        if available.len() < 4 {
            return Ok(None);
        }
        let length = u16::from_be_bytes([available[2], available[3]]);
        return Ok(Some((usize::from(length), 4)));
    }
    if marker == PAYLOAD_LENGTH_EXTENDED_64 {
        if available.len() < 10 {
            return Ok(None);
        }
        let mut declared = [0u8; 8];
        declared.copy_from_slice(&available[2..10]);
        let declared = u64::from_be_bytes(declared);
        // Compare before the conversion to `usize`: the limit check on a
        // rounded value would be satisfied by a peer that claims 2**63 bytes.
        if declared > protocol::MAX_MESSAGE_BYTES as u64 {
            return Err(ProtocolError::with_code(
                protocol::close::MESSAGE_TOO_BIG,
                "frame exceeds the message limit",
            ));
        }
        return Ok(Some((declared as usize, 10)));
    }
    Ok(Some((usize::from(marker), 2)))
}

fn is_data_opcode(opcode: u8) -> bool {
    matches!(
        opcode,
        opcode::CONTINUATION | opcode::TEXT | opcode::BINARY
    )
}

fn is_control_opcode(opcode: u8) -> bool {
    matches!(opcode, opcode::CLOSE | opcode::PING | opcode::PONG)
}

fn decode_text(payload: &[u8]) -> Result<String, ProtocolError> {
    // Validate first, copy once: `String::from_utf8(payload.to_vec())` allocates and
    // copies the frame before it looks at it, which for a 5 MiB message is a
    // megabyte-scale copy of bytes that may turn out to be garbage.
    std::str::from_utf8(payload).map(str::to_owned).map_err(|_| {
        // RFC 6455 has its own code for this (1007), but the bridge's close-code set
        // is closed by the spec; a broken text frame is a protocol error here.
        ProtocolError::protocol("text frame is not valid UTF-8")
    })
}

/// Encodes one unmasked server frame. Server frames are never fragmented: the
/// bridge sends whole messages, and one frame per message keeps the peer simple.
pub fn encode_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = encode_frame_header(opcode, payload.len());
    frame.extend_from_slice(payload);
    frame
}

fn encode_frame_header(opcode: u8, length: usize) -> Vec<u8> {
    if length < usize::from(PAYLOAD_LENGTH_EXTENDED_16) {
        return vec![FIRST_BYTE_FIN | opcode, length as u8];
    }
    if length < 0x10000 {
        let mut header = vec![FIRST_BYTE_FIN | opcode, PAYLOAD_LENGTH_EXTENDED_16];
        header.extend_from_slice(&(length as u16).to_be_bytes());
        return header;
    }
    let mut header = vec![FIRST_BYTE_FIN | opcode, PAYLOAD_LENGTH_EXTENDED_64];
    header.extend_from_slice(&(length as u64).to_be_bytes());
    header
}

/// Status code and reason as a close payload, with the reason cut to what a control
/// frame may carry: 125 bytes total, two of which are the code.
///
/// The cut is by bytes, exactly like the template — a reason that loses half a
/// UTF-8 sequence is the peer's decoding problem, not a reason to send 127 bytes.
pub fn encode_close_payload(code: u16, reason: &str) -> Vec<u8> {
    let reason_bytes = reason.as_bytes();
    let limit = MAX_CONTROL_PAYLOAD_BYTES - CLOSE_CODE_BYTES;
    let kept = &reason_bytes[..reason_bytes.len().min(limit)];

    let mut payload = Vec::with_capacity(CLOSE_CODE_BYTES + kept.len());
    payload.extend_from_slice(&code.to_be_bytes());
    payload.extend_from_slice(kept);
    payload
}

/// The close payload read back. Fewer than two bytes is not a code but the absence
/// of one, which `1005` expresses.
pub fn decode_close_payload(payload: &[u8]) -> CloseInfo {
    if payload.len() < CLOSE_CODE_BYTES {
        return CloseInfo {
            code: NO_STATUS_CODE,
            reason: String::new(),
        };
    }
    CloseInfo {
        code: u16::from_be_bytes([payload[0], payload[1]]),
        // Lossy, like the template's `toString("utf8")`: a peer's mangled reason
        // must not become a second error.
        reason: String::from_utf8_lossy(&payload[CLOSE_CODE_BYTES..]).into_owned(),
    }
}
