/**
 * One bridge, two transports, the same answers — proven by comparison.
 *
 * `test/http-transport.test.js` pins the transport against a stub tool set and
 * `test/mcp.test.js` pins the protocol over stdio. What neither can show is the
 * property this file exists for: a single running bridge, with a real extension
 * connection, answers `tools/list` and `tools/call` identically over stdin and
 * over `POST /mcp`. That is acceptance criterion 2 as a comparison instead of a
 * claim.
 *
 * The second case is the harness-neutrality proof: a plain HTTP client that
 * knows nothing but the protocol — no harness, no session bookkeeping — has to
 * find a complete MCP server, and the texts it reads must not name a harness.
 *
 * The third property is capacity: the picture limit (3 MiB) is four times the request
 * limit (1 MiB), so the transport has to carry a *response* far larger than any request
 * it would ever accept — a direction a status-line case never exercises
 * (spec 21, criterion 6).
 *
 * The child gets `stdin: "pipe"` because this file uses both channels; ports are
 * the pair reserved for this file in `test/ports.js`, because the operator's real
 * bridge holds 8110 and 8111 and a port search hides a collision instead of
 * showing it (docs/18, "feste Ports, keine Suche").
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { STATUS_RESULT } from "./fixtures/fake-extension.mjs";
import { HTTP_MCP } from "./ports.js";

const BRIDGE_PATH = path.resolve(import.meta.dirname, "../bridge/bridge.mjs");
const FAKE_EXTENSION_PATH = path.resolve(import.meta.dirname, "fixtures/fake-extension.mjs");

const EVENT_TIMEOUT_MS = 10_000;
// How long the bridge may take to announce its listeners. Not a retry budget:
// the spawn happens once, and the ports are fixed.
const READY_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const PORT_POLL_INTERVAL_MS = 20;

// The thirteen tools of the contract. Duplicated on purpose: a test that imports the
// count it asserts cannot notice a table that lost a tool.
const TOOL_COUNT = 13;

// The indented JSON the fixture's status result must arrive as, so "the same
// answer" is compared against a known value and not just against itself.
const INDENTED_STATUS_RESULT = JSON.stringify(STATUS_RESULT, null, 2);

// The largest picture the contract promises to carry, in decoded bytes, and the length
// of its base64: 3 145 728 × 4/3 = 4 194 304 characters, no padding, because the byte
// count is a multiple of three. Both are literals for the same reason the port table is:
// a value derived from the bridge's own limit would follow the next number change and
// stay green while proving nothing about the picture that arrived.
const THREE_MEBIBYTE_PICTURE_BYTES = 3_145_728;
const THREE_MEBIBYTE_BASE64_LENGTH = 4_194_304;

// The journal line that picture has to leave behind — built here, not in the bridge, so
// a formatter that lost a field fails instead of quietly agreeing with itself.
const THREE_MEBIBYTE_JOURNAL_LINE =
  "screenshot tab=20 bytes=3145728 format=png scaled=false ok=true";

// Words a client reads in the contract must not mention a harness: the endpoint
// is a service any MCP client may use, not a private adapter for one of them.
// Matched as whole words — "pi" is two letters and lives inside half the
// dictionary.
const HARNESS_NAMES = Object.freeze(["pi", "claude", "cursor", "copilot"]);
const HARNESS_PATTERNS = Object.freeze(
  HARNESS_NAMES.map((name) => ({ name, pattern: new RegExp(`\\b${name}\\b`, "i") })),
);

// Generated per run: a literal would violate the "no secrets in the repo" rule,
// and `randomBytes(16)` gives exactly the 32 hex characters `readToken` wants.
const TOKEN = randomBytes(16).toString("hex");

const TIMED_OUT = Symbol("timed out");

/* ------------------------------------------------------------------ processes */

