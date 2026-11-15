/**
 * The hub: everything that happens on one accepted connection after the frame
 * layer did its job — authentication, the requests to the extension, and the
 * timers around them.
 *
 * The hub owns no socket and writes no timestamp. It gets a `log` writer
 * injected (bridge.mjs prefixes the ISO timestamp) and a `conn` that already
 * speaks WebSocket, which keeps every decision in here testable without a
 * process, a clock stub or a real network peer.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { PROTOCOL } from "./protocol.mjs";

// The extension reads its own version from the manifest; the bridge reports the
// version of this package. Hard-coded on purpose: the Hub interface takes only
// `{config, token, log, onStatus}`, and a JSON import would print an
// experimental warning on the stderr stream the operator is supposed to read.
const BRIDGE_VERSION = "0.1.0";

const NO_ERROR_CODE = "unknown";

// Stands in for a field a broken result did not carry, so the log line keeps its
// shape and the reader sees the hole instead of a shifted column.
const NO_FIELD = "?";

// The hole marker of the `inspect` line, deliberately not `NO_FIELD`: the spec
// spells that line's holes as `selector=<selektor|->`, and a lone `?` there would
// read like a one-character selector instead of "not set".
const UNSET_INSPECT_FIELD = "-";

// The sources the injected page code may name. Whitelisted here as well as in the
// extension: a log line is the wrong place to find out what a broken result says.
const TEXT_SOURCES = Object.freeze(["innerText", "textContent"]);

// The three ways a request can fail. A `name` instead of a class per case
// because the caller switches on it, and a `switch` over names survives the
// module boundary that `instanceof` quietly does not.
const UNAVAILABLE = "ExtensionUnavailable";
const TIMEOUT = "ExtensionTimeout";
const EXTENSION_ERROR = "ExtensionError";

/**
 * `status windows=2 tabs=14`, with the tab count summed over all windows.
 *
 * Missing or malformed structures count as zero instead of throwing: a broken
 * result must not take the connection down with it, and the log line is more
 * useful than a stack trace.
 */
export function formatStatusLine(result) {
  const windows = Array.isArray(result?.windows) ? result.windows : [];
  const tabs = windows.reduce((total, window) => total + countTabs(window), 0);
  return `status windows=${windows.length} tabs=${tabs}`;
}

function countTabs(window) {
  return Array.isArray(window?.tabs) ? window.tabs.length : 0;
}

/**
 * `navigate tab=42 url=https://example.org/ complete=true`.
 *
 * Read as defensively as `formatStatusLine`: a navigation is the one action the
 * agent takes in the operator's browser, so its proof line has to survive a
 * malformed result rather than throw it away.
 */
function formatNavigateLine(result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  const url = typeof result?.url === "string" ? result.url : NO_FIELD;
  const complete = result?.complete === true ? "true" : "false";
  return `navigate tab=${tabId} url=${url} complete=${complete}`;
}

/**
 * `focus tab=42 window=1`.
 *
 * Shorter than the `navigate` line on purpose: `focus` changes nothing the
 * operator could not see, so there is no page fact worth repeating. The `url`
 * stays out even though the result carries one — the only proof this line owes is
 * *which* tab came forward, and in which window.
 */
function formatFocusLine(result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  const windowId = Number.isInteger(result?.windowId) ? String(result.windowId) : NO_FIELD;
  return `focus tab=${tabId} window=${windowId}`;
}

/**
 * `read tab=42 url=https://example.org/ chars=1234 truncated=false via=innerText`.
 *
 * The page text never reaches this line: the operator's mailbox is not log
 * material. The character count is the whole proof the operator needs — it says
 * that something came back, and how much. `via` says which source it came from,
 * so an acceptance run can tell a visible page from the `textContent` fallback.
 */
function formatReadLine(result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  const url = typeof result?.url === "string" ? result.url : NO_FIELD;
  const truncated = result?.truncated === true ? "true" : "false";
  return `read tab=${tabId} url=${url} chars=${pageTextCharCount(result)} truncated=${truncated} via=${textSource(result)}`;
}

/**
 * The source name, whitelisted rather than echoed.
 *
 * A whitelist keeps a broken or hostile extension from writing its own line
 * endings — and anything else — into the log: two names are the whole protocol,
 * everything else is one `?`.
 */
function textSource(result) {
  return TEXT_SOURCES.includes(result?.via) ? result.via : NO_FIELD;
}

/** The only thing `read` may tell the log about the text: how long it was. */
function pageTextCharCount(result) {
  return typeof result?.text === "string" ? String(result.text.length) : NO_FIELD;
}

