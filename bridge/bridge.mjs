/**
 * Entry point of the bridge: read configuration, refuse to start without a
 * usable token, then hand WebSocket upgrades on the configured address to the
 * hub and serve MCP on stdin/stdout — and, with `--http`, additionally on
 * `POST /mcp` over loopback.
 *
 * stdout is the JSON-RPC channel and nothing else: every line this file writes
 * — its own and the hub's — goes to stderr.
 *
 * The two exit codes of the service are deliberate: `1` for a port that could
 * not be bound (systemd restarts, which is the point), `2` for a missing or too
 * short token file (no restart heals that, which is what
 * `RestartPreventExitStatus=2` in the unit is for).
 */
import fs from "node:fs";
import http from "node:http";

import { loadConfig, readToken, tokenPath } from "./config.mjs";
import { Hub } from "./hub.mjs";
import { startHttpTransport } from "./http-transport.mjs";
import { handleMessageText, startMcpServer } from "./mcp.mjs";
import { findPortOwner } from "./port-owner.mjs";
import { upgradeSocket } from "./websocket.mjs";

// The only argv this entry point reads. `BC_HTTP_PORT` sets a *port*, never a
// *mode*: an agent harness spawns this file with the operator's environment
// inherited, and a second bind on 8111 would get EADDRINUSE, end with exit 1 and
// leave that session without a single tool — the exact failure this increment
// exists to remove.
const HTTP_FLAG = "--http";

// `/mcp` is loopback-only by design and never goes behind a proxy. Naming the
// default here is what lets a bind failure print the address it tried instead of
// guessing one.
const MCP_HOST = "127.0.0.1";

/**
 * One log line, prefixed with an ISO timestamp. This is also the hub's log
 * writer: the hub formats the message, the timestamp belongs to the process.
 */
