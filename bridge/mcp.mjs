/**
 * MCP over stdio: JSON-RPC 2.0, one message per line, on the process' own
 * stdin and stdout.
 *
 * stdout is a protocol channel from here on, not a place to print things. pi's
 * `StdioTransport` splits stdout at every `\n` and treats a trailing fragment as
 * "server closed with an incomplete JSON-RPC message", so a single stray
 * `console.log` anywhere in the bridge makes the server unusable while looking
 * like a protocol bug. Everything diagnostic goes through the injected `log`
 * writer, which bridge.mjs points at stderr.
 */
import readline from "node:readline";

import { PROTOCOL } from "./protocol.mjs";

const JSONRPC_VERSION = "2.0";

// Reported in `initialize`. Hard-coded rather than imported from package.json:
// this module is loaded by the entry point, and the version is part of the
// handshake contract, not of the build.
const SERVER_INFO = Object.freeze({ name: "browser-control", version: "0.1.0" });

// Versions a client may ask for. Echoing an unknown one would make the client
// speak a dialect this server never implemented, so an unknown request falls
// back to the newest version we do speak.
const KNOWN_PROTOCOL_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const FALLBACK_PROTOCOL_VERSION = "2025-11-25";

// JSON-RPC 2.0 requires both fields on every error. The texts are English
// because this is the protocol layer; what a human reads is the German text
// inside a tool result.
const ERRORS = Object.freeze({
  PARSE_ERROR: Object.freeze({ code: -32700, message: "parse error" }),
  INVALID_REQUEST: Object.freeze({ code: -32600, message: "invalid request" }),
  METHOD_NOT_FOUND: Object.freeze({ code: -32601, message: "method not found" }),
  INVALID_PARAMS: Object.freeze({ code: -32602, message: "invalid params" }),
});

const BROWSER_STATUS = "browser_status";
const BROWSER_NAVIGATE = "browser_navigate";
const BROWSER_READ = "browser_read";
const BROWSER_CLICK = "browser_click";
const BROWSER_TYPE = "browser_type";
const BROWSER_FOCUS = "browser_focus";
const BROWSER_INSPECT = "browser_inspect";
const BROWSER_OPEN_TAB = "browser_open_tab";
const BROWSER_CLOSE_TAB = "browser_close_tab";
const BROWSER_EVAL = "browser_eval";
const BROWSER_SCREENSHOT = "browser_screenshot";
const BROWSER_FRAMES = "browser_frames";
const BROWSER_TRANSCRIPT = "browser_transcript";

// The one property ten schemas share. One frozen instance instead of ten
// literals: the same rule in ten copies is ten places to forget an edit. The
// tool table is deep-frozen and nothing mutates a schema, so sharing is safe —
// and `tools/list` serialises it into ten independent copies on the wire anyway,
// which is why a client never sees the aliasing.
const TAB_PROPERTY = Object.freeze({ type: "integer", minimum: 1 });

// The tool table is the contract with the client, so the strings are copied
// verbatim instead of being assembled. `additionalProperties: false` is
// load-bearing: `callTool` refuses any argument, and the schema has to say the
// same thing before the call happens.
const TOOLS = Object.freeze([
  Object.freeze({
    name: BROWSER_STATUS,
    description:
      "Zeigt die Fenster und Tabs des Betreiber-Browsers im Default-Container, samt Verbindungszustand der Extension, und markiert den Agenten-Tab mit `agent: true`.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({}),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: BROWSER_NAVIGATE,
    description:
      "Öffnet eine http(s)-URL im Agenten-Tab des Betreiber-Browsers (Default-Container), wartet, bis die Seite geladen ist, und danach, bis sie sich beruhigt hat (höchstens 3 s); meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ url: Object.freeze({ type: "string" }), tab: TAB_PROPERTY }),
      required: Object.freeze(["url"]),
      additionalProperties: false,
    }),
  }),
  // Four optional properties since spec 23: the window (`offset`, `maxChars`), the
  // `mode` that picks the article body, and the `tab` that picks *which* agent tab to
  // read — without it the extension reads the last used one. The ranges and the enum
  // stand in the schema because they are the contract, and the extension checks them
  // once more where the error is raised.
  Object.freeze({
    name: BROWSER_READ,
    description:
      "Liest Titel, Adresse und den Text des Agenten-Tabs; `offset` überspringt so viele Zeichen des Textes (Default 0), `maxChars` begrenzt den Ausschnitt (Default 20 000, höchstens 100 000). `offset`/`maxChars` blättern durch den Text; `chars` und `totalChars` sagen, wo man steht. `via` sagt, ob sichtbarer Text oder Textinhalt. `mode: article` liest nur den Artikelkörper — ohne Navigation, Fußzeile und Cookie-Banner. Wartet vorher, bis sich die Seite beruhigt hat (höchstens 3 s), und meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        offset: Object.freeze({ type: "integer", minimum: 0 }),
        maxChars: Object.freeze({ type: "integer", minimum: 1, maximum: 100000 }),
        mode: Object.freeze({ type: "string", enum: Object.freeze(["text", "article"]) }),
        // The frame filter of spec 24: a substring of a frame's address. `minLength`
        // states the one thing the schema can say about it — an empty substring would
        // match every frame — and everything else (which frame it hits) is the page's
        // decision, not the schema's.
        frame: Object.freeze({ type: "string", minLength: 1 }),
        tab: TAB_PROPERTY,
      }),
      additionalProperties: false,
    }),
  }),
  // `click` is the first tool whose argument is not a URL, so its schema names a
  // plain string: what a CSS selector may look like is `querySelector`'s rule,
  // and the extension is where it is applied — a copy here would be a second
  // opinion nobody asked for.
  Object.freeze({
    name: BROWSER_CLICK,
    description:
      "Klickt das erste Element, das dem CSS-Selektor entspricht, im Agenten-Tab, wartet, bis sich die Seite beruhigt hat (höchstens 3 s), und liefert den Seitentext danach (auf 20 000 Zeichen gekürzt); meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        selector: Object.freeze({ type: "string" }),
        // The frame filter of spec 26, in the same shape and at the same place `read`
        // declares it: a substring of a frame's address, `minLength` because the empty
        // substring would match every frame, everything else decided in the page.
        frame: Object.freeze({ type: "string", minLength: 1 }),
        tab: TAB_PROPERTY,
      }),
      required: Object.freeze(["selector"]),
      additionalProperties: false,
    }),
  }),
  // The first tool with more than one argument, and the only one with an optional
  // third. `text` has no format of its own — what a field accepts is the page's
  // business — and `submit` is a plain boolean: the schema says nothing beyond the
  // type, because a wrong type is refused at the call (`-32602`), not debated here.
  Object.freeze({
    name: BROWSER_TYPE,
    description:
      "Schreibt Text in das Feld, das dem CSS-Selektor entspricht, sendet optional Enter und liefert den Seitentext danach (auf 20 000 Zeichen gekürzt). Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        selector: Object.freeze({ type: "string" }),
        text: Object.freeze({ type: "string" }),
        submit: Object.freeze({ type: "boolean" }),
        // The frame filter of spec 26 — the field this tool is written into, not the tab
        // it lives in. Same shape as `click`'s and `read`'s.
        frame: Object.freeze({ type: "string", minLength: 1 }),
        tab: TAB_PROPERTY,
      }),
      required: Object.freeze(["selector", "text"]),
      additionalProperties: false,
    }),
  }),
  // Appended, never inserted: four assertions in `test/mcp.test.js` index the table
  // by position, and a new tool in the middle would shift all of them.
  // No required argument, like `read`: without `tab` the extension focuses the last
  // used agent tab, with `tab` exactly the one the caller named.
  Object.freeze({
    name: BROWSER_FOCUS,
    description:
      "Holt den Agenten-Tab nach vorn und sein Fenster in den Vordergrund; die Seite wird dabei nicht verändert, und `focused` kommt aus einer Abfrage nach dem Fokussieren. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ tab: TAB_PROPERTY }),
      additionalProperties: false,
    }),
  }),
  // The only tool with two optional arguments and no required one: `selector`,
  // `text` or both, and the call refuses a pair of neither. `limit` carries one
  // range in the schema and no check in `inspectTool` — the range is the
  // extension's rule, and a second opinion here would answer a limit the extension
  // would have accepted anyway (or accept one it refuses).
  // The `>>>` sentence is the only thing spec 27 adds here: `selector` stays a plain
  // string and the jump is syntax inside it, so the schema below is untouched. What the
  // sentence has to carry is the two facts a caller cannot guess — that the right side
  // is searched in the *open* shadow tree, and that each link is a bare selector, not a
  // full CSS chain. Closed trees stay unreachable because no script reaches into them,
  // and a caller who expects a hit there would read `count: 0` as a broken tool.
  Object.freeze({
    name: BROWSER_INSPECT,
    description:
      "Listet die Elemente des Agenten-Tabs auf (per CSS-Selektor und/oder Textsuche) mit Tag, id, class, Link, sichtbarem Text, Sichtbarkeit und einem fertigen Selektor zum Weiterverwenden. `my-card >>> button` springt rechts vom `>>>` in den offenen Schattenbaum von `my-card` (mehrere Stufen erlaubt); jedes Glied ist ein einfacher Selektor — Typ, `#id`, `.class`, `[attr=\"wert\"]` oder `:nth-of-type(n)`; geschlossene Schattenbäume bleiben unerreichbar, und ohne `>>>` ändert sich nichts. Ändert nichts an der Seite. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        selector: Object.freeze({ type: "string" }),
        text: Object.freeze({ type: "string" }),
        limit: Object.freeze({ type: "integer", minimum: 1, maximum: 200 }),
        includeHidden: Object.freeze({ type: "boolean" }),
        // The frame filter of spec 25, in the same shape and at the same place `read`
        // declares it: a substring of a frame's address, `minLength` because the empty
        // substring would match every frame, everything else decided in the page.
        frame: Object.freeze({ type: "string", minLength: 1 }),
        tab: TAB_PROPERTY,
      }),
      additionalProperties: false,
    }),
  }),
  // Appended, never inserted: seven assertions in `test/mcp.test.js` index the table
  // by position, and a tool in the middle would shift all of them.
  Object.freeze({
    name: BROWSER_OPEN_TAB,
    description:
      "Öffnet einen weiteren Agenten-Tab im Default-Container (höchstens fünf) und liefert `tabId`, `url` und `title`. Wartet, bis die Seite geladen ist, aber nicht auf Ruhe — ein `browser_read` danach soll nicht `page_busy` kosten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ url: Object.freeze({ type: "string" }) }),
      required: Object.freeze(["url"]),
      additionalProperties: false,
    }),
  }),
  // The counter-tool to `open_tab`. Nothing is required: without `tab` the
  // extension closes the tab it used last, which is the one an agent usually means.
  Object.freeze({
    name: BROWSER_CLOSE_TAB,
    description:
      "Schließt einen Agenten-Tab und entfernt ihn aus der Liste; ohne `tab` den zuletzt benutzten. Liefert `tabId` und `closed`.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ tab: TAB_PROPERTY }),
      additionalProperties: false,
    }),
  }),
  // Appended, never inserted: five assertions in `test/mcp.test.js` index the table
  // by position, and `browser_eval` is the tool that must not shift a single one.
  //
  // The schema states the type of `code` and nothing about its length: the 20 000
  // characters are the extension's rule, and a second opinion here would refuse a
  // call the extension would have accepted (or accept one it refuses) — the same
  // line `limit` draws for `inspect`. The description carries what the tool can do
  // to the operator's page, because a client shows it before the first call.
  //
  // The `Funktionsrumpf` sentence is not decoration either: a caller that sends a
  // bare `document.title` — no `return` — gets `null` from a perfectly healthy tool
  // and reads that as "not implemented". The contract has always said so (spec 19,
  // criterion 4); this is the only place a caller reads it without the spec.
  Object.freeze({
    name: BROWSER_EVAL,
    description:
      "Wertet Code im Seitenkontext des Agenten-Tabs aus und liefert das Ergebnis als JSON; Code darf die Seite ändern, auch Passwortfelder füllen. `code` läuft als Funktionsrumpf: Das Ergebnis kommt mit `return` zurück, ohne `return` ist es `null`. Nur möglich, wenn „Code-Auswertung erlauben\" in den Einstellungen der Erweiterung eingeschaltet ist — sonst `eval_not_allowed`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        code: Object.freeze({ type: "string" }),
        // The frame filter of spec 25: the code runs in the addressed frame and in no
        // other. Same property `read` and `inspect` declare, at the same place.
        frame: Object.freeze({ type: "string", minLength: 1 }),
        tab: TAB_PROPERTY,
      }),
      required: Object.freeze(["code"]),
      additionalProperties: false,
    }),
  }),
  // Appended, never inserted: every assertion above indexes the table by position,
  // and the eleventh tool is the one that must not shift a single one of them.
  //
  // One optional property and nothing else: `tab` picks *which* agent tab to
  // photograph, the same rule nine other tools follow. No `format`, no `quality`, no
  // `rect` — the ladder is the extension's contract, and a knob here would be a
  // second opinion about a picture the bridge never sees (spec 20, `## Non-goals`).
  Object.freeze({
    name: BROWSER_SCREENSHOT,
    description:
      "Fotografiert den sichtbaren Ausschnitt des Agenten-Tabs und liefert das Bild als MCP-Bildinhalt (höchstens 3 MiB; PNG, bei Überschreiten verkleinert und als JPEG neu kodiert). Die Zahlen dazu — `format`, `width`, `height`, `bytes` und `scaled` — stehen als Textblock daneben. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ tab: TAB_PROPERTY }),
      additionalProperties: false,
    }),
  }),
  // Appended, never inserted: every assertion above indexes the table by position, and
  // the twelfth tool is the one that must not shift a single one of them.
  //
  // One optional property and nothing else: `tab` picks *which* agent tab to
  // inventory. No `frame`, no depth, no parent list — this tool answers flat addresses,
  // and that is also the vocabulary the other tools address a frame with.
  Object.freeze({
    name: BROWSER_FRAMES,
    description:
      "Listet die Rahmen (iframes) des Agenten-Tabs mit ihrer Adresse; `frame` bei den anderen Werkzeugen nimmt einen Teilstring davon. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ tab: TAB_PROPERTY }),
      additionalProperties: false,
    }),
  }),
  // Appended, never inserted: every assertion above indexes the table by position, and
  // the thirteenth tool is the one that must not shift a single one of them.
  //
  // The window is `read`'s pair, property for property — the same two numbers count the
  // same unit (characters of the answer), so a second bound here would be a second
  // opinion about a paging rule the extension already applies. No `frame` and no `mode`:
  // a transcript is one track file of one watch page, and a frame filter would name a frame
  // that file never lives in.
  Object.freeze({
    name: BROWSER_TRANSCRIPT,
    description:
      "Liest das Transkript des YouTube-Video-Tabs als Segmente mit Zeitstempel und Text aus der Untertitelspur des Videos — die Spur, die der Player selbst geladen hat, nicht die, die sein Panel gerade zeigt. `requestedLanguage` nennt die gewählte Spur, `deliveredLanguage` die Sprache der gelieferten Spurendatei, `source` den Ort, an dem das Datenmodell des Players gefunden wurde. `offset` überspringt so viele Zeichen der verketteten Segmenttexte (Default 0), `maxChars` begrenzt den Ausschnitt (Default 20 000, höchstens 100 000); `segments` enthält genau die Segmente dieses Fensters, `chars` und `totalChars` sagen, wo man steht, und `truncated` blättert weiter. Der Tab muss im Vordergrund sein — vorher browser_focus aufrufen, sonst antwortet das Werkzeug `transcript_needs_focus`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        offset: Object.freeze({ type: "integer", minimum: 0 }),
        maxChars: Object.freeze({ type: "integer", minimum: 1, maximum: 100000 }),
        tab: TAB_PROPERTY,
      }),
      additionalProperties: false,
    }),
  }),
]);