/**
 * `click selector=a#video-title-link tab=42 url=https://example.org/`.
 *
 * The selector is the one field the log takes from the request instead of the
 * result: the extension answers with the element it clicked, but a rerender can
 * wipe that description away, and the selector is what the operator typed. It
 * goes through `singleLineSelector` — the log calls each entry one line, and a
 * value that can split itself in two would make that a lie.
 */
function formatClickLine(params, result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  const url = typeof result?.url === "string" ? result.url : NO_FIELD;
  return `click selector=${singleLineSelector(params?.selector)} tab=${tabId} url=${url}`;
}

/**
 * Collapses every line-break run into a single space, with `unsetField` standing
 * in for a value that is not a string.
 *
 * Same reasoning as the `via` whitelist: an entry that a value can split is an
 * entry that a value can forge — a selector carrying `\n` could otherwise end
 * the real line and start a plausible-looking one of its own. The hole marker is
 * a parameter because the lines word their holes differently (`?` for the
 * sub-results of `click`/`type`, `-` for `inspect`'s filters) while the
 * flattening rule has to stay the same one.
 */
function singleLine(value, unsetField) {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ") : unsetField;
}

/** The `click`/`type` selector, with `NO_FIELD` for one that is not a string. */
function singleLineSelector(selector) {
  return singleLine(selector, NO_FIELD);
}

/**
 * `type selector=input[name="q"] chars=15 submit=true tab=42 url=https://example.org/`.
 *
 * `chars` is the length of the text the agent *typed* — the request's `text`, not
 * the page text beside it. The page text would make the line look like a `read`
 * result; the typed length is the one fact that proves typing happened at all.
 * The text itself never appears: it may be a password, and the operator's
 * terminal is not the place to find that out. `submit` is the intent from the
 * request for the same reason the selector is: the extension's answer says
 * whether Enter was fired, and the line says what was asked for.
 */
function formatTypeLine(params, result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  const url = typeof result?.url === "string" ? result.url : NO_FIELD;
  const submit = params?.submit === true ? "true" : "false";
  return `type selector=${singleLineSelector(params?.selector)} chars=${typedInputCharCount(params)} submit=${submit} tab=${tabId} url=${url}`;
}

/**
 * The length of the text that was typed. It lives in the request, not the result.
 *
 * This method has two lengths — the input the agent asked for and the page text
 * that came back — and reading them swapped logs the page's length where the
 * typed one belongs. Only the first one belongs in the line; every length in the
 * debug block is `DEBUG_WHITELIST`'s business.
 */
function typedInputCharCount(params) {
  return typeof params?.text === "string" ? String(params.text.length) : NO_FIELD;
}

/**
 * `inspect selector=a#cart-link text=- found=1`.
 *
 * Both filters come from the *request*: they are the caller's input, not page
 * content, and they stay raw here on purpose — the operator needs the exact
 * filter back to know what was asked. The boundary of that rule: a selector
 * copied out of an earlier `inspect` result can carry page text. It is still the
 * request's string, so this line prints it; the debug block redacts it.
 *
 * `singleLine` serves both filters: a value that can split itself in two could
 * otherwise end this line and start a plausible-looking one of its own.
 */
function formatInspectLine(params, result) {
  const selector = singleLine(params?.selector, UNSET_INSPECT_FIELD);
  const text = singleLine(params?.text, UNSET_INSPECT_FIELD);
  return `inspect selector=${selector} text=${text} found=${inspectCount(result)}`;
}

/**
 * The number of hits the page had, not the number of delivered elements.
 *
 * `truncated` in the debug block carries the difference; the line owes the
 * operator the count, because that is what decides whether a narrower filter is
 * needed.
 */
function inspectCount(result) {
  return Number.isInteger(result?.count) ? String(result.count) : UNSET_INSPECT_FIELD;
}

/**
 * `open tab=42 url=https://example.org/`.
 *
 * Two fields, and neither is the title: a freshly opened tab's title is page
 * content like any other, and what this line owes the operator is the proof that
 * a tab came into being — not what it happens to display.
 */
function formatOpenTabLine(result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  const url = typeof result?.url === "string" ? result.url : NO_FIELD;
  return `open tab=${tabId} url=${url}`;
}

/**
 * `close tab=42`.
 *
 * The id comes from the *result*, never from the request: `close_tab` without a
 * `tab` closes the last used one, so the request has no id worth printing — and
 * the caller needs to know *which* tab went away.
 */
function formatCloseTabLine(result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  return `close tab=${tabId}`;
}