function logLine(message) {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * IPv6 literals are logged in their bracketed form; `::1:8110` reads like a
 * different address entirely.
 */
function formatAddress({ host, port }) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Behind the reverse proxy the peer is always the proxy's address. That is the
 * intended reading — `X-Forwarded-For` is not trusted, because any client can
 * set it.
 */
function peerAddress(socket) {
  return socket.remoteAddress ?? "unknown";
}

/**
 * Plain HTTP requests are refused rather than ignored: this listener speaks
 * WebSocket only, and a 426 tells a lost `curl` that much immediately.
 *
 * `http.createServer` calls its listener as `(req, res)`, so this signature
 * must match it — an `(res)` parameter would bind the request object and turn
 * every non-upgrade request into a `TypeError` that kills the process. Caddy
 * produces exactly such requests whenever a client speaks HTTP/2.
 */
function rejectPlainRequest(_req, res) {
  res.writeHead(426, {
    "Content-Type": "text/plain; charset=utf-8",
    Connection: "close",
  });
  res.end("WebSocket upgrade required\n");
}

/**
 * The two lines a failed bind writes: what failed, and who owns the port.
 *
 * The owner comes from `findPortOwner`, which reads `/proc`; the alternative —
 * `lsof`/`ss` — would be a binary a minimal systemd `PATH` may not have. When it
 * cannot answer, the line says so instead of naming a PID, because a wrong PID
 * sends the operator hunting the wrong process.
 */
function logBindFailure({ label, host, port, error }) {
  const address = formatAddress({ host, port });
  logLine(`${label} failed on ${address}: ${error.code ?? error.message}`);
  logLine(`port ${address} in use, ${describePortOwner(port)}`);
}

function describePortOwner(port) {
  // Matched by port alone: `127.0.0.1:8111` and `0.0.0.0:8111` both make a bind
  // fail with EADDRINUSE, so "who owns 8111" is the useful question.
  const owner = findPortOwner({ port });
  if (owner === null) return "Besitzer nicht ermittelbar";
  return `owner pid=${owner.pid} name=${owner.name}`;
}

/**
 * Binds a listener and resolves once it is listening; the bind error (EADDRINUSE
 * among them) comes back as a rejection instead of an `error` event nobody is
 * waiting for at that moment.
 */
function listenOn(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * The shutdown contract a listener has to satisfy: `close()` drops the listener
 * and every connection it still holds. The HTTP transport's handle has the same
 * method; the extension server needs `closeAllConnections` explicitly, because
 * `server.close()` alone waits for upgraded sockets that no longer report to it.
 */
function closeListener(server) {
  return {
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/**
 * Shuts every listener down and exits 0 through a single, idempotent path.
 *
 * SIGTERM, SIGINT and the end of stdin can arrive in the same tick, and a second
 * run would log a second "shutting down" and call `process.exit` on a process
 * that is already leaving. The boolean guard is the whole protection.
 *
 * The handles join the set as they exist — the extension listener first, the
 * HTTP one only once its bind resolved — so a SIGTERM in that window still exits
 * 0 through this path instead of dying with the default signal exit.
 *
 * The exit does not wait for `close()`'s callback: a socket upgraded to WebSocket
 * still counts as a live connection of the HTTP server but is no longer managed
 * by it, so that callback may never fire and the process would hang on SIGTERM.
 * There is no state worth draining — the log writes to stderr synchronously.
 */
function installShutdownHandlers() {
  const closables = new Set();
  let stopped = false;

  const stop = (reason) => {
    if (stopped) return;
    stopped = true;

    logLine(`${reason}, shutting down`);
    for (const closable of closables) closable.close();
    process.exitCode = 0;
    process.exit(0);
  };

  process.once("SIGTERM", () => stop("received SIGTERM"));
  process.once("SIGINT", () => stop("received SIGINT"));

  return { stop, attach: (closable) => closables.add(closable) };
}

/**
 * True only when stdin is a channel whose end means "the client is gone".
 *
 * `isFIFO()` alone would be wrong in both directions. Node gives a child started
 * with `stdio: "pipe"` a Unix socketpair (`isFIFO=false isSocket=true`), so the
 * rule would never fire under pi; and `echo | nohup … &` as well as a non-PTY
 * `ssh` hand over a pipe, where the standalone bridge from INSTALL.md must
 * survive the EOF. `/dev/null` (`stdio: "ignore"`, `nohup … &` from a terminal)
 * and a terminal are character devices and are ignored.
 *
 * EBADF means fd 0 is already closed: nothing will ever arrive, so there is
 * nothing to react to either.
 */
function stdinIsClientChannel() {
  try {
    const stats = fs.fstatSync(0);
    return stats.isFIFO() || stats.isSocket();
  } catch {
    return false;
  }
}

/**
 * The extension-facing listener: WebSocket upgrades go to the hub, everything
 * else is refused by `rejectPlainRequest`.
 */
function createExtensionServer(hub) {
  const server = http.createServer(rejectPlainRequest);
  server.on("upgrade", (req, socket, head) => {
    const connection = upgradeSocket(req, socket, head);
    // A request that is not a valid handshake has already been answered with
    // 400 by `upgradeSocket`; there is nothing to attach to.
    if (connection === null) return;
    hub.handleConnection(connection, peerAddress(socket));
  });
  return server;
}

async function main(env = process.env, argv = process.argv.slice(2)) {
  const config = loadConfig(env);
  const address = formatAddress(config);
  const tokenFile = tokenPath(env);
  const token = readToken(tokenFile);

  if (token === null) {
    logLine(`token file missing or too short: ${tokenFile}`);
    process.exit(2);
  }

  const hub = new Hub({ config, token, log: logLine });
  // Installed before anything binds: a signal during startup must exit 0 through
  // the same path a signal during work does.
  const shutdown = installShutdownHandlers();

  const extensionServer = createExtensionServer(hub);
  const extensionListener = closeListener(extensionServer);
  shutdown.attach(extensionListener);

  try {
    await listenOn(extensionServer, config);
  } catch (error) {
    logBindFailure({ label: "listener", host: config.host, port: config.port, error });
    process.exit(1);
  }

  // Failures after a successful bind (EMFILE, a broken socket) still end the
  // process with 1: there is nothing to keep serving without the listener.
  extensionServer.on("error", (error) => {
    logLine(`listener failed on ${address}: ${error.code ?? error.message}`);
    process.exit(1);
  });
  logLine(`listening on ${address} log=${config.logLevel}`);

  // Unconditional, in both modes: under systemd stdin is `/dev/null`, so
  // `stdinIsClientChannel()` stays false and its EOF is not a shutdown request.
  // That is the reason the unit lives at all — and the reason removing this call
  // would look like a working service for exactly as long as nobody sent a
  // SIGTERM.
  startMcpServer({
    hub,
    log: logLine,
    onInputClosed: () => {
      // Only a pipe or socketpair stdin belongs to a client. Under
      // `stdio: "ignore"` or `< /dev/null` the EOF is not a shutdown request —
      // it is how the standalone bridge is started.
      if (stdinIsClientChannel()) shutdown.stop("stdin closed");
    },
  });

  // stdio is up before the second bind starts: a client that speaks first must
  // not wait for a free port, and a failing `/mcp` bind must not cost it the
  // transport that already works.
  if (!argv.includes(HTTP_FLAG)) return;

  const mcpAddress = { host: MCP_HOST, port: config.httpPort };
  let transport;
  try {
    transport = await startHttpTransport({
      ...mcpAddress,
      token,
      // The hub reaches the tool layer here, not inside the transport: the
      // transport knows HTTP and JSON-RPC, nothing about extensions. One seam,
      // two ways in, identical answers.
      toolSet: { handleMessageText: (text) => handleMessageText(text, { hub, log: logLine }) },
      log: logLine,
    });
  } catch (error) {
    logBindFailure({ label: "http listener", ...mcpAddress, error });
    // No half-alive service: a bridge that answers the extension but not `/mcp`
    // looks healthy in `systemctl status` while every HTTP call fails. Closing
    // the bound listener first makes the exit honest.
    extensionListener.close();
    process.exit(1);
  }

  shutdown.attach(transport);
  logLine(`listening on ${formatAddress(transport)} for POST /mcp`);
}

main().catch((error) => {
  // Nothing in `main` is expected to throw. If something does, one line beats a
  // stack trace in the journal, and 1 is the code for "this start failed".
  logLine(`bridge failed: ${error?.message ?? error}`);
  process.exit(1);
});
