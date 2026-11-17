//! The WebSocket half of the bridge: handshake, frame codec, close handshake.
//!
//! The thirteen cases of `test/websocket.test.js` are here under their Node names.
//! They proved the behaviour against a real TCP peer; the port proves the same
//! behaviour one layer lower — through [`Transport`] and explicit `receive()` calls —
//! because the socket itself is only the hub's business (stage 2c). What the Node
//! suite needed a hand-written peer for is still hand-written here: a compliant
//! browser client never sends an unmasked frame, never fragments a message by hand
//! and never announces a megabyte it does not send.
//!
//! Every further case carries the `ws_` prefix, so the count of the thirteen —
//! `grep -cE '^test (acceptKey|encodeFrame|frameDecoder|upgradeSocket|websocket)_…'`
//! in the stage's proof — cannot grow a case that the Node suite never had.

// The case names are copied from the Node suite so the mapping stays readable;
// `docs/38`, `### What could go wrong` names the allow.
#![allow(non_snake_case)]

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use browser_control_bridge::protocol::{self, MAX_MESSAGE_BYTES};
use browser_control_bridge::ws::{
    accept_key, decode_close_payload, encode_close_payload, encode_frame, opcode, upgrade_socket,
    CloseInfo, ConnectionEvent, FrameDecoder, Headers, RequestHead, Transport,
    WebSocketConnection,
};

// RFC 6455 §1.3 example pair. The expected accept value is not hex, so it does not
// trip the "no secrets in the repo" grep either.
const RFC_SAMPLE_KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const RFC_SAMPLE_ACCEPT: &str = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

const CLIENT_MASK_KEY: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

/* ------------------------------------------------------------------ helpers */

/// One end of a connection: everything the connection writes, and whether it has
/// been closed. Shared by cloning, so the test keeps reading after the wrapper took
/// its own copy — the socket here is a buffer, not a network.
#[derive(Clone, Default)]
struct Wire(Rc<RefCell<WireState>>);

#[derive(Default)]
struct WireState {
    written: Vec<u8>,
    ended: bool,
}

impl Wire {
    fn new() -> Wire {
        Wire::default()
    }

    /// Takes the bytes written so far, so the next read starts at the next frame.
    fn take(&self) -> Vec<u8> {
        std::mem::take(&mut self.0.borrow_mut().written)
    }

    fn ended(&self) -> bool {
        self.0.borrow().ended
    }
}

impl Transport for Wire {
    fn write(&mut self, bytes: &[u8]) -> bool {
        self.0.borrow_mut().written.extend_from_slice(bytes);
        true
    }

    fn end(&mut self) {
        self.0.borrow_mut().ended = true;
    }
}

/// Builds a client frame. `masked: false` and `fin: false` exist precisely because
/// a compliant client would never produce them.
fn client_frame(opcode: u8, payload: &[u8], fin: bool, masked: bool) -> Vec<u8> {
    let first = if fin { 0x80 } else { 0x00 } | opcode;
    let mask_bit = if masked { 0x80 } else { 0x00 };
    let mut frame = Vec::new();

    let length = payload.len();
    if length < 126 {
        frame.push(first);
        frame.push(mask_bit | length as u8);
    } else if length < 0x10000 {
        frame.push(first);
        frame.push(mask_bit | 126);
        frame.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        frame.push(first);
        frame.push(mask_bit | 127);
        frame.extend_from_slice(&(length as u64).to_be_bytes());
    }

    if !masked {
        frame.extend_from_slice(payload);
        return frame;
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

/// The common case: one complete, masked frame.
fn masked_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    client_frame(opcode, payload, true, true)
}

struct ServerFrame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
}

/// Parses one server frame off the front of `bytes`, which has to hold a complete
/// one: a partial frame is a bug in the code under test, not a case to wait for.
fn take_server_frame(bytes: &mut Vec<u8>) -> ServerFrame {
    assert!(
        bytes.len() >= 2,
        "a server frame has at least a two-byte header"
    );
    let first = bytes[0];
    let second = bytes[1];
    assert_eq!(second & 0x80, 0, "server frames are never masked");

    let mut length = usize::from(second & 0x7f);
    let mut offset = 2;
    if length == 126 {
        assert!(bytes.len() >= 4, "16-bit length marker without its bytes");
        length = usize::from(u16::from_be_bytes([bytes[2], bytes[3]]));
        offset = 4;
    } else if length == 127 {
        assert!(bytes.len() >= 10, "64-bit length marker without its bytes");
        let mut declared = [0u8; 8];
        declared.copy_from_slice(&bytes[2..10]);
        length = u64::from_be_bytes(declared) as usize;
        offset = 10;
    }
    assert!(bytes.len() >= offset + length, "the frame is not complete");

    let payload = bytes[offset..offset + length].to_vec();
    bytes.drain(..offset + length);

    ServerFrame {
        fin: first & 0x80 != 0,
        opcode: first & 0x0f,
        payload,
    }
}

/// The status code of a close payload.
fn close_code(payload: &[u8]) -> u16 {
    assert!(
        payload.len() >= 2,
        "a close payload without a code has no status"
    );
    u16::from_be_bytes([payload[0], payload[1]])
}

struct HandshakeResponse {
    status_line: String,
    headers: Vec<(String, String)>,
}

