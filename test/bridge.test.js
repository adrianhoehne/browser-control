/**
 * The bridge as a child process with a fake extension as its peer.
 *
 * Every other file in `test/` exercises modules in-process. This one is about
 * the entry point itself: that `bridge/bridge.mjs` starts, listens on the
 * configured address, authenticates against the token file, logs to stderr,
 * keeps stdout empty and exits 0 on SIGTERM. The peer is the child-process
 * fixture, because the point is a real socket between two processes — and a
 * child process is also the only way to hand the token over in an environment
 * instead of this test's own.
 *
 * Waits are polling loops with a deadline, not fixed sleeps: startup and the
 * status round trip take as long as they take.
 *
 * The port is the one this file reserves in `test/ports.js`, never a searched
 * one: a search loop hides the collision one needs to see (docs/18, "feste
 * Ports, keine Suche"). A taken port therefore fails this file within
 * milliseconds, with the bridge's own stderr in the message.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { STATUS_RESULT } from "./fixtures/fake-extension.mjs";
import { EXTENSION_BRIDGE } from "./ports.js";

const BRIDGE_PATH = path.resolve(import.meta.dirname, "../bridge/bridge.mjs");
const FAKE_EXTENSION_PATH = path.resolve(import.meta.dirname, "fixtures/fake-extension.mjs");

const EVENT_TIMEOUT_MS = 10_000;
// How long a bridge may take to accept its first connection. Not a retry
// budget: the spawn happens once, and the port is fixed.
const READY_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 2_000;
// A refused bind on a fixed port is not a slow thing. Two seconds is the
// ceiling, not the expectation — well under a second on any sane machine.
const FAIL_FAST_EXIT_BUDGET_MS = 2_000;
const PORT_POLL_INTERVAL_MS = 20;
// A probe of an address nobody listens on is answered by the kernel at once. The
// budget only exists so that a *silent* address fails the case instead of
// hanging it — silence would prove nothing about which interface is bound.
const CONNECT_TIMEOUT_MS = 2_000;
// Long enough for a second listener that was started by mistake to have bound.
// The negative case below would otherwise pass on a bridge that was simply slow.
const NO_LISTENER_SETTLE_MS = 300;

// The owner lookup reads `/proc`, so the case that asserts on a PID is Linux-only.
// Skipped, never passed: a green tick on macOS would claim a lookup the module
// cannot do there.
const SKIP_OUTSIDE_LINUX =
  process.platform === "linux" ? false : "reads /proc, which only Linux provides";

// Generated per run: a literal would violate the "no secrets in the repo" rule,
// and `randomBytes(16)` gives exactly the 32 hex characters `readToken` wants.
const TOKEN = randomBytes(16).toString("hex");

// `formatStatusLine` sums the tabs over all windows; the fixture's windows hold
// two and one. An edited fixture must fail this test, not silently pass.
const STATUS_LINE = "status windows=2 tabs=3";
const STATUS_LINE_WITH_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z status windows=2 tabs=3$/;
const INDENTED_RESULT = JSON.stringify(STATUS_RESULT, null, 2);
const INDENTED_RESULT_LINES = INDENTED_RESULT.split("\n");
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

// Sentinel for "the awaited thing did not happen yet"; `undefined` is a real
// result for `Array.prototype.find`.
const NOT_YET = Symbol("not yet");
const TIMED_OUT = Symbol("timed out");

/* ------------------------------------------------------------------ processes */