// The code the extension answers with when it dislikes the URL's scheme.
// `bridge/mcp.mjs` keeps its own copy of that rule — the two checks are the
// double floor, not one shared function reached through the wire.
const INVALID_URL_CODE = "invalid_url";
// The two codes `read` can answer with that are the caller's situation rather
// than a broken call, so each gets its own sentence below.
const NO_AGENT_TAB_CODE = "no_agent_tab";
const NOT_READABLE_CODE = "not_readable";
// The third code of that group: nothing is wrong with the call, the page simply has
// not finished loading. Advice with a timestamp, not a failure.
const PAGE_BUSY_CODE = "page_busy";
// The fourth, and the one that carries a number: the page holds the whole text, so it
// alone can refuse an `offset` behind its end — and only its message names the length,
// which is the number the caller corrects its next offset by.
const OFFSET_OUT_OF_RANGE_CODE = "offset_out_of_range";
// The two codes the frame filter adds (spec 24). Both are the filter's verdict on
// frames that answered — `frame_not_found` carries how many answered,
// `frame_ambiguous` the colliding addresses — and both have their own sentences below.
const FRAME_NOT_FOUND_CODE = "frame_not_found";
const FRAME_AMBIGUOUS_CODE = "frame_ambiguous";
// The three codes `transcript` adds to `read`'s window codes (spec 32). It inherits
// `no_agent_tab`, `invalid_params` and `offset_out_of_range` — the same situation, the
// same sentences — and adds the page itself, the focus gate and the missing caption track. A
// typo in one of these three would silence a sentence without failing anything.
const TRANSCRIPT_FAILED_CODE = "transcript_failed";
const NO_TRANSCRIPT_PANEL_CODE = "no_transcript_panel";
const TRANSCRIPT_NEEDS_FOCUS_CODE = "transcript_needs_focus";
// The three codes a refused click answers with. Each names the selector, because
// the same selector is the thing the operator has to correct.
const INVALID_SELECTOR_CODE = "invalid_selector";
const NO_MATCH_CODE = "no_match";
const NOT_CLICKABLE_CODE = "not_clickable";
// The two codes a refused `type` adds to the selector codes above: the element is
// there but cannot take text, or it could but the operator has it locked.
const NOT_TYPEABLE_CODE = "not_typeable";
const PASSWORD_NOT_ALLOWED_CODE = "password_not_allowed";
// The one code `inspect` adds that the operator can act on: the extension reads
// the same four parameters the schema declares and refuses a value outside its
// rules (`limit: 201`, a filter that is not a string, a switch that is not a
// boolean). It is deliberately one sentence for all of them — the hub forwards
// only the code, and the bridge refuses to invent a field name it did not check.
const INVALID_PARAMS_CODE = "invalid_params";
// The one code `open_tab` adds, and the only one in this module that names a limit
// instead of a mistake: five agent tabs are the contract, so the sentence below
// asks for a close rather than for a retry.
const TOO_MANY_TABS_CODE = "too_many_tabs";
// The five codes `eval` adds. All five are the extension's, spelled here as the
// wire spells them, because a typo in one of these five would silence a sentence
// without failing anything the tests could see.
const EVAL_NOT_ALLOWED_CODE = "eval_not_allowed";
const EVAL_FAILED_CODE = "eval_failed";
const EVAL_TIMEOUT_CODE = "eval_timeout";
const EVAL_RESULT_TOO_LARGE_CODE = "eval_result_too_large";
const EVAL_RESULT_UNSERIALIZABLE_CODE = "eval_result_unserializable";
// The three codes `screenshot` adds, spelled as the wire spells them. It inherits
// `no_agent_tab` and `invalid_params` and deliberately *not* `page_busy` or
// `not_readable`: `captureTab` injects nothing, so there is no page triangle here.
const SCREENSHOT_NOT_ALLOWED_CODE = "screenshot_not_allowed";
const SCREENSHOT_FAILED_CODE = "screenshot_failed";
const SCREENSHOT_TOO_LARGE_CODE = "screenshot_too_large";
// The two formats the ladder may deliver, mapped to the MIME type the MCP image block
// carries. A table with two entries and no guessing: the *extension* decided the format
// when it encoded the picture, so the bridge has nothing to sniff and must not try.
//
// Read with `Object.hasOwn`, never as `SCREENSHOT_MIME_TYPES[format] === undefined`: the
// lookup of a prototype key (`"toString"`, `"constructor"`) answers a function, and that
// function would end up in a frame as somebody's `mimeType`.
const SCREENSHOT_MIME_TYPES = Object.freeze({ png: "image/png", jpeg: "image/jpeg" });

// The `kind` values a `not_readable` sentence may print. A whitelist, not a
// pass-through: the value comes off the wire, and an unvetted string has no
// business inside a sentence the operator reads. `unknown` is on the list so the
// extension's own "I cannot tell" is a known answer — the sentence still drops it,
// because printing "Typ: unknown" would dress up a missing fact as a finding.
const NOT_READABLE_KINDS = Object.freeze(["internal", "pdf", "file", "unknown"]);

// How many colliding frame addresses a `frame_ambiguous` sentence prints. The extension
// caps its own list at five too; this second cap is the display limit of the side that
// builds the sentence, not a second opinion about the frames.
const FRAME_CANDIDATE_LIMIT = 5;

// The wire name of the tab every tab-addressed tool may name, spelled once: `tabId`
// is what the extension *answers*, and a second spelling here would travel to the
// extension as an argument it silently ignores.
const TAB_ARGUMENT = "tab";
// The whole of the `focus`, `close_tab` and `screenshot` schema: one optional key.
const TAB_ARGUMENTS = Object.freeze([TAB_ARGUMENT]);
// The `status` schema: nothing at all, not even `tab` — it reports every window, so
// a tab could only be ignored.
const NO_ARGUMENTS = Object.freeze([]);

// The two keys `browser_navigate` accepts, in the order the schema declares them.
// The list is what "everything apart from these" is measured against.
const NAVIGATE_ARGUMENTS = Object.freeze(["url", TAB_ARGUMENT]);
// The one required key of `browser_open_tab`; it deliberately takes no `tab`: the
// tab it would name does not exist until the call returns.
const OPEN_TAB_ARGUMENTS = Object.freeze(["url"]);
// The three keys `browser_click` accepts, in schema order.
const CLICK_ARGUMENTS = Object.freeze(["selector", "frame", TAB_ARGUMENT]);

