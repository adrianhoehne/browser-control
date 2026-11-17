#!/usr/bin/env node
/**
 * The blackbox E2E: Firefox starts, the extension is installed temporarily, MCP
 * opens a page, and **the page itself** reports back to a beacon server.
 *
 * That last step is the reason this file exists. The bridge can answer "opened"
 * without a browser being there; a loaded page that fetches `/ping` cannot. The
 * ten steps and their two deadlines are `docs/40`, `## Der E2E-Ablauf`.
 *
 * Ports 18810/18811/18990 are outside both reserved ranges: 8110/8111 belong to
 * the operator's running service, 18110–18119 to the Rust and parity suites.
 *
 * **Cleaning up.** Every process this script starts is stopped by the PID it was
 * started with — and, on POSIX, as a process group, because `npx` starts
 * `web-ext` and `web-ext` starts Firefox. Firefox is additionally stopped by the
 * PID its wrapper recorded, since `web-ext` does not hand that one out. Nothing
 * here matches a name or a command line: `pkill -f`/`taskkill /IM` would kill the
 * operator's service, which has exactly the same command line.
 *
 * Usage:
 *   node scripts/e2e/run.mjs [--keep] [--windows] [--only-bridge]
 *   node scripts/e2e/run.mjs --self-check [--source <dir>]
 */
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTestExtension, checkSeams } from "./build-test-extension.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BEACON_SCRIPT = path.join(REPO_ROOT, "scripts", "e2e", "beacon.mjs");
const DEFAULT_SOURCE = path.join(REPO_ROOT, "extension");

const BRIDGE_BIND = "127.0.0.1:18810";
const BRIDGE_EXT_PORT = 18810;
const BRIDGE_HTTP_PORT = 18811;
const BEACON_PORT = 18990;
const BEACON_URL = `http://127.0.0.1:${BEACON_PORT}`;
const MCP_URL = `http://127.0.0.1:${BRIDGE_HTTP_PORT}/mcp`;

/** Chosen, not measured: 15 × and 7 × the measured 4 s (`docs/40`, table). */
const BRIDGE_UP_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 60_000;
const BEACON_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const STOP_GRACE_MS = 3_000;

const LINUX_TARGET = "x86_64-unknown-linux-musl";
const WINDOWS_TARGET = "x86_64-pc-windows-gnu";

class E2eError extends Error {}

