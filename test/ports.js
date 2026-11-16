/**
 * The ports this test suite is allowed to bind — reserved, never searched.
 *
 * A service whose port moves is useless to a client, and a port search hides
 * exactly the collision one wants to see. On 2026-10-23 two concurrent
 * `npm test` runs swallowed each other's bridges that way and hung until the
 * deadline; a collision has to be a red test at once instead
 * (docs/18, "Nachtrag 2026-10-23: feste Ports, keine Suche").
 *
 * Rules of the range, kept short because a table is only useful if it stays
 * readable:
 * - One entry per test file that binds a port. Two files on one number is the
 *   bug this module exists to prevent, and `test/ports.test.js` asserts it.
 * - `18110`–`18119` only: `8110`/`8111` belong to the operator's running
 *   bridge, and anything below `1024` would want privileges in production too.
 * - Adding a file that binds a port means adding an entry here first. The
 *   numbers are the whole contract; nothing derives them at runtime.
 *
 * The module exports nothing but the table, so `Object.entries(PORTS)` in the
 * test is the complete list, not an accident of naming.
 */

/** Extension listener of `test/bridge.test.js`; `http` is the port that file proves stays unbound. */
export const EXTENSION_BRIDGE = Object.freeze({ extension: 18110, http: 18111 });

/** Extension listener of `test/mcp.test.js` — protocol over stdio, so no HTTP port. */
export const MCP_FIXTURE = Object.freeze({ extension: 18112 });

/** Both listeners of `test/http-mcp.test.js`. */
export const HTTP_MCP = Object.freeze({ extension: 18113, http: 18114 });

/**
 * Both listeners of `scripts/parity.sh` — the parity run spawns the bridge instead
 * of the test runner doing it, and `http` is only bound by the `--http` log case.
 * Reserved here for the same reason as every other entry: two runs on one number is
 * the collision this table exists to prevent.
 */
export const PARITY = Object.freeze({ extension: 18115, http: 18116 });
