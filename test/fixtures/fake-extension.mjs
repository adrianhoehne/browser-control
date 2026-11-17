/**
 * A fake extension peer for `test/bridge.test.js` and `test/mcp.test.js`.
 *
 * It stands in for the Firefox background script: a Node 22 global `WebSocket`
 * client that says `hello`, waits for `welcome` and answers the `status`,
 * `navigate`, `read`, `click`, `type`, `focus`, `inspect`, `eval`, `open_tab`,
 * `close_tab`, `screenshot`, `frames` and `transcript` requests with fixed results. It is
 * started as a child process by the test, so the bridge sees a real peer over a real
 * socket instead of a stub living in the same process.
 *
 * Input comes from the environment, never from argv: a token on a command line
 * is readable by every local process, and this fixture handles tokens like the
 * real extension does.
 *
 *   BC_TEST_URL              `ws://127.0.0.1:<port>` of the bridge under test
 *   BC_TEST_TOKEN            token to present in `hello` (generated per test run)
 *   BC_TEST_ANSWER           what to do with a `status` request: unset answers
 *                            normally, `"0"` keeps the peer silent (the timeout
 *                            case), `error:<code>` answers `ok:false` with that code
 *   BC_TEST_NAVIGATE_ANSWER  the same three modes for a `navigate` request
 *   BC_TEST_READ_ANSWER      the same three modes for a `read` request
 *   BC_TEST_CLICK_ANSWER     the same three modes for a `click` request
 *   BC_TEST_TYPE_ANSWER      the same three modes for a `type` request
 *   BC_TEST_FOCUS_ANSWER     the same three modes for a `focus` request
 *   BC_TEST_INSPECT_ANSWER   the same three modes for an `inspect` request
 *   BC_TEST_OPEN_TAB_ANSWER  the same three modes for an `open_tab` request
 *   BC_TEST_CLOSE_TAB_ANSWER the same three modes for a `close_tab` request
 *   BC_TEST_EVAL_ANSWER      the same three modes for an `eval` request
 *   BC_TEST_SCREENSHOT_ANSWER the same three modes for a `screenshot` request
 *   BC_TEST_SCREENSHOT_BYTES  a byte count: `screenshot` then answers a PNG that
 *                            decodes to exactly that many bytes, with `scaled: false`
 *   BC_TEST_SCREENSHOT_FORMAT a format name: replaces the `format` of the answer and
 *                            nothing else — how a test hands the bridge a picture
 *                            format it has no MIME type for
 *   BC_TEST_FRAMES_ANSWER    the same three modes for a `frames` request
 *   BC_TEST_TRANSCRIPT_ANSWER the same three modes for a `transcript` request
 *   BC_TEST_ERROR_DETAILS    a JSON object spread into every `ok:false` frame's
 *                            `error` — that is how a test gives the bridge the
 *                            `url` and `kind` of a page it could not read. Unset
 *                            keeps the frame exactly as it always was.
 *
 * Every request is announced on stderr as `fake extension: request method=<m>`:
 * that line is how a test proves whether a call reached the peer at all. A request
 * that carried a `tab` says so in the same line (`... method=read tab=42`), which
 * is how a test proves the bridge put the argument on the wire. A `frame` says only
 * that it was there (`... method=read frame=yes`): the value is an address fragment,
 * and this fixture writes no addresses anywhere.
 *
 * Run directly and it is a peer; import it and it is only data (the tests import
 * `STATUS_RESULT`, `NAVIGATE_RESULT`, `READ_RESULT`, `CLICK_RESULT`,
 * `TYPE_RESULT`, `FOCUS_RESULT`, `INSPECT_RESULT`, `OPEN_TAB_RESULT`,
 * `CLOSE_TAB_RESULT`, `EVAL_RESULT`, `SCREENSHOT_RESULT`, `FRAMES_RESULT` and
 * `TRANSCRIPT_RESULT` to compare the bridge's JSON byte for byte).
 */
import { pathToFileURL } from "node:url";

const WELCOME_TIMEOUT_MS = 5_000;
const SILENT_ANSWER_FLAG = "0";
const ERROR_ANSWER_PREFIX = "error:";

/**
 * Two normal windows with three tabs between them — the shape from the spec's
 * "Ergebnis von status", including one tab without a URL, which is what a
 * freshly opened `about:newtab` reports.
 *
 * `connectedAt` is a fixed timestamp instead of `Date.now()`: the parent test
 * compares this object against the bridge's indented debug JSON, and a moving
 * value would turn an exact comparison into a fuzzy one. Nothing the bridge does
 * with the result depends on the extension's clock.
 */
