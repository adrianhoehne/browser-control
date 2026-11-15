/**
 * MCP over HTTP: routing, token, body limit — the transport, not the tools.
 *
 * The tool set is a stub on purpose. What is under test is the wiring around
 * `handleMessageText`: which status a caller gets, in which order, and whether
 * the socket is closed again afterwards. The seam itself is pinned in
 * `test/mcp.test.js`.
 *
 * `port: 0` is not a convenience here: it is the only way to learn the address
 * the kernel picked, and the loopback case has to look at the real one.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { startHttpTransport } from "../bridge/http-transport.mjs";

// 32 hex characters, the shortest token the bridge accepts — generated per run,
// because a token committed to the repository is a token in every clone.
const TOKEN = randomBytes(16).toString("hex");
const WRONG_TOKEN = randomBytes(16).toString("hex");

// A trickling client that is never answered must fail its case instead of
// hanging the suite: no test here waits longer than this.
const SOCKET_TIMEOUT_MS = 2_000;

// The bound for a case whose failure mode is a hang — a request the transport
// never answers because the check under test is gone. It has to be enforced by
// the *request*, not only by the runner: a runner timeout marks the case red but
// leaves its socket and listener open, and the file then never exits.
const ANSWER_TIMEOUT_MS = 5_000;

// Backstop above `ANSWER_TIMEOUT_MS`: a case that ignores its own bound is still
// aborted by name instead of being left to the runner's global limit.
const CASE_TIMEOUT_MS = 10_000;

// Spelled out on purpose, not derived from `PROTOCOL.MAX_MESSAGE_BYTES`. The
// transport limit and the socket limit are two decisions now, and a derived value
// would silently follow the socket upward — turning every 413 case below into a
// test of a limit nobody meant to raise.
const MAX_BODY_BYTES = 1048576;

/**
 * Stands in for the real seam: records the text it was handed and answers in a
 * shape the test can recognise. `null` for a request without `id` mirrors the
 * real rule for notifications, so the 202 branch is exercised, not assumed.
 */
function createStubToolSet() {
  const receivedTexts = [];

  return {
    receivedTexts,
    async handleMessageText(text) {
      receivedTexts.push(text);
      const request = JSON.parse(text);
      if (!Object.hasOwn(request, "id")) return null;
      return { jsonrpc: "2.0", id: request.id, result: { tools: [] } };
    },
  };
}

/**
 * Runs a case against a freshly bound transport and closes it afterwards —
 * including when the case throws, because a listener left behind keeps the
 * test process alive long after the reporter printed its summary.
 *
 * `toolSet` is overridable: the status the transport answers when the tool layer
 * throws can only be reached with a tool set that throws.
 */
async function withTransport(run, { toolSet = createStubToolSet() } = {}) {
  const logLines = [];
  const transport = await startHttpTransport({
    port: 0,
    token: TOKEN,
    toolSet,
    log: (line) => logLines.push(line),
  });

  try {
    return await run({
      transport,
      toolSet,
      logLines,
      origin: `http://127.0.0.1:${transport.port}`,
    });
  } finally {
    await transport.close();
  }
}

/**
 * One HTTP request collected into `{status, headers, body}`.
 *
 * Deliberately not `fetch`: several cases here end with the server closing the
 * socket right after the status line, and a client that reports what arrived
 * beats one that throws `TypeError: fetch failed`.
 *
 * `timeoutMs` destroys the request when no answer comes, so a case that expects
 * one fails with a message instead of waiting for a reply that will never arrive.
 */
function requestOnce({ port, method = "POST", path = "/mcp", headers = {}, body = null, timeoutMs = 0 }) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const stopTimer = () => {
      if (timer !== null) clearTimeout(timer);
    };

    const request = http.request(
      { host: "127.0.0.1", port, method, path, headers },
      async (response) => {
        stopTimer();
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: await readResponseBody(response),
        });
      },
    );

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        request.destroy(new Error(`no answer on ${method} ${path} within ${timeoutMs} ms`));
      }, timeoutMs);
      // An unref'd timer cannot hold the file open by itself once the case failed.
      timer.unref();
    }

    request.on("error", (error) => {
      stopTimer();
      reject(error);
    });
    request.end(body === null ? undefined : body);
  });
}

/**
 * The response body as text, settled on `end` or on `close`.
 *
 * A rejection closes the connection, and the close can reach the client before
 * its `end` event does; both are the answer.
 */