/**
 * `eval tab=18 elapsedMs=4 ok=true`.
 *
 * `ok` is a literal `true`, not a field of the result: `#reportResult` runs for an
 * answer that said `ok:true`, and the extension's result carries no `ok` of its
 * own — printing `result.ok` would log `?` on every successful call.
 *
 * The code and the result are missing on purpose, not by oversight: the code can
 * be a password or a token spelled as a literal, and the result can be the page's
 * content. Tab id, runtime and state are the whole line (spec 19, `## Hub`).
 */
function formatEvalLine(result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  const elapsedMs = Number.isInteger(result?.elapsedMs) ? String(result.elapsedMs) : NO_FIELD;
  return `eval tab=${tabId} elapsedMs=${elapsedMs} ok=true`;
}

/**
 * `screenshot tab=4 bytes=214311 format=jpeg scaled=true ok=true`.
 *
 * The picture itself is the one thing this line must never carry. Base64 is not a
 * readable detail, it is an image: written to the journal it would be a wall of
 * characters nobody greps and everybody scrolls past. Size, format, state and tab
 * are the whole proof that a picture was taken (spec 20, `## Hub`).
 *
 * `ok` is a literal `true` for the same reason as in `eval`: `#reportResult` runs for
 * an answer that said `ok:true`, and the result carries no `ok` of its own. `scaled`
 * on the other hand *is* a field, and `false` is a fact — a missing value stays
 * `NO_FIELD` instead of being folded into the boolean it most resembles.
 */
function formatScreenshotLine(result) {
  const tabId = Number.isInteger(result?.tabId) ? String(result.tabId) : NO_FIELD;
  const bytes = Number.isInteger(result?.bytes) ? String(result.bytes) : NO_FIELD;
  const format = typeof result?.format === "string" ? result.format : NO_FIELD;
  const scaled = typeof result?.scaled === "boolean" ? String(result.scaled) : NO_FIELD;
  return `screenshot tab=${tabId} bytes=${bytes} format=${format} scaled=${scaled} ok=true`;
}

/* ---------------------------------------------------------- debug whitelist */

/*
 * What may appear on stderr when `logLevel` is `debug` is a whitelist, not a list
 * of redactions (spec 28).
 *
 * The block used to be built by seven report branches, four of which replaced a
 * field or two themselves while the other three printed whatever arrived — a
 * blacklist counts what somebody remembered to hide. A result field that nobody
 * thought of therefore reached the log in full, which is the wrong direction for
 * page content. Here the table below is the only place that decides: a field it
 * does not name prints a marker, never its value and never its length (a length
 * gives a short field away as well).
 */

/** The field arrives exactly as the extension sent it. */
const FULL = "full";

/** A string becomes `<n chars>`, `null` stays `null`, anything else becomes UNLISTED. */
const LENGTH = "length";

/** A list of strings, each entry through the `LENGTH` rule. */
const LENGTH_EACH = "lengthEach";

// The value a field nobody whitelisted is printed with. The *key* stays: dropping
// it would make a new field look like "does not exist", and two unlisted fields
// would silently collapse into one.
const UNLISTED = "<unlisted field>";

/** The rule for a field that is an object — or a list of objects — with known fields. */
function shapeOf(fields) {
  return Object.freeze({ fields: Object.freeze({ ...fields }) });
}