function startProcess(scriptPath, env, args = []) {
  // Only the variables the test sets: a stray `BC_LOG=debug` in the developer's
  // shell must not decide what is measured here.
  const child = spawn(process.execPath, [scriptPath, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  // A write to a child that already died raises EPIPE here; that is a real
  // failure, but it belongs to the waiting helper that reports with the child's
  // output, not to an unhandled stream error that kills the test process.
  child.stdin.on("error", () => {});

  // `close`, not `exit`: only `close` guarantees that both pipes were drained.
  const exit = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  return { child, output, exit };
}

function isRunning(handle) {
  return handle.child.exitCode === null && handle.child.signalCode === null;
}

async function raceExit(handle, timeoutMs) {
  // The timeout promise is unref'd: a pending timer must not keep the test
  // process alive after the child is long gone.
  return Promise.race([handle.exit, delay(timeoutMs, TIMED_OUT, { ref: false })]);
}

/** Best-effort teardown for `t.after`: nothing here may throw. */
async function killQuietly(handle) {
  if (!isRunning(handle)) return;
  handle.child.kill("SIGTERM");
  const result = await raceExit(handle, CLEANUP_TIMEOUT_MS);
  if (result === TIMED_OUT) handle.child.kill("SIGKILL");
}

/** SIGTERMs the child and returns its exit code; a hung process fails the case. */
async function stopWithSigterm(handle) {
  if (isRunning(handle)) handle.child.kill("SIGTERM");

  const result = await raceExit(handle, EXIT_TIMEOUT_MS);
  if (result === TIMED_OUT) {
    handle.child.kill("SIGKILL");
    throw new Error(`the bridge ignored SIGTERM for ${EXIT_TIMEOUT_MS} ms:\n${handle.output.stderr}`);
  }
  return result.code;
}

/* -------------------------------------------------------------------- waiting */

function findLine(text, matcher) {
  return text.split("\n").find((line) => matcher.test(line));
}

/**
 * Polls stderr until `matcher` matches a line, and fails fast when the child is
 * gone — a bridge that exited will never write that line, and waiting out the
 * full deadline would only make a port collision slow instead of red.
 */
async function waitForLine(bridge, matcher, description) {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    if (findLine(bridge.output.stderr, matcher) !== undefined) return;
    if (!isRunning(bridge)) {
      throw new Error(`the bridge exited before ${description}:\n--- bridge stderr ---\n${bridge.output.stderr}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`no ${description} within ${READY_TIMEOUT_MS} ms:\n${bridge.output.stderr}`);
    }
    await delay(PORT_POLL_INTERVAL_MS);
  }
}

/* --------------------------------------------------------------------- bridge */

/**
 * Starts one bridge with `--http`, both listeners on this file's reserved ports,
 * and returns it with `extensionPort` and `httpPort`.
 *
 * Spawned exactly once: if a port is taken the bridge exits 1 within
 * milliseconds, and the readiness wait below turns that into a red test naming
 * both ports and the bridge's stderr. Retrying would only hide the collision.
 */
async function startBridgeWithHttp(t, { tokenFile }) {
  const { extension: extensionPort, http: httpPort } = HTTP_MCP;
  const handle = startProcess(
    BRIDGE_PATH,
    {
      BC_BIND: `127.0.0.1:${extensionPort}`,
      BC_HTTP_PORT: String(httpPort),
      BC_TOKEN_FILE: tokenFile,
    },
    ["--http"],
  );
  // Registered before the wait: a failing wait must not leave a child behind.
  t.after(() => killQuietly(handle));

  await waitForLine(
    handle,
    / for POST \/mcp$/,
    `the MCP endpoint on 127.0.0.1:${httpPort} (extension port ${extensionPort})`,
  );
  return { ...handle, extensionPort, httpPort };
}

function startFakeExtension(t, port, env = {}) {
  const handle = startProcess(FAKE_EXTENSION_PATH, {
    BC_TEST_URL: `ws://127.0.0.1:${port}`,
    BC_TEST_TOKEN: TOKEN,
    ...env,
  });
  t.after(() => killQuietly(handle));
  return handle;
}

function createTokenFile(t) {
  // Outside the working tree on purpose: a token file inside the repo is exactly
  // the kind of leftover that a secret grep finds a month later.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const file = path.join(directory, "token");
  fs.writeFileSync(file, TOKEN, { mode: 0o600 });
  return file;
}

/* ------------------------------------------------------------------- channels */

/**
 * The stdio client: one JSON-RPC message out, the next finished stdout line in.
 *
 * Lines are queued raw and parsed by the reader, so a line that is not JSON fails
 * the awaiting test with a message instead of throwing inside a stream handler.
 */
function createStdioPeer(child) {
  const lines = [];
  const readers = [];
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      deliver(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });

  function deliver(line) {
    const reader = readers.shift();
    if (reader === undefined) {
      lines.push(line);
      return;
    }
    reader(line);
  }

  function nextLine() {
    if (lines.length > 0) return Promise.resolve(lines.shift());

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no answer on stdout within ${EVENT_TIMEOUT_MS} ms`)),
        EVENT_TIMEOUT_MS,
      );
      timer.unref();
      readers.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  return {
    async request(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return JSON.parse(await nextLine());
    },
  };
}

/**
 * One `POST /mcp` with the bearer token, body sent exactly as given.
 *
 * Broken-JSON cases cannot go through `JSON.stringify`: stringifying `{` produces
 * a perfectly valid JSON string and would prove the wrong thing. Nothing here
 * retries — a status other than 200 is the caller's to assert on.
 */
function postMcpText(port, text) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ statusCode: response.statusCode, headers: response.headers, body: chunks.join("") }),
        );
      },
    );
    request.once("error", reject);
    request.end(text);
  });
}

/** `postMcpText` for a JSON-RPC object; the headers come back with the answer. */
function postMcp(port, message) {
  return postMcpText(port, JSON.stringify(message));
}

/** `postMcp` for the happy path, where a non-200 is the failure worth reporting. */
async function requestMcp(port, message) {
  const response = await postMcp(port, message);
  assert.equal(response.statusCode, 200, `POST /mcp answered ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body);
}

/**
 * The answer without its `id`: the two transports answer under different ids
 * because the two requests carry different ones, and nothing else may differ.
 */
function withoutId(message) {
  const { id: _id, ...rest } = message;
  return rest;
}

/**
 * GIVEN-bridge shorthand: a running bridge with a connected fake extension.
 *
 * `extensionEnv` turns the fixture's knobs (`BC_TEST_SCREENSHOT_BYTES` and friends); the
 * default keeps the fixed answers. The connection details are set before the spread for
 * the same reason `test/mcp.test.js` does it — the knobs have their own names, and keeping
 * both files looking alike is worth more than a guard against a hazard nobody has.
 */
async function startBridgeWithExtension(t, extensionEnv = {}) {
  const bridge = await startBridgeWithHttp(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.extensionPort, extensionEnv);
  await waitForLine(bridge, / extension connected /, "extension connection");
  return bridge;
}

/* ---------------------------------------------------------------------- cases */

test("httpMcp_theSameToolsListAndTheSameBrowserStatusCall_shouldAnswerTheSameObjectsOnStdioAndOnHttp", async (t) => {
  // GIVEN one bridge serving both transports, with a fake extension connected:
  const bridge = await startBridgeWithExtension(t);
  const stdio = createStdioPeer(bridge.child);

  // WHEN the same `tools/list` is asked once over stdin and once over `POST /mcp`,
  const stdioList = await stdio.request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const httpList = await requestMcp(bridge.httpPort, { jsonrpc: "2.0", id: 2, method: "tools/list" });

  // THEN both offer the eleven tools of the contract, and the answers are equal
  // once the ids are normalised:
  assert.equal(stdioList.result.tools.length, TOOL_COUNT);
  assert.deepEqual(withoutId(httpList), withoutId(stdioList));

  // WHEN the same `tools/call` on `browser_status` goes both ways,
  const stdioCall = await stdio.request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "browser_status" },
  });
  const httpCall = await requestMcp(bridge.httpPort, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "browser_status" },
  });

  // THEN the answers are equal too — and that shared answer is the extension's
  // own result as indented JSON, so "equal" cannot mean "equally empty":
  assert.deepEqual(withoutId(httpCall), withoutId(stdioCall));
  assert.equal(stdioCall.result.content[0].text, INDENTED_STATUS_RESULT);

  // THEN the process is still one process, and SIGTERM closes both listeners
  // with the service exit code 0:
  assert.equal(await stopWithSigterm(bridge), 0);
});

