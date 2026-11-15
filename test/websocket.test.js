import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { PROTOCOL } from "../bridge/protocol.mjs";
import { FrameDecoder, OPCODE, ProtocolError, acceptKey, encodeFrame, upgradeSocket } from "../bridge/websocket.mjs";

// RFC 6455 §1.3 example pair. The expected accept value is not hex, so it does
// not trip the "no secrets in the repo" grep either.
const RFC_SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const RFC_SAMPLE_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

const CLIENT_MASK_KEY = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
// Without this, a decoder that never answers hangs the test run instead of
// failing it.
const SOCKET_TEST_OPTIONS = { timeout: 10_000 };

/* ------------------------------------------------------------------ helpers */

/**
 * Runs a real HTTP server whose upgrades go through `upgradeSocket`.
 *
 * A real socket is unavoidable here: the browser's WebSocket client always
 * masks, never fragments and never sends a frame the server must reject, so the
 * interesting cases only exist on a hand-written TCP peer.
 */
async function startServer(t) {
  const connections = [];
  const waiters = [];
  const sockets = new Set();
  const server = http.createServer();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const connection = upgradeSocket(req, socket, head);
    if (connection === null) return;
    connections.push(connection);
    for (const resolve of waiters.splice(0)) resolve(connection);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Destroying first and closing without the callback: `server.close()` waits
  // for upgraded sockets in ways that are hard to predict, and a teardown that
  // can hang is a test run that can hang.
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  return {
    port: server.address().port,
    /**
     * Returns the next accepted connection. Register the promise *before*
     * connecting — a waiter added after the upgrade would never fire.
     */
    nextConnection: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no upgrade within the timeout")), 5_000);
        waiters.push((connection) => {
          clearTimeout(timer);
          resolve(connection);
        });
      }),
  };
}

/** Reads server-to-client traffic: whole handshake responses and whole frames. */
function createWire(socket) {
  let buffer = Buffer.alloc(0);
  let ended = false;
  const wakeups = [];

  const wake = () => {
    for (const resolve of wakeups.splice(0)) resolve();
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake();
  });
  // Several tests end with the server closing the connection, so a reset here is
  // an expected outcome rather than a test failure.
  socket.on("error", () => {
    ended = true;
    wake();
  });
  socket.on("close", () => {
    ended = true;
    wake();
  });

  async function read(match) {
    for (;;) {
      const result = match(buffer);
      if (result !== null) {
        buffer = buffer.subarray(result.consumed);
        return result.value;
      }
      if (ended) throw new Error("socket ended before the expected bytes arrived");
      // No `await` between the failed match and the wakeup registration, so a
      // chunk cannot slip in unnoticed.
      await new Promise((resolve) => wakeups.push(resolve));
    }
  }

  return {
    readHandshakeResponse: () => read(matchHandshakeResponse),
    readFrame: () => read(matchServerFrame),
  };
}

function matchHandshakeResponse(buffer) {
  const end = buffer.indexOf("\r\n\r\n");
  if (end === -1) return null;

  const [statusLine, ...headerLines] = buffer.subarray(0, end).toString("latin1").split("\r\n");
  const headers = new Map();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return { consumed: end + 4, value: { statusLine, headers } };
}

/** Server frames are never masked, which keeps the parser short. */
function matchServerFrame(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;

  return {
    consumed: offset + length,
    value: { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload: Buffer.from(buffer.subarray(offset, offset + length)) },
  };
}

/**
 * Builds a client frame. `masked: false` and `fin: false` exist precisely
 * because a compliant client would never produce them.
 */
function clientFrame({ opcode, payload = Buffer.alloc(0), fin = true, masked = true, maskKey = CLIENT_MASK_KEY }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const maskBit = masked ? 0x80 : 0x00;

  let header;
  if (body.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, maskBit | body.length]);
  } else if (body.length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }

  if (!masked) return Buffer.concat([header, body]);

  const maskedBody = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) {
    maskedBody[index] = body[index] ^ maskKey[index & 0b11];
  }
  return Buffer.concat([header, maskKey, maskedBody]);
}

