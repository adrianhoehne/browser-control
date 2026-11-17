/**
 * The portable zip and the two start scripts inside it.
 *
 * Two halves on purpose. The archive cases read what `scripts/bundle.sh`
 * produced; the guide cases read the two texts in `docs/portable/`. Only the
 * archive cases need `zip`/`unzip`, so only they skip. A missing bridge binary
 * is a **failure**, never a skip: a green run that never looked at a built zip
 * would prove nothing about the thing this file exists to check.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE_SCRIPT = path.join(REPO_ROOT, "scripts", "bundle.sh");
const MANIFEST = path.join(REPO_ROOT, "extension", "manifest.json");
const GUIDE_DIR = path.join(REPO_ROOT, "docs", "portable");
const VERSION = JSON.parse(readFileSync(MANIFEST, "utf8")).version;

/** 8110/8111 belong to the service; 18110–18119 are reserved for the suites. */
const RESERVED_PORTS = new Set([8110, 8111]);
const RESERVED_PORT_RANGE = { from: 18110, to: 18119 };
const READY_TIMEOUT_MS = 20000;

function hasTool(name) {
  return spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).status === 0;
}

const SKIP = !hasTool("bash") || !hasTool("zip") || !hasTool("unzip")
  ? "needs bash, zip and unzip"
  : false;

/** The two artefacts, built once for the whole file. */
let built;

function bundle() {
  if (built !== undefined) return built;

  const result = spawnSync("bash", [BUNDLE_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(
    result.status,
    0,
    `scripts/bundle.sh failed with ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );

  built = {
    linux: path.join(REPO_ROOT, "dist", `browser-control-${VERSION}-linux-x86_64.zip`),
    windows: path.join(REPO_ROOT, "dist", `browser-control-${VERSION}-windows-x86_64.zip`),
  };
  return built;
}

function entriesOf(artifact) {
  const listed = spawnSync("unzip", ["-Z1", artifact], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\n").filter((line) => line !== "");
}

function contentOf(artifact, name) {
  const read = spawnSync("unzip", ["-p", artifact, name], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(read.status, 0, read.stderr);
  return read.stdout;
}

/**
 * Unpacks one artefact into a fresh sandbox and returns the top-level folder —
 * the folder the user sees after "Extract here".
 */
function unpack(t, platform) {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "bc-bundle-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const extracted = spawnSync("unzip", ["-q", bundle()[platform], "-d", sandbox], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);

  return { sandbox, folder: path.join(sandbox, `browser-control-${VERSION}-${platform}-x86_64`) };
}

async function freePort() {
  // Ask the kernel for a port and throw it away again. Not a reservation — but
  // the closest a test gets without a registry, and the ranges that would
  // collide with the service or the other suites are retried.
  for (;;) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));

    if (RESERVED_PORTS.has(port)) continue;
    if (port >= RESERVED_PORT_RANGE.from && port <= RESERVED_PORT_RANGE.to) continue;
    return port;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => reject(new Error("the bridge did not exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForLine(child, logPath, needle) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    if (text.includes(needle)) return;

    if (child.exitCode !== null) {
      throw new Error(`the bridge exited with ${child.exitCode} before "${needle}" appeared:\n${text}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`"${needle}" did not appear within ${READY_TIMEOUT_MS} ms:\n${text}`);
    }
    await delay(100);
  }
}

/**
 * Starts `start.sh` from `folder` on two free ports and waits until both
 * listeners are up. stdout and stderr go to separate files: the three printed
 * lines are a stdout contract, the bridge logs on stderr, and mixing them would
 * make "exactly three lines" untestable.
 */
async function startBridge(t, folder, options = {}) {
  const bindPort = await freePort();
  const httpPort = await freePort();

  const logDir = mkdtempSync(path.join(os.tmpdir(), "bc-bundle-log-"));
  const ownedHome = options.home === undefined;
  const home = ownedHome ? mkdtempSync(path.join(os.tmpdir(), "bc-bundle-home-")) : options.home;
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  if (ownedHome) t.after(() => rmSync(home, { recursive: true, force: true }));

  const stdoutPath = path.join(logDir, "stdout.log");
  const stderrPath = path.join(logDir, "stderr.log");
  const stdout = openSync(stdoutPath, "w");
  const stderr = openSync(stderrPath, "w");

  const child = spawn("bash", [path.join(folder, "start.sh")], {
    cwd: folder,
    // stdin is /dev/null and not a pipe: a closed pipe means "the client is
    // gone" to the bridge, which is the difference between the unit and a bare
    // `spawn` without this line.
    stdio: ["ignore", stdout, stderr],
    env: {
      ...process.env,
      HOME: home,
      BC_BIND: `127.0.0.1:${bindPort}`,
      BC_HTTP_PORT: String(httpPort),
    },
  });
  closeSync(stdout);
  closeSync(stderr);

  // Clean up by PID, never by pattern: `pkill -f browser-control-bridge` would
  // also take the operator's service down (CONTRIBUTING.md).
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitForLine(child, stderrPath, `listening on 127.0.0.1:${bindPort}`);
  await waitForLine(child, stderrPath, `listening on 127.0.0.1:${httpPort} for POST /mcp`);

  return {
    bindPort,
    httpPort,
    stdout: () => readFileSync(stdoutPath, "utf8"),
    stderr: () => readFileSync(stderrPath, "utf8"),
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.kill("SIGTERM");
      return waitForExit(child, 10000);
    },
  };
}