export const STATUS_RESULT = {
  extension: { version: "0.1.0", connectedAt: "2026-10-23T09:12:31.004Z" },
  windows: [
    {
      id: 1,
      focused: true,
      type: "normal",
      tabs: [
        {
          id: 101,
          active: true,
          pinned: false,
          url: "https://example.org/",
          title: "Beispiel",
        },
        {
          id: 102,
          active: false,
          pinned: true,
          url: "https://example.com/",
          title: "Example Domain",
        },
      ],
    },
    {
      id: 2,
      focused: false,
      type: "normal",
      tabs: [{ id: 201, active: true, pinned: false, url: "", title: "Neuer Tab" }],
    },
  ],
};

/**
 * The seven fields `navigate` answers with, in the shape the spec documents.
 *
 * A loaded page, so `complete: true` — the other value has its own path in the
 * extension and never has to be invented by a fixture. The settle pair is the one
 * invented page that calmed down 412 ms into the wait; the bridge passes both
 * fields through unchanged, which is what the pinned tool text shows.
 */
export const NAVIGATE_RESULT = {
  tabId: 42,
  windowId: 1,
  url: "https://example.org/",
  title: "Example Domain",
  complete: true,
  settled: true,
  waitedMs: 412,
};

/**
 * The six fields `read` answers with. Two invented lines, not anybody's page: the
 * text of a real site has no business in this repository, and the bridge treats
 * the string as opaque anyway. `via` names the source the text came from.
 */
export const READ_RESULT = {
  tabId: 42,
  url: "https://example.org/",
  title: "Beispielseite",
  text: "Zeile eins\n\nZeile zwei",
  truncated: false,
  via: "innerText",
};

/**
 * The nine fields `click` answers with: the `read` result plus the description of
 * the element that was clicked and the settle pair.
 *
 * The text is `READ_RESULT.text` on purpose — a click reads the page after it, so a
 * second invented text would add nothing but one more string of fake page in the
 * repository. `clicked` is the element description from the spec (`tag#id`).
 * `settled`/`waitedMs` are `NAVIGATE_RESULT`'s pair: one invented wait, shared like
 * the invented page — they are what proves the bridge forwards both fields instead
 * of dropping one.
 */
export const CLICK_RESULT = {
  tabId: READ_RESULT.tabId,
  url: READ_RESULT.url,
  title: READ_RESULT.title,
  clicked: "a#video-title-link",
  text: READ_RESULT.text,
  truncated: READ_RESULT.truncated,
  via: READ_RESULT.via,
  settled: NAVIGATE_RESULT.settled,
  waitedMs: NAVIGATE_RESULT.waitedMs,
};

/**
 * The eight fields `type` answers with: the `read` result plus the element
 * description and the submit flag.
 *
 * `typed` is the element description (`tag#id`), never the text that was typed —
 * no invented search term belongs in this repository, and the answer must not
 * carry one either. The page text is `READ_RESULT.text` for the same reason it is
 * in `CLICK_RESULT`: typing is a read with one write in front of it.
 */
export const TYPE_RESULT = {
  tabId: READ_RESULT.tabId,
  url: READ_RESULT.url,
  title: READ_RESULT.title,
  typed: "input#q",
  submitted: true,
  text: READ_RESULT.text,
  truncated: READ_RESULT.truncated,
  via: READ_RESULT.via,
};

/**
 * The six fields `focus` answers with — the only result that carries no page text.
 *
 * `active`/`focused` are the extension's report of what its two calls achieved, not
 * the intent: both are `true` here because the fixture's peer always succeeds, and
 * the interesting half-success (`focused:false`) belongs to the extension's tests.
 * Tab and fields are shared with `NAVIGATE_RESULT` — it is the same tab coming
 * forward, so a second invented tab would only make the fixture harder to read.
 */
export const FOCUS_RESULT = {
  tabId: NAVIGATE_RESULT.tabId,
  windowId: NAVIGATE_RESULT.windowId,
  url: NAVIGATE_RESULT.url,
  title: NAVIGATE_RESULT.title,
  active: true,
  focused: true,
};

