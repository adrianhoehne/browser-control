/**
 * MCP over HTTP: the bridge's second surface, `POST /mcp` on loopback.
 *
 * The transport does exactly three things — route, check the bearer token, hand
 * one JSON-RPC text to the seam stdio already uses. It owns no tool logic: a
 * second copy of the tool table would be a second contract to keep in sync, and
 * the first one is already pinned by tests.
 *
 * `toolSet` is an object with `handleMessageText`, already bound to whatever it
 * needs (hub, log). Keeping the hub out of this module is what makes the
 * transport testable with a stub and what keeps the number of ways into the
 * extension at one.
 *
 * Bodies and headers never reach the log: an `Authorization` header is a
 * secret, and a body can carry whatever the operator was reading.
 */
import { createServer } from "node:http";

import { verifyToken } from "./hub.mjs";

const MCP_PATH = "/mcp";

// The one status this module decides itself, and only when the tool layer throws
// instead of answering. It is also the value the catch below logs: stderr is
// journald, and journald is forever.
const INTERNAL_ERROR_STATUS = 500;

// One number, and deliberately not the extension's message limit. A request is
// one call — a tool name, a few arguments — while a response can be a picture of
// several megabytes. Tying the two together would let a 5 MiB socket limit turn
// into a 5 MiB request body nobody asked for. So: an oversized HTTP body answers
// 413, an oversized stdio line answers -32700 — transport failures and protocol
// failures are different layers and say so differently.
const MAX_BODY_BYTES = 1048576;

/**
 * Starts the HTTP endpoint and resolves once it is bound.
 *
 * `port: 0` is allowed and useful: it is how a test learns the address the
 * kernel actually picked instead of guessing one. The returned `port` and
 * `host` are read back from `server.address()` for the same reason.
 *
 * Binding is loopback-only by default. This endpoint steers the operator's
 * browser; it belongs on 127.0.0.1 and nowhere else.
 */
export async function startHttpTransport({ port, token, toolSet, log, host = "127.0.0.1" }) {
  const server = createServer((request, response) => {
    // One broken client is one broken client. Nothing a single request does may
    // end the service that the extension socket lives in.
    //
    // The log gets the status, never `error.message`: an exception thrown while
    // handling a body can quote that body — `JSON.parse` failures carry a
    // fragment of their input — and a body is whatever the operator was reading.
    handleRequest({ request, response, token, toolSet, log }).catch(() => {
      log(`http request failed, answering ${INTERNAL_ERROR_STATUS}`);
      reject({ request, response, status: INTERNAL_ERROR_STATUS });
    });
  });

  await listenOn(server, { host, port });

  const address = server.address();
  return {
    port: address.port,
    host: address.address,
    close: () => closeServer(server),
  };
}

/**
 * The routing order is fixed and deliberate: path, method, token, body.
 *
 * Token last-but-one means an unauthenticated caller learns nothing about the
 * endpoint beyond its existence — no tool data, no reason for the rejection.
 */
async function handleRequest({ request, response, token, toolSet, log }) {
  // A destroyed socket can still emit `error` on the response; without a
  // handler that is an uncaught event and kills the process.
  response.on("error", () => {});

  if (pathOf(request.url) !== MCP_PATH) {
    reject({ request, response, status: 404 });
    return;
  }

  if (request.method !== "POST") {
    // No server-initiated stream, so `GET` is not a lesser request, it is the
    // wrong one — and `Allow` says which one would have worked.
    reject({ request, response, status: 405, headers: { Allow: "POST" } });
    return;
  }

  if (!hasValidBearerToken(request.headers.authorization, token)) {
    log("http auth failed");
    reject({ request, response, status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    return;
  }

  // Read before the first `data` event: a client that announces an oversized
  // body is refused without a single byte of it being buffered.
  if (declaresOversizedBody(request)) {
    reject({ request, response, status: 413 });
    return;
  }

  const body = await readBody(request);
  if (body === null) {
    reject({ request, response, status: 413 });
    return;
  }
  if (body === ABORTED) {
    // The client gave up mid-body. There is nobody left to answer, and inventing
    // a status would only add a line to the log.
    return;
  }

  const message = await toolSet.handleMessageText(body);
  if (message === null) {
    // A notification: JSON-RPC forbids a response, HTTP still wants an end.
    respondEmpty(response, 202);
    return;
  }

  respondJson(response, 200, message);
}

const ABORTED = Symbol("client aborted the body");

/**
 * Answers a request that will not be served.
 *
 * The status and `Connection: close`, nothing else: no reason line, no tool
 * data. Closing is the point — a local process could otherwise hold a
 * connection with a body that trickles in forever just under the limit.
 */
function reject({ request, response, status, headers = {} }) {
  if (response.headersSent || response.destroyed) return;

  response.writeHead(status, { ...headers, Connection: "close", "Content-Length": 0 });
  response.end();

  // Tear the socket down only once the reply has been flushed: destroying
  // earlier would race the client's read of the very status it is owed.
  response.once("finish", () => request.destroy());
}

function respondJson(response, status, message) {
  const body = JSON.stringify(message);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function respondEmpty(response, status) {
  response.writeHead(status, { "Content-Length": 0 });
  response.end();
}

/**
 * Whether the declared `Content-Length` is already over the limit.
 *
 * A `Transfer-Encoding: chunked` request has no such header; that case is
 * caught while streaming instead.
 */
function declaresOversizedBody(request) {
  const declaredBytes = Number(request.headers["content-length"]);
  return Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES;
}

/**
 * Collects the body, or `null` once it is larger than what may be parsed.
 *
 * Counting while streaming is what makes the limit fire on a chunked body:
 * there is no header to look at, and waiting for the last chunk would mean
 * buffering the payload the limit exists to refuse.
 */
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let receivedBytes = 0;

    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      // Stop reading: the socket is closed right after the 413, so there is
      // nothing left to drain and nothing left to spend memory on.
      request.pause();
      resolve(null);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(ABORTED));
    request.on("aborted", () => resolve(ABORTED));
  });
}

/**
 * Splits the path off the request target. `request.url` on a server is always
 * an origin-form target, so a plain split is enough; `new URL` would only add
 * a failure mode for targets it cannot parse.
 */
function pathOf(url) {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * `Authorization: Bearer <token>`, case-insensitive in the scheme as RFC 6750
 * says. Anything else — no header, another scheme, an empty token — fails the
 * same way, and the comparison itself is timing-safe via `verifyToken`.
 */
function hasValidBearerToken(headerValue, token) {
  if (typeof headerValue !== "string") return false;

  const separator = headerValue.indexOf(" ");
  if (separator === -1) return false;
  if (headerValue.slice(0, separator).toLowerCase() !== "bearer") return false;

  return verifyToken(token, headerValue.slice(separator + 1).trim());
}

function listenOn(server, { host, port }) {
  return new Promise((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.removeListener("error", rejectListen);
      resolve();
    });
  });
}

/**
 * Closes the listener and the connections it still holds.
 *
 * Idle keep-alive sockets would keep the promise pending until their own
 * timeout; this is the shutdown path, so they go now.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
