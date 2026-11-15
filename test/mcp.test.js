/**
 * The bridge as an MCP server: JSON-RPC over the child's stdin/stdout.
 *
 * In-process module tests would prove the framing code, not the contract. The
 * contract is the process: pi starts `bridge/bridge.mjs`, writes lines to its
 * stdin and parses stdout. So this file spawns the real entry point and talks to
 * it the way the client does — including the part that matters most, that stdout
 * carries nothing but protocol.
 *
 * Unlike the helpers in `test/bridge.test.js`, the child here gets
 * `stdin: "pipe"` instead of `"ignore"`: with `"ignore"` the child's `stdin` is
 * `null` in the parent and every write would throw. The `"ignore"` case is the
 * counter-case for the lifecycle stage.
 *
 * One named exception: the window cases of `browser_read` (`offset`/`maxChars`) call the
 * exported `handleMessageText` with a recording hub instead of spawning the bridge. What
 * they prove is *which arguments* the tool layer puts on the wire, and the fixture cannot
 * show that — its stderr line carries only `tab`, and widening it would break the
 * `tab=(\d+)$` suffix the `requestedTabs` helper matches. Every sentence and every schema
 * still travels through the real process; only the pass-through of the window is proved
 * one layer in, where it is decided.
 *
 * The port is this file's reserved one from `test/ports.js`, never a searched
 * one: a search loop hides the collision one needs to see (docs/18, "feste
 * Ports, keine Suche").
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { PROTOCOL } from "../bridge/protocol.mjs";
// The named exception to this file's spawn-a-process rule — see the header comment.
import { handleMessageText } from "../bridge/mcp.mjs";
import {
  CLICK_RESULT,
  CLOSE_TAB_RESULT,
  EVAL_RESULT,
  FOCUS_RESULT,
  FRAMES_RESULT,
  INSPECT_RESULT,
  NAVIGATE_RESULT,
  OPEN_TAB_RESULT,
  READ_RESULT,
  SCREENSHOT_RESULT,
  STATUS_RESULT,
  TRANSCRIPT_RESULT,
  TYPE_RESULT,
} from "./fixtures/fake-extension.mjs";
import { MCP_FIXTURE } from "./ports.js";

const BRIDGE_PATH = path.resolve(import.meta.dirname, "../bridge/bridge.mjs");
const FAKE_EXTENSION_PATH = path.resolve(import.meta.dirname, "fixtures/fake-extension.mjs");

const EVENT_TIMEOUT_MS = 10_000;
// How long a bridge may take to accept its first connection. Not a retry
// budget: the spawn happens once, and the port is fixed.
const READY_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const PORT_POLL_INTERVAL_MS = 20;
// Long enough for a process that wrongly acts on an ignored stdin to die.
const IGNORED_STDIN_SETTLE_MS = 300;

// The fixture's own result, indented exactly as the tool text must be. A moving
// value anywhere in it would turn the comparison into a fuzzy one.
const INDENTED_RESULT = JSON.stringify(STATUS_RESULT, null, 2);
const INDENTED_NAVIGATE_RESULT = JSON.stringify(NAVIGATE_RESULT, null, 2);
const INDENTED_READ_RESULT = JSON.stringify(READ_RESULT, null, 2);
const INDENTED_CLICK_RESULT = JSON.stringify(CLICK_RESULT, null, 2);
const INDENTED_TYPE_RESULT = JSON.stringify(TYPE_RESULT, null, 2);
const INDENTED_FOCUS_RESULT = JSON.stringify(FOCUS_RESULT, null, 2);
const INDENTED_INSPECT_RESULT = JSON.stringify(INSPECT_RESULT, null, 2);
const INDENTED_OPEN_TAB_RESULT = JSON.stringify(OPEN_TAB_RESULT, null, 2);
const INDENTED_CLOSE_TAB_RESULT = JSON.stringify(CLOSE_TAB_RESULT, null, 2);
const INDENTED_EVAL_RESULT = JSON.stringify(EVAL_RESULT, null, 2);
// The nine fields a screenshot answer carries *beside* the picture: the same result
// without its `base64`. Rest destructuring, not a hand-written copy — a field that
// arrives in the fixture has to arrive in the text block, and the one that may not
// stays out without anybody remembering to remove it.
const { base64: SCREENSHOT_PICTURE, ...SCREENSHOT_METADATA } = SCREENSHOT_RESULT;
const SCREENSHOT_METADATA_TEXT = JSON.stringify(SCREENSHOT_METADATA, null, 2);

// The visible tool texts, quoted from the contract. Duplicated on purpose: a
// test that imports the sentence it checks cannot notice a changed sentence.
const TOOL_DESCRIPTION =
  "Zeigt die Fenster und Tabs des Betreiber-Browsers im Default-Container, samt Verbindungszustand der Extension, und markiert den Agenten-Tab mit `agent: true`.";
const NAVIGATE_TOOL_DESCRIPTION =
  "Öffnet eine http(s)-URL im Agenten-Tab des Betreiber-Browsers (Default-Container), wartet, bis die Seite geladen ist, und danach, bis sie sich beruhigt hat (höchstens 3 s); meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
const READ_TOOL_DESCRIPTION =
  "Liest Titel, Adresse und den Text des Agenten-Tabs; `offset` überspringt so viele Zeichen des Textes (Default 0), `maxChars` begrenzt den Ausschnitt (Default 20 000, höchstens 100 000). `offset`/`maxChars` blättern durch den Text; `chars` und `totalChars` sagen, wo man steht. `via` sagt, ob sichtbarer Text oder Textinhalt. `mode: article` liest nur den Artikelkörper — ohne Navigation, Fußzeile und Cookie-Banner. Wartet vorher, bis sich die Seite beruhigt hat (höchstens 3 s), und meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
const CLICK_TOOL_DESCRIPTION =
  "Klickt das erste Element, das dem CSS-Selektor entspricht, im Agenten-Tab, wartet, bis sich die Seite beruhigt hat (höchstens 3 s), und liefert den Seitentext danach (auf 20 000 Zeichen gekürzt); meldet `settled`/`waitedMs`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
const TYPE_TOOL_DESCRIPTION =
  "Schreibt Text in das Feld, das dem CSS-Selektor entspricht, sendet optional Enter und liefert den Seitentext danach (auf 20 000 Zeichen gekürzt). Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
const FOCUS_TOOL_DESCRIPTION =
  "Holt den Agenten-Tab nach vorn und sein Fenster in den Vordergrund; die Seite wird dabei nicht verändert, und `focused` kommt aus einer Abfrage nach dem Fokussieren. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
const INSPECT_TOOL_DESCRIPTION =
  "Listet die Elemente des Agenten-Tabs auf (per CSS-Selektor und/oder Textsuche) mit Tag, id, class, Link, sichtbarem Text, Sichtbarkeit und einem fertigen Selektor zum Weiterverwenden. `my-card >>> button` springt rechts vom `>>>` in den offenen Schattenbaum von `my-card` (mehrere Stufen erlaubt); jedes Glied ist ein einfacher Selektor — Typ, `#id`, `.class`, `[attr=\"wert\"]` oder `:nth-of-type(n)`; geschlossene Schattenbäume bleiben unerreichbar, und ohne `>>>` ändert sich nichts. Ändert nichts an der Seite. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
// The two tools of the tab management. Their descriptions are new, so they are not
// a changed pin — they are a pin like every other one.
const OPEN_TAB_TOOL_DESCRIPTION =
  "Öffnet einen weiteren Agenten-Tab im Default-Container (höchstens fünf) und liefert `tabId`, `url` und `title`. Wartet, bis die Seite geladen ist, aber nicht auf Ruhe — ein `browser_read` danach soll nicht `page_busy` kosten.";
const CLOSE_TAB_TOOL_DESCRIPTION =
  "Schließt einen Agenten-Tab und entfernt ihn aus der Liste; ohne `tab` den zuletzt benutzten. Liefert `tabId` und `closed`.";
// The description of the newest tool, quoted verbatim — including the German
// quotes and the backticked code it mentions. A tool that can change the page says
// so before the first call, so this string is part of the contract, not decoration.
// The `Funktionsrumpf` sentence is pinned word for word as well: it is the one place
// a caller learns that a bare expression answers `null` instead of its value.
const EVAL_TOOL_DESCRIPTION =
  "Wertet Code im Seitenkontext des Agenten-Tabs aus und liefert das Ergebnis als JSON; Code darf die Seite ändern, auch Passwortfelder füllen. `code` läuft als Funktionsrumpf: Das Ergebnis kommt mit `return` zurück, ohne `return` ist es `null`. Nur möglich, wenn „Code-Auswertung erlauben\" in den Einstellungen der Erweiterung eingeschaltet ist — sonst `eval_not_allowed`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
// The contract's own words for that one fact, lifted out of the string above: a
// wording that drops the `return` rule may not slip through a changed constant.
const EVAL_FUNCTION_BODY_SENTENCE = "`code` läuft als Funktionsrumpf";
// The description of the eleven-th tool, quoted verbatim. It carries what the caller
// needs to read the answer without decoding it: that the picture arrives as an image
// block, that the numbers stand in a text block beside it, and the size limit.
const SCREENSHOT_TOOL_DESCRIPTION =
  "Fotografiert den sichtbaren Ausschnitt des Agenten-Tabs und liefert das Bild als MCP-Bildinhalt (höchstens 3 MiB; PNG, bei Überschreiten verkleinert und als JPEG neu kodiert). Die Zahlen dazu — `format`, `width`, `height`, `bytes` und `scaled` — stehen als Textblock daneben. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
// The description of the twelfth tool, quoted verbatim. It names the vocabulary the
// other tools address a frame with — a list nobody can use is a list without that
// sentence, because `frame` is the only way to act inside a row of it.
const FRAMES_TOOL_DESCRIPTION =
  "Listet die Rahmen (iframes) des Agenten-Tabs mit ihrer Adresse; `frame` bei den anderen Werkzeugen nimmt einen Teilstring davon. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
// The description of the thirteenth tool, quoted verbatim. It is the only place a caller
// learns four things: the answer is *segments* from the video's caption track rather than a
// text band, the three language fields name the track and its file, the two window defaults
// are `read`'s (0 and 20 000), and the tab has to be in front before the call — without that
// last sentence the agent reads `transcript_needs_focus` as a broken tool.
const TRANSCRIPT_TOOL_DESCRIPTION =
  "Liest das Transkript des YouTube-Video-Tabs als Segmente mit Zeitstempel und Text aus der Untertitelspur des Videos — die Spur, die der Player selbst geladen hat, nicht die, die sein Panel gerade zeigt. `requestedLanguage` nennt die gewählte Spur, `deliveredLanguage` die Sprache der gelieferten Spurendatei, `source` den Ort, an dem das Datenmodell des Players gefunden wurde. `offset` überspringt so viele Zeichen der verketteten Segmenttexte (Default 0), `maxChars` begrenzt den Ausschnitt (Default 20 000, höchstens 100 000); `segments` enthält genau die Segmente dieses Fensters, `chars` und `totalChars` sagen, wo man steht, und `truncated` blättert weiter. Der Tab muss im Vordergrund sein — vorher browser_focus aufrufen, sonst antwortet das Werkzeug `transcript_needs_focus`. Mit `tab` genau diesen Tab, ohne `tab` den zuletzt benutzten.";
const NO_EXTENSION_TEXT =
  "Keine Extension verbunden — Firefox mit der Extension läuft nicht oder die Verbindung ist getrennt.";
const NO_ANSWER_TEXT = "Die Extension hat nicht geantwortet (Zeitüberschreitung).";
const UNEXPECTED_ARGUMENTS_TEXT = "browser_status erwartet keine Argumente.";
const NAVIGATE_UNEXPECTED_ARGUMENTS_TEXT = "browser_navigate erwartet nur `url` und `tab`.";
const READ_UNEXPECTED_ARGUMENTS_TEXT =
  "browser_read erwartet nur `offset`, `maxChars`, `mode`, `frame` und `tab`.";
const CLICK_UNEXPECTED_ARGUMENTS_TEXT = "browser_click erwartet nur `selector`, `frame` und `tab`.";
const TYPE_UNEXPECTED_ARGUMENTS_TEXT =
  "browser_type erwartet nur `selector`, `text`, `submit`, `frame` und `tab`.";
const FOCUS_UNEXPECTED_ARGUMENTS_TEXT = "browser_focus erwartet nur `tab`.";
const INSPECT_UNEXPECTED_ARGUMENTS_TEXT =
  "browser_inspect erwartet nur `selector`, `text`, `limit`, `includeHidden`, `frame` und `tab`.";
const OPEN_TAB_UNEXPECTED_ARGUMENTS_TEXT = "browser_open_tab erwartet nur `url`.";
const CLOSE_TAB_UNEXPECTED_ARGUMENTS_TEXT = "browser_close_tab erwartet nur `tab`.";
const EVAL_UNEXPECTED_ARGUMENTS_TEXT = "browser_eval erwartet nur `code`, `frame` und `tab`.";
const SCREENSHOT_UNEXPECTED_ARGUMENTS_TEXT = "browser_screenshot erwartet nur `tab`.";
const FRAMES_UNEXPECTED_ARGUMENTS_TEXT = "browser_frames erwartet nur `tab`.";
const TRANSCRIPT_UNEXPECTED_ARGUMENTS_TEXT =
  "browser_transcript erwartet nur `offset`, `maxChars` und `tab`.";
const INVALID_URL_TEXT = "Nur http:// und https:// sind erlaubt.";
const NO_AGENT_TAB_TEXT = "Kein Agenten-Tab — zuerst browser_navigate aufrufen.";
// The one sentence of the tab limit. Quoted here so a changed wording turns the case
// red — and spelled with the number as a word, like the contract has it.
const TOO_MANY_TABS_TEXT = "Es sind schon fünf Agenten-Tabs offen — erst einen schließen.";
const NOT_READABLE_TEXT = "Diese Seite kann die Extension nicht lesen (interne Seite oder Sonderformat).";
// The sentence for a page that is still loading. Quoted, not imported: a changed
// wording has to turn these four cases red. One constant for all four tools, because
// the contract gives them one sentence.
const PAGE_BUSY_TEXT = "Die Seite lädt noch — bitte gleich noch einmal versuchen.";
// The same news with the details the extension adds today. `BC_TEST_ERROR_DETAILS`
// carries them on the frame; one invented address, quoted into every sentence, so a
// changed wording turns the case red. The `quatsch` entry is the reason the bridge
// keeps a whitelist: a kind it does not know must lose its type, not gain a soapbox.
const NOT_READABLE_URL = "https://example.org/preisliste.pdf";
const NOT_READABLE_PDF_TEXT = `Diese Seite kann die Extension nicht lesen (Typ: pdf). Adresse: ${NOT_READABLE_URL}`;
const NOT_READABLE_WITHOUT_KIND_TEXT = `Diese Seite kann die Extension nicht lesen. Adresse: ${NOT_READABLE_URL}`;
// The type the server reported travels next to it, and it is *not* whitelisted: a
// media type has no closed set, so any non-empty string is printed. The bracket gains
// the kind only when the bridge knows the word, and the address stays last.
const NOT_READABLE_CONTENT_TYPE = "application/pdf";
const NOT_READABLE_PDF_WITH_TYPE_TEXT = `Diese Seite kann die Extension nicht lesen (Typ: pdf, Content-Type: application/pdf). Adresse: ${NOT_READABLE_URL}`;
const NOT_READABLE_WITH_TYPE_TEXT = `Diese Seite kann die Extension nicht lesen (Content-Type: application/pdf). Adresse: ${NOT_READABLE_URL}`;
const NOT_READABLE_DETAIL_CASES = [
  { caseName: "WithAKnownKind", details: { kind: "pdf", url: NOT_READABLE_URL }, sentence: NOT_READABLE_PDF_TEXT },
  {
    caseName: "WithAnUnknownKind",
    details: { kind: "unknown", url: NOT_READABLE_URL },
    sentence: NOT_READABLE_WITHOUT_KIND_TEXT,
  },
  {
    caseName: "WithAKindOutsideTheWhitelist",
    details: { kind: "quatsch", url: NOT_READABLE_URL },
    sentence: NOT_READABLE_WITHOUT_KIND_TEXT,
  },
  {
    caseName: "WithAKindAndAContentType",
    details: { kind: "pdf", url: NOT_READABLE_URL, contentType: NOT_READABLE_CONTENT_TYPE },
    sentence: NOT_READABLE_PDF_WITH_TYPE_TEXT,
  },
  {
    caseName: "WithAContentTypeButNoKind",
    details: { kind: "unknown", url: NOT_READABLE_URL, contentType: NOT_READABLE_CONTENT_TYPE },
    sentence: NOT_READABLE_WITH_TYPE_TEXT,
  },
];

// The one refusal that carries a measurement: the page's own message names the length of
// the whole text, and the tool text has to repeat it verbatim — a number invented here
// would be a second measurement of a text the bridge never saw. Spelled out like every
// sentence in this file, so a changed wording turns the case red.
const OFFSET_OUT_OF_RANGE_MESSAGE = "Der Text hat 87314 Zeichen; offset 999999 liegt dahinter.";
const OFFSET_OUT_OF_RANGE_TEXT = `Der \`offset\` liegt hinter dem Ende des Textes: ${OFFSET_OUT_OF_RANGE_MESSAGE}`;
const OFFSET_OUT_OF_RANGE_DETAILS = { totalChars: 87314, message: OFFSET_OUT_OF_RANGE_MESSAGE };

// A refused window carries two facts in the page's own words: which parameter is wrong
// and which bounds apply. Both have to reach the client, because that sentence *is* the
// fix — the generic `code=invalid_params` catch-all names neither.
const INVALID_READ_PARAMS_MESSAGE = "maxChars muss eine ganze Zahl von 1 bis 100000 sein.";
const INVALID_READ_PARAMS_TEXT = `Der Parameter ist ungültig: ${INVALID_READ_PARAMS_MESSAGE}`;
const INVALID_READ_PARAMS_DETAILS = { message: INVALID_READ_PARAMS_MESSAGE };
const CALL_EXTENSION_FAILED_TEXT = "Die Extension konnte die Anfrage nicht ausführen (code=invalid_params).";

// The two sentences of the frame filter (spec 24), each with the second form the
// extension's `details` earns: the number of frames that answered, and the addresses
// that collided. Spelled out completely, not assembled out of a shared prefix — a case
// that passed because it glued the same strings together would notice no rewrite.
const FRAME_NOT_FOUND_TEXT =
  "Zu diesem `frame` passt kein Rahmen — mit browser_frames die Adressen prüfen.";
const FRAME_NOT_FOUND_WITH_COUNT_TEXT =
  "Zu diesem `frame` passt kein Rahmen — mit browser_frames die Adressen prüfen (geantwortete Rahmen: 2).";
const FRAME_AMBIGUOUS_TEXT =
  "Mehrere Rahmen passen zu diesem `frame` — einen längeren Teilstring der Adresse angeben.";
const FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT =
  "Mehrere Rahmen passen zu diesem `frame` — einen längeren Teilstring einer dieser Adressen angeben: " +
  "https://widget.example.net/kalender/oben, https://widget.example.net/kalender/unten.";
// The `details` the extension would send: two frames answered and matched nothing, or
// two collided on the same substring.
const FRAME_NOT_FOUND_DETAILS = { frames: 2 };
const FRAME_CANDIDATES = [
  "https://widget.example.net/kalender/oben",
  "https://widget.example.net/kalender/unten",
];
const FRAME_AMBIGUOUS_DETAILS = { candidates: FRAME_CANDIDATES };
// The substring a case sends. Deliberately *not* one of the addresses that travel in
// `details`: a log that printed the argument would then be indistinguishable from the
// sentence, and the fixture's rule is that no address reaches stderr.
const FRAME_SUBSTRING = "kalender";

// The selector every click case below sends, and the three sentences it can be
// answered with — quoted with the selector spelled out, so a changed sentence
// turns the case red.
const CLICK_SELECTOR = "a#video-title-link";
const INVALID_SELECTOR_TEXT = "Der Selektor ist ungültig: a#video-title-link.";
const NO_MATCH_TEXT = "Kein Element passt zu: a#video-title-link.";
const NOT_CLICKABLE_TEXT = "Das Element ist nicht sichtbar oder deaktiviert: a#video-title-link.";

// The selector and the invented text every type case below sends, plus the two
// sentences only a `type` call can produce. Invented values, deliberately: no real
// search term belongs in a fixture, and the sentences spell the selector out so a
// changed wording turns the case red.
const TYPE_SELECTOR = "input#q";
const TYPE_TEXT = "suchbegriff";
const TYPE_NO_MATCH_TEXT = "Kein Element passt zu: input#q.";
const NOT_TYPEABLE_TEXT = "Das Element ist kein beschreibbares Feld oder deaktiviert: input#q.";
const PASSWORD_NOT_ALLOWED_TEXT =
  "Passwortfelder sind gesperrt. In den Optionen der Erweiterung freischalten.";

// The one sentence a failed `focus` keeps its code in: the bridge cannot tell why
// the window did not come forward, so the code is the only fact it has.
const FOCUS_FAILED_TEXT = "Die Extension konnte die Anfrage nicht ausführen (code=focus_failed).";

// The filter and the two sentences only an `inspect` call can produce. The sentence
// for a missing filter names both arguments; the one for the extension's
// `invalid_params` names none at all — the bridge does not range-check the limit it
// would have to blame.
const INSPECT_SELECTOR = "a#cart-link";
const INSPECT_NEEDS_FILTER_TEXT = "browser_inspect braucht `selector` oder `text`.";
const INSPECT_INVALID_SELECTOR_TEXT = "Der Selektor ist ungültig: a#cart-link.";
const INSPECT_INVALID_PARAMS_TEXT = "Der Parameter ist ungültig.";

// The code every `eval` case below sends, the code string and the result of the
// fixture are invented like everything else here — and the sentence of each of the
// tool's own codes is quoted, so a changed wording turns its case red. One constant
// per code: the table below exists to prove that no code falls back to the generic
// `code=…` sentence, and a shared constant would hide a swapped mapping.
const EVAL_CODE = "return document.title";
const EVAL_NOT_ALLOWED_TEXT =
  "Code-Auswertung ist in den Einstellungen der Erweiterung nicht erlaubt — erst dort einschalten.";
const EVAL_FAILED_TEXT = "Der Code im Agenten-Tab ist gescheitert (Ausnahme oder Syntaxfehler).";
const EVAL_TIMEOUT_TEXT = "Der Code hat nicht rechtzeitig geantwortet (Zeitüberschreitung nach 2 s).";
const EVAL_RESULT_TOO_LARGE_TEXT =
  "Das Ergebnis ist zu groß für eine Antwort (mehr als 10 000 Zeichen JSON) — weniger zurückgeben, zum Beispiel mit browser_inspect.";
const EVAL_RESULT_UNSERIALIZABLE_TEXT =
  "Das Ergebnis lässt sich nicht als JSON abbilden (etwa zirkulär) — nur einfache Werte zurückgeben.";
const INVALID_EVAL_PARAMS_TEXT = "Der Parameter ist ungültig.";

// The sentences of `browser_screenshot`, one constant per code — plus the two
// message-carrying variants, each of which appears in its own case below. Quoted from
// the contract like every other sentence here, so a changed wording turns its case red.
const SCREENSHOT_NOT_ALLOWED_TEXT =
  "Bildschirmfotos sind in den Einstellungen der Erweiterung nicht erlaubt — erst dort einschalten.";
const SCREENSHOT_FAILED_TEXT = "Der Agenten-Tab ließ sich nicht fotografieren.";
// Two invented messages, not one reused string: a bridge that printed the browser's
// message for the wrong code would look identical with a shared constant.
const SCREENSHOT_BROWSER_MESSAGE = "The operation failed for an unknown transient reason";
const SCREENSHOT_FAILED_WITH_MESSAGE_TEXT = `Der Agenten-Tab ließ sich nicht fotografieren: ${SCREENSHOT_BROWSER_MESSAGE}`;
// The measurement the extension puts into `details.message` — bytes, both dimensions
// and the limit, in the wording of spec 20's wire example.
const SCREENSHOT_TOO_LARGE_MEASUREMENT =
  "Das Bild ist auch nach dem Verkleinern zu groß: 3300000 Bytes bei 1200 × 675 (Grenze 3145728).";
const SCREENSHOT_TOO_LARGE_TEXT =
  "Das Bild ist auch nach dem Verkleinern zu groß — es wird nicht geliefert; ein anderer Tab kann kleiner ausfallen.";
const SCREENSHOT_TOO_LARGE_WITH_MESSAGE_TEXT = `${SCREENSHOT_TOO_LARGE_TEXT} Messung: ${SCREENSHOT_TOO_LARGE_MEASUREMENT}`;
const INVALID_SCREENSHOT_PARAMS_TEXT = "Der Parameter ist ungültig.";
// The three sentences of `browser_transcript`, quoted from the contract, plus the second form
// of the first: its `offset_out_of_range` is *not* among them: that code keeps `read`'s
// sentence above, because the extension checks both tools' windows with the same helper — and
// a case below pins it against that very constant.
const TRANSCRIPT_FAILED_TEXT =
  "Das Transkript ließ sich nicht lesen — nur YouTube-Watch-Seiten haben eines.";
// The same code with the extension's reason, quoted from the contract. The reason is the
// extension's own sentence for the situation it saw — here the one `noCaptionFileMessageFor`
// writes. Its own constant next to the plain sentence, because a bridge that printed the
// reason for the wrong code would look identical with a shared string.
const TRANSCRIPT_FAILURE_REASON =
  'Die Spurendatei zur Sprache "ja" wurde auf dieser Seite nicht gefunden.';
const TRANSCRIPT_FAILED_WITH_MESSAGE_TEXT = `Das Transkript ließ sich nicht lesen: ${TRANSCRIPT_FAILURE_REASON}`;
// The probe for the leak case: a signed track address as the player leaves it in its
// resource list, deliberately short and with a `platzhalter` signature — the repo's
// no-secret rule and criterion 11 count hex runs of 32 and more, and this fixture must not
// carry one. It lives in the failure *details*, the only path the bridge is handed at all.
const TRANSCRIPT_PROBE_URL =
  "https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en&expire=1&signature=platzhalter";
const TRANSCRIPT_NEEDS_FOCUS_TEXT =
  "Der Tab ist nicht im Vordergrund, deshalb ist die Seite nicht gerendert — zuerst browser_focus aufrufen und es dann erneut versuchen.";
// The extension's own words for the visible-but-hydrating tab, quoted from
// `needsFocusMessageFor`. This is the case criterion 5 is about: the sentence must not
// tell the caller to focus again, or the agent loops on a page that is already in front.
const TRANSCRIPT_FOCUS_MESSAGE =
  'Der Tab ist im Vordergrund (document.visibilityState: "visible"), die Seite ist aber noch nicht aufgebaut. Ein erneuter browser_focus hilft nicht; warte kurz und versuche es erneut.';
const TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE_TEXT = `Die Seite ist nicht gerendert: ${TRANSCRIPT_FOCUS_MESSAGE}`;
const NO_TRANSCRIPT_PANEL_TEXT =
  "Keine Untertitelspur im Video gefunden — das Video hat keine, oder die Seite ist noch nicht fertig aufgebaut.";

// The fixture announces every request on its own stderr. Counting these lines is
// how a test tells "refused by the bridge" apart from "reached the extension".
const NAVIGATE_REQUEST_LINE = "fake extension: request method=navigate";
const STATUS_REQUEST_LINE = "fake extension: request method=status";
const READ_REQUEST_LINE = "fake extension: request method=read";
const CLICK_REQUEST_LINE = "fake extension: request method=click";
const TYPE_REQUEST_LINE = "fake extension: request method=type";
const FOCUS_REQUEST_LINE = "fake extension: request method=focus";
const INSPECT_REQUEST_LINE = "fake extension: request method=inspect";
const OPEN_TAB_REQUEST_LINE = "fake extension: request method=open_tab";
const CLOSE_TAB_REQUEST_LINE = "fake extension: request method=close_tab";
const EVAL_REQUEST_LINE = "fake extension: request method=eval";
const SCREENSHOT_REQUEST_LINE = "fake extension: request method=screenshot";
const FRAMES_REQUEST_LINE = "fake extension: request method=frames";
const TRANSCRIPT_REQUEST_LINE = "fake extension: request method=transcript";

// Generated per run: a literal would violate the "no secrets in the repo" rule,
// and `randomBytes(16)` gives exactly the 32 hex characters `readToken` wants.
const TOKEN = randomBytes(16).toString("hex");

// Sentinel for "the awaited thing did not happen yet"; `undefined` is a real
// result for `Array.prototype.find`.
const NOT_YET = Symbol("not yet");
const TIMED_OUT = Symbol("timed out");

// What bridge.mjs writes once the listener is up. The timestamp prefix is the
// process'; the rest is what has to reach stderr and must never reach stdout.
const LISTENING_LINE = / listening on 127\.0\.0\.1:\d+ log=info/;

/* ------------------------------------------------------------------ processes */