function readResponseBody(response) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", settle);
    response.on("close", settle);
    response.on("error", settle);
  });
}

/**
 * Resolves when the socket closes, rejects when it does not — the difference is
 * the whole point of the case, so a timeout must not look like success.
 */
function waitForClose(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error(`the socket was still open after ${timeoutMs} ms`));
    }, timeoutMs);

    function onClose() {
      clearTimeout(timer);
      resolve();
    }

    socket.once("close", onClose);
  });
}

/**
 * Writes one chunk and waits for the socket to catch up when it has to.
 *
 * The wait also ends on `close` and on `error`: once the transport rejects the
 * body it closes the socket, and a loop that only knew `drain` would wait for an
 * event that never comes.
 */
function writeWithBackpressure(request, chunk) {
  if (request.write(chunk)) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      request.off("drain", done);
      request.off("close", done);
      request.off("error", done);
      resolve();
    };

    request.on("drain", done);
    request.on("close", done);
    request.on("error", done);
  });
}

/**
 * The first response to `request` — or a rejection that names what was missing.
 *
 * Waiting on `once("response")` alone is a trap: a transport that stops
 * checking the limit never answers, and one that rejects mid-upload can close
 * the socket before the response event is emitted. Either way an unbounded wait
 * outlives the case, and the runner reports a hanging file instead of a red
 * test — the worst of both outcomes.
 *
 * `onAnswered` runs synchronously inside the response event, so a caller can
 * freeze the state (bytes written so far) that is only meaningful right then.
 * `describeProgress` supplies the "what did happen" half of every message.
 */
function waitForResponse(
  request,
  {
    timeoutMs,
    expectation = "a response",
    onAnswered = () => {},
    describeProgress = () => "no progress recorded",
  },
) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("response", onResponse);
      request.off("error", onError);
      request.off("close", onClose);
      settle(value);
    };

    function onResponse(response) {
      onAnswered(response);
      finish(resolve, response);
    }

    function onError(error) {
      finish(reject, new Error(`no ${expectation} before the socket failed (${error.message}); ${describeProgress()}`));
    }

    function onClose() {
      finish(reject, new Error(`no ${expectation} before the socket closed; ${describeProgress()}`));
    }

    const timer = setTimeout(() => {
      finish(reject, new Error(`no ${expectation} within ${timeoutMs} ms; ${describeProgress()}`));
    }, timeoutMs);
    // An unref'd timer cannot hold the file open by itself once the case failed.
    timer.unref();

    request.once("response", onResponse);
    // `once` for the failure paths too: a destroyed request emits `error` once
    // per buffered write, and the first one is the answer.
    request.once("error", onError);
    request.once("close", onClose);
  });
}