function closeFramePayload(code, reason = "") {
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

async function connectClient(t, port, { key = RFC_SAMPLE_KEY, extensions, protocol } = {}) {
  const socket = net.connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  const wire = createWire(socket);
  await once(socket, "connect");

  socket.write(
    [
      "GET /browser-control/ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: keep-alive, Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...(extensions === undefined ? [] : [`Sec-WebSocket-Extensions: ${extensions}`]),
      ...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
      "",
      "",
    ].join("\r\n"),
  );

  const response = await wire.readHandshakeResponse();
  return { socket, wire, response };
}

/* -------------------------------------------------------------- acceptKey */

test("acceptKey_withRfcSampleKey_shouldReturnTheDocumentedAcceptValue", () => {
  // GIVEN the example key from RFC 6455 §1.3,
  // WHEN we compute the accept value,
  // THEN it must match the documented one — a wrong GUID or a hex digest instead
  // of Base64 fails every real browser handshake:
  assert.equal(acceptKey(RFC_SAMPLE_KEY), RFC_SAMPLE_ACCEPT);
});

/* ---------------------------------------------------------------- encodeFrame */

test("encodeFrame_withPayloadOfExtendedLengths_shouldSetTheMatchingLengthMarker", () => {
  // GIVEN payloads in all three length classes,
  const small = encodeFrame(OPCODE.TEXT, "hallo");
  const medium = encodeFrame(OPCODE.TEXT, Buffer.alloc(200, 0x61));
  const large = encodeFrame(OPCODE.TEXT, Buffer.alloc(0x10000, 0x61));

  // WHEN we look at their headers,
  // THEN the markers and the total lengths must fit — the 64-bit path is the one
  // whose off-by-one nobody notices until a big message goes out:
  assert.equal(small[0], 0x81);
  assert.equal(small[1], 5);
  assert.equal(small.length, 7);

  assert.equal(medium[1], 126);
  assert.equal(medium.readUInt16BE(2), 200);
  assert.equal(medium.length, 204);

  assert.equal(large[1], 127);
  assert.equal(large.readBigUInt64BE(2), 0x10000n);
  assert.equal(large.length, 10 + 0x10000);
});

/* -------------------------------------------------------------- FrameDecoder */

test("frameDecoder_pushWithDeclaredOversizedFrame_shouldThrowMessageTooBigBeforeBuffering", () => {
  // GIVEN a frame header that announces more than the limit,
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(PROTOCOL.MAX_MESSAGE_BYTES + 1), 2);

  // WHEN the decoder sees only that header,
  // THEN it must refuse immediately instead of waiting for — and allocating —
  // a megabyte the peer may never send:
  assert.throws(
    () => new FrameDecoder().push(header),
    (error) => error instanceof ProtocolError && error.code === PROTOCOL.CLOSE.MESSAGE_TOO_BIG,
  );
});

test("frameDecoder_pushWithContinuationWithoutStartedMessage_shouldThrowProtocolError", () => {
  // GIVEN a lone continuation frame,
  const frame = clientFrame({ opcode: OPCODE.CONTINUATION, payload: "verwaist" });

  // WHEN the decoder processes it,
  // THEN the message state is broken and the answer is a protocol error:
  assert.throws(
    () => new FrameDecoder().push(frame),
    (error) => error instanceof ProtocolError && error.code === PROTOCOL.CLOSE.PROTOCOL_ERROR,
  );
});

/* ----------------------------------------------------------------- handshake */

test("upgradeSocket_withSampleKey_shouldAnswer101AndNegotiateNothingElse", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a client that offers compression and a subprotocol,
  const server = await startServer(t);
  const client = await connectClient(t, server.port, { extensions: "permessage-deflate", protocol: "chat" });

  // WHEN the handshake completes,
  // THEN it must be a 101 with the right accept key and without either offer
  // echoed — accepting compression would break the frame parser silently:
  assert.equal(client.response.statusLine, "HTTP/1.1 101 Switching Protocols");
  assert.equal(client.response.headers.get("upgrade").toLowerCase(), "websocket");
  assert.equal(client.response.headers.get("sec-websocket-accept"), RFC_SAMPLE_ACCEPT);
  assert.equal(client.response.headers.has("sec-websocket-extensions"), false);
  assert.equal(client.response.headers.has("sec-websocket-protocol"), false);
});