// One entry per method that has a debug block, keyed by the *protocol* method
// name: `hub.mjs` never sees the MCP tool name (`browser_read`).
//
// Absent on purpose, and that is not an oversight in the direction reversal: `eval`
// (its result is arbitrary page JSON, spec 19), `screenshot` (the base64 *is* the
// picture, spec 20/21), `open_tab` and `close_tab` (the line is the whole report),
// and `frames`, which has no report branch at all. `debugBlockOf` returns `null`
// for them; that is the one place where "unknown" writes nothing instead of a
// marker, because an unknown *method* has no field that was ever judged safe.
const DEBUG_WHITELIST = Object.freeze({
  // Byte-identical on purpose: test/bridge.test.js (`INDENTED_RESULT_LINES`) and
  // test/mcp.test.js pin exactly this block against the fixture, so `url` and
  // `title` are the only ones printed in full here.
  [PROTOCOL.METHODS.STATUS]: {
    extension: shapeOf({ version: FULL, connectedAt: FULL }),
    windows: shapeOf({
      id: FULL,
      focused: FULL,
      type: FULL,
      tabs: shapeOf({ id: FULL, active: FULL, pinned: FULL, agent: FULL, url: FULL, title: FULL }),
    }),
  },
  [PROTOCOL.METHODS.NAVIGATE]: {
    tabId: FULL,
    windowId: FULL,
    url: FULL,
    title: LENGTH,
    complete: FULL,
    settled: FULL,
    waitedMs: FULL,
  },
  [PROTOCOL.METHODS.READ]: {
    tabId: FULL,
    url: FULL,
    title: LENGTH,
    text: LENGTH,
    offset: FULL,
    chars: FULL,
    totalChars: FULL,
    truncated: FULL,
    via: FULL,
    mode: FULL,
    root: FULL,
    fellBack: FULL,
    // `readAgentTabPage` answers `{...page, ...settle}`, so the settle fields come last.
    settled: FULL,
    waitedMs: FULL,
  },
  [PROTOCOL.METHODS.CLICK]: {
    tabId: FULL,
    url: FULL,
    title: LENGTH,
    clicked: LENGTH,
    text: LENGTH,
    truncated: FULL,
    via: FULL,
    settled: FULL,
    waitedMs: FULL,
  },
  [PROTOCOL.METHODS.TYPE]: {
    tabId: FULL,
    url: FULL,
    title: LENGTH,
    typed: LENGTH,
    submitted: FULL,
    text: LENGTH,
    truncated: FULL,
    via: FULL,
  },
  [PROTOCOL.METHODS.FOCUS]: { tabId: FULL, windowId: FULL, url: FULL, title: LENGTH, active: FULL, focused: FULL },
  [PROTOCOL.METHODS.INSPECT]: {
    tabId: FULL,
    url: FULL,
    title: LENGTH,
    count: FULL,
    truncated: FULL,
    elements: shapeOf({
      index: FULL,
      selector: LENGTH,
      tag: FULL,
      id: LENGTH,
      classes: LENGTH_EACH,
      text: LENGTH,
      href: LENGTH,
      ariaLabel: LENGTH,
      visible: FULL,
      disabled: FULL,
      rect: shapeOf({ x: FULL, y: FULL, width: FULL, height: FULL }),
    }),
  },
});

/**
 * The finished debug block of one result, or `null` when the method has no entry.
 *
 * Text, not an object, because every caller hands it to the injected log writer
 * unchanged — and one `JSON.stringify` is what keeps a smuggled `\n` inside a
 * value an escaped `\\n` instead of a forged second log line.
 */
export function debugBlockOf(method, result) {
  // `null` means "write nothing", not "empty block": see the table's comment.
  // `Object.hasOwn`, not `DEBUG_WHITELIST[method] === undefined`: `"constructor"`
  // and `"toString"` are inherited from `Object.prototype`, so a `undefined` test
  // would hand a method nobody listed a block full of markers.
  if (!Object.hasOwn(DEBUG_WHITELIST, method)) return null;
  return JSON.stringify(projectShape(result, DEBUG_WHITELIST[method]), null, 2);
}

/**
 * The result cut down to the whitelisted fields, in table order.
 *
 * Table order rather than result order, so the same method reads the same way on
 * every answer. Fields the result carries but nobody listed come last, each with
 * its key and the marker. Listed fields it does not carry are simply absent: the
 * block must not invent a `null` for a field the extension never sent.
 */
function projectShape(result, whitelist) {
  // Only a mapping can be projected. Anything else — a list, a scalar, `null` — is
  // printed as it arrived; reshaping it would mean inventing rules for content
  // nobody whitelisted.
  if (!isFieldContainer(result)) return result;

  const projected = {};
  for (const [field, rule] of Object.entries(whitelist)) {
    if (!Object.hasOwn(result, field)) continue;
    projected[field] = applyRule(result[field], rule);
  }
  for (const [field, value] of Object.entries(result)) {
    if (Object.hasOwn(whitelist, field)) continue;
    projected[field] = UNLISTED;
  }
  return projected;
}

