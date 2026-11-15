/**
 * Hub behaviour against a real HTTP/WebSocket server and Node's global
 * `WebSocket` client.
 *
 * The client is a real `WebSocket` on purpose: the frame layer has its own
 * tests (test/websocket.test.js), so everything here is about the hub's
 * decisions — who counts as authenticated, which timer fires, which close code
 * goes out and which line reaches the log writer.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { loadConfig } from "../bridge/config.mjs";
import { Hub, HubRequestError, debugBlockOf, formatStatusLine, verifyToken } from "../bridge/hub.mjs";
import { PROTOCOL } from "../bridge/protocol.mjs";
import { upgradeSocket } from "../bridge/websocket.mjs";

const EVENT_TIMEOUT_MS = 5_000;
// Sentinel for "the awaited thing did not happen yet"; `undefined` is a real
// result for `Array.prototype.find`.
const NOT_YET = Symbol("not yet");

// Generated per run: a literal would violate the "no secrets in the repo" rule,
// and `randomBytes(16)` gives exactly the 32 hex characters `readToken` wants.
const TOKEN = randomBytes(16).toString("hex");

/* ------------------------------------------------------------------ helpers */

/**
 * Polls until `check()` returns something other than NOT_YET.
 *
 * Polling, not events: the interesting state lives in the hub behind a socket,
 * so there is nothing local to subscribe to. 5 ms is invisible next to the
 * 200 ms timeouts the tests configure.
 */