function listPaths(root) {
  const found = new Set();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      found.add(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
}

function isInside(candidate, folder) {
  return candidate === folder || candidate.startsWith(`${folder}${path.sep}`);
}

test("bundle_linuxZip_shouldContainExactlyTheSevenEntries", { skip: SKIP }, () => {
  // GIVEN the built Linux artefact,
  const { linux } = bundle();
  const root = `browser-control-${VERSION}-linux-x86_64`;

  // WHEN its entry names are listed,
  const names = entriesOf(linux);

  // THEN they are the folder entry plus exactly six files — no data/, no
  // target/ leftovers, no .git. The deep equality is the point: a seventh file
  // or a stray folder is what the "nothing else" clause means:
  assert.deepEqual(names.slice().sort(), [
    `${root}/`,
    `${root}/browser-control-${VERSION}.xpi`,
    `${root}/browser-control-bridge`,
    `${root}/CLIENTS.md`,
    `${root}/FIREFOX.md`,
    `${root}/README.txt`,
    `${root}/start.sh`,
  ].sort());
});

test("bundle_windowsZip_shouldContainTheExeAndTheCmd", { skip: SKIP }, () => {
  // GIVEN the built Windows artefact,
  const { windows } = bundle();
  const root = `browser-control-${VERSION}-windows-x86_64`;

  // WHEN its entry names are listed,
  const names = entriesOf(windows);

  // THEN the same list carries the .exe and start.cmd instead of the Linux pair —
  // a Windows zip with start.sh in it is a zip nobody can start:
  assert.deepEqual(names.slice().sort(), [
    `${root}/`,
    `${root}/browser-control-${VERSION}.xpi`,
    `${root}/browser-control-bridge.exe`,
    `${root}/CLIENTS.md`,
    `${root}/FIREFOX.md`,
    `${root}/README.txt`,
    `${root}/start.cmd`,
  ].sort());
});

test("bundle_shouldNotCarryAToken", { skip: SKIP }, () => {
  // GIVEN both artefacts,
  const artifacts = Object.values(bundle());

  for (const artifact of artifacts) {
    const names = entriesOf(artifact);

    // WHEN the entry names are searched for the folder a token would live in,
    // THEN there is none: the token is created on the first start, and a token in
    // a download is the same key for every user:
    assert.deepEqual(names.filter((name) => /(^|\/)data\//.test(name)), [], artifact);

    // ... and the files a human writes carry no 32+ hex run. The binaries are
    // excluded on purpose: a compiled binary carries hexadecimal tables, so a
    // match there would be a false alarm and not a secret.
    const writtenByHand = names.filter((name) => /\.(sh|cmd|txt|md)$/.test(name));
    // Four text files per artefact: the start script, README.txt and the two guides.
    assert.equal(writtenByHand.length, 4, `${artifact}: ${writtenByHand.join(", ")}`);
    for (const name of writtenByHand) {
      assert.doesNotMatch(contentOf(artifact, name), /[0-9a-f]{32,}/, `${name} carries a token-shaped string`);
    }
  }
});

test("startSh_shouldCreateTheTokenOnceAndKeepIt", { skip: SKIP }, async (t) => {
  // GIVEN an unpacked Linux folder,
  const { folder } = unpack(t, "linux");
  const tokenPath = path.join(folder, "data", "token");

  // WHEN the start script runs for the first time,
  const first = await startBridge(t, folder);

  // THEN it creates the token with the documented shape and mode, and prints
  // exactly the three lines the guides refer to. The printed ports have to be the
  // ports it listens on — a script that prints 8110 and listens on 18130 is the
  // most expensive mistake this package could make:
  assert.ok(existsSync(tokenPath), "data/token was not created");
  const token = readFileSync(tokenPath, "utf8").trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  assert.equal(
    first.stdout(),
    `endpoint: ws://127.0.0.1:${first.bindPort}\n` +
      `http: http://127.0.0.1:${first.httpPort}/mcp\n` +
      `token: ${token}\n`,
  );
  await first.stop();

  // WHEN the script runs a second time,
  const second = await startBridge(t, folder);

  // THEN the token is untouched: a rewritten token would log the extension out on
  // every restart, which is what "kept" has to mean here:
  assert.equal(readFileSync(tokenPath, "utf8").trim(), token);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  await second.stop();
});

test("startSh_shouldRefuseATooShortToken", { skip: SKIP }, (t) => {
  // GIVEN an unpacked folder whose token is below the bridge's 32-character floor,
  const { folder } = unpack(t, "linux");
  mkdirSync(path.join(folder, "data"), { recursive: true });
  writeFileSync(path.join(folder, "data", "token"), "0123abcd\n");

  // WHEN the start script runs,
  const result = spawnSync("bash", [path.join(folder, "start.sh")], {
    cwd: folder,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // The ports cannot matter: the bridge stops before it binds anything. They
    // still stay outside the reserved ranges, so a broken script that does bind
    // cannot collide with the service or the other suites.
    env: { ...process.env, HOME: folder, BC_BIND: "127.0.0.1:18220", BC_HTTP_PORT: "18221" },
    timeout: READY_TIMEOUT_MS,
  });

  // THEN the bridge's own exit code 2 comes through: the script invents no second
  // threshold of its own, and `exec` hands the code over unchanged:
  assert.equal(result.status, 2, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
});

test("startSh_shouldNotWriteOutsideItsFolder", { skip: SKIP }, async (t) => {
  // GIVEN an unpacked folder in a sandbox that also holds its own empty HOME,
  const { sandbox, folder } = unpack(t, "linux");
  const home = path.join(sandbox, "home");
  mkdirSync(home);

  const before = listPaths(sandbox);

  // WHEN the server runs and stops,
  const run = await startBridge(t, folder, { home });
  await run.stop();

  // THEN nothing outside the folder is new — not in HOME either, where a stale
  // default would put its token. This is the sandboxed form of "no ~/.config,
  // no ~/.local/bin, no unit":
  const written = [...listPaths(sandbox)]
    .filter((candidate) => !before.has(candidate))
    .filter((candidate) => !isInside(candidate, folder));

  assert.deepEqual(written, []);
});

test("startSh_shouldNotDeriveTheTokenFromTimeOrPid", { skip: SKIP }, async (t) => {
  // GIVEN two fresh folders, each unpacked on its own,
  const first = unpack(t, "linux");
  const second = unpack(t, "linux");

  // WHEN each one starts once,
  const firstRun = await startBridge(t, first.folder);
  const firstToken = readFileSync(path.join(first.folder, "data", "token"), "utf8").trim();
  await firstRun.stop();

  const secondRun = await startBridge(t, second.folder);
  const secondToken = readFileSync(path.join(second.folder, "data", "token"), "utf8").trim();
  await secondRun.stop();

  // THEN the two tokens differ, and each is 32 random bytes in hex. A timestamp
  // or a PID would pass the "differ" half; the length is what rules out a short
  // derivation standing in for randomness:
  assert.notEqual(firstToken, secondToken);
  assert.match(firstToken, /^[0-9a-f]{64}$/);
  assert.match(secondToken, /^[0-9a-f]{64}$/);
});

/**
 * The two guides are prose, so only their structure is tested. A missing step is
 * a user who stops halfway and has nothing to read.
 */
function guideText(fileName) {
  return readFileSync(path.join(GUIDE_DIR, fileName), "utf8");
}

function numberedSteps(text) {
  return text
    .split("\n")
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => Number.parseInt(line, 10));
}

test("guides_shouldBeNumberedFromOne", () => {
  // GIVEN the two guides in the repository,
  const expectedSteps = { "FIREFOX.md": 9, "CLIENTS.md": 7 };

  for (const [fileName, atLeast] of Object.entries(expectedSteps)) {
    // WHEN the numbered lines are collected,
    const steps = numberedSteps(guideText(fileName));

    // THEN the list starts at 1 and has no gap — a missing number is a missing
    // instruction, and "repeat steps 3 to 9" in FIREFOX.md counts on the numbers
    // being the real ones:
    assert.deepEqual(steps, Array.from({ length: steps.length }, (_unused, index) => index + 1), fileName);
    assert.ok(steps.length >= atLeast, `${fileName} has ${steps.length} steps, expected at least ${atLeast}`);
  }
});

test("guides_shouldNameThePrintedLines", () => {
  // GIVEN the two guides,
  // WHEN each one is searched for the address it is about,
  // THEN the pairing holds: the extension guide carries the WebSocket endpoint,
  // the client guide carries the MCP URL — and the client guide names it once per
  // client it documents (pi, Codex, OpenCode):
  const firefox = guideText("FIREFOX.md");
  const clients = guideText("CLIENTS.md");

  assert.match(firefox, /ws:\/\/127\.0\.0\.1:8110/);

  const mcpAddresses = clients.match(/http:\/\/127\.0\.0\.1:8111\/mcp/g) ?? [];
  assert.ok(mcpAddresses.length >= 3, `CLIENTS.md names the MCP address ${mcpAddresses.length} times`);
});