impl HandshakeResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn has_header(&self, name: &str) -> bool {
        self.header(name).is_some()
    }
}

fn parse_response(raw: &str) -> HandshakeResponse {
    let mut lines = raw.split("\r\n");
    let status_line = lines.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    HandshakeResponse {
        status_line,
        headers,
    }
}

/// The five header lines a browser sends.
fn valid_handshake_lines() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Host", "127.0.0.1:8110"),
        ("Upgrade", "websocket"),
        ("Connection", "keep-alive, Upgrade"),
        ("Sec-WebSocket-Key", RFC_SAMPLE_KEY),
        ("Sec-WebSocket-Version", "13"),
    ]
}

/// Those lines with the names in `without` dropped and any number of lines added —
/// the shapes a "break exactly one check" case needs.
///
/// `without` is a list because dropping one line is not always enough to make a
/// header value the only source of a token: the mixed-case case has to remove the
/// original `Connection: keep-alive, Upgrade` as well, or the lower-case token it
/// means to test would still be found in the folded list and the case would pass
/// with the case-insensitive comparison removed.
fn handshake_headers(without: &[&str], added: &[(&str, &str)]) -> Headers {
    let pairs: Vec<(&str, &str)> = valid_handshake_lines()
        .into_iter()
        .filter(|(name, _)| {
            !without
                .iter()
                .any(|dropped| name.eq_ignore_ascii_case(dropped))
        })
        .chain(added.iter().copied())
        .collect();
    Headers::from_pairs(&pairs)
}

fn handshake_request(method: &str, headers: Headers) -> RequestHead {
    RequestHead {
        method: method.to_string(),
        headers,
    }
}

/// The handshake a browser sends, with extra offers appended.
fn browser_handshake(added: &[(&str, &str)]) -> RequestHead {
    handshake_request("GET", handshake_headers(&[], added))
}

/// An accepted connection plus the peer's end of the wire. The `101` is consumed:
/// every case below is about what happens after the handshake.
fn connect(head: &[u8]) -> (WebSocketConnection<Wire>, Wire) {
    let wire = Wire::new();
    let connection = upgrade_socket(&browser_handshake(&[]), wire.clone(), head)
        .expect("the sample handshake is a valid upgrade");
    wire.take();
    (connection, wire)
}

/* -------------------------------------------------------------- acceptKey */

#[test]
fn acceptKey_withRfcSampleKey_shouldReturnTheDocumentedAcceptValue() {
    // GIVEN the example key from RFC 6455 §1.3,
    // WHEN we compute the accept value,
    // THEN it must match the documented one — a wrong GUID or a hex digest instead
    // of Base64 fails every real browser handshake:
    assert_eq!(accept_key(RFC_SAMPLE_KEY), RFC_SAMPLE_ACCEPT);
}

/* ---------------------------------------------------------------- encodeFrame */

#[test]
fn encodeFrame_withPayloadOfExtendedLengths_shouldSetTheMatchingLengthMarker() {
    // GIVEN payloads in all three length classes,
    let small = encode_frame(opcode::TEXT, b"hallo");
    let medium = encode_frame(opcode::TEXT, &[0x61; 200]);
    let large = encode_frame(opcode::TEXT, &vec![0x61; 0x10000]);

    // WHEN we look at their headers,
    // THEN the markers and the total lengths must fit — the 64-bit path is the one
    // whose off-by-one nobody notices until a big message goes out:
    assert_eq!(small[0], 0x81);
    assert_eq!(small[1], 5);
    assert_eq!(small.len(), 7);

    assert_eq!(medium[1], 126);
    assert_eq!(u16::from_be_bytes([medium[2], medium[3]]), 200);
    assert_eq!(medium.len(), 204);

    assert_eq!(large[1], 127);
    assert_eq!(
        u64::from_be_bytes([
            large[2], large[3], large[4], large[5], large[6], large[7], large[8], large[9]
        ]),
        0x10000
    );
    assert_eq!(large.len(), 10 + 0x10000);
}

/* -------------------------------------------------------------- FrameDecoder */

#[test]
fn frameDecoder_pushWithDeclaredOversizedFrame_shouldThrowMessageTooBigBeforeBuffering() {
    // GIVEN a frame header that announces more than the limit,
    let mut header = vec![0x81, 0x80 | 127];
    header.extend_from_slice(&((MAX_MESSAGE_BYTES as u64) + 1).to_be_bytes());

    // WHEN the decoder sees only that header,
    // THEN it must refuse immediately instead of waiting for — and allocating — a
    // megabyte the peer may never send:
    let error = FrameDecoder::new()
        .push(&header)
        .expect_err("an oversized announcement was accepted");
    assert_eq!(error.code, protocol::close::MESSAGE_TOO_BIG);
}

#[test]
fn frameDecoder_pushWithContinuationWithoutStartedMessage_shouldThrowProtocolError() {
    // GIVEN a lone continuation frame,
    let frame = masked_frame(opcode::CONTINUATION, b"verwaist");

    // WHEN the decoder processes it,
    // THEN the message state is broken and the answer is a protocol error:
    let error = FrameDecoder::new()
        .push(&frame)
        .expect_err("a lone continuation was accepted");
    assert_eq!(error.code, protocol::close::PROTOCOL_ERROR);
}

/* ----------------------------------------------------------------- handshake */

