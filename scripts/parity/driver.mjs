/**
 * Runs exactly one implementation for exactly one comparison of the parity
 * yardstick (`docs/37`, stage 2) and prints what came back, unmasked.
 *
 * Why a process driver at all: "parity" is a promise about two *programs*, and a
 * module-level comparison would prove that two functions agree while the entry
 * points could still differ in a log line, an exit code or a close frame. So this
 * file speaks to the real bridge over its real stdin/stdout, and the four modes
 * below are the four shapes a comparison needs:
 *
 *   rpc    — write the requests, read exactly one answer line each, with a deadline.
 *   probe  — start the bridge, then run an external probe (the WebSocket one) against it.
 *   logs   — start it, let it become ready and quiet, stop it, hand over stderr.
 *   exit   — start it and wait for it to end on its own (a failed preflight).
 *
 * Two rules this file keeps so that the caller does not have to:
 *
 * - **The environment is pinned, never inherited.** The bridge's own defaults are
 *   20 s for a call and 5 s for the hello, and a comparison that measures silence
 *   would then take twenty seconds instead of 300 ms. The developer's shell is
 *   not passed on either: a stray `BC_LOG=debug` in the calling terminal must not
 *   decide what a comparison sees.
 * - **One answer line per request, with a deadline.** Reading "everything that
 *   arrived eventually" turns a hung bridge into a hung parity run, and the
 *   deadline is what makes the failure attributable to the request that stalled.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NODE_BRIDGE = path.join(ROOT, "bridge/bridge.mjs");
const RUST_BRIDGE = path.join(
  ROOT,
  "bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge",
);
const FAKE_EXTENSION = path.join(ROOT, "test/fixtures/fake-extension.mjs");

// Pinned per run, not defaulted: `docs/37` fixes these two numbers for every
// comparison, and the same values are what make "300 ms" a measurement instead
// of an expectation.
const PINNED_BRIDGE_ENV = Object.freeze({ BC_CALL_TIMEOUT_MS: "300", BC_HELLO_TIMEOUT_MS: "300" });

const POLL_INTERVAL_MS = 10;
const STOP_GRACE_MS = 5_000;

const USAGE = `usage: driver.mjs --mode rpc|probe|logs|exit --token-file <path> [options]

  --impl node|rust             which implementation to start (default: node)
  --mode <name>                rpc | probe | logs | exit (default: rpc)
  --requests <file>            rpc: one JSON-RPC line per request
  --probe <file>               probe: the Node script to run against the bridge
  --probe-arg <value>          probe: one argument, repeatable, order kept
  --bind <host:port>           the extension listener (default: 127.0.0.1:18115)
  --http-port <port>           the MCP-over-HTTP port (default: 18116)
  --http                       start the bridge with \`--http\`
  --log info|debug             BC_LOG for this run (default: info)
  --fixture                    start test/fixtures/fake-extension.mjs as the peer
  --fixture-env <KEY=VALUE>    fixture environment, repeatable
  --await-before-fixture <re>  wait for this stderr line before the fixture starts
  --await-after-fixture <re>   wait for this stderr line after the fixture started
  --token-file <path>          BC_TOKEN_FILE; read only when the fixture needs it
  --await-deadline <ms>        per awaited line (default: 5000)
  --response-deadline <ms>     per answer line (default: 5000)
  --exit-deadline <ms>         for a process that must end by itself (default: 10000)
`;

/* ------------------------------------------------------------------- options */