function startProcess(scriptPath, env, { stdin = "pipe" } = {}) {
  // Only the variables the test sets. Inheriting the developer's shell could let
  // a stray `BC_LOG=debug` decide what is measured here.
  const child = spawn(process.execPath, [scriptPath], {
    env,
    stdio: [stdin, "pipe", "pipe"],
  });

  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });

  // A write to a bridge that already died raises EPIPE here. That is a real
  // failure, but it belongs to the waiting helper that reports with the child's
  // output — not to an unhandled stream error that kills the test process.
  // `stdin: "ignore"` leaves no stream at all, hence the optional call.
  child.stdin?.on("error", () => {});

  // `close`, not `exit`: only `close` guarantees that both pipes were drained,
  // and the stdout assertions read those pipes.
  const exit = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  return { child, output, exit };
}

function isRunning(handle) {
  return handle.child.exitCode === null && handle.child.signalCode === null;
}

async function raceExit(handle, timeoutMs) {
  // The timeout promise is unref'd: a pending timer must not keep the test
  // process alive after the child is long gone.
  return Promise.race([handle.exit, delay(timeoutMs, TIMED_OUT, { ref: false })]);
}

/** Best-effort teardown for `t.after`: nothing here may throw. */
async function killQuietly(handle) {
  if (!isRunning(handle)) return;
  handle.child.kill("SIGTERM");
  const result = await raceExit(handle, CLEANUP_TIMEOUT_MS);
  if (result === TIMED_OUT) handle.child.kill("SIGKILL");
}

/* ---------------------------------------------------------------------- ports */

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * The line the bridge writes once its extension listener is bound. Matching the
 * log line — not a successful connect — is what makes readiness prove that
 * *this* child bound the port: a connect would also succeed against a foreign
 * bridge that happens to hold the same number, and the test would then wait for
 * a log line its own child never writes.
 */
function boundLinePattern(port) {
  return new RegExp(`^\\S+ listening on 127\\.0\\.0\\.1:${port} log=\\S+$`, "m");
}

async function waitForListener(handle, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const boundLine = boundLinePattern(port);

  for (;;) {
    if (boundLine.test(handle.output.stderr)) return;
    // A bridge that already exited will never listen; its stderr says why.
    if (!isRunning(handle)) {
      throw new Error(
        `the bridge exited before it listened on port ${port} — is another test run using this reserved port?\n` +
          `--- bridge stderr ---\n${handle.output.stderr}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the bridge did not report port ${port} as listening within ${READY_TIMEOUT_MS} ms:\n` +
          handle.output.stderr,
      );
    }
    await delay(PORT_POLL_INTERVAL_MS);
  }
}

/* --------------------------------------------------------------------- bridge */

/**
 * Starts the bridge on this file's reserved port and returns the process handle
 * extended with `port`. Spawned once — there is no second attempt, because a
 * refused bind is the finding, not an obstacle.
 */
async function startBridge(t, { tokenFile, env = {}, stdin = "pipe" }) {
  const { extension: port } = MCP_FIXTURE;
  const handle = startProcess(
    BRIDGE_PATH,
    {
      BC_BIND: `127.0.0.1:${port}`,
      BC_TOKEN_FILE: tokenFile,
      ...env,
    },
    { stdin },
  );
  // Registered before the wait: a failing wait must not leave a child behind.
  t.after(() => killQuietly(handle));

  await waitForListener(handle, port);
  return { ...handle, port };
}

/* ------------------------------------------------------------ fake extension */

function startFakeExtension(t, port, env = {}) {
  const handle = startProcess(FAKE_EXTENSION_PATH, {
    BC_TEST_URL: `ws://127.0.0.1:${port}`,
    BC_TEST_TOKEN: TOKEN,
    ...env,
  });
  t.after(() => killQuietly(handle));
  return handle;
}

/* --------------------------------------------------------------- token files */

function createTokenFile(t, { trailingNewline = false } = {}) {
  // Outside the working tree on purpose: a token file inside the repo is exactly
  // the kind of leftover that a secret grep finds a month later.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const file = path.join(directory, "token");
  fs.writeFileSync(file, trailingNewline ? `${TOKEN}\n` : TOKEN, { mode: 0o600 });
  return file;
}

/* -------------------------------------------------------------------- waiting */