#[test]
fn upgradeSocket_withSampleKey_shouldAnswer101AndNegotiateNothingElse() {
    // GIVEN a client that offers compression and a subprotocol,
    let wire = Wire::new();
    let request = browser_handshake(&[
        ("Sec-WebSocket-Extensions", "permessage-deflate"),
        ("Sec-WebSocket-Protocol", "chat"),
    ]);

    // WHEN the handshake completes,
    let connection = upgrade_socket(&request, wire.clone(), &[]);

    // THEN it must be a 101 with the right accept key and without either offer
    // echoed — accepting compression would break the frame parser silently:
    assert!(connection.is_some(), "the sample handshake was rejected");
    let raw = String::from_utf8(wire.take()).expect("the handshake response is ASCII");
    assert_eq!(
        raw,
        concat!(
            "HTTP/1.1 101 Switching Protocols\r\n",
            "Upgrade: websocket\r\n",
            "Connection: Upgrade\r\n",
            "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n",
            "\r\n",
        ),
        "the 101 is four header lines in that order, and nothing else"
    );

    let response = parse_response(&raw);
    assert_eq!(response.status_line, "HTTP/1.1 101 Switching Protocols");
    assert_eq!(
        response.header("upgrade").map(str::to_ascii_lowercase),
        Some("websocket".to_string())
    );
    assert_eq!(response.header("sec-websocket-accept"), Some(RFC_SAMPLE_ACCEPT));
    assert!(!response.has_header("sec-websocket-extensions"));
    assert!(!response.has_header("sec-websocket-protocol"));
}

/* --------------------------------------------------------------- messaging */

#[test]
fn websocket_onFragmentedTextFrames_shouldEmitOneJoinedMessage() {
    // GIVEN a connected client and a fresh connection,
    let (mut connection, _wire) = connect(&[]);

    // WHEN it sends one message as two frames (`fin=0`, then continuation `fin=1`),
    let mut events = connection.receive(&client_frame(opcode::TEXT, b"Hallo ", false, true));
    events.extend(connection.receive(&client_frame(opcode::CONTINUATION, b"Welt", true, true)));

    // THEN exactly one message with both halves arrives, in order:
    assert_eq!(
        events,
        vec![ConnectionEvent::Message("Hallo Welt".to_string())]
    );
}

#[test]
fn websocket_onFrameSplitAcrossTcpWrites_shouldStillEmitTheMessage() {
    // GIVEN a connected client,
    let (mut connection, _wire) = connect(&[]);
    let frame = masked_frame(opcode::TEXT, b"zerhackt");

    // WHEN a single frame arrives in two writes,
    let beforeTheRest = connection.receive(&frame[..3]);
    let afterTheRest = connection.receive(&frame[3..]);

    // THEN the decoder must buffer the head instead of giving up on it:
    assert!(beforeTheRest.is_empty());
    assert_eq!(
        afterTheRest,
        vec![ConnectionEvent::Message("zerhackt".to_string())]
    );
}

#[test]
fn websocket_onPingFrame_shouldAnswerWithPongCarryingTheSamePayload() {
    // GIVEN a connected client,
    let (mut connection, wire) = connect(&[]);

    // WHEN it pings,
    let events = connection.receive(&masked_frame(opcode::PING, b"lebenszeichen"));

    // THEN the answer is a pong with the identical payload:
    assert!(events.is_empty(), "a ping is not a message");
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::PONG);
    assert_eq!(frame.payload, b"lebenszeichen");
    assert!(frame.fin, "control frames are never fragmented");
}

#[test]
fn websocket_onCloseFrame_shouldEchoTheStatusCodeAndCloseTheConnection() {
    // GIVEN a connected client,
    let (mut connection, wire) = connect(&[]);

    // WHEN it closes the connection itself,
    let events = connection.receive(&masked_frame(
        opcode::CLOSE,
        &encode_close_payload(1001, "tschüss"),
    ));

    // THEN the bridge echoes the close frame and reports the peer's code, not one
    // of its own invention:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(close_code(&frame.payload), 1001);
    assert_eq!(
        events,
        vec![ConnectionEvent::Close(CloseInfo {
            code: 1001,
            reason: "tschüss".to_string(),
        })]
    );
    assert!(!connection.is_open());
    assert!(wire.ended(), "the socket is closed after the echo");
}

/* --------------------------------------------------------------- violations */

#[test]
fn websocket_onUnmaskedFrame_shouldCloseWithProtocolErrorInsteadOfCrashing() {
    // GIVEN a connected client,
    let (mut connection, wire) = connect(&[]);

    // WHEN it sends an unmasked frame, which no browser ever does,
    let events = connection.receive(&client_frame(opcode::TEXT, b"unmaskiert", true, false));

    // THEN the bridge closes with 1002 and stays alive:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(close_code(&frame.payload), protocol::close::PROTOCOL_ERROR);
    assert_eq!(
        events,
        vec![ConnectionEvent::Close(CloseInfo {
            code: protocol::close::PROTOCOL_ERROR,
            reason: "client frame is not masked".to_string(),
        })]
    );
}