function parseOptions(argv) {
  const options = {
    impl: "node",
    mode: "rpc",
    requests: null,
    tokenFile: null,
    bind: "127.0.0.1:18115",
    httpPort: "18116",
    log: "info",
    http: false,
    fixture: false,
    fixtureEnv: [],
    // The bridge announces readiness on stderr (`listening on …`, printed from the
    // listen callback). A fixture started earlier races the bind and dies with
    // "could not reach the bridge" — it does not retry, so the race is a hard
    // failure whenever the machine is busy. Waiting for the line is the default,
    // not an opt-in.
    awaitBeforeFixture: ["listening on"],
    awaitAfterFixture: [],
    probe: null,
    probeArgs: [],
    awaitDeadline: 5_000,
    responseDeadline: 5_000,
    exitDeadline: 10_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const separator = argv[index].indexOf("=");
    const name = separator === -1 ? argv[index] : argv[index].slice(0, separator);
    const inlineValue = separator === -1 ? null : argv[index].slice(separator + 1);
    // A value option either carries `=value` or takes the next argument; a flag
    // has none of both, so consuming unconditionally would eat the flag after it.
    const value = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${name} needs a value`);
      return argv[index];
    };

    switch (name) {
      case "--impl": options.impl = value(); break;
      case "--mode": options.mode = value(); break;
      case "--requests": options.requests = value(); break;
      case "--probe": options.probe = value(); break;
      case "--probe-arg": options.probeArgs.push(value()); break;
      case "--bind": options.bind = value(); break;
      case "--http-port": options.httpPort = value(); break;
      case "--log": options.log = value(); break;
      case "--http": options.http = true; break;
      case "--fixture": options.fixture = true; break;
      case "--fixture-env": options.fixtureEnv.push(value()); break;
      case "--await-before-fixture": options.awaitBeforeFixture.push(value()); break;
      case "--await-after-fixture": options.awaitAfterFixture.push(value()); break;
      case "--token-file": options.tokenFile = value(); break;
      case "--await-deadline": options.awaitDeadline = Number(value()); break;
      case "--response-deadline": options.responseDeadline = Number(value()); break;
      case "--exit-deadline": options.exitDeadline = Number(value()); break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${argv[index]}`);
    }
  }

  if (options.mode === "rpc" && options.requests === null) throw new Error("rpc mode needs --requests");
  if (options.mode === "probe" && options.probe === null) throw new Error("probe mode needs --probe");
  if (options.tokenFile === null) throw new Error("--token-file is required");
  return options;
}

/* ------------------------------------------------------------------ processes */

/**
 * Only `PATH` is inherited. Everything the children decide on is named here or
 * passed in, so a comparison cannot be decided by the caller's shell.
 */
function childEnv(extra) {
  return { PATH: process.env.PATH ?? "", ...extra };
}

function startProcess(command, args, env, stdinMode) {
  const child = spawn(command, args, { env, stdio: [stdinMode, "pipe", "pipe"] });

  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  // A write to a process that already died raises EPIPE. That is a real finding,
  // but it belongs to the waiting code that reports with the child's output — not
  // to an unhandled stream error that kills this driver.
  child.stdin?.on("error", () => {});

  const exit = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  return { child, output, exit };
}

function hasExited(handle) {
  return handle.child.exitCode !== null || handle.child.signalCode !== null;
}

function exitCodeOf(handle) {
  return handle.child.exitCode ?? handle.child.signalCode ?? "?";
}

function startImplementation(options) {
  const [command, args] =
    options.impl === "node" ? [process.execPath, [NODE_BRIDGE]] : [RUST_BRIDGE, []];
  // The flag is appended only here: `BC_HTTP_PORT` sets a port, never a mode.
  const argv = options.http ? [...args, "--http"] : args;
  // stdin is `ignore` for every mode that does not speak JSON-RPC: that is how the
  // service is started under systemd, and `/dev/null` is exactly what the bridge's
  // `stdinIsClientChannel()` is written against.
  const stdinMode = options.mode === "rpc" ? "pipe" : "ignore";

  return startProcess(
    command,
    argv,
    childEnv({
      BC_BIND: options.bind,
      BC_HTTP_PORT: options.httpPort,
      BC_TOKEN_FILE: options.tokenFile,
      BC_LOG: options.log,
      ...PINNED_BRIDGE_ENV,
    }),
    stdinMode,
  );
}