// The five keys `browser_read` accepts, in the order the schema declares them. Also
// the order `readTool` copies the set ones into the request, so the wire payload reads
// like the tool description instead of like the caller's key order.
const READ_ARGUMENTS = Object.freeze(["offset", "maxChars", "mode", "frame", TAB_ARGUMENT]);

// The four keys `browser_type` accepts. A list, because "everything apart from
// these" is the rule the schema states with `additionalProperties: false`.
const TYPE_ARGUMENTS = Object.freeze(["selector", "text", "submit", "frame", TAB_ARGUMENT]);

// The six keys `browser_inspect` accepts, in the order the schema declares them.
// Also the order `inspectTool` copies the set ones into the request, so the wire
// payload reads like the tool description instead of like the caller's key order.
const INSPECT_ARGUMENTS = Object.freeze(["selector", "text", "limit", "includeHidden", "frame", TAB_ARGUMENT]);

// The three keys `browser_eval` accepts: the code body, the optional frame and the
// optional tab. A list for the same reason as everywhere else — it is what "everything
// apart from these" is measured against.
const EVAL_ARGUMENTS = Object.freeze(["code", "frame", TAB_ARGUMENT]);

// The three keys `browser_transcript` accepts, in schema order. The same comment as
// `READ_ARGUMENTS` applies: it is also the order the set keys are copied onto the wire.
const TRANSCRIPT_ARGUMENTS = Object.freeze(["offset", "maxChars", TAB_ARGUMENT]);

// The sentence for a call that carries arguments its schema forbids. One entry per
// tool instead of one sentence for all of them: `navigate` and `click` do expect
// an argument, and a shared wording would have to lie about the rest.
const UNEXPECTED_ARGUMENTS = Object.freeze({
  [BROWSER_STATUS]: `${BROWSER_STATUS} erwartet keine Argumente.`,
  [BROWSER_NAVIGATE]: `${BROWSER_NAVIGATE} erwartet nur \`url\` und \`tab\`.`,
  [BROWSER_READ]: `${BROWSER_READ} erwartet nur \`offset\`, \`maxChars\`, \`mode\`, \`frame\` und \`tab\`.`,
  [BROWSER_CLICK]: `${BROWSER_CLICK} erwartet nur \`selector\`, \`frame\` und \`tab\`.`,
  [BROWSER_TYPE]: `${BROWSER_TYPE} erwartet nur \`selector\`, \`text\`, \`submit\`, \`frame\` und \`tab\`.`,
  [BROWSER_FOCUS]: `${BROWSER_FOCUS} erwartet nur \`tab\`.`,
  [BROWSER_INSPECT]: `${BROWSER_INSPECT} erwartet nur \`selector\`, \`text\`, \`limit\`, \`includeHidden\`, \`frame\` und \`tab\`.`,
  [BROWSER_OPEN_TAB]: `${BROWSER_OPEN_TAB} erwartet nur \`url\`.`,
  [BROWSER_CLOSE_TAB]: `${BROWSER_CLOSE_TAB} erwartet nur \`tab\`.`,
  [BROWSER_EVAL]: `${BROWSER_EVAL} erwartet nur \`code\`, \`frame\` und \`tab\`.`,
  [BROWSER_SCREENSHOT]: `${BROWSER_SCREENSHOT} erwartet nur \`tab\`.`,
  [BROWSER_FRAMES]: `${BROWSER_FRAMES} erwartet nur \`tab\`.`,
  [BROWSER_TRANSCRIPT]: `${BROWSER_TRANSCRIPT} erwartet nur \`offset\`, \`maxChars\` und \`tab\`.`,
});

// The visible texts of all tools. One place, because the contract quotes them
// word for word and a test compares them word for word.
const TOOL_TEXTS = Object.freeze({
  UNKNOWN_TOOL: (name) => `Unbekanntes Tool: ${name}`,
  INVALID_URL: "Nur http:// und https:// sind erlaubt.",
  NO_EXTENSION:
    "Keine Extension verbunden — Firefox mit der Extension läuft nicht oder die Verbindung ist getrennt.",
  NO_ANSWER: "Die Extension hat nicht geantwortet (Zeitüberschreitung).",
  NO_AGENT_TAB: "Kein Agenten-Tab — zuerst browser_navigate aufrufen.",
  // No advice that would help: the fifth tab is the limit, so closing one is the
  // only thing that unblocks the call, and the sentence says exactly that.
  TOO_MANY_TABS: "Es sind schon fünf Agenten-Tabs offen — erst einen schließen.",
  // Retrying is the whole fix, so the sentence asks for it and promises nothing
  // about how long "gleich" is — the extension does not measure that either.
  PAGE_BUSY: "Die Seite lädt noch — bitte gleich noch einmal versuchen.",
  NOT_READABLE: "Diese Seite kann die Extension nicht lesen (interne Seite oder Sonderformat).",
  // The same news with the one fact the extension could add: which kind of page it
  // was, and where it was. Both are hidden when unknown, and neither is invented —
  // the fallback above is the sentence for "the extension told us nothing".
  NOT_READABLE_WITH_KIND: (kind, url) =>
    `Diese Seite kann die Extension nicht lesen (Typ: ${kind}). Adresse: ${url}`,
  // The type the server reported goes next to the kind, in that order, because the
  // kind is what the address promised and the type is what the server delivered —
  // they may disagree, and the sentence lets both stand instead of picking one.
  NOT_READABLE_WITH_KIND_AND_TYPE: (kind, contentType, url) =>
    `Diese Seite kann die Extension nicht lesen (Typ: ${kind}, Content-Type: ${contentType}). Adresse: ${url}`,
  // Without a kind the bracket carries the type alone: one fact beats a placeholder
  // word, so the bracket stays instead of falling back to the kindless sentence.
  NOT_READABLE_WITH_TYPE: (contentType, url) =>
    `Diese Seite kann die Extension nicht lesen (Content-Type: ${contentType}). Adresse: ${url}`,
  NOT_READABLE_WITH_URL: (url) => `Diese Seite kann die Extension nicht lesen. Adresse: ${url}`,
  // The extension's `offset_out_of_range`. The length is the entire value of this code:
  // without it the caller cannot tell where the text ends, and that number only ever
  // existed in the page. Hence a second sentence for the case that carries one — like
  // `EVAL_FAILED_WITH_MESSAGE`, and for the same reason: the message *is* the fact.
  OFFSET_OUT_OF_RANGE: "Der `offset` liegt hinter dem Ende des Textes.",
  OFFSET_OUT_OF_RANGE_WITH_MESSAGE: (message) =>
    `Der \`offset\` liegt hinter dem Ende des Textes: ${message}`,
  // The extension's `invalid_params` for `read`: a `tab` that is no tab id, or a window
  // outside `1 … 100000`. Unlike `inspect`'s and `eval`'s sentence this one has a second
  // form, because the extension's message names the field and both bounds ("maxChars
  // muss eine ganze Zahl von 1 bis 100000 sein.") — the caller's whole fix is in there.
  // Without it the agent would read the generic `code=invalid_params` and guess.
  INVALID_READ_PARAMS: "Der Parameter ist ungültig.",
  INVALID_READ_PARAMS_WITH_MESSAGE: (message) => `Der Parameter ist ungültig: ${message}`,
  // The two frame codes of spec 24, each with a second form for the fact the extension
  // sent: the number of frames that answered, and the addresses that collided. Advice
  // for the next call, so both name what the caller has to change.
  FRAME_NOT_FOUND: "Zu diesem `frame` passt kein Rahmen — mit browser_frames die Adressen prüfen.",
  FRAME_NOT_FOUND_WITH_COUNT: (count) =>
    `Zu diesem \`frame\` passt kein Rahmen — mit browser_frames die Adressen prüfen (geantwortete Rahmen: ${count}).`,
  FRAME_AMBIGUOUS:
    "Mehrere Rahmen passen zu diesem `frame` — einen längeren Teilstring der Adresse angeben.",
  FRAME_AMBIGUOUS_WITH_CANDIDATES: (candidates) =>
    `Mehrere Rahmen passen zu diesem \`frame\` — einen längeren Teilstring einer dieser Adressen angeben: ${candidates.join(", ")}.`,
  // The selector is repeated verbatim in all three: the operator just clicked
  // somewhere, and the value they would paste back is the one they sent.
  INVALID_SELECTOR: (selector) => `Der Selektor ist ungültig: ${selector}.`,
  NO_MATCH: (selector) => `Kein Element passt zu: ${selector}.`,
  NOT_CLICKABLE: (selector) => `Das Element ist nicht sichtbar oder deaktiviert: ${selector}.`,
  // `not_typeable` covers both halves of the same rule — a `div` takes no text and
  // a disabled input takes none either — so the sentence names both. The password
  // sentence points at the only place the decision can be changed, because the
  // bridge cannot see that option at all.
  NOT_TYPEABLE: (selector) => `Das Element ist kein beschreibbares Feld oder deaktiviert: ${selector}.`,
  PASSWORD_NOT_ALLOWED: "Passwortfelder sind gesperrt. In den Optionen der Erweiterung freischalten.",
  // `inspect` needs at least one filter, and this sentence names which two — the
  // caller sent neither, so "the parameter is invalid" (the sentence below for the
  // extension's own refusal) would leave them guessing.
  INSPECT_NEEDS_FILTER: "browser_inspect braucht `selector` oder `text`.",
  // The extension's `invalid_params`, which is a limit outside 1–200 or a filter of
  // the wrong type. No field name: the hub hands over the code alone, and the
  // bridge does not range-check the limit it would have to blame.
  INVALID_INSPECT_PARAMS: "Der Parameter ist ungültig.",
  STATUS_EXTENSION_FAILED: (code) => `Die Extension konnte den Status nicht liefern (code=${code}).`,
  // The sentences of `browser_eval`, one per code — plus a second one for
  // `eval_failed` —, so the agent reads a cause instead of a number.
  //
  // `eval_failed` is the one code with a second sentence: the page's own message is
  // the only thing that makes it actionable, so it rides along when the extension
  // sent one (`EVAL_FAILED_WITH_MESSAGE`). The other four stay static — they carry no
  // page message, and mixing one in would be a second truth about the same call.
  //
  // `eval_not_allowed` is the only one that names the place to act: the switch lives
  // in the extension's options, and the bridge cannot see it at all.
  EVAL_NOT_ALLOWED:
    "Code-Auswertung ist in den Einstellungen der Erweiterung nicht erlaubt — erst dort einschalten.",
  EVAL_FAILED: "Der Code im Agenten-Tab ist gescheitert (Ausnahme oder Syntaxfehler).",
  // Cause and origin in one sentence: the page's message says what broke, the prefix
  // says whose snippet broke. The colon is the seam, so an empty message would leave a
  // dangling `:` — `evalFailedText` refuses to build this sentence without one.
  EVAL_FAILED_WITH_MESSAGE: (message) => `Der Code im Agenten-Tab ist gescheitert: ${message}`,
  // The deadline is the extension's 2 s; the sentence names it, because "timed out"
  // without a number would leave the caller guessing how long it may wait.
  EVAL_TIMEOUT: "Der Code hat nicht rechtzeitig geantwortet (Zeitüberschreitung nach 2 s).",
  // The advice points at the tool that answers a list without the 10 000-character
  // limit: retrying the same code would produce the same oversized answer.
  EVAL_RESULT_TOO_LARGE:
    "Das Ergebnis ist zu groß für eine Antwort (mehr als 10 000 Zeichen JSON) — weniger zurückgeben, zum Beispiel mit browser_inspect.",
  EVAL_RESULT_UNSERIALIZABLE:
    "Das Ergebnis lässt sich nicht als JSON abbilden (etwa zirkulär) — nur einfache Werte zurückgeben.",
  // The extension's `invalid_params` for `eval` is an empty code or one above
  // 20 000 characters. No field name and no limit: the hub forwards the code alone,
  // and the bridge refuses to blame a length it never checked.
  INVALID_EVAL_PARAMS: "Der Parameter ist ungültig.",
  // The sentences of `browser_screenshot`, one per code — plus a second one for the
  // two codes that carry a message, for the same reason `eval_failed` has one: at
  // `screenshot_failed` the browser's own words are the only actionable fact, and at
  // `screenshot_too_large` the measurement decides whether another tab could help.
  //
  // The bridge formats no number of its own. The bytes and the two dimensions come
  // from the extension's `details.message` verbatim — a second formatting here would
  // be a second truth about the same measurement.
  //
  // `screenshot_not_allowed` is the only one that names the place to act: the switch
  // lives in the extension's options, and the bridge cannot see it at all.
  SCREENSHOT_NOT_ALLOWED:
    "Bildschirmfotos sind in den Einstellungen der Erweiterung nicht erlaubt — erst dort einschalten.",
  SCREENSHOT_FAILED: "Der Agenten-Tab ließ sich nicht fotografieren.",
  SCREENSHOT_FAILED_WITH_MESSAGE: (message) => `Der Agenten-Tab ließ sich nicht fotografieren: ${message}`,
  SCREENSHOT_TOO_LARGE:
    "Das Bild ist auch nach dem Verkleinern zu groß — es wird nicht geliefert; ein anderer Tab kann kleiner ausfallen.",
  // The label keeps the quoted sentence readable next to the bridge's own: the
  // extension repeats the cause, and `Messung:` says whose numbers these are.
  SCREENSHOT_TOO_LARGE_WITH_MESSAGE: (message) =>
    `Das Bild ist auch nach dem Verkleinern zu groß — es wird nicht geliefert; ein anderer Tab kann kleiner ausfallen. Messung: ${message}`,
  // The extension's `invalid_params` for `screenshot` is a `tab` of the wrong type.
  // No field name and no rule: the hub forwards the code alone.
  INVALID_SCREENSHOT_PARAMS: "Der Parameter ist ungültig.",
  // The sentences of `browser_transcript`, one per code (spec 32). The first three are
  // the tool's own verdicts and each names the next step: a page that is no watch page,
  // a tab that is not in front, a video whose model has no caption track. `offset_out_of_range` and
  // `invalid_params` take the `read` sentences above — the extension checks both tools
  // with the same `windowParamsOf`, and two wordings for one verdict would be two truths.
  TRANSCRIPT_FAILED:
    "Das Transkript ließ sich nicht lesen — nur YouTube-Watch-Seiten haben eines.",
  // The same code with the extension's own reason. It is the whole difference on a watch
  // page: the sentence above blames the page, while the reason names what is missing
  // ("Die Spurendatei zur Sprache \"ja\" wurde auf dieser Seite nicht gefunden."). Built
  // like `OFFSET_OUT_OF_RANGE_WITH_MESSAGE`, and the reason is again the fact itself.
  TRANSCRIPT_FAILED_WITH_MESSAGE: (message) =>
    `Das Transkript ließ sich nicht lesen: ${message}`,
  TRANSCRIPT_NEEDS_FOCUS:
    "Der Tab ist nicht im Vordergrund, deshalb ist die Seite nicht gerendert — zuerst browser_focus aufrufen und es dann erneut versuchen.",
  // The extension sends the reason along, and it is the whole difference between the two
  // states: a hidden tab needs `browser_focus`, a *visible* but still hydrating one must
  // not be focused again (spec 32, criterion 5). The plain sentence above would start
  // exactly the loop that second state exists to prevent.
  TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE: (message) => `Die Seite ist nicht gerendert: ${message}`,
  // The key keeps its name from spec 32 — a new code would be a new spec. The field is no
  // panel any more: the tool reads the caption track of the model, so the sentence names
  // the track, and the second clause still covers the page that is not done building.
  NO_TRANSCRIPT_PANEL:
    "Keine Untertitelspur im Video gefunden — das Video hat keine, oder die Seite ist noch nicht fertig aufgebaut.",
  // Shared by `navigate` and `read`: the sentence says "the request", not "the
  // navigation", and two keys with the same wording would be one too many.
  CALL_EXTENSION_FAILED: (code) => `Die Extension konnte die Anfrage nicht ausführen (code=${code}).`,
  BRIDGE_FAILED: "Die Bridge konnte den Status nicht lesen.",
});