/**
 * The six fields `inspect` answers with, and the single element in it.
 *
 * One invented page snippet, not two: the element's `text` is the first line of
 * `READ_RESULT.text` and its `href` is the same invented address, so the fixture
 * keeps carrying exactly one fake page. `selector` is the handle the tool promises
 * and `id` the part a click would report as `tag#id` — that round-trip is what
 * criterion 6 measures in the operator's browser, and this element is the shape it
 * walks through here. `ariaLabel` is `null` on purpose: an element without one is
 * the normal case, and inventing a label would hide that the field can be empty.
 */
export const INSPECT_RESULT = {
  tabId: READ_RESULT.tabId,
  url: READ_RESULT.url,
  title: READ_RESULT.title,
  count: 1,
  truncated: false,
  elements: [
    {
      index: 0,
      selector: "a#cart-link",
      tag: "a",
      id: "cart-link",
      classes: ["cart"],
      text: "Zeile eins",
      href: READ_RESULT.url,
      ariaLabel: null,
      visible: true,
      disabled: false,
      rect: { x: 12, y: 340, width: 120, height: 24 },
    },
  ],
};

/**
 * The three fields `open_tab` answers with, in the shape the spec documents.
 *
 * `tabId` is *not* the `42` of `NAVIGATE_RESULT`/`READ_RESULT`: a log line that
 * printed the wrong result is only visible when the two differ. `title` is a page
 * title like any other, and it is exactly the field the hub's `open` line has to
 * leave out — which is why the fixture carries one.
 */
export const OPEN_TAB_RESULT = {
  tabId: 31,
  url: "https://example.org/",
  title: "Beispiel",
};

/**
 * The two fields `close_tab` answers with.
 *
 * The same tab as `OPEN_TAB_RESULT`: closing the tab a previous `open_tab` made is
 * the round trip both tools exist for.
 */
export const CLOSE_TAB_RESULT = {
  tabId: OPEN_TAB_RESULT.tabId,
  closed: true,
};

/**
 * The five fields `eval` answers with.
 *
 * `tabId` is neither `42` nor `31`: the hub's `eval` line is the one log line that
 * is a promise about log hygiene, and a fixture that reused the tab of another
 * method would hide a line built from the wrong result. `result` is the invented
 * page title — one fake page in this file, not two — and `elapsedMs` is the
 * smallest plausible runtime, so a log line printing a wrong number stands out.
 */
export const EVAL_RESULT = {
  tabId: 18,
  url: READ_RESULT.url,
  title: READ_RESULT.title,
  elapsedMs: 4,
  result: READ_RESULT.title,
};

/**
 * The magic each picture format puts in front, with the number of bytes it stands for.
 *
 * Both spans are whole four-character groups — 12 characters = 9 bytes for the PNG, 4
 * = 3 for the JPEG — so the filler behind them stays aligned and the streak decodes to
 * exactly the byte count it claims. A partial group would shift every byte after it.
 */
const IMAGE_MAGIC = {
  png: { base64: "iVBORw0KGgoA", bytes: 9 },
  jpeg: { base64: "/9j/", bytes: 3 },
};

/**
 * A base64 streak that decodes to exactly `byteCount` bytes.
 *
 * A second copy of the helper in `test/extension.test.js`, kept apart on purpose: this
 * file is a peer process and must not import from a test file, or the fixture would
 * start disproving what it fakes. `AA==` / `AAA=` close the last group, which is what
 * makes the decode length exact instead of "rounded down to the group".
 */
function base64OfLength(byteCount) {
  const fullGroups = Math.floor(byteCount / 3);
  const remainder = byteCount % 3;
  const tail = remainder === 0 ? "" : remainder === 1 ? "AA==" : "AAA=";
  return "AAAA".repeat(fullGroups) + tail;
}

/** A picture of `byteCount` decoded bytes with the real magic of `format` in front. */
function base64ImageOf({ format, byteCount }) {
  const magic = IMAGE_MAGIC[format];
  if (magic === undefined) throw new Error(`no base64 magic known for ${format}`);
  if (byteCount < magic.bytes) {
    throw new Error(`a ${format} of ${byteCount} bytes cannot carry its ${magic.bytes}-byte magic`);
  }
  return magic.base64 + base64OfLength(byteCount - magic.bytes);
}