function startFixture(options) {
  const token = readToken(options.tokenFile);
  const extra = {};
  for (const pair of options.fixtureEnv) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error(`--fixture-env needs KEY=VALUE, got ${pair}`);
    extra[pair.slice(0, separator)] = pair.slice(separator + 1);
  }

  return startProcess(
    process.execPath,
    [FAKE_EXTENSION],
    childEnv({ BC_TEST_URL: `ws://${options.bind}`, BC_TEST_TOKEN: token, ...extra }),
    "ignore",
  );
}

function readToken(tokenFile) {
  let content;
  try {
    content = fs.readFileSync(tokenFile, "utf8");
  } catch (error) {
    throw new Error(`the fixture needs a readable token file at ${tokenFile}: ${error.code ?? error.message}`);
  }
  const token = content.trim();
  if (token === "") throw new Error(`the token file ${tokenFile} is empty`);
  return token;
}

/**
 * SIGTERM, then SIGKILL. Best effort and idempotent: it is also the cleanup path,
 * where throwing would hide the real finding.
 */
async function stopQuietly(handle) {
  if (handle === null || handle === undefined || hasExited(handle)) return;

  handle.child.kill("SIGTERM");
  const timedOut = Symbol("timed out");
  const result = await Promise.race([
    handle.exit,
    delay(STOP_GRACE_MS, timedOut, { ref: false }),
  ]);

  if (result === timedOut) {
    handle.child.kill("SIGKILL");
    await handle.exit;
  }
}

/* -------------------------------------------------------------------- waiting */