/**
 * Runs the JSON-RPC side on `input`/`output` until `input` ends.
 *
 * `hub` and `log` belong to the tool layer (`tools/list`, `tools/call`) and
 * are injected so the entry point wires them exactly once: the hub is the only
 * path to the extension, and `log` is the only channel that is not stdout.
 *
 * `onInputClosed` is the lifecycle hook: it fires when stdin ends and is
 * deliberately a plain callback — what closing stdin means for the process is
 * the entry point's decision, not this module's.
 */
export function startMcpServer({
  hub,
  log,
  input = process.stdin,
  output = process.stdout,
  onInputClosed = () => {},
}) {
  // Registered once, not per write: a listener per message would leak and
  // eventually trip MaxListenersExceededWarning. Without any handler, an EPIPE
  // when the client goes away is an unhandled `error` event and kills the
  // process with a code nobody asked for.
  output.on("error", () => {});

  const writeMessage = (message) => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  const context = { hub, log, writeMessage };
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  // Not awaited on purpose: two `tools/call`s must run as two independent
  // awaits. A queue would let a slow extension block a request that could be
  // answered immediately, and the client matches answers by `id` anyway.
  //
  // The `catch` is the net under that choice: nothing throws out of `handleLine`
  // today, but an unhandled rejection ends the process by default, and a single
  // bad line must never be able to kill the server. Logged, then dropped — the
  // client sees a missing answer, not a protocol error nobody asked for.
  lines.on("line", (text) => {
    void handleLine(text, context).catch((error) => {
      context.log(`mcp line failed: ${error?.message ?? error}`);
    });
  });
  lines.on("close", () => onInputClosed());
}

/**
 * One line in, at most one message out. Everything malformed is answered here;
 * a notification gets no answer at all, because JSON-RPC forbids one.
 */
async function handleLine(text, context) {
  const message = await handleMessageText(text, context);
  if (message !== null) context.writeMessage(message);
}

/**
 * The transport-independent part: one JSON-RPC text in, at most one message
 * out (`null` for a notification and for anything that must not be answered).
 *
 * Exported because it is the seam between protocol and transport: stdio calls
 * it through `handleLine`, an HTTP body will call it directly, and both get the
 * same answers — including the `-32700` this function decides itself. Keeping
 * the write out of it means the one place that writes stays one place, no
 * matter how many ways in there are.
 */
export async function handleMessageText(text, context) {
  // The length check limits what gets answered, not how much memory this costs:
  // readline buffers the whole line before it hands it over. A line this long is
  // a broken client, not a request; answering keeps the session alive instead of
  // leaving the client to time out.
  if (Buffer.byteLength(text, "utf8") > PROTOCOL.MAX_MESSAGE_BYTES) {
    return errorMessage(null, ERRORS.PARSE_ERROR);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // One bad line is not a reason to die.
    return errorMessage(null, ERRORS.PARSE_ERROR);
  }

  if (!isJsonObject(parsed)) {
    // MCP dropped JSON-RPC batches, so an array — or a bare string — is a client
    // bug. Refusing it is honest; half-processing it would be worse.
    return errorMessage(null, ERRORS.INVALID_REQUEST);
  }

  // No `id` means notification (`notifications/initialized` is the one that
  // always arrives): answered never, handled never in this stage.
  if (!Object.hasOwn(parsed, "id")) return null;

  return respondTo(parsed, context);
}

/**
 * Turns one request into its response.
 *
 * A protocol-level failure (`-32601`, `-32602`) says the *request* is wrong; a
 * tool that fails later reports inside `result.content` with `isError`, so the
 * client can show the message instead of a protocol error.
 */
async function respondTo(request, context) {
  // `id: null` for a request that carries none — JSON-RPC's way of saying "I
  // could not read your id".
  const id = request.id ?? null;

  switch (request.method) {
    case "initialize":
      return resultMessage(id, initializeResult(request.params));
    case "ping":
      return resultMessage(id, {});
    case "tools/list":
      return resultMessage(id, { tools: TOOLS });
    case "tools/call":
      return callTool(id, request.params, context);
    default:
      return errorMessage(id, ERRORS.METHOD_NOT_FOUND);
  }
}

/**
 * Answers a `tools/call` request.
 *
 * The order of the checks is deliberate: a request without a usable `name` is a
 * malformed *request* (`-32602`), an unknown `name` is a tool result the client
 * should display, and only then are the arguments judged — per tool, because
 * each tool judges its own.
 */