/* --------------------------------------------------------------- messaging */

test("websocket_onFragmentedTextFrames_shouldEmitOneJoinedMessage", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a connected client and a fresh connection,
  const server = await startServer(t);
  const connectionPromise = server.nextConnection();
  const client = await connectClient(t, server.port);
  const connection = await connectionPromise;

  const received = [];
  connection.on("message", (text) => received.push(text));
  const firstMessage = once(connection, "message");

  // WHEN it sends one message as two frames (`fin=0`, then continuation `fin=1`),
  client.socket.write(clientFrame({ opcode: OPCODE.TEXT, payload: "Hallo ", fin: false }));
  client.socket.write(clientFrame({ opcode: OPCODE.CONTINUATION, payload: "Welt", fin: true }));
  await firstMessage;
  await delay(20);

  // THEN exactly one message with both halves arrives, in order:
  assert.deepEqual(received, ["Hallo Welt"]);
});

test("websocket_onFrameSplitAcrossTcpWrites_shouldStillEmitTheMessage", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a connected client,
  const server = await startServer(t);
  const connectionPromise = server.nextConnection();
  const client = await connectClient(t, server.port);
  const connection = await connectionPromise;
  const message = once(connection, "message");

  // WHEN a single frame arrives in two TCP writes,
  const frame = clientFrame({ opcode: OPCODE.TEXT, payload: "zerhackt" });
  client.socket.write(frame.subarray(0, 3));
  await delay(20);
  client.socket.write(frame.subarray(3));

  // THEN the decoder must buffer the head instead of giving up on it:
  assert.deepEqual(await message, ["zerhackt"]);
});

test("websocket_onPingFrame_shouldAnswerWithPongCarryingTheSamePayload", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a connected client,
  const server = await startServer(t);
  const connectionPromise = server.nextConnection();
  const client = await connectClient(t, server.port);
  await connectionPromise;
  const pong = client.wire.readFrame();

  // WHEN it pings,
  client.socket.write(clientFrame({ opcode: OPCODE.PING, payload: "lebenszeichen" }));

  // THEN the answer is a pong with the identical payload:
  const frame = await pong;
  assert.equal(frame.opcode, OPCODE.PONG);
  assert.equal(frame.payload.toString("utf8"), "lebenszeichen");
});

test("websocket_onCloseFrame_shouldEchoTheStatusCodeAndCloseTheConnection", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a connected client,
  const server = await startServer(t);
  const connectionPromise = server.nextConnection();
  const client = await connectClient(t, server.port);
  const connection = await connectionPromise;
  const closeEcho = client.wire.readFrame();
  const closed = once(connection, "close");

  // WHEN it closes the connection itself,
  client.socket.write(clientFrame({ opcode: OPCODE.CLOSE, payload: closeFramePayload(1001, "tschüss") }));

  // THEN the bridge echoes the close frame and reports the peer's code, not one
  // of its own invention:
  const frame = await closeEcho;
  assert.equal(frame.opcode, OPCODE.CLOSE);
  assert.equal(frame.payload.readUInt16BE(0), 1001);
  assert.deepEqual((await closed)[0], { code: 1001, reason: "tschüss" });
});

/* --------------------------------------------------------------- violations */