/** Polls the child's stderr for one line, and gives up the moment it exits. */
async function awaitStderr(handle, pattern, timeoutMs) {
  const regex = new RegExp(pattern, "m");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (regex.test(handle.output.stderr)) return;
    if (hasExited(handle)) {
      throw new Error(
        `the process exited (code ${exitCodeOf(handle)}) before it wrote /${pattern}/\n${handle.output.stderr}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no line matching /${pattern}/ within ${timeoutMs} ms\n${handle.output.stderr}`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function awaitAll(handle, patterns, timeoutMs) {
  // `await` inside the loop, not `void awaitStderr(...)`: without it this function
  // returns before the first line ever matched, and the next step then talks to a
  // process that is still starting up.
  for (const pattern of patterns) await awaitStderr(handle, pattern, timeoutMs);
}

/**
 * The next complete stdout line, with a deadline.
 *
 * A line is complete when its newline arrived: `split("\n")` on `"a\nb\n"` gives
 * three pieces and on `"a\nb"` gives two, so `pieces.length - 1` is the number of
 * finished lines in both cases — the last piece is the unfinished tail.
 */
async function nextResponseLine(handle, cursor, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const pieces = handle.output.stdout.split("\n");
    if (pieces.length - 1 > cursor.value) {
      const line = pieces[cursor.value];
      cursor.value += 1;
      return line;
    }
    if (hasExited(handle)) {
      throw new Error(
        `the process exited (code ${exitCodeOf(handle)}) with ${cursor.value} answer line(s) so far\n` +
          `--- stdout ---\n${handle.output.stdout}\n--- stderr ---\n${handle.output.stderr}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no answer line ${cursor.value + 1} within ${timeoutMs} ms\n` +
          `--- stdout ---\n${handle.output.stdout}\n--- stderr ---\n${handle.output.stderr}`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/* ---------------------------------------------------------------------- modes */

/** One request line in, exactly one answer line out — the whole of the MCP measurement. */
async function runRpc(options, session) {
  const requests = readRequests(options.requests);
  const cursor = { value: 0 };

  for (const request of requests) {
    session.impl.child.stdin.write(`${request}\n`);
    try {
      const answer = await nextResponseLine(session.impl, cursor, options.responseDeadline);
      process.stdout.write(`${answer}\n`);
    } catch (error) {
      throw new Error(`request ${JSON.stringify(request)}: ${error.message}`, { cause: error });
    }
  }

  await stopAndRequireCleanExit(session.impl);
}

async function runProbe(options, session) {
  const probe = startProcess(
    process.execPath,
    [options.probe, ...options.probeArgs],
    childEnv(),
    "ignore",
  );

  const timedOut = Symbol("timed out");
  const result = await Promise.race([
    probe.exit,
    delay(options.exitDeadline, timedOut, { ref: false }),
  ]);
  if (result === timedOut) {
    await stopQuietly(probe);
    throw new Error(`the probe did not finish within ${options.exitDeadline} ms\n${probe.output.stderr}`);
  }
  if (result.code !== 0) {
    throw new Error(`the probe failed with code ${result.code}\n` + `--- stdout ---\n${probe.output.stdout}\n--- stderr ---\n${probe.output.stderr}`);
  }

  process.stdout.write(ensureTrailingNewline(probe.output.stdout));

  await stopAndRequireCleanExit(session.impl);
}

async function runLogs(options, session) {
  await stopAndRequireCleanExit(session.impl);
  process.stdout.write(ensureTrailingNewline(session.impl.output.stderr));
}

async function runExit(options, session) {
  const timedOut = Symbol("timed out");
  const result = await Promise.race([
    session.impl.exit,
    delay(options.exitDeadline, timedOut, { ref: false }),
  ]);
  if (result === timedOut) {
    throw new Error(`the process did not exit within ${options.exitDeadline} ms\n${session.impl.output.stderr}`);
  }

  // The exit code is part of what a failed preflight promises, so it is printed
  // with the lines it belongs to rather than kept in the diagnostic.
  process.stdout.write(ensureTrailingNewline(session.impl.output.stderr));
  process.stdout.write(`exit=${result.code ?? result.signal}\n`);
}

function readRequests(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function ensureTrailingNewline(text) {
  if (text === "" || text.endsWith("\n")) return text;
  return `${text}\n`;
}

/**
 * SIGTERM and exit 0. The bridge promises that an orderly stop ends with 0, and a
 * comparison that skipped the check would keep a "hang on shutdown" invisible for
 * as long as nobody watched the exit code.
 */
async function stopAndRequireCleanExit(handle) {
  if (!hasExited(handle)) handle.child.kill("SIGTERM");

  const timedOut = Symbol("timed out");
  const result = await Promise.race([
    handle.exit,
    delay(STOP_GRACE_MS, timedOut, { ref: false }),
  ]);
  if (result === timedOut) {
    handle.child.kill("SIGKILL");
    throw new Error(`the process ignored SIGTERM for ${STOP_GRACE_MS} ms\n${handle.output.stderr}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `the process did not stop with exit code 0 but ${result.code ?? result.signal}\n${handle.output.stderr}`,
    );
  }
}

/* ----------------------------------------------------------------------- main */

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const session = { impl: null, fixture: null };

  try {
    session.impl = startImplementation(options);

    // Waiting for the bridge's readiness line only makes sense when a peer is about
    // to connect: comparisons 5 and 6 *expect* the bridge to die before it ever
    // listens (occupied port, missing token), and a driver that waits for
    // `listening on` there would turn their expected failure into a timeout.
    if (options.mode !== "exit") {
      const before = options.awaitBeforeFixture.length > 0
        ? options.awaitBeforeFixture
        : ["listening on"];
      await awaitAll(session.impl, before, options.awaitDeadline);
    }

    if (options.fixture) session.fixture = startFixture(options);
    await awaitAll(session.impl, options.awaitAfterFixture, options.awaitDeadline);

    if (options.mode === "rpc") await runRpc(options, session);
    else if (options.mode === "probe") await runProbe(options, session);
    else if (options.mode === "logs") await runLogs(options, session);
    else if (options.mode === "exit") await runExit(options, session);
    else throw new Error(`unknown mode: ${options.mode}`);
  } finally {
    // The fixture first: it only ever exits because the bridge went away, and
    // killing it first turns that into a clean shutdown rather than a reset.
    await stopQuietly(session.fixture);
    await stopQuietly(session.impl);
  }
}

main().catch((error) => {
  process.stderr.write(`driver: ${error?.message ?? error}\n`);
  process.exit(1);
});