async function waitFor(check, description) {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  for (;;) {
    const value = check();
    if (value !== NOT_YET) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${EVENT_TIMEOUT_MS} ms waiting for ${description}`);
    }
    await delay(5);
  }
}

/**
 * Starts a hub behind a real server on port 0.
 *
 * `env` is passed to `loadConfig()`, so a test configures timeouts the same way
 * the operator does — through the variable names from the spec.
 */
async function startHubServer(t, env = {}, { wrapConnection = (connection) => connection } = {}) {
  const logLines = [];
  const statusResults = [];
  const config = loadConfig(env);
  const hub = new Hub({
    config,
    token: TOKEN,
    // The timestamp prefix belongs to bridge.mjs; here the raw message is what
    // the assertions look at.
    log: (message) => logLines.push(message),
    onStatus: (result) => statusResults.push(result),
  });

  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    const connection = upgradeSocket(req, socket, head);
    if (connection === null) return;
    // The wrapper exists for one case: a socket that dies between the hub's
    // `isOpen` check and its write cannot be produced over a real socket without
    // racing, so that case swaps the `send` instead of waiting for luck.
    hub.handleConnection(wrapConnection(connection), socket.remoteAddress ?? "unknown");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  // Close sockets first and the listener second: closing the listener while
  // upgraded sockets are still open is exactly the case server.mjs documents as
  // "may never call back".
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  return {
    port: server.address().port,
    hub,
    logLines,
    statusResults,
    waitForLogLine: (matcher, description) => waitFor(() => logLines.find(matcher) ?? NOT_YET, description),
  };
}

/**
 * A `WebSocket` client that records everything the bridge sends, so no message
 * can be missed between two awaits — `welcome` and `request` arrive back to back.
 */
function createClient(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  let open = false;
  let closeEvent = null;

  socket.addEventListener("open", () => {
    open = true;
  });
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data));
  });
  socket.addEventListener("close", (event) => {
    closeEvent = event;
  });

  return {
    socket,
    messages,
    get closeEvent() {
      return closeEvent;
    },
    waitForOpen: () => waitFor(() => (open ? true : NOT_YET), "the socket to open"),
    waitForMessage: (type) => waitFor(() => messages.find((m) => m.type === type) ?? NOT_YET, `a "${type}" message`),
    // Searched by id, never by position: responses may arrive in any order, and
    // a test that counts lines breaks the day two requests overlap.
    waitForRequest: (id) =>
      waitFor(
        () => messages.find((m) => m.type === PROTOCOL.TYPES.REQUEST && m.id === id) ?? NOT_YET,
        `a "${PROTOCOL.TYPES.REQUEST}" message with id ${id}`,
      ),
    waitForClose: () => waitFor(() => closeEvent ?? NOT_YET, "the bridge to close the connection"),
  };
}

async function connectClient(t, port) {
  const client = createClient(port);
  t.after(() => client.socket.close());
  await client.waitForOpen();
  return client;
}

function helloFrame(token) {
  return JSON.stringify({
    type: PROTOCOL.TYPES.HELLO,
    protocol: PROTOCOL.VERSION,
    extensionVersion: "0.1.0",
    browser: { name: "Firefox", version: "152.0.3" },
    token,
  });
}

function responseFrame(result, { ok = true, id = 1 } = {}) {
  if (ok) {
    return JSON.stringify({ type: PROTOCOL.TYPES.RESPONSE, id, ok: true, result });
  }
  return JSON.stringify({ type: PROTOCOL.TYPES.RESPONSE, id, ok: false, error: result });
}

/** Same length on purpose: the interesting path is the compare, not the length reject. */
function flipFirstCharacter(token) {
  const replacement = token[0] === "a" ? "b" : "a";
  return replacement + token.slice(1);
}

/* --------------------------------------------------------- formatStatusLine */

test("formatStatusLine_withTwoWindows_shouldSumTabsAcrossAllWindows", () => {
  // GIVEN a status result whose windows hold two and one tabs:
  const result = {
    windows: [
      { id: 1, tabs: [{ id: 101 }, { id: 102 }] },
      { id: 2, tabs: [{ id: 201 }] },
    ],
  };

  // WHEN the single log line is formatted,
  // THEN the tab count is the sum over all windows, not the first window's count:
  assert.equal(formatStatusLine(result), "status windows=2 tabs=3");
});

test("formatStatusLine_withoutWindows_shouldReportZeros", () => {
  // GIVEN results that carry no window list at all,
  // WHEN they are formatted,
  // THEN counting nothing is not an error:
  assert.equal(formatStatusLine({}), "status windows=0 tabs=0");
  assert.equal(formatStatusLine(null), "status windows=0 tabs=0");
});

/* --------------------------------------------------------------- debugBlockOf */

/*
 * The whitelist is the contract, so these cases read it the way an operator reads
 * the stderr stream: keys in table order, page text as a length, and anything the
 * table does not name as a marker — never its value, never its length.
 */

test("debugBlockOf_withAKnownMethod_shouldPrintExactlyTheWhitelistedFieldsInTableOrder", () => {
  // GIVEN a read result that carries every whitelisted field, deliberately in a
  // different order than the table (a result arrives in whatever order the
  // extension serialised it):
  const result = {
    waitedMs: 7,
    settled: true,
    fellBack: false,
    root: null,
    mode: "full",
    via: "innerText",
    truncated: false,
    totalChars: 22,
    chars: 22,
    offset: 0,
    text: "Zeile eins",
    title: "Beispielseite",
    url: "https://example.org/",
    tabId: 42,
  };

  // WHEN the block is built for the read method,
  const block = JSON.parse(debugBlockOf(PROTOCOL.METHODS.READ, result));

  // THEN the keys follow the table, not the result,
  assert.deepEqual(Object.keys(block), [
    "tabId",
    "url",
    "title",
    "text",
    "offset",
    "chars",
    "totalChars",
    "truncated",
    "via",
    "mode",
    "root",
    "fellBack",
    "settled",
    "waitedMs",
  ]);

  // ... the two page strings appear as their lengths while the identifying fields
  // stay readable, and `null` on a `full` field is still a fact:
  assert.equal(block.title, `<${result.title.length} chars>`);
  assert.equal(block.text, `<${result.text.length} chars>`);
  assert.equal(block.url, "https://example.org/");
  assert.equal(block.root, null);
  assert.equal(block.settled, true);
});

test("debugBlockOf_withAnUnlistedField_shouldPrintTheMarkerInsteadOfValueAndLength", () => {
  // GIVEN a read result with a field nobody entered in the table:
  const blockText = debugBlockOf(PROTOCOL.METHODS.READ, { tabId: 42, surpriseField: "geheim" });

  // WHEN the block is built,
  const block = JSON.parse(blockText);

  // THEN the key survives with the marker as its value,
  assert.deepEqual(block, { tabId: 42, surpriseField: "<unlisted field>" });

  // ... and neither the content nor a length of it reaches the block — a length
  // would give a short field away just as well:
  assert.ok(!blockText.includes("geheim"), "the unlisted value must not reach the block");
  assert.ok(!blockText.includes("<6 chars>"), "not even the length of an unlisted field may appear");
});

test("debugBlockOf_withTwoUnlistedFields_shouldKeepBothKeys", () => {
  // GIVEN a result with two fields that are not in the table and would look alike
  // once their values are replaced:
  const block = JSON.parse(
    debugBlockOf(PROTOCOL.METHODS.READ, { tabId: 42, surpriseA: "geheim", surpriseB: "auch geheim" }),
  );

  // WHEN the block is built,
  // THEN each keeps its own key at the end of the block, so two strangers do not
  // collapse into one entry:
  assert.deepEqual(Object.keys(block), ["tabId", "surpriseA", "surpriseB"]);
  assert.deepEqual(block, { tabId: 42, surpriseA: "<unlisted field>", surpriseB: "<unlisted field>" });
});

test("debugBlockOf_withAnUnlistedFieldInsideAnElement_shouldPrintTheMarkerThere", () => {
  // GIVEN an inspect result whose element carries a field the element shape does
  // not name:
  const result = {
    tabId: 42,
    count: 1,
    elements: [{ index: 0, text: "Kaufen", surpriseInside: "geheim" }],
  };

  // WHEN the block is built,
  const block = JSON.parse(debugBlockOf(PROTOCOL.METHODS.INSPECT, result));

  // THEN the nesting is projected field by field, so the marker lands inside the
  // element rather than the whole element being dropped or printed in full:
  assert.deepEqual(Object.keys(block.elements[0]), ["index", "text", "surpriseInside"]);
  assert.equal(block.elements[0].text, "<6 chars>");
  assert.equal(block.elements[0].surpriseInside, "<unlisted field>");
});

test("debugBlockOf_withAMethodWithoutATableEntry_shouldReturnNull", () => {
  // GIVEN the methods that are silent on purpose — eval, screenshot, open_tab,
  // close_tab and frames, which has no report branch at all — plus one name no
  // protocol knows, plus the two names every object inherits from
  // `Object.prototype` (a plain `entry === undefined` lookup would hand those a
  // block full of markers):
  const silentMethods = [
    PROTOCOL.METHODS.EVAL,
    PROTOCOL.METHODS.SCREENSHOT,
    PROTOCOL.METHODS.OPEN_TAB,
    PROTOCOL.METHODS.CLOSE_TAB,
    PROTOCOL.METHODS.FRAMES,
    "frobnicate",
    "constructor",
    "toString",
  ];

  // WHEN a block is requested for each of them,
  // THEN the answer is `null` — "write nothing", not a block full of markers:
  for (const method of silentMethods) {
    assert.equal(debugBlockOf(method, { tabId: 42, result: "geheim" }), null, `${method} must have no block`);
  }
});

test("debugBlockOf_withALengthFieldCarryingANonString_shouldPrintTheMarkerAndKeepNull", () => {
  // GIVEN a `length` field (`text`) carrying a number and another (`title`)
  // carrying `null`:
  const block = JSON.parse(debugBlockOf(PROTOCOL.METHODS.READ, { tabId: 42, title: null, text: 42 }));

  // WHEN the block is built,
  // THEN `null` survives as the statement "there is none",
  assert.equal(block.title, null);

  // ... and a number where a page string was expected is content of a kind the
  // table never judged, so it becomes the marker:
  assert.equal(block.text, "<unlisted field>");
});

test("debugBlockOf_withAMissingListedField_shouldNotInventIt", () => {
  // GIVEN a read result carrying only two of the fourteen whitelisted fields:
  const result = { tabId: 42, truncated: false };

  // WHEN the block is built,
  const block = JSON.parse(debugBlockOf(PROTOCOL.METHODS.READ, result));

  // THEN the listed-but-absent fields are simply not there — a `null` for a field
  // the extension never sent would be an invention, and reading it as "empty"
  // would be worse than the hole:
  assert.deepEqual(block, result);
  assert.deepEqual(Object.keys(block), ["tabId", "truncated"]);
});

test("debugBlockOf_withALengthEachFieldCarryingANonArray_shouldPrintTheMarker", () => {
  // GIVEN an inspect element whose `classes` — a `lengthEach` field — carries a
  // plain string instead of a list, the shape a broken extension would send:
  const result = { tabId: 42, elements: [{ index: 0, classes: "knopf" }] };

  // WHEN the block is built,
  const block = JSON.parse(debugBlockOf(PROTOCOL.METHODS.INSPECT, result));

  // THEN the field prints the marker rather than a length it cannot vouch for:
  // the string's `length` would describe content of a kind the table never judged,
  // and printing it in full is the one thing the whitelist exists to prevent.
  assert.equal(block.elements[0].classes, "<unlisted field>");
});

/*
 * A known gap, pinned rather than approved (spec 28, `## Bekannte Lücken`).
 *
 * `projectShape` can only project a mapping; anything else — a list, a scalar,
 * `null` — is printed as it arrived. The old code at the same spot was just as
 * leaky, so this is not a regression, but the whitelist reads as if it closed the
 * flank and it does not. The assertion below exists so the hole cannot *widen*
 * unnoticed; the day someone prints the marker instead, this test is the diff.
 */
test("debugBlockOf_withAResultThatIsNoObject_shouldPrintItAsItArrived", () => {
  // GIVEN a result that is no mapping — a list, the one shape no report branch
  // builds but a broken or hostile extension can send:
  const result = ["geheim"];

  // WHEN the block is built for a method that does have a table entry,
  const blockText = debugBlockOf(PROTOCOL.METHODS.READ, result);

  // THEN today the value is printed in full — the gap described above, not a
  // decision anybody made:
  assert.equal(blockText, JSON.stringify(result, null, 2));
  assert.ok(blockText.includes("geheim"), "the gap: a non-object result is not projected");
});

/* -------------------------------------------------------------- verifyToken */

test("verifyToken_withTheExpectedToken_shouldReturnTrue", () => {
  // GIVEN the configured token,
  // WHEN it is compared with itself,
  // THEN it matches:
  assert.equal(verifyToken(TOKEN, TOKEN), true);
});

test("verifyToken_withSameLengthButDifferentToken_shouldReturnFalse", () => {
  // GIVEN a candidate of the same length that differs in the first character,
  // WHEN it is compared,
  // THEN it is rejected — the constant-time compare is the deciding step:
  assert.equal(verifyToken(TOKEN, flipFirstCharacter(TOKEN)), false);
});

test("verifyToken_withShorterCandidate_shouldReturnFalse", () => {
  // GIVEN a candidate shorter than the configured token,
  // WHEN it is compared,
  // THEN it is rejected before anything is hashed:
  assert.equal(verifyToken(TOKEN, TOKEN.slice(0, -1)), false);
  assert.equal(verifyToken(TOKEN, ""), false);
});

/* ----------------------------------------------------------------- hello/auth */

test("hub_withWrongToken_shouldCloseWith4401AndKeepTheTokenOutOfTheLog", async (t) => {
  // GIVEN a running hub and a client that sends a wrong token of the right length:
  const { port, logLines, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);

  // WHEN the client presents it in `hello`,
  client.socket.send(helloFrame(flipFirstCharacter(TOKEN)));

  // THEN the bridge closes with 4401, logs exactly one auth failure and never
  // repeats the token:
  const close = await client.waitForClose();
  assert.equal(close.code, PROTOCOL.CLOSE.AUTH_FAILED);
  const authLine = await waitForLogLine((line) => line.startsWith("auth failed"), "the auth failed line");
  assert.match(authLine, /^auth failed peer=\S+$/);
  assert.ok(!logLines.join("\n").includes(TOKEN), "the log must not contain the token");
});

test("hub_withoutHelloWithinTheHelloTimeout_shouldCloseWith4408", async (t) => {
  // GIVEN a hub whose hello deadline is 200 ms,
  const { port } = await startHubServer(t, { BC_HELLO_TIMEOUT_MS: "200" });

  // WHEN a client connects and says nothing,
  const client = await connectClient(t, port);
  const close = await client.waitForClose();

  // THEN the hub closes with 4408:
  assert.equal(close.code, PROTOCOL.CLOSE.HELLO_TIMEOUT);
});

test("hub_withForeignFirstFrame_shouldCloseWith1002AndLogAProtocolError", async (t) => {
  // GIVEN a running hub and a client whose first message is not a `hello`:
  const { port, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);

  // WHEN that message arrives,
  client.socket.send(JSON.stringify({ type: "nope" }));

  // THEN the hub closes with 1002 and logs a protocol error naming the peer:
  const close = await client.waitForClose();
  assert.equal(close.code, PROTOCOL.CLOSE.PROTOCOL_ERROR);
  const protocolLine = await waitForLogLine((line) => line.startsWith("protocol error"), "the protocol error line");
  assert.match(protocolLine, /^protocol error peer=\S+$/);
});

test("hub_afterWelcome_shouldKeepTheConnectionUsablePastTheHelloTimeout", async (t) => {
  // GIVEN a hub whose hello deadline is 200 ms and a client that already said hello:
  const { port, waitForLogLine } = await startHubServer(t, {
    BC_HELLO_TIMEOUT_MS: "200",
    BC_CALL_TIMEOUT_MS: "2000",
  });
  const client = await connectClient(t, port);

  client.socket.send(helloFrame(TOKEN));
  await client.waitForMessage(PROTOCOL.TYPES.WELCOME);

  // WHEN nothing happens for twice the hello deadline,
  await delay(400);

  // THEN the hello timer is gone: no close, and the connection still answers —
  // a status response is logged instead of hitting a dead socket.
  assert.equal(client.closeEvent, null);
  assert.equal(client.socket.readyState, WebSocket.OPEN);

  client.socket.send(responseFrame({ windows: [{ id: 1, tabs: [{ id: 101 }, { id: 102 }] }] }));
  await waitForLogLine((line) => line === "status windows=1 tabs=2", "the status line");
});

/* ------------------------------------------------------------------- status */

test("hub_withSecondValidConnection_shouldReplaceOnlyThePreviousOneWith4409", async (t) => {
  // GIVEN an authenticated client and a hub that remembered it:
  const { port } = await startHubServer(t);
  const first = await connectClient(t, port);
  first.socket.send(helloFrame(TOKEN));
  await first.waitForMessage(PROTOCOL.TYPES.WELCOME);

  // WHEN a second valid connection arrives,
  const second = await connectClient(t, port);
  second.socket.send(helloFrame(TOKEN));
  await second.waitForMessage(PROTOCOL.TYPES.WELCOME);

  // THEN the previous connection is closed with 4409 while the new one keeps
  // working — "the newest wins" must not cost the new connection its socket:
  const close = await first.waitForClose();
  assert.equal(close.code, PROTOCOL.CLOSE.REPLACED);

  const request = await second.waitForMessage(PROTOCOL.TYPES.REQUEST);
  assert.deepEqual(request, {
    type: PROTOCOL.TYPES.REQUEST,
    id: 1,
    method: PROTOCOL.METHODS.STATUS,
    params: {},
  });
  assert.equal(second.closeEvent, null);
});

test("hub_withoutStatusResponse_shouldLogStatusTimeoutAndKeepTheConnection", async (t) => {
  // GIVEN a hub whose status deadline is 200 ms and a client that stays silent:
  const { port, waitForLogLine } = await startHubServer(t, { BC_CALL_TIMEOUT_MS: "200" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  await client.waitForMessage(PROTOCOL.TYPES.REQUEST);

  // WHEN no answer arrives in time,
  const timeoutLine = await waitForLogLine((line) => line.startsWith("status timeout"), "the status timeout line");

  // THEN the log says so and the connection survives:
  assert.match(timeoutLine, /^status timeout peer=\S+$/);
  assert.equal(client.socket.readyState, WebSocket.OPEN);
  assert.equal(client.closeEvent, null);
});

test("hub_withStatusFailureResponse_shouldLogTheCodeAndKeepTheConnection", async (t) => {
  // GIVEN an authenticated client that received the status request:
  const { port, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  await client.waitForMessage(PROTOCOL.TYPES.REQUEST);

  // WHEN it answers with `ok:false`,
  client.socket.send(responseFrame({ code: "unsupported_method", message: "only status is known" }, { ok: false }));

  // THEN the code is logged and the connection stays open — a failing method is
  // not a reason to hang up:
  const failedLine = await waitForLogLine((line) => line.startsWith("status failed"), "the status failed line");
  assert.match(failedLine, /^status failed peer=\S+ code=unsupported_method$/);
  assert.equal(client.socket.readyState, WebSocket.OPEN);
  assert.equal(client.closeEvent, null);
});

test("hub_withDebugLogging_shouldLogTheStatusLineAndTheIndentedResult", async (t) => {
  // GIVEN a hub started with BC_LOG=debug:
  const { port, statusResults, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  await client.waitForMessage(PROTOCOL.TYPES.REQUEST);

  // WHEN a successful status response arrives,
  const result = { windows: [{ id: 1, tabs: [{ id: 101 }] }] };
  client.socket.send(responseFrame(result));

  // THEN the summary line comes first and the full result follows as JSON, and
  // the result also reaches the `onStatus` seam. Byte-identical to the result on
  // purpose: `test/bridge.test.js` and `test/mcp.test.js` pin this block from the
  // outside against the fixture, so `url` and `title` are `full` in the table:
  await waitForLogLine((line) => line === "status windows=1 tabs=1", "the status line");
  const jsonLine = await waitForLogLine((line) => line.startsWith("{"), "the debug JSON");
  assert.equal(jsonLine, JSON.stringify(result, null, 2));
  assert.deepEqual(statusResults, [result]);
});

/* ------------------------------------------------------- requestStatus seam */

/*
 * Every case below searches requests and answers by their `id`, never by
 * position or line number: two requests may be in flight at once, and their
 * answers may come back in any order.
 */

test("hub_withDebugLogging_shouldLogTheNavigateLineAndTheIndentedResult", async (t) => {
  // GIVEN a hub started with BC_LOG=debug and an answered automatic status
  // request, so the only request in flight below is this test's own:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a navigation is answered successfully,
  const pending = hub.request(PROTOCOL.METHODS.NAVIGATE, { url: "https://example.org/" });
  const request = await client.waitForRequest(2);
  const result = {
    tabId: 42,
    windowId: 1,
    url: "https://example.org/",
    title: "Example Domain",
    complete: true,
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN the proof line is written exactly as the spec words it,
  const navigateLine = await waitForLogLine(
    (line) => line === "navigate tab=42 url=https://example.org/ complete=true",
    "the navigate line",
  );

  // ... followed by the whitelist block as indented JSON — the same debug
  // treatment `status` gets, because a navigation is the one action the agent
  // takes in the operator's browser. Table order, `url` in full, `title` as the
  // length of the page text it is:
  const debugEntry = await waitFor(
    () => logLines.find((line) => line.includes('"tabId": 42')) ?? NOT_YET,
    "the indented navigate result",
  );
  const expectedBlock = {
    tabId: 42,
    windowId: 1,
    url: "https://example.org/",
    title: `<${result.title.length} chars>`,
    complete: true,
  };
  assert.deepEqual(Object.keys(JSON.parse(debugEntry)), Object.keys(expectedBlock), "table order, not result order");
  assert.deepEqual(JSON.parse(debugEntry), expectedBlock);
  assert.ok(debugEntry.includes('\n  "windowId": 1'), "the result must be indented, not a second one-liner");
  assert.ok(
    logLines.indexOf(debugEntry) > logLines.indexOf(navigateLine),
    "the summary line comes before the debug block",
  );
});

/* -------------------------------------------------------------------- read */

test("hub_requestWithReadMethod_shouldResolveAndLogOneLineWithoutAnyPageText", async (t) => {
  // GIVEN a hub started with BC_LOG=debug — the setting that writes a debug block
  // to stderr — and an answered automatic status request, so the only request in
  // flight below is this test's own:
  const { port, hub, logLines, statusResults, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a read is answered, with an invented text so that nobody's page is in
  // this test, and with the two settle fields the extension appends:
  const pending = hub.request(PROTOCOL.METHODS.READ, {});
  const request = await client.waitForRequest(2);
  const result = {
    tabId: 42,
    url: "https://example.org/",
    title: "Beispielseite",
    text: "Zeile eins\n\nZeile zwei",
    truncated: false,
    via: "innerText",
    settled: true,
    waitedMs: 7,
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN the proof line names tab, URL, length, flag and source, exactly as the
  // spec words it,
  const readLine = await waitForLogLine((line) => line.startsWith("read tab="), "the read line");
  assert.equal(
    readLine,
    `read tab=42 url=https://example.org/ chars=${result.text.length} truncated=false via=innerText`,
  );

  // ... the debug block carries the count where the text was — writing the result
  // itself would put the operator's page text on stderr,
  const redactedText = `"text": "<${result.text.length} chars>"`;
  const debugEntry = await waitFor(
    () => logLines.find((line) => line.includes(redactedText)) ?? NOT_YET,
    "the redacted debug result",
  );
  assert.ok(debugEntry.startsWith("{"), "the debug block is the indented JSON result");

  // ... its keys follow the whitelist table in order, which is what makes the
  // block readable the same way for every answer (the listed fields this result
  // does not carry — `offset`, `chars`, `mode`, `root`, … — are absent, not null),
  const block = JSON.parse(debugEntry);
  assert.deepEqual(Object.keys(block), ["tabId", "url", "title", "text", "truncated", "via", "settled", "waitedMs"]);

  // ... the title is page text too and appears as its length while the URL stays
  // the operator's address,
  assert.equal(block.title, `<${result.title.length} chars>`);
  assert.equal(block.url, "https://example.org/");
  assert.equal(block.waitedMs, 7);

  // ... no line anywhere contains the page text,
  assert.ok(!logLines.join("\n").includes(result.text), "the page text must not reach the log");

  // ... and `read` does not feed the `status` seam.
  assert.deepEqual(statusResults, [{ windows: [] }]);
});

test("hub_requestWithReadMethodAndAForeignFieldUnderDebugLogging_shouldPrintTheMarkerAndNotTheValue", async (t) => {
  // GIVEN a hub started with BC_LOG=debug and an answered automatic status
  // request, so the only request in flight below is this test's own:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a read answer carries a field the whitelist does not know — the shape a
  // field added by a future extension version would have:
  const pending = hub.request(PROTOCOL.METHODS.READ, {});
  const request = await client.waitForRequest(2);
  client.socket.send(
    responseFrame(
      {
        tabId: 42,
        url: "https://example.org/",
        title: "Beispielseite",
        text: "Zeile eins",
        truncated: false,
        via: "innerText",
        surpriseField: "geheim",
      },
      { id: request.id },
    ),
  );
  await pending;

  // THEN the block names the field but not its value,
  const marker = '"surpriseField": "<unlisted field>"';
  const debugEntry = await waitFor(
    () => logLines.find((line) => line.includes(marker)) ?? NOT_YET,
    "the debug block with the unlisted marker",
  );
  const block = JSON.parse(debugEntry);
  assert.equal(block.surpriseField, "<unlisted field>");
  assert.equal(Object.keys(block).at(-1), "surpriseField", "unlisted fields hang at the end");

  // ... and the value does not appear anywhere in the log — the string itself, not
  // a count of lines, is the assertion that proves the reversal of direction:
  assert.ok(!logLines.join("\n").includes("geheim"), "an unlisted value must never reach the log");
});

test("hub_requestWithReadMethodUnderInfoLogging_shouldWriteNoDebugBlock", async (t) => {
  // GIVEN a hub at the default log level and an answered automatic status request:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a read is answered,
  const pending = hub.request(PROTOCOL.METHODS.READ, {});
  const request = await client.waitForRequest(2);
  client.socket.send(
    responseFrame(
      { tabId: 42, url: "https://example.org/", title: "Beispielseite", text: "Zeile eins", truncated: false },
      { id: request.id },
    ),
  );
  await pending;

  // THEN the line is written and no message is a JSON block — the level stays the
  // switch, whatever the whitelist says:
  await waitForLogLine((line) => line.startsWith("read tab="), "the read line");
  const blockLikeMessages = logLines.filter((line) => line.startsWith("{"));
  assert.deepEqual(blockLikeMessages, []);
});

test("hub_requestWithReadMethodWithoutAKnownTextSource_shouldLogAQuestionMarkInsteadOfAGuess", async (t) => {
  // GIVEN a hub with an answered automatic status request — the only request in
  // flight below is this test's own:
  const { port, hub, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a read answer carries no `via` — an extension from before the field
  // existed, or a broken one:
  const pending = hub.request(PROTOCOL.METHODS.READ, {});
  const request = await client.waitForRequest(2);
  client.socket.send(
    responseFrame(
      { tabId: 42, url: "https://example.org/", text: "Zeile eins", truncated: false },
      { id: request.id },
    ),
  );
  await pending;

  // THEN the line keeps its shape and shows the hole instead of a shifted column:
  const readLine = await waitForLogLine((line) => line.startsWith("read tab="), "the read line");
  assert.equal(readLine, "read tab=42 url=https://example.org/ chars=10 truncated=false via=?");
});

test("hub_requestWithReadMethodAndAHostileTextSource_shouldLogAQuestionMarkAndNoExtraLine", async (t) => {
  // GIVEN a hub with an answered automatic status request — the only request in
  // flight below is this test's own:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a read answer carries a `via` that is not one of the two known sources
  // — here one shaped like a complete, plausible `navigate` line so that an
  // echoed value would forge an entry in `bridge.log`:
  const pending = hub.request(PROTOCOL.METHODS.READ, {});
  const request = await client.waitForRequest(2);
  client.socket.send(
    responseFrame(
      {
        tabId: 42,
        url: "https://example.org/",
        text: "Zeile eins",
        truncated: false,
        via: "innerText\nnavigate tab=7 url=https://evil.example/ complete=true",
      },
      { id: request.id },
    ),
  );
  await pending;

  // THEN the source falls back to the whitelist's `?` ...
  const readLine = await waitForLogLine((line) => line.startsWith("read tab="), "the read line");
  assert.equal(readLine, "read tab=42 url=https://example.org/ chars=10 truncated=false via=?");

  // ... and the log stays one line per message — the injected `\n` must not split
  // the entry into a second line that reads like a navigation:
  const physicalLines = logLines.join("\n").split("\n");
  assert.equal(
    physicalLines.filter((line) => line.startsWith("read tab=")).length,
    1,
    "exactly one read line must reach the log",
  );
  assert.ok(
    !physicalLines.some((line) => line.startsWith("navigate tab=7")),
    "no forged navigate line may reach the log",
  );
});

/* ------------------------------------------------------------------- click */

test("hub_requestWithClickMethod_shouldLogSelectorTabAndUrlWithoutAnyPageText", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, statusResults, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a click is requested and answered — the selector here differs from the
  // result's `clicked` on purpose, so the line below proves which of the two it
  // took:
  const selector = 'a[href*="/watch"]';
  const pending = hub.request(PROTOCOL.METHODS.CLICK, { selector });
  const request = await client.waitForRequest(2);
  const result = {
    tabId: 42,
    url: "https://example.org/watch",
    title: "Beispielvideo",
    clicked: "a#video-title-link",
    text: "Zeile eins\n\nZeile zwei",
    truncated: false,
    via: "innerText",
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN the proof line names the selector of the *request*, then tab and URL,
  // exactly as the spec words it,
  const clickLine = await waitForLogLine((line) => line.startsWith("click selector="), "the click line");
  assert.equal(clickLine, 'click selector=a[href*="/watch"] tab=42 url=https://example.org/watch');

  // ... it carries no length and no text, because a click is not a read — the
  // character count would make the line look like one,
  assert.ok(!clickLine.includes("chars="), "the click line names no text length");
  assert.ok(!clickLine.includes(result.text), "the page text must not reach the log");

  // ... and `click` does not feed the `status` seam.
  assert.deepEqual(statusResults, [{ windows: [] }]);
});

test("hub_requestWithClickMethodAndAMultilineSelector_shouldLogOneSpaceAndExactlyOnePhysicalLine", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN the selector was pasted with a line break in it,
  const pending = hub.request(PROTOCOL.METHODS.CLICK, { selector: "div\n a" });
  const request = await client.waitForRequest(2);
  client.socket.send(
    responseFrame(
      { tabId: 42, url: "https://example.org/", clicked: "a", text: "Zeile eins", truncated: false, via: "innerText" },
      { id: request.id },
    ),
  );
  await pending;

  // THEN the break became a space — the selector's own space after it stays, the
  // rule replaces the break and does not rewrite the selector,
  const clickLine = await waitForLogLine((line) => line.startsWith("click selector="), "the click line");
  assert.equal(clickLine, "click selector=div  a tab=42 url=https://example.org/");

  // ... so the entry stays one physical line: no second line that reads like a
  // log entry of its own,
  const physicalLines = logLines.join("\n").split("\n");
  assert.equal(
    physicalLines.filter((line) => line.startsWith("click selector=")).length,
    1,
    "exactly one click line must reach the log",
  );
  assert.ok(
    !physicalLines.some((line) => line.startsWith(" a tab=")),
    "the selector's line break must not start a line of its own",
  );
});

test("hub_requestWithClickMethodUnderDebugLogging_shouldRedactTextAndClicked", async (t) => {
  // GIVEN a hub started with BC_LOG=debug — the setting that writes whole results
  // to stderr — and an answered automatic status request:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a click is answered — with an invented page text and a `clicked` shaped
  // like the `href` form, which is the one that can carry a session token:
  const pending = hub.request(PROTOCOL.METHODS.CLICK, { selector: "a.link" });
  const request = await client.waitForRequest(2);
  const result = {
    tabId: 42,
    url: "https://example.org/",
    title: "Beispielseite",
    clicked: 'a[href="/watch?sitzungstoken"]',
    text: "Zeile eins\n\nZeile zwei",
    truncated: false,
    via: "innerText",
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN the debug block carries the lengths where text and element description
  // were — two `length` rules in the table, one block,
  const debugEntry = await waitFor(
    () =>
      logLines.find(
        (line) => line.includes(`"text": "<${result.text.length} chars>"`) && line.includes('"clicked": "<'),
      ) ?? NOT_YET,
    "the redacted click debug result",
  );
  assert.ok(debugEntry.startsWith("{"), "the debug block is the indented JSON result");
  assert.ok(
    debugEntry.includes(`"clicked": "<${result.clicked.length} chars>"`),
    "`clicked` must be redacted to its length",
  );

  // ... in table order, and only the fields this result actually carries (the
  // listed-but-absent `settled`/`waitedMs` are not invented):
  assert.deepEqual(Object.keys(JSON.parse(debugEntry)), [
    "tabId",
    "url",
    "title",
    "clicked",
    "text",
    "truncated",
    "via",
  ]);

  // ... and no line anywhere carries the text or the clicked element — the
  // unredacted result would have put both on stderr,
  const joinedLog = logLines.join("\n");
  assert.ok(!joinedLog.includes(result.text), "the page text must not reach the log");
  assert.ok(!joinedLog.includes(result.clicked), "the clicked element must not reach the log");
  assert.ok(!joinedLog.includes("sitzungstoken"), "no token-bearing href may reach the log");

  // ... written once: a second, unredacted block would have leaked the `clicked`
  // value the line above just proved absent — the branch has no second writer.
  assert.equal(
    logLines.filter((line) => line.includes('"tabId": 42')).length,
    1,
    "exactly one debug block per result",
  );
});

/* --------------------------------------------------------------------- type */

test("hub_requestWithTypeMethod_shouldLogSelectorCharsAndSubmitWithoutTheTypedText", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, logLines, statusResults, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a type request is answered with a text that must never be readable in
  // the log — the value the agent writes may be a password:
  const typedText = "geheim-testwert";
  const pending = hub.request(PROTOCOL.METHODS.TYPE, {
    selector: 'input[name="q"]',
    text: typedText,
    submit: true,
  });
  const request = await client.waitForRequest(2);
  // The URL carries no query on purpose: a search page that echoes the typed text
  // in its address is the known hole this increment does not close, and a test URL
  // that happens to be quiet must not pretend it does.
  const result = {
    tabId: 42,
    url: "https://example.org/suche",
    title: "Suchergebnisse",
    typed: "input#q",
    submitted: true,
    text: "Zeile eins\n\nZeile zwei",
    truncated: false,
    via: "innerText",
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN the proof line names the selector, the length of the *typed* text and
  // the submit intent, then tab and URL:
  const typeLine = await waitForLogLine((line) => line.startsWith("type selector="), "the type line");
  assert.equal(
    typeLine,
    'type selector=input[name="q"] chars=15 submit=true tab=42 url=https://example.org/suche',
  );

  // ... so the count is the typed text's length, not the page text's,
  assert.ok(!typeLine.includes(`chars=${result.text.length} `), "`chars` must not count the page text");

  // ... and neither the typed text nor the page text reaches any line.
  const joinedLog = logLines.join("\n");
  assert.ok(!joinedLog.includes(typedText), "the typed text must not reach the log");
  assert.ok(!joinedLog.includes(result.text), "the page text must not reach the log");

  // ... and `type` does not feed the `status` seam.
  assert.deepEqual(statusResults, [{ windows: [] }]);
});

test("hub_requestWithTypeMethodAndAMultilineSelector_shouldLogOneSpaceAndExactlyOnePhysicalLine", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN the selector arrived with a line break in it,
  const pending = hub.request(PROTOCOL.METHODS.TYPE, { selector: "input\n[name=q]", text: "ab" });
  const request = await client.waitForRequest(2);
  client.socket.send(
    responseFrame(
      { tabId: 42, url: "https://example.org/", typed: "input", submitted: false, text: "x", truncated: false, via: "innerText" },
      { id: request.id },
    ),
  );
  await pending;

  // THEN the break became a space, and a missing `submit` counts as the `false`
  // the extension would have assumed anyway,
  const typeLine = await waitForLogLine((line) => line.startsWith("type selector="), "the type line");
  assert.equal(typeLine, "type selector=input [name=q] chars=2 submit=false tab=42 url=https://example.org/");

  // ... so exactly one physical line starts with the method name.
  const physicalLines = logLines.join("\n").split("\n");
  assert.equal(
    physicalLines.filter((line) => line.startsWith("type selector=")).length,
    1,
    "exactly one type line must reach the log",
  );
});

test("hub_requestWithTypeMethodUnderDebugLogging_shouldRedactThePageTextAndTheElementDescription", async (t) => {
  // GIVEN a hub started with BC_LOG=debug — the setting that writes whole results
  // to stderr — and an answered automatic status request:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a type request is answered — with an invented page text and a `typed`
  // shaped like the `aria-label` form, which is the one that can carry a session
  // token:
  const pending = hub.request(PROTOCOL.METHODS.TYPE, {
    selector: "input#q",
    text: "geheim-testwert",
    submit: true,
  });
  const request = await client.waitForRequest(2);
  const result = {
    tabId: 42,
    url: "https://example.org/",
    title: "Beispielseite",
    typed: 'input[aria-label="suchfeld-sitzungstoken"]',
    submitted: true,
    text: "Zeile eins\n\nZeile zwei",
    truncated: false,
    via: "innerText",
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN the debug block carries the lengths where the page text and the element
  // description were — two `length` rules in the table, one block,
  const debugEntry = await waitFor(
    () =>
      logLines.find(
        (line) => line.includes(`"text": "<${result.text.length} chars>"`) && line.includes('"typed": "<'),
      ) ?? NOT_YET,
    "the redacted type debug result",
  );
  assert.ok(debugEntry.startsWith("{"), "the debug block is the indented JSON result");
  assert.ok(
    debugEntry.includes(`"typed": "<${result.typed.length} chars>"`),
    "`typed` must be redacted to its length",
  );

  // ... in table order, and only the fields this result carries:
  assert.deepEqual(Object.keys(JSON.parse(debugEntry)), [
    "tabId",
    "url",
    "title",
    "typed",
    "submitted",
    "text",
    "truncated",
    "via",
  ]);

  // ... and no line anywhere carries the typed text, the page text or the element
  // description — the unredacted result would have put all three on stderr,
  const joinedLog = logLines.join("\n");
  assert.ok(!joinedLog.includes("geheim-testwert"), "the typed text must not reach the log");
  assert.ok(!joinedLog.includes(result.text), "the page text must not reach the log");
  assert.ok(!joinedLog.includes(result.typed), "the element description must not reach the log");
  assert.ok(!joinedLog.includes("sitzungstoken"), "no token-bearing aria-label may reach the log");

  // ... written once: a second, unredacted block would have leaked the values the
  // lines above just proved absent — the branch has no second writer.
  assert.equal(
    logLines.filter((line) => line.includes('"tabId": 42')).length,
    1,
    "exactly one debug block per result",
  );
});

/* ------------------------------------------------------------------- focus */

test("hub_requestWithFocusMethod_shouldLogOneLineAndOnlyTheWhitelistedFields", async (t) => {
  // GIVEN a hub started with BC_LOG=debug — the setting that writes whole results
  // to stderr — and an answered automatic status request, so the only request in
  // flight below is this test's own:
  const { port, hub, logLines, statusResults, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a focus is answered with the six fields the extension promises:
  const pending = hub.request(PROTOCOL.METHODS.FOCUS, {});
  const request = await client.waitForRequest(2);
  const result = {
    tabId: 42,
    windowId: 1,
    url: "https://example.org/",
    title: "Beispielseite",
    active: true,
    focused: true,
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN exactly one proof line names the tab and its window — and nothing else,
  // because there is no page fact to report:
  const focusLines = logLines.filter((line) => line.startsWith("focus "));
  assert.equal(focusLines.length, 1, "exactly one focus line");
  assert.equal(focusLines[0], `focus tab=42 window=1`);

  // ... the debug block is the whitelist, not the arrived result: every field this
  // result carries is on it, so it is the same block `read` gets — `url` in full,
  // `title` as its length. The line above is the assertion that keeps `url` out of
  // the *line*; this block carries it on purpose, so whether it appears there is a
  // question about the table, not about a leak.
  const debugEntry = logLines.find((line) => line.includes('"focused": true'));
  assert.ok(debugEntry !== undefined, "the debug block carries the result");
  assert.ok(debugEntry.startsWith("{"), "the debug block is the indented JSON result");
  const expectedBlock = {
    tabId: 42,
    windowId: 1,
    url: "https://example.org/",
    title: `<${result.title.length} chars>`,
    active: true,
    focused: true,
  };
  assert.deepEqual(JSON.parse(debugEntry), expectedBlock);
  assert.deepEqual(Object.keys(JSON.parse(debugEntry)), Object.keys(expectedBlock), "table order, not result order");

  // ... and `focus` does not feed the `status` seam.
  assert.deepEqual(statusResults, [{ windows: [] }]);
});

/* -------------------------------------------------- open_tab / close_tab */

test("hub_requestWithOpenTabMethod_shouldLogTabAndUrlWithoutTheTitle", async (t) => {
  // GIVEN a hub started with BC_LOG=debug — the setting that would write a whole
  // result to stderr — and an answered automatic status request:
  const { port, hub, logLines, statusResults, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN an `open_tab` is answered with the three fields the extension promises,
  // and the title is one that would stand out anywhere in the log:
  const pending = hub.request(PROTOCOL.METHODS.OPEN_TAB, { url: "https://example.org/" });
  const request = await client.waitForRequest(2);
  const result = { tabId: 31, url: "https://example.org/", title: "Kontoauszug Maerz" };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN exactly one proof line names the new tab and the address, worded as the
  // spec words it,
  const openLines = logLines.filter((line) => line.startsWith("open "));
  assert.equal(openLines.length, 1, "exactly one open line");
  assert.equal(openLines[0], "open tab=31 url=https://example.org/");

  // ... the title is nowhere: it is page content, and the line owes the operator
  // the tab, not what the tab happens to display. This holds under debug logging
  // too, which is the half a `#logDebugResult` in the branch would break,
  assert.deepEqual(
    logLines.filter((line) => line.includes(result.title)),
    [],
    "the tab title must not reach the log",
  );

  // ... and `open_tab` does not feed the `status` seam.
  assert.deepEqual(statusResults, [{ windows: [] }]);
});

test("hub_requestWithCloseTabMethod_shouldLogTheTabOfTheResultAndNoDebugBlock", async (t) => {
  // GIVEN the same debug-logging hub with an answered status request:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a `close_tab` without a `tab` is answered — the request names no id at
  // all, so the line can only come from the result:
  const pending = hub.request(PROTOCOL.METHODS.CLOSE_TAB, {});
  const request = await client.waitForRequest(2);
  const result = { tabId: 31, closed: true };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN exactly one proof line names the tab that went away,
  const closeLines = logLines.filter((line) => line.startsWith("close "));
  assert.equal(closeLines.length, 1, "exactly one close line — the branch must not be missing");
  assert.equal(closeLines[0], "close tab=31");

  // ... and no debug block accompanies it: the line is the whole report, which is
  // also the shape that keeps a tab title out of stderr.
  assert.deepEqual(
    logLines.filter((line) => line.includes('"closed": true')),
    [],
    "close_tab must write no debug block",
  );
});

test("hub_requestStatus_withTwoRequestsInFlightAndReversedAnswers_shouldResolveEachPromiseWithItsOwnResult", async (t) => {
  // GIVEN an authenticated client whose automatic status request is still open:
  const { port, hub } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  await client.waitForMessage(PROTOCOL.TYPES.REQUEST);

  // WHEN two further requests start before either of them is answered,
  const first = hub.requestStatus();
  const second = hub.requestStatus();
  const firstRequest = await client.waitForRequest(2);
  const secondRequest = await client.waitForRequest(3);

  // THEN each drew its own id from the per-session counter:
  assert.equal(firstRequest.id, 2);
  assert.equal(secondRequest.id, 3);
  assert.deepEqual(firstRequest.params, {});
  assert.deepEqual(secondRequest.params, {});

  // WHEN the answers arrive in reverse order relative to the requests,
  const secondResult = { windows: [{ id: 2, tabs: [{ id: 201 }] }] };
  const firstResult = { windows: [{ id: 1, tabs: [{ id: 101 }, { id: 102 }] }] };
  client.socket.send(responseFrame(secondResult, { id: secondRequest.id }));
  client.socket.send(responseFrame(firstResult, { id: firstRequest.id }));

  // THEN each promise resolves with the result that belongs to its own id:
  assert.deepEqual(await second, secondResult);
  assert.deepEqual(await first, firstResult);
});

test("hub_requestStatusWithoutAnyConnectedExtension_shouldRejectWithExtensionUnavailable", async (t) => {
  // GIVEN a hub nobody has connected to,
  const { hub } = await startHubServer(t);

  // WHEN a status request is made,
  // THEN it is rejected as unavailable instead of hanging until a timer:
  await assert.rejects(hub.requestStatus(), (error) => {
    assert.ok(error instanceof HubRequestError, "the rejection must be a HubRequestError");
    assert.equal(error.name, "ExtensionUnavailable");
    // Only `ExtensionError` carries a code, so an absent one is part of the shape:
    assert.equal(error.code, undefined);
    return true;
  });
});

test("hub_requestStatusWithoutAnAnswerWithinTheCallTimeout_shouldRejectWithExtensionTimeoutAndStillLogTheTimeout", async (t) => {
  // GIVEN a hub with a 200 ms status deadline and a client that stays silent:
  const { port, hub, waitForLogLine } = await startHubServer(t, { BC_CALL_TIMEOUT_MS: "200" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  await client.waitForMessage(PROTOCOL.TYPES.REQUEST);

  // WHEN a status request gets no answer in time,
  // THEN the promise rejects as a timeout,
  await assert.rejects(hub.requestStatus(), { name: "ExtensionTimeout" });

  // ... the log line of the old increment still appears, and the connection is
  // kept — a slow answer is not a broken peer:
  const timeoutLine = await waitForLogLine((line) => line.startsWith("status timeout"), "the status timeout line");
  assert.match(timeoutLine, /^status timeout peer=\S+$/);
  assert.equal(client.closeEvent, null);
});

test("hub_requestStatusAnsweredWithOkFalse_shouldRejectWithExtensionErrorCarryingTheCode", async (t) => {
  // GIVEN an authenticated client and a status request in flight,
  const { port, hub, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  const pending = hub.requestStatus();
  const request = await client.waitForRequest(2);

  // WHEN it answers `ok:false` with the extension's own code,
  client.socket.send(
    responseFrame({ code: "permission_denied", message: "the operator said no" }, { ok: false, id: request.id }),
  );

  // THEN the promise carries both the failure kind and that code,
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof HubRequestError, "the rejection must be a HubRequestError");
    assert.equal(error.name, "ExtensionError");
    assert.equal(error.code, "permission_denied");
    return true;
  });

  // ... the log line stays as it was, and the connection survives:
  const failedLine = await waitForLogLine((line) => line.startsWith("status failed"), "the status failed line");
  assert.match(failedLine, /^status failed peer=\S+ code=permission_denied$/);
  assert.equal(client.closeEvent, null);
});

test("hub_requestAnsweredWithOkFalse_shouldRejectWithTheExtensionErrorAttached", async (t) => {
  // GIVEN an authenticated client and a read request in flight,
  const { port, hub, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));

  // The peer comes from an earlier line of the same connection, so the expected
  // failure line below can be a literal comparison instead of a pattern that
  // would tolerate an appended address:
  const connectedLine = await waitForLogLine(
    (line) => line.startsWith("extension connected"),
    "the extension connected line",
  );
  const connectedMatch = /^extension connected peer=(\S+) protocol=\S+$/.exec(connectedLine);
  assert.ok(connectedMatch !== null, `unexpected connected line: ${connectedLine}`);
  const peer = connectedMatch[1];

  const pending = hub.request(PROTOCOL.METHODS.READ, { tabId: 5 });
  const request = await client.waitForRequest(2);

  // WHEN the extension answers `ok:false` with the three extra fields it sends for
  // an unreadable page (an invented address — this repo carries no real one),
  const extensionError = {
    code: "not_readable",
    message: "the page could not be read",
    url: "https://example.org/preisliste.pdf?token=1",
    kind: "pdf",
    contentType: "application/pdf",
  };
  client.socket.send(responseFrame(extensionError, { ok: false, id: request.id }));

  // THEN the rejection hands the extension's whole error object through as
  // `details`, so `bridge/mcp.mjs` can read `url`, `kind` and `contentType` off it:
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof HubRequestError, "the rejection must be a HubRequestError");
    assert.equal(error.name, "ExtensionError");
    assert.equal(error.code, "not_readable");
    assert.deepEqual(error.details, extensionError);
    return true;
  });

  // ... while the log line is byte for byte the line it was before the details
  // existed. The address may carry credentials in its query, so it is the one
  // thing that must never appear here:
  const failedLine = await waitForLogLine((line) => line.startsWith("read failed"), "the read failed line");
  assert.equal(failedLine, `read failed peer=${peer} code=not_readable`);
});

test(
  "hub_withAnOpenRequestWhenThePeerDisconnects_shouldRejectWithExtensionUnavailableAndLogNoGhostTimeout",
  // A hub without the `#rejectAllPending` call leaves the promise pending
  // forever, and a pending promise hangs the suite instead of failing it. This
  // deadline is the difference between red and stuck: generous against the two
  // short delays below, far shorter than a hung runner.
  { timeout: 15_000 },
  async (t) => {
    // GIVEN a hub with a 200 ms status deadline — short enough that a timer which
    // survived the close would fire inside this test:
    const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_CALL_TIMEOUT_MS: "200" });
    const client = await connectClient(t, port);
    client.socket.send(helloFrame(TOKEN));
    const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);

    // The automatic request is answered *before* the second one starts. With it
    // settled there is exactly one armed timer left in this test — the one of
    // the request below — so "no ghost timeout" is a statement about the close,
    // not about winning a 200 ms race against a second request in flight.
    client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
    await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

    // WHEN a status request is in flight and the peer then disconnects,
    const pending = hub.requestStatus();
    await client.waitForRequest(2);

    // The expectation is attached *before* the close: the rejection happens while
    // the disconnect is in flight, and a handler added afterwards would make Node
    // report an unhandled rejection for the gap in between.
    const rejection = assert.rejects(pending, { name: "ExtensionUnavailable" });

    client.socket.close();
    await client.waitForClose();

    // THEN the request fails immediately instead of staying pending until the
    // timer would have fired,
    await rejection;

    // ... and no timer survived the close: well past the deadline there is not a
    // single "status timeout" line, which is where a ghost of the closed
    // request's timer would show up.
    await delay(400);
    assert.deepEqual(
      logLines.filter((line) => line.startsWith("status timeout")),
      [],
    );
  },
);

test("hub_requestStatusWhenTheRequestCannotBeSent_shouldRejectImmediatelyWithExtensionUnavailable", async (t) => {
  // GIVEN a hub whose connection drops writes on demand — the window between the
  // hub's `isOpen` check and its write, which a real socket only opens by luck:
  let refuseWrites = false;
  const { port, hub, waitForLogLine } = await startHubServer(
    t,
    {},
    {
      wrapConnection: (connection) => ({
        get isOpen() {
          return connection.isOpen;
        },
        on: (event, handler) => connection.on(event, handler),
        close: (code, reason) => connection.close(code, reason),
        send: (text) => (refuseWrites ? false : connection.send(text)),
      }),
    },
  );
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  // Answered first, so the only request in flight below is this test's own:
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN the socket is gone by the time the request is written,
  refuseWrites = true;

  // THEN the promise is rejected right away instead of waiting out the 10 s
  // timer for an answer that can never come:
  await assert.rejects(hub.requestStatus(), (error) => {
    assert.ok(error instanceof HubRequestError, "the rejection must be a HubRequestError");
    assert.equal(error.name, "ExtensionUnavailable");
    assert.match(error.message, /could not be sent/);
    return true;
  });
});

/* ---------------------------------------------------------------- navigate */

test("hub_requestWithNavigateMethod_shouldResolveByItsIdLogOneLineAndLeaveOnStatusAlone", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, statusResults, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a navigate request is made,
  const pending = hub.request(PROTOCOL.METHODS.NAVIGATE, { url: "https://example.org/" });
  const request = await client.waitForRequest(2);

  // THEN it goes out under its own method with its own params:
  assert.deepEqual(request, {
    type: PROTOCOL.TYPES.REQUEST,
    id: 2,
    method: "navigate",
    params: { url: "https://example.org/" },
  });

  // WHEN the answer arrives addressed by that id,
  const result = {
    tabId: 42,
    windowId: 1,
    url: "https://example.org/",
    title: "Example Domain",
    complete: true,
  };
  client.socket.send(responseFrame(result, { id: request.id }));

  // THEN the promise resolves with the result and the proof line is written —
  // while `onStatus` stays a `status`-only seam and must not see a navigation:
  assert.deepEqual(await pending, result);
  await waitForLogLine(
    (line) => line === "navigate tab=42 url=https://example.org/ complete=true",
    "the navigate line",
  );
  assert.deepEqual(statusResults, [{ windows: [] }]);
});

test("hub_requestNavigateAnsweredWithOkFalse_shouldRejectWithExtensionErrorCarryingTheCode", async (t) => {
  // GIVEN an authenticated client and a navigate request in flight,
  const { port, hub, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  const pending = hub.request(PROTOCOL.METHODS.NAVIGATE, { url: "https://example.org/" });
  const request = await client.waitForRequest(2);

  // WHEN the extension answers `ok:false` with its own code,
  client.socket.send(
    responseFrame({ code: "navigate_failed", message: "tabs.create failed" }, { ok: false, id: request.id }),
  );

  // THEN the rejection is an `ExtensionError` carrying exactly that code,
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof HubRequestError, "the rejection must be a HubRequestError");
    assert.equal(error.name, "ExtensionError");
    assert.equal(error.code, "navigate_failed");
    return true;
  });

  // ... the failure line is named after the method, and the connection lives on:
  const failedLine = await waitForLogLine(
    (line) => line.startsWith("navigate failed"),
    "the navigate failed line",
  );
  assert.match(failedLine, /^navigate failed peer=\S+ code=navigate_failed$/);
  assert.equal(client.closeEvent, null);
});

test("hub_withStatusAndNavigateInFlight_shouldResolveEachByItsIdWhenTheAnswersArriveInReverse", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, statusResults, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a status and a navigate request overlap,
  const statusPending = hub.requestStatus();
  const navigatePending = hub.request(PROTOCOL.METHODS.NAVIGATE, { url: "https://example.org/" });
  const statusRequest = await client.waitForRequest(2);
  const navigateRequest = await client.waitForRequest(3);

  // THEN each carries the method it was asked for:
  assert.equal(statusRequest.method, PROTOCOL.METHODS.STATUS);
  assert.equal(navigateRequest.method, PROTOCOL.METHODS.NAVIGATE);

  // WHEN the answers arrive in reverse order relative to the requests,
  const navigateResult = {
    tabId: 7,
    windowId: 1,
    url: "https://example.org/",
    title: "Example Domain",
    complete: false,
  };
  const statusResult = { windows: [{ id: 1, tabs: [{ id: 101 }] }] };
  client.socket.send(responseFrame(navigateResult, { id: navigateRequest.id }));
  client.socket.send(responseFrame(statusResult, { id: statusRequest.id }));

  // THEN each promise gets the result of its own id, and each answer is logged
  // under the method its pending entry remembered — not under a shared name:
  assert.deepEqual(await navigatePending, navigateResult);
  assert.deepEqual(await statusPending, statusResult);
  await waitForLogLine((line) => line.startsWith("navigate tab=7"), "the navigate line");
  await waitForLogLine((line) => line === "status windows=1 tabs=1", "the status line");
  assert.deepEqual(statusResults, [{ windows: [] }, statusResult]);
});

/* ---------------------------------------------------------------- inspect */

test("hub_requestWithInspectMethod_shouldLogOneLineWithoutElementText", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, logLines, statusResults, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN an inspect goes out with a selector and without a text filter — the
  // element is invented, so nobody's page is in this test:
  const pending = hub.request(PROTOCOL.METHODS.INSPECT, { selector: "a#cart-link" });
  const request = await client.waitForRequest(2);
  const element = {
    index: 0,
    tag: "a",
    text: "Erfundene Warenkorbaufschrift",
    id: "cart-link",
    classes: ["knopf"],
    href: "https://example.org/erfunden",
    ariaLabel: "",
    selector: "a#cart-link",
    visible: true,
    disabled: false,
    rect: { x: 1, y: 2, width: 3, height: 4 },
  };
  const result = {
    tabId: 42,
    url: "https://example.org/",
    title: "Beispielseite",
    count: 1,
    truncated: false,
    elements: [element],
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN exactly one line names the filter of the request, the unset one as the
  // spec's `-`, and the hit count,
  const inspectLines = logLines.filter((line) => line.startsWith("inspect "));
  assert.equal(inspectLines.length, 1, "exactly one inspect line");
  assert.equal(inspectLines[0], "inspect selector=a#cart-link text=- found=1");

  // ... and the element text reaches no logged line at all — the line reports the
  // count, never the hits themselves,
  const joinedLog = logLines.join("\n");
  assert.ok(!joinedLog.includes(element.text), "the element text must not reach the log");
  assert.ok(!joinedLog.includes("Erfundene"), "no fragment of the element text may reach the log");

  // ... and `inspect` does not feed the `status` seam.
  assert.deepEqual(statusResults, [{ windows: [] }]);
});

test("hub_requestWithInspectMethodWithDebugLog_shouldRedactEveryPageString", async (t) => {
  // GIVEN a hub started with BC_LOG=debug — the setting that writes whole results
  // to stderr — and an answered automatic status request:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN an inspect is answered with an element whose strings are all invented
  // page content — including a `selector` built from an `aria-label`, the one
  // field that hides page text inside a selector string:
  const pending = hub.request(PROTOCOL.METHODS.INSPECT, { text: "warenkorb" });
  const request = await client.waitForRequest(2);
  const element = {
    index: 0,
    tag: "a",
    text: "Erfundene Aufschrift",
    id: "cart-link",
    classes: ["knopf", "knopf--gross"],
    href: "https://example.org/erfunden",
    ariaLabel: "Erfundene Aufschrift im Warenkorb",
    selector: 'a[aria-label="Erfundene Aufschrift im Warenkorb"]',
    visible: true,
    disabled: false,
    rect: { x: 1, y: 2, width: 3, height: 4 },
  };
  const result = {
    tabId: 42,
    url: "https://example.org/",
    title: "Beispielseite",
    count: 1,
    truncated: false,
    elements: [element],
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);

  // THEN exactly one debug block is written for this result,
  const debugEntries = logLines.filter((line) => line.includes('"tabId": 42'));
  assert.equal(debugEntries.length, 1, "exactly one debug block per result");
  const debugBlock = JSON.parse(debugEntries[0]);
  const debuggedElement = debugBlock.elements[0];

  // ... every page string of the element is now a length,
  assert.equal(debuggedElement.text, `<${element.text.length} chars>`);
  assert.equal(debuggedElement.href, `<${element.href.length} chars>`);
  assert.equal(debuggedElement.id, `<${element.id.length} chars>`);
  assert.equal(debuggedElement.ariaLabel, `<${element.ariaLabel.length} chars>`);
  assert.equal(debuggedElement.selector, `<${element.selector.length} chars>`);

  // ... the class list too, entry by entry,
  assert.deepEqual(
    debuggedElement.classes,
    element.classes.map((name) => `<${name.length} chars>`),
    "each class name must be redacted",
  );

  // ... while the shape of the hit and the tab stay readable — `url` in full
  // because six log lines print it beside the block anyway, `title` as its length
  // like in every block but `status`,
  assert.equal(debuggedElement.index, 0);
  assert.equal(debuggedElement.tag, "a");
  assert.equal(debuggedElement.visible, true);
  assert.equal(debuggedElement.disabled, false);
  assert.deepEqual(debuggedElement.rect, element.rect);
  assert.equal(debugBlock.url, "https://example.org/");
  assert.equal(debugBlock.title, `<${result.title.length} chars>`);

  // ... and no logged line carries any of the page strings. The filter from the
  // request is allowed to appear — it is input, not page content:
  const joinedLog = logLines.join("\n");
  assert.ok(!joinedLog.includes("Erfundene"), "text, ariaLabel and selector must not reach the log");
  assert.ok(!joinedLog.includes("example.org/erfunden"), "the element href must not reach the log");
  assert.ok(!joinedLog.includes("cart-link"), "the element id must not reach the log");
  assert.ok(!joinedLog.includes("knopf"), "the class names must not reach the log");
  assert.ok(joinedLog.includes("inspect selector=- text=warenkorb found=1"), "the filter itself stays raw");
});

test("hub_requestWithInspectMethodWithAnUnlistedElementFieldUnderDebugLog_shouldPrintTheMarkerThere", async (t) => {
  // GIVEN a hub started with BC_LOG=debug and an answered automatic status request:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN an inspect answer carries an element field the element shape does not
  // name — the shape a field added by a future extension version would have:
  const pending = hub.request(PROTOCOL.METHODS.INSPECT, { text: "warenkorb" });
  const request = await client.waitForRequest(2);
  client.socket.send(
    responseFrame(
      {
        tabId: 42,
        url: "https://example.org/",
        title: "Beispielseite",
        count: 1,
        truncated: false,
        elements: [{ index: 0, tag: "a", text: "Erfundene Aufschrift", surpriseInside: "geheim" }],
      },
      { id: request.id },
    ),
  );
  await pending;

  // THEN the marker lands *inside* the element — the nesting is projected field by
  // field, so one unknown field does not turn the whole hit into a marker,
  const debugEntry = await waitFor(
    () => logLines.find((line) => line.includes('"surpriseInside": "<unlisted field>"')) ?? NOT_YET,
    "the debug block with the unlisted element field",
  );
  const debuggedElement = JSON.parse(debugEntry).elements[0];
  assert.equal(debuggedElement.surpriseInside, "<unlisted field>");
  assert.equal(Object.keys(debuggedElement).at(-1), "surpriseInside", "unlisted fields hang at the end of the element");

  // ... and it does not drag a value or a length of its own onto stderr:
  const joinedLog = logLines.join("\n");
  assert.ok(!joinedLog.includes("geheim"), "an unlisted element value must never reach the log");
  assert.ok(!joinedLog.includes("Erfundene"), "the element text must not reach the log either");
});

/* ------------------------------------------------------------------- eval */

// The code and the result of the log-hygiene case are two markers, not the same
// string: one assertion that misses both would look like two that pass.
const EVAL_CODE_MARKER = "data-probe";
const EVAL_RESULT_MARKER = "probe-antwort";

test("hub_eval_shouldResolveByItsIdAndKeepOnStatusQuiet", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, statusResults, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN an eval request is made with a code body,
  const code = `document.body.dataset.probe = "${EVAL_CODE_MARKER}"; return 1`;
  const pending = hub.request(PROTOCOL.METHODS.EVAL, { code });
  const request = await client.waitForRequest(2);

  // THEN it goes out under its own method, carrying the code as sent — the hub
  // passes the body through instead of judging it:
  assert.deepEqual(request, {
    type: PROTOCOL.TYPES.REQUEST,
    id: 2,
    method: "eval",
    params: { code },
  });

  // WHEN the answer arrives addressed by that id,
  const result = {
    tabId: 18,
    url: "https://example.org/",
    title: "Beispielseite",
    elapsedMs: 4,
    result: 1,
  };
  client.socket.send(responseFrame(result, { id: request.id }));

  // THEN the promise resolves with the result as it came, and the `status` seam
  // stays a `status`-only seam:
  assert.deepEqual(await pending, result);
  await waitForLogLine((line) => line === "eval tab=18 elapsedMs=4 ok=true", "the eval line");
  assert.deepEqual(statusResults, [{ windows: [] }]);
});

test("hub_eval_shouldLogOnlyTabElapsedAndOk", async (t) => {
  // GIVEN a hub started with BC_LOG=debug — the setting that writes whole results
  // to stderr, and the only level at which a debug block could leak what the line
  // leaves out. With the default `info` this case would be blind to it:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN an eval is answered with a code and a result that both carry page-shaped
  // content — the code writes a marker into the DOM, the result is that marker:
  const code = `document.body.dataset.probe = "${EVAL_CODE_MARKER}"; return "${EVAL_RESULT_MARKER}"`;
  const pending = hub.request(PROTOCOL.METHODS.EVAL, { code });
  const request = await client.waitForRequest(2);
  const result = {
    tabId: 18,
    url: "https://example.org/",
    title: "Beispielseite",
    elapsedMs: 4,
    result: EVAL_RESULT_MARKER,
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);
  await waitForLogLine((line) => line === "eval tab=18 elapsedMs=4 ok=true", "the eval line");

  // THEN exactly one line is written for this answer — no debug block beside it,
  const evalLines = logLines.filter((line) => line.startsWith("eval "));
  assert.equal(evalLines.length, 1, "exactly one eval line and no debug block");
  assert.equal(evalLines[0], "eval tab=18 elapsedMs=4 ok=true");

  // ... and neither the code nor the result reaches any logged line, not even at
  // the debug level the hub was started with:
  const joinedLog = logLines.join("\n");
  assert.ok(!joinedLog.includes(EVAL_CODE_MARKER), "the code must not reach the log");
  assert.ok(!joinedLog.includes(EVAL_RESULT_MARKER), "the result must not reach the log");
});

test("hub_eval_withOkFalse_shouldRejectWithTheExtensionsCode", async (t) => {
  // GIVEN an authenticated client and an eval request in flight,
  const { port, hub, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  const pending = hub.request(PROTOCOL.METHODS.EVAL, { code: "return 1" });
  const request = await client.waitForRequest(2);

  // WHEN the extension answers `ok:false` with its own code,
  client.socket.send(
    responseFrame(
      { code: "eval_not_allowed", message: "Code-Auswertung ist in den Einstellungen der Erweiterung nicht erlaubt." },
      { ok: false, id: request.id },
    ),
  );

  // THEN the rejection is an `ExtensionError` carrying exactly that code,
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof HubRequestError, "the rejection must be a HubRequestError");
    assert.equal(error.name, "ExtensionError");
    assert.equal(error.code, "eval_not_allowed");
    return true;
  });

  // ... the failure line is named after the method, no `eval tab=` line is
  // written for a refusal, and the connection lives on:
  const failedLine = await waitForLogLine((line) => line.startsWith("eval failed"), "the eval failed line");
  assert.match(failedLine, /^eval failed peer=\S+ code=eval_not_allowed$/);
  assert.equal(client.closeEvent, null);
});