/**
 * The nine fields `screenshot` answers with, in the shape spec 20 documents.
 *
 * `tabId` is `20` — a fourth invented tab, so a hub line built from the wrong
 * result of the wrong method is visible instead of plausible. The picture is a
 * JPEG that went through the ladder: `scaled: true` and `bytes` just under the
 * 3 MiB limit, which is the interesting case (a passthrough PNG would make the
 * `scaled=false` branch the only one a log line ever sees).
 *
 * `base64` is generated, not written: a real 214 311-byte streak is ~285 KB of
 * source that nobody can read, and `Buffer.from(…, "base64")` silently ignores
 * characters that do not belong to the alphabet — a hand-typed string would make
 * every length assertion about it a coin flip. Generated, the decode is the byte
 * count the result claims, and only the head is a real format magic.
 */
export const SCREENSHOT_RESULT = {
  tabId: 20,
  url: READ_RESULT.url,
  title: READ_RESULT.title,
  format: "jpeg",
  width: 1600,
  height: 900,
  bytes: 214311,
  scaled: true,
  activated: false,
  base64: base64ImageOf({ format: "jpeg", byteCount: 214311 }),
};

/**
 * The four fields `frames` answers with, in the shape spec 24 documents.
 *
 * `tabId` is `READ_RESULT`'s on purpose: it is the same agent tab, listed rather than
 * read — and `frames` writes no log line, so there is no line a wrong id could spoil.
 * The second address is the sub-frame the other tools would address with a `frame`
 * substring, so the fixture carries exactly one kind of address per role. `top` is
 * `true` for the main frame and `false` for the embedded one, which is the only
 * distinction this result promises.
 */
export const FRAMES_RESULT = {
  tabId: READ_RESULT.tabId,
  url: READ_RESULT.url,
  count: 2,
  frames: [
    { href: READ_RESULT.url, top: true },
    { href: "https://widget.example.net/kalender", top: false },
  ],
};

/**
 * The eight fields `transcript` answers with, in the shape spec 33 documents.
 *
 * The three language fields come *first*, like the extension writes them: behind twenty
 * thousand characters of segment text nobody would read them, so the fixture puts them
 * where a caller looks first — and a bridge that reorders the answer fails visibly.
 * `requestedLanguage` is the language code of the target track, `deliveredLanguage` the
 * `lang` of the track file that was actually read, `source` the container the player's
 * model was found in (one of the five candidates the extension knows).
 *
 * Three segments with an *invented* text — the same two lines `READ_RESULT` carries, plus
 * a third, so a wrong index is visible instead of plausible. `timeText` is the display and
 * `time` the number of seconds, which is the difference the a11y line ("4 Sekunden") would
 * blur if it were read as text: the fixture carries no such line, and the extension's own
 * cases prove it is dropped.
 *
 * The numbers are consistent: `"Zeile eins Zeile zwei Zeile drei"` is 32 characters, so
 * `totalChars`/`chars` = 32 at the default window, and `truncated` is `false` because the
 * window reaches the end. The 32 counts the segment text only — the language fields are
 * keys, not text. No `tabId`: this answer is the segments and the window, nothing else
 * (criterion 2).
 */
export const TRANSCRIPT_RESULT = {
  requestedLanguage: "en",
  deliveredLanguage: "en",
  source: "ytplayer.bootstrapPlayerResponse",
  segments: [
    { time: 4, timeText: "0:04", text: "Zeile eins" },
    { time: 6, timeText: "0:06", text: "Zeile zwei" },
    { time: 14, timeText: "0:14", text: "Zeile drei" },
  ],
  totalChars: 32,
  chars: 32,
  offset: 0,
  truncated: false,
};

/* ---------------------------------------------------------------- wire format */

// Literal strings on purpose: this fixture speaks the wire protocol as the spec
// documents it, not as `bridge-rs/src/protocol.rs` implements it — and not as the
// value `extension/protocol.js` carries. A diverging constant is supposed to break
// this test, and mirroring the constant here would hide it.
function helloMessage(token) {
  return {
    type: "hello",
    protocol: 1,
    extensionVersion: "0.1.0",
    browser: { name: "Firefox", version: "152.0.3" },
    token,
  };
}

function statusResponse(id) {
  return { type: "response", id, ok: true, result: STATUS_RESULT };
}

function navigateResponse(id) {
  return { type: "response", id, ok: true, result: NAVIGATE_RESULT };
}

function readResponse(id) {
  return { type: "response", id, ok: true, result: READ_RESULT };
}

function clickResponse(id) {
  return { type: "response", id, ok: true, result: CLICK_RESULT };
}