test("startHttpTransport_withToolsListAndValidToken_shouldAnswer200WithApplicationJson", async () => {
  await withTransport(async ({ transport, toolSet }) => {
    // GIVEN a caller holding the token and one well-formed JSON-RPC object,
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    // WHEN it posts that object to /mcp,
    const answer = await requestOnce({
      port: transport.port,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
    });

    // THEN the answer is 200 with JSON, and it is exactly what the tool set
    // returned — the transport adds no envelope of its own:
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(answer.body), {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    assert.deepEqual(toolSet.receivedTexts, [body]);
  });
});

test("startHttpTransport_withoutToken_shouldAnswer401WithBearerChallengeAndEmptyBody", async () => {
  await withTransport(async ({ transport, toolSet, logLines }) => {
    // GIVEN a caller with a perfectly good request but no Authorization header,
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    // WHEN it posts to /mcp,
    const answer = await requestOnce({
      port: transport.port,
      headers: { "Content-Type": "application/json" },
      body,
    });

    // THEN it gets 401 with the challenge, an empty body — no reason, no tool
    // data — and the body never reached the tool set:
    assert.equal(answer.status, 401);
    assert.equal(answer.headers["www-authenticate"], "Bearer");
    assert.equal(answer.body, "");
    assert.deepEqual(toolSet.receivedTexts, []);

    // And the log says neither the body nor the header:
    for (const line of logLines) {
      assert.ok(!line.includes(body), `the log carries the request body: ${line}`);
      assert.ok(!line.includes("jsonrpc"), `the log carries the request body: ${line}`);
    }
  });
});

test("startHttpTransport_withWrongToken_shouldAnswer401WithBearerChallenge", async () => {
  await withTransport(async ({ transport, toolSet }) => {
    // GIVEN a caller with the right header shape and the wrong secret,
    const body = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" });

    // WHEN it posts to /mcp,
    const answer = await requestOnce({
      port: transport.port,
      headers: { Authorization: `Bearer ${WRONG_TOKEN}`, "Content-Type": "application/json" },
      body,
    });

    // THEN the rejection looks exactly like the missing-token one: a caller
    // learns nothing about how close it was, and no tool data leaks:
    assert.equal(answer.status, 401);
    assert.equal(answer.headers["www-authenticate"], "Bearer");
    assert.equal(answer.body, "");
    assert.deepEqual(toolSet.receivedTexts, []);
  });
});

test("startHttpTransport_withBasicScheme_shouldAnswer401WithBearerChallenge", async () => {
  await withTransport(async ({ transport, toolSet }) => {
    // GIVEN a caller that carries the correct secret in the wrong scheme,
    const body = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" });

    // WHEN it posts to /mcp,
    const answer = await requestOnce({
      port: transport.port,
      headers: { Authorization: `Basic ${TOKEN}`, "Content-Type": "application/json" },
      body,
    });

    // THEN the scheme check fails before the token ever matters:
    assert.equal(answer.status, 401);
    assert.equal(answer.headers["www-authenticate"], "Bearer");
    assert.equal(answer.body, "");
    assert.deepEqual(toolSet.receivedTexts, []);
  });
});

test("startHttpTransport_withGetOnMcpAndNoToken_shouldAnswer405WithAllowPost", async () => {
  await withTransport(async ({ transport }) => {
    // GIVEN an unauthenticated caller — no `Authorization` header at all,
    // WHEN it uses GET on /mcp,
    const answer = await requestOnce({ port: transport.port, method: "GET" });

    // THEN it gets 405 and is told which method would have worked. The method
    // check comes before the token check, so a regression that swapped that
    // order would answer 401 here and this case would notice:
    assert.equal(answer.status, 405);
    assert.equal(answer.headers.allow, "POST");
    assert.equal(answer.body, "");
  });
});

test("startHttpTransport_withUnknownPath_shouldAnswer404", async () => {
  await withTransport(async ({ transport, toolSet }) => {
    // GIVEN a request to a path this transport does not serve,
    const body = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" });

    // WHEN it is posted with a valid token,
    const answer = await requestOnce({
      port: transport.port,
      path: "/x",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
    });

    // THEN the path decides first — 404, not 200 and not 401:
    assert.equal(answer.status, 404);
    assert.equal(answer.body, "");
    assert.deepEqual(toolSet.receivedTexts, []);
  });
});

test(
  "startHttpTransport_withOversizedContentLength_shouldAnswer413BeforeAnyBodyArrives",
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    await withTransport(async ({ transport, toolSet }) => {
      // GIVEN a caller that announces twice the allowed body and never sends it,
      const answer = await requestOnce({
        port: transport.port,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": String(2 * MAX_BODY_BYTES),
        },
        // Without the header check the transport waits for a body that never
        // comes; this bound is what makes that a red case by name.
        timeoutMs: ANSWER_TIMEOUT_MS,
      });

      // WHEN the transport answers,
      // THEN it is 413 with an empty body, decided from the header alone:
      assert.equal(answer.status, 413);
      assert.equal(answer.body, "");
      assert.deepEqual(toolSet.receivedTexts, []);
    });
  },
);

test(
  "startHttpTransport_withABodyOfOneByteOverTheRequestLimit_shouldAnswer413WhileTheSocketAllowsFiveMebibytes",
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    await withTransport(async ({ transport, toolSet }) => {
      // GIVEN a caller that announces one byte more than a request may carry.
      // The socket limit is 5 242 880, so this only answers 413 if the request
      // limit is its own number and was not dragged along with it:
      const answer = await requestOnce({
        port: transport.port,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          // Literal for the same reason `MAX_BODY_BYTES` is: a derived value here
          // would follow the socket limit and keep this case green by accident.
          "Content-Length": String(1048577),
        },
        // Without the header check the transport waits for a body that never
        // comes; this bound is what makes that a red case by name.
        timeoutMs: ANSWER_TIMEOUT_MS,
      });

      // WHEN the transport answers,
      // THEN it is 413, decided from the header alone, and nothing reaches the
      // tool layer:
      assert.equal(answer.status, 413);
      assert.equal(answer.body, "");
      assert.deepEqual(toolSet.receivedTexts, []);
    });
  },
);