/* ------------------------------------------------------------- screenshot */

// Both format magics in one invented string on purpose: a debug block that printed
// the base64 of a *successful* screenshot would carry whichever one the picture
// happened to be, and a needle that can only ever match one of them would leave half
// the leak unpinned. Nothing here is a real image — the point is that the hub must
// not put these characters in the log at all.
const SCREENSHOT_BASE64_MARKER = "iVBORw0KGgoAAAANSUhEUg/9j/4AAQSkZJRg";

test("hub_screenshot_shouldResolveByItsIdAndLogOneLineWithoutThePicture", async (t) => {
  // GIVEN an authenticated client whose automatic status request is answered,
  const { port, hub, waitForLogLine } = await startHubServer(t);
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a screenshot is requested for tab 4,
  const pending = hub.request(PROTOCOL.METHODS.SCREENSHOT, { tab: 4 });
  const request = await client.waitForRequest(2);

  // THEN it goes out under its own method with the tab as sent — the hub adds no
  // parameter of its own, and `format`/`quality` are the extension's ladder:
  assert.deepEqual(request, {
    type: PROTOCOL.TYPES.REQUEST,
    id: 2,
    method: "screenshot",
    params: { tab: 4 },
  });

  // WHEN the extension answers with the picture addressed by that id,
  const result = {
    tabId: 4,
    url: "https://example.org/",
    title: "Beispielseite",
    format: "jpeg",
    width: 1600,
    height: 900,
    bytes: 214311,
    scaled: true,
    activated: false,
    base64: SCREENSHOT_BASE64_MARKER,
  };
  client.socket.send(responseFrame(result, { id: request.id }));

  // THEN the promise resolves with the result as it came — the base64 included,
  // because the caller needs the picture and only the log must not have it,
  assert.deepEqual(await pending, result);

  // ... and the one line says tab, size, format and state, in that order:
  await waitForLogLine(
    (line) => line === "screenshot tab=4 bytes=214311 format=jpeg scaled=true ok=true",
    "the screenshot line",
  );
});

