/**
 * Environment of the bridge, read once at startup.
 *
 * Everything here is pure: no I/O besides `readToken()`, no globals. `main()`
 * passes `process.env` in, which keeps this file testable without spawning a
 * process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTOCOL } from "./protocol.mjs";

const DEFAULT_BIND = Object.freeze({ host: "127.0.0.1", port: 8110 });

// The second endpoint: MCP over HTTP. Its own port, because it is its own
// listener — the extension socket must not share a surface with it.
const DEFAULT_HTTP_PORT = 8111;
const DEFAULT_LOG_LEVEL = "info";
const LOG_LEVELS = Object.freeze(["info", "debug"]);

// bc's token contract: at least 32 hex characters, because that is the shortest
// sane `openssl rand -hex 16`. Filesystem permissions (0600) are the operator's
// job, not ours — checking them here would only produce false comfort.
const MIN_TOKEN_LENGTH = 32;
const HEX_ONLY = /^[0-9a-f]+$/i;

/**
 * Reads and trims one environment variable. Absent and blank are the same
 * thing: neither is a configuration decision.
 */
function readEnv(env, name) {
  const raw = env?.[name];
  return typeof raw === "string" ? raw.trim() : "";
}

function parsePort(rawPort) {
  if (rawPort === "") return null;
  const port = Number(rawPort);
  const isValid = Number.isInteger(port) && port > 0 && port <= 65535;
  return isValid ? port : null;
}

/**
 * Node resolves hosts through getaddrinfo, which does not accept the bracketed
 * `[::1]` notation. The brackets are added back only when needed for display,
 * so `BC_BIND=[::1]:8110` actually listens instead of failing with ENOTFOUND.
 */
function stripIpv6Brackets(host) {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/**
 * Splits at the *last* colon: an IPv6 literal contains colons of its own, and
 * `split(":")` would shred `[::1]:8110` into five useless pieces.
 */
function parseBind(rawBind) {
  if (rawBind === "") return { ...DEFAULT_BIND };

  const separator = rawBind.lastIndexOf(":");
  if (separator === -1) return { ...DEFAULT_BIND };

  const host = stripIpv6Brackets(rawBind.slice(0, separator));
  const port = parsePort(rawBind.slice(separator + 1));

  // An empty host would mean "all interfaces" to Node. Falling back to loopback
  // is the safer reading of a broken value: this listener is meant to sit
  // behind the reverse proxy, nowhere else.
  return {
    host: host === "" ? DEFAULT_BIND.host : host,
    port: port ?? DEFAULT_BIND.port,
  };
}

function parseTimeout(rawValue, fallback) {
  const value = Number(rawValue);
  const isValid = Number.isInteger(value) && value > 0;
  return isValid ? value : fallback;
}

/**
 * Turns the raw environment into the bridge's configuration. Invalid values
 * fall back to their default instead of throwing: a bridge that refuses to
 * start because of a stray typo in `BC_LOG` helps nobody.
 */
export function loadConfig(env = process.env) {
  const { host, port } = parseBind(readEnv(env, "BC_BIND"));
  const rawLogLevel = readEnv(env, "BC_LOG");
  const logLevel = LOG_LEVELS.includes(rawLogLevel) ? rawLogLevel : DEFAULT_LOG_LEVEL;

  return {
    host,
    port,
    httpPort: parsePort(readEnv(env, "BC_HTTP_PORT")) ?? DEFAULT_HTTP_PORT,
    logLevel,
    helloTimeoutMs: parseTimeout(readEnv(env, "BC_HELLO_TIMEOUT_MS"), PROTOCOL.HELLO_TIMEOUT_MS),
    callTimeoutMs: parseTimeout(readEnv(env, "BC_CALL_TIMEOUT_MS"), PROTOCOL.CALL_TIMEOUT_MS),
  };
}

/**
 * Path of the token file. The default is built with `os.homedir()` because Node
 * does not expand a literal `~` — a tilde reaching `readFile` is a guaranteed
 * ENOENT on a perfectly valid configuration.
 */
export function tokenPath(env = process.env) {
  const configured = readEnv(env, "BC_TOKEN_FILE");
  if (configured !== "") return configured;
  return path.join(os.homedir(), ".config/browser-control/token");
}

/**
 * Returns the trimmed token, or null when it is missing or unusable. The
 * caller decides what null means; here it only means "no token we could use".
 *
 * `openssl rand -hex 32 > token` writes a trailing newline, so the content is
 * trimmed before both checks and return.
 */
export function readToken(tokenFile) {
  let content;
  try {
    content = fs.readFileSync(tokenFile, "utf8");
  } catch (error) {
    // A missing file is a configuration state the caller reports with exit 2.
    // Anything else (EACCES, EISDIR) is a different problem and should surface
    // as one instead of hiding behind "missing or too short".
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const token = content.trim();
  if (token.length < MIN_TOKEN_LENGTH) return null;
  if (!HEX_ONLY.test(token)) return null;
  return token;
}