async function callTool(id, params, context) {
  const name = params?.name;
  if (typeof name !== "string" || name === "") {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  switch (name) {
    case BROWSER_STATUS:
      return statusTool(id, params, context);
    case BROWSER_NAVIGATE:
      return navigateTool(id, params, context);
    case BROWSER_READ:
      return readTool(id, params, context);
    case BROWSER_CLICK:
      return clickTool(id, params, context);
    case BROWSER_TYPE:
      return typeTool(id, params, context);
    case BROWSER_FOCUS:
      return focusTool(id, params, context);
    case BROWSER_INSPECT:
      return inspectTool(id, params, context);
    case BROWSER_OPEN_TAB:
      return openTabTool(id, params, context);
    case BROWSER_CLOSE_TAB:
      return closeTabTool(id, params, context);
    case BROWSER_EVAL:
      return evalTool(id, params, context);
    case BROWSER_SCREENSHOT:
      return screenshotTool(id, params, context);
    case BROWSER_FRAMES:
      return framesTool(id, params, context);
    case BROWSER_TRANSCRIPT:
      return transcriptTool(id, params, context);
    default:
      return toolError(id, TOOL_TEXTS.UNKNOWN_TOOL(name));
  }
}

function statusTool(id, params, context) {
  return optionalArgumentsTool(id, params, context, {
    name: BROWSER_STATUS,
    request: (hub) => hub.requestStatus(),
  });
}

/**
 * `tools/call` for `browser_read`: a window, a `mode`, an optional `tab`, and the
 * method of the same name.
 *
 * Two checks before the request leaves, in the order `inspectTool` established: the
 * declared types (`-32602`, because the schema states them) and the keys the schema
 * forbids (the tool's own sentence). Types are what the bridge checks — the *enum* and
 * the *ranges* are not checked here on purpose. `"text"`/`"article"` for `mode`,
 * 1 … 100 000 for `maxChars` and "0 or more" for `offset` belong to the extension,
 * which refuses anything else with `invalid_params`; a copy in the bridge would be a
 * second opinion with its own drift — the same split `inspect`'s `limit` has.
 */
async function readTool(id, params, { hub, log }) {
  const args = params.arguments ?? {};
  if (!hasDeclaredReadArgumentTypes(args)) {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (hasUndeclaredArgument(args, READ_ARGUMENTS)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[BROWSER_READ]);
  }

  // Only the keys the caller actually set, in schema order: the extension fills
  // `offset`, `maxChars` and `mode` with its defaults, and a request that named them
  // would put a window on the wire — and into the hub's log line — that nobody asked for.
  const requestParams = {};
  for (const key of READ_ARGUMENTS) {
    if (args[key] !== undefined) requestParams[key] = args[key];
  }

  try {
    return textResultMessage(id, await hub.request(PROTOCOL.METHODS.READ, requestParams));
  } catch (error) {
    return toolError(id, failureTextFor(BROWSER_READ, error, log, requestParams));
  }
}

/** `tools/call` for `browser_focus`: an optional `tab`, and an otherwise empty payload. */
function focusTool(id, params, context) {
  return optionalArgumentsTool(id, params, context, {
    name: BROWSER_FOCUS,
    allowedArguments: TAB_ARGUMENTS,
    request: (hub, tab) => hub.request(PROTOCOL.METHODS.FOCUS, withOptionalTab({}, tab)),
  });
}

/** `tools/call` for `browser_close_tab`: an optional `tab`, empty payload without it. */
function closeTabTool(id, params, context) {
  return optionalArgumentsTool(id, params, context, {
    name: BROWSER_CLOSE_TAB,
    allowedArguments: TAB_ARGUMENTS,
    request: (hub, tab) => hub.request(PROTOCOL.METHODS.CLOSE_TAB, withOptionalTab({}, tab)),
  });
}

/**
 * `tools/call` for `browser_screenshot`: an optional `tab`, and an otherwise empty
 * payload — the picture's parameters are the extension's ladder, not the caller's.
 *
 * No own `catch`: `optionalArgumentsTool` already hands `error.details` to
 * `failureTextFor`, and `screenshotFailureTextFor` is where the two message-carrying
 * codes read it. A second `catch` here would be a second path to the same sentence.
 *
 * The `format` switch is the only difference to the other four allow-list tools: a
 * picture is not JSON text, it is an image content block with the numbers beside it.
 */
function screenshotTool(id, params, context) {
  return optionalArgumentsTool(id, params, context, {
    name: BROWSER_SCREENSHOT,
    allowedArguments: TAB_ARGUMENTS,
    request: (hub, tab) => hub.request(PROTOCOL.METHODS.SCREENSHOT, withOptionalTab({}, tab)),
    format: screenshotResultMessage,
  });
}

/**
 * `tools/call` for `browser_frames`: an optional `tab`, and an otherwise empty payload.
 *
 * The fourth tool whose whole argument rule is `TAB_ARGUMENTS` — no picture to format,
 * no extra knob, because the frame *addresses* are the answer and the filter that uses
 * them is a parameter of the other tools.
 */
function framesTool(id, params, context) {
  return optionalArgumentsTool(id, params, context, {
    name: BROWSER_FRAMES,
    allowedArguments: TAB_ARGUMENTS,
    request: (hub, tab) => hub.request(PROTOCOL.METHODS.FRAMES, withOptionalTab({}, tab)),
  });
}

/**
 * `tools/call` for `browser_transcript`: the window (`offset`, `maxChars`), an optional
 * `tab`, and the method of the same name.
 *
 * The same split as `readTool`, because it is the same window: the declared *types* are
 * the bridge's (`-32602`, the schema states them), the *ranges* are the extension's — a
 * `maxChars` outside 1 … 100 000 or a negative `offset` comes back as `invalid_params`
 * with the field named, which is a sentence the bridge could only guess at.
 */
async function transcriptTool(id, params, { hub, log }) {
  const args = params.arguments ?? {};
  if (!hasDeclaredTranscriptArgumentTypes(args)) {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (hasUndeclaredArgument(args, TRANSCRIPT_ARGUMENTS)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[BROWSER_TRANSCRIPT]);
  }

  // Only the keys the caller set, in schema order: the extension fills `offset` and
  // `maxChars` with its defaults, and a request that named them would put a window on
  // the wire that nobody asked for.
  const requestParams = {};
  for (const key of TRANSCRIPT_ARGUMENTS) {
    if (args[key] !== undefined) requestParams[key] = args[key];
  }

  try {
    return textResultMessage(id, await hub.request(PROTOCOL.METHODS.TRANSCRIPT, requestParams));
  } catch (error) {
    return toolError(id, failureTextFor(BROWSER_TRANSCRIPT, error, log, requestParams));
  }
}

/**
 * The one path the four tools take whose whole argument rule is a short allow-list:
 * `status` allows nothing at all, `focus`, `close_tab`, `screenshot` and `frames` allow
 * exactly `tab`. They differ only in the request they send and in the shape of their
 * answer, so a second copy of check-then-ask would be a second place to fix.
 *
 * Both checks come first: a call that would be refused must not reach the extension
 * at all. The key set is judged before the type, because a tool that declares no
 * `tab` has to answer its own sentence even when the value would be an integer.
 *
 * `format` is the seam for an answer that is not indented JSON — today only the
 * picture of `browser_screenshot`. It is called *inside* the `try`, so a formatter
 * that throws ends as `BRIDGE_FAILED`; hence the rule that it validates and returns an
 * error instead of throwing.
 */
async function optionalArgumentsTool(
  id,
  params,
  { hub, log },
  { name, request, allowedArguments = NO_ARGUMENTS, format = textResultMessage },
) {
  const args = params.arguments;
  if (!hasNoArguments(args, allowedArguments)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[name]);
  }

  // A wrong type is a malformed request (`-32602`), because the schema says
  // `integer`: the client broke the contract before the tool ever ran.
  if (allowedArguments.includes(TAB_ARGUMENT) && !hasDeclaredTabArgument(args)) {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  try {
    return format(id, await request(hub, args?.tab));
  } catch (error) {
    return toolError(id, failureTextFor(name, error, log));
  }
}

/** A successful result as the indented JSON text block every tool answers with. */
function textResultMessage(id, result) {
  return resultMessage(id, {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  });
}

/**
 * The answer of `browser_screenshot`: the metadata as text, then the picture as an
 * image block.
 *
 * Text first, image second — that order is the contract: a client that renders only
 * the first block still learns what the picture is, and one that renders both reads
 * the numbers above the picture instead of below it.
 *
 * The base64 lives in the image block **only**. A copy in the text block would be the
 * same payload twice for a benefit nobody has — and the metadata is what a model can
 * read without decoding anything.
 *
 * Returns, never throws: `optionalArgumentsTool` calls this inside its `try`, where a
 * throw would be reported as `BRIDGE_FAILED` — a sentence about the bridge for a
 * problem in the extension's answer. A `format` neither `png` nor `jpeg` is our own
 * bug or a wire that drifted, and the generic screenshot sentence is the honest answer
 * to it; guessing a MIME type would ship a lie the client cannot detect.
 *
 * The answer in wire terms — text first, the picture after it, and the base64 with no
 * `data:` prefix, because the MCP protocol wants the bare streak:
 *
 *   {"content": [
 *     {"type": "text", "text": "{ … }"},
 *     {"type": "image", "mimeType": "image/png", "data": "iVBORw0…"}
 *   ]}
 */
function screenshotResultMessage(id, result) {
  const format = result?.format;
  const base64 = result?.base64;
  if (typeof base64 !== "string" || !Object.hasOwn(SCREENSHOT_MIME_TYPES, format)) {
    return toolError(id, TOOL_TEXTS.SCREENSHOT_FAILED);
  }

  // Rest destructuring, not a hand-written field list: the metadata keeps the order
  // and the count the extension answered with, and a field added there arrives here
  // without an edit.
  const { base64: _picture, ...metadata } = result;
  return resultMessage(id, {
    content: [
      { type: "text", text: JSON.stringify(metadata, null, 2) },
      { type: "image", mimeType: SCREENSHOT_MIME_TYPES[format], data: base64 },
    ],
  });
}

/**
 * `tools/call` for `browser_navigate`.
 *
 * A missing or non-string `url` is a malformed request (`-32602`): the schema
 * declares it required, so the client broke the contract before the tool ever
 * ran. A `url` that is not http(s) is a *tool* error instead — the message is
 * for the human, and it is decided here, before any request reaches the
 * extension. That order is the whole point of the check on this side.
 */
async function navigateTool(id, params, { hub, log }) {
  const url = params.arguments?.url;
  if (typeof url !== "string") {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  // Everything apart from `url` and the optional `tab` is an argument the schema
  // forbids. Same precedence as `browser_status`: a message for the client, not a
  // protocol error, because the request itself was well-formed.
  if (!hasDeclaredTabArgument(params.arguments)) {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (hasUndeclaredArgument(params.arguments, NAVIGATE_ARGUMENTS)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[BROWSER_NAVIGATE]);
  }

  if (!isHttpUrl(url)) {
    return toolError(id, TOOL_TEXTS.INVALID_URL);
  }

  try {
    const result = await hub.request(
      PROTOCOL.METHODS.NAVIGATE,
      withOptionalTab({ url }, params.arguments.tab),
    );
    return textResultMessage(id, result);
  } catch (error) {
    return toolError(id, failureTextFor(BROWSER_NAVIGATE, error, log));
  }
}

/**
 * `tools/call` for `browser_open_tab`.
 *
 * The same order as `navigateTool` — missing or non-string `url` first (`-32602`),
 * undeclared keys second (the tool's own sentence), the http(s) rule third —
 * because this is `navigate` without a tab to fall back on: the extension creates a
 * new agent tab and answers its id.
 *
 * No `tab` here, deliberately: the tab this call addresses does not exist until the
 * call returns.
 */
async function openTabTool(id, params, { hub, log }) {
  const url = params.arguments?.url;
  if (typeof url !== "string") {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (hasUndeclaredArgument(params.arguments, OPEN_TAB_ARGUMENTS)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[BROWSER_OPEN_TAB]);
  }

  if (!isHttpUrl(url)) {
    return toolError(id, TOOL_TEXTS.INVALID_URL);
  }

  try {
    return textResultMessage(id, await hub.request(PROTOCOL.METHODS.OPEN_TAB, { url }));
  } catch (error) {
    return toolError(id, failureTextFor(BROWSER_OPEN_TAB, error, log));
  }
}

/**
 * `tools/call` for `browser_click`.
 *
 * Same order as `navigateTool`: a missing or non-string `selector` is a malformed
 * request (`-32602`), because the schema declares it required. An *empty* string
 * is not malformed — it goes to the page, where `querySelector` decides and
 * answers `invalid_selector`. The bridge has no opinion on selector syntax.
 */
async function clickTool(id, params, { hub, log }) {
  const args = params.arguments ?? {};
  const selector = args.selector;
  if (typeof selector !== "string") {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  // The frame filter of spec 26: type only, like every other key — the `minLength: 1` of the
  // schema is the contract, and the empty substring travels to the extension, which refuses
  // it with `invalid_params` before anything is injected.
  if (args.frame !== undefined && typeof args.frame !== "string") {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  // Everything apart from `selector`, the optional `frame` and the optional `tab` is an
  // argument the schema forbids. Checked before the request leaves, so a refused call never
  // reaches the extension. A `tab` of the wrong type is a malformed request, not a tool
  // sentence: the schema says `integer`, and the client broke it first.
  if (!hasDeclaredTabArgument(args)) {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (hasUndeclaredArgument(args, CLICK_ARGUMENTS)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[BROWSER_CLICK]);
  }

  // The request params are also what the failure sentences are built from: the
  // extension answers a code, and the sentence needs the selector it refused. The
  // payload is built by hand, so `frame` has to be copied here as well: a key the schema
  // declares but this line forgets would fall out silently — no error, no sentence, just
  // a click that quietly lands in the main frame. Set only when the caller set it, so a
  // call without a frame puts no key on the wire at all.
  const payload = { selector };
  if (args.frame !== undefined) payload.frame = args.frame;
  const requestParams = withOptionalTab(payload, args.tab);
  try {
    return textResultMessage(id, await hub.request(PROTOCOL.METHODS.CLICK, requestParams));
  } catch (error) {
    return toolError(id, failureTextFor(BROWSER_CLICK, error, log, requestParams));
  }
}

/**
 * `tools/call` for `browser_type`.
 *
 * Four checks before the request leaves, in this order: `selector` and `text`
 * must be strings (`-32602`, the schema declares both required — and `""` is a
 * string, so emptying a field stays allowed), `submit` may be absent but must be
 * a boolean if present, `frame` may be absent but must be a string if present, and
 * every other key is an argument the schema forbids.
 *
 * The `submit` check is the interesting one: without it a `"true"` would travel
 * to the extension, come back as a refusal, and the operator would read "the
 * extension could not run this request" — blaming the wrong side of the wire for
 * a client mistake.
 */
async function typeTool(id, params, { hub, log }) {
  const args = params.arguments ?? {};
  const selector = args.selector;
  const text = args.text;
  if (typeof selector !== "string" || typeof text !== "string") {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  const submit = args.submit;
  if (submit !== undefined && typeof submit !== "boolean") {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  // The frame filter of spec 26: type only, the same split as everywhere else — an empty
  // substring travels and is refused by the extension, which is the side that knows what
  // `includes("")` would mean.
  if (args.frame !== undefined && typeof args.frame !== "string") {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (!hasDeclaredTabArgument(args)) {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (hasUndeclaredArgument(args, TYPE_ARGUMENTS)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[BROWSER_TYPE]);
  }

  // The missing `submit` means "no Enter", and it is filled in here rather than in
  // the extension: the wire format documents `false` as the default, and a request
  // that names all three keys is easier to read in a log. `frame` stays out when the
  // caller named none — same rule, same reason as in `clickTool`.
  const payload = { selector, text, submit: submit ?? false };
  if (args.frame !== undefined) payload.frame = args.frame;
  const requestParams = withOptionalTab(payload, args.tab);
  try {
    return textResultMessage(id, await hub.request(PROTOCOL.METHODS.TYPE, requestParams));
  } catch (error) {
    return toolError(id, failureTextFor(BROWSER_TYPE, error, log, requestParams));
  }
}

/**
 * `tools/call` for `browser_inspect`.
 *
 * Three checks before the request leaves, in the order `typeTool` established: the
 * declared type of every key (`-32602`, because the schema states it), the keys the
 * schema forbids (the tool's own sentence), and the one rule the schema cannot
 * state — at least one of `selector`/`text`.
 *
 * The `limit` range is not checked here on purpose. 1–200 belongs to the extension,
 * which refuses anything else with `invalid_params`; a copy in the bridge would be a
 * second opinion with its own drift.
 */
async function inspectTool(id, params, { hub, log }) {
  const args = params.arguments ?? {};
  if (!hasDeclaredInspectArgumentTypes(args)) {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (hasUndeclaredArgument(args, INSPECT_ARGUMENTS)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[BROWSER_INSPECT]);
  }

  // Refused here rather than by the extension: the sentence can name the two
  // arguments, and a call with nothing to search for must not reach the page.
  if (args.selector === undefined && args.text === undefined) {
    return toolError(id, TOOL_TEXTS.INSPECT_NEEDS_FILTER);
  }

  // Only the keys the caller actually set: the extension fills `limit` and
  // `includeHidden` with its defaults, and a request that named them would make the
  // hub's log line claim a limit nobody asked for.
  const requestParams = {};
  for (const key of INSPECT_ARGUMENTS) {
    if (args[key] !== undefined) requestParams[key] = args[key];
  }

  try {
    return textResultMessage(id, await hub.request(PROTOCOL.METHODS.INSPECT, requestParams));
  } catch (error) {
    return toolError(id, failureTextFor(BROWSER_INSPECT, error, log, requestParams));
  }
}

/**
 * The types the `browser_inspect` schema declares, checked key by key.
 *
 * Absent is not wrong: every key is optional in the schema, and `limit` is only
 * required to be an *integer* — where its range ends is the extension's business.
 */
function hasDeclaredInspectArgumentTypes(args) {
  if (!isJsonObject(args)) return false;
  if (args.selector !== undefined && typeof args.selector !== "string") return false;
  if (args.text !== undefined && typeof args.text !== "string") return false;
  if (args.limit !== undefined && !Number.isInteger(args.limit)) return false;
  if (args.includeHidden !== undefined && typeof args.includeHidden !== "boolean") return false;
  // Type only, like every other key here: the `minLength: 1` of the schema is the
  // contract, and an empty substring travels to the extension, which refuses it with
  // `invalid_params` before anything is injected.
  if (args.frame !== undefined && typeof args.frame !== "string") return false;
  return hasDeclaredTabArgument(args);
}

/**
 * The types the `browser_read` schema declares, checked key by key.
 *
 * Absent is not wrong: every key is optional. The two window parameters are only
 * required to be an *integer* — where their ranges end is the extension's business,
 * exactly the split `hasDeclaredInspectArgumentTypes` makes for `limit`. `mode` is only
 * required to be a *string*, never one of the two values the schema lists: which modes
 * exist is the extension's rule, and a copy of it here would be a second list with its
 * own drift.
 */
function hasDeclaredReadArgumentTypes(args) {
  if (!isJsonObject(args)) return false;
  if (args.offset !== undefined && !Number.isInteger(args.offset)) return false;
  if (args.maxChars !== undefined && !Number.isInteger(args.maxChars)) return false;
  if (args.mode !== undefined && typeof args.mode !== "string") return false;
  // Type only, like `mode`: the `minLength: 1` of the schema is the contract, and the
  // empty string travels to the extension, which refuses it with `invalid_params`
  // before anything is injected — the same split as every other range in this file.
  if (args.frame !== undefined && typeof args.frame !== "string") return false;
  return hasDeclaredTabArgument(args);
}

/**
 * The types the `browser_transcript` schema declares, checked key by key.
 *
 * Two keys fewer than `hasDeclaredReadArgumentTypes` — no `mode`, no `frame` — and the
 * same rule for the window: an *integer* is all the bridge asks, where the range ends is
 * the extension's business.
 */
function hasDeclaredTranscriptArgumentTypes(args) {
  if (!isJsonObject(args)) return false;
  if (args.offset !== undefined && !Number.isInteger(args.offset)) return false;
  if (args.maxChars !== undefined && !Number.isInteger(args.maxChars)) return false;
  return hasDeclaredTabArgument(args);
}

/**
 * `tools/call` for `browser_eval`: the code body, an optional `frame` and `tab`, and
 * the method of the same name.
 *
 * Two checks before the request leaves: the declared type of `code` (`-32602`,
 * because the schema states it as a string) and the keys the schema forbids — the
 * same order the other tools use. What is *not* checked here is deliberate: the
 * length of the code and the switch behind it belong to the extension, and a second
 * opinion in the bridge would be a rule with its own drift. An empty code travels
 * too, and comes back as the extension's `invalid_params` with its own sentence.
 */
async function evalTool(id, params, { hub, log }) {
  const args = params.arguments ?? {};
  if (!hasDeclaredEvalArgumentTypes(args)) {
    return errorMessage(id, ERRORS.INVALID_PARAMS);
  }

  if (hasUndeclaredArgument(args, EVAL_ARGUMENTS)) {
    return toolError(id, UNEXPECTED_ARGUMENTS[BROWSER_EVAL]);
  }

  // The payload is built by hand, so `frame` has to be copied here as well: a key the
  // schema declares but this line forgets would fall out silently — no error, no
  // sentence, just a call that quietly runs in the main frame. Set only when the caller
  // set it, so an `eval` without a frame puts no key on the wire at all.
  const payload = { code: args.code };
  if (args.frame !== undefined) payload.frame = args.frame;
  const requestParams = withOptionalTab(payload, args.tab);

  try {
    return textResultMessage(id, await hub.request(PROTOCOL.METHODS.EVAL, requestParams));
  } catch (error) {
    return toolError(id, failureTextFor(BROWSER_EVAL, error, log, requestParams));
  }
}

/**
 * The single required key of the `browser_eval` schema, checked for its type.
 *
 * A missing `code` lands in the `false` as well: the schema requires it, and a call
 * without it has nothing to run — the protocol error is the honest answer, not a
 * sentence about a body nobody sent.
 */
function hasDeclaredEvalArgumentTypes(args) {
  if (!isJsonObject(args)) return false;
  if (typeof args.code !== "string") return false;
  // Type only, the same split `hasDeclaredReadArgumentTypes` makes: `minLength` is the
  // schema's statement, and the extension refuses the empty substring with
  // `invalid_params` before a page is touched.
  if (args.frame !== undefined && typeof args.frame !== "string") return false;
  return hasDeclaredTabArgument(args);
}

/**
 * The same rule the extension applies, checked a second time before the request
 * leaves the bridge. A relative value throws and lands in the `false`.
 */
function isHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Missing arguments and `{}` are the same thing; anything else is not.
 *
 * `typeof null === "object"`, hence the explicit object check: `{"arguments":
 * null}` is a client that wanted to send something, and the schema says there is
 * nothing to send.
 *
 * `allowedArguments` is what the tool's schema declares: nothing for `status`,
 * `TAB_ARGUMENTS` for `focus`, `close_tab`, `screenshot` and `frames`.
 */
function hasNoArguments(args, allowedArguments = NO_ARGUMENTS) {
  if (args === undefined) return true;
  if (!isJsonObject(args)) return false;
  return !hasUndeclaredArgument(args, allowedArguments);
}

/**
 * True when `args` carries a key its schema does not declare — the argument-side
 * half of `additionalProperties: false`.
 *
 * The tools with a required argument check it themselves and call this afterwards,
 * so the key that is already proven to be a string is in their `declaredArguments`
 * list too.
 */
function hasUndeclaredArgument(args, declaredArguments) {
  return Object.keys(args).some((key) => !declaredArguments.includes(key));
}

/**
 * `tab` is optional everywhere it appears; when it is there it must be the positive
 * integer the schema declares. `null` and `{"31": …}` are wrong types, not "absent":
 * the extension answers `invalid_params` for both, and a wrong call is worth refusing
 * before it costs a round trip.
 */
function hasDeclaredTabArgument(args) {
  const tab = args?.[TAB_ARGUMENT];
  return tab === undefined || (Number.isInteger(tab) && tab >= 1);
}

/**
 * The request payload with `tab` added when — and only when — the caller sent one.
 *
 * Shared by the tools whose payload is their declared arguments plus an optional `tab`:
 * sending `tab: undefined` would put the key on the wire, and the hub's `read tab=…`
 * line would then claim a tab nobody asked for. `read` builds its payload in schema
 * order by itself, because it has more than one optional key.
 */
function withOptionalTab(params, tab) {
  return tab === undefined ? params : { ...params, tab };
}

/**
 * Maps a `HubRequestError` name onto the sentence the operator reads. The names
 * are the documented discriminator, so a name-based switch is the contract, not
 * a shortcut. Anything else is a bridge bug: logged, and still answered as a
 * tool error — a throw would end the session and a protocol error would hide
 * the text from the human.
 *
 * `params` is for the tools whose sentences quote a request field (`click` and
 * `type` name the selector). The other tools pass nothing and are answered as
 * before, so this fourth parameter is an addition, not a change. `error.details`
 * travels the same way: an extension that says nothing about the page leaves it
 * empty, and the sentence stays the one it always was.
 */
function failureTextFor(toolName, error, log, params = {}) {
  switch (error?.name) {
    case "ExtensionUnavailable":
      return TOOL_TEXTS.NO_EXTENSION;
    case "ExtensionTimeout":
      return TOOL_TEXTS.NO_ANSWER;
    case "ExtensionError":
      // `?? {}` and not a bare `error.details`: the hub forwards what the peer sent,
      // and a peer that answers `error: null` must not turn a refusal into a throw.
      return extensionFailureText(toolName, error.code, params, error.details ?? {});
    default:
      log(`tool ${toolName} failed: ${error?.message ?? error}`);
      return TOOL_TEXTS.BRIDGE_FAILED;
  }
}

/**
 * What an `ok:false` from the extension reads like. A refused URL gets the same
 * sentence as the bridge's own refusal, so the operator cannot tell — and does
 * not need to — which of the two floors caught it. `read` and `click` have codes
 * of their own, because "open a tab first", "this page cannot be read" and "that
 * selector matches nothing" are advice, not a failure of the extension.
 *
 * `details` is the extension's word on the refusal: `url`/`kind` for the unreadable
 * page, `message` wherever a sentence has room for the extension's own words (`read`'s
 * `offset_out_of_range` and `invalid_params`, `eval_failed`, the screenshot codes,
 * `transcript_needs_focus` and `transcript_failed`). A sentence without such a place
 * ignores what it cannot use.
 */
function extensionFailureText(toolName, code, params = {}, details = {}) {
  // The filter's two codes stand above every tool branch: they are the same verdict on
  // the same page, whichever tool asked — `read` since spec 24, `inspect` and `eval`
  // since spec 25, and the same pair will answer for `click` and `type`. Both sentences
  // name the next step, so they are worth no per-tool copy.
  if (code === FRAME_NOT_FOUND_CODE) return frameNotFoundText(details);
  if (code === FRAME_AMBIGUOUS_CODE) return frameAmbiguousText(details);
  if (toolName === BROWSER_NAVIGATE) {
    return code === INVALID_URL_CODE
      ? TOOL_TEXTS.INVALID_URL
      : TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  if (toolName === BROWSER_READ) {
    if (code === INVALID_PARAMS_CODE) return invalidReadParamsText(details);
    if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
    if (code === NOT_READABLE_CODE) return notReadableText(details);
    if (code === PAGE_BUSY_CODE) return TOOL_TEXTS.PAGE_BUSY;
    if (code === OFFSET_OUT_OF_RANGE_CODE) return offsetOutOfRangeText(details);
    return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  // Without this branch every click code would fall through to the `status`
  // sentence, which names the wrong action. `not_readable`/`read_failed` are
  // answered exactly like `read` answers them: they are more telling than a
  // catch-all code.
  if (toolName === BROWSER_CLICK) {
    if (code === INVALID_SELECTOR_CODE) return TOOL_TEXTS.INVALID_SELECTOR(params.selector);
    if (code === NO_MATCH_CODE) return TOOL_TEXTS.NO_MATCH(params.selector);
    if (code === NOT_CLICKABLE_CODE) return TOOL_TEXTS.NOT_CLICKABLE(params.selector);
    if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
    if (code === NOT_READABLE_CODE) return notReadableText(details);
    if (code === PAGE_BUSY_CODE) return TOOL_TEXTS.PAGE_BUSY;
    return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  // `type` repeats the selector sentences of `click` and adds the two that are
  // specific to writing: the element takes no text, or a password field is locked.
  // `type_failed` and `superseded` keep the generic sentence with their code — the
  // operator cannot act on either, and inventing advice for them would be a guess.
  if (toolName === BROWSER_TYPE) {
    if (code === INVALID_SELECTOR_CODE) return TOOL_TEXTS.INVALID_SELECTOR(params.selector);
    if (code === NO_MATCH_CODE) return TOOL_TEXTS.NO_MATCH(params.selector);
    if (code === NOT_TYPEABLE_CODE) return TOOL_TEXTS.NOT_TYPEABLE(params.selector);
    if (code === PASSWORD_NOT_ALLOWED_CODE) return TOOL_TEXTS.PASSWORD_NOT_ALLOWED;
    if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
    if (code === NOT_READABLE_CODE) return notReadableText(details);
    if (code === PAGE_BUSY_CODE) return TOOL_TEXTS.PAGE_BUSY;
    return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  // `focus` has no code of its own that the operator could act on: "no agent tab
  // yet" is advice, everything else (`focus_failed`, a timeout code) keeps its code
  // in the generic sentence. A closed window is not one of these: the extension
  // answers that as `ok:true` with `focused:false`, because the tab is already
  // forward. `focus_failed` is only the throwing `tabs.update`.
  if (toolName === BROWSER_FOCUS) {
    if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
    return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  if (toolName === BROWSER_INSPECT) return inspectFailureTextFor(code, params, details);
  // `open_tab` has exactly one code of its own: the fifth tab is the limit, and the
  // sentence names the only way out of it. Everything else (`invalid_url` included)
  // keeps its code in the generic sentence.
  if (toolName === BROWSER_OPEN_TAB) {
    if (code === TOO_MANY_TABS_CODE) return TOOL_TEXTS.TOO_MANY_TABS;
    return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  // `close_tab` adds no code: a foreign or already-gone id is `no_agent_tab`, which
  // is the same advice `read` gives, and `browser_navigate` is the call that fixes
  // it. Anything else keeps its code in the generic sentence.
  if (toolName === BROWSER_CLOSE_TAB) {
    if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
    return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  if (toolName === BROWSER_EVAL) return evalFailureTextFor(code, details);
  if (toolName === BROWSER_SCREENSHOT) return screenshotFailureTextFor(code, details);
  // `browser_frames` inherits `read`'s three refusals and nothing else: the list is an
  // inventory *of a page*, so "no agent tab yet", "still loading" and "cannot be read"
  // are the same advice `read` gives — and the same sentences. Without this branch all
  // three would fall through to the `status` sentence, which names the wrong action.
  // `frames_failed` (an injection whose answer has no usable shape) keeps its code in
  // the generic sentence: the operator can act on it no more than on `read_failed`.
  if (toolName === BROWSER_FRAMES) {
    if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
    if (code === NOT_READABLE_CODE) return notReadableText(details);
    if (code === PAGE_BUSY_CODE) return TOOL_TEXTS.PAGE_BUSY;
    return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  // `browser_transcript` reads a page, so "no agent tab yet", the two injection refusals
  // and the two window codes are `read`'s answers — the extension checks `offset`/`maxChars`
  // with the same helper for both tools, and `offset_out_of_range` carries the same
  // `totalChars` the caller pages by. The three codes of its own name the page, the focus
  // gate and the missing caption track; without this branch all of them would fall through to the `status`
  // sentence, which names the wrong action.
  // `transcript_needs_focus` keeps the extension's `message`: only the page side reads
  // `visibilityState`, and "visible but hydrating" needs different advice than "hidden"
  // (spec 32, criterion 5).
  if (toolName === BROWSER_TRANSCRIPT) {
    if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
    if (code === NOT_READABLE_CODE) return notReadableText(details);
    if (code === PAGE_BUSY_CODE) return TOOL_TEXTS.PAGE_BUSY;
    if (code === INVALID_PARAMS_CODE) return invalidReadParamsText(details);
    if (code === OFFSET_OUT_OF_RANGE_CODE) return offsetOutOfRangeText(details);
    if (code === TRANSCRIPT_FAILED_CODE) return transcriptFailedText(details);
    if (code === TRANSCRIPT_NEEDS_FOCUS_CODE) return transcriptNeedsFocusText(details);
    if (code === NO_TRANSCRIPT_PANEL_CODE) return TOOL_TEXTS.NO_TRANSCRIPT_PANEL;
    return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
  }
  return TOOL_TEXTS.STATUS_EXTENSION_FAILED(code ?? "unknown");
}

/**
 * The sentence for an unreadable page, built from the facts the extension could add:
 * `kind`, `url` and `contentType`.
 *
 * Nothing usable means the old sentence, word for word. A `url` without a usable
 * `kind` still names the address — the address is worth more than a type nobody
 * knows. A `kind` outside the whitelist is dropped on the floor: it is a string from
 * another process, and this sentence goes into a chat window. The `contentType` gets
 * no such whitelist and only has to be a non-empty string — a media type has no
 * closed set, and a made-up one names a media type that does not exist at worst.
 */
function notReadableText(details) {
  const url = nonEmptyString(details?.url);
  if (url === null) return TOOL_TEXTS.NOT_READABLE;

  const kind = nonEmptyString(details?.kind);
  const contentType = nonEmptyString(details?.contentType);
  const namedKind = NOT_READABLE_KINDS.includes(kind) && kind !== "unknown" ? kind : null;
  if (contentType !== null) {
    return namedKind === null
      ? TOOL_TEXTS.NOT_READABLE_WITH_TYPE(contentType, url)
      : TOOL_TEXTS.NOT_READABLE_WITH_KIND_AND_TYPE(namedKind, contentType, url);
  }
  if (namedKind === null) return TOOL_TEXTS.NOT_READABLE_WITH_URL(url);
  return TOOL_TEXTS.NOT_READABLE_WITH_KIND(namedKind, url);
}

/** The value itself when it is a non-empty string, `null` for everything else. */
function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The sentence for an `offset` behind the text's end, with the length the extension
 * sent when there is one.
 *
 * The length is the point of this code: it is what the caller pages by, and it only
 * ever lived in the page. No usable message means the plain sentence — the extension's
 * message is the only place a number may come from, and inventing one here would be a
 * second measurement of a text the bridge never saw.
 */
function offsetOutOfRangeText(details) {
  const message = nonEmptyString(details?.message);
  return message === null
    ? TOOL_TEXTS.OFFSET_OUT_OF_RANGE
    : TOOL_TEXTS.OFFSET_OUT_OF_RANGE_WITH_MESSAGE(message);
}

/**
 * The sentence for `transcript_needs_focus`, with the extension's own message when there
 * is one.
 *
 * The message is not decoration: the extension is the only side that reads
 * `document.visibilityState`, and the two shapes of this refusal need opposite advice.
 * A hidden tab needs `browser_focus`; a visible tab that is still hydrating must not be
 * focused again, or the agent loops forever on the very sentence that was meant to stop
 * it (spec 32, criterion 5). Dropping the message would leave the caller with the first
 * advice only. A message that is not a usable string means the plain sentence.
 */
function transcriptNeedsFocusText(details) {
  const message = nonEmptyString(details?.message);
  return message === null
    ? TOOL_TEXTS.TRANSCRIPT_NEEDS_FOCUS
    : TOOL_TEXTS.TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE(message);
}

/**
 * The sentence for `transcript_failed`, with the extension's own reason when there is one.
 *
 * The extension refuses this code for several distinguishable situations — an original
 * audiotrack list that is not unique, an original track that points at no caption track,
 * an ambiguous English track, a missing player model, a missing track file, an unreadable
 * one, and the player menu's own refusals (no row, a miscount, no exact name, an ambiguous
 * name, a click that did not take effect) — and the plain sentence above describes none of
 * them: on a watch page it is simply false. The reason only ever comes from the side that
 * saw the page, so no usable message means the plain sentence, never a guessed one
 * (spec 33, criterion 14).
 */
function transcriptFailedText(details) {
  const message = nonEmptyString(details?.message);
  return message === null
    ? TOOL_TEXTS.TRANSCRIPT_FAILED
    : TOOL_TEXTS.TRANSCRIPT_FAILED_WITH_MESSAGE(message);
}

/**
 * The sentence for a `read` the extension refused as `invalid_params`, with its own
 * message when there is one.
 *
 * Built like `offsetOutOfRangeText` and for the same reason: the extension is the side
 * that knows which field is wrong and which bounds apply, and this sentence is the only
 * place that news can reach the caller. A message that is not a usable string means the
 * plain sentence — the bridge never range-checks the window it would otherwise blame.
 */
function invalidReadParamsText(details) {
  const message = nonEmptyString(details?.message);
  return message === null
    ? TOOL_TEXTS.INVALID_READ_PARAMS
    : TOOL_TEXTS.INVALID_READ_PARAMS_WITH_MESSAGE(message);
}

/**
 * The sentence for a `frame` substring no frame answered to, with the count when the
 * extension sent a usable one.
 *
 * The count is not decoration: a frame that never answered (a hung embed) is missing
 * from it, and the caller learns that "no frame matched" and "nobody was listening" are
 * two different situations. No usable number means the shorter sentence — the bridge
 * never counts frames it cannot see.
 */
function frameNotFoundText(details) {
  const count = details?.frames;
  return Number.isInteger(count) && count >= 0
    ? TOOL_TEXTS.FRAME_NOT_FOUND_WITH_COUNT(count)
    : TOOL_TEXTS.FRAME_NOT_FOUND;
}

/**
 * The sentence for an ambiguous `frame`, naming the addresses that collided.
 *
 * The candidates are the whole value of this code: the caller has to answer the same
 * substring differently, and only the addresses say how. The list is cut again here —
 * the extension caps it at five, and this sentence goes into a chat window, so a
 * second cap on the side that formats is the honest place for a display limit.
 * Without a usable address the shorter sentence stands; inventing one is not an option.
 */
function frameAmbiguousText(details) {
  const candidates = frameCandidatesOf(details?.candidates);
  return candidates.length === 0
    ? TOOL_TEXTS.FRAME_AMBIGUOUS
    : TOOL_TEXTS.FRAME_AMBIGUOUS_WITH_CANDIDATES(candidates);
}

/** The non-empty strings of a candidate list, at most `FRAME_CANDIDATE_LIMIT` of them. */
function frameCandidatesOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => nonEmptyString(entry) !== null)
    .slice(0, FRAME_CANDIDATE_LIMIT);
}

/**
 * What an `ok:false` from an `inspect` call reads like.
 *
 * Its own function, because the sentences are assembled from the request rather
 * than from the tool: `invalid_selector` has to name the selector the caller sent,
 * while `invalid_params` deliberately names no field at all. `inspect_failed` (an
 * injection whose answer had no usable shape) and every unknown code keep their
 * code in the generic sentence — the operator can act on neither. `not_readable`
 * is answered with the same builder `read` uses: one page, one sentence, whichever
 * tool walked into it.
 */
function inspectFailureTextFor(code, params = {}, details = {}) {
  if (code === INVALID_PARAMS_CODE) return TOOL_TEXTS.INVALID_INSPECT_PARAMS;
  if (code === INVALID_SELECTOR_CODE) return TOOL_TEXTS.INVALID_SELECTOR(params.selector);
  if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
  if (code === NOT_READABLE_CODE) return notReadableText(details);
  if (code === PAGE_BUSY_CODE) return TOOL_TEXTS.PAGE_BUSY;
  return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
}

/**
 * The sentence for code that threw in the agent tab, with the page's own message
 * when there is one.
 *
 * The message is the entire value of this code: "the code failed" tells an agent
 * nothing it cannot read off its own snippet, while "Cannot read properties of null"
 * names the mistake. The extension cuts that message to `EVAL_MESSAGE_LIMIT` characters
 * before it leaves the page and never reads the stack, so a second limit here would
 * only re-cut a fact the extension already decided is safe to print.
 *
 * No usable message — absent, empty, not a string — means the old sentence word for
 * word. A dangling `: ` behind it would be worse than the general sentence.
 */
function evalFailedText(details) {
  const message = nonEmptyString(details?.message);
  return message === null ? TOOL_TEXTS.EVAL_FAILED : TOOL_TEXTS.EVAL_FAILED_WITH_MESSAGE(message);
}

/**
 * What an `ok:false` from an `eval` call reads like.
 *
 * Its own function because the tool has five codes of its own *and* inherits the
 * four of the page triangle — `eval` walks into the same injection `read` does, so
 * `no_agent_tab`, `page_busy` and `not_readable` mean here exactly what they mean
 * there, down to the sentence. A generic `code=…` for those would tell the caller
 * less than `read` already says about the same page.
 *
 * Unknown codes keep the generic sentence: `superseded` cannot happen (there is no
 * slot) and anything else is a fact the bridge cannot turn into advice.
 */
function evalFailureTextFor(code, details = {}) {
  if (code === EVAL_NOT_ALLOWED_CODE) return TOOL_TEXTS.EVAL_NOT_ALLOWED;
  if (code === EVAL_FAILED_CODE) return evalFailedText(details);
  if (code === EVAL_TIMEOUT_CODE) return TOOL_TEXTS.EVAL_TIMEOUT;
  if (code === EVAL_RESULT_TOO_LARGE_CODE) return TOOL_TEXTS.EVAL_RESULT_TOO_LARGE;
  if (code === EVAL_RESULT_UNSERIALIZABLE_CODE) return TOOL_TEXTS.EVAL_RESULT_UNSERIALIZABLE;
  if (code === INVALID_PARAMS_CODE) return TOOL_TEXTS.INVALID_EVAL_PARAMS;
  if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
  if (code === NOT_READABLE_CODE) return notReadableText(details);
  if (code === PAGE_BUSY_CODE) return TOOL_TEXTS.PAGE_BUSY;
  return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
}

/**
 * What an `ok:false` from a `screenshot` call reads like.
 *
 * Its own function because the tool's three codes carry more than a word: the two
 * that take a message read it here, and the third names the switch the operator has
 * to flip. The two message-carrying codes get the message through
 * `screenshotMessageText`, so a case with an absent, empty or non-string `message`
 * falls back to the plain sentence instead of leaving a dangling `: `.
 *
 * `no_agent_tab` is inherited and answered like everywhere else; `page_busy` and
 * `not_readable` are not on this list on purpose — `captureTab` injects no script,
 * so the extension never answers them and a sentence for them would be advice about
 * a failure that cannot happen.
 */
function screenshotFailureTextFor(code, details = {}) {
  if (code === SCREENSHOT_NOT_ALLOWED_CODE) return TOOL_TEXTS.SCREENSHOT_NOT_ALLOWED;
  if (code === SCREENSHOT_FAILED_CODE) {
    return screenshotMessageText(details, TOOL_TEXTS.SCREENSHOT_FAILED, TOOL_TEXTS.SCREENSHOT_FAILED_WITH_MESSAGE);
  }
  if (code === SCREENSHOT_TOO_LARGE_CODE) {
    return screenshotMessageText(details, TOOL_TEXTS.SCREENSHOT_TOO_LARGE, TOOL_TEXTS.SCREENSHOT_TOO_LARGE_WITH_MESSAGE);
  }
  if (code === INVALID_PARAMS_CODE) return TOOL_TEXTS.INVALID_SCREENSHOT_PARAMS;
  if (code === NO_AGENT_TAB_CODE) return TOOL_TEXTS.NO_AGENT_TAB;
  return TOOL_TEXTS.CALL_EXTENSION_FAILED(code ?? "unknown");
}

/**
 * `generic` when the extension sent no usable `message`, the assembled sentence
 * otherwise.
 *
 * Two codes of `screenshot` carry a measurement or a browser message, and both are
 * optional on the wire. The `nonEmptyString` gate is what keeps an empty string from
 * turning the sentence into half a sentence with a colon hanging off its end.
 */
function screenshotMessageText(details, generic, withMessage) {
  const message = nonEmptyString(details?.message);
  return message === null ? generic : withMessage(message);
}

function toolError(id, text) {
  return resultMessage(id, { content: [{ type: "text", text }], isError: true });
}

function initializeResult(params) {
  return {
    protocolVersion: protocolVersionFor(params?.protocolVersion),
    capabilities: { tools: { listChanged: false } },
    serverInfo: { ...SERVER_INFO },
  };
}

function protocolVersionFor(requested) {
  return KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL_VERSION;
}

function resultMessage(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function errorMessage(id, { code, message }) {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