function fail(message) {
  throw new E2eError(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function tail(text, lines = 10) {
  const all = text.trimEnd().split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function parseArgs(argv) {
  const options = { keep: false, windows: false, selfCheck: false, onlyBridge: false, source: DEFAULT_SOURCE };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--keep":
        options.keep = true;
        break;
      case "--windows":
        options.windows = true;
        break;
      case "--self-check":
        options.selfCheck = true;
        break;
      case "--only-bridge":
        options.onlyBridge = true;
        break;
      case "--source":
        if (!value) fail("--source needs a directory");
        options.source = path.resolve(value);
        index += 1;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        fail(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return (
    "usage: node scripts/e2e/run.mjs [--keep] [--windows] [--only-bridge]\n" +
    "       node scripts/e2e/run.mjs --self-check [--source <dir>]\n\n" +
    "Runs the ten steps of docs/40: bridge, beacon, Firefox, MCP call, beacon hit.\n" +
    "  --keep          leave the processes running and name the work directory\n" +
    "  --windows       Windows paths and taskkill instead of POSIX process groups\n" +
    "  --only-bridge   steps 1–5 only: binary, token, test copy, bridge, beacon\n" +
    "  --self-check    only count the two seam anchors; no process, no port\n" +
    "  --source <dir>  the extension folder for --self-check (default: extension/)\n\n" +
    "Environment: E2E_BINARY, E2E_FIREFOX, E2E_TOKEN_FILE, E2E_BEACON_MODE=ok|broken.\n"
  );
}

/** Step 1: `E2E_BINARY` wins, otherwise the release binary of this platform's target. */
function resolveBinary({ windows }) {
  const configured = process.env.E2E_BINARY;
  if (configured) {
    const resolved = path.resolve(configured);
    if (!existsSync(resolved)) fail(`no binary at ${resolved} (E2E_BINARY)`);
    return resolved;
  }
  const target = windows ? WINDOWS_TARGET : LINUX_TARGET;
  const name = windows ? "browser-control-bridge.exe" : "browser-control-bridge";
  const binary = path.join(REPO_ROOT, "bridge-rs", "target", target, "release", name);
  if (!existsSync(binary)) {
    fail(
      `no binary at ${binary}\n` +
        `build it with: cargo build --release --manifest-path bridge-rs/Cargo.toml --target ${target}\n` +
        "or name one with E2E_BINARY=<path>",
    );
  }
  return binary;
}

/** Step 2: a 64-hex token in a file; `E2E_TOKEN_FILE` names it, otherwise it is created. */
function ensureToken(workDir) {
  const configured = process.env.E2E_TOKEN_FILE;
  const file = configured ? path.resolve(configured) : path.join(workDir, "token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(token)) fail(`${file} does not hold a 64-character hex token`);
    return { file, token };
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { file, token };
}

/** Step 6: `E2E_FIREFOX`, else the Windows default, else `command -v firefox`. */
function resolveFirefox({ windows }) {
  const configured = process.env.E2E_FIREFOX;
  if (configured) {
    const resolved = path.resolve(configured);
    if (!existsSync(resolved)) fail(`no firefox at ${resolved} (E2E_FIREFOX)`);
    return resolved;
  }
  if (windows) {
    const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? "C:\\Program Files";
    const candidate = path.join(programFiles, "Mozilla Firefox", "firefox.exe");
    if (existsSync(candidate)) return candidate;
  }
  // `command -v` is a shell builtin, so it needs a shell; Windows has `where`.
  const probe = windows
    ? spawnSync("where", ["firefox"], { encoding: "utf8" })
    : spawnSync("sh", ["-c", "command -v firefox"], { encoding: "utf8" });
  const first = (probe.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (probe.status === 0 && first) return first;
  fail("no firefox — point E2E_FIREFOX at one (Windows default: %ProgramFiles%\\Mozilla Firefox\\firefox.exe)");
}

function isAlive(pid, group) {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops one process by the PID it was started with.
 *
 * `group` is set on POSIX because the run starts every child detached: the child
 * leads its own process group, and the group kill takes the descendants that
 * killing the leader alone would orphan. Windows uses `taskkill /T`, which walks
 * the tree for the same reason.
 */
async function stopProcess({ name, pid, windows, group }) {
  if (!pid) return;
  if (windows) {
    const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { encoding: "utf8" });
    const gone = result.status === 0;
    process.stdout.write(`cleanup: ${name} pid=${pid}${gone ? "" : " (already gone)"}\n`);
    return;
  }
  const signal = (name_) => {
    try {
      process.kill(group ? -pid : pid, name_);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal("SIGTERM")) {
    process.stdout.write(`cleanup: ${name} pid=${pid} (already gone)\n`);
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && isAlive(pid, group)) await sleep(POLL_MS);
  if (isAlive(pid, group)) signal("SIGKILL");
  process.stdout.write(`cleanup: ${name} pid=${pid}\n`);
}

function startBridge({ binary, tokenFile, logFile, windows }) {
  const out = openSync(logFile, "a");
  const child = spawn(binary, ["--http"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      BC_BIND: BRIDGE_BIND,
      BC_HTTP_PORT: String(BRIDGE_HTTP_PORT),
      BC_TOKEN_FILE: tokenFile,
    },
    // stdin on `ignore`, never a pipe: a pipe EOF ends the bridge with exit 0
    // (`docs/38`, stage 2f) and the test would then hunt a failure that is not
    // there.
    stdio: ["ignore", out, out],
    detached: !windows,
  });
  closeSync(out);
  process.stdout.write(`e2e: bridge pid=${child.pid} ${BRIDGE_BIND} + :${BRIDGE_HTTP_PORT}\n`);
  return child;
}

function startBeacon({ logFile, windows }) {
  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [BEACON_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, E2E_BEACON_MODE: process.env.E2E_BEACON_MODE ?? "ok" },
    stdio: ["ignore", out, out],
    detached: !windows,
  });
  closeSync(out);
  process.stdout.write(`e2e: beacon pid=${child.pid} port=${BEACON_PORT} mode=${process.env.E2E_BEACON_MODE ?? "ok"}\n`);
  return child;
}

/** `--firefox <wrapper>` on POSIX: the wrapper records the PID and then *is* Firefox. */
function writeFirefoxWrapper({ workDir, firefox, pidFile }) {
  const file = path.join(workDir, "firefox-wrapper.sh");
  const body =
    "#!/bin/sh\n" +
    "# web-ext does not hand out the Firefox PID and `pkill -f firefox` would hit the\n" +
    "# operator's own browser. So: record $$, then `exec`, which keeps one process —\n" +
    "# the PID in this file is the browser's own.\n" +
    `echo $$ > "${pidFile}"\n` +
    `exec "${firefox}" "$@"\n`;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

function quoteForShell(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function startWebExt({ extensionDir, firefoxArgument, logFile, windows }) {
  const args = [
    "--yes",
    "web-ext@8.9.0",
    "run",
    "--source-dir",
    extensionDir,
    "--firefox",
    firefoxArgument,
    "--arg=-headless",
    "--no-reload",
    "--no-input",
  ];
  const out = openSync(logFile, "a");
  const child = spawn("npx", windows ? args.map(quoteForShell) : args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", out, out],
    // `shell` only on Windows: there `npx` is `npx.cmd`, and Node refuses to spawn
    // a `.cmd` directly since the argument-injection fix.
    shell: windows,
    detached: !windows,
  });
  closeSync(out);
  process.stdout.write(`e2e: web-ext pid=${child.pid} firefox=${firefoxArgument}\n`);
  return child;
}

/**
 * Waits until every needle is in the log.
 *
 * A child that has already exited is a failure on the spot: otherwise a port
 * clash would cost the full deadline and end with a message about the thing that
 * never arrived instead of the log that says why.
 */
async function waitForLog({ logFile, needles, timeoutMs, what, child }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = readIfExists(logFile);
    if (needles.every((needle) => text.includes(needle))) return text;
    if (child && child.exitCode !== null) {
      fail(
        `${what} — the process exited with ${child.exitCode}\n` +
          `--- ${path.basename(logFile)} (last lines) ---\n${tail(text)}`,
      );
    }
    await sleep(POLL_MS);
  }
  fail(
    `${what} — no ${needles.map((needle) => `"${needle}"`).join(" and ")} in ` +
      `${logFile} within ${Math.round(timeoutMs / 1000)} s\n` +
      `--- ${path.basename(logFile)} (last lines) ---\n${tail(readIfExists(logFile))}`,
  );
}

async function waitForBeaconUp({ timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BEACON_URL}/state`);
      if (response.ok) return;
    } catch {
      // Not listening yet; the child prints its line a moment before the bind.
    }
    await sleep(POLL_MS);
  }
  fail(`the beacon did not answer on ${BEACON_URL}/state`);
}

/** Step 8: the MCP call, with the header and the JSON-RPC envelope. */
async function openTab({ token, url }) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "browser_open_tab", arguments: { url } },
  });
  let response;
  try {
    response = await fetch(MCP_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
  } catch (error) {
    fail(`POST ${MCP_URL} failed: ${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) fail(`POST ${MCP_URL} answered ${response.status}: ${text.slice(0, 300)}`);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    fail(`POST ${MCP_URL} answered no JSON: ${text.slice(0, 300)}`);
  }
  if (message.error) fail(`browser_open_tab failed: ${message.error.message ?? JSON.stringify(message.error)}`);
  return message.result;
}

function tabIdOf(result) {
  const text = result?.content?.find?.((block) => block.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text).tabId ?? null;
  } catch {
    return null;
  }
}

/** Step 9: the proof. A hit is only counted when the beacon answered 204. */
async function waitForBeaconHit({ timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BEACON_URL}/state`);
      if (response.ok) {
        const state = await response.json();
        if (state.hits > 0) return state.lastPing;
      }
    } catch {
      // Same as above: a beacon that is up but silent answers `hits: 0`.
    }
    await sleep(POLL_MS);
  }
  fail(
    `no beacon hit within ${Math.round(timeoutMs / 1000)} s — the page in Firefox did not reach ` +
      `${BEACON_URL}/ping (mode=${process.env.E2E_BEACON_MODE ?? "ok"})`,
  );
}

/**
 * One stack of cleanups, run in reverse start order: the newest process goes
 * first, so Firefox is not left loading a page whose bridge is already gone.
 */
function createCleanupStack() {
  const steps = [];
  return {
    push(step) {
      steps.push(step);
    },
    async run() {
      for (const step of steps.reverse()) {
        try {
          await step();
        } catch (error) {
          process.stderr.write(`cleanup: ${error.message}\n`);
        }
      }
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  // Criterion 3: only the two anchors, no browser and no port.
  if (options.selfCheck) {
    const counts = checkSeams(options.source);
    process.stdout.write(
      `seams ok: endpoint=${counts.endpoint} token=${counts.token} in ` +
        `${path.join(options.source, "background.js")}\n`,
    );
    return;
  }

  const windows = options.windows || process.platform === "win32";
  const workDir = mkdtempSync(path.join(os.tmpdir(), "browser-control-e2e-"));
  const cleanup = createCleanupStack();
  // Named outside the try block: a failure has to be able to quote the bridge log
  // before the work directory goes away with it.
  let bridgeLog = null;
  // web-ext installs the temporary add-on and starts Firefox; its output is the
  // only place that says *why* Firefox refused. It has to survive the failure too.
  let webExtLog = null;
  try {
    // Step 1 and 2: binary and token, before anything listens.
    const binary = resolveBinary({ windows });
    process.stdout.write(`e2e: binary ${binary}\n`);
    const token = ensureToken(workDir);

    // Step 3: the test copy, with both seams counted.
    const extensionDir = path.join(workDir, "ext");
    const seams = buildTestExtension({ targetDir: extensionDir, token: token.token });
    process.stdout.write(`e2e: test copy ${extensionDir} (seams ${JSON.stringify(seams.counts)})\n`);

    bridgeLog = path.join(workDir, "bridge.log");
    const beaconLog = path.join(workDir, "beacon.log");
    webExtLog = path.join(workDir, "web-ext.log");
    const firefoxPidFile = path.join(workDir, "firefox.pid");

    // Step 4: the bridge on the ports that belong to this run.
    const bridge = startBridge({ binary, tokenFile: token.file, logFile: bridgeLog, windows });
    cleanup.push(() => stopProcess({ name: "bridge", pid: bridge.pid, windows, group: !windows }));
    await waitForLog({
      logFile: bridgeLog,
      needles: [`127.0.0.1:${BRIDGE_EXT_PORT}`, "for POST /mcp"],
      timeoutMs: BRIDGE_UP_TIMEOUT_MS,
      what: "the bridge did not start",
      child: bridge,
    });

    // Step 5: the beacon.
    const beacon = startBeacon({ logFile: beaconLog, windows });
    cleanup.push(() => stopProcess({ name: "beacon", pid: beacon.pid, windows, group: !windows }));
    await waitForBeaconUp();

    if (options.onlyBridge) {
      const page = await (await fetch(`${BEACON_URL}/page`)).text();
      if (!page.includes('fetch("/ping")')) fail("the beacon page does not phone home — /page has no fetch(\"/ping\")");
      process.stdout.write("e2e: steps 1-5 ok (bridge, beacon, test copy) — no Firefox, as asked\n");
    } else {
      // Step 6: Firefox, through web-ext, which installs the copy as a temporary add-on.
      const firefox = resolveFirefox({ windows });
      const firefoxArgument = windows
        ? firefox
        : writeFirefoxWrapper({ workDir, firefox, pidFile: firefoxPidFile });
      const webExt = startWebExt({ extensionDir, firefoxArgument, logFile: webExtLog, windows });
      cleanup.push(() => stopProcess({ name: "web-ext", pid: webExt.pid, windows, group: !windows }));
      if (!windows) {
        cleanup.push(async () => {
          // Registered after web-ext, so it runs first: the browser closes before
          // the tool that started it. The PID comes from the wrapper, never from a
          // search for a command line.
          const pid = Number.parseInt(readIfExists(firefoxPidFile).trim(), 10);
          if (!Number.isInteger(pid) || pid <= 0) return;
          await stopProcess({ name: "firefox", pid, windows, group: false });
        });
      }

      // Step 7: the extension has to dial in. 60 s is 15 × the measured 4 s.
      await waitForLog({
        logFile: bridgeLog,
        needles: ["extension connected"],
        timeoutMs: CONNECT_TIMEOUT_MS,
        what: "the extension did not connect",
      });
      process.stdout.write("e2e: extension connected\n");

      // Step 8: open the page over MCP.
      const tabId = tabIdOf(await openTab({ token: token.token, url: `${BEACON_URL}/page` }));
      process.stdout.write(`e2e: browser_open_tab tab=${tabId ?? "?"} url=${BEACON_URL}/page\n`);

      // Step 9: the page has to report itself. 30 s is 7 × the measured 4 s.
      const ping = await waitForBeaconHit({ timeoutMs: BEACON_TIMEOUT_MS });
      process.stdout.write(`PING ${ping}\n`);
      process.stdout.write("e2e: ok\n");
    }
  } catch (error) {
    // The bridge log is where criterion 2 is decided: it says `open tab=` even when
    // no beacon arrived. Printing it here makes a red run readable.
    if (bridgeLog) {
      process.stderr.write(`--- bridge.log (last lines) ---\n${tail(readIfExists(bridgeLog))}\n`);
    }
    if (webExtLog) {
      process.stderr.write(`--- web-ext.log (last lines) ---\n${tail(readIfExists(webExtLog))}\n`);
    }
    throw error;
  } finally {
    // Step 10, also on a failure: `--keep` is the one exception, and it says so.
    if (options.keep) {
      process.stdout.write(`e2e: --keep, leaving everything at ${workDir}\n`);
    } else {
      await cleanup.run();
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`e2e: ${error.message}\n`);
    process.exitCode = 1;
  });
}