#[test]
fn websocket_onBinaryFrame_shouldCloseWithUnsupportedData() {
    // GIVEN a connected client,
    let (mut connection, wire) = connect(&[]);

    // WHEN it sends a binary frame,
    let events = connection.receive(&masked_frame(opcode::BINARY, &[0x00, 0x01, 0x02]));

    // THEN the answer is 1003: the link carries JSON text and nothing else:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(close_code(&frame.payload), protocol::close::UNSUPPORTED_DATA);
    assert_eq!(
        events,
        vec![ConnectionEvent::Close(CloseInfo {
            code: protocol::close::UNSUPPORTED_DATA,
            reason: "binary frames are not supported".to_string(),
        })]
    );
}

#[test]
fn websocket_onMessageLargerThanTheLimit_shouldCloseWithMessageTooBig() {
    // GIVEN a connected client and two halves just past the limit,
    let (mut connection, wire) = connect(&[]);
    // Derived from the limit, never spelled out: a literal copy of the old number
    // is what turned this case from red into *hanging* when the limit moved.
    let justPastTheLimit = MAX_MESSAGE_BYTES + 1024;
    let halfMessage = vec![0x61; justPastTheLimit.div_ceil(2)];

    // WHEN continuation frames push the message past that limit,
    let firstHalf = connection.receive(&client_frame(opcode::TEXT, &halfMessage, false, true));
    let secondHalf = connection.receive(&client_frame(
        opcode::CONTINUATION,
        &halfMessage,
        true,
        true,
    ));

    // THEN the accumulated size is refused with 1009 — the limit is checked per
    // message, not per frame, otherwise fragments would walk straight around it:
    assert!(firstHalf.is_empty());
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(close_code(&frame.payload), protocol::close::MESSAGE_TOO_BIG);
    assert_eq!(
        secondHalf,
        vec![ConnectionEvent::Close(CloseInfo {
            code: protocol::close::MESSAGE_TOO_BIG,
            reason: "message exceeds the message limit".to_string(),
        })]
    );
}

#[test]
fn websocket_onAMessageOfFourMebibytes_shouldEmitIt() {
    // GIVEN a connected client and a message far above the old 1 MiB limit,
    let (mut connection, _wire) = connect(&[]);
    // 4,2 MB is what a 3 MiB picture becomes once Base64 is done with it, so this
    // is the size the socket has to carry in the field — not a round number.
    let size = 4_200_000usize;
    let payload = vec![0x61; size];

    // WHEN it sends that message in one frame,
    let events = connection.receive(&masked_frame(opcode::TEXT, &payload));

    // THEN it arrives whole instead of being closed with 1009: 0x61 decodes to one
    // character, so the message length is the payload length:
    assert_eq!(events.len(), 1);
    match &events[0] {
        ConnectionEvent::Message(text) => assert_eq!(text.len(), size),
        other => panic!("expected one message, got {other:?}"),
    }
}

/* ------------------------------------------------- further cases (`ws_`) */

#[test]
fn ws_onReservedBits_shouldRejectBeforeTheLengthIsKnown() {
    // GIVEN a frame whose first two bytes already claim a reserved bit — the rest
    // of the header, including the 64-bit length, never arrives,
    let mut header = vec![0xc1, 0x80 | 127];
    header.truncate(2);

    // WHEN the decoder sees it,
    let error = FrameDecoder::new()
        .push(&header)
        .expect_err("reserved bits were accepted");

    // THEN the answer is a protocol error without waiting for a length field: a
    // peer that announces garbage must be refused even if it sends nothing more.
    assert_eq!(error.code, protocol::close::PROTOCOL_ERROR);
    assert_eq!(
        error.message,
        "reserved bits set without a negotiated extension"
    );
}

#[test]
fn ws_onUnknownOpcode_shouldRejectWithProtocolError() {
    // GIVEN a frame with opcode 3, which RFC 6455 leaves unassigned,
    let frame = masked_frame(0x3, b"unklar");

    // WHEN the decoder sees it,
    let error = FrameDecoder::new()
        .push(&frame)
        .expect_err("an unknown opcode was accepted");

    // THEN framing is broken and the connection has to go:
    assert_eq!(error.code, protocol::close::PROTOCOL_ERROR);
    assert_eq!(error.message, "unknown opcode 0x3");
}

#[test]
fn ws_onA64BitLengthOfTwoToThe63_shouldRejectWith1009() {
    // GIVEN a length field that a naive `as usize` would round to a small number,
    let mut header = vec![0x81, 0x80 | 127];
    header.extend_from_slice(&(1u64 << 63).to_be_bytes());

    // WHEN the decoder reads it,
    let error = FrameDecoder::new()
        .push(&header)
        .expect_err("2**63 bytes were accepted");

    // THEN the comparison happened before the conversion, so the limit still fires:
    assert_eq!(error.code, protocol::close::MESSAGE_TOO_BIG);
}

#[test]
fn ws_onAFragmentedControlFrame_shouldRejectWithProtocolError() {
    // GIVEN a ping with `fin=0`,
    let frame = client_frame(opcode::PING, b"halb", false, true);

    // WHEN the decoder sees it,
    let error = FrameDecoder::new()
        .push(&frame)
        .expect_err("a fragmented control frame was accepted");

    // THEN control frames may never be fragmented:
    assert_eq!(error.code, protocol::close::PROTOCOL_ERROR);
    assert_eq!(error.message, "control frame is fragmented");
}