test(
  "startHttpTransport_withOversizedChunkedBody_shouldAnswer413BeforeTheBodyFinishes",
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    await withTransport(async ({ transport, toolSet }) => {
      // GIVEN a chunked body — no Content-Length to inspect — of twice the
      // allowed size, written in chunks,
      const totalBytes = 2 * MAX_BODY_BYTES;
      // Deliberately smaller than a socket read: the transport answers as soon as
      // the counter crosses the limit, and whatever of that chunk it has not
      // consumed yet is still in its receive queue when it closes. A non-empty
      // queue makes the close an RST, and an RST throws away the 413 the client
      // has not read yet — the case then fails for a reason that has nothing to
      // do with the limit. A chunk that fits one read leaves nothing behind, so
      // the same close arrives as a FIN and the status line survives.
      const chunk = Buffer.alloc(16 * 1024, 0x20);
      // Paced on purpose: a loopback socket swallows megabytes faster than any
      // server can answer, and an unpaced upload would prove nothing about where
      // the limit fired. Two milliseconds per chunk leave the transport plenty of
      // time to refuse after it has counted the first half.
      const pauseBetweenChunksMs = 2;
      let writtenBytes = 0;
      let writtenBytesWhenAnswered = null;
      let uploadStopped = false;

      const request = http.request({
        host: "127.0.0.1",
        port: transport.port,
        method: "POST",
        path: "/mcp",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      });
      // The transport closes the socket mid-upload; that reset is the expected
      // outcome here, not a failure of the case.
      request.on("error", () => {});

      // WHEN we keep writing until the transport answers,
      const upload = (async () => {
        while (!uploadStopped && writtenBytes < totalBytes && writtenBytesWhenAnswered === null) {
          writtenBytes += chunk.length;
          await writeWithBackpressure(request, chunk);
          await delay(pauseBetweenChunksMs);
        }
        if (!uploadStopped && writtenBytesWhenAnswered === null) request.end();
      })();
      // The upload may still be in flight when the wait below fails — a write
      // error on the socket the transport just closed must not surface as an
      // unhandled rejection and turn a named failure into noise.
      upload.catch(() => {});

      let response;
      let answerBody;
      try {
        response = await waitForResponse(request, {
          timeoutMs: ANSWER_TIMEOUT_MS,
          expectation: "413",
          // Only meaningful at the moment of the answer: afterwards the upload
          // is still counting, so the assertion below would compare against the
          // wrong number.
          onAnswered: () => {
            writtenBytesWhenAnswered = writtenBytes;
          },
          describeProgress: () => `written: ${writtenBytes} of ${totalBytes} bytes`,
        });
        answerBody = await readResponseBody(response);
      } finally {
        // The upload is no longer interesting once the wait is over, and the
        // stopped flag also releases a write that would otherwise wait for a
        // `drain` on a destroyed socket, i.e. forever.
        uploadStopped = true;
        request.destroy();
      }

      // THEN the 413 arrives while most of the body is still unsent — the limit
      // fires on the stream instead of after buffering 2 MiB:
      assert.equal(response.statusCode, 413);
      assert.equal(answerBody, "");
      assert.ok(
        writtenBytesWhenAnswered < totalBytes,
        `the 413 arrived only after all ${writtenBytesWhenAnswered} bytes were written`,
      );
      assert.ok(
        writtenBytesWhenAnswered <= MAX_BODY_BYTES + 512 * 1024,
        `the 413 was decided only after ${writtenBytesWhenAnswered} bytes, far beyond the limit`,
      );
      assert.deepEqual(toolSet.receivedTexts, []);
    });
  },
);

test(
  "startHttpTransport_afterARejection_shouldStillAnswerTheNextRequest",
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    await withTransport(async ({ transport }) => {
      // GIVEN a request that was rejected for its declared size — the same
      // never-sent body as above, so the same bound applies,
      const rejected = await requestOnce({
        port: transport.port,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": String(2 * MAX_BODY_BYTES),
        },
        timeoutMs: ANSWER_TIMEOUT_MS,
      });
      assert.equal(rejected.status, 413);

      // WHEN the next request arrives with a valid token and a small body,
      const body = JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" });
      const answer = await requestOnce({
        port: transport.port,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body,
      });

      // THEN the transport served it — one rejection is not a broken listener:
      assert.equal(answer.status, 200);
      assert.deepEqual(JSON.parse(answer.body).id, 6);
    });
  },
);

