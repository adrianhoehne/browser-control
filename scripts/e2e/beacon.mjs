#!/usr/bin/env node
/**
 * The beacon: a page that phones home, so the E2E run has something Firefox
 * itself can prove.
 *
 * The bridge could answer "opened" without a browser being there; the loaded
 * page cannot. It runs `fetch("/ping")` on load, this server answers 204 and
 * remembers when — that hit is the whole point of the test (`docs/40`,
 * criterion 1).
 *
 * `E2E_BEACON_MODE=broken` answers `/ping` with **500** instead of 204 and
 * records no hit. That is criterion 2: a run with a beacon that fails must be a
 * red run, even though the bridge still reports `open tab=`.
 *
 * Two shapes in one file, on purpose: `startBeacon` is the library form (used by
 * the tests, on an ephemeral port) and the CLI form is what `run.mjs` spawns as
 * a child so step 10 can clean it up by PID.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

/** Where the E2E run expects it (`docs/40`); never 18990 on a service port. */
export const BEACON_PORT = 18990;

export const MODE_OK = "ok";
export const MODE_BROKEN = "broken";

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>beacon</title></head>
  <body>
    <p>beacon</p>
    <script>
      // Relative on purpose: same origin, so there is no CORS preflight and no
      // token to configure. A failure is swallowed — the server's counter, not
      // the page's console, is what the test reads.
      fetch("/ping").catch(() => {});
    </script>
  </body>
</html>
`;

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  // A 204 must not announce a body; `content-length: 0` next to it would be a lie
  // about a message that RFC 9110 says has none.
  if (status === 204) {
    response.writeHead(status, { "cache-control": "no-store" });
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

/**
 * The beacon as an object: `listen(port)` binds, `hits` and `attempts` are the
 * counters, `state()` is what `/state` answers.
 *
 * `hits` counts 204 answers only. A request that arrived while the mode is
 * `broken` is an `attempt`: the page's `fetch` rejected, so treating it as a hit
 * would let a failing beacon pass the test it exists to fail.
 */
export function createBeacon({ mode = MODE_OK, onHit = () => {} } = {}) {
  const hits = [];
  const attempts = [];

  const server = http.createServer((request, response) => {
    // A malformed URL is not worth a stack trace in a test run.
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      send(response, 400, "bad request\n");
      return;
    }

    if (url.pathname === "/page") {
      send(response, 200, PAGE_HTML, "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/ping") {
      if (mode === MODE_BROKEN) {
        attempts.push(new Date().toISOString());
        send(response, 500, "beacon is broken on purpose\n");
        return;
      }
      const stamp = new Date().toISOString();
      hits.push(stamp);
      send(response, 204, "");
      onHit(stamp);
      return;
    }

    if (url.pathname === "/state") {
      send(response, 200, JSON.stringify(stateOf()), "application/json");
      return;
    }

    send(response, 404, "not found\n");
  });

  function stateOf() {
    return {
      mode,
      hits: hits.length,
      attempts: attempts.length,
      lastPing: hits.at(-1) ?? null,
    };
  }

  return {
    server,
    hits,
    attempts,
    state: stateOf,

    /** Binds and resolves with the real port (so `port: 0` works in tests). */
    listen(port = BEACON_PORT) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    },

    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function parseArgs(argv) {
  const options = { port: BEACON_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") {
      const value = argv[index + 1];
      if (!/^\d+$/.test(value ?? "")) {
        throw new Error("--port needs a number");
      }
      options.port = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function modeFromEnvironment() {
  const raw = (process.env.E2E_BEACON_MODE ?? MODE_OK).trim().toLowerCase();
  if (raw === MODE_BROKEN) return MODE_BROKEN;
  // Anything else means `ok`: a typo must not silently disable the proof.
  return MODE_OK;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "usage: scripts/e2e/beacon.mjs [--port 18990]\n\n" +
        "Serves /page (HTML with fetch(\"/ping\")), /ping (204, or 500 when\n" +
        "E2E_BEACON_MODE=broken) and /state (JSON counters).\n",
    );
    return;
  }

  const mode = modeFromEnvironment();
  const beacon = createBeacon({
    mode,
    // The line criterion 1 looks for on stdout. It carries the stamp of the
    // request the *page* made, not the time this process noticed it.
    onHit: (stamp) => process.stdout.write(`PING ${stamp}\n`),
  });
  const port = await beacon.listen(options.port);
  process.stdout.write(`beacon listening on http://127.0.0.1:${port} mode=${mode}\n`);

  const stop = () => {
    beacon.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`beacon: ${error.message}\n`);
    process.exit(1);
  });
}