#[test]
fn ws_onAControlFrameOf126Bytes_shouldRejectWithProtocolError() {
    // GIVEN a pong one byte over what a control frame may carry,
    let frame = masked_frame(opcode::PONG, &[0x61; 126]);

    // WHEN the decoder sees it,
    let error = FrameDecoder::new()
        .push(&frame)
        .expect_err("an oversized control frame was accepted");

    // THEN the 125-byte ceiling holds:
    assert_eq!(error.code, protocol::close::PROTOCOL_ERROR);
    assert_eq!(error.message, "control frame payload too long");
}

#[test]
fn ws_onATextFrameThatIsNotUtf8_shouldRejectWithProtocolError() {
    // GIVEN a text frame whose payload is not UTF-8,
    let frame = masked_frame(opcode::TEXT, &[0xff, 0xfe]);

    // WHEN the decoder sees it,
    let error = FrameDecoder::new()
        .push(&frame)
        .expect_err("an invalid text frame was accepted");

    // THEN the answer is 1002, not the RFC's own 1007: the bridge's close-code set
    // is closed by the spec (`docs/38`), and this is the port, not an improvement.
    assert_eq!(error.code, protocol::close::PROTOCOL_ERROR);
    assert_eq!(error.message, "text frame is not valid UTF-8");
}

#[test]
fn ws_onANewMessageWhileFragmentsArePending_shouldRejectWithProtocolError() {
    // GIVEN a fragmented message that was never finished,
    let mut decoder = FrameDecoder::new();
    decoder
        .push(&client_frame(opcode::TEXT, b"angefangen", false, true))
        .expect("the first fragment is legal");

    // WHEN a fresh text frame arrives instead of a continuation,
    let error = decoder
        .push(&masked_frame(opcode::TEXT, b"neuanfang"))
        .expect_err("a second message during fragmentation was accepted");

    // THEN the peer lost track and the connection goes:
    assert_eq!(error.code, protocol::close::PROTOCOL_ERROR);
    assert_eq!(
        error.message,
        "new message started before the fragmented one finished"
    );
}

#[test]
fn ws_onAnAnnouncedOversizedFrame_shouldCloseWith1009BeforeThePayloadArrives() {
    // GIVEN a connected client that announces one byte more than the limit,
    let (mut connection, wire) = connect(&[]);
    let mut header = vec![0x81, 0x80 | 127];
    header.extend_from_slice(&((MAX_MESSAGE_BYTES as u64) + 1).to_be_bytes());

    // WHEN only the ten header bytes arrive — the payload never does,
    let events = connection.receive(&header);

    // THEN the close frame is already on the wire, because the connection never
    // waited for a payload it would have had to buffer first:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(close_code(&frame.payload), protocol::close::MESSAGE_TOO_BIG);
    assert_eq!(
        events,
        vec![ConnectionEvent::Close(CloseInfo {
            code: protocol::close::MESSAGE_TOO_BIG,
            reason: "frame exceeds the message limit".to_string(),
        })]
    );
}

#[test]
fn ws_decodeClosePayload_withFewerThanTwoBytes_shouldReturnCode1005() {
    // GIVEN close payloads that carry no status code at all,
    // WHEN they are decoded,
    // THEN the answer is 1005 ("no status received"), which is a local value and
    // never goes on the wire:
    assert_eq!(
        decode_close_payload(&[]),
        CloseInfo {
            code: 1005,
            reason: String::new(),
        }
    );
    assert_eq!(
        decode_close_payload(&[0x03]),
        CloseInfo {
            code: 1005,
            reason: String::new(),
        }
    );
}

#[test]
fn ws_onEmptyCloseFrame_shouldReportNoStatusCodeAndEchoNothing() {
    // GIVEN a connected client,
    let (mut connection, wire) = connect(&[]);

    // WHEN it sends a close frame without a payload,
    let events = connection.receive(&masked_frame(opcode::CLOSE, &[]));

    // THEN the bridge echoes an equally empty payload and reports 1005 instead of
    // inventing a code the peer never sent:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert!(frame.payload.is_empty());
    assert_eq!(
        events,
        vec![ConnectionEvent::Close(CloseInfo {
            code: 1005,
            reason: String::new(),
        })]
    );
}

#[test]
fn ws_onCloseFrameWithASinglePayloadByte_shouldReportCode1005() {
    // GIVEN a connected client that closes with a payload of one byte — not a status
    // code, but not the empty payload either,
    let (mut connection, wire) = connect(&[]);

    // WHEN it arrives through `receive`, not through `decode_close_payload` directly:
    // the boundary between "no payload" and "one byte of payload" is a decoder
    // decision as much as a decoding one,
    let events = connection.receive(&masked_frame(opcode::CLOSE, &[0x03]));

    // THEN the connection reports 1005 and echoes the byte it was given. A code that
    // was never on the wire must not be invented, and a payload of one byte must not
    // be promoted to a well-formed close frame either:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(frame.payload, vec![0x03]);
    assert_eq!(
        events,
        vec![ConnectionEvent::Close(CloseInfo {
            code: 1005,
            reason: String::new(),
        })]
    );
}