test("startHttpTransport_withNotification_shouldAnswer202WithEmptyBody", async () => {
  await withTransport(async ({ transport, toolSet }) => {
    // GIVEN a notification — a JSON-RPC object without `id`,
    const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });

    // WHEN it is posted,
    const answer = await requestOnce({
      port: transport.port,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
    });

    // THEN JSON-RPC forbids a response, so HTTP gets an accepted empty one:
    assert.equal(answer.status, 202);
    assert.equal(answer.body, "");
    assert.deepEqual(toolSet.receivedTexts, [body]);
  });
});

test(
  "startHttpTransport_whenTheToolSetThrows_shouldAnswer500AndLogTheStatusInsteadOfTheMessage",
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    // GIVEN a tool set that throws with a message quoting a fragment of the body,
    // the way a `JSON.parse` failure does,
    const requestText = '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"text":"operator was reading this"}}';
    const throwingToolSet = {
      receivedTexts: [],
      async handleMessageText() {
        throw new SyntaxError(`Unexpected token in ${requestText}`);
      },
    };

    await withTransport(
      async ({ transport, logLines }) => {
        // WHEN a validly authenticated request reaches that tool set,
        const answer = await requestOnce({
          port: transport.port,
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: requestText,
        });

        // THEN the caller gets an answer instead of a dead listener,
        assert.equal(answer.status, 500);
        assert.equal(answer.body, "");

        // ... and the log names the status, never the exception text: that text
        // is request content, and stderr goes to journald where it stays:
        const failureLine = logLines.find((line) => line.startsWith("http request failed"));
        assert.ok(failureLine, `no failure line in the log: ${JSON.stringify(logLines)}`);
        assert.match(failureLine, /\b500\b/);
        assert.ok(
          !failureLine.includes("operator was reading this"),
          `the log quotes the request body: ${failureLine}`,
        );
        assert.ok(
          !failureLine.includes("Unexpected token"),
          `the log carries the exception message: ${failureLine}`,
        );
      },
      { toolSet: throwingToolSet },
    );
  },
);

test("startHttpTransport_onDefaultHost_shouldBindLoopbackOnly", async () => {
  await withTransport(async ({ transport, origin }) => {
    // GIVEN a transport started without an explicit host,
    // WHEN we read back the address the kernel actually bound,
    // THEN it is loopback, on a port the kernel really assigned:
    assert.equal(transport.host, "127.0.0.1");
    assert.ok(Number.isInteger(transport.port) && transport.port > 0);
    assert.equal(origin, `http://127.0.0.1:${transport.port}`);
  });
});

test("startHttpTransport_afterARejection_shouldCloseTheSocketInsteadOfHoldingIt", async () => {
  await withTransport(async ({ transport }) => {
    // GIVEN a caller with the wrong token that announces a chunked body and
    // then sends one small piece — the trickle that would hold the connection
    // forever if the transport answered and kept the socket open,
    const answerChunks = [];
    const socket = net.connect({ host: "127.0.0.1", port: transport.port });
    socket.on("data", (data) => answerChunks.push(data));
    // The server's close may reset our end; that is the behaviour under test.
    socket.on("error", () => {});

    await once(socket, "connect");
    socket.write(
      [
        "POST /mcp HTTP/1.1",
        `Host: 127.0.0.1:${transport.port}`,
        `Authorization: Bearer ${WRONG_TOKEN}`,
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "",
        "",
      ].join("\r\n"),
    );
    socket.write('5\r\n{"jso\r\n');

    // WHEN we wait without ever sending the rest,
    try {
      await waitForClose(socket, SOCKET_TIMEOUT_MS);

      // THEN the server answered 401 and closed its end instead of waiting for
      // a body it would never accept:
      const answer = Buffer.concat(answerChunks).toString("utf8");
      assert.match(answer, /^HTTP\/1\.1 401 /);
      assert.match(answer, /\r\nconnection: close\r\n/i);
    } finally {
      socket.destroy();
    }
  });
});