function isFieldContainer(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Four rules, and the table is the only source of them — a fifth would have to be
// added here as well, which is the point of keeping the decision in one place.
function applyRule(value, rule) {
  if (rule === FULL) return value;
  if (rule === LENGTH) return lengthOf(value);
  if (rule === LENGTH_EACH) return lengthsOf(value);
  // Throwing beats a quiet fallback to `shape`: a typo in the table would raise
  // a `TypeError` on `rule.fields` while a request is in flight, which reads
  // like a hung request instead of a broken table.
  if (!isShapeRule(rule)) throw new TypeError(`unknown debug whitelist rule: ${String(rule)}`);
  return projectNested(value, rule.fields);
}

/** `shapeOf(...)` is the only rule that is an object; every other rule is a string. */
function isShapeRule(rule) {
  return rule !== null && typeof rule === "object" && isFieldContainer(rule.fields);
}

function lengthOf(value) {
  if (typeof value === "string") return `<${value.length} chars>`;
  // `null` is a statement worth keeping (`"ariaLabel": null` means "no label"),
  // every other non-string is content of a kind the table did not judge.
  return value === null ? null : UNLISTED;
}

function lengthsOf(value) {
  // Not a list: nothing here says how to shorten it, so it prints the marker.
  return Array.isArray(value) ? value.map((entry) => lengthOf(entry)) : UNLISTED;
}

/** A `shape` field: one object with these fields, or a list of them, field by field. */
function projectNested(value, fields) {
  const projectElement = (entry) => (isFieldContainer(entry) ? projectShape(entry, fields) : UNLISTED);
  return Array.isArray(value) ? value.map(projectElement) : projectElement(value);
}

/**
 * Constant-time token comparison.
 *
 * Both sides are hashed first, so `timingSafeEqual` always sees two 32-byte
 * buffers — it throws on unequal lengths, and a length-dependent throw would
 * leak exactly the information the constant-time compare is there to hide. The
 * length check in front is still worth its line: it rejects an obviously wrong
 * candidate without hashing anything.
 */
export function verifyToken(expected, candidate) {
  if (typeof candidate !== "string") return false;
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(sha256(expected), sha256(candidate));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Returns the hello message, or null when the first message is not one.
 *
 * Only what the spec names is checked: JSON object, `type`, non-empty string
 * `token`. `protocol` and the browser metadata are deliberately not validated —
 * rejecting an extension that reports a newer protocol version would lock out
 * the operator's own reload.
 */
function parseHello(text) {
  const message = parseJsonObject(text);
  if (message === null) return null;
  if (message.type !== PROTOCOL.TYPES.HELLO) return null;
  if (typeof message.token !== "string" || message.token === "") return null;
  return message;
}

function parseJsonObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

function formatProtocol(value) {
  return Number.isInteger(value) ? String(value) : "unknown";
}

/**
 * `reason` is the peer's close phrase when it sent one; the numeric code carries
 * the meaning, so it always comes first.
 */
function describeClose({ code, reason }) {
  return typeof reason === "string" && reason !== "" ? `${code} ${reason}` : String(code);
}

function formatErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" && code !== "" ? code : NO_ERROR_CODE;
}

/**
 * A request that did not produce a result.
 *
 * `name` is the discriminator: `ExtensionUnavailable` (nobody to ask, or the
 * peer went away mid-request), `ExtensionTimeout` (no answer within
 * `BC_CALL_TIMEOUT_MS`) and `ExtensionError` (the extension answered `ok:false`
 * — the only case that carries the extension's own `code`).
 */
export class HubRequestError extends Error {
  constructor(name, message, { code, details = {} } = {}) {
    super(message);
    this.name = name;
    if (code !== undefined) this.code = code;
    this.details = details;
  }
}

export class Hub {
  #config;
  #token;
  #log;
  #onStatus;
  // The authenticated connection, if any. Kept as a session object rather than
  // the raw socket, because replacing it must clear the replaced session's
  // timers as well.
  #current = null;

  /**
   * `log` receives one finished line; the timestamp prefix is the caller's job.
   * `onStatus` is the seam for the JSON-RPC layer of the next increment and is
   * called with the raw `result` object of a `status` answer — every other
   * method keeps its result in the promise and in the log line.
   */
  constructor({ config, token, log, onStatus = () => {} }) {
    this.#config = config;
    this.#token = token;
    this.#log = log;
    this.#onStatus = onStatus ?? (() => {});
  }

  /**
   * Attaches the hub's protocol to one connection returned by `upgradeSocket`.
   * `peer` is the socket peer as a string, used verbatim in log lines.
   */
  handleConnection(conn, peer) {
    const session = {
      conn,
      peer,
      authenticated: false,
      helloTimer: null,
      // Ids are counted per connection, not per hub: `pendingRequests` is per
      // session too, so uniqueness holds without a shared counter — and the
      // first request of every connection stays `id: 1`, which the replace case
      // and the extension's own tests both rely on.
      nextRequestId: 0,
      // Request id -> {method, timeout, resolve, reject}. A map instead of one
      // field because several requests may be in flight and answered out of
      // order; the method rides along so an answer can be reported without
      // remembering what was asked outside the pending entry.
      pendingRequests: new Map(),
    };

    session.helloTimer = setTimeout(() => {
      session.helloTimer = null;
      conn.close(PROTOCOL.CLOSE.HELLO_TIMEOUT);
    }, this.#config.helloTimeoutMs);

    conn.on("message", (text) => this.#handleMessage(session, text));
    conn.on("close", (info) => this.#handleClose(session, info));
  }

  #handleMessage(session, text) {
    // A message that raced with our own close frame (the hello timer firing is
    // the usual case) is not worth a state change or a log line.
    if (!session.conn.isOpen) return;

    if (!session.authenticated) {
      this.#handleHello(session, text);
      return;
    }
    this.#handleResponse(session, text);
  }

  #handleHello(session, text) {
    const hello = parseHello(text);
    if (hello === null) {
      this.#log(`protocol error peer=${session.peer}`);
      session.conn.close(PROTOCOL.CLOSE.PROTOCOL_ERROR);
      return;
    }

    if (!verifyToken(this.#token, hello.token)) {
      this.#log(`auth failed peer=${session.peer}`);
      session.conn.close(PROTOCOL.CLOSE.AUTH_FAILED);
      return;
    }

    this.#accept(session, hello);
  }

  #accept(session, hello) {
    // Timer hygiene: leaving the hello timer armed would close a perfectly
    // healthy connection with 4408 a few seconds after `welcome`.
    clearTimeout(session.helloTimer);
    session.helloTimer = null;
    session.authenticated = true;

    // Only the remembered reference is closed. Testing "is the newest one" here
    // instead would compare a session with itself and close the connection that
    // just arrived.
    const previous = this.#current;
    this.#current = session;
    if (previous !== null && previous !== session) {
      previous.conn.close(PROTOCOL.CLOSE.REPLACED);
    }

    this.#log(`extension connected peer=${session.peer} protocol=${formatProtocol(hello.protocol)}`);

    session.conn.send(
      JSON.stringify({
        type: PROTOCOL.TYPES.WELCOME,
        protocol: PROTOCOL.VERSION,
        bridgeVersion: BRIDGE_VERSION,
      }),
    );
    // The `catch` is mandatory, not cosmetic: without it an unanswered
    // auto-request would surface as an unhandled rejection and take the bridge
    // process down a few seconds after a perfectly healthy handshake.
    this.requestStatus().catch(() => {});
  }

  /**
   * Asks the connected extension to run one request with `params`.
   *
   * Resolves with the `result` object of the response, rejects with a
   * `HubRequestError`. Callers own the rejection — the automatic request in
   * `#accept` catches its own.
   */
  request(method, params = {}) {
    const session = this.#current;
    if (session === null) {
      return Promise.reject(new HubRequestError(UNAVAILABLE, "no extension is connected"));
    }
    return this.#ask(session, method, params);
  }

  /** Thin wrapper: the automatic request after the handshake keeps its name. */
  requestStatus() {
    return this.request(PROTOCOL.METHODS.STATUS, {});
  }

  #ask(session, method, params) {
    const id = ++session.nextRequestId;

    return new Promise((resolve, reject) => {
      session.pendingRequests.set(id, {
        method,
        params,
        timeout: setTimeout(() => this.#handleTimeout(session, id), this.#config.callTimeoutMs),
        resolve,
        reject,
      });

      const sent = session.conn.send(
        JSON.stringify({
          type: PROTOCOL.TYPES.REQUEST,
          id,
          method,
          params,
        }),
      );

      // A socket that closed between the `isOpen` check and this write can never
      // answer; saying so now beats waiting out the timer.
      if (!sent) {
        this.#rejectPending(session, id, new HubRequestError(UNAVAILABLE, "the request could not be sent"));
      }
    });
  }

  #handleTimeout(session, id) {
    const entry = this.#takePending(session, id);
    // Already answered or already rejected by the close handler. A timer that
    // outlived its request must not settle twice or log a ghost line.
    if (entry === undefined) return;

    // The connection stays open: a slow answer is not a broken peer, and the
    // extension keeps its live socket for the next request. The line is named
    // after the method, so `status timeout` keeps reading exactly as before.
    this.#log(`${entry.method} timeout peer=${session.peer}`);
    entry.reject(
      new HubRequestError(TIMEOUT, `no ${entry.method} answer within ${this.#config.callTimeoutMs} ms`),
    );
  }

  /**
   * Removes a pending request and disarms its timer. Every settlement path goes
   * through here, so no request settles twice and no timer outlives its request.
   */
  #takePending(session, id) {
    const entry = session.pendingRequests.get(id);
    if (entry === undefined) return undefined;
    clearTimeout(entry.timeout);
    session.pendingRequests.delete(id);
    return entry;
  }

  #rejectPending(session, id, error) {
    const entry = this.#takePending(session, id);
    if (entry !== undefined) entry.reject(error);
  }

  #handleResponse(session, text) {
    const message = parseJsonObject(text);
    // Anything that is not a response to a request we know is dropped silently.
    // Only the first message has a spec-defined failure mode; inventing a second
    // close path here would close connections for no documented reason.
    if (message === null || message.type !== PROTOCOL.TYPES.RESPONSE) return;

    const entry = this.#takePending(session, message.id);
    // A response for a request that already timed out or went away is dropped:
    // it cannot settle anything any more, and nothing is waiting for it.
    if (entry === undefined) return;

    if (message.ok === true) {
      this.#reportResult(entry, message.result);
      // Resolved last, so the log lines of this answer are written before any
      // awaiting caller continues.
      entry.resolve(message.result);
      return;
    }

    const code = formatErrorCode(message.error);
    // `ok:false` is a normal answer from a working extension, so the connection
    // stays; the code says what went wrong on that side.
    this.#log(`${entry.method} failed peer=${session.peer} code=${code}`);
    entry.reject(
      new HubRequestError(EXTENSION_ERROR, `the extension answered ok:false code=${code}`, {
        code,
        details: message.error,
      }),
    );
  }

  /**
   * One line per successful request — not just for `status`: a navigation is the
   * only action the agent takes in the operator's browser, and without a line
   * there is no proof of it beyond the tab itself.
   */
  #reportResult(entry, result) {
    if (entry.method === PROTOCOL.METHODS.STATUS) {
      this.#reportStatus(result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.NAVIGATE) {
      this.#reportNavigate(result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.READ) {
      this.#reportRead(result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.CLICK) {
      // `click` is the one method whose proof line needs the request: the
      // selector lives in `params`, not in the result.
      this.#reportClick(entry.params, result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.TYPE) {
      this.#reportType(entry.params, result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.FOCUS) {
      this.#reportFocus(result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.INSPECT) {
      // Like `click`: the two filters live in `params`, not in the result. The
      // `return` is load-bearing — a branch that falls through is how spec 08
      // once lost an increment.
      this.#reportInspect(entry.params, result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.OPEN_TAB) {
      this.#reportOpenTab(result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.CLOSE_TAB) {
      // Mandatory, not decoration: `#reportResult` writes nothing at all for a
      // method it does not know, so a missing branch would make `close_tab`
      // invisible in the operator's terminal.
      this.#reportCloseTab(result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.EVAL) {
      // Same rule as `close_tab`: no branch, no line.
      this.#reportEval(result);
      return;
    }
    if (entry.method === PROTOCOL.METHODS.SCREENSHOT) {
      // Again: no branch, no line — and the line is the only trace a picture
      // leaves anywhere, since the bridge keeps no copy of it.
      this.#reportScreenshot(result);
      return;
    }
  }

  #reportStatus(result) {
    this.#log(formatStatusLine(result));
    this.#logDebugBlock(PROTOCOL.METHODS.STATUS, result);
    this.#onStatus(result);
  }

  /** No `onStatus`: that seam belongs to `status`, not to every method. */
  #reportNavigate(result) {
    this.#log(formatNavigateLine(result));
    this.#logDebugBlock(PROTOCOL.METHODS.NAVIGATE, result);
  }

  /**
   * No `onStatus`. The debug block comes from `DEBUG_WHITELIST`, so the page text
   * is its length and every field the table does not name is a marker — the
   * operator still sees how much came back, not what it said.
   */
  #reportRead(result) {
    this.#log(formatReadLine(result));
    this.#logDebugBlock(PROTOCOL.METHODS.READ, result);
  }

  /**
   * No `onStatus`. The debug block comes from `DEBUG_WHITELIST`, where `clicked`
   * and `text` are lengths: `clicked` is a short description of the element
   * (`a[href="…"]`) and that `href` can carry a session token, while `text` is the
   * page beside it. Nothing the operator's browser shows belongs on stderr beyond
   * its length.
   */
  #reportClick(params, result) {
    this.#log(formatClickLine(params, result));
    this.#logDebugBlock(PROTOCOL.METHODS.CLICK, result);
  }

  /**
   * No `onStatus`. The page-side pair needs its lengths for different reasons:
   * `typed` describes the element and can carry an `href` or an `aria-label`,
   * exactly like `clicked`; `text` is the page after the typing, and on a search
   * page it repeats what was typed. Both are `length` in the table.
   */
  #reportType(params, result) {
    this.#log(formatTypeLine(params, result));
    this.#logDebugBlock(PROTOCOL.METHODS.TYPE, result);
  }

  /**
   * No `onStatus`. `focus` reads nothing, so the block is the one `status` and
   * `navigate` get from the same table — its `url` prints in full, its `title` as
   * a length like every other block.
   */
  #reportFocus(result) {
    this.#log(formatFocusLine(result));
    this.#logDebugBlock(PROTOCOL.METHODS.FOCUS, result);
  }

  /**
   * No `onStatus`. The block is the nested one: each element is projected field by
   * field from the table, so every page string in a hit — `text`, `href`, `id`,
   * `ariaLabel`, `selector` (a selector can hide page text inside
   * `tag[aria-label="…"]`) and each class name — prints as its length.
   */
  #reportInspect(params, result) {
    this.#log(formatInspectLine(params, result));
    this.#logDebugBlock(PROTOCOL.METHODS.INSPECT, result);
  }

  /**
   * No `onStatus`, and no debug block — `open_tab` has no `DEBUG_WHITELIST` entry.
   *
   * The result of `open_tab` carries the new tab's *title* — page content that the
   * line above leaves out on purpose. A block would put it on stderr right beside
   * the line that avoided it.
   */
  #reportOpenTab(result) {
    this.#log(formatOpenTabLine(result));
  }

  /**
   * Same rule as `open_tab`, for a shorter result.
   *
   * `{tabId, closed}` has nothing worth a debug block: the line names the id, and a
   * second copy of it as `{…}` JSON is the kind of noise an operator scrolls past.
   * It also keeps the two new methods worded alike — neither puts a tab title on
   * stderr.
   */
  #reportCloseTab(result) {
    this.#log(formatCloseTabLine(result));
  }

  /**
   * No `onStatus`, and no debug block — `eval` has no `DEBUG_WHITELIST` entry, not
   * even a redacting one.
   *
   * A block would put the result on stderr, and for `eval` that result is
   * whatever the code produced: page content, a cookie, a token. The increment's
   * log hygiene is tab id, runtime and state, never content — a rule that only
   * holds until the first `BC_LOG=debug` if this block is added back. (It would
   * also need a rule for arbitrary page JSON, which the table has deliberately
   * no way to express.)
   */
  #reportEval(result) {
    this.#log(formatEvalLine(result));
  }

  /**
   * No `onStatus`, and no debug block either — `screenshot` is the same rule as
   * `eval`, with a sharper edge.
   *
   * At `eval` a block would print a result the operator may not want on stderr; at
   * `screenshot` it would print the base64 string, and a base64 string *is* the
   * picture. `BC_LOG=debug` must not be the switch that turns the journal into an
   * image store, so the one line is all there is — not even a shortened copy.
   */
  #reportScreenshot(result) {
    this.#log(formatScreenshotLine(result));
  }

  /**
   * The one gate between `logLevel` and a debug block.
   *
   * The level is read once, here, and the block itself comes from the whitelist:
   * a method without a table entry yields `null` and writes nothing, which is how
   * the four silent methods stay silent without a second decision in a branch.
   */
  #logDebugBlock(method, result) {
    if (this.#config.logLevel === "debug") {
      const block = debugBlockOf(method, result);
      if (block !== null) this.#log(block);
    }
  }

  #handleClose(session, info) {
    // Rejected before the timers are disarmed: an open request can never be
    // answered now, and waiting for a timer that `#clearTimers` is about to
    // cancel would leave its promise pending forever.
    this.#rejectAllPending(session);
    this.#clearTimers(session);

    if (this.#current === session) {
      this.#current = null;
    }
    // Only authenticated sessions deserve a line: an unauthenticated socket that
    // timed out or failed auth already logged why it went away.
    if (session.authenticated) {
      this.#log(`extension disconnected reason=${describeClose(info)}`);
    }
  }

  /**
   * The peer is gone, so every request of this session fails the same way. One
   * shared error instance: they carry no per-request detail worth duplicating.
   */
  #rejectAllPending(session) {
    const error = new HubRequestError(UNAVAILABLE, "the extension connection went away");
    for (const entry of session.pendingRequests.values()) {
      entry.reject(error);
    }
  }

  #clearTimers(session) {
    clearTimeout(session.helloTimer);
    session.helloTimer = null;
    for (const entry of session.pendingRequests.values()) {
      clearTimeout(entry.timeout);
    }
    session.pendingRequests.clear();
  }
}