#[test]
fn ws_onPingBetweenTwoFragments_shouldKeepTheFragmentState() {
    // GIVEN a connected client that has started a fragmented message,
    let (mut connection, wire) = connect(&[]);
    let beforeThePing = connection.receive(&client_frame(opcode::TEXT, b"Hallo ", false, true));

    // WHEN a ping arrives between the fragments, which a browser is free to do,
    let duringThePing = connection.receive(&masked_frame(opcode::PING, b"dazwischen"));
    let afterThePing = connection.receive(&client_frame(opcode::CONTINUATION, b"Welt", true, true));

    // THEN the control frame left the message state alone and the halves still join:
    assert!(beforeThePing.is_empty());
    assert!(duringThePing.is_empty(), "a ping is not a message");
    assert_eq!(
        afterThePing,
        vec![ConnectionEvent::Message("Hallo Welt".to_string())]
    );

    // and the ping was answered with its own payload, not with the fragments:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::PONG);
    assert_eq!(frame.payload, b"dazwischen");
}

#[test]
fn ws_onTwoFragmentRoundsInARow_shouldEmitBothMessages() {
    // GIVEN a connected client,
    let (mut connection, _wire) = connect(&[]);

    // WHEN it fragments two messages back to back, so the second round starts right
    // after the first one finished,
    let mut events = connection.receive(&client_frame(opcode::TEXT, b"ers", false, true));
    events.extend(connection.receive(&client_frame(opcode::CONTINUATION, b"ter", true, true)));
    events.extend(connection.receive(&client_frame(opcode::TEXT, b"zwei", false, true)));
    events.extend(connection.receive(&client_frame(opcode::CONTINUATION, b"ter", true, true)));

    // THEN both messages arrive whole and in order: the fragment state was cleared
    // at the first `fin` instead of being carried into the second round.
    assert_eq!(
        events,
        vec![
            ConnectionEvent::Message("erster".to_string()),
            ConnectionEvent::Message("zweiter".to_string()),
        ]
    );
}

#[test]
fn ws_onAFrameOfExactlyTheMessageLimit_shouldAcceptIt() {
    // GIVEN a connected client and a frame of exactly the allowed size — the check
    // is `>`, not `>=`, because the limit is the largest size that still fits,
    let (mut connection, _wire) = connect(&[]);
    let payload = vec![b'a'; MAX_MESSAGE_BYTES];

    // WHEN it arrives,
    let events = connection.receive(&masked_frame(opcode::TEXT, &payload));

    // THEN the message is delivered instead of being refused:
    assert_eq!(events.len(), 1);
    match &events[0] {
        ConnectionEvent::Message(text) => assert_eq!(text.len(), MAX_MESSAGE_BYTES),
        other => panic!("expected one message, got {other:?}"),
    }
}

#[test]
fn ws_onAFrameOneByteOverTheMessageLimit_shouldCloseWith1009() {
    // GIVEN a frame one byte wider than the limit,
    let (mut connection, wire) = connect(&[]);
    let payload = vec![b'a'; MAX_MESSAGE_BYTES + 1];

    // WHEN it arrives,
    let events = connection.receive(&masked_frame(opcode::TEXT, &payload));

    // THEN the answer is 1009. Without this pair, a `>` turned into a `>=` would stay
    // green: the case above is what makes the boundary visible.
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(close_code(&frame.payload), protocol::close::MESSAGE_TOO_BIG);
    assert_eq!(
        events,
        vec![ConnectionEvent::Close(CloseInfo {
            code: protocol::close::MESSAGE_TOO_BIG,
            reason: "frame exceeds the message limit".to_string(),
        })]
    );
}

#[test]
fn ws_onBytesThatCameWithTheHandshake_shouldNotBeLost() {
    // GIVEN a `hello` that arrived in the same packet as the handshake,
    let head = masked_frame(opcode::TEXT, b"im selben Paket");

    // WHEN the connection is created and asked for its events,
    let (mut connection, _wire) = connect(&head);
    let events = connection.receive(&[]);

    // THEN the bytes were not swallowed by the handshake: they are decoded on the
    // first `receive()`, which is this port's stand-in for the microtask that kept
    // the listener window open.
    assert_eq!(
        events,
        vec![ConnectionEvent::Message("im selben Paket".to_string())]
    );
}

#[test]
fn ws_onAHeadThatHoldsHalfAFrame_shouldJoinItWithTheFollowingBytes() {
    // GIVEN a head that ends in the middle of a frame,
    let frame = masked_frame(opcode::TEXT, b"angeschnitten");
    let (mut connection, _wire) = connect(&frame[..4]);

    // WHEN the rest arrives as an ordinary chunk,
    let events = connection.receive(&frame[4..]);

    // THEN the decoder carried the head over instead of resetting:
    assert_eq!(
        events,
        vec![ConnectionEvent::Message("angeschnitten".to_string())]
    );
}

#[test]
fn ws_headBytesThenImmediateClose_shouldStillEmitTheMessage() {
    // GIVEN a `hello` that arrived with the handshake and a socket that dies before
    // the caller ever asks for events,
    let head = masked_frame(opcode::TEXT, b"hello");
    let (mut connection, _wire) = connect(&head);

    // WHEN the transport closes,
    let events = connection.transport_closed();

    // THEN the message comes first and the close second — the order Node produced
    // when its microtask delivered the head and `socket.on("close")` fired after it.
    // A close that only reports `Close` loses the `hello` for good, because no later
    // `receive()` will come.
    assert_eq!(
        events,
        vec![
            ConnectionEvent::Message("hello".to_string()),
            ConnectionEvent::Close(CloseInfo {
                code: 1006,
                reason: "connection lost".to_string(),
            }),
        ]
    );
}