test("httpMcp_aPlainHttpClientWithNoHarness_shouldInitializeListToolsAndCallBrowserStatus", async (t) => {
  // GIVEN a running bridge and nothing but `node:http` to talk to it — no
  // harness, no session bookkeeping, no stdio:
  const bridge = await startBridgeWithExtension(t);

  // WHEN a plain client performs the protocol handshake over `POST /mcp`,
  const handshake = await postMcp(bridge.httpPort, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "8" } },
  });
  assert.equal(handshake.statusCode, 200, `initialize answered ${handshake.statusCode}: ${handshake.body}`);
  const initialize = JSON.parse(handshake.body);

  // THEN the answer carries no `Mcp-Session-Id`: the service keeps no client
  // state, and a client that got an id would be obliged to echo it on every
  // later request. Asserted on the headers, which is why this step uses the
  // header-preserving helper rather than the body-only one:
  assert.equal(
    handshake.headers["mcp-session-id"],
    undefined,
    `the response invented a session id: ${handshake.headers["mcp-session-id"]}`,
  );

  // THEN the server names itself as the service it is,
  assert.equal(initialize.result.serverInfo.name, "browser-control");
  // ... announces exactly one capability, `tools`,
  assert.deepEqual(Object.keys(initialize.result.capabilities), ["tools"]);
  // ... and echoes the requested protocol version.
  assert.equal(initialize.result.protocolVersion, "2025-06-18");

  // WHEN it then asks for the tools,
  const list = await requestMcp(bridge.httpPort, { jsonrpc: "2.0", id: 2, method: "tools/list" });

  // THEN it gets the whole table without a session that has to be established
  // first:
  assert.equal(list.result.tools.length, TOOL_COUNT);
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    [
      "browser_status",
      "browser_navigate",
      "browser_read",
      "browser_click",
      "browser_type",
      "browser_focus",
      "browser_inspect",
      "browser_open_tab",
      "browser_close_tab",
      "browser_eval",
      "browser_screenshot",
      "browser_frames",
      "browser_transcript",
    ],
  );

  // ... and the newest tool arrives over HTTP with the one field it requires: a
  // client that reads the schema has to know that `code` is mandatory — without it
  // there is nothing to run, and the call is refused as `invalid params`.
  const evalTool = list.result.tools.find((tool) => tool.name === "browser_eval");
  assert.deepEqual(evalTool.inputSchema.required, ["code"]);
  assert.deepEqual(Object.keys(evalTool.inputSchema.properties), ["code", "frame", "tab"]);

  // WHEN it finally calls `browser_status`,
  const call = await requestMcp(bridge.httpPort, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "browser_status" },
  });

  // THEN the tool answers with the extension's result, exactly as stdio would:
  assert.equal(call.result.isError, undefined);
  assert.equal(call.result.content[0].text, INDENTED_STATUS_RESULT);
});