test("websocket_onUnmaskedFrame_shouldCloseWithProtocolErrorInsteadOfCrashing", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a connected client,
  const server = await startServer(t);
  const connectionPromise = server.nextConnection();
  const client = await connectClient(t, server.port);
  const connection = await connectionPromise;
  const closeFrame = client.wire.readFrame();
  const closed = once(connection, "close");

  // WHEN it sends an unmasked frame, which no browser ever does,
  client.socket.write(clientFrame({ opcode: OPCODE.TEXT, payload: "unmaskiert", masked: false }));

  // THEN the bridge closes with 1002 and stays alive:
  const frame = await closeFrame;
  assert.equal(frame.opcode, OPCODE.CLOSE);
  assert.equal(frame.payload.readUInt16BE(0), PROTOCOL.CLOSE.PROTOCOL_ERROR);
  assert.equal((await closed)[0].code, PROTOCOL.CLOSE.PROTOCOL_ERROR);
});

test("websocket_onBinaryFrame_shouldCloseWithUnsupportedData", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a connected client,
  const server = await startServer(t);
  const connectionPromise = server.nextConnection();
  const client = await connectClient(t, server.port);
  const connection = await connectionPromise;
  const closeFrame = client.wire.readFrame();
  const closed = once(connection, "close");

  // WHEN it sends a binary frame,
  client.socket.write(clientFrame({ opcode: OPCODE.BINARY, payload: Buffer.from([0x00, 0x01, 0x02]) }));

  // THEN the answer is 1003: the link carries JSON text and nothing else:
  const frame = await closeFrame;
  assert.equal(frame.opcode, OPCODE.CLOSE);
  assert.equal(frame.payload.readUInt16BE(0), PROTOCOL.CLOSE.UNSUPPORTED_DATA);
  assert.equal((await closed)[0].code, PROTOCOL.CLOSE.UNSUPPORTED_DATA);
});

test("websocket_onMessageLargerThanTheLimit_shouldCloseWithMessageTooBig", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a connected client and one text frame just under the limit,
  const server = await startServer(t);
  const connectionPromise = server.nextConnection();
  const client = await connectClient(t, server.port);
  const connection = await connectionPromise;
  const closeFrame = client.wire.readFrame();
  const closed = once(connection, "close");
  // Derived from the limit, never spelled out: a literal copy of the old number
  // is what turned this case from red into *hanging* when the limit moved — it
  // stayed below the new limit, no 1009 ever came, and the socket guard ran out.
  const justPastTheLimit = PROTOCOL.MAX_MESSAGE_BYTES + 1024;
  const halfMessage = Buffer.alloc(Math.ceil(justPastTheLimit / 2), 0x61);

  // WHEN continuation frames push the message past that limit,
  client.socket.write(clientFrame({ opcode: OPCODE.TEXT, payload: halfMessage, fin: false }));
  client.socket.write(clientFrame({ opcode: OPCODE.CONTINUATION, payload: halfMessage, fin: true }));

  // THEN the accumulated size is refused with 1009 — the limit is checked per
  // message, not per frame, otherwise fragments would walk straight around it:
  const frame = await closeFrame;
  assert.equal(frame.opcode, OPCODE.CLOSE);
  assert.equal(frame.payload.readUInt16BE(0), PROTOCOL.CLOSE.MESSAGE_TOO_BIG);
  assert.equal((await closed)[0].code, PROTOCOL.CLOSE.MESSAGE_TOO_BIG);
});

test("websocket_onAMessageOfFourMebibytes_shouldEmitIt", SOCKET_TEST_OPTIONS, async (t) => {
  // GIVEN a connected client and a message far above the old 1 MiB limit,
  const server = await startServer(t);
  const connectionPromise = server.nextConnection();
  const client = await connectClient(t, server.port);
  const connection = await connectionPromise;
  const answered = once(connection, "message");
  // 4,2 MB is what a 3 MiB picture becomes once Base64 is done with it, so this
  // is the size the socket has to carry in the field — not a round number.
  const size = 4_200_000;
  const payload = Buffer.alloc(size, 0x61);

  // WHEN it sends that message in one frame,
  client.socket.write(clientFrame({ opcode: OPCODE.TEXT, payload }));

  // THEN it arrives whole instead of being closed with 1009: 0x61 decodes to
  // one character, so the message length is the payload length:
  const [message] = await answered;
  assert.equal(message.length, size);
});