#[test]
fn ws_onTwoMessagesInOneChunk_shouldEmitBothInOrder() {
    // GIVEN two frames that arrive in one read,
    let mut chunk = masked_frame(opcode::TEXT, b"eins");
    chunk.extend(masked_frame(opcode::TEXT, b"zwei"));
    let (mut connection, _wire) = connect(&[]);

    // WHEN the decoder consumes the chunk,
    let events = connection.receive(&chunk);

    // THEN the loop over the buffer produced both, in the order they arrived:
    assert_eq!(
        events,
        vec![
            ConnectionEvent::Message("eins".to_string()),
            ConnectionEvent::Message("zwei".to_string()),
        ]
    );
}

#[test]
fn ws_onManyTinyFramesInOneChunk_shouldStayLinear() {
    // GIVEN one chunk of many minimal text frames — 200 000 of them, seven bytes
    // each, which is the shape a peer uses to make the decoder do the most work per
    // byte it sends,
    const FRAMES: usize = 200_000;
    let single = masked_frame(opcode::TEXT, b"a");
    let mut chunk = Vec::with_capacity(FRAMES * single.len());
    for _ in 0..FRAMES {
        chunk.extend_from_slice(&single);
    }
    let mut decoder = FrameDecoder::new();

    // WHEN the decoder consumes that chunk,
    let started = Instant::now();
    let events = decoder.push(&chunk).expect("the frames are legal");
    let elapsed = started.elapsed();

    // THEN every frame comes back, and the time stays linear in the chunk size.
    // Draining the consumed prefix per frame moved the rest of the buffer each time:
    // 3 MB of frames cost 66 s in release, and any local process may push that much
    // before `hello`. The budget is deliberately generous — this case guards the
    // complexity class, not a millisecond, and a busy machine must not turn it red.
    assert_eq!(events.len(), FRAMES);
    assert!(
        elapsed < Duration::from_secs(2),
        "200 000 frames took {elapsed:?}, which is no longer linear"
    );
}

#[test]
fn ws_onPongFrame_shouldEmitNoEventAndWriteNothing() {
    // GIVEN a connected client,
    let (mut connection, wire) = connect(&[]);

    // WHEN it sends an unsolicited pong,
    let events = connection.receive(&masked_frame(opcode::PONG, "spät".as_bytes()));

    // THEN it is ignored: the bridge never pings on its own, so nobody waits:
    assert!(events.is_empty());
    assert!(wire.take().is_empty());
}

#[test]
fn ws_withoutACloseFrame_shouldReportCode1006() {
    // GIVEN a connected client that simply disappears,
    let (mut connection, _wire) = connect(&[]);

    // WHEN the socket closes without a close frame,
    // THEN the code is 1006 — and only once:
    assert_eq!(
        connection.transport_closed(),
        vec![ConnectionEvent::Close(CloseInfo {
            code: 1006,
            reason: "connection lost".to_string(),
        })]
    );
    assert!(connection.transport_closed().is_empty());
}

#[test]
fn ws_afterASocketErrorWithoutACloseFrame_shouldReportTheSocketError() {
    // GIVEN a connected client whose socket fails mid-frame,
    let (mut connection, _wire) = connect(&[]);

    // WHEN the socket reports the error and then closes,
    connection.transport_failed();

    // THEN the reason is the socket's, still with 1006:
    assert_eq!(
        connection.transport_closed(),
        vec![ConnectionEvent::Close(CloseInfo {
            code: 1006,
            reason: "socket error".to_string(),
        })]
    );
}

#[test]
fn ws_afterThePeerClosed_shouldNotEmitASecondCloseEvent() {
    // GIVEN a connection the peer has already closed,
    let (mut connection, _wire) = connect(&[]);
    let events = connection.receive(&masked_frame(
        opcode::CLOSE,
        &encode_close_payload(1000, ""),
    ));
    assert_eq!(events.len(), 1);

    // WHEN the socket close follows,
    // THEN the `close` event is not repeated:
    assert!(connection.transport_closed().is_empty());
}

#[test]
fn ws_close_shouldTruncateTheReasonAtWhatAControlFrameCarries() {
    // GIVEN a reason far longer than a control frame may carry,
    let (mut connection, wire) = connect(&[]);
    let reason = "x".repeat(200);

    // WHEN we close with it,
    connection.close(1000, &reason);

    // THEN the payload is 125 bytes: two for the code, 123 for the reason:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(frame.payload.len(), 125);
    assert_eq!(close_code(&frame.payload), 1000);
    assert_eq!(&frame.payload[2..], &reason.as_bytes()[..123]);
}

#[test]
fn ws_sendAfterOurOwnClose_shouldReturnFalseAndReportOurCode() {
    // GIVEN a connected client,
    let (mut connection, wire) = connect(&[]);

    // WHEN we close from our side,
    connection.close(1000, "fertig");

    // THEN the frame carries our code, sending reports `false` instead of raising,
    // and the close event repeats our code rather than the peer's or 1006:
    let mut written = wire.take();
    let frame = take_server_frame(&mut written);
    assert_eq!(frame.opcode, opcode::CLOSE);
    assert_eq!(close_code(&frame.payload), 1000);
    assert!(wire.ended());
    assert!(!connection.is_open());
    assert!(!connection.send("zu spät"), "a closed connection wrote");
    assert!(!connection.ping(b""));
    assert_eq!(
        connection.transport_closed(),
        vec![ConnectionEvent::Close(CloseInfo {
            code: 1000,
            reason: "fertig".to_string(),
        })]
    );
}