function typeResponse(id) {
  return { type: "response", id, ok: true, result: TYPE_RESULT };
}

function focusResponse(id) {
  return { type: "response", id, ok: true, result: FOCUS_RESULT };
}

function inspectResponse(id) {
  return { type: "response", id, ok: true, result: INSPECT_RESULT };
}

function openTabResponse(id) {
  return { type: "response", id, ok: true, result: OPEN_TAB_RESULT };
}

function closeTabResponse(id) {
  return { type: "response", id, ok: true, result: CLOSE_TAB_RESULT };
}

function evalResponse(id) {
  return { type: "response", id, ok: true, result: EVAL_RESULT };
}

/**
 * The `screenshot` answer for the two knobs a test can turn.
 *
 * `byteCount` unset keeps the fixed result. Set, it builds a PNG of exactly that many
 * bytes and says `format: "png"`, `scaled: false` — the shape of a capture that came
 * through untouched. Both are not decoration: a mode that reused the fixed
 * `format`/`scaled` would claim a JPEG about PNG bytes, and a caller that logs
 * `format=… scaled=…` would never see the passthrough branch.
 *
 * `format` is applied last and replaces that one field. A test that names an unknown
 * format is asking the *bridge* what it does with a picture it has no MIME type for,
 * so the bytes behind it are allowed to stay whatever they were — the bridge must
 * refuse before it ever looks at them.
 */
function screenshotResultOf({ byteCount, format }) {
  const base = byteCount === null ? SCREENSHOT_RESULT : passthroughPngOf(byteCount);
  return format === "" ? base : { ...base, format };
}

/** A PNG of exactly `byteCount` decoded bytes: the capture the ladder never touched. */
function passthroughPngOf(byteCount) {
  return {
    ...SCREENSHOT_RESULT,
    format: "png",
    bytes: byteCount,
    scaled: false,
    base64: base64ImageOf({ format: "png", byteCount }),
  };
}

function screenshotResponse(id, answer) {
  return { type: "response", id, ok: true, result: screenshotResultOf(answer) };
}

function framesResponse(id) {
  return { type: "response", id, ok: true, result: FRAMES_RESULT };
}

function transcriptResponse(id) {
  return { type: "response", id, ok: true, result: TRANSCRIPT_RESULT };
}

/**
 * The `read` failure answer — with `via` on it, like the success answer.
 *
 * Deliberate: a failed `read` still names the source it would have read from, and
 * the bridge has to ignore every result field once `ok` is `false`. This fixture
 * is the only place that shape is exercised.
 */
function readErrorResponse(id, code) {
  return { ...errorResponse(id, code), via: READ_RESULT.via };
}

/**
 * The `ok:false` answer the real extension sends when a method fails on its
 * side. The message is filler: the bridge logs and forwards the `code`, which is
 * the part the contract and the tests talk about. `BC_TEST_ERROR_DETAILS` adds
 * whatever a test wants on top — `url` and `kind` for `not_readable`.
 */
function errorResponse(id, code) {
  return {
    type: "response",
    id,
    ok: false,
    error: { code, message: "the fake extension was told to answer ok:false", ...errorDetailsFromEnv() },
  };
}

/**
 * The extra error keys `BC_TEST_ERROR_DETAILS` names, or `{}` when it is unset.
 *
 * Malformed JSON dies loudly instead of being dropped: a test that meant to send
 * details and quietly sent none would stay green while proving the wrong sentence.
 */
function errorDetailsFromEnv() {
  const raw = readEnv("BC_TEST_ERROR_DETAILS");
  if (raw === "") return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("BC_TEST_ERROR_DETAILS is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("BC_TEST_ERROR_DETAILS must be a JSON object");
  }
  return parsed;
}

/**
 * Reads the planned behaviour for one method out of the environment.
 *
 * Three modes, because the bridge has three answers to prove: a result, a
 * timeout (silence) and the extension's own `ok:false` failure.
 */
function answerModeFromEnv(variableName) {
  const raw = readEnv(variableName);
  if (raw === SILENT_ANSWER_FLAG) return { kind: "silent" };
  if (!raw.startsWith(ERROR_ANSWER_PREFIX)) return { kind: "result" };

  const code = raw.slice(ERROR_ANSWER_PREFIX.length);
  // `error:` without a code would answer `ok:false` with a code the bridge cannot
  // log. A fixture that quietly invents one would hide the mistake in the test
  // that set the variable, so it dies loudly instead.
  if (code === "") fail(`${variableName}=${raw} names no error code`);
  return { kind: "error", code };
}

