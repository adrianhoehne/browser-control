/**
 * Minimal RFC 6455 server side: handshake, frame codec, connection wrapper.
 *
 * The scope is deliberately narrow. This link carries JSON in text frames only,
 * so `permessage-deflate` is never negotiated, subprotocols do not exist and
 * binary payloads are refused. Everything outside that scope is answered with a
 * close code instead of being supported — a partially correct implementation of
 * a big RFC is still cheaper to reason about than a dependency, but only as long
 * as the supported surface stays this small.
 *
 * Only the server side is implemented because the only peer is the extension.
 * Consequently every incoming frame must be masked and every outgoing frame is
 * not.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { PROTOCOL } from "./protocol.mjs";

// RFC 6455 §1.3: the fixed GUID that turns the client key into the accept key.
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const FIRST_BYTE_FIN = 0x80;
const FIRST_BYTE_RESERVED = 0x70;
const SECOND_BYTE_MASKED = 0x80;
const PAYLOAD_LENGTH_EXTENDED_16 = 126;
const PAYLOAD_LENGTH_EXTENDED_64 = 127;
const MAX_CONTROL_PAYLOAD_BYTES = 125;
const MASK_KEY_BYTES = 4;
const CLOSE_CODE_BYTES = 2;

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

const DATA_OPCODES = new Set([OPCODE.CONTINUATION, OPCODE.TEXT, OPCODE.BINARY]);
const CONTROL_OPCODES = new Set([OPCODE.CLOSE, OPCODE.PING, OPCODE.PONG]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A wire violation that must be answered with a close frame instead of an
 * exception on the way to the caller. The `code` is one of `PROTOCOL.CLOSE`.
 */
export class ProtocolError extends Error {
  constructor(message, code = PROTOCOL.CLOSE.PROTOCOL_ERROR) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/**
 * Computes the `Sec-WebSocket-Accept` value for a client's `Sec-WebSocket-Key`.
 */
export function acceptKey(key) {
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}

/**
 * Encodes one unmasked server frame. Server frames are never fragmented: the
 * bridge sends whole messages, and one frame per message keeps the peer simple.
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  return Buffer.concat([encodeFrameHeader(opcode, body.length), body]);
}

function encodeFrameHeader(opcode, length) {
  if (length < PAYLOAD_LENGTH_EXTENDED_16) {
    return Buffer.from([FIRST_BYTE_FIN | opcode, length]);
  }
  if (length < 0x10000) {
    const header = Buffer.alloc(4);
    header[0] = FIRST_BYTE_FIN | opcode;
    header[1] = PAYLOAD_LENGTH_EXTENDED_16;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = FIRST_BYTE_FIN | opcode;
  header[1] = PAYLOAD_LENGTH_EXTENDED_64;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

/**
 * Turns a byte stream from the client into frames and reassembles messages.
 *
 * `push()` never throws for I/O reasons and never touches the socket: it returns
 * the completed events of that chunk and throws a `ProtocolError` for anything
 * the RFC forbids. Keeping it socket-free is what makes the piece testable
 * without a network, and it is where the message limit lives — a limit enforced by
 * the connection would still have let the decoder allocate the payload.
 */
export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  // Set once the first frame of a fragmented message arrived; the chunks are
  // joined only at `fin`, so a peer cannot split a message into arbitrary bookkeeping.
  #fragments = null;

  /**
   * Consumes one chunk and returns the events it completed. Partial frames stay
   * buffered until the rest arrives.
   *
   * Events: `{type:"message",data}` for a complete text message,
   * `{type:"ping"|"pong"|"close",payload}` for control frames.
   */
  push(chunk) {
    if (chunk.length > 0) {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
    }

    const events = [];
    for (;;) {
      const frame = this.#readFrame();
      if (frame === null) return events;
      const event = this.#handleFrame(frame);
      if (event !== null) events.push(event);
    }
  }