test("hub_screenshot_shouldLogExactlyOneLineAndNoBase64EvenAtTheDebugLevel", async (t) => {
  // GIVEN a hub started with BC_LOG=debug — the setting that writes whole results to
  // stderr, and the only level at which a debug block could leak the picture. With
  // the default `info` this case would be blind to it:
  const { port, hub, logLines, waitForLogLine } = await startHubServer(t, { BC_LOG: "debug" });
  const client = await connectClient(t, port);
  client.socket.send(helloFrame(TOKEN));
  const autoRequest = await client.waitForMessage(PROTOCOL.TYPES.REQUEST);
  client.socket.send(responseFrame({ windows: [] }, { id: autoRequest.id }));
  await waitForLogLine((line) => line === "status windows=0 tabs=0", "the automatic status line");

  // WHEN a screenshot is answered with a picture-shaped result,
  const pending = hub.request(PROTOCOL.METHODS.SCREENSHOT, { tab: 4 });
  const request = await client.waitForRequest(2);
  const result = {
    tabId: 4,
    url: "https://example.org/",
    title: "Beispielseite",
    format: "png",
    width: 1280,
    height: 720,
    bytes: 48211,
    scaled: false,
    activated: false,
    base64: SCREENSHOT_BASE64_MARKER,
  };
  client.socket.send(responseFrame(result, { id: request.id }));
  assert.deepEqual(await pending, result);
  await waitForLogLine(
    (line) => line === "screenshot tab=4 bytes=48211 format=png scaled=false ok=true",
    "the screenshot line",
  );

  // THEN exactly one line is written for this answer — no debug block beside it,
  // not even a shortened one:
  const screenshotLines = logLines.filter((line) => line.startsWith("screenshot "));
  assert.equal(screenshotLines.length, 1, "exactly one screenshot line and no debug block");
  assert.equal(screenshotLines[0], "screenshot tab=4 bytes=48211 format=png scaled=false ok=true");

  // ... and no logged line carries a base64 fragment, in either format magic: a
  // base64 string *is* the picture, so `BC_LOG=debug` must not turn the journal into
  // an image store (criterion 11, measured locally):
  const joinedLog = logLines.join("\n");
  assert.ok(!joinedLog.includes("iVBORw0"), "the PNG magic must not reach the log");
  assert.ok(!joinedLog.includes("/9j/"), "the JPEG magic must not reach the log");
});