/**
 * The stderr line announcing one request.
 *
 * `tab` rides along when the bridge put it on the wire, and it is the only *value* named
 * here: it is the one field the bridge adds on its own, so its presence is what a test can
 * hold `withOptionalTab` to. Page text and addresses stay out — no test needs them, and a
 * log is not the place for what the operator browsed.
 *
 * The `frame` substring is the one argument the bridge passes through that *is* an address
 * fragment, so the line says only that it was there (`frame=yes`, never the value): what a
 * test may prove is that the argument travelled, not which frame the operator addressed.
 */
function requestLine(message) {
  const tab = message.params?.tab;
  const suffix = Number.isInteger(tab) ? ` tab=${tab}` : "";
  const frame = message.params?.frame === undefined ? "" : " frame=yes";
  // The two window parameters `read` and `transcript` share. Logged only when the call
  // carries them: this line is the tests' proof that the bridge forwards what the caller
  // named, and a default printed here would hide a dropped or rewritten value.
  const window = ["offset", "maxChars"]
    .filter((key) => message.params?.[key] !== undefined)
    .map((key) => ` ${key}=${message.params[key]}`)
    .join("");
  return `fake extension: request method=${message.method}${suffix}${frame}${window}`;
}

/** What to send back for one request — `null` for "say nothing", the timeout case. */
function responseFor(message, answers) {
  switch (message.method) {
    case "status":
      return answered(message.id, answers.status, statusResponse);
    case "navigate":
      return answered(message.id, answers.navigate, navigateResponse);
    case "read":
      return answered(message.id, answers.read, readResponse, readErrorResponse);
    case "click":
      // No `via` on the failure answer, unlike `read`: a refused click never read
      // a page, so it has no source to name.
      return answered(message.id, answers.click, clickResponse);
    case "type":
      // Same shape as `click`: a refused type read nothing either.
      return answered(message.id, answers.type, typeResponse);
    case "focus":
      // Again no `via`: `focus` reads nothing, so a refused one has no source.
      return answered(message.id, answers.focus, focusResponse);
    case "inspect":
      // No `via` either: `inspect` answers elements, not a source of text.
      return answered(message.id, answers.inspect, inspectResponse);
    case "open_tab":
      // No `via`: opening a tab reads no page — the title it answers with is the
      // tab's, not a text source's.
      return answered(message.id, answers.openTab, openTabResponse);
    case "close_tab":
      // Again no `via`: a closed tab has no page left to read.
      return answered(message.id, answers.closeTab, closeTabResponse);
    case "eval":
      // And none here either: `eval` answers whatever the code produced, which is
      // not a text source the hub knows.
      return answered(message.id, answers.eval, evalResponse);
    case "screenshot":
      // No `via` either, and none is needed: a picture is not page text. The
      // failure answer is the plain `ok:false` frame — the bridge reads the
      // browser's message out of `error.message`, not out of a field beside it.
      return answered(message.id, answers.screenshot, screenshotResponse);
    case "frames":
      // No `via`: a frame list is not a text source either. The failure answer is the
      // plain `ok:false` frame, which is exactly what the three inherited codes
      // (`no_agent_tab`, `page_busy`, `not_readable`) arrive in.
      return answered(message.id, answers.frames, framesResponse);
    case "transcript":
      // No `via` either: a segment list is not a source of page text, it is the text.
      // The failure frame is the plain `ok:false` one — `transcript_failed`,
      // `no_transcript_panel`, `transcript_needs_focus` and the inherited window codes
      // all arrive that way.
      return answered(message.id, answers.transcript, transcriptResponse);
    default:
      return null;
  }
}

function answered(id, answer, resultResponse, failureResponse = errorResponse) {
  switch (answer.kind) {
    case "error":
      return failureResponse(id, answer.code);
    case "result":
      // The answer rides along for the one response that is built from the test's
      // environment rather than from a frozen constant; the others ignore it.
      return resultResponse(id, answer);
    default:
      return null;
  }
}

/* -------------------------------------------------------------------- the peer */