test("httpMcp_withBrokenJsonAndAValidToken_shouldAnswer200WithTheParseErrorCode", async (t) => {
  // GIVEN a running bridge and a caller holding the token,
  const bridge = await startBridgeWithHttp(t, { tokenFile: createTokenFile(t) });

  // WHEN it posts a body that is not JSON at all,
  const answer = await postMcpText(bridge.httpPort, "{");

  // THEN the *transport* succeeded — 200 — and the failure is the protocol's,
  // because a malformed body is not an HTTP mistake:
  assert.equal(answer.statusCode, 200, `POST /mcp answered ${answer.statusCode}: ${answer.body}`);
  assert.equal(answer.headers["content-type"], "application/json");

  // ... named as JSON-RPC's parse error, with `id: null` because there was no
  // readable id:
  const message = JSON.parse(answer.body);
  assert.equal(message.error.code, -32700);
  assert.equal(message.id, null);
});

/*
 * The transport has to carry a whole picture, not just a status line — and the picture
 * limit is four times the request limit. That asymmetry is the point of the case: an
 * answer of 4 MiB of base64 must be a response, because the 1 MiB limit is about what a
 * caller sends, not about what the service answers (spec 21, criterion 6).
 */
test("httpMcp_aScreenshotOfThreeMebibytes_shouldArriveImageShapedAndParsable", async (t) => {
  // GIVEN a fake extension whose capture is exactly the 3 MiB picture limit, as a PNG
  // the ladder never touched, so the journal line below states all four of its fields:
  const bridge = await startBridgeWithExtension(t, {
    BC_TEST_SCREENSHOT_BYTES: String(THREE_MEBIBYTE_PICTURE_BYTES),
  });

  // WHEN `browser_screenshot` is called over `POST /mcp`,
  const response = await postMcp(bridge.httpPort, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "browser_screenshot" },
  });

  // THEN the object is complete before any field is read: a body whose stream lost a
  // chunk would fail right here instead of at an assertion that only looks close.
  assert.equal(
    response.statusCode,
    200,
    `POST /mcp answered ${response.statusCode}: ${response.body.slice(0, 200)}`,
  );
  const result = JSON.parse(response.body).result;

  // THEN the answer is image-shaped, text first:
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");

  // ... the payload is the whole picture — 4 194 304 base64 characters,
  const data = result.content[1].data;
  assert.equal(data.length, THREE_MEBIBYTE_BASE64_LENGTH);
  // ... which decode to the byte count the text block beside it claims, so "3 MiB"
  // means the picture and not the size of the transport's buffer:
  assert.equal(Buffer.from(data, "base64").length, THREE_MEBIBYTE_PICTURE_BYTES);
  assert.equal(JSON.parse(result.content[0].text).bytes, THREE_MEBIBYTE_PICTURE_BYTES);

  // THEN the journal's whole footprint for this picture is one line of numbers: a
  // bridge that logged the payload would write 4 MiB of base64 into every journal it
  // ever keeps. `endsWith` because the line arrives behind a timestamp, and the exact
  // count because a second line would mean the answer was reported twice.
  const journalLines = bridge.output.stderr.split("\n").filter((line) => line.includes(" screenshot "));
  assert.equal(journalLines.length, 1, `expected one screenshot line, got ${journalLines.length}`);
  assert.ok(
    journalLines[0].endsWith(THREE_MEBIBYTE_JOURNAL_LINE),
    `the screenshot line is not the numbers alone: ${journalLines[0].slice(0, 200)}`,
  );
  assert.ok(!bridge.output.stderr.includes("iVBORw0"), "the journal carries the picture's base64");
});

test("httpMcp_everyToolTextAndTheServerInfo_shouldNameNoHarness", async (t) => {
  // GIVEN a running bridge and a client that reads the contract it publishes:
  const bridge = await startBridgeWithExtension(t);
  const initialize = await requestMcp(bridge.httpPort, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const list = await requestMcp(bridge.httpPort, { jsonrpc: "2.0", id: 2, method: "tools/list" });

  // WHEN the texts that a foreign client actually sees are searched for harness
  // names — tool names, descriptions and schemas on one side, `serverInfo` on the
  // other,
  const publishedTexts = {
    tools: JSON.stringify(list.result.tools),
    serverInfo: JSON.stringify(initialize.result.serverInfo),
  };

  // THEN not one of them mentions a harness, so the endpoint stays a service
  // rather than an adapter for a single product:
  for (const [where, text] of Object.entries(publishedTexts)) {
    for (const { name, pattern } of HARNESS_PATTERNS) {
      assert.ok(!pattern.test(text), `${where} names "${name}": ${text.slice(0, 200)}`);
    }
  }
});