async function waitFor(check, description) {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;

  for (;;) {
    const value = check();
    if (value !== NOT_YET) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${EVENT_TIMEOUT_MS} ms waiting for ${description}`);
    }
    await delay(PORT_POLL_INTERVAL_MS);
  }
}

/**
 * Polls the child's stderr. On a timeout the error carries what the process
 * actually wrote — without it a failing assertion would only say "nothing
 * arrived", which is the least useful thing to know about a child process.
 */
async function waitForOutput(handle, check, description) {
  try {
    return await waitFor(() => check(handle.output) ?? NOT_YET, description);
  } catch (error) {
    throw new Error(
      `${error.message}\n--- bridge stderr ---\n${handle.output.stderr}\n--- bridge stdout ---\n${handle.output.stdout}`,
      { cause: error },
    );
  }
}

/**
 * Polls stderr — the only channel a log line may use. Same failure report as
 * `waitForOutput`, because "nothing arrived" is the least useful thing to know.
 */
async function waitForStderr(handle, check, description) {
  return waitForOutput(handle, ({ stderr }) => (check(stderr) ? true : NOT_YET), description);
}

/* --------------------------------------------------------------- the protocol */

/**
 * Splits stdout into the finished lines and the fragment after the last newline.
 *
 * The tail is returned rather than dropped: a message without its closing `\n`
 * is exactly what the client rejects with "closed with an incomplete JSON-RPC
 * message", so a test that wants to know the stream ended cleanly has to be
 * able to see it. During a running process the tail is expected to be non-empty
 * for a moment (a write can be split across chunks), which is why dropping it is
 * the right default for the polling helpers and why the end-of-stream cases
 * assert on it explicitly.
 */
function splitStdout(stdout) {
  const lines = stdout.split("\n");
  const tail = lines.pop();

  const messages = lines.filter((line) => line !== "").map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`stdout carried a line that is not JSON: ${JSON.stringify(line)}`);
    }
  });

  return { messages, tail };
}

/**
 * Every complete line on stdout, parsed.
 *
 * A line that is not JSON is a failure, not a "nothing yet": stdout is the
 * protocol channel, and the whole point of this file is that nothing else
 * reaches it. A line is complete exactly when its newline arrived.
 */
function parseRpcLines(stdout) {
  return splitStdout(stdout).messages;
}

/**
 * Proof that a finished process left no message without its newline. Used at the
 * points where stdout is final; while the bridge still runs, the tail may simply
 * be a write in flight.
 */
function assertNoUnfinishedTail(handle) {
  assert.equal(
    splitStdout(handle.output.stdout).tail,
    "",
    "stdout ended with a message that has no closing newline",
  );
}

function completedLines(handle) {
  return parseRpcLines(handle.output.stdout);
}

function sendMessage(handle, message) {
  handle.child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** For the malformed input cases: the line goes out exactly as written. */
function sendRawLine(handle, text) {
  handle.child.stdin.write(`${text}\n`);
}

/** Searched by `id`, never by position: two requests may be answered in any order. */
function waitForResponse(handle, id, description) {
  return waitForOutput(
    handle,
    ({ stdout }) => parseRpcLines(stdout).find((message) => message.id === id),
    description ?? `the response with id=${id}`,
  );
}

function waitForErrorCode(handle, code, description) {
  return waitForOutput(
    handle,
    ({ stdout }) => parseRpcLines(stdout).find((message) => message.error?.code === code),
    description ?? `the response with error code ${code}`,
  );
}

/** Sends a `ping` and returns its answer — the cheapest proof of life there is. */
async function ping(handle, id) {
  sendMessage(handle, { jsonrpc: "2.0", id, method: "ping" });
  return waitForResponse(handle, id, `the answer to ping id=${id}`);
}

function toolsCall(id, params) {
  return { jsonrpc: "2.0", id, method: "tools/call", params };
}

/** The one tool call this server has, with no arguments at all. */
function browserStatusCall(id) {
  return toolsCall(id, { name: "browser_status" });
}

/** The other tool: `browser_navigate` with a URL, as the schema asks for it. */
function browserNavigateCall(id, url) {
  return toolsCall(id, { name: "browser_navigate", arguments: { url } });
}

/** The third tool: `browser_read`, with the window the caller built when it has one. */
function browserReadCall(id, args) {
  return toolsCall(id, { name: "browser_read", ...(args === undefined ? {} : { arguments: args }) });
}

/** The fourth tool: `browser_click` with a selector, as the schema asks for it. */
function browserClickCall(id, selector) {
  return toolsCall(id, { name: "browser_click", arguments: { selector } });
}

/** The fifth tool: `browser_type`, with the two required keys and no `submit`. */
function browserTypeCall(id, selector, text) {
  return toolsCall(id, { name: "browser_type", arguments: { selector, text } });
}

/** The sixth tool: `browser_focus`, without arguments like `browser_read`. */
function browserFocusCall(id) {
  return toolsCall(id, { name: "browser_focus" });
}

/** The seventh tool: `browser_inspect` with the argument object the caller built. */
function browserInspectCall(id, args) {
  return toolsCall(id, { name: "browser_inspect", arguments: args });
}

/** The eighth tool: `browser_open_tab` with the URL its schema requires. */
function browserOpenTabCall(id, url) {
  return toolsCall(id, { name: "browser_open_tab", arguments: { url } });
}

/** The ninth tool: `browser_close_tab` — with `tab` when the caller names one. */
function browserCloseTabCall(id, args) {
  return args === undefined
    ? toolsCall(id, { name: "browser_close_tab" })
    : toolsCall(id, { name: "browser_close_tab", arguments: args });
}

/** The tenth tool: `browser_eval` with the argument object the caller built. */
function browserEvalCall(id, args) {
  return toolsCall(id, { name: "browser_eval", arguments: args });
}

/** The eleventh tool: `browser_screenshot` with an optional tab, like `browser_focus`. */
function browserScreenshotCall(id, args) {
  return toolsCall(id, { name: "browser_screenshot", arguments: args });
}

/** The twelfth tool: `browser_frames`, again with an optional tab. */
function browserFramesCall(id, args) {
  return toolsCall(id, { name: "browser_frames", arguments: args });
}

/** The thirteenth tool: `browser_transcript`, with the window the caller built. */
function browserTranscriptCall(id, args) {
  return toolsCall(id, { name: "browser_transcript", arguments: args });
}

/**
 * Every stderr line announcing a request of one method.
 *
 * A prefix test, not an equality test: a request that carried a `tab` names it in
 * the same line (`... method=read tab=42`), and a counter that demanded the bare
 * line would silently stop counting exactly the calls most worth counting.
 */
function requestLines(fakeExtension, requestLine) {
  return fakeExtension.output.stderr
    .split("\n")
    .filter((line) => line.startsWith(requestLine));
}

/**
 * The `tab` values named on the request lines of one method.
 *
 * This is the only proof that `withOptionalTab` puts the argument on the wire: the
 * fixture answers the same frame either way, so without it the bridge could drop
 * `tab` and every other assertion would still pass. The match accepts a suffix behind
 * the tab (`frame=yes`, since spec 24) instead of anchoring on the line end — a
 * counting helper that demanded the bare tail would silently stop counting the calls
 * with the most arguments.
 */
function requestedTabs(fakeExtension, requestLine) {
  const TAB_SUFFIX = / tab=(\d+)(?: |$)/;
  return requestLines(fakeExtension, requestLine).flatMap((line) => {
    const match = TAB_SUFFIX.exec(line);
    return match === null ? [] : [Number(match[1])];
  });
}

/** How many `read` requests reached the fake extension. */
function readRequestCount(fakeExtension) {
  return requestLines(fakeExtension, READ_REQUEST_LINE).length;
}

/** How many `navigate` requests reached the fake extension. */
function navigateRequestCount(fakeExtension) {
  return requestLines(fakeExtension, NAVIGATE_REQUEST_LINE).length;
}

/** How many `click` requests reached the fake extension. */
function clickRequestCount(fakeExtension) {
  return requestLines(fakeExtension, CLICK_REQUEST_LINE).length;
}

/** How many `type` requests reached the fake extension. */
function typeRequestCount(fakeExtension) {
  return requestLines(fakeExtension, TYPE_REQUEST_LINE).length;
}

/** How many `focus` requests reached the fake extension. */
function focusRequestCount(fakeExtension) {
  return requestLines(fakeExtension, FOCUS_REQUEST_LINE).length;
}

/** How many `inspect` requests reached the fake extension. */
function inspectRequestCount(fakeExtension) {
  return requestLines(fakeExtension, INSPECT_REQUEST_LINE).length;
}

/** How many `open_tab` requests reached the fake extension. */
function openTabRequestCount(fakeExtension) {
  return requestLines(fakeExtension, OPEN_TAB_REQUEST_LINE).length;
}

/** How many `close_tab` requests reached the fake extension. */
function closeTabRequestCount(fakeExtension) {
  return requestLines(fakeExtension, CLOSE_TAB_REQUEST_LINE).length;
}

/** How many `eval` requests reached the fake extension. */
function evalRequestCount(fakeExtension) {
  return requestLines(fakeExtension, EVAL_REQUEST_LINE).length;
}

/** How many `screenshot` requests reached the fake extension. */
function screenshotRequestCount(fakeExtension) {
  return requestLines(fakeExtension, SCREENSHOT_REQUEST_LINE).length;
}

/** How many `frames` requests reached the fake extension. */
function framesRequestCount(fakeExtension) {
  return requestLines(fakeExtension, FRAMES_REQUEST_LINE).length;
}

/** How many `transcript` requests reached the fake extension. */
function transcriptRequestCount(fakeExtension) {
  return requestLines(fakeExtension, TRANSCRIPT_REQUEST_LINE).length;
}

/** Waits for a process to be gone, reporting its stderr when it is not. */
async function exitWithin(handle, timeoutMs) {
  const result = await raceExit(handle, timeoutMs);
  if (result === TIMED_OUT) {
    throw new Error(`the bridge was still running after ${timeoutMs} ms\n${handle.output.stderr}`);
  }
  return result;
}

/** Every line on stderr that announces a shutdown — there must be exactly one. */
function shutdownLines(handle) {
  return handle.output.stderr.split("\n").filter((line) => line.includes("shutting down"));
}

/* ---------------------------------------------------------------------- cases */

test("mcp_initialize_withAKnownProtocolVersion_shouldEchoThatVersion", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the client initialises with a version the server knows,
  sendMessage(bridge, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const response = await waitForResponse(bridge, 1);

  // THEN that version comes back, with the capabilities and the server name the
  // contract names:
  assert.equal(response.jsonrpc, "2.0");
  assert.deepEqual(response.result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "browser-control", version: "0.1.0" },
  });
});

test("mcp_initialize_withAnUnknownProtocolVersion_shouldFallBackToTheNewestKnownVersion", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the client asks for a version that does not exist,
  sendMessage(bridge, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  const response = await waitForResponse(bridge, 1);

  // THEN it gets the newest version the server speaks instead of an error:
  assert.equal(response.result.protocolVersion, "2025-11-25");
});

test("mcp_stdout_shouldCarryNothingButJsonRpcWhileTheLogLinesStayOnStderr", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the client runs the shortest complete dialogue there is,
  sendMessage(bridge, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await waitForResponse(bridge, 1);
  await ping(bridge, 2);

  // THEN every complete line on stdout is a JSON-RPC message with an id,
  const messages = completedLines(bridge);
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.jsonrpc, "2.0");
    assert.ok(Object.hasOwn(message, "id"), "every response carries an id field");
  }

  // ... the bridge's own "listening on …" line is on stderr and never on stdout,
  const listeningLine = await waitForOutput(
    bridge,
    ({ stderr }) => stderr.split("\n").find((line) => LISTENING_LINE.test(line)),
    'the "listening on" line on stderr',
  );
  assert.match(listeningLine, LISTENING_LINE);
  assert.ok(!bridge.output.stdout.includes("listening on"), "the log line must not reach stdout");
  assert.ok(!bridge.output.stdout.includes("status windows="), "no log line may reach stdout");
});

test("mcp_toANotificationFollowedByAPing_shouldAnswerOnlyThePing", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN `notifications/initialized` (no id) is followed by a `ping`,
  sendMessage(bridge, { jsonrpc: "2.0", method: "notifications/initialized" });
  sendMessage(bridge, { jsonrpc: "2.0", id: 7, method: "ping" });
  const response = await waitForResponse(bridge, 7);

  // THEN exactly one answer exists: the notification sent first would have been
  // answered first, so a single line now is proof that it was answered never.
  assert.deepEqual(response.result, {});
  assert.equal(completedLines(bridge).length, 1);
  assert.equal(completedLines(bridge).filter((message) => message.id === 7).length, 1);
});

test("mcp_forAnUnknownMethod_shouldAnswerWithMethodNotFound", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the client calls a method this server does not implement,
  sendMessage(bridge, { jsonrpc: "2.0", id: 3, method: "tools/nonexistent" });
  const response = await waitForResponse(bridge, 3);

  // THEN it gets the JSON-RPC method-not-found error and no result:
  assert.equal(response.error.code, -32601);
  assert.equal(response.error.message, "method not found");
  assert.equal(response.result, undefined);
});

test("mcp_withOneBrokenLine_shouldAnswerParseErrorAndKeepServingTheNextRequest", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN a line arrives that is not JSON,
  sendRawLine(bridge, '{"jsonrpc":"2.0","id":1,"method":');
  const parseError = await waitForErrorCode(bridge, -32700, "the parse error response");

  // THEN the answer names the parse error with `id: null`,
  assert.equal(parseError.jsonrpc, "2.0");
  assert.equal(parseError.id, null);
  assert.equal(parseError.error.message, "parse error");

  // ... and the server keeps running: a good line afterwards is answered.
  const response = await ping(bridge, 11);
  assert.deepEqual(response.result, {});
});

test("mcp_withALineThatIsNotAJsonObject_shouldAnswerInvalidRequestAndKeepServing", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN a well-formed JSON value arrives that is not an object — a JSON-RPC
  // batch, which MCP does not use,
  sendRawLine(bridge, "[1,2]");
  const invalidRequest = await waitForErrorCode(bridge, -32600, "the invalid request response");

  // THEN it is refused as an invalid request, not as a parse error,
  assert.equal(invalidRequest.id, null);
  assert.equal(invalidRequest.error.message, "invalid request");

  // ... and the server keeps serving:
  const response = await ping(bridge, 12);
  assert.deepEqual(response.result, {});
});

test("mcp_withALineLongerThanTheMessageLimit_shouldAnswerParseErrorInsteadOfParsingItAndKeepServing", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN a single line arrives that exceeds MAX_MESSAGE_BYTES — the server itself
  // has to judge it, because readline hands over whatever length arrives:
  sendRawLine(bridge, `"${"x".repeat(PROTOCOL.MAX_MESSAGE_BYTES)}"`);
  const parseError = await waitForErrorCode(bridge, -32700, "the parse error for the oversized line");

  // THEN the line is refused instead of being parsed and answered as a request,
  assert.equal(parseError.id, null);
  assert.equal(parseError.error.message, "parse error");

  // ... and the session survives it: the next line is answered normally.
  const response = await ping(bridge, 13);
  assert.deepEqual(response.result, {});
});

test("mcp_withAStringIdOrZeroAsId_shouldAnswerUnderExactlyThatId", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN two requests carry ids that are present but not plain positive
  // integers — a string, which JSON-RPC allows, and `0`, which only `??` keeps:
  sendMessage(bridge, { jsonrpc: "2.0", id: "req-7", method: "ping" });
  sendMessage(bridge, { jsonrpc: "2.0", id: 0, method: "ping" });

  // THEN each answer carries its own id unchanged. A `||` where the code has a
  // `??` would turn the zero into `null` and silently break the pairing:
  const stringIdAnswer = await waitForResponse(bridge, "req-7", "the answer to the string id");
  assert.equal(stringIdAnswer.id, "req-7");
  const zeroIdAnswer = await waitForResponse(bridge, 0, "the answer to id 0");
  assert.equal(zeroIdAnswer.id, 0);
  assert.deepEqual(zeroIdAnswer.result, {});
});

test("mcp_toolsList_shouldOfferExactlyTheThirteenToolsOfTheContract", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the client asks for the tool table,
  sendMessage(bridge, { jsonrpc: "2.0", id: 20, method: "tools/list" });
  const response = await waitForResponse(bridge, 20);

  // THEN there are exactly thirteen tools, declared word for word as the contract says,
  // in the order the contract lists them. New tools are appended, so every position is
  // a pin: each of the thirteen is checked field by field below, and nothing may shift.
  const { tools } = response.result;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "browser_status",
      "browser_navigate",
      "browser_read",
      "browser_click",
      "browser_type",
      "browser_focus",
      "browser_inspect",
      "browser_open_tab",
      "browser_close_tab",
      "browser_eval",
      "browser_screenshot",
      "browser_frames",
      "browser_transcript",
    ],
  );
  assert.equal(tools.length, 13);

  assert.equal(tools[0].description, TOOL_DESCRIPTION);
  assert.deepEqual(tools[0].inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  // Redundant on purpose: this one field is what stops a client from silently
  // sending arguments nobody reads.
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  // `status` is the one tool that does not take a `tab` even now: it reports every
  // window, so a tab could only be ignored.
  assert.deepEqual(tools[0].inputSchema.properties, {});

  assert.equal(tools[1].description, NAVIGATE_TOOL_DESCRIPTION);
  assert.deepEqual(tools[1].inputSchema, {
    type: "object",
    properties: { url: { type: "string" }, tab: { type: "integer", minimum: 1 } },
    required: ["url"],
    additionalProperties: false,
  });
  assert.deepEqual(tools[1].inputSchema.required, ["url"]);
  assert.equal(tools[1].inputSchema.additionalProperties, false);

  assert.equal(tools[2].description, READ_TOOL_DESCRIPTION);
  // Five declared properties since spec 24: the window (`offset`, `maxChars`), the
  // `mode` that picks the article body, the `frame` substring that addresses an iframe,
  // and `tab`. The ranges and the enum stand here because they are the contract, and the
  // cases below prove that the bridge itself checks only the *types*.
  assert.deepEqual(tools[2].inputSchema, {
    type: "object",
    properties: {
      offset: { type: "integer", minimum: 0 },
      maxChars: { type: "integer", minimum: 1, maximum: 100000 },
      mode: { type: "string", enum: ["text", "article"] },
      frame: { type: "string", minLength: 1 },
      tab: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  });
  // The order is the contract too: a client builds its argument panel in this order.
  assert.deepEqual(Object.keys(tools[2].inputSchema.properties), [
    "offset",
    "maxChars",
    "mode",
    "frame",
    "tab",
  ]);
  assert.equal(tools[2].inputSchema.additionalProperties, false);
  // No `required`: a read without a window is the default read.
  assert.equal(tools[2].inputSchema.required, undefined);

  assert.equal(tools[3].description, CLICK_TOOL_DESCRIPTION);
  // Three declared properties since spec 26: the selector, the `frame` substring that
  // addresses an iframe, and `tab` — in that order, because a client builds its
  // argument panel in this order.
  assert.deepEqual(tools[3].inputSchema, {
    type: "object",
    properties: {
      selector: { type: "string" },
      frame: { type: "string", minLength: 1 },
      tab: { type: "integer", minimum: 1 },
    },
    required: ["selector"],
    additionalProperties: false,
  });
  assert.deepEqual(Object.keys(tools[3].inputSchema.properties), ["selector", "frame", "tab"]);
  // The one required field of this schema: without a selector there is nothing
  // to click, and `-32602` below is the call-side half of the same rule.
  assert.deepEqual(tools[3].inputSchema.required, ["selector"]);
  assert.equal(tools[3].inputSchema.additionalProperties, false);

  assert.equal(tools[4].description, TYPE_TOOL_DESCRIPTION);
  assert.deepEqual(tools[4].inputSchema, {
    type: "object",
    properties: {
      selector: { type: "string" },
      text: { type: "string" },
      submit: { type: "boolean" },
      frame: { type: "string", minLength: 1 },
      tab: { type: "integer", minimum: 1 },
    },
    required: ["selector", "text"],
    additionalProperties: false,
  });
  assert.deepEqual(Object.keys(tools[4].inputSchema.properties), [
    "selector",
    "text",
    "submit",
    "frame",
    "tab",
  ]);
  // Two required keys, and `submit` deliberately not among them: typing without
  // Enter is the normal case, and a call-side default fills the gap.
  assert.deepEqual(tools[4].inputSchema.required, ["selector", "text"]);
  assert.equal(tools[4].inputSchema.additionalProperties, false);
  assert.equal(tools[4].inputSchema.properties.submit.type, "boolean");

  // Appended in the order of the contract: `browser_focus` takes only the optional
  // `tab`, and its schema says so.
  assert.equal(tools[5].name, "browser_focus");
  assert.equal(tools[5].description, FOCUS_TOOL_DESCRIPTION);
  assert.deepEqual(tools[5].inputSchema, {
    type: "object",
    properties: { tab: { type: "integer", minimum: 1 } },
    additionalProperties: false,
  });
  assert.deepEqual(Object.keys(tools[5].inputSchema.properties), ["tab"]);
  assert.equal(tools[5].inputSchema.additionalProperties, false);

  // The seventh tool is the first with two optional filters and no required key:
  // a call with neither is refused at the call (`INSPECT_NEEDS_FILTER_TEXT` below),
  // and `required` deliberately stays empty so a client may send either one.
  assert.equal(tools[6].name, "browser_inspect");
  assert.equal(tools[6].description, INSPECT_TOOL_DESCRIPTION);
  assert.deepEqual(tools[6].inputSchema, {
    type: "object",
    properties: {
      selector: { type: "string" },
      text: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      includeHidden: { type: "boolean" },
      frame: { type: "string", minLength: 1 },
      tab: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  });
  assert.deepEqual(Object.keys(tools[6].inputSchema.properties), [
    "selector",
    "text",
    "limit",
    "includeHidden",
    "frame",
    "tab",
  ]);
  assert.equal(tools[6].inputSchema.required, undefined);
  assert.equal(tools[6].inputSchema.additionalProperties, false);

  // The two tools of the tab management, appended after all of the above.
  // `browser_open_tab` is `navigate` minus the tab: the tab it addresses does not
  // exist until it answers.
  assert.equal(tools[7].name, "browser_open_tab");
  assert.equal(tools[7].description, OPEN_TAB_TOOL_DESCRIPTION);
  assert.deepEqual(tools[7].inputSchema, {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  });
  assert.deepEqual(tools[7].inputSchema.required, ["url"]);
  assert.equal(tools[7].inputSchema.additionalProperties, false);

  assert.equal(tools[8].name, "browser_close_tab");
  assert.equal(tools[8].description, CLOSE_TAB_TOOL_DESCRIPTION);
  assert.deepEqual(tools[8].inputSchema, {
    type: "object",
    properties: { tab: { type: "integer", minimum: 1 } },
    additionalProperties: false,
  });
  assert.equal(tools[8].inputSchema.required, undefined);
  assert.equal(tools[8].inputSchema.additionalProperties, false);

  // The tenth tool, appended after every position above it: `code` is required and
  // a string, `tab` is the optional integer seven schemas already share. No length
  // in the schema — the 20 000 characters are the extension's rule, not a second
  // opinion here.
  assert.equal(tools[9].name, "browser_eval");
  assert.equal(tools[9].description, EVAL_TOOL_DESCRIPTION);
  // The one sentence a caller can read nowhere else: `code` runs as a function body,
  // so the result needs a `return` and a bare expression answers `null`. Checked
  // outside the verbatim string too, so a repaired constant cannot hide a dropped
  // rule — a caller who misses it reads a healthy tool as "not implemented".
  assert.ok(
    tools[9].description.includes(EVAL_FUNCTION_BODY_SENTENCE),
    tools[9].description,
  );
  assert.match(tools[9].description, /ohne `return` ist es `null`/);
  assert.deepEqual(tools[9].inputSchema, {
    type: "object",
    properties: {
      code: { type: "string" },
      frame: { type: "string", minLength: 1 },
      tab: { type: "integer", minimum: 1 },
    },
    required: ["code"],
    additionalProperties: false,
  });
  assert.deepEqual(tools[9].inputSchema.required, ["code"]);
  assert.deepEqual(Object.keys(tools[9].inputSchema.properties), ["code", "frame", "tab"]);
  assert.equal(tools[9].inputSchema.additionalProperties, false);

  // The eleventh tool, appended after every position above it: one optional `tab`
  // and nothing else. No `format`, no `quality`, no `rect` — the ladder is the
  // extension's contract, and a knob here would be a second opinion about a picture
  // the bridge never sees.
  assert.equal(tools[10].name, "browser_screenshot");
  assert.equal(tools[10].description, SCREENSHOT_TOOL_DESCRIPTION);
  assert.deepEqual(tools[10].inputSchema, {
    type: "object",
    properties: { tab: { type: "integer", minimum: 1 } },
    additionalProperties: false,
  });
  // No `required` at all: without `tab` the extension photographs the last used
  // agent tab, which is the one an agent usually means.
  assert.equal(tools[10].inputSchema.required, undefined);
  assert.deepEqual(Object.keys(tools[10].inputSchema.properties), ["tab"]);
  assert.equal(tools[10].inputSchema.additionalProperties, false);

  // The twelfth tool, appended after every position above it: one optional `tab` and
  // nothing else. No `frame`, no depth, no parent list — the flat addresses it answers
  // are exactly what the other tools address a frame with.
  assert.equal(tools[11].name, "browser_frames");
  assert.equal(tools[11].description, FRAMES_TOOL_DESCRIPTION);
  assert.deepEqual(tools[11].inputSchema, {
    type: "object",
    properties: { tab: { type: "integer", minimum: 1 } },
    additionalProperties: false,
  });
  assert.equal(tools[11].inputSchema.required, undefined);
  assert.deepEqual(Object.keys(tools[11].inputSchema.properties), ["tab"]);
  assert.equal(tools[11].inputSchema.additionalProperties, false);

  // The thirteenth tool, appended after every position above it: the window of `read`
  // (`offset`, `maxChars`, same bounds) plus the optional `tab`. No `mode` and no
  // `frame` — a transcript is one track file of one watch page, and the track file is not
  // inside an iframe the caller could address. Its position is the reason `tools[11].name`
  // above is still `browser_frames`: appending shifts nothing.
  assert.equal(tools[12].name, "browser_transcript");
  assert.equal(tools[12].description, TRANSCRIPT_TOOL_DESCRIPTION);
  assert.deepEqual(tools[12].inputSchema, {
    type: "object",
    properties: {
      offset: { type: "integer", minimum: 0 },
      maxChars: { type: "integer", minimum: 1, maximum: 100000 },
      tab: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  });
  // Same order as `read`'s window and the same absence of `required`: without a window
  // the extension reads from 0 to 20 000 characters, which is the default read.
  assert.deepEqual(Object.keys(tools[12].inputSchema.properties), ["offset", "maxChars", "tab"]);
  assert.equal(tools[12].inputSchema.required, undefined);
  assert.equal(tools[12].inputSchema.additionalProperties, false);
  // The description is the only place the two defaults are written down for a caller
  // who reads schemas instead of prose, so both are pinned as text as well.
  assert.match(tools[12].description, /`offset` überspringt so viele Zeichen .*\(Default 0\)/);
  assert.match(tools[12].description, /`maxChars` .*Default 20 000, höchstens 100 000/);
  assert.match(tools[12].description, /browser_focus/);

  // Eleven schemas share one frozen `tab` property in the module, and that is safe:
  // JSON makes eleven independent copies on the wire, so a client that mutates its
  // parsed table touches nobody else's. Compared by value here, because identity
  // does not survive the wire — the eleven must still agree word for word.
  for (const tool of tools.slice(1, 7)) {
    assert.deepEqual(tool.inputSchema.properties.tab, { type: "integer", minimum: 1 }, tool.name);
  }
  assert.deepEqual(tools[8].inputSchema.properties.tab, { type: "integer", minimum: 1 });
  assert.deepEqual(tools[9].inputSchema.properties.tab, { type: "integer", minimum: 1 });
  assert.deepEqual(tools[10].inputSchema.properties.tab, { type: "integer", minimum: 1 });
  assert.deepEqual(tools[11].inputSchema.properties.tab, { type: "integer", minimum: 1 });
  assert.deepEqual(tools[12].inputSchema.properties.tab, { type: "integer", minimum: 1 });
});

test("mcp_toolsCallBrowserStatus_withAConnectedExtension_shouldReturnTheStatusAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a fake extension connected and its automatic status
  // request already answered:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN the client calls the one tool,
  sendMessage(bridge, browserStatusCall(21));
  const response = await waitForResponse(bridge, 21);

  // THEN the answer is a text content block whose text is the result, indented
  // with two spaces and without an error flag:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");

  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_RESULT);
  const parsed = JSON.parse(text);
  assert.ok(parsed.windows.length >= 1, "at least one window is expected");
  assert.deepEqual(parsed, STATUS_RESULT);
});

test("mcp_toolsCallBrowserStatus_withoutAnExtension_shouldReturnTheNoExtensionSentenceAsToolError", async (t) => {
  // GIVEN a running bridge with nobody on the other end:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the client calls the tool anyway,
  sendMessage(bridge, browserStatusCall(22));
  const response = await waitForResponse(bridge, 22);

  // THEN it gets the German sentence, flagged as an error — not a JSON-RPC
  // error, because the human should read the sentence:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_EXTENSION_TEXT }]);
  assert.equal(response.error, undefined);
});

test("mcp_toolsCallBrowserStatus_whenTheExtensionStaysSilent_shouldReturnTheTimeoutSentence", async (t) => {
  // GIVEN a bridge with a 300 ms call timeout and an extension that never
  // answers:
  const bridge = await startBridge(t, {
    tokenFile: createTokenFile(t),
    env: { BC_CALL_TIMEOUT_MS: "300" },
  });
  startFakeExtension(t, bridge.port, { BC_TEST_ANSWER: "0" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client calls the tool,
  sendMessage(bridge, browserStatusCall(23));
  const response = await waitForResponse(bridge, 23);

  // THEN the timeout is reported as a tool error instead of hanging the call:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_ANSWER_TEXT }]);
});

test("mcp_toolsCallBrowserStatus_whenTheExtensionAnswersOkFalse_shouldReturnTheExtensionFailedSentenceWithTheCode", async (t) => {
  // GIVEN a bridge with a fake extension that refuses the status request with a
  // code of its own (the fourth answer in the contract, and the only one that
  // carries a value from the far side):
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port, { BC_TEST_ANSWER: "error:permission_denied" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status failed peer=") && stderr.includes("code=permission_denied"),
    "the automatic request failing with the extension's code on stderr",
  );

  // WHEN the client calls the tool,
  sendMessage(bridge, browserStatusCall(28));
  const response = await waitForResponse(bridge, 28);

  // THEN it gets the sentence from the contract word for word, with the code
  // inside it. Quoted here instead of imported: a changed sentence must turn
  // this red, which an imported one could never do.
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [
    { type: "text", text: "Die Extension konnte den Status nicht liefern (code=permission_denied)." },
  ]);
  assert.equal(response.error, undefined);
});

test("mcp_toolsCallBrowserNavigate_withAConnectedExtension_shouldReturnAllSevenFieldsAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a fake extension connected and its automatic status
  // request already answered:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN the client calls `browser_navigate`,
  sendMessage(bridge, browserNavigateCall(50, "https://example.org/"));
  const response = await waitForResponse(bridge, 50);

  // THEN the answer is the extension's result as indented JSON, without an error
  // flag:
  assert.equal(response.result.isError, undefined);
  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_NAVIGATE_RESULT);

  // ... and it carries all five fields the contract promises, `windowId`
  // included — a client that only gets four cannot show or use the tab.
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, NAVIGATE_RESULT);
  for (const field of ["tabId", "windowId", "url", "title", "complete"]) {
    assert.ok(Object.hasOwn(parsed, field), `${field} is missing`);
  }
});

test("mcp_toolsCallBrowserNavigate_withoutAUrl_shouldAnswerInvalidParams", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the required `url` is missing — once not sent at all, once as a number,
  sendMessage(bridge, toolsCall(51, { name: "browser_navigate", arguments: {} }));
  sendMessage(bridge, toolsCall(52, { name: "browser_navigate", arguments: { url: 42 } }));

  // THEN this is a malformed request, not a tool result: the schema declares
  // `url` required, so the client broke the contract before the tool ran.
  for (const id of [51, 52]) {
    const response = await waitForResponse(bridge, id);
    assert.equal(response.error.code, -32602);
    assert.equal(response.error.message, "invalid params");
    assert.equal(response.result, undefined);
  }
});

test("mcp_toolsCallBrowserNavigate_withASecondArgument_shouldReturnTheOnlyUrlAndTabSentence", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the call carries an argument the schema forbids — `windowId` spells the
  // `tab` intent in a name this server does not read,
  sendMessage(
    bridge,
    toolsCall(53, { name: "browser_navigate", arguments: { url: "https://example.org/", windowId: 1 } }),
  );
  const response = await waitForResponse(bridge, 53);

  // THEN it is a tool error with the sentence from the contract — same precedence
  // as `browser_status`: a message for the client, not a protocol error.
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NAVIGATE_UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(response.error, undefined);
});

test("mcp_toolsCallBrowserNavigate_withAFileUrl_shouldRefuseItWithoutAskingTheExtension", async (t) => {
  // GIVEN a running bridge with a connected fake extension — the counter can only
  // prove a zero when something is there to count requests:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client asks for a local file,
  sendMessage(bridge, browserNavigateCall(54, "file:///etc/passwd"));
  const response = await waitForResponse(bridge, 54);

  // THEN the bridge refuses it itself — the extension never hears about it. The
  // fixture counter says so, an absent `status failed` line would not: a refused
  // call would leave that line untouched either way.
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: INVALID_URL_TEXT }]);
  assert.equal(response.error, undefined);
  assert.equal(navigateRequestCount(fakeExtension), 0, "the refused call must not reach the extension");
});

test("mcp_toolsCallBrowserNavigate_whenTheExtensionRefusesTheUrl_shouldReturnTheSameGermanSentence", async (t) => {
  // GIVEN a fake extension that refuses every navigate request with its own
  // `invalid_url` — the second floor of the same rule:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port, { BC_TEST_NAVIGATE_ANSWER: "error:invalid_url" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client navigates,
  sendMessage(bridge, browserNavigateCall(55, "https://example.org/"));
  const response = await waitForResponse(bridge, 55);

  // THEN the sentence is the same as the bridge's own refusal: which of the two
  // floors caught it is not the operator's problem.
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: INVALID_URL_TEXT }]);
});

test("mcp_toolsCallBrowserNavigate_whenTheExtensionFails_shouldReturnTheGenericSentenceWithTheCode", async (t) => {
  // GIVEN a fake extension whose navigation fails on its side:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port, { BC_TEST_NAVIGATE_ANSWER: "error:navigate_failed" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client navigates,
  sendMessage(bridge, browserNavigateCall(56, "https://example.org/"));
  const response = await waitForResponse(bridge, 56);

  // THEN it gets the generic sentence with the code inside it, quoted here
  // instead of imported so a changed sentence turns this red:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [
    { type: "text", text: "Die Extension konnte die Anfrage nicht ausführen (code=navigate_failed)." },
  ]);
});

test("mcp_toolsCallBrowserNavigate_shouldNotSendRefusedCallsToTheExtension", async (t) => {
  // GIVEN a bridge with a connected fake extension — one run, because the
  // counter has to count before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );
  // The automatic status request proves the counter sees requests at all:
  await waitForStderr(
    fakeExtension,
    (stderr) => stderr.includes(STATUS_REQUEST_LINE),
    "the automatic status request on the fake extension's stderr",
  );

  // WHEN two calls are refused — one without a URL, one with a local file,
  sendMessage(bridge, toolsCall(60, { name: "browser_navigate", arguments: {} }));
  sendMessage(bridge, browserNavigateCall(61, "file:///etc/passwd"));
  const [missingUrl, fileUrl] = await Promise.all([waitForResponse(bridge, 60), waitForResponse(bridge, 61)]);

  // ... the first as a protocol error, the second as a tool error with the
  // German sentence,
  assert.equal(missingUrl.error.code, -32602);
  assert.equal(fileUrl.result.isError, true);
  assert.deepEqual(fileUrl.result.content, [{ type: "text", text: INVALID_URL_TEXT }]);

  // THEN neither of them reached the extension,
  assert.equal(
    navigateRequestCount(fakeExtension),
    0,
    `no navigate request may reach the extension:\n${fakeExtension.output.stderr}`,
  );

  // ... and the one allowed call afterwards is the only one that does. Exactly
  // one is the counter's own proof: a zero without it would also be green if the
  // fixture never counted.
  sendMessage(bridge, browserNavigateCall(62, "https://example.org/"));
  const success = await waitForResponse(bridge, 62);
  assert.deepEqual(JSON.parse(success.result.content[0].text), NAVIGATE_RESULT);
  await waitForStderr(
    fakeExtension,
    () => navigateRequestCount(fakeExtension) === 1,
    "exactly one navigate request on the fake extension's stderr",
  );
  assert.equal(navigateRequestCount(fakeExtension), 1);
});

test("mcp_toolsCallBrowserRead_withAConnectedExtension_shouldReturnAllSixFieldsAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a fake extension connected and its automatic status
  // request already answered:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN the client calls `browser_read`,
  sendMessage(bridge, browserReadCall(70));
  const response = await waitForResponse(bridge, 70);

  // THEN the answer is the extension's result as indented JSON, without an error
  // flag and with every field the contract promises:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");

  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_READ_RESULT);
  const parsed = JSON.parse(text);
  for (const field of ["tabId", "url", "title", "text", "truncated", "via"]) {
    assert.ok(Object.hasOwn(parsed, field), `${field} is missing`);
  }
  assert.deepEqual(parsed, READ_RESULT);
});

test("mcp_toolsCallBrowserRead_withTabIdInsteadOfTab_shouldReturnTheOnlyTabSentence", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count
  // before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the calls name the tab by the key the *extension answers* with (`tabId`)
  // and by a key nobody declares — both are arguments the schema forbids;
  // `tabId` is the near-miss this case exists for: the wire name is `tab`.
  sendMessage(bridge, toolsCall(71, { name: "browser_read", arguments: { tabId: 42 } }));
  sendMessage(bridge, toolsCall(121, { name: "browser_read", arguments: { x: 1 } }));

  // THEN each is a tool error with the sentence from the contract, not a protocol
  // error — same precedence as `browser_status`,
  for (const id of [71, 121]) {
    const response = await waitForResponse(bridge, id);
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: READ_UNEXPECTED_ARGUMENTS_TEXT }]);
    assert.equal(response.error, undefined);
  }

  // ... and neither refused call reached the extension.
  assert.equal(readRequestCount(fakeExtension), 0, "the refused call must not reach the extension");
});

test("mcp_toolsCallBrowserRead_whenThereIsNoAgentTab_shouldReturnTheNavigateFirstSentence", async (t) => {
  // GIVEN a fake extension that has no agent tab to read — the code the real one
  // answers when nothing was navigated yet, or the tab went away:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_READ_ANSWER: "error:no_agent_tab" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads,
  sendMessage(bridge, browserReadCall(72));
  const response = await waitForResponse(bridge, 72);

  // THEN it is advice, not a failure: the sentence names the call that fixes it,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_AGENT_TAB_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the request really went to the extension — the sentence comes from
  // its code, not from the bridge guessing.
  await waitForStderr(
    fakeExtension,
    () => readRequestCount(fakeExtension) === 1,
    "exactly one read request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserRead_whenThePageCannotBeRead_shouldReturnTheNotReadableSentence", async (t) => {
  // GIVEN a page the extension cannot inject into — a PDF viewer, `about:`:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_READ_ANSWER: "error:not_readable" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads,
  sendMessage(bridge, browserReadCall(73));
  const response = await waitForResponse(bridge, 73);

  // THEN the sentence explains the kind of page instead of leaking the code,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NOT_READABLE_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and this request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => readRequestCount(fakeExtension) === 1,
    "exactly one read request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserRead_whenThePageIsStillLoading_shouldReturnThePageBusySentence", async (t) => {
  // GIVEN a fake extension whose tab has not finished loading — the code the real
  // one answers when it is asked too early:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_READ_ANSWER: "error:page_busy" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads,
  sendMessage(bridge, browserReadCall(116));
  const response = await waitForResponse(bridge, 116);

  // THEN the sentence asks for the retry that is the whole fix — and not the
  // `not_readable` sentence, which would claim the page cannot be read at all,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: PAGE_BUSY_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the request really reached the extension.
  await waitForStderr(
    fakeExtension,
    () => readRequestCount(fakeExtension) === 1,
    "exactly one read request on the fake extension's stderr",
  );
});

/*
 * The same case with the details the extension sends today: `kind` and `url`
 * travel on the error frame and end up in the sentence. Table-driven because the
 * three differ only in that frame — and because the point is the rule behind them,
 * not three copies of one setup.
 */
for (const [index, { caseName, details, sentence }] of NOT_READABLE_DETAIL_CASES.entries()) {
  test(`mcp_toolsCallBrowserRead_whenNotReadableArrives${caseName}_shouldReturnASentenceWithTheAddress`, async (t) => {
    // GIVEN a fake extension that refuses the read and names the page it refused:
    const id = 74 + index;
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, {
      BC_TEST_READ_ANSWER: "error:not_readable",
      BC_TEST_ERROR_DETAILS: JSON.stringify(details),
    });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client reads,
    sendMessage(bridge, browserReadCall(id));
    const response = await waitForResponse(bridge, id);

    // THEN the sentence names what the extension knew and hides what it did not —
    // the address always, the kind only when the bridge knows the word,
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... and the details really came from the extension's own frame: the request
    // reached it.
    await waitForStderr(
      fakeExtension,
      () => readRequestCount(fakeExtension) === 1,
      "exactly one read request on the fake extension's stderr",
    );
  });
}

/* --------------------------------------------------- read: window and mode (spec 22, 23) */

/*
 * The window and `mode` cases of `browser_read`, through the exported seam and a hub that
 * records instead of asking. The one named exception to this file's spawn-a-process rule,
 * and the header says why: what these cases prove is the *argument set* on the wire, not
 * what the page answers. Types are checked by the bridge; the enum and the ranges are the
 * extension's (so `mode: "Artikel"` is a case in `test/extension.test.js`, not one here).
 * And because `test/fixtures/fake-extension.mjs` is locked, a read that reaches the fixture
 * proves that `mode` travels and that the answer passes through unchanged — never that
 * `root`/`fellBack` reach the client. That gap is a gap, not a proof.
 */

/** A hub that remembers every request the tool layer sends and answers one read result. */
function createRecordingHub() {
  const requests = [];

  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      return READ_RESULT;
    },
  };
}

/** One `tools/call` line through the seam the stdio and the HTTP transport share. */
async function callToolThroughTheSeam(call) {
  const hub = createRecordingHub();
  const answer = await handleMessageText(JSON.stringify(call), { hub, log: () => {} });
  return { answer, requests: hub.requests };
}

test("mcp_toolsCallBrowserRead_withAWindow_shouldPassExactlyTheSetKeysToTheExtension", async () => {
  // GIVEN the window of the spec's example, and a second caller that names no window:
  const withWindow = { offset: 20000, maxChars: 100 };

  // WHEN both reads go through the tool layer,
  const windowed = await callToolThroughTheSeam(browserReadCall(300, withWindow));
  const bare = await callToolThroughTheSeam(browserReadCall(301));

  // THEN the request carries exactly the two keys the caller set, in schema order — the
  // extension's defaults are what the absent keys fall back to, so the bridge fills in
  // nothing:
  assert.equal(windowed.requests.length, 1);
  assert.equal(windowed.requests[0].method, PROTOCOL.METHODS.READ);
  assert.deepEqual(windowed.requests[0].params, { offset: 20000, maxChars: 100 });

  // ... and a read without them puts no key on the wire at all: absent, not `null` and
  // not the default, because a request that named them would claim a window nobody
  // asked for — the hub's `read` line included.
  assert.equal(bare.requests.length, 1);
  assert.deepEqual(bare.requests[0].params, {});
  assert.deepEqual(Object.keys(bare.requests[0].params), []);

  // ... and both answers are the tool's ordinary indented JSON, so the pass-through did
  // not change the shape of what the client reads:
  assert.equal(windowed.answer.result.isError, undefined);
  assert.equal(windowed.answer.result.content[0].text, INDENTED_READ_RESULT);
});

test("mcp_toolsCallBrowserRead_withAWindowOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension", async () => {
  // GIVEN the values that look like numbers but are not the `integer` the schema
  // declares — a string and a fraction, for both window parameters:
  const refused = [{ offset: "5" }, { offset: 1.5 }, { maxChars: "100" }, { maxChars: 1.5 }];

  for (const args of refused) {
    // WHEN the client reads with that argument,
    const { answer, requests } = await callToolThroughTheSeam(browserReadCall(302, args));

    // THEN it is a malformed *request* (`-32602`), because the schema says `integer` and
    // the client broke the contract before the tool ever ran —
    assert.equal(answer.error?.code, -32602, `${JSON.stringify(args)} must answer -32602`);
    assert.equal(answer.result, undefined, `${JSON.stringify(args)} must not be a tool result`);

    // ... and nothing reached the extension: the refused call costs no round trip.
    assert.deepEqual(requests, [], `${JSON.stringify(args)} must not reach the extension`);
  }
});

test("mcp_toolsCallBrowserRead_withARangeOnlyTheExtensionChecks_shouldPassItThrough", async () => {
  // GIVEN the three values that are integers but outside the extension's ranges:
  const passedThrough = [{ offset: -1 }, { maxChars: 0 }, { maxChars: 100001 }];

  for (const args of passedThrough) {
    // WHEN the client reads with one of them,
    const { answer, requests } = await callToolThroughTheSeam(browserReadCall(303, args));

    // THEN the request really goes to the extension: the range check sits there, and a
    // second copy here would be a second opinion with its own drift — the same split
    // `inspect`'s `limit` has. The extension is what refuses these with `invalid_params`
    // (proved in `test/extension.test.js`, without an injection).
    assert.deepEqual(requests[0]?.params, args, `${JSON.stringify(args)} must travel`);
    assert.equal(answer.result.isError, undefined);
  }
});

test("mcp_toolsCallBrowserRead_withOnlyAMode_shouldPassThatOneKeyAndNoDefault", async () => {
  // GIVEN a caller that asks for the article body and names no window:
  const articleOnly = { mode: "article" };

  // WHEN the read goes through the tool layer,
  const { answer, requests } = await callToolThroughTheSeam(browserReadCall(304, articleOnly));

  // THEN the request carries the one key the caller set — absent, not `null` and not the
  // `"text"` the extension would fall back to, because a named default would claim the
  // caller asked for it:
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, PROTOCOL.METHODS.READ);
  assert.deepEqual(requests[0].params, { mode: "article" });
  assert.deepEqual(Object.keys(requests[0].params), ["mode"]);

  // ... and the answer is the tool's ordinary indented JSON, so the pass-through did not
  // change the shape of what the client reads:
  assert.equal(answer.result.isError, undefined);
  assert.equal(answer.result.content[0].text, INDENTED_READ_RESULT);
});

test("mcp_toolsCallBrowserRead_withWindowAndMode_shouldPassTheThreeKeysInSchemaOrder", async () => {
  // GIVEN a caller that names the window and the mode together — `offset: 0` is set on
  // purpose: the default has to survive as a *sent* value, not be swallowed as absent:
  const windowAndMode = { offset: 0, maxChars: 100, mode: "article" };

  // WHEN the read goes through the tool layer,
  const { requests } = await callToolThroughTheSeam(browserReadCall(305, windowAndMode));

  // THEN exactly these three keys travel, in the order the schema declares them — the
  // wire payload reads like the tool description instead of like the caller's key order:
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, { offset: 0, maxChars: 100, mode: "article" });
  assert.deepEqual(Object.keys(requests[0].params), ["offset", "maxChars", "mode"]);
});

test("mcp_toolsCallBrowserRead_withAModeOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension", async () => {
  // GIVEN the values that are not the `string` the schema declares — a number, `null`
  // and an array. Note what is *not* here: a string that is not one of the two modes. The
  // bridge checks the type, the extension checks the enum, and `"Artikel"` is that case
  // in `test/extension.test.js`.
  const refused = [{ mode: 1 }, { mode: null }, { mode: ["article"] }];

  for (const args of refused) {
    // WHEN the client reads with that argument,
    const { answer, requests } = await callToolThroughTheSeam(browserReadCall(306, args));

    // THEN it is a malformed *request* (`-32602`), because the schema says `string` and
    // the client broke the contract before the tool ever ran —
    assert.equal(answer.error?.code, -32602, `${JSON.stringify(args)} must answer -32602`);
    assert.equal(answer.result, undefined, `${JSON.stringify(args)} must not be a tool result`);

    // ... and nothing reached the extension.
    assert.deepEqual(requests, [], `${JSON.stringify(args)} must not reach the extension`);
  }
});

test("mcp_toolsCallBrowserRead_withAnUndeclaredArgument_shouldAnswerTheFullArgumentSet", async () => {
  // GIVEN a caller that guesses the German key instead of `mode`:
  const germanKey = { artikel: true };

  // WHEN the call goes through the tool layer,
  const { answer, requests } = await callToolThroughTheSeam(browserReadCall(307, germanKey));

  // THEN it is a tool error naming every argument the tool does accept — the sentence is
  // the caller's map back to the schema, so each key has to be in it:
  assert.equal(answer.result.isError, true);
  assert.deepEqual(answer.result.content, [{ type: "text", text: READ_UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(answer.error, undefined);

  // ... and a forbidden key costs no round trip.
  assert.deepEqual(requests, []);
});

test("mcp_toolsCallBrowserRead_whenTheOffsetIsBehindTheText_shouldReturnASentenceNamingTheLength", async (t) => {
  // GIVEN a fake extension that refuses the read the way the page does, with the length
  // of the whole text in the message — the number the caller pages by:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, {
    BC_TEST_READ_ANSWER: "error:offset_out_of_range",
    BC_TEST_ERROR_DETAILS: JSON.stringify(OFFSET_OUT_OF_RANGE_DETAILS),
  });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads from a place behind the end,
  sendMessage(bridge, browserReadCall(117, { offset: 999999 }));
  const response = await waitForResponse(bridge, 117);

  // THEN the sentence for that code repeats the extension's own message — the length is
  // inside it — and is not the generic `code=…` catch-all:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: OFFSET_OUT_OF_RANGE_TEXT }]);
  assert.equal(response.error, undefined);

  // ... because the request really went to the extension: the numbers come from its
  // answer, not from the bridge guessing.
  await waitForStderr(
    fakeExtension,
    () => readRequestCount(fakeExtension) === 1,
    "exactly one read request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserRead_whenTheWindowIsRefused_shouldReturnASentenceNamingTheBound", async (t) => {
  // GIVEN a fake extension that refuses the window the way the page does — `maxChars: 0`
  // — and names the parameter with its bounds in the message:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, {
    BC_TEST_READ_ANSWER: "error:invalid_params",
    BC_TEST_ERROR_DETAILS: JSON.stringify(INVALID_READ_PARAMS_DETAILS),
  });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads with a window the extension cannot honour,
  sendMessage(bridge, browserReadCall(118, { maxChars: 0 }));
  const response = await waitForResponse(bridge, 118);

  // THEN the sentence repeats the extension's message, so the parameter and its number
  // travel — and the answer is not the generic catch-all, which would leave the agent
  // guessing which argument to change:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: INVALID_READ_PARAMS_TEXT }]);
  assert.ok(INVALID_READ_PARAMS_TEXT.includes("100000"), "the bound from the message must travel");
  assert.notEqual(response.result.content[0].text, CALL_EXTENSION_FAILED_TEXT);
  assert.equal(response.error, undefined);

  // ... because the request really went to the extension: the wording is its own.
  await waitForStderr(
    fakeExtension,
    () => readRequestCount(fakeExtension) === 1,
    "exactly one read request on the fake extension's stderr",
  );
});

/* ------------------------------------------------------------ read: frame (spec 24) */

test("mcp_toolsCallBrowserRead_withAFrame_shouldPassTheSubstringInSchemaOrder", async () => {
  // GIVEN a caller that addresses an iframe, with the window beside it — and a second one
  // that sends the empty string, which the bridge does not judge:
  const withWindow = { maxChars: 100, frame: FRAME_SUBSTRING };
  const empty = { frame: "" };

  // WHEN both reads go through the tool layer,
  const windowed = await callToolThroughTheSeam(browserReadCall(320, withWindow));
  const blank = await callToolThroughTheSeam(browserReadCall(321, empty));

  // THEN the substring travels after `mode` and before `tab`, exactly where the schema
  // declares it — the wire payload reads like the tool description:
  assert.equal(windowed.requests.length, 1);
  assert.equal(windowed.requests[0].method, PROTOCOL.METHODS.READ);
  assert.deepEqual(windowed.requests[0].params, { maxChars: 100, frame: FRAME_SUBSTRING });
  assert.deepEqual(Object.keys(windowed.requests[0].params), ["maxChars", "frame"]);

  // ... and `""` really is sent: `minLength: 1` is the schema's statement, the extension
  // is what refuses an empty substring with `invalid_params` before injecting anything —
  // the same split every other range in this file has.
  assert.deepEqual(blank.requests[0]?.params, { frame: "" });

  // ... and both answers are the tool's ordinary indented JSON.
  assert.equal(windowed.answer.result.isError, undefined);
  assert.equal(windowed.answer.result.content[0].text, INDENTED_READ_RESULT);
});

test("mcp_toolsCallBrowserRead_withAFrameOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension", async () => {
  // GIVEN the values that are not the `string` the schema declares — a number, `null`
  // and an array:
  const refused = [{ frame: 1 }, { frame: null }, { frame: [FRAME_SUBSTRING] }];

  for (const args of refused) {
    // WHEN the client reads with that argument,
    const { answer, requests } = await callToolThroughTheSeam(browserReadCall(322, args));

    // THEN it is a malformed *request* (`-32602`), because the schema says `string` and
    // the client broke the contract before the tool ever ran —
    assert.equal(answer.error?.code, -32602, `${JSON.stringify(args)} must answer -32602`);
    assert.equal(answer.result, undefined, `${JSON.stringify(args)} must not be a tool result`);

    // ... and nothing reached the extension.
    assert.deepEqual(requests, [], `${JSON.stringify(args)} must not reach the extension`);
  }
});

test("mcp_toolsCallBrowserRead_whenTheFrameMatchesNothing_shouldReturnASentenceNamingTheAnsweredCount", async (t) => {
  // GIVEN a fake extension that refuses the read the way the filter does, and says how
  // many frames answered:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, {
    BC_TEST_READ_ANSWER: "error:frame_not_found",
    BC_TEST_ERROR_DETAILS: JSON.stringify(FRAME_NOT_FOUND_DETAILS),
  });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads with a substring no frame matches, naming the tab as well,
  sendMessage(bridge, browserReadCall(119, { tab: 42, frame: FRAME_SUBSTRING }));
  const response = await waitForResponse(bridge, 119);

  // THEN the sentence is that code's own, with the count as the extension sent it —
  // not the generic catch-all:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: FRAME_NOT_FOUND_WITH_COUNT_TEXT }]);
  assert.notEqual(response.result.content[0].text, FRAME_NOT_FOUND_TEXT);
  assert.equal(response.error, undefined);

  // ... and the request really went to the extension — with both arguments on the wire
  // and the substring announced only as its presence, the address itself nowhere on
  // stderr:
  await waitForStderr(
    fakeExtension,
    () => requestLines(fakeExtension, READ_REQUEST_LINE).length === 1,
    "exactly one read request on the fake extension's stderr",
  );
  assert.deepEqual(requestLines(fakeExtension, READ_REQUEST_LINE), [
    `${READ_REQUEST_LINE} tab=42 frame=yes`,
  ]);
  assert.deepEqual(requestedTabs(fakeExtension, READ_REQUEST_LINE), [42]);
  assert.ok(!fakeExtension.output.stderr.includes(FRAME_SUBSTRING), "the substring must not be logged");
});

test("mcp_toolsCallBrowserRead_whenTwoFramesMatch_shouldReturnASentenceNamingTheCandidates", async (t) => {
  // GIVEN a fake extension that refuses the read as ambiguous, with the colliding
  // addresses in `details`:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, {
    BC_TEST_READ_ANSWER: "error:frame_ambiguous",
    BC_TEST_ERROR_DETAILS: JSON.stringify(FRAME_AMBIGUOUS_DETAILS),
  });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads with a substring both frames match,
  sendMessage(bridge, browserReadCall(120, { frame: FRAME_SUBSTRING }));
  const response = await waitForResponse(bridge, 120);

  // THEN the sentence names every candidate, because only they say how to answer more
  // precisely — and it is not the sentence for "no frame at all":
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [
    { type: "text", text: FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT },
  ]);
  for (const candidate of FRAME_CANDIDATES) {
    assert.ok(response.result.content[0].text.includes(candidate), `${candidate} is missing`);
  }
  assert.equal(response.error, undefined);
});

test("mcp_toolsCallBrowserRead_withAFrameAndNoDetailsInTheRefusal_shouldAnswerTheShorterSentence", async (t) => {
  // GIVEN a fake extension that refuses both frame codes *without* `details` — the
  // extension always sends them, so this is the bridge's own fallback path:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port, { BC_TEST_READ_ANSWER: "error:frame_not_found" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads with a substring,
  sendMessage(bridge, browserReadCall(121, { frame: FRAME_SUBSTRING }));
  const response = await waitForResponse(bridge, 121);

  // THEN the shorter sentence stands — a bridge that printed "(geantwortete Rahmen:
  // undefined)" would be worse than one that says less:
  assert.deepEqual(response.result.content, [{ type: "text", text: FRAME_NOT_FOUND_TEXT }]);
  assert.ok(!response.result.content[0].text.includes("undefined"));
});

/* ------------------------------------------------------------------- click */

test("mcp_toolsCallBrowserClick_withAConnectedExtension_shouldReturnAllNineFieldsAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a fake extension connected and its automatic status
  // request already answered:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN the client clicks a selector,
  sendMessage(bridge, browserClickCall(80, CLICK_SELECTOR));
  const response = await waitForResponse(bridge, 80);

  // THEN the answer is the extension's result as indented JSON, without an error
  // flag and with every field the contract promises — `clicked` is what makes it
  // a click answer rather than a read answer:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");

  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_CLICK_RESULT);
  const parsed = JSON.parse(text);
  for (const field of ["tabId", "url", "title", "clicked", "text", "truncated", "via"]) {
    assert.ok(Object.hasOwn(parsed, field), `${field} is missing`);
  }
  assert.deepEqual(parsed, CLICK_RESULT);

  // ... and exactly one click request reached the extension.
  await waitForStderr(
    fakeExtension,
    () => clickRequestCount(fakeExtension) === 1,
    "exactly one click request on the fake extension's stderr",
  );
  assert.equal(clickRequestCount(fakeExtension), 1);
});

test("mcp_toolsCallBrowserClick_withoutAUsableSelector_shouldAnswerInvalidParamsAndNeverReachTheExtension", async (t) => {
  // GIVEN a bridge with a connected fake extension — one run, because the counter
  // has to count before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );
  await waitForStderr(
    fakeExtension,
    (stderr) => stderr.includes(STATUS_REQUEST_LINE),
    "the automatic status request on the fake extension's stderr",
  );

  // WHEN two calls are refused — one without a selector, one with a selector that
  // is not a string,
  sendMessage(bridge, toolsCall(81, { name: "browser_click", arguments: {} }));
  sendMessage(bridge, toolsCall(82, { name: "browser_click", arguments: { selector: 7 } }));
  const [missing, notAString] = await Promise.all([waitForResponse(bridge, 81), waitForResponse(bridge, 82)]);

  // THEN both are protocol errors: the schema declares the field required, so the
  // client broke the contract before the tool ever ran,
  assert.equal(missing.error.code, -32602);
  assert.equal(notAString.error.code, -32602);
  assert.equal(missing.result, undefined);

  // ... and neither of them reached the extension,
  assert.equal(
    clickRequestCount(fakeExtension),
    0,
    `no click request may reach the extension:\n${fakeExtension.output.stderr}`,
  );

  // ... while the allowed call afterwards is the one that does. Exactly one is
  // the counter's own proof: a zero without it would also be green if the fixture
  // never counted.
  sendMessage(bridge, browserClickCall(83, CLICK_SELECTOR));
  const success = await waitForResponse(bridge, 83);
  assert.deepEqual(JSON.parse(success.result.content[0].text), CLICK_RESULT);
  await waitForStderr(
    fakeExtension,
    () => clickRequestCount(fakeExtension) === 1,
    "exactly one click request on the fake extension's stderr",
  );
  assert.equal(clickRequestCount(fakeExtension), 1);
});

test("mcp_toolsCallBrowserClick_withAnUnknownArgument_shouldReturnTheOnlySelectorAndTabSentence", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count
  // before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the call carries an argument the schema forbids,
  sendMessage(bridge, toolsCall(84, { name: "browser_click", arguments: { selector: CLICK_SELECTOR, x: 1 } }));
  const response = await waitForResponse(bridge, 84);

  // THEN it is a tool error with the sentence from the contract, not a protocol
  // error — the request itself was well-formed,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: CLICK_UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the refused call never reached the extension.
  assert.equal(clickRequestCount(fakeExtension), 0, "the refused call must not reach the extension");
});

/*
 * One case per refusal that names the selector: `invalid_selector`, `no_match` and
 * `not_clickable` are three different pieces of advice, and each has to arrive as
 * its own German sentence instead of the generic `code=…` line. Table-driven
 * because the three differ only in the code the fake extension answers with.
 */
const CLICK_REFUSAL_CASES = [
  { code: "invalid_selector", caseName: "AnInvalidSelector", sentence: INVALID_SELECTOR_TEXT },
  { code: "no_match", caseName: "NoMatchingElement", sentence: NO_MATCH_TEXT },
  { code: "not_clickable", caseName: "ANotClickableElement", sentence: NOT_CLICKABLE_TEXT },
];

for (const { code, caseName, sentence } of CLICK_REFUSAL_CASES) {
  test(`mcp_toolsCallBrowserClick_whenTheExtensionAnswers${caseName}_shouldReturnTheSentenceForThatCode`, async (t) => {
    // GIVEN a fake extension that refuses the click with exactly this code:
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_CLICK_ANSWER: `error:${code}` });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client clicks,
    sendMessage(bridge, browserClickCall(85, CLICK_SELECTOR));
    const response = await waitForResponse(bridge, 85);

    // THEN it gets the sentence that names the selector it sent — not the code,
    // and not the generic catch-all,
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... because the request really went to the extension: the sentence comes
    // from its code, not from the bridge guessing.
    await waitForStderr(
      fakeExtension,
      () => clickRequestCount(fakeExtension) === 1,
      "exactly one click request on the fake extension's stderr",
    );
  });
}

test("mcp_toolsCallBrowserClick_whenThereIsNoAgentTab_shouldReturnTheSameSentenceAsBrowserRead", async (t) => {
  // GIVEN a fake extension that has no agent tab to click in:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_CLICK_ANSWER: "error:no_agent_tab" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client clicks,
  sendMessage(bridge, browserClickCall(86, CLICK_SELECTOR));
  const response = await waitForResponse(bridge, 86);

  // THEN it is the advice `browser_read` gives, word for word — two wordings for
  // "open a tab first" would be one too many,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_AGENT_TAB_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and this request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => clickRequestCount(fakeExtension) === 1,
    "exactly one click request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserClick_whenThePageIsStillLoading_shouldReturnThePageBusySentence", async (t) => {
  // GIVEN a fake extension whose tab has not finished loading:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_CLICK_ANSWER: "error:page_busy" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client clicks,
  sendMessage(bridge, browserClickCall(117, CLICK_SELECTOR));
  const response = await waitForResponse(bridge, 117);

  // THEN it gets the same sentence `browser_read` gives — one code, one wording,
  // whichever tool walked into the loading page,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: PAGE_BUSY_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => clickRequestCount(fakeExtension) === 1,
    "exactly one click request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserClick_whenTheClickWasSuperseded_shouldReturnTheGenericSentenceWithTheCode", async (t) => {
  // GIVEN a fake extension whose click is replaced by a newer one — the case the
  // real extension answers when two clicks overlap:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_CLICK_ANSWER: "error:superseded" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client clicks,
  sendMessage(bridge, browserClickCall(87, CLICK_SELECTOR));
  const response = await waitForResponse(bridge, 87);

  // THEN it gets the generic sentence with the code inside it, quoted here
  // instead of imported so a changed sentence turns this red — `superseded` is
  // not advice the operator could act on, so it keeps its code,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [
    { type: "text", text: "Die Extension konnte die Anfrage nicht ausführen (code=superseded)." },
  ]);

  // ... and the request reached the extension.
  await waitForStderr(
    fakeExtension,
    () => clickRequestCount(fakeExtension) === 1,
    "exactly one click request on the fake extension's stderr",
  );
});

/* -------------------------------------------------------------------- type */

test("mcp_toolsCallBrowserType_withAConnectedExtension_shouldReturnAllEightFieldsAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a fake extension connected and its automatic status
  // request already answered:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN the client types into a field — without `submit`, which is the normal
  // case and has to work without a third argument:
  sendMessage(bridge, browserTypeCall(90, TYPE_SELECTOR, TYPE_TEXT));
  const response = await waitForResponse(bridge, 90);

  // THEN the answer is the extension's result as indented JSON, without an error
  // flag and with every field the contract promises — `typed` and `submitted` are
  // what make it a type answer rather than a read answer:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");

  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_TYPE_RESULT);
  const parsed = JSON.parse(text);
  for (const field of ["tabId", "url", "title", "typed", "submitted", "text", "truncated", "via"]) {
    assert.ok(Object.hasOwn(parsed, field), `${field} is missing`);
  }
  assert.deepEqual(parsed, TYPE_RESULT);

  // ... and the text that was typed is not in it: `typed` describes the element,
  // never the value, so the answer cannot become a second log of the input,
  assert.ok(!text.includes(TYPE_TEXT), "the typed text must not appear in the answer");

  // ... and exactly one type request reached the extension.
  await waitForStderr(
    fakeExtension,
    () => typeRequestCount(fakeExtension) === 1,
    "exactly one type request on the fake extension's stderr",
  );
  assert.equal(typeRequestCount(fakeExtension), 1);
});

test("mcp_toolsCallBrowserType_withoutAUsableText_shouldAnswerInvalidParamsAndNeverReachTheExtension", async (t) => {
  // GIVEN a bridge with a connected fake extension — one run, because the counter
  // has to count before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );
  await waitForStderr(
    fakeExtension,
    (stderr) => stderr.includes(STATUS_REQUEST_LINE),
    "the automatic status request on the fake extension's stderr",
  );

  // WHEN two calls are refused — one without a text, one with a text that is not
  // a string,
  sendMessage(bridge, toolsCall(91, { name: "browser_type", arguments: { selector: TYPE_SELECTOR } }));
  sendMessage(bridge, toolsCall(92, { name: "browser_type", arguments: { selector: TYPE_SELECTOR, text: 7 } }));
  const [missing, notAString] = await Promise.all([waitForResponse(bridge, 91), waitForResponse(bridge, 92)]);

  // THEN both are protocol errors: the schema declares `text` required, so the
  // client broke the contract before the tool ever ran,
  assert.equal(missing.error.code, -32602);
  assert.equal(notAString.error.code, -32602);
  assert.equal(missing.result, undefined);

  // ... and neither of them reached the extension,
  assert.equal(
    typeRequestCount(fakeExtension),
    0,
    `no type request may reach the extension:\n${fakeExtension.output.stderr}`,
  );

  // ... while the allowed call afterwards is the one that does. Exactly one is
  // the counter's own proof: a zero without it would also be green if the fixture
  // never counted.
  sendMessage(bridge, browserTypeCall(93, TYPE_SELECTOR, TYPE_TEXT));
  const success = await waitForResponse(bridge, 93);
  assert.deepEqual(JSON.parse(success.result.content[0].text), TYPE_RESULT);
  await waitForStderr(
    fakeExtension,
    () => typeRequestCount(fakeExtension) === 1,
    "exactly one type request on the fake extension's stderr",
  );
  assert.equal(typeRequestCount(fakeExtension), 1);
});

test("mcp_toolsCallBrowserType_withASubmitThatIsNotABoolean_shouldAnswerInvalidParamsInsteadOfBlamingTheExtension", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count
  // before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN `submit` arrives as the string a sloppy client likes to send,
  sendMessage(
    bridge,
    toolsCall(94, { name: "browser_type", arguments: { selector: TYPE_SELECTOR, text: TYPE_TEXT, submit: "true" } }),
  );
  const response = await waitForResponse(bridge, 94);

  // THEN it is a malformed request, not a tool error: letting it through would
  // come back as "the extension could not run the request", which blames the
  // wrong side of the wire for a client mistake,
  assert.equal(response.error.code, -32602);
  assert.equal(response.error.message, "invalid params");
  assert.equal(response.result, undefined);

  // ... and the refused call never reached the extension,
  assert.equal(typeRequestCount(fakeExtension), 0, "the refused call must not reach the extension");

  // ... while the same call with a real boolean is the one that does.
  sendMessage(
    bridge,
    toolsCall(95, { name: "browser_type", arguments: { selector: TYPE_SELECTOR, text: TYPE_TEXT, submit: true } }),
  );
  const accepted = await waitForResponse(bridge, 95);
  assert.deepEqual(JSON.parse(accepted.result.content[0].text), TYPE_RESULT);
  await waitForStderr(
    fakeExtension,
    () => typeRequestCount(fakeExtension) === 1,
    "exactly one type request on the fake extension's stderr",
  );
  assert.equal(typeRequestCount(fakeExtension), 1);
});

test("mcp_toolsCallBrowserType_withAnUnknownArgument_shouldReturnTheOnlyFourKeysSentence", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count
  // before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the call carries an argument the schema forbids — `enter` spells the
  // intent of `submit`, which is exactly the kind of near-miss the sentence is for,
  sendMessage(
    bridge,
    toolsCall(96, { name: "browser_type", arguments: { selector: TYPE_SELECTOR, text: TYPE_TEXT, enter: true } }),
  );
  const response = await waitForResponse(bridge, 96);

  // THEN it is a tool error with the sentence from the contract, not a protocol
  // error — the request itself was well-formed,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: TYPE_UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the refused call never reached the extension.
  assert.equal(typeRequestCount(fakeExtension), 0, "the refused call must not reach the extension");
});

/*
 * One case per refusal `type` has to translate: `no_match` names the selector,
 * `not_typeable` adds the describing half, and `password_not_allowed` is the only
 * sentence of this tool that names no element — it names the switch instead.
 * Table-driven because the three differ only in the code the fake extension
 * answers with.
 */
const TYPE_REFUSAL_CASES = [
  { code: "no_match", caseName: "NoMatchingElement", sentence: TYPE_NO_MATCH_TEXT },
  { code: "not_typeable", caseName: "AnElementThatTakesNoText", sentence: NOT_TYPEABLE_TEXT },
  { code: "password_not_allowed", caseName: "ALockedPasswordField", sentence: PASSWORD_NOT_ALLOWED_TEXT },
];

for (const { code, caseName, sentence } of TYPE_REFUSAL_CASES) {
  test(`mcp_toolsCallBrowserType_whenTheExtensionAnswers${caseName}_shouldReturnTheSentenceForThatCode`, async (t) => {
    // GIVEN a fake extension that refuses the type call with exactly this code:
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_TYPE_ANSWER: `error:${code}` });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client types,
    sendMessage(bridge, browserTypeCall(97, TYPE_SELECTOR, TYPE_TEXT));
    const response = await waitForResponse(bridge, 97);

    // THEN it gets the sentence for that code — not the code, and not the generic
    // catch-all,
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... because the request really went to the extension: the sentence comes
    // from its code, not from the bridge guessing.
    await waitForStderr(
      fakeExtension,
      () => typeRequestCount(fakeExtension) === 1,
      "exactly one type request on the fake extension's stderr",
    );
  });
}

test("mcp_toolsCallBrowserType_whenThereIsNoAgentTab_shouldReturnTheSameSentenceAsBrowserRead", async (t) => {
  // GIVEN a fake extension that has no agent tab to type in:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_TYPE_ANSWER: "error:no_agent_tab" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client types,
  sendMessage(bridge, browserTypeCall(98, TYPE_SELECTOR, TYPE_TEXT));
  const response = await waitForResponse(bridge, 98);

  // THEN it is the advice `browser_read` gives, word for word — a second wording
  // for "open a tab first" would be one too many,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_AGENT_TAB_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and this request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => typeRequestCount(fakeExtension) === 1,
    "exactly one type request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserType_whenThePageIsStillLoading_shouldReturnThePageBusySentence", async (t) => {
  // GIVEN a fake extension whose tab has not finished loading:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_TYPE_ANSWER: "error:page_busy" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client types,
  sendMessage(bridge, browserTypeCall(118, TYPE_SELECTOR, TYPE_TEXT));
  const response = await waitForResponse(bridge, 118);

  // THEN it gets the same sentence `browser_read` and `browser_click` give:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: PAGE_BUSY_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => typeRequestCount(fakeExtension) === 1,
    "exactly one type request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserType_whenTheTypeCallWasSuperseded_shouldReturnTheGenericSentenceWithTheCode", async (t) => {
  // GIVEN a fake extension whose type call is replaced by a newer one — the case
  // the real extension answers when two calls overlap:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_TYPE_ANSWER: "error:superseded" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client types,
  sendMessage(bridge, browserTypeCall(99, TYPE_SELECTOR, TYPE_TEXT));
  const response = await waitForResponse(bridge, 99);

  // THEN it gets the generic sentence with the code inside it, quoted here
  // instead of imported so a changed sentence turns this red — `superseded` is not
  // advice the operator could act on, so it keeps its code,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [
    { type: "text", text: "Die Extension konnte die Anfrage nicht ausführen (code=superseded)." },
  ]);

  // ... and the request reached the extension.
  await waitForStderr(
    fakeExtension,
    () => typeRequestCount(fakeExtension) === 1,
    "exactly one type request on the fake extension's stderr",
  );
});

/* ------------------------------------------------------------------- focus */

test("mcp_toolsCallBrowserFocus_withAConnectedExtension_shouldReturnAllSixFieldsAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a fake extension connected and its automatic status
  // request already answered:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN the client calls `browser_focus`,
  sendMessage(bridge, browserFocusCall(100));
  const response = await waitForResponse(bridge, 100);

  // THEN the answer is the extension's result as indented JSON, without an error
  // flag and with every field the contract promises:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");

  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_FOCUS_RESULT);
  const parsed = JSON.parse(text);
  for (const field of ["tabId", "windowId", "url", "title", "active", "focused"]) {
    assert.ok(Object.hasOwn(parsed, field), `${field} is missing`);
  }
  assert.deepEqual(parsed, FOCUS_RESULT);

  // ... and the request really went to the extension.
  await waitForStderr(
    fakeExtension,
    () => focusRequestCount(fakeExtension) === 1,
    "exactly one focus request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserFocus_withAnArgument_shouldReturnTheOnlyTabSentence", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count
  // before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the call carries an argument the schema forbids,
  sendMessage(bridge, toolsCall(101, { name: "browser_focus", arguments: { x: 1 } }));
  const response = await waitForResponse(bridge, 101);

  // THEN it is a tool error with the sentence from the contract, not a protocol
  // error — same precedence as `browser_read`,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: FOCUS_UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the refused call never reached the extension.
  assert.equal(focusRequestCount(fakeExtension), 0, "the refused call must not reach the extension");
});

test("mcp_toolsCallBrowserFocus_whenThereIsNoAgentTab_shouldReturnTheSameSentenceAsBrowserRead", async (t) => {
  // GIVEN a fake extension with no agent tab to bring forward — nothing was
  // navigated yet, or the tab went away:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_FOCUS_ANSWER: "error:no_agent_tab" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client focuses,
  sendMessage(bridge, browserFocusCall(102));
  const response = await waitForResponse(bridge, 102);

  // THEN it is advice, not a failure: the sentence names the call that fixes it,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_AGENT_TAB_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the request really went to the extension — the sentence comes from
  // its code, not from the bridge guessing.
  await waitForStderr(
    fakeExtension,
    () => focusRequestCount(fakeExtension) === 1,
    "exactly one focus request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserFocus_whenTheFocusFailed_shouldReturnTheGenericSentenceWithTheCode", async (t) => {
  // GIVEN a fake extension whose `tabs.update` threw — the tab was gone between
  // the lookup and the update (a closed window is not this case: it answers
  // `ok:true` with `focused:false`):
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_FOCUS_ANSWER: "error:focus_failed" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client focuses,
  sendMessage(bridge, browserFocusCall(103));
  const response = await waitForResponse(bridge, 103);

  // THEN the generic sentence carries the code: the bridge cannot tell why the tab
  // did not come forward, and inventing advice would be a guess,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: FOCUS_FAILED_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and this request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => focusRequestCount(fakeExtension) === 1,
    "exactly one focus request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserInspect_withAConnectedExtension_shouldReturnAllSixResultFieldsAndEveryElementField", async (t) => {
  // GIVEN a bridge with a fake extension connected and its automatic status
  // request already answered:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN the client asks for the elements behind a selector,
  sendMessage(bridge, browserInspectCall(110, { selector: INSPECT_SELECTOR }));
  const response = await waitForResponse(bridge, 110);

  // THEN the answer is the extension's result as indented JSON, without an error
  // flag:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");

  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_INSPECT_RESULT);
  const parsed = JSON.parse(text);
  for (const field of ["tabId", "url", "title", "count", "truncated", "elements"]) {
    assert.ok(Object.hasOwn(parsed, field), `${field} is missing`);
  }
  assert.deepEqual(parsed, INSPECT_RESULT);

  // ... and every element carries the eleven documented fields. `selector` is the
  // one that matters most: it is the handle `browser_click` accepts, and `index` is
  // only a position in this array — not a second way to reach the element.
  assert.equal(parsed.elements.length, 1);
  for (const field of [
    "index",
    "selector",
    "tag",
    "id",
    "classes",
    "text",
    "href",
    "ariaLabel",
    "visible",
    "disabled",
    "rect",
  ]) {
    assert.ok(Object.hasOwn(parsed.elements[0], field), `${field} is missing on the element`);
  }

  // ... and exactly one inspect request reached the extension.
  await waitForStderr(
    fakeExtension,
    () => inspectRequestCount(fakeExtension) === 1,
    "exactly one inspect request on the fake extension's stderr",
  );
  assert.equal(inspectRequestCount(fakeExtension), 1);
});

test("mcp_toolsCallBrowserInspect_withoutASelectorAndWithoutText_shouldReturnTheNeedsFilterSentenceAndNeverReachTheExtension", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count
  // before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    fakeExtension,
    (stderr) => stderr.includes(STATUS_REQUEST_LINE),
    "the automatic status request on the fake extension's stderr",
  );

  // WHEN the call carries neither filter — once as an empty argument object, once
  // as no `arguments` at all,
  sendMessage(bridge, browserInspectCall(111, {}));
  sendMessage(bridge, toolsCall(112, { name: "browser_inspect" }));
  const [emptyArguments, noArguments] = await Promise.all([
    waitForResponse(bridge, 111),
    waitForResponse(bridge, 112),
  ]);

  // THEN both get the sentence that names the two arguments a caller could have
  // sent — not the protocol error and not the extension's `invalid_params` line,
  for (const response of [emptyArguments, noArguments]) {
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: INSPECT_NEEDS_FILTER_TEXT }]);
    assert.equal(response.error, undefined);
  }

  // ... and neither reached the extension: the missing filter is decided here.
  assert.equal(
    inspectRequestCount(fakeExtension),
    0,
    `no inspect request may reach the extension:\n${fakeExtension.output.stderr}`,
  );
});

test("mcp_toolsCallBrowserInspect_whenTheExtensionAnswersInvalidSelector_shouldReturnTheSentenceWithTheSelector", async (t) => {
  // GIVEN a fake extension whose `querySelectorAll` threw — the selector the caller
  // sent is not something the page can parse:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_INSPECT_ANSWER: "error:invalid_selector" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client inspects,
  sendMessage(bridge, browserInspectCall(113, { selector: INSPECT_SELECTOR }));
  const response = await waitForResponse(bridge, 113);

  // THEN it gets the sentence that repeats the selector it sent — the value the
  // operator would paste back, not the bare code,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: INSPECT_INVALID_SELECTOR_TEXT }]);
  assert.equal(response.error, undefined);

  // ... because the request really went to the extension, and exactly one did.
  await waitForStderr(
    fakeExtension,
    () => inspectRequestCount(fakeExtension) === 1,
    "exactly one inspect request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserInspect_whenTheExtensionAnswersInvalidParams_shouldReturnItsOwnSentenceInsteadOfTheGenericOne", async (t) => {
  // GIVEN a fake extension that refuses the parameters with `invalid_params` and a
  // caller that sends `limit: 201` — a client that ignores the schema's range:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_INSPECT_ANSWER: "error:invalid_params" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client inspects with that limit,
  sendMessage(bridge, browserInspectCall(115, { selector: INSPECT_SELECTOR, limit: 201 }));
  const response = await waitForResponse(bridge, 115);

  // THEN the sentence is the one for a refused parameter — not the generic
  // `code=…` line, and without a field name the bridge never checked,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: INSPECT_INVALID_PARAMS_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the out-of-range limit really travelled to the extension: the bridge
  // leaves the range to the side that owns the rule. A call refused at the bridge
  // would leave the counter at zero and prove nothing about that division.
  await waitForStderr(
    fakeExtension,
    () => inspectRequestCount(fakeExtension) === 1,
    "exactly one inspect request on the fake extension's stderr",
  );
});

/*
 * `inspect` has its own mapper, so the same three shapes are proven through it as
 * well: two sentence builders would be one too many, and a shared one that nobody
 * wired into the second place is exactly the bug a single case would miss.
 */
for (const [index, { caseName, details, sentence }] of NOT_READABLE_DETAIL_CASES.entries()) {
  test(`mcp_toolsCallBrowserInspect_whenNotReadableArrives${caseName}_shouldReturnTheSameSentenceAsBrowserRead`, async (t) => {
    // GIVEN a fake extension that refuses the inspect and names the page:
    const id = 116 + index;
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, {
      BC_TEST_INSPECT_ANSWER: "error:not_readable",
      BC_TEST_ERROR_DETAILS: JSON.stringify(details),
    });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client inspects a page the extension cannot reach into,
    sendMessage(bridge, browserInspectCall(id, { selector: INSPECT_SELECTOR }));
    const response = await waitForResponse(bridge, id);

    // THEN the sentence is the one `browser_read` would give for the same frame —
    // same page, same news, so a second wording would be a second opinion,
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... and the request reached the extension, so the details are its own.
    await waitForStderr(
      fakeExtension,
      () => inspectRequestCount(fakeExtension) === 1,
      "exactly one inspect request on the fake extension's stderr",
    );
  });
}

test("mcp_toolsCallBrowserInspect_whenThereIsNoAgentTab_shouldReturnTheSameSentenceAsBrowserRead", async (t) => {
  // GIVEN a fake extension that has no agent tab to inspect:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_INSPECT_ANSWER: "error:no_agent_tab" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client inspects,
  sendMessage(bridge, browserInspectCall(114, { selector: INSPECT_SELECTOR }));
  const response = await waitForResponse(bridge, 114);

  // THEN it is the same advice `browser_read` gives, word for word — two wordings
  // for "open a tab first" would be one too many,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_AGENT_TAB_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and this request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => inspectRequestCount(fakeExtension) === 1,
    "exactly one inspect request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserInspect_whenThePageIsStillLoading_shouldReturnThePageBusySentence", async (t) => {
  // GIVEN a fake extension whose tab has not finished loading:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_INSPECT_ANSWER: "error:page_busy" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client inspects,
  sendMessage(bridge, browserInspectCall(119, { selector: INSPECT_SELECTOR }));
  const response = await waitForResponse(bridge, 119);

  // THEN the fourth tool answers that sentence too — `inspect` has its own mapper,
  // so a branch only in `extensionFailureText` would leave it with the code,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: PAGE_BUSY_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => inspectRequestCount(fakeExtension) === 1,
    "exactly one inspect request on the fake extension's stderr",
  );
});

/* ----------------------------------------------------- inspect: frame (spec 25) */

/**
 * The two frame codes `browser_inspect` now answers, each with the details that earn the
 * longer sentence: the number of frames that answered and the addresses that collided.
 *
 * Table-driven for the same reason as `EVAL_REFUSAL_CASES`: the two cases differ only in
 * the code the fake extension answers with, and a code that fell through to the generic
 * `code=…` sentence would let the agent read a number instead of the next step.
 */
const INSPECT_FRAME_REFUSAL_CASES = [
  {
    code: "frame_not_found",
    caseName: "FrameNotFound",
    details: FRAME_NOT_FOUND_DETAILS,
    sentence: FRAME_NOT_FOUND_WITH_COUNT_TEXT,
  },
  {
    code: "frame_ambiguous",
    caseName: "FrameAmbiguous",
    details: FRAME_AMBIGUOUS_DETAILS,
    sentence: FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT,
  },
];

test("mcp_toolsCallBrowserInspect_withAFrame_shouldPassTheSubstringInSchemaOrder", async () => {
  // GIVEN a caller that addresses an iframe beside its other filters, and a second one
  // that names no frame at all:
  const framed = { selector: INSPECT_SELECTOR, limit: 5, frame: FRAME_SUBSTRING };
  const bare = { selector: INSPECT_SELECTOR };

  // WHEN both calls go through the tool layer,
  const windowed = await callToolThroughTheSeam(browserInspectCall(340, framed));
  const plain = await callToolThroughTheSeam(browserInspectCall(341, bare));

  // THEN the substring travels after `includeHidden` and before `tab`, exactly where the
  // schema declares it — the wire payload reads like the tool description,
  assert.equal(windowed.requests.length, 1);
  assert.equal(windowed.requests[0].method, PROTOCOL.METHODS.INSPECT);
  assert.deepEqual(windowed.requests[0].params, {
    selector: INSPECT_SELECTOR,
    limit: 5,
    frame: FRAME_SUBSTRING,
  });
  assert.deepEqual(Object.keys(windowed.requests[0].params), ["selector", "limit", "frame"]);

  // ... and a call without a frame puts no key on the wire at all: absent, not `null`,
  // because a request that named it would claim a filter nobody sent.
  assert.deepEqual(plain.requests[0]?.params, { selector: INSPECT_SELECTOR });
  assert.deepEqual(Object.keys(plain.requests[0]?.params ?? {}), ["selector"]);
});

test("mcp_toolsCallBrowserInspect_withAFrameOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension", async () => {
  // GIVEN the values that are not the `string` the schema declares — a number and
  // `null`:
  const refused = [{ selector: INSPECT_SELECTOR, frame: 1 }, { selector: INSPECT_SELECTOR, frame: null }];

  for (const args of refused) {
    // WHEN the client inspects with that argument,
    const { answer, requests } = await callToolThroughTheSeam(browserInspectCall(342, args));

    // THEN it is a malformed *request* (`-32602`), because the schema says `string` and
    // the client broke the contract before the tool ever ran —
    assert.equal(answer.error?.code, -32602, `${JSON.stringify(args)} must answer -32602`);
    assert.equal(answer.result, undefined, `${JSON.stringify(args)} must not be a tool result`);

    // ... and nothing reached the extension.
    assert.deepEqual(requests, [], `${JSON.stringify(args)} must not reach the extension`);
  }
});

for (const { code, caseName, details, sentence } of INSPECT_FRAME_REFUSAL_CASES) {
  test(`mcp_toolsCallBrowserInspect_whenTheFilterAnswers${caseName}_shouldReturnTheFrameSentence`, async (t) => {
    // GIVEN a fake extension that refuses the inspect call with exactly this code, and
    // the details that make the longer sentence:
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, {
      BC_TEST_INSPECT_ANSWER: `error:${code}`,
      BC_TEST_ERROR_DETAILS: JSON.stringify(details),
    });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client inspects through a substring,
    sendMessage(bridge, browserInspectCall(343, { selector: INSPECT_SELECTOR, frame: FRAME_SUBSTRING }));
    const response = await waitForResponse(bridge, 343);

    // THEN the sentence is the filter's own, with the fact the extension sent — both
    // codes stand above the tool chain, so `inspect` reads the same sentence as `read`,
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... because the request really went to the extension.
    await waitForStderr(
      fakeExtension,
      () => inspectRequestCount(fakeExtension) === 1,
      "exactly one inspect request on the fake extension's stderr",
    );
  });
}

/* --------------------------------------- inspect: piercing selector (spec 27) */

/*
 * The bridge's half of the `>>>` contract: the jump is syntax inside `selector`, not a
 * field of its own. This case is the fence around the temptation to "help" on the way
 * through — a split, a normalised spacing or an escaped `>` would all be a second
 * opinion about a string only the page can read.
 */
test("mcp_toolsCallBrowserInspect_withAPiercingSelector_shouldPassItThroughUnchanged", async () => {
  // GIVEN a selector whose `>>>` jumps into the shadow tree of a component:
  const piercingSelector = "my-card >>> button";

  // WHEN it goes through the tool layer,
  const { requests } = await callToolThroughTheSeam(browserInspectCall(344, { selector: piercingSelector }));

  // THEN it arrives character for character, as the only key the caller set,
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, PROTOCOL.METHODS.INSPECT);
  assert.deepEqual(requests[0].params, { selector: piercingSelector });
  assert.deepEqual(Object.keys(requests[0].params), ["selector"]);

  // ... unchanged, not "repaired": the three spaces around the jump are still there and
  // no escape crept in, because the extension's parser is the one authority on it.
  assert.equal(requests[0].params.selector, "my-card >>> button");
});

/*
 * The two tab tools, and the `tab` the four tools above learned in the same
 * increment. The fixture answers a fixed result whatever the request params are, so
 * what these cases prove about `tab` is the bridge's half of the contract: that a
 * declared `tab` is forwarded instead of refused, that an undeclared or wrongly
 * typed one never reaches the wire, and that a wrong key is named correctly.
 */

test("mcp_toolsCallBrowserOpenTab_withAConnectedExtension_shouldReturnTabIdUrlAndTitleAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count
  // before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client opens a second agent tab,
  sendMessage(bridge, browserOpenTabCall(130, "https://example.org/"));
  const response = await waitForResponse(bridge, 130);

  // THEN the answer is the extension's result as indented JSON, without an error
  // flag: the three fields the contract promises, and nothing else — a client that
  // gets no `tabId` cannot address the tab it just opened,
  assert.equal(response.result.isError, undefined);
  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_OPEN_TAB_RESULT);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, OPEN_TAB_RESULT);
  assert.deepEqual(Object.keys(parsed), ["tabId", "url", "title"]);

  // ... and the request really went to the extension.
  await waitForStderr(
    fakeExtension,
    () => openTabRequestCount(fakeExtension) === 1,
    "exactly one open_tab request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserOpenTab_atTheTabLimit_shouldReturnTheTooManyTabsSentence", async (t) => {
  // GIVEN a fake extension that answers with the one code this tool adds — the
  // sixth tab it refuses to open:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_OPEN_TAB_ANSWER: "error:too_many_tabs" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client opens one more tab,
  sendMessage(bridge, browserOpenTabCall(131, "https://example.org/"));
  const response = await waitForResponse(bridge, 131);

  // THEN the sentence names the limit and the only way out of it — closing one —
  // instead of the code, which would leave the operator guessing,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: TOO_MANY_TABS_TEXT }]);
  assert.equal(response.error, undefined);
  assert.ok(
    !response.result.content[0].text.includes("too_many_tabs"),
    "the code must be translated, not echoed",
  );

  // ... and the refusal came from the extension, not from the bridge guessing.
  await waitForStderr(
    fakeExtension,
    () => openTabRequestCount(fakeExtension) === 1,
    "exactly one open_tab request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserCloseTab_withoutTab_shouldReturnTabIdAndClosedAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client closes the tab it used last — the call without an argument,
  // which is the ordinary one,
  sendMessage(bridge, browserCloseTabCall(132));
  const response = await waitForResponse(bridge, 132);

  // THEN the answer names the tab that actually went away: without it the caller
  // could not tell this from closing a different tab,
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content[0].text, INDENTED_CLOSE_TAB_RESULT);
  const parsed = JSON.parse(response.result.content[0].text);
  assert.deepEqual(parsed, CLOSE_TAB_RESULT);
  assert.deepEqual(Object.keys(parsed), ["tabId", "closed"]);

  // ... and the request reached the extension too.
  await waitForStderr(
    fakeExtension,
    () => closeTabRequestCount(fakeExtension) === 1,
    "exactly one close_tab request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserCloseTab_withAForeignTabId_shouldReturnTheNavigateFirstSentence", async (t) => {
  // GIVEN a fake extension that refuses the id — a tab of the operator's, or one
  // that is already gone:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_CLOSE_TAB_ANSWER: "error:no_agent_tab" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client closes a tab by that id,
  sendMessage(bridge, browserCloseTabCall(133, { tab: 99 }));
  const response = await waitForResponse(bridge, 133);

  // THEN it reads like `read` does: advice, with the call that fixes it — not the
  // generic sentence with a code nobody can act on,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_AGENT_TAB_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the request reached the extension, so the sentence really is its code.
  await waitForStderr(
    fakeExtension,
    () => closeTabRequestCount(fakeExtension) === 1,
    "exactly one close_tab request on the fake extension's stderr",
  );
});

test("mcp_toolsCallBrowserOpenTab_withASecondArgument_shouldReturnTheOnlyUrlSentence", async (t) => {
  // GIVEN a running bridge with a connected fake extension — the counter has to
  // count before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the call tries to hand over a tab that does not exist yet — the near-miss
  // this tool has to refuse, because `open_tab` creates the tab it addresses,
  sendMessage(
    bridge,
    toolsCall(134, { name: "browser_open_tab", arguments: { url: "https://example.org/", tab: 42 } }),
  );
  const response = await waitForResponse(bridge, 134);

  // THEN the sentence names `url` as the only argument the tool takes,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: OPEN_TAB_UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the refused call never reached the extension.
  assert.equal(openTabRequestCount(fakeExtension), 0, "the refused call must not reach the extension");
});

test("mcp_toolsCallBrowserRead_withTab_shouldForwardTheCallInsteadOfRefusingIt", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN one call names the tab with the declared key `tab` and one names it with
  // the key the *extension answers* with — `tabId` is the near-miss this case
  // exists for, and the wire name is `tab`;
  sendMessage(bridge, toolsCall(135, { name: "browser_read", arguments: { tab: 42 } }));
  sendMessage(bridge, toolsCall(136, { name: "browser_read", arguments: { tab: "42" } }));

  // THEN the first is answered exactly like a call without a tab — `tab` is
  // declared, so the bridge has no reason to refuse it. Which tab the extension
  // then reads is its business, and the fixture answers regardless of the params:
  const accepted = await waitForResponse(bridge, 135);
  assert.equal(accepted.result.isError, undefined);
  assert.equal(accepted.result.content[0].text, INDENTED_READ_RESULT);

  // ... the second is a malformed request, because the schema says `integer` and a
  // string tab would only come back as the extension's `invalid_params`,
  const refused = await waitForResponse(bridge, 136);
  assert.equal(refused.error.code, -32602);
  assert.equal(refused.error.message, "invalid params");
  assert.equal(refused.result, undefined);

  // ... and only the accepted call reached the extension.
  await waitForStderr(
    fakeExtension,
    () => readRequestCount(fakeExtension) === 1,
    "exactly one read request on the fake extension's stderr",
  );

  // ... with the tab the caller named — the wire is where `tab` has to arrive, and
  // the fixture answers from `params` regardless, so a bridge that swallowed the
  // argument would look identical everywhere else:
  assert.deepStrictEqual(requestedTabs(fakeExtension, READ_REQUEST_LINE), [42]);
});

test("mcp_toolsCallBrowserClick_withTab_shouldPutTheTabOnTheWireNextToTheSelector", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client clicks a selector in tab 42,
  sendMessage(bridge, toolsCall(138, { name: "browser_click", arguments: { selector: CLICK_SELECTOR, tab: 42 } }));
  const response = await waitForResponse(bridge, 138);

  // THEN the answer is the ordinary click answer — naming a tab costs no shape,
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content[0].text, INDENTED_CLICK_RESULT);

  // ... and the tab travels next to the selector. Dropping it would click the newest
  // agent tab instead: a different page, and the operator would never be told.
  await waitForStderr(
    fakeExtension,
    () => clickRequestCount(fakeExtension) === 1,
    "exactly one click request on the fake extension's stderr",
  );
  assert.deepStrictEqual(requestedTabs(fakeExtension, CLICK_REQUEST_LINE), [42]);
});

test("mcp_toolsCallBrowserStatus_withATab_shouldStillReturnTheNoArgumentsSentence", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN a call hands `status` the argument its sibling tools take — the "one more
  // tool takes a tab, so this one must too" guess,
  sendMessage(bridge, toolsCall(137, { name: "browser_status", arguments: { tab: 42 } }));
  const response = await waitForResponse(bridge, 137);

  // THEN it is refused with the old sentence, unchanged: `status` reports every
  // window, so a tab it could only ignore is an argument the schema forbids — and
  // the count of tools that take one is not the count of tools there are.
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(response.error, undefined);
});

/* -------------------------------------------------------------------- eval */

test("mcp_toolsCallBrowserEval_withAConnectedExtension_shouldReturnTheResultAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client runs a code body in tab 42,
  sendMessage(bridge, browserEvalCall(150, { code: EVAL_CODE, tab: 42 }));
  const response = await waitForResponse(bridge, 150);

  // THEN the answer is the extension's result as indented JSON, without an error
  // flag — `elapsedMs` included, because it is the only field that proves the call
  // was measured rather than invented:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content[0].type, "text");
  const text = response.result.content[0].text;
  assert.equal(text, INDENTED_EVAL_RESULT);
  assert.deepEqual(JSON.parse(text), EVAL_RESULT);

  // ... and the request went to the extension with the tab the caller named. The
  // fixture answers from `params` regardless, so the request line is the only proof
  // that `tab` travels next to `code`:
  await waitForStderr(
    fakeExtension,
    () => evalRequestCount(fakeExtension) === 1,
    "exactly one eval request on the fake extension's stderr",
  );
  assert.deepStrictEqual(requestedTabs(fakeExtension, EVAL_REQUEST_LINE), [42]);
});

test("mcp_toolsCallBrowserEval_withoutTheCode_shouldAnswerInvalidParamsAndNeverReachTheExtension", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count
  // before its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    fakeExtension,
    (stderr) => stderr.includes(STATUS_REQUEST_LINE),
    "the automatic status request on the fake extension's stderr",
  );

  // WHEN the call carries no `code` — once as an empty argument object, once as no
  // `arguments` at all,
  sendMessage(bridge, browserEvalCall(151, {}));
  sendMessage(bridge, toolsCall(152, { name: "browser_eval" }));
  const [emptyArguments, noArguments] = await Promise.all([
    waitForResponse(bridge, 151),
    waitForResponse(bridge, 152),
  ]);

  // THEN both are malformed requests, because the schema requires the one field
  // without which there is nothing to run:
  for (const response of [emptyArguments, noArguments]) {
    assert.equal(response.error.code, -32602);
    assert.equal(response.error.message, "invalid params");
    assert.equal(response.result, undefined);
  }

  // ... and neither reached the extension.
  assert.equal(
    evalRequestCount(fakeExtension),
    0,
    `no eval request may reach the extension:\n${fakeExtension.output.stderr}`,
  );
});

test("mcp_toolsCallBrowserEval_withAFrame_shouldPassTheSubstringBehindTheCode", async () => {
  // GIVEN a caller that addresses an iframe, and a second one that names no frame:
  const framed = { code: EVAL_CODE, frame: FRAME_SUBSTRING };
  const bare = { code: EVAL_CODE };

  // WHEN both calls go through the tool layer,
  const windowed = await callToolThroughTheSeam(browserEvalCall(350, framed));
  const plain = await callToolThroughTheSeam(browserEvalCall(351, bare));

  // THEN the substring travels behind the code, exactly where the schema declares it.
  // The payload is built by hand in `evalTool`, so this is the proof that it copies
  // `frame` at all — a key the schema declares but the payload forgets would fall out
  // with no error at all,
  assert.equal(windowed.requests.length, 1);
  assert.equal(windowed.requests[0].method, PROTOCOL.METHODS.EVAL);
  assert.deepEqual(windowed.requests[0].params, { code: EVAL_CODE, frame: FRAME_SUBSTRING });
  assert.deepEqual(Object.keys(windowed.requests[0].params), ["code", "frame"]);

  // ... and a call without a frame puts no key on the wire: absent, not `null`.
  assert.deepEqual(plain.requests[0]?.params, { code: EVAL_CODE });
  assert.deepEqual(Object.keys(plain.requests[0]?.params ?? {}), ["code"]);
});

test("mcp_toolsCallBrowserEval_withAFrameOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension", async () => {
  // GIVEN the values that are not the `string` the schema declares — a number, `null`
  // and an array:
  const refused = [{ code: EVAL_CODE, frame: 1 }, { code: EVAL_CODE, frame: null }, { code: EVAL_CODE, frame: [FRAME_SUBSTRING] }];

  for (const args of refused) {
    // WHEN the client evaluates with that argument,
    const { answer, requests } = await callToolThroughTheSeam(browserEvalCall(352, args));

    // THEN it is a malformed *request* (`-32602`), because the schema says `string` and
    // the client broke the contract before the tool ever ran —
    assert.equal(answer.error?.code, -32602, `${JSON.stringify(args)} must answer -32602`);
    assert.equal(answer.result, undefined, `${JSON.stringify(args)} must not be a tool result`);

    // ... and nothing reached the extension.
    assert.deepEqual(requests, [], `${JSON.stringify(args)} must not reach the extension`);
  }
});

test("mcp_toolsCallBrowserEval_withANumericCode_shouldAnswerInvalidParams", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the call sends something that is not a string — `3` is the value a client
  // guessing at "a small piece of code" could send:
  sendMessage(bridge, browserEvalCall(153, { code: 3 }));
  const response = await waitForResponse(bridge, 153);

  // THEN the declared type of the field is enforced with the protocol error, not
  // with a sentence about a code the bridge would have had to coerce:
  assert.equal(response.error.code, -32602);
  assert.equal(response.error.message, "invalid params");
  assert.equal(response.result, undefined);
});

test("mcp_toolsCallBrowserEval_withAnUndeclaredArgument_shouldReturnTheOnlyTwoKeysSentence", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the call tries to hand over `timeoutMs` — the near-miss this case exists
  // for: the extension owns that deadline, and a caller who could move it would
  // move the guard along with it,
  sendMessage(bridge, browserEvalCall(154, { code: EVAL_CODE, timeoutMs: 3000 }));
  const response = await waitForResponse(bridge, 154);

  // THEN it is a tool error naming the two arguments the tool takes,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: EVAL_UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and the refused call never reached the extension.
  assert.equal(evalRequestCount(fakeExtension), 0, "the refused call must not reach the extension");
});

/*
 * One case per refusal `eval` has to translate: the five codes of its own, the four it
 * inherits from the page triangle it shares with `read` and `inspect`, and the two the
 * frame filter adds (spec 25).
 * Table-driven because they differ only in the code the fake extension answers
 * with — and the table is the point: a code that fell through to the generic
 * `code=…` sentence would let the agent read a number instead of a cause.
 *
 * `not_readable` is answered without `BC_TEST_ERROR_DETAILS`, so it lands on the
 * plain sentence; the builder that adds `kind` and `url` is `read`'s own and is
 * exercised there.
 *
 * `details` is the `BC_TEST_ERROR_DETAILS` object a case sends on the frame. The two
 * frame cases use it for `frames`/`candidates`; `eval_failed` needs it for its page
 * message and appears twice for exactly that reason: the fixture's default frame always
 * carries a `message`, so the plain-sentence case has to blank it out, while the other
 * case hands over a page message the sentence has to repeat.
 */
const EVAL_FAILED_PAGE_MESSAGE = "messwert-4711: Cannot read properties of null";
const EVAL_FAILED_WITH_MESSAGE_TEXT = `Der Code im Agenten-Tab ist gescheitert: ${EVAL_FAILED_PAGE_MESSAGE}`;
const EVAL_REFUSAL_CASES = [
  { code: "eval_not_allowed", caseName: "EvalNotAllowed", sentence: EVAL_NOT_ALLOWED_TEXT },
  // The page said nothing the bridge can print: old sentence, no dangling `: `.
  { code: "eval_failed", caseName: "EvalFailed", details: { message: "" }, sentence: EVAL_FAILED_TEXT },
  // The page named its own mistake: the sentence has to repeat it verbatim.
  {
    code: "eval_failed",
    caseName: "EvalFailedWithThePageMessage",
    details: { message: EVAL_FAILED_PAGE_MESSAGE },
    sentence: EVAL_FAILED_WITH_MESSAGE_TEXT,
  },
  { code: "eval_timeout", caseName: "EvalTimeout", sentence: EVAL_TIMEOUT_TEXT },
  { code: "eval_result_too_large", caseName: "EvalResultTooLarge", sentence: EVAL_RESULT_TOO_LARGE_TEXT },
  {
    code: "eval_result_unserializable",
    caseName: "EvalResultUnserializable",
    sentence: EVAL_RESULT_UNSERIALIZABLE_TEXT,
  },
  { code: "invalid_params", caseName: "InvalidParams", sentence: INVALID_EVAL_PARAMS_TEXT },
  { code: "no_agent_tab", caseName: "NoAgentTab", sentence: NO_AGENT_TAB_TEXT },
  { code: "page_busy", caseName: "PageBusy", sentence: PAGE_BUSY_TEXT },
  { code: "not_readable", caseName: "NotReadable", sentence: NOT_READABLE_TEXT },
  // The filter's two codes: the same verdict and the same sentences `read` and `inspect`
  // answer with, because both stand above the tool chain.
  {
    code: "frame_not_found",
    caseName: "FrameNotFound",
    details: FRAME_NOT_FOUND_DETAILS,
    sentence: FRAME_NOT_FOUND_WITH_COUNT_TEXT,
  },
  {
    code: "frame_ambiguous",
    caseName: "FrameAmbiguous",
    details: FRAME_AMBIGUOUS_DETAILS,
    sentence: FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT,
  },
];

for (const { code, caseName, details, sentence } of EVAL_REFUSAL_CASES) {
  test(`mcp_toolsCallBrowserEval_whenTheExtensionAnswers${caseName}_shouldReturnTheSentenceForThatCode`, async (t) => {
    // GIVEN a fake extension that refuses the eval call with exactly this code, and
    // the case's details on the frame when it has any:
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, {
      BC_TEST_EVAL_ANSWER: `error:${code}`,
      ...(details === undefined ? {} : { BC_TEST_ERROR_DETAILS: JSON.stringify(details) }),
    });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client runs a code body,
    sendMessage(bridge, browserEvalCall(155, { code: EVAL_CODE }));
    const response = await waitForResponse(bridge, 155);

    // THEN it gets the sentence for that code — not the code, and not the generic
    // catch-all. The `deepEqual` above pins the whole sentence, so a page message
    // inside it is pinned too: no separate `includes` is needed, and one would only
    // restate what this line already holds.
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... because the request really went to the extension: the sentence comes from
    // its code, not from the bridge guessing.
    await waitForStderr(
      fakeExtension,
      () => evalRequestCount(fakeExtension) === 1,
      "exactly one eval request on the fake extension's stderr",
    );
  });
}

/* ---------------------------------------------------- click/type: frame (spec 26) */

/**
 * The two acting tools that learned `frame` before this increment: everything a case has to
 * know about them, so the cases below are one statement instead of two copies.
 *
 * `args` builds what the *client* sends (no `frame` when the case has none, and no
 * `submit` for `type`, because that is the normal call); `params` is what has to reach the
 * wire — the bridge fills in the documented default of `submit`, and nothing else.
 */
const FRAMED_ACTING_TOOLS = [
  {
    name: "browser_click",
    caseName: "BrowserClick",
    method: PROTOCOL.METHODS.CLICK,
    args: (frame) => ({ selector: CLICK_SELECTOR, ...(frame === undefined ? {} : { frame }) }),
    params: (frame) => ({ selector: CLICK_SELECTOR, ...(frame === undefined ? {} : { frame }) }),
  },
  {
    name: "browser_type",
    caseName: "BrowserType",
    method: PROTOCOL.METHODS.TYPE,
    args: (frame) => ({ selector: TYPE_SELECTOR, text: TYPE_TEXT, ...(frame === undefined ? {} : { frame }) }),
    params: (frame) => ({
      selector: TYPE_SELECTOR,
      text: TYPE_TEXT,
      submit: false,
      ...(frame === undefined ? {} : { frame }),
    }),
  },
];

for (const tool of FRAMED_ACTING_TOOLS) {
  test(`mcp_toolsCall${tool.caseName}_withAFrame_shouldPassTheSubstringInSchemaOrder`, async () => {
    // GIVEN a caller that addresses an iframe, and a second one that names none,
    // WHEN both calls go through the tool layer,
    const windowed = await callToolThroughTheSeam(
      toolsCall(360, { name: tool.name, arguments: tool.args(FRAME_SUBSTRING) }),
    );
    const plain = await callToolThroughTheSeam(toolsCall(361, { name: tool.name, arguments: tool.args(undefined) }));

    // THEN the substring travels after the tool's own arguments and before `tab`: the
    // hand-built payload really carries it, which is the half a missing copy line would
    // lose silently,
    assert.equal(windowed.requests.length, 1);
    assert.equal(windowed.requests[0].method, tool.method);
    assert.deepEqual(windowed.requests[0].params, tool.params(FRAME_SUBSTRING));
    assert.equal(windowed.requests[0].params.frame, FRAME_SUBSTRING);

    // ... and a call without a frame puts no key on the wire at all: absent, not `null`,
    // because a request that named it would claim a filter nobody sent.
    assert.deepEqual(plain.requests[0]?.params, tool.params(undefined));
    assert.deepEqual(Object.keys(plain.requests[0]?.params ?? {}), Object.keys(tool.params(undefined)));
  });

  test(`mcp_toolsCall${tool.caseName}_withAFrameOfTheWrongType_shouldAnswerInvalidParamsAndReachNoExtension`, async () => {
    // GIVEN the values that are not the `string` the schema declares — a number, `null`
    // and an array:
    const refused = [1, null, [FRAME_SUBSTRING]].map((frame) => tool.args(frame));

    for (const args of refused) {
      // WHEN the client calls the tool with that argument,
      const { answer, requests } = await callToolThroughTheSeam(toolsCall(362, { name: tool.name, arguments: args }));

      // THEN it is a malformed *request* (`-32602`), because the schema says `string` and
      // the client broke the contract before the tool ever ran,
      assert.equal(answer.error?.code, -32602, `${JSON.stringify(args)} must answer -32602`);
      assert.equal(answer.result, undefined, `${JSON.stringify(args)} must not be a tool result`);

      // ... and nothing reached the extension.
      assert.deepEqual(requests, [], `${JSON.stringify(args)} must not reach the extension`);
    }
  });
}

/**
 * The two frame codes the acting tools now answer, each with the details that earn the
 * longer sentence — the same pair and the same sentences `read`, `inspect` and `eval`
 * answer with, because both stand above the tool chain.
 *
 * One case for both tools and both codes, not four: the sentence is chosen above the tool
 * branches, so a refused click and a refused typing already prove the reachability for both
 * tools, and every extra case here costs a bridge and a fake extension.
 *
 * The fixture spreads *one* `details` object into every error frame, so the call below hands
 * it both facts: the two builders read disjoint keys (`frames`, `candidates`), and this case
 * proves exactly that — each code reaches its own sentence and not the other one.
 */
const ACTING_FRAME_REFUSAL_CASES = [
  {
    code: "frame_not_found",
    caseName: "FrameNotFound",
    sentence: FRAME_NOT_FOUND_WITH_COUNT_TEXT,
    notTheSentence: FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT,
  },
  {
    code: "frame_ambiguous",
    caseName: "FrameAmbiguous",
    sentence: FRAME_AMBIGUOUS_WITH_CANDIDATES_TEXT,
    notTheSentence: FRAME_NOT_FOUND_WITH_COUNT_TEXT,
  },
];

/** One refused answer: this code's sentence, with its details, and not the other code's. */
function assertFrameSentenceFor(response, { caseName, sentence, notTheSentence }) {
  assert.equal(response.result.isError, true, caseName);
  assert.deepEqual(response.result.content, [{ type: "text", text: sentence }], caseName);
  assert.notEqual(response.result.content[0].text, notTheSentence, caseName);
  assert.equal(response.error, undefined, caseName);
}

test("mcp_toolsCallBrowserClickAndType_whenTheFilterRefuses_shouldReturnThatCodesFrameSentence", async (t) => {
  // GIVEN a fake extension that refuses the click with the first case's code and the typing
  // with the second's, plus the details both longer sentences need:
  const [clickCase, typeCase] = ACTING_FRAME_REFUSAL_CASES;
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, {
    BC_TEST_CLICK_ANSWER: `error:${clickCase.code}`,
    BC_TEST_TYPE_ANSWER: `error:${typeCase.code}`,
    BC_TEST_ERROR_DETAILS: JSON.stringify({ ...FRAME_NOT_FOUND_DETAILS, ...FRAME_AMBIGUOUS_DETAILS }),
  });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client clicks and types through a substring the filter rejects,
  sendMessage(
    bridge,
    toolsCall(363, { name: "browser_click", arguments: { selector: CLICK_SELECTOR, frame: FRAME_SUBSTRING } }),
  );
  sendMessage(
    bridge,
    toolsCall(364, {
      name: "browser_type",
      arguments: { selector: TYPE_SELECTOR, text: TYPE_TEXT, frame: FRAME_SUBSTRING },
    }),
  );
  const [clicked, typed] = await Promise.all([waitForResponse(bridge, 363), waitForResponse(bridge, 364)]);

  // THEN each call gets its own code's sentence — not the generic catch-all, not the other
  // code's sentence, and not the tool's own failure sentence,
  assertFrameSentenceFor(clicked, clickCase);
  assertFrameSentenceFor(typed, typeCase);

  // ... because both requests really went to the extension, with the substring on the wire
  // and announced only as its presence — the address fragment itself stays off the log.
  await waitForStderr(
    fakeExtension,
    () => clickRequestCount(fakeExtension) === 1 && typeRequestCount(fakeExtension) === 1,
    "one click and one type request on the fake extension's stderr",
  );
  assert.deepEqual(requestLines(fakeExtension, CLICK_REQUEST_LINE), [`${CLICK_REQUEST_LINE} frame=yes`]);
  assert.deepEqual(requestLines(fakeExtension, TYPE_REQUEST_LINE), [`${TYPE_REQUEST_LINE} frame=yes`]);
  assert.ok(!fakeExtension.output.stderr.includes(FRAME_SUBSTRING), "the substring must not be logged");
});

/* -------------------------------------------------------------- screenshot */

test("mcp_toolsCallBrowserScreenshot_shouldReturnTheMetadataAsTextAndThenTheImage", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client photographs the visible area of tab 42,
  sendMessage(bridge, browserScreenshotCall(156, { tab: 42 }));
  const response = await waitForResponse(bridge, 156);

  // THEN the answer has two blocks in exactly one order — the numbers first, the
  // picture after them:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 2);
  assert.deepEqual(
    response.result.content.map((block) => block.type),
    ["text", "image"],
    "the text block comes first, the image block after it",
  );

  // ... the text block is the whole result minus its picture — nine fields, no
  // `base64`, so the caller can read what the picture is without decoding it and
  // the payload is not sent twice. Short enough for the fixture, whose title and
  // url are short: `screenshot` deliberately does not cut them.
  const text = response.result.content[0].text;
  assert.equal(text, SCREENSHOT_METADATA_TEXT);
  assert.ok(!text.includes("base64"), "the text block must not carry the picture");
  assert.ok(text.length < 1024, "the metadata of the fixture must stay a short block");
  assert.deepEqual(JSON.parse(text), SCREENSHOT_METADATA);
  assert.equal(Object.keys(JSON.parse(text)).length, 9);

  // ... and the image block is the picture itself: `mimeType` from the result's
  // `format`, `data` the bare base64 (no `data:` prefix), decoding to the `bytes`
  // the text block claims (criterion 3).
  const image = response.result.content[1];
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.data, SCREENSHOT_PICTURE);
  assert.equal(image.data.startsWith("/9j/"), true, "the data must be the JPEG");
  assert.equal(Buffer.from(image.data, "base64").length, SCREENSHOT_RESULT.bytes);

  // ... and the request carried the tab the caller named. The fixture answers from
  // `params` regardless, so its stderr line is the only proof that `tab` travels:
  await waitForStderr(
    fakeExtension,
    () => screenshotRequestCount(fakeExtension) === 1,
    "exactly one screenshot request on the fake extension's stderr",
  );
  assert.deepStrictEqual(requestedTabs(fakeExtension, SCREENSHOT_REQUEST_LINE), [42]);
});

/*
 * The same answer with the other format, and the only pin on the PNG entry of the MIME
 * table: the fixture's own picture is a JPEG, so a bridge that answered `image/jpeg` for
 * every format would keep the case above green.
 */
test("mcp_toolsCallBrowserScreenshot_withAPng_shouldNameThePngMimeType", async (t) => {
  // GIVEN a fake extension whose picture is a PNG of exactly 68 bytes — the 1×1
  // passthrough capture a small tab really produces,
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port, { BC_TEST_SCREENSHOT_BYTES: "68" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client asks for a picture,
  sendMessage(bridge, browserScreenshotCall(159, {}));
  const response = await waitForResponse(bridge, 159);

  // THEN the MIME type follows the format the extension reported, and the bytes are
  // the PNG the fixture built — head and length, not just a non-empty string,
  const image = response.result.content[1];
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data.startsWith("iVBORw0"), true, "the data must be the PNG");
  assert.equal(Buffer.from(image.data, "base64").length, 68);

  // ... while the text block beside it carries the numbers of that same picture,
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    ...SCREENSHOT_METADATA,
    format: "png",
    bytes: 68,
    scaled: false,
  });
});

/*
 * The one format the bridge must not guess: `gif` is neither of the ladder's two, so the
 * answer is the generic sentence and *one* text block — no image block with an invented
 * `mimeType`, which a client would render as a broken picture nobody can blame.
 *
 * The formatter returning instead of throwing is the whole point of the case: a `throw`
 * inside `optionalArgumentsTool`'s `try` would answer `BRIDGE_FAILED`, a sentence about
 * the bridge for a fault on the extension's side.
 */
test("mcp_toolsCallBrowserScreenshot_withAnUnknownFormat_shouldAnswerAnErrorWithoutAnImage", async (t) => {
  // GIVEN a fake extension that names a format the bridge knows no MIME type for,
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, { BC_TEST_SCREENSHOT_FORMAT: "gif" });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client asks for a picture,
  sendMessage(bridge, browserScreenshotCall(160, {}));
  const response = await waitForResponse(bridge, 160);

  // THEN it is a tool error with the generic screenshot sentence and exactly one
  // text block — the call did reach the extension, the answer was unusable:
  assert.equal(response.result.isError, true);
  assert.equal(response.result.content.length, 1);
  assert.deepEqual(response.result.content, [{ type: "text", text: SCREENSHOT_FAILED_TEXT }]);
  assert.equal(response.error, undefined);

  // ... and no image block was sent at all, with no guessed MIME type in it.
  assert.equal(
    response.result.content.some((block) => block.type === "image"),
    false,
    "an unknown format must not become an image block",
  );
  await waitForStderr(
    fakeExtension,
    () => screenshotRequestCount(fakeExtension) === 1,
    "exactly one screenshot request on the fake extension's stderr",
  );
});

/*
 * The sibling of the `browser_focus` case of the same name, and the only pin on the
 * `UNEXPECTED_ARGUMENTS[BROWSER_SCREENSHOT]` entry: `toolError(id, undefined)` would
 * answer `text: undefined` and every other screenshot case would stay green.
 */
test("mcp_toolsCallBrowserScreenshot_withAnArgument_shouldReturnTheOnlyTabSentence", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count before
  // its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the call carries an argument the schema forbids,
  sendMessage(bridge, browserScreenshotCall(158, { x: 1 }));
  const response = await waitForResponse(bridge, 158);

  // THEN it is a tool error with the sentence from the contract, not a protocol
  // error — same precedence as `browser_focus`,
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [
    { type: "text", text: SCREENSHOT_UNEXPECTED_ARGUMENTS_TEXT },
  ]);
  assert.equal(response.error, undefined);

  // ... and the refused call never reached the extension.
  assert.equal(
    screenshotRequestCount(fakeExtension),
    0,
    "the refused call must not reach the extension",
  );
});

/*
 * One case per refusal `screenshot` has to translate: its three codes plus the one
 * it inherits from the address rule. `page_busy` and `not_readable` are missing on
 * purpose — `captureTab` injects no script, so no agent tab can answer them.
 * Both message-carrying codes appear twice: once with the extension's message (the
 * browser's rejection, the ladder's measurement) and once without, because a bridge
 * that glued a dangling `: ` onto the plain sentence would still be green if only
 * the carrying case existed. `details` is the `BC_TEST_ERROR_DETAILS` object a case
 * sends, and the frame's `error` is what the bridge reads.
 */
const SCREENSHOT_REFUSAL_CASES = [
  { code: "screenshot_not_allowed", caseName: "ScreenshotNotAllowed", sentence: SCREENSHOT_NOT_ALLOWED_TEXT },
  // Nothing the bridge can print: the generic sentence, no dangling colon.
  { code: "screenshot_failed", caseName: "ScreenshotFailed", details: { message: "" }, sentence: SCREENSHOT_FAILED_TEXT },
  // The browser named its reason, so the sentence repeats it: that is the only part
  // the agent could act on.
  {
    code: "screenshot_failed",
    caseName: "ScreenshotFailedWithTheBrowserMessage",
    details: { message: SCREENSHOT_BROWSER_MESSAGE },
    sentence: SCREENSHOT_FAILED_WITH_MESSAGE_TEXT,
  },
  // The measurement — bytes, dimensions, limit — is the extension's, and the tool
  // text has to carry it verbatim: the number decides whether another tab helps.
  {
    code: "screenshot_too_large",
    caseName: "ScreenshotTooLargeWithTheMeasurement",
    details: { message: SCREENSHOT_TOO_LARGE_MEASUREMENT },
    sentence: SCREENSHOT_TOO_LARGE_WITH_MESSAGE_TEXT,
  },
  // The fallback for a frame that carries no measurement at all.
  {
    code: "screenshot_too_large",
    caseName: "ScreenshotTooLargeWithoutAMeasurement",
    details: { message: "" },
    sentence: SCREENSHOT_TOO_LARGE_TEXT,
  },
  { code: "invalid_params", caseName: "InvalidParams", sentence: INVALID_SCREENSHOT_PARAMS_TEXT },
  { code: "no_agent_tab", caseName: "NoAgentTab", sentence: NO_AGENT_TAB_TEXT },
];

for (const { code, caseName, details, sentence } of SCREENSHOT_REFUSAL_CASES) {
  test(`mcp_toolsCallBrowserScreenshot_whenTheExtensionAnswers${caseName}_shouldReturnTheSentenceForThatCode`, async (t) => {
    // GIVEN a fake extension that refuses the screenshot call with exactly this code,
    // and the case's details on the frame when it has any:
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, {
      BC_TEST_SCREENSHOT_ANSWER: `error:${code}`,
      ...(details === undefined ? {} : { BC_TEST_ERROR_DETAILS: JSON.stringify(details) }),
    });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client photographs the last used agent tab,
    sendMessage(bridge, browserScreenshotCall(157, {}));
    const response = await waitForResponse(bridge, 157);

    // THEN it gets the sentence for that code — not the code, and not the generic
    // catch-all. The `deepEqual` pins the whole block, so a message inside the
    // sentence is pinned too; a separate `includes` would only restate this line.
    // And there is exactly one block: a refusal is never dressed up with a picture.
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content.length, 1);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... because the request really went to the extension: the sentence comes from
    // its code, not from the bridge guessing.
    await waitForStderr(
      fakeExtension,
      () => screenshotRequestCount(fakeExtension) === 1,
      "exactly one screenshot request on the fake extension's stderr",
    );
  });
}

/* ----------------------------------------------------------------- frames */

test("mcp_toolsCallBrowserFrames_shouldReturnTheFrameListAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client lists the frames of tab 42,
  sendMessage(bridge, browserFramesCall(161, { tab: 42 }));
  const response = await waitForResponse(bridge, 161);

  // THEN the answer is the extension's result as indented JSON, field for field — the
  // bridge adds nothing to a list and drops nothing from it:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");

  const text = response.result.content[0].text;
  assert.equal(text, JSON.stringify(FRAMES_RESULT, null, 2));
  assert.deepEqual(JSON.parse(text), FRAMES_RESULT);

  // ... and the request carried the tab the caller named. The fixture answers from its
  // own result, so its stderr line is the only proof that `tab` travels:
  await waitForStderr(
    fakeExtension,
    () => framesRequestCount(fakeExtension) === 1,
    "exactly one frames request on the fake extension's stderr",
  );
  assert.deepStrictEqual(requestedTabs(fakeExtension, FRAMES_REQUEST_LINE), [42]);
});

/*
 * The three refusals `browser_frames` inherits from `read`, and the whole reason its
 * branch in `extensionFailureText` exists: without it each of them would answer the
 * `status` sentence, which tells the caller the extension could not deliver a *status*.
 * The sentences are `read`'s, word for word — a list of frames is a read of the page,
 * and two wordings for one situation would be two truths about it.
 */
const FRAMES_REFUSAL_CASES = [
  { code: "no_agent_tab", caseName: "NoAgentTab", sentence: NO_AGENT_TAB_TEXT },
  { code: "page_busy", caseName: "PageBusy", sentence: PAGE_BUSY_TEXT },
  { code: "not_readable", caseName: "NotReadable", sentence: NOT_READABLE_TEXT },
];

for (const { code, caseName, sentence } of FRAMES_REFUSAL_CASES) {
  test(`mcp_toolsCallBrowserFrames_whenTheExtensionAnswers${caseName}_shouldReturnTheReadSentence`, async (t) => {
    // GIVEN a fake extension that refuses the frames call with exactly this code —
    // all three are codes `read` answers with too:
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, {
      BC_TEST_FRAMES_ANSWER: `error:${code}`,
    });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client lists the frames of the last used agent tab,
    sendMessage(bridge, browserFramesCall(162, {}));
    const response = await waitForResponse(bridge, 162);

    // THEN it gets the sentence `read` gives for that code — not the code, and not the
    // catch-all sentence that names the wrong action:
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... because the request really went to the extension, so the sentence comes from
    // its code and not from the bridge guessing:
    await waitForStderr(
      fakeExtension,
      () => framesRequestCount(fakeExtension) === 1,
      "exactly one frames request on the fake extension's stderr",
    );
  });
}

/*
 * The pin on `UNEXPECTED_ARGUMENTS[BROWSER_FRAMES]`: `toolError(id, undefined)` would
 * answer `text: undefined` and every other frames case would stay green.
 */
test("mcp_toolsCallBrowserFrames_withAnArgument_shouldReturnTheOnlyTabSentence", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count before
  // its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the call carries an argument the schema forbids,
  sendMessage(bridge, browserFramesCall(163, { frame: "widget" }));
  const response = await waitForResponse(bridge, 163);

  // THEN it is a tool error with the sentence from the contract, not a protocol error,
  // and the refused call never reached the extension:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: FRAMES_UNEXPECTED_ARGUMENTS_TEXT }]);
  assert.equal(response.error, undefined);
  assert.equal(
    framesRequestCount(fakeExtension),
    0,
    "the refused call must not reach the extension",
  );
});

/* ------------------------------------------------------------- transcript */

test("mcp_toolsCallBrowserTranscript_withAConnectedExtension_shouldReturnTheFieldsAsIndentedJsonText", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads the transcript of tab 42, from inside the text,
  sendMessage(bridge, browserTranscriptCall(171, { tab: 42, offset: 5, maxChars: 10 }));
  const response = await waitForResponse(bridge, 171);

  // THEN the answer is the extension's eight fields as indented JSON, field for field —
  // the bridge adds nothing to the segments and drops nothing from them:
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");

  const text = response.result.content[0].text;
  assert.equal(text, JSON.stringify(TRANSCRIPT_RESULT, null, 2));

  // ... and the fields are the ones the contract names: the three language fields first,
  // then the window, `time` is a number of seconds, `timeText` its display, and the a11y
  // line is nowhere in the text.
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), [
    "requestedLanguage",
    "deliveredLanguage",
    "source",
    "segments",
    "totalChars",
    "chars",
    "offset",
    "truncated",
  ]);
  assert.deepEqual(Object.keys(parsed.segments[0]), ["time", "timeText", "text"]);
  assert.equal(parsed.segments[0].time, 4);
  assert.equal(parsed.segments[0].timeText, "0:04");

  // ... and the request carried the tab and the window the caller named. The fixture
  // answers from its own result, so its stderr line is the only proof that `tab`,
  // `offset` and `maxChars` travel at all:
  await waitForStderr(
    fakeExtension,
    () => transcriptRequestCount(fakeExtension) === 1,
    "exactly one transcript request on the fake extension's stderr",
  );
  assert.deepStrictEqual(requestLines(fakeExtension, TRANSCRIPT_REQUEST_LINE), [
    `${TRANSCRIPT_REQUEST_LINE} tab=42 offset=5 maxChars=10`,
  ]);
});

/*
 * A video whose player model carries no caption track is the one refusal a caller will meet
 * in normal use — the caption row is simply not there, or the page is not done building. Its
 * own case, not the loop below, because the sentence and the code are the pair this tool
 * exists to report honestly: `transcript_failed` would hide that the page was fine and the
 * track was not. The field is still `no_transcript_panel` — a new code would be a new spec —
 * but the sentence speaks of the track now that the panel is no longer read.
 */
test("mcp_toolsCallBrowserTranscript_whenTheVideoHasNoCaptionTrack_shouldReturnTheNoTranscriptSentence", async (t) => {
  // GIVEN a fake extension that answers the missing-track verdict:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, {
    BC_TEST_TRANSCRIPT_ANSWER: "error:no_transcript_panel",
  });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads the transcript of the last used agent tab,
  sendMessage(bridge, browserTranscriptCall(172, {}));
  const response = await waitForResponse(bridge, 172);

  // THEN it gets the missing-track sentence — not the code, and not the catch-all sentence
  // that names a status:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: NO_TRANSCRIPT_PANEL_TEXT }]);
  assert.equal(response.error, undefined);

  // ... because the request really went to the extension:
  await waitForStderr(
    fakeExtension,
    () => transcriptRequestCount(fakeExtension) === 1,
    "exactly one transcript request on the fake extension's stderr",
  );
});

/*
 * The refusals `browser_transcript` answers with — and the whole reason its branch in
 * `extensionFailureText` exists: without it each of them would answer the `status`
 * sentence, which tells the caller the extension could not deliver a *status*.
 * `offset_out_of_range`, `page_busy` and `not_readable` keep `read`'s sentences word for
 * word: the extension checks both tools' windows with the same helper, and both tools walk
 * into the same injection (`injectPageCode` throws the last two). `transcript_needs_focus`
 * comes twice: the plain sentence is the fallback for a frame without a message, the second
 * form proves the extension's words reach the caller, which is what keeps a visible-but-
 * hydrating tab out of the focus loop (criterion 5). `transcript_failed` comes twice for the
 * same reason: the loop pins the fallback, and its own case below pins the reason.
 */
const TRANSCRIPT_REFUSAL_CASES = [
  {
    code: "transcript_failed",
    caseName: "TranscriptFailed",
    sentence: TRANSCRIPT_FAILED_TEXT,
    // A frame without a usable message keeps the fallback: `null` rides over the fixture's
    // filler message, so the bridge sees the "absent/not a string" branch (criterion 14).
    details: { message: null },
  },
  {
    code: "offset_out_of_range",
    caseName: "OffsetOutOfRange",
    sentence: OFFSET_OUT_OF_RANGE_TEXT,
    details: OFFSET_OUT_OF_RANGE_DETAILS,
  },
  { code: "page_busy", caseName: "PageBusy", sentence: PAGE_BUSY_TEXT },
  { code: "not_readable", caseName: "NotReadable", sentence: NOT_READABLE_TEXT },
  {
    code: "transcript_needs_focus",
    caseName: "NeedsFocus",
    sentence: TRANSCRIPT_NEEDS_FOCUS_TEXT,
    // A frame without a usable message keeps the fallback: `null` rides over the
    // fixture's filler message, so the bridge sees the "absent/not a string" branch.
    details: { message: null },
  },
  {
    code: "transcript_needs_focus",
    caseName: "NeedsFocusWithMessage",
    sentence: TRANSCRIPT_NEEDS_FOCUS_WITH_MESSAGE_TEXT,
    details: { message: TRANSCRIPT_FOCUS_MESSAGE },
  },
];

for (const { code, caseName, sentence, details } of TRANSCRIPT_REFUSAL_CASES) {
  test(`mcp_toolsCallBrowserTranscript_whenTheExtensionAnswers${caseName}_shouldReturnTheSentenceForThatCode`, async (t) => {
    // GIVEN a fake extension that refuses the transcript call with exactly this code,
    // and the details its sentence needs when it has any:
    const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
    const fakeExtension = startFakeExtension(t, bridge.port, {
      BC_TEST_TRANSCRIPT_ANSWER: `error:${code}`,
      ...(details === undefined ? {} : { BC_TEST_ERROR_DETAILS: JSON.stringify(details) }),
    });
    await waitForStderr(
      bridge,
      (stderr) => stderr.includes("extension connected"),
      "the extension handshake on stderr",
    );

    // WHEN the client reads the transcript of the last used agent tab,
    sendMessage(bridge, browserTranscriptCall(173, {}));
    const response = await waitForResponse(bridge, 173);

    // THEN it gets that code's own sentence, with the number the extension sent where
    // the sentence has room for it:
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: sentence }]);
    assert.equal(response.error, undefined);

    // ... because the request really went to the extension, so the sentence comes from
    // its code and not from the bridge guessing:
    await waitForStderr(
      fakeExtension,
      () => transcriptRequestCount(fakeExtension) === 1,
      "exactly one transcript request on the fake extension's stderr",
    );
  });
}

/*
 * The three fields spec 33 puts in front of the segments: the target track's language, the
 * language of the file that was actually read, and the container the model came from. Pinned
 * as the first four lines of the wire text, because the *order* is part of the answer — the
 * extension writes them first so a caller reads the language before twenty thousand
 * characters of segment text, and a bridge that rebuilt the object would silently undo that.
 */
test("mcp_toolsCallBrowserTranscript_shouldCarryTheLanguageFields", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads the transcript of the last used agent tab,
  sendMessage(bridge, browserTranscriptCall(175, {}));
  const response = await waitForResponse(bridge, 175);

  // THEN the answer opens with the three language fields, key and value both in the text,
  // in the extension's order:
  const text = response.result.content[0].text;
  assert.deepEqual(text.split("\n").slice(0, 4), [
    "{",
    '  "requestedLanguage": "en",',
    '  "deliveredLanguage": "en",',
    '  "source": "ytplayer.bootstrapPlayerResponse",',
  ]);

  // ... and the parsed answer agrees with the fixture field by field: the bridge forwards
  // them, it does not invent or rename one on the way.
  const parsed = JSON.parse(text);
  assert.equal(parsed.requestedLanguage, TRANSCRIPT_RESULT.requestedLanguage);
  assert.equal(parsed.deliveredLanguage, TRANSCRIPT_RESULT.deliveredLanguage);
  assert.equal(parsed.source, TRANSCRIPT_RESULT.source);
});

/*
 * The signed track address never leaves the extension (spec 33, criterion 8). It can only
 * reach the bridge inside the failure `details`, so that is where this case puts it — next
 * to a reason the bridge *does* print. The answer must carry the reason and not one byte of
 * the address: the bridge takes `details.message` and nothing else from the frame.
 */
test("mcp_toolsCallBrowserTranscript_shouldNotLeakTheUrl", async (t) => {
  // GIVEN a fake extension that refuses with a reason and, beside it, the signed address the
  // player had fetched — the shape a careless extension would hand over:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, {
    BC_TEST_TRANSCRIPT_ANSWER: "error:transcript_failed",
    BC_TEST_ERROR_DETAILS: JSON.stringify({
      url: TRANSCRIPT_PROBE_URL,
      message: TRANSCRIPT_FAILURE_REASON,
    }),
  });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads the transcript of the last used agent tab,
  sendMessage(bridge, browserTranscriptCall(176, {}));
  const response = await waitForResponse(bridge, 176);

  // THEN the reason arrives, and the address does not: no endpoint, no signature.
  const text = response.result.content[0].text;
  assert.equal(text, TRANSCRIPT_FAILED_WITH_MESSAGE_TEXT);
  assert.equal(text.includes("timedtext"), false, text);
  assert.equal(text.includes("signature"), false, text);

  // ... because the request really went to the extension, so the silence is the bridge's
  // choosing and not a request that never left:
  await waitForStderr(
    fakeExtension,
    () => transcriptRequestCount(fakeExtension) === 1,
    "exactly one transcript request on the fake extension's stderr",
  );
});

/*
 * Criterion 14: the reason the extension saw reaches the caller. The plain sentence blames
 * the page ("nur YouTube-Watch-Seiten haben eines"), which is false on a watch page whose
 * video has no Japanese track file — and the caller's next step depends on the difference:
 * another video here, a reload there. The reason is the extension's own string, quoted into
 * the expected sentence by the constant above.
 */
test("mcp_toolsCallBrowserTranscript_shouldPassTheFailureDetail", async (t) => {
  // GIVEN a fake extension that refuses `transcript_failed` with the sentence it would use
  // for a video whose target track has no file on this page:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port, {
    BC_TEST_TRANSCRIPT_ANSWER: "error:transcript_failed",
    BC_TEST_ERROR_DETAILS: JSON.stringify({ message: TRANSCRIPT_FAILURE_REASON }),
  });
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the client reads the transcript of the last used agent tab,
  sendMessage(bridge, browserTranscriptCall(177, {}));
  const response = await waitForResponse(bridge, 177);

  // THEN the answer carries the extension's reason and not the generic sentence — not the
  // code either, which would send the caller looking at its own call:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [
    { type: "text", text: TRANSCRIPT_FAILED_WITH_MESSAGE_TEXT },
  ]);
  assert.equal(response.error, undefined);

  // ... because the request really went to the extension, so the reason is its own words:
  await waitForStderr(
    fakeExtension,
    () => transcriptRequestCount(fakeExtension) === 1,
    "exactly one transcript request on the fake extension's stderr",
  );
});

/*
 * The pin on `UNEXPECTED_ARGUMENTS[BROWSER_TRANSCRIPT]`: `toolError(id, undefined)` would
 * answer `text: undefined` and every other transcript case would stay green. The key it
 * refuses is `frame`, the one `read` declares and this tool deliberately does not.
 */
test("mcp_toolsCallBrowserTranscript_withAnArgument_shouldReturnTheDeclaredArgumentsSentence", async (t) => {
  // GIVEN a bridge with a connected fake extension — the counter has to count before
  // its zero means anything:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  const fakeExtension = startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("extension connected"),
    "the extension handshake on stderr",
  );

  // WHEN the call carries an argument the schema forbids,
  sendMessage(bridge, browserTranscriptCall(174, { frame: "widget" }));
  const response = await waitForResponse(bridge, 174);

  // THEN it is a tool error with the sentence from the contract, not a protocol error,
  // and the refused call never reached the extension:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [
    { type: "text", text: TRANSCRIPT_UNEXPECTED_ARGUMENTS_TEXT },
  ]);
  assert.equal(response.error, undefined);
  assert.equal(
    transcriptRequestCount(fakeExtension),
    0,
    "the refused call must not reach the extension",
  );
});

test("mcp_toolsCall_withAnUnknownToolName_shouldReturnAnUnknownToolToolError", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN the client calls a tool this server does not have,
  sendMessage(bridge, toolsCall(24, { name: "navigate" }));
  const response = await waitForResponse(bridge, 24);

  // THEN the name is echoed in a tool error, so the client can show it:
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: "Unbekanntes Tool: navigate" }]);
  assert.equal(response.error, undefined);
});

test("mcp_toolsCall_withArguments_shouldRefuseThemInsteadOfIgnoringThem", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN a call carries arguments — once as an object with a key, once as a
  // value that is not an object at all,
  sendMessage(bridge, toolsCall(25, { name: "browser_status", arguments: { x: 1 } }));
  sendMessage(bridge, toolsCall(26, { name: "browser_status", arguments: "x" }));

  // THEN both are refused with the same sentence, because the schema says there
  // is nothing to pass:
  for (const id of [25, 26]) {
    const response = await waitForResponse(bridge, id);
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: UNEXPECTED_ARGUMENTS_TEXT }]);
  }
});

test("mcp_toolsCall_withoutAUsableName_shouldAnswerInvalidParams", async (t) => {
  // GIVEN a running bridge:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });

  // WHEN a `tools/call` arrives with no `name` at all,
  sendMessage(bridge, toolsCall(27, {}));
  const response = await waitForResponse(bridge, 27);

  // THEN this is a malformed request, not an unknown tool: the server cannot
  // say which tool the client meant, so it says that much in protocol terms —
  // with code and message, as JSON-RPC 2.0 requires:
  assert.equal(response.error.code, -32602);
  assert.equal(response.error.message, "invalid params");
  assert.equal(response.result, undefined);
});

test("mcp_withTwoToolCallsInOneWrite_shouldAnswerBothUnderTheirOwnIds", async (t) => {
  // GIVEN a bridge with a connected fake extension:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN two calls arrive in a single write — no queue, two independent awaits,
  bridge.child.stdin.write(`${JSON.stringify(browserStatusCall(31))}\n${JSON.stringify(browserStatusCall(32))}\n`);

  // THEN both are answered, each under its own id, in whatever order they
  // finished — which is why this is searched by id and never by position:
  const answers = await Promise.all([waitForResponse(bridge, 31), waitForResponse(bridge, 32)]);
  for (const answer of answers) {
    assert.deepEqual(JSON.parse(answer.result.content[0].text), STATUS_RESULT);
  }
  const ids = completedLines(bridge).map((message) => message.id);
  assert.equal(ids.filter((id) => id === 31).length, 1);
  assert.equal(ids.filter((id) => id === 32).length, 1);
});

test("mcp_withDebugLoggingAndAConnectedExtension_shouldKeepTheIndentedJsonOnStderrOnly", async (t) => {
  // GIVEN a bridge that logs at debug level and an extension that answers:
  const bridge = await startBridge(t, {
    tokenFile: createTokenFile(t),
    env: { BC_LOG: "debug" },
  });
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes(INDENTED_RESULT),
    "the indented result on stderr",
  );

  // WHEN the client calls the tool as well,
  sendMessage(bridge, browserStatusCall(33));
  const response = await waitForResponse(bridge, 33);

  // THEN the multi-line debug output stayed on stderr ...
  assert.ok(bridge.output.stderr.includes(INDENTED_RESULT));
  assert.deepEqual(JSON.parse(response.result.content[0].text), STATUS_RESULT);

  // ... and every complete line on stdout is still a JSON-RPC message. The
  // debug run is the only one that writes several lines per event, so this is
  // where a stray stdout write would surface.
  const messages = completedLines(bridge);
  assert.ok(messages.length >= 1);
  for (const message of messages) {
    assert.equal(message.jsonrpc, "2.0");
    assert.ok(Object.hasOwn(message, "id"), "every response carries an id field");
  }
  assert.ok(!bridge.output.stdout.includes('"windows"'), "the status JSON must not reach stdout");
  assert.ok(!bridge.output.stdout.includes("status windows="), "no log line may reach stdout");
});

test("mcp_whenStdinEnds_shouldExitZeroAfterASingleShutdownLine", async (t) => {
  // GIVEN a running bridge that has answered a request:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  await ping(bridge, 40);

  // WHEN the client closes stdin — the normal way a stdio client says goodbye,
  bridge.child.stdin.end();
  const result = await exitWithin(bridge, EXIT_TIMEOUT_MS);

  // THEN the process ends with 0,
  assert.deepEqual(result, { code: 0, signal: null });

  // ... exactly one shutdown line was written (SIGTERM from the cleanup must
  // not add a second one either),
  assert.equal(shutdownLines(bridge).length, 1, `one shutdown line expected:\n${bridge.output.stderr}`);
  assert.match(shutdownLines(bridge)[0], / stdin closed, shutting down$/);

  // ... and stdout carried nothing but JSON-RPC, with no unfinished tail — the
  // case the client rejects by name:
  for (const message of completedLines(bridge)) {
    assert.equal(message.jsonrpc, "2.0");
    assert.ok(Object.hasOwn(message, "id"));
  }
  assertNoUnfinishedTail(bridge);
});

test("mcp_whenStdinEndsWithAConnectedExtension_shouldAlsoExitZeroWithOneShutdownLine", async (t) => {
  // GIVEN a bridge with a connected fake extension — a session that has a
  // socket, a pending auto-request and everything else to trip over:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t) });
  startFakeExtension(t, bridge.port);
  await waitForStderr(
    bridge,
    (stderr) => stderr.includes("status windows="),
    "the automatic status line on stderr",
  );

  // WHEN stdin ends,
  bridge.child.stdin.end();
  const result = await exitWithin(bridge, EXIT_TIMEOUT_MS);

  // THEN it still ends with 0 and still logs exactly once,
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(shutdownLines(bridge).length, 1, `one shutdown line expected:\n${bridge.output.stderr}`);

  // ... and stdout stayed protocol-only, without a fragment at the end.
  for (const message of completedLines(bridge)) {
    assert.equal(message.jsonrpc, "2.0");
  }
  assertNoUnfinishedTail(bridge);
});

test("mcp_withAnIgnoredStdin_shouldKeepRunningAndListeningAfterTheEof", async (t) => {
  // GIVEN a bridge started the way INSTALL.md starts the standalone one, with
  // stdin on /dev/null:
  const bridge = await startBridge(t, { tokenFile: createTokenFile(t), stdin: "ignore" });

  // WHEN the EOF that /dev/null produces has had time to be acted upon,
  await delay(IGNORED_STDIN_SETTLE_MS);

  // THEN the process is still alive and the extension can still reach it —
  // otherwise the standalone bridge would die seconds after every start:
  assert.ok(isRunning(bridge), `the bridge exited on its ignored stdin:\n${bridge.output.stderr}`);
  assert.equal(await canConnect(bridge.port), true);
  assert.equal(shutdownLines(bridge).length, 0);
});