#[test]
fn ws_withAnUpgradeHeaderInMixedCase_shouldAnswer101() {
    // GIVEN a handshake whose header values are cased differently — HTTP header
    // values are compared case-insensitively for both `Upgrade` and the
    // `Connection` token. Both original lines are dropped, so `UPGRADE` is the only
    // place a lower-case token could be found: fold in the original
    // `Connection: keep-alive, Upgrade` and this case would stay green with the
    // case-insensitive comparison deleted.
    let request = handshake_request(
        "GET",
        handshake_headers(
            &["Upgrade", "Connection"],
            &[
                ("Upgrade", "WebSocket"),
                ("Connection", "Keep-Alive, UPGRADE"),
            ],
        ),
    );
    let wire = Wire::new();

    // WHEN the upgrade runs,
    let connection = upgrade_socket(&request, wire.clone(), &[]);

    // THEN it is accepted:
    assert!(connection.is_some(), "the cased handshake was rejected");
}

#[test]
fn ws_withTwoConnectionLines_shouldJoinThemIntoOneHeaderList() {
    // GIVEN a request that repeats `Connection`, which HTTP allows,
    let request = handshake_request(
        "GET",
        handshake_headers(
            &["Connection"],
            &[("Connection", "keep-alive"), ("Connection", "Upgrade")],
        ),
    );
    let wire = Wire::new();

    // WHEN the upgrade runs,
    let connection = upgrade_socket(&request, wire.clone(), &[]);

    // THEN the repeated header arrived as one comma list and the token was found:
    assert!(
        connection.is_some(),
        "a repeated Connection header was not folded"
    );
}

#[test]
fn ws_withWhitespaceAroundHeaderValues_shouldAnswer101() {
    // GIVEN a handshake whose values carry the optional whitespace RFC 9110 §5.5
    // allows — Node's HTTP parser strips it, so `req.headers` never sees it,
    let request = handshake_request(
        "GET",
        handshake_headers(
            &["Upgrade", "Sec-WebSocket-Version", "Sec-WebSocket-Key"],
            &[
                ("Upgrade", "websocket "),
                ("Sec-WebSocket-Version", " 13"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ== "),
            ],
        ),
    );
    let wire = Wire::new();

    // WHEN the upgrade runs,
    let connection = upgrade_socket(&request, wire.clone(), &[]);

    // THEN it answers 101, as the template does. The accept key proves the trim went
    // in at the right place: padded bytes would change the digest:
    assert!(connection.is_some(), "a padded handshake was rejected");
    let raw = String::from_utf8(wire.take()).expect("the handshake response is ASCII");
    assert!(raw.starts_with("HTTP/1.1 101 Switching Protocols\r\n"));
    assert!(
        raw.contains(&format!("Sec-WebSocket-Accept: {RFC_SAMPLE_ACCEPT}\r\n")),
        "the accept key was computed over the untrimmed value"
    );
}

#[test]
fn ws_onAnInvalidHandshake_shouldAnswer400AndCloseTheSocket() {
    // GIVEN the seven ways a request can fail the check,
    let cases: Vec<(&str, RequestHead)> = vec![
        (
            "a POST instead of a GET",
            handshake_request("POST", handshake_headers(&[], &[])),
        ),
        (
            "no Sec-WebSocket-Key",
            handshake_request("GET", handshake_headers(&["Sec-WebSocket-Key"], &[])),
        ),
        (
            "an empty Sec-WebSocket-Key",
            handshake_request(
                "GET",
                handshake_headers(
                    &["Sec-WebSocket-Key"],
                    &[("Sec-WebSocket-Key", "")],
                ),
            ),
        ),
        (
            "no Sec-WebSocket-Version",
            handshake_request(
                "GET",
                handshake_headers(&["Sec-WebSocket-Version"], &[]),
            ),
        ),
        (
            "version 12",
            handshake_request(
                "GET",
                handshake_headers(
                    &["Sec-WebSocket-Version"],
                    &[("Sec-WebSocket-Version", "12")],
                ),
            ),
        ),
        (
            "a Connection header without the upgrade token",
            handshake_request(
                "GET",
                handshake_headers(&["Connection"], &[("Connection", "keep-alive")]),
            ),
        ),
        (
            "Upgrade: h2c",
            handshake_request(
                "GET",
                handshake_headers(&["Upgrade"], &[("Upgrade", "h2c")]),
            ),
        ),
    ];

    for (description, request) in cases {
        // WHEN the upgrade runs,
        let wire = Wire::new();
        let connection = upgrade_socket(&request, wire.clone(), &[]);

        // THEN there is no connection, the answer is a bare 400 and the socket is
        // closed instead of left hanging:
        assert!(connection.is_none(), "{description} was accepted");
        assert_eq!(
            String::from_utf8(wire.take()).expect("the rejection is ASCII"),
            "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            "{description}"
        );
        assert!(wire.ended(), "{description} left the socket open");
    }
}