function startProcess(scriptPath, env, args = []) {
  // Only the variables the test sets. Inheriting the developer's shell could let
  // a stray `BC_LOG=debug` or `BC_TEST_ANSWER=0` decide what is measured here.
  const child = spawn(process.execPath, [scriptPath, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
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

  // `close`, not `exit`: only `close` guarantees that both pipes were drained,
  // and the stdout assertions read those pipes.
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

/**
 * SIGTERMs the process and returns its exit code, so the caller can assert 0.
 * A process that ignores SIGTERM is a failed test, not a hung run.
 */
async function stopWithSigterm(handle) {
  if (isRunning(handle)) handle.child.kill("SIGTERM");

  const result = await raceExit(handle, EXIT_TIMEOUT_MS);
  if (result === TIMED_OUT) {
    handle.child.kill("SIGKILL");
    throw new Error(`the process ignored SIGTERM for ${EXIT_TIMEOUT_MS} ms\n${handle.output.stderr}`);
  }
  return result.code;
}

/** Best-effort teardown for `t.after`: nothing here may throw. */
async function killQuietly(handle) {
  if (!isRunning(handle)) return;
  handle.child.kill("SIGTERM");
  const result = await raceExit(handle, CLEANUP_TIMEOUT_MS);
  if (result === TIMED_OUT) handle.child.kill("SIGKILL");
}

/* ---------------------------------------------------------------------- ports */

/**
 * Whether a TCP connection to this address succeeds.
 *
 * A refused connection resolves `false`; no answer at all *rejects*, because a
 * blackholed probe looks exactly like a closed port and the loopback proof below
 * would then rest on nothing.
 */
function canConnect({ host = "127.0.0.1", port, timeoutMs = CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from ${host}:${port} within ${timeoutMs} ms — a silent probe proves nothing`));
    }, timeoutMs);
    timer.unref();

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * The host's first non-internal IPv4 address, or `null`.
 *
 * Criterion 4 asks for a probe against an address the extension socket must not
 * be reachable on. A host without one — a container with only loopback — cannot
 * be probed at all, and reporting that as green would claim a property nobody
 * checked.
 */
function firstNonInternalIpv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * Holds a reserved port inside this very process — the "another bridge is
 * already running" case, produced on purpose instead of hoped for.
 */
async function holdReservedPort(t, port) {
  const held = net.createServer();
  await new Promise((resolve, reject) => {
    held.once("error", reject);
    held.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => held.close(resolve)));
  return port;
}

/**
 * The line the bridge writes once its extension listener is bound. Matching the
 * log line — not a successful connect — is what makes readiness prove that
 * *this* child bound the port: a connect would also succeed against a foreign
 * bridge that happens to hold the same number, and the test would then wait for
 * a log line its own child never writes.
 */
function boundLinePattern(port) {
  return new RegExp(`^\\S+ listening on 127\\.0\\.0\\.1:${port} log=\\S+$`, "m");
}

/**
 * Waits until the bridge reports its bound listener — and gives up the moment it
 * exits instead.
 *
 * The exit case is checked first, not last, and that order is the whole
 * fail-fast property: a port someone else holds makes the bridge exit 1 within
 * milliseconds, so the test dies here with the port and the bridge's stderr in
 * the message instead of retrying.
 */
async function waitForListener(handle, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const boundLine = boundLinePattern(port);

  for (;;) {
    if (boundLine.test(handle.output.stderr)) return;
    // A bridge that already exited will never listen; its stderr says why.
    if (!isRunning(handle)) {
      throw new Error(
        `the bridge exited before it listened on port ${port} — is another test run using this reserved port?\n` +
          `--- bridge stderr ---\n${handle.output.stderr}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the bridge did not report port ${port} as listening within ${READY_TIMEOUT_MS} ms:\n` +
          handle.output.stderr,
      );
    }
    await delay(PORT_POLL_INTERVAL_MS);
  }
}

/* --------------------------------------------------------------------- bridge */

/**
 * Starts the bridge on this file's reserved port and returns the process handle
 * extended with `port`. Spawned once — there is no second attempt, because a
 * refused bind is the finding, not an obstacle.
 */
async function startBridge(t, { tokenFile, env = {} }) {
  const { extension: port } = EXTENSION_BRIDGE;
  const handle = startProcess(BRIDGE_PATH, {
    BC_BIND: `127.0.0.1:${port}`,
    BC_TOKEN_FILE: tokenFile,
    ...env,
  });
  // Registered before the wait: a failing wait must not leave a child behind.
  t.after(() => killQuietly(handle));

  await waitForListener(handle, port);
  return { ...handle, port };
}

/* ------------------------------------------------------------ fake extension */

function startFakeExtension(t, port, env = {}) {
  const handle = startProcess(FAKE_EXTENSION_PATH, {
    BC_TEST_URL: `ws://127.0.0.1:${port}`,
    BC_TEST_TOKEN: TOKEN,
    ...env,
  });
  t.after(() => killQuietly(handle));
  return handle;
}

/* --------------------------------------------------------------- token files */

function createTokenFile(t, { trailingNewline = false } = {}) {
  // Outside the working tree on purpose: a token file inside the repo is exactly
  // the kind of leftover that a secret grep finds a month later.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const file = path.join(directory, "token");
  fs.writeFileSync(file, trailingNewline ? `${TOKEN}\n` : TOKEN, { mode: 0o600 });
  return file;
}

/* -------------------------------------------------------------------- waiting */

async function waitFor(check, description) {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;

  for (;;) {
    const value = check();
    if (value !== NOT_YET) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${EVENT_TIMEOUT_MS} ms waiting for ${description}`);
    }
    await delay(PORT_POLL_INTERVAL_MS);
  }
}

function findLine(text, matcher) {
  return text.split("\n").find((line) => matcher.test(line));
}

/**
 * Removes the per-log-call timestamp from every line that starts with one.
 *
 * The bridge stamps one write, not every line of it, so the indented JSON has a
 * timestamp on its first line and bare continuation lines. Normalising the
 * prefix is what lets the comparison be exact without hard-coding a clock.
 */
function stripTimestamps(text) {
  return text
    .split("\n")
    .map((line) => line.replace(TIMESTAMP_PREFIX, ""))
    .join("\n");
}

/**
 * Polls the bridge's stderr. On a timeout the error carries what the process
 * actually wrote — without it a failing assertion would only say "nothing
 * arrived", which is the least useful thing to know about a child process.
 */
async function waitForStderr(handle, check, description) {
  try {
    return await waitFor(() => check(handle.output.stderr), description);
  } catch (error) {
    throw new Error(
      `${error.message}\n--- bridge stderr ---\n${handle.output.stderr}\n--- bridge stdout ---\n${handle.output.stdout}`,
      { cause: error },
    );
  }
}

/* ------------------------------------------------------------- plain requests */

/**
 * A plain HTTP GET without an `Upgrade` header — the request Caddy forwards when
 * a client speaks HTTP/2, and the one that used to crash the bridge.
 *
 * `node:http` sends exactly what a lost `curl` sends; nothing here sets upgrade
 * headers, and that is the whole point of the regression case.
 */
function requestPlainGet(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/", method: "GET" }, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ statusCode: response.statusCode, headers: response.headers, body: chunks.join("") });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

/* ---------------------------------------------------------------------- cases */

test("bridge_withDebugLoggingAndAFakeExtension_shouldLogTheExactStatusLineAndJsonOnStderrAndExitZeroOnSigterm", async (t) => {
  // GIVEN a bridge started with BC_LOG=debug and a token file outside the repo:
  const bridge = await startBridge(t, {
    tokenFile: createTokenFile(t),
    env: { BC_LOG: "debug" },
  });

  // WHEN a fake extension connects and answers `status` with two windows and
  // three tabs,
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => (stderr.includes(INDENTED_RESULT) ? true : NOT_YET),
    "the status line and the indented result",
  );

  // THEN that summary stands on one line whose only prefix is an ISO timestamp:
  const timestampedStatusLines = bridge.output.stderr
    .split("\n")
    .filter((line) => STATUS_LINE_WITH_TIMESTAMP.test(line));
  assert.equal(timestampedStatusLines.length, 1, `exactly one ISO-timestamped "${STATUS_LINE}" line expected`);

  // ... and the complete result follows as indented JSON with nothing in
  // between, which is the strongest reading of "danach nichts":
  const lines = stripTimestamps(bridge.output.stderr).split("\n");
  const statusIndex = lines.indexOf(STATUS_LINE);
  assert.deepEqual(lines.slice(statusIndex + 1, statusIndex + 1 + INDENTED_RESULT_LINES.length), INDENTED_RESULT_LINES);

  // ... while stdout stayed empty, because it belongs to the JSON-RPC layer:
  assert.equal(bridge.output.stdout, "");

  // THEN SIGTERM shuts it down with exit code 0 and still nothing on stdout:
  assert.equal(await stopWithSigterm(bridge), 0);
  assert.equal(bridge.output.stdout, "");
});

test("bridge_withATokenFileEndingInANewline_shouldAuthenticateTheTrimmedToken", async (t) => {
  // GIVEN a token file written with a trailing newline, exactly as
  // `openssl rand -hex 32 > token` writes it,
  const bridge = await startBridge(t, {
    tokenFile: createTokenFile(t, { trailingNewline: true }),
  });

  // WHEN the fake extension presents the token without that newline,
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => findLine(stderr, / extension connected peer=\S+ protocol=1$/) ?? NOT_YET,
    'the "extension connected" line',
  );

  // THEN the connection is accepted, the status answer arrives, and no auth
  // failure appears anywhere in the log:
  await waitForStderr(
    bridge,
    (stderr) => (stderr.includes(`${STATUS_LINE}\n`) ? true : NOT_YET),
    "the status line",
  );
  assert.ok(!bridge.output.stderr.includes("auth failed"), "a trimmed token must not fail authentication");

  assert.equal(bridge.output.stdout, "");
  assert.equal(await stopWithSigterm(bridge), 0);
});

test("bridge_withoutAnAnswerFromTheExtension_shouldLogAStatusTimeoutAndStillExitZeroOnSigterm", async (t) => {
  // GIVEN a bridge with a short status deadline and a fake extension that stays
  // silent after `welcome`:
  const bridge = await startBridge(t, {
    tokenFile: createTokenFile(t),
    env: { BC_CALL_TIMEOUT_MS: "300" },
  });
  startFakeExtension(t, bridge.port, { BC_TEST_ANSWER: "0" });

  await waitForStderr(
    bridge,
    (stderr) => findLine(stderr, / extension connected peer=\S+/) ?? NOT_YET,
    'the "extension connected" line',
  );

  // WHEN the deadline passes,
  const timeoutLine = await waitForStderr(
    bridge,
    (stderr) => findLine(stderr, / status timeout peer=\S+$/) ?? NOT_YET,
    'the "status timeout" line',
  );

  // THEN stderr names the reason, no status line is invented, and SIGTERM still
  // ends the process with 0:
  assert.match(timeoutLine, /^\d{4}-\d{2}-\d{2}T\S+ status timeout peer=\S+$/);
  assert.ok(!bridge.output.stderr.includes("status windows="), "a silent peer must not produce a status line");
  assert.equal(bridge.output.stdout, "");
  assert.equal(await stopWithSigterm(bridge), 0);
  assert.equal(bridge.output.stdout, "");
});

test("bridge_withAPlainHttpGetWithoutUpgradeHeader_shouldAnswer426AndKeepServingWebSocketClients", async (t) => {
  // GIVEN a bridge started with a token file outside the repo:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN a client sends a plain GET without an `Upgrade` header — the shape
  // Caddy forwards for an HTTP/2 client, and the one that used to kill the
  // process with `TypeError: res.writeHead is not a function`,
  const plain = await requestPlainGet(bridge.port);

  // THEN that request is refused with 426 and a closing connection,
  assert.equal(plain.statusCode, 426);
  assert.equal(plain.headers.connection, "close");
  // ... whose body names the reason (the writer's newline is not the contract):
  assert.equal(plain.body.trim(), "WebSocket upgrade required");

  // ... and the process survived it rather than dying on a callback signature:
  assert.equal(isRunning(bridge), true, `the bridge died on a plain request:\n${bridge.output.stderr}`);
  assert.ok(!bridge.output.stderr.includes("TypeError"), "a plain request must not raise inside the listener");
  assert.equal(bridge.output.stdout, "");

  // WHEN a fake extension then performs a real upgrade handshake on the same
  // bridge,
  startFakeExtension(t, bridge.port);

  // THEN it is authenticated and served like before the rejected request:
  await waitForStderr(
    bridge,
    (stderr) => (stderr.includes(`${STATUS_LINE}\n`) ? true : NOT_YET),
    "the status line after a rejected plain request",
  );
  assert.ok(!bridge.output.stderr.includes("auth failed"), "the rejection must not disturb a later handshake");
  assert.equal(bridge.output.stdout, "");

  // THEN SIGTERM still ends the process with 0:
  assert.equal(await stopWithSigterm(bridge), 0);
});

test("bridge_withoutTheHttpFlagButWithBCHttpPortSet_shouldNotListenOnThatPort", async (t) => {
  // GIVEN this file's reserved HTTP port and a bridge started without `--http`
  // — the way an agent harness spawns it, with the operator's environment
  // inherited:
  const httpPort = EXTENSION_BRIDGE.http;
  const bridge = await startBridge(t, {
    tokenFile: createTokenFile(t),
    env: { BC_HTTP_PORT: String(httpPort) },
  });

  // WHEN the extension listener is already accepting connections and the
  // second bind would have happened by now,
  await delay(NO_LISTENER_SETTLE_MS);

  // THEN nothing listens on the HTTP port:
  assert.equal(
    await canConnect({ port: httpPort }),
    false,
    `a bridge without --http bound port ${httpPort}; a spawned bridge would then die on EADDRINUSE`,
  );

  // ... and no line ever announces an MCP endpoint, because there is none:
  assert.ok(!bridge.output.stderr.includes("/mcp"), `unexpected MCP line:\n${bridge.output.stderr}`);

  // THEN the process is still the working stdio bridge it was before:
  assert.equal(isRunning(bridge), true, `the bridge died:\n${bridge.output.stderr}`);
  assert.equal(await stopWithSigterm(bridge), 0);
});

test("bridge_onItsReservedPort_shouldRefuseAConnectionOnTheHostsNonInternalIpv4", async (t) => {
  // GIVEN the host's first non-internal IPv4 — an address the extension socket
  // must not be reachable on, and one this file cannot invent:
  const address = firstNonInternalIpv4();
  if (address === null) {
    t.skip("no non-internal IPv4 on this host");
    return;
  }

  // WHEN a bridge runs on this file's reserved port,
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // THEN that port really is listening on loopback — without this the refusal
  // below would also be satisfied by a bridge that never started:
  assert.equal(await canConnect({ port: bridge.port }), true, `nothing listens on 127.0.0.1:${bridge.port}`);

  // ... and a connection on the other address is refused, so the listener sits
  // on 127.0.0.1 alone and not on every interface:
  assert.equal(
    await canConnect({ host: address, port: bridge.port }),
    false,
    `the extension socket answers on ${address}:${bridge.port} — it must bind loopback only`,
  );

  // THEN SIGTERM still ends the process with 0:
  assert.equal(await stopWithSigterm(bridge), 0);
});

test("bridge_withItsReservedPortAlreadyBound_shouldExitOneAtOnceAndNameThePort", async (t) => {
  // GIVEN this file's reserved extension port, held by this very process — the
  // collision the fixed port makes visible (a second test run, say):
  const port = await holdReservedPort(t, EXTENSION_BRIDGE.extension);

  // WHEN a bridge is started on exactly that port,
  const handle = startProcess(BRIDGE_PATH, {
    BC_BIND: `127.0.0.1:${port}`,
    BC_TOKEN_FILE: createTokenFile(t),
  });
  t.after(() => killQuietly(handle));

  const result = await raceExit(handle, FAIL_FAST_EXIT_BUDGET_MS);
  // THEN it ends with exit code 1 instead of pretending to serve — and it does
  // so well inside the budget, because nothing retries a refused bind:
  assert.notEqual(
    result,
    TIMED_OUT,
    `the bridge did not exit within ${FAIL_FAST_EXIT_BUDGET_MS} ms:\n${handle.output.stderr}`,
  );
  assert.deepEqual(result, { code: 1, signal: null }, `stderr:\n${handle.output.stderr}`);

  // ... and its stderr names the port it could not have:
  assert.ok(
    handle.output.stderr.includes(`127.0.0.1:${port}`),
    `stderr does not name port ${port}:\n${handle.output.stderr}`,
  );
  assert.match(
    findLine(handle.output.stderr, /listener failed on/) ?? "",
    new RegExp(`listener failed on 127\\.0\\.0\\.1:${port}: EADDRINUSE$`),
  );
});

test(
  "bridge_withAPreBoundExtensionPort_shouldExitOneWithAnOwnerLineNamingThisTestProcess",
  { skip: SKIP_OUTSIDE_LINUX },
  async (t) => {
    // GIVEN this file's reserved extension port, held by this very test process —
    // the "another bridge is already running" case the owner line exists for:
    const port = await holdReservedPort(t, EXTENSION_BRIDGE.extension);

    // WHEN a bridge is started on exactly that port,
    const handle = startProcess(BRIDGE_PATH, {
      BC_BIND: `127.0.0.1:${port}`,
      BC_TOKEN_FILE: createTokenFile(t),
    });
    t.after(() => killQuietly(handle));

    const result = await raceExit(handle, EXIT_TIMEOUT_MS);
    // THEN it ends with exit code 1 instead of pretending to serve:
    assert.notEqual(result, TIMED_OUT, `the bridge did not exit:\n${handle.output.stderr}`);
    assert.deepEqual(result, { code: 1, signal: null }, `stderr:\n${handle.output.stderr}`);

    // ... after naming what failed,
    const failureLine = findLine(handle.output.stderr, /listener failed on/);
    assert.ok(failureLine, `no failure line:\n${handle.output.stderr}`);
    assert.match(failureLine, new RegExp(`listener failed on 127\\.0\\.0\\.1:${port}: EADDRINUSE$`));

    // ... and, on a second line, who owns the port: this test process.
    // The name comes from `/proc/<pid>/comm` and therefore from the runtime, not
    // from the bridge: Node 22 writes `node`, Node 24 writes `MainThread` for
    // this same process. So it is asserted as present, not as a fixed string —
    // pinning it would only make the suite a Node version detector.
    const ownerLine = findLine(handle.output.stderr, / in use, owner pid=/);
    assert.ok(ownerLine, `no owner line:\n${handle.output.stderr}`);
    assert.match(ownerLine, new RegExp(`port 127\\.0\\.0\\.1:${port} in use, owner pid=${process.pid} name=\\S+$`));
  },
);

test(
  "bridge_withAPreBoundHttpPortAndTheHttpFlag_shouldExitOneInsteadOfServingTheExtensionSocketAlone",
  { skip: SKIP_OUTSIDE_LINUX },
  async (t) => {
    // GIVEN this file's reserved HTTP port, held by this very test process — the
    // collision that used to leave a bridge answering the extension while every
    // `POST /mcp` failed:
    const httpPort = await holdReservedPort(t, EXTENSION_BRIDGE.http);

    // WHEN a bridge starts with `--http` and its extension listener on this
    // file's reserved port. Deliberately not `127.0.0.1:0`: `parsePort` rejects 0
    // and falls back to the default 8110, which the operator's running service
    // owns — a test must not borrow that port, let alone compete for it.
    const handle = startProcess(
      BRIDGE_PATH,
      {
        BC_BIND: `127.0.0.1:${EXTENSION_BRIDGE.extension}`,
        BC_HTTP_PORT: String(httpPort),
        BC_TOKEN_FILE: createTokenFile(t),
      },
      ["--http"],
    );
    t.after(() => killQuietly(handle));

    const result = await raceExit(handle, FAIL_FAST_EXIT_BUDGET_MS);
    // THEN it ends with exit code 1 instead of serving only half of itself — and
    // it does so well inside the budget, because nothing retries a refused bind:
    assert.notEqual(
      result,
      TIMED_OUT,
      `the bridge did not exit within ${FAIL_FAST_EXIT_BUDGET_MS} ms:\n${handle.output.stderr}`,
    );
    assert.deepEqual(result, { code: 1, signal: null }, `stderr:\n${handle.output.stderr}`);

    // ... after naming what failed,
    const failureLine = findLine(handle.output.stderr, /http listener failed on/);
    assert.ok(failureLine, `no HTTP failure line:\n${handle.output.stderr}`);
    assert.match(failureLine, new RegExp(`http listener failed on 127\\.0\\.0\\.1:${httpPort}: EADDRINUSE$`));

    // ... and, second line, who owns the port: this test process. The name is
    // `node` on Node 22 and `MainThread` on Node 24 (`/proc/<pid>/comm`), so it
    // is only required to be non-empty — address and PID are what matters.
    const ownerLine = findLine(handle.output.stderr, / in use, owner pid=/);
    assert.ok(ownerLine, `no owner line:\n${handle.output.stderr}`);
    assert.match(ownerLine, new RegExp(`port 127\\.0\\.0\\.1:${httpPort} in use, owner pid=${process.pid} name=\\S+$`));

    // ... and no `/mcp` endpoint was ever announced: the exit is the honest
    // answer, not a bridge that looks healthy while never answering `/mcp`:
    assert.ok(!handle.output.stderr.includes("for POST /mcp"), `unexpected MCP line:\n${handle.output.stderr}`);

    // ... and that branch is what ended the process. Without its `exit(1)` the
    // extension listener stays bound and the code after the catch fails on a
    // transport that was never created — exit code 1 all the same, but for a
    // reason nobody can act on:
    assert.ok(
      !handle.output.stderr.includes("bridge failed"),
      `the bridge ended in an unrelated failure instead of the bind branch:\n${handle.output.stderr}`,
    );
  },
);

test("bridge_withATokenFileThatDoesNotExist_shouldExitTwo", async (t) => {
  // GIVEN a token path that was never written — a token file the operator has
  // not created yet, which no restart can heal (hence `RestartPreventExitStatus=2`):
  const missing = path.join(os.tmpdir(), `bc-missing-${randomBytes(8).toString("hex")}`, "token");

  // WHEN the bridge is started with it,
  const handle = startProcess(BRIDGE_PATH, {
    BC_BIND: "127.0.0.1:0",
    BC_TOKEN_FILE: missing,
    BC_HTTP_PORT: "8111",
  });
  t.after(() => killQuietly(handle));

  // THEN it stops with the configuration code 2, before any port is bound,
  const result = await raceExit(handle, EXIT_TIMEOUT_MS);
  assert.notEqual(result, TIMED_OUT, `the bridge did not exit:\n${handle.output.stderr}`);
  assert.deepEqual(result, { code: 2, signal: null }, `stderr:\n${handle.output.stderr}`);

  // ... and says which file it wanted instead of failing silently:
  assert.ok(
    handle.output.stderr.includes(`token file missing or too short: ${missing}`),
    `unexpected stderr:\n${handle.output.stderr}`,
  );
  assert.ok(!handle.output.stderr.includes("listening on"), "a token failure must not bind a port first");
});