  #readFrame() {
    if (this.#buffer.length < 2) return null;

    const first = this.#buffer[0];
    const second = this.#buffer[1];
    const fin = (first & FIRST_BYTE_FIN) !== 0;
    const opcode = first & 0x0f;

    // Checked before the payload length is known, so a peer announcing garbage
    // is rejected even if it never sends the bytes it announced.
    if ((first & FIRST_BYTE_RESERVED) !== 0) {
      throw new ProtocolError("reserved bits set without a negotiated extension");
    }
    if (!DATA_OPCODES.has(opcode) && !CONTROL_OPCODES.has(opcode)) {
      throw new ProtocolError(`unknown opcode 0x${opcode.toString(16)}`);
    }
    if ((second & SECOND_BYTE_MASKED) === 0) {
      throw new ProtocolError("client frame is not masked");
    }

    const lengthState = this.#readPayloadLength(second);
    if (lengthState === null) return null;
    const { length, payloadOffset } = lengthState;

    if (CONTROL_OPCODES.has(opcode)) {
      if (!fin) throw new ProtocolError("control frame is fragmented");
      if (length > MAX_CONTROL_PAYLOAD_BYTES) throw new ProtocolError("control frame payload too long");
    }
    if (length > PROTOCOL.MAX_MESSAGE_BYTES) {
      throw new ProtocolError("frame exceeds the message limit", PROTOCOL.CLOSE.MESSAGE_TOO_BIG);
    }

    const frameEnd = payloadOffset + MASK_KEY_BYTES + length;
    if (this.#buffer.length < frameEnd) return null;

    const maskKey = this.#buffer.subarray(payloadOffset, payloadOffset + MASK_KEY_BYTES);
    const payload = unmask(this.#buffer, payloadOffset + MASK_KEY_BYTES, length, maskKey);
    this.#buffer = this.#buffer.subarray(frameEnd);

    return { fin, opcode, payload };
  }

  #readPayloadLength(second) {
    const marker = second & 0x7f;
    if (marker === PAYLOAD_LENGTH_EXTENDED_16) {
      if (this.#buffer.length < 4) return null;
      return { length: this.#buffer.readUInt16BE(2), payloadOffset: 4 };
    }
    if (marker === PAYLOAD_LENGTH_EXTENDED_64) {
      if (this.#buffer.length < 10) return null;
      const declared = this.#buffer.readBigUInt64BE(2);
      // Compare before `Number()`: the limit check on a rounded value would be
      // satisfied by a peer that claims 2**63 bytes.
      if (declared > BigInt(PROTOCOL.MAX_MESSAGE_BYTES)) {
        throw new ProtocolError("frame exceeds the message limit", PROTOCOL.CLOSE.MESSAGE_TOO_BIG);
      }
      return { length: Number(declared), payloadOffset: 10 };
    }
    return { length: marker, payloadOffset: 2 };
  }

  #handleFrame({ fin, opcode, payload }) {
    if (CONTROL_OPCODES.has(opcode)) {
      if (opcode === OPCODE.CLOSE) return { type: "close", payload };
      if (opcode === OPCODE.PING) return { type: "ping", payload };
      return { type: "pong", payload };
    }

    if (opcode === OPCODE.BINARY) {
      throw new ProtocolError("binary frames are not supported", PROTOCOL.CLOSE.UNSUPPORTED_DATA);
    }

    if (opcode === OPCODE.CONTINUATION) {
      if (this.#fragments === null) {
        throw new ProtocolError("continuation frame without a started message");
      }
      this.#fragments.chunks.push(payload);
      this.#fragments.length += payload.length;
      if (this.#fragments.length > PROTOCOL.MAX_MESSAGE_BYTES) {
        throw new ProtocolError("message exceeds the message limit", PROTOCOL.CLOSE.MESSAGE_TOO_BIG);
      }
      if (!fin) return null;
      const message = Buffer.concat(this.#fragments.chunks, this.#fragments.length);
      this.#fragments = null;
      return { type: "message", data: decodeText(message) };
    }

    // TEXT. A new message while fragments are pending means the peer lost track.
    if (this.#fragments !== null) {
      throw new ProtocolError("new message started before the fragmented one finished");
    }
    if (!fin) {
      this.#fragments = { chunks: [payload], length: payload.length };
      return null;
    }
    return { type: "message", data: decodeText(payload) };
  }
}

function unmask(buffer, start, length, maskKey) {
  const payload = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = buffer[start + index] ^ maskKey[index & 0b11];
  }
  return payload;
}

function decodeText(payload) {
  try {
    return utf8Decoder.decode(payload);
  } catch {
    // RFC 6455 has its own code for this (1007), but the bridge's close-code set
    // is closed by the spec; a broken text frame is a protocol error here.
    throw new ProtocolError("text frame is not valid UTF-8");
  }
}

function encodeClosePayload(code, reason) {
  const reasonBytes = Buffer.from(reason, "utf8").subarray(0, MAX_CONTROL_PAYLOAD_BYTES - CLOSE_CODE_BYTES);
  const payload = Buffer.alloc(CLOSE_CODE_BYTES + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, CLOSE_CODE_BYTES);
  return payload;
}

function decodeClosePayload(payload) {
  if (payload.length < CLOSE_CODE_BYTES) return { code: 1005, reason: "" };
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(CLOSE_CODE_BYTES).toString("utf8"),
  };
}

/**
 * One accepted WebSocket connection.
 *
 * Events: `message` (text string, one per reassembled message) and `close`
 * (`{code, reason}`, exactly once — the code is the peer's when the peer closed,
 * ours when we closed, and 1006 when the socket died without a close frame).
 */
export class WebSocketConnection extends EventEmitter {
  #socket;
  #decoder = new FrameDecoder();
  #open = true;
  #closeInfo = null;
  #closeEmitted = false;

  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.#socket = socket;

    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("error", () => {
      // A peer that vanishes mid-frame is normal operation for a browser
      // extension; crashing the bridge over it would be rude.
      this.#closeInfo ??= { code: 1006, reason: "socket error" };
    });
    socket.on("close", () => this.#emitClose());

    // Bytes that arrived together with the handshake are real frames. Handling
    // them from a microtask keeps the window open for the caller to attach
    // listeners right after `upgradeSocket()` returned.
    if (head.length > 0) {
      queueMicrotask(() => this.#receive(head));
    }
  }

  get isOpen() {
    return this.#open;
  }

  /**
   * Sends one text message. Returns false instead of throwing when the peer is
   * already gone: callers in the hub race with disconnects and should not have
   * to wrap every send.
   */
  send(text) {
    return this.#writeFrame(OPCODE.TEXT, Buffer.from(text, "utf8"));
  }

  ping(payload = Buffer.alloc(0)) {
    return this.#writeFrame(OPCODE.PING, payload);
  }

  close(code = 1000, reason = "") {
    if (!this.#open) return;
    this.#closeInfo = { code, reason };
    this.#shutdown(code, reason);
  }

  #receive(chunk) {
    let events;
    try {
      events = this.#decoder.push(chunk);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.#closeWithError(error);
      return;
    }
    for (const event of events) this.#handleEvent(event);
  }

  #closeWithError(error) {
    if (!this.#open) return;
    this.#closeInfo = { code: error.code, reason: error.message };
    this.#shutdown(error.code, error.message);
  }

  #handleEvent(event) {
    if (event.type === "message") {
      this.emit("message", event.data);
      return;
    }
    if (event.type === "ping") {
      this.#writeFrame(OPCODE.PONG, event.payload);
      return;
    }
    if (event.type === "close") {
      this.#echoClose(event.payload);
    }
    // Incoming pongs are ignored: the bridge never pings on its own, so there is
    // nobody waiting for an answer.
  }

  #echoClose(payload) {
    this.#closeInfo = decodeClosePayload(payload);
    // RFC 6455 §5.5.1 asks for the peer's status code back; echoing the whole
    // payload is the shortest way to do that.
    this.#open = false;
    this.#writeFrameRaw(OPCODE.CLOSE, payload);
    this.#socket.end();
  }

  #shutdown(code, reason) {
    this.#open = false;
    this.#writeFrameRaw(OPCODE.CLOSE, encodeClosePayload(code, reason));
    this.#socket.end();
  }