function readEnv(name) {
  const raw = process.env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** The byte count `BC_TEST_SCREENSHOT_BYTES` names, or `null` when it is unset. */
function byteCountFromEnv(name) {
  const raw = readEnv(name);
  if (raw === "") return null;
  const byteCount = Number(raw);
  // A silent `NaN` would build a zero-byte picture and the test that set the variable
  // would fail somewhere else entirely. The fixture dies where the typo is.
  if (!Number.isInteger(byteCount) || byteCount < 0) {
    fail(`${name}=${raw} is not a byte count`);
  }
  return byteCount;
}

function fail(message) {
  process.stderr.write(`fake extension: ${message}\n`);
  process.exit(1);
}

/**
 * Parses one incoming frame. Anything unparsable is dropped: the fixture only
 * needs the two message types the spec defines, and a broken frame is the
 * bridge's test case to report, not this one's.
 */
function parseMessage(data) {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function connect(socket, { token, answers }) {
  let welcomed = false;

  // Nothing but the socket keeps this process alive, so a peer that never
  // receives `welcome` would look like a hung test. The timer turns that into a
  // failure that names the fake instead of the bridge.
  const welcomeTimer = setTimeout(() => {
    fail(`no welcome within ${WELCOME_TIMEOUT_MS} ms`);
  }, WELCOME_TIMEOUT_MS);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify(helloMessage(token)));
  });

  socket.addEventListener("message", (event) => {
    const message = parseMessage(event.data);
    if (message === null) return;

    if (message.type === "welcome") {
      welcomed = true;
      clearTimeout(welcomeTimer);
      return;
    }

    if (message.type === "request") {
      // One line per request, before the answer: the tests count these to prove
      // which calls reached the extension at all — a refused call that never left
      // the bridge must leave no trace here.
      process.stderr.write(`${requestLine(message)}\n`);
      const response = responseFor(message, answers);
      if (response !== null) socket.send(JSON.stringify(response));
    }
  });

  socket.addEventListener("close", () => {
    clearTimeout(welcomeTimer);
    // Exit 0 in both directions of a normal shutdown: the bridge under test is
    // stopped by the parent, and what that means is decided there.
    process.exit(0);
  });

  socket.addEventListener("error", () => {
    clearTimeout(welcomeTimer);
    // A reset after the handshake is the parent stopping the bridge. Before it,
    // this fixture never reached the peer it was supposed to fake — that is a
    // fixture failure, not a bridge result.
    if (welcomed) {
      process.exit(0);
      return;
    }
    fail(`could not reach the bridge at ${socket.url}`);
  });
}

function main() {
  const url = readEnv("BC_TEST_URL");
  const token = readEnv("BC_TEST_TOKEN");
  const answers = {
    status: answerModeFromEnv("BC_TEST_ANSWER"),
    navigate: answerModeFromEnv("BC_TEST_NAVIGATE_ANSWER"),
    read: answerModeFromEnv("BC_TEST_READ_ANSWER"),
    click: answerModeFromEnv("BC_TEST_CLICK_ANSWER"),
    type: answerModeFromEnv("BC_TEST_TYPE_ANSWER"),
    focus: answerModeFromEnv("BC_TEST_FOCUS_ANSWER"),
    inspect: answerModeFromEnv("BC_TEST_INSPECT_ANSWER"),
    openTab: answerModeFromEnv("BC_TEST_OPEN_TAB_ANSWER"),
    closeTab: answerModeFromEnv("BC_TEST_CLOSE_TAB_ANSWER"),
    eval: answerModeFromEnv("BC_TEST_EVAL_ANSWER"),
    screenshot: {
      ...answerModeFromEnv("BC_TEST_SCREENSHOT_ANSWER"),
      byteCount: byteCountFromEnv("BC_TEST_SCREENSHOT_BYTES"),
      format: readEnv("BC_TEST_SCREENSHOT_FORMAT"),
    },
    frames: answerModeFromEnv("BC_TEST_FRAMES_ANSWER"),
    transcript: answerModeFromEnv("BC_TEST_TRANSCRIPT_ANSWER"),
  };

  if (url === "" || token === "") {
    fail("BC_TEST_URL and BC_TEST_TOKEN must be set; this fixture is started by test/bridge.test.js");
    return;
  }

  connect(new WebSocket(url), { token, answers });
}

// Under `node --test test/*.test.js` this file is imported by the test, and
// `npm test` passes an explicit glob because the runner would otherwise treat
// every file under `test/` as a test file and start this one as a peer.
const startedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (startedDirectly) main();