  #writeFrame(opcode, payload) {
    if (!this.#open) return false;
    return this.#writeFrameRaw(opcode, payload);
  }

  #writeFrameRaw(opcode, payload) {
    if (this.#socket.destroyed || !this.#socket.writable) return false;
    this.#socket.write(encodeFrame(opcode, payload));
    return true;
  }

  #emitClose() {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.#open = false;
    this.emit("close", this.#closeInfo ?? { code: 1006, reason: "connection lost" });
  }
}

/**
 * Completes the HTTP upgrade and returns the connection, or `null` when the
 * request is not a valid WebSocket handshake — in that case the socket has been
 * answered with 400 and closed.
 *
 * `Sec-WebSocket-Extensions` and `Sec-WebSocket-Protocol` are never echoed: no
 * compression, no subprotocol. A client that offers them is not rejected, it
 * simply does not get them, which is what RFC 6455 prescribes.
 */
export function upgradeSocket(req, socket, head = Buffer.alloc(0)) {
  const key = req.headers["sec-websocket-key"];
  if (!isWebSocketUpgrade(req, key)) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return null;
  }

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "",
      "",
    ].join("\r\n"),
  );

  return new WebSocketConnection(socket, head);
}

function isWebSocketUpgrade(req, key) {
  return (
    req.method === "GET" &&
    typeof key === "string" &&
    key.length > 0 &&
    (req.headers.upgrade ?? "").toLowerCase() === "websocket" &&
    req.headers["sec-websocket-version"] === "13" &&
    headerHasToken(req.headers.connection, "upgrade")
  );
}

function headerHasToken(value, token) {
  if (typeof value !== "string") return false;
  return value
    .split(",")
    .some((part) => part.trim().toLowerCase() === token);
}
