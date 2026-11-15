---
description: browser_inspect und browser_eval adressieren einen iframe per URL-Teilstring; zweiter Teil von Spec 24. click und type folgen in Spec 26.
status: active
---

# Auch drinnen abfragen: `frame` für `inspect` und `eval`

Spec 24 (`docs/24-frames.md`) hat die Rahmen **sichtbar** gemacht:
`browser_frames` listet sie, und `browser_read` kann in einen hineinlesen. Was
fehlt, ist das **Handeln** — ein Formular in einem iframe ausfüllen, einen Knopf
dort drücken, ein Element dort abfragen. Und die Ruhe-Erkennung nach einem Klick
läuft heute im Hauptrahmen, also an der falschen Stelle.

Dieses Inkrement ist der zweite Teil: dieselben vier Werkzeuge, derselbe
`frame`-Parameter, dieselbe Adressierung (URL-Teilstring) und dieselbe
Fehlerwahrheit wie in Spec 24. Es entstand durch die Teilungsregel aus
`CONTRIBUTING.md` (dritter Review-Block bei Spec 24) und setzt deren Stufen 1–5 voraus.

## Ziel

- **`frame` als optionaler Parameter** für `inspect` und `eval`
  — Teilstring der Rahmen-Adresse, wie bei `read`. Fehlt er, gilt der
  Hauptrahmen; alle bestehenden Aufrufe bleiben unverändert.
- **Der Filter ist die erste Anweisung jedes Schnipsels.** Ein nicht adressierter
  Rahmen antwortet `{outcome: "not_the_frame"}` und **tut nichts**: keine Abfrage,
  kein `eval`. Das ist bei `eval` der Unterschied zwischen „beschrieben" und
  „eingeschränkt".
- **`click` und `type` folgen in Spec 26** (`docs/26-frame-click-type.md`) —
  zusammen mit der Ruhe-Erkennung im adressierten Rahmen.
- **Die Fehlerwahrheit von Spec 24 gilt** (`frame_not_found`,
  `frame_ambiguous`, mit `details.frames` bzw. `details.candidates`), ebenso die
  Rangfolge: Injektionsfehler (`no_agent_tab`, `page_busy`, `not_readable`)
  gewinnen, die Rahmenfehler gelten nur für Rahmen, die geantwortet haben.
- **Die Antwortfelder kommen aus dem Rahmen.** `inspect`/`eval` antworten mit
  `url`/`title` **des Rahmens**, nicht des Tabs — das ist ehrlich und wird so
  dokumentiert.

## Non-goals

- **Kein `frame` für `navigate`, `focus`, `open_tab`, `close_tab`, `screenshot`,
  `status`** (wie Spec 24).
- **`frame` für `click` und `type`** — Spec 26, nicht dieses Inkrement (geteilt
  nach dem dritten Review-Block).
- **Kein Screenshot eines Rahmens**, kein Index, kein Selektor-Zugang.
- **Kein Adressieren mit mehreren Filtern** (`frame` bleibt ein String).
- **Keine neue Berechtigung**, keine Änderung an `manifest.json`.

## Wire-Protokoll

`read`, `click`, `type`, `inspect`, `eval` tragen `frame?: string` — `read` ab
Spec 24, die übrigen vier hier. Keine neue Methode, keine neuen Codes jenseits
der beiden aus Spec 24.

## MCP-Werkzeug

`frame: {type: "string", minLength: 1}` in den Schemata von `browser_click`,
`browser_type`, `browser_inspect` und `browser_eval` (hinter den bestehenden
Eigenschaften, vor `tab`); `CLICK_ARGUMENTS`/`TYPE_ARGUMENTS`/`INSPECT_ARGUMENTS`/
`EVAL_ARGUMENTS` bekommen `frame`; die vier `UNEXPECTED_ARGUMENTS`-Sätze nennen
es; `hasDeclaredInspectArgumentTypes`/`hasDeclaredEvalArgumentTypes` prüfen den
Typ. **Die handgebauten Nutzlasten** von `clickTool` (`{selector}`) und
`typeTool` (`{selector, text, submit}`) müssen `frame` mitkopieren — heute fiele
es dort raus, ohne dass ein Schema es merkt.

## Extension

- `frameWantedOf`, `frameTargetOf`, `FrameError` und die Fehlerzweige in
  `clickErrorFor`/`typeErrorFor`/`inspectErrorFor`/`evalErrorFor` (Muster von
  `read`, Spec 24).
- `typeAgentTab` beginnt mit `const want = frameWantedOf(params, TypingError);`
  nach `typeRequestParams(params)`.
- `clickPageSource(selector, want)`, `pageStateCode(want)` **ersetzt** die
  Konstante `PAGE_STATE_CODE` (sonst läse der Zustand nach dem Klick im
  Hauptrahmen), `typePageCode(request, want)`, `inspectPageCode(request, want)`,
  `evalPageCode(cfg, want)`; `clickResult(…, want)` und `typeResult(…, want)`
  reichen `want` an den Seitenzustand weiter.
- `settlePageCode(want)`, `settlePageSource(want, …)`, `settleWindow(tabId, want
  = null)`, `settleAgentTab(tabId, halt = null, want = null)`; die Reihenfolge im
  Rennen bleibt: `SUPERSEDED_SETTLE` → `NO_SETTLE` (Frist) → Rahmenauswahl.
- `eval` behält `Array.isArray(results)` **vor** der Rahmenauswahl, sonst wird
  ein `eval_timeout` zum `frame_not_found`.
- **Konsumentenvertrag: `frameTargetOf` liefert einen Eintrag, nicht ein Array.**
  Umzustellen sind `clickOutcomeOf`, `typeOutcomeOf`, `inspectResultOf`,
  `evalResultOf` und die zwei Aufrufe des Seitenzustands (`clickResult`,
  `typeResult`) — sie lesen heute selbst `results[0]` und gäben im Zwei-Rahmen-Tab
  den falschen Rahmen zurück. `navigate` bleibt bei `want === null`.
- **Der Seitenzustand kommt aus dem Rahmen.** Fällt die Seitenantwort auf `about:`
  zurück, gilt `before` — das ist der **Tab**; der Kommentar benennt es.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | im Zwei-Rahmen-Tab bleibt der **nicht** adressierte Rahmen unverändert (kein `clicks`, kein `value`, kein `__probe`) | der Filter ist die erste Anweisung |
| `test/extension.test.js` | je eine Zusicherung `scriptCalls[0].details.frameId === 0` für `inspect` und `eval` | ohne `frame` bleibt der Hauptrahmen |
| `test/extension.test.js` | `eval_timeout` im adressierten Rahmen bleibt `eval_timeout`, nicht `frame_not_found` | die Fristprüfung steht vor der Auswahl |
| `test/mcp.test.js` | `frame: 1` ⇒ `-32602` für beide; `frame_not_found`/`frame_ambiguous` tragen ihre Sätze | Typen und Texte |

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-27, `CONTRIBUTING.md`, `## Acceptance`): Kriterium 4 ist
live und nach dem Commit zu messen; **Kernannahme** ist Kriterium 4.

1. **Ohne `frame` unverändert** (lokal). `inspect` und `eval` injizieren weiter in
   `frameId: 0`; alle bestehenden Fälle sind grün.
2. **Abfragen im Rahmen** (lokal). `inspect` und `eval` mit einem Teilstring
   arbeiten im adressierten Rahmen, der nicht adressierte bleibt unverändert, und
   die Antwort trägt `url`/`title` des **Rahmens**.
3. **Die Fehler bleiben getrennt** (lokal). `eval_timeout` bleibt `eval_timeout`;
   `frame_not_found`/`frame_ambiguous` kommen nur für antwortende Rahmen.
4. **Eine echte Abfrage im iframe** (live). Auf einer Seite mit einem iframe
   liefert `browser_inspect` mit `frame` Elemente aus dem Rahmen, `browser_eval`
   mit demselben `frame` einen Ausdruck daraus, und beide Werkzeuge **ohne**
   `frame` liefern weiter den Hauptrahmen. Die Zahlen stehen unter `## Messlauf

**Gemessen am 2026-10-29** im Profil des Betreibers, Tab 7, Extension 0.1.0, Seite
`developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe` (Rahmen `example.org`).

| Kriterium | Befund |
|---|---|
| 4 (live, `inspect`) | `browser_inspect` mit `frame: "example.org"`, `selector: "body"` ⇒ `count: 1`, `selector: "*"` ⇒ `count: 14`, Antwort trägt `url: "https://example.org/"` und den Titel des **Rahmens** |
| 4 (live, `eval`) | `browser_eval` mit `frame: "example.org"`, `code: "return document.title + ' / ' + document.querySelectorAll('p').length"` ⇒ `result: "Example Domain / 6"`, `elapsedMs: 0` |
| 4 (Gegenprobe) | dieselben Werkzeuge **ohne** `frame` antworten mit der MDN-Seite (`url: …/Reference/Elements/iframe`, `count: 1` für `h1`) — der Hauptrahmen bleibt unverändert |
| Sanity | `selector: "h1"` im Rahmen ergab `count: 0`; die heutige `example.org`-Seite hat kein `h1` (`*` liefert 14 Elemente, `body` eins). Kein Fehler, aber ein Beleg dafür, dass ein leeres Ergebnis auch ehrlich sein kann. |

**Nicht gemessen:** der Fall, dass zwei gleiche Widget-Rahmen beide werfen
(`frame_ambiguous` mit zwei echten Adressen) — er ist im Code-Fall gepinnt, live
aber nur mit passender Seite zu erzeugen.
## Dev plan

**Completed 2026-10-28** (Stufen 1 und 2; Stufe 3 ist der Abschluss des Orchestrators).

**Voraussetzung, vor Stufe 1 zu prüfen:** Spec 24, Stufen 1–5 sind gebaut. Nachweis:
`grep -n "function frameTargetOf\|function frameWantedOf\|class FrameError\|function framesAgentTab" extension/background.js`
→ vier Treffer; `grep -n "allFrames" extension/background.js` → der `allFrames`-Zweig in
`injectPageCode`. Fehlt eines davon, ist dieses Inkrement nicht startbar — dann stoppen
und melden, nicht nachbauen.

1. **Muster: `inspect` komplett durch (Extension + Bridge + Tests), dazu die
   Zwei-Rahmen-Fixture.** `extension/background.js`: `isAddressedFrame(want)` als
   **Modulfunktion** (keine Closure, sie reist per `toString()`) neben
   `describeElement`/`isVisible` in `PAGE_HELPERS_CODE` (~2509) — `want === null` ⇒
   `true`, sonst `location.href.toLowerCase().includes(want)`; die Vergleichsform
   wörtlich wie in `readPageSource` aus Spec 24. `inspectPageSource(request, want)`
   bekommt `want` als **letztes Argument** und als **erste Anweisung**
   `if (!isAddressedFrame(want)) return { outcome: "not_the_frame", href: location.href };`
   (Treffer antworten ihr normales Ergebnis plus `href`). `inspectPageCode(request,
   want)` → `pageSnippetCode(inspectPageSource, [request, want],
   selectorForElement.toString())`. `inspectAgentTab(params)`: `const want =
   frameWantedOf(params, InspectError);` nach `inspectRequestParams(params)` und
   **vor** `addressedAgentTab`; `injectPageCode(tab.id, inspectPageCode(pageRequest,
   want), { allFrames: want !== null })`; `inspectResultOf(tab.id,
   frameTargetOf(results, want))` — **Eintrag, nicht Array**. `inspectErrorFor`:
   `if (error instanceof FrameError) return frameErrorFrame(error);` als zweite Zeile;
   `frameErrorFrame` neben `readErrorFrame` — dieselbe Form (`{code, message,
   ...details}`).
   `bridge/mcp.mjs`: `frame` in `tools[6]` vor `tab`; `INSPECT_ARGUMENTS =
   ["selector","text","limit","includeHidden","frame",TAB_ARGUMENT]`;
   `UNEXPECTED_ARGUMENTS` nennt `frame`; `hasDeclaredInspectArgumentTypes` prüft
   `typeof args.frame === "string"`; die beiden Frame-Codes müssen in
   `extensionFailureText` **oberhalb** der Werkzeug-Kette stehen (aus Spec 24) — steht
   der Zweig dort, ist hier nichts zu tun.
   `test/extension.test.js`: die Zwei-Rahmen-Fixture aus 24 auf `frames: [page, …]`
   verallgemeinern; ihr `executeScript` **leitet die Antwortzahl aus
   `details.allFrames` ab** (`allFrames !== true` ⇒ `[runPageCode(code, frames[0])]`,
   sonst ein Eintrag pro Rahmen) — so scheitert ein vergessener `allFrames`-Schalter am
   fehlenden Rahmen statt still am Hauptrahmen. Fälle: `inspect` mit `frame` liefert aus
   dem Widget-Rahmen; derselbe Fall mit **umgekehrter** Antwortreihenfolge; die
   Hauptrahmen-Fixture bleibt unverändert; `frame_not_found` (Zahl) und
   `frame_ambiguous` (Kandidaten); `frame: 3` ⇒ `invalid_params` ohne Injektion.
   `PAGE_HELPERS_PIN` um `isAddressedFrame` nachziehen.
   `test/mcp.test.js`: Schema-Pin `tools[6]` und Schlüsselordnung,
   `INSPECT_UNEXPECTED_ARGUMENTS_TEXT`, Durchreich-Beweis über `callToolThroughTheSeam`,
   `frame: 1` ⇒ `-32602`, zwei Einträge für `frame_not_found`/`frame_ambiguous`.
   Proof: `node --test --test-timeout=60000 test/extension.test.js --test-name-pattern
   "inspect_"`, `… test/mcp.test.js --test-name-pattern "BrowserInspect"`.

2. **`eval`, mit der Fristprüfung vor der Auswahl.** `const want =
   frameWantedOf(params, EvalError)` in `evalAgentTab` **nach** `evalAllowed()` und nach
   `evalRequestParams` — der Schalter bleibt die erste Entscheidung (Spec 19).
   `evalPageSource(cfg, want)` mit dem Filter als erster Anweisung; `evalPageCode(cfg,
   want)`; `injectPageCode(…, { allFrames: want !== null })`. **Reihenfolge in
   `evalAgentTab` ist Vertrag:** erst `Promise.race` gegen `guard.promise`, dann
   `if (!Array.isArray(results)) throw EvalError(EVAL_TIMEOUT_CODE, …)`, **erst danach**
   `evalResultOf(tab.id, frameTargetOf(results, want))`. `evalErrorFor`:
   `FrameError`-Zweig. Tests: `eval` mit `frame` (Schalter an) liefert aus dem Rahmen;
   `frame_not_found`; der bestehende Guard-Fall zusätzlich mit `frame: "widget"` ⇒
   `eval_timeout`; `frameId: 0`-Pin in `eval_withTab_shouldEvaluateInThatTab`; für den
   Zwei-Rahmen-Fall die per-Rahmen-Variante von `evaluatingTabs` (`runWaitingPageCode`
   je Rahmen, `pageClocks` sammeln). Bridge: Schema `tools[9]`, `EVAL_ARGUMENTS`,
   `UNEXPECTED_ARGUMENTS`, `hasDeclaredEvalArgumentTypes`, Nutzlast um `frame`
   erweitern, Seam, `frame: 1`, zwei Sätze in `EVAL_REFUSAL_CASES`.
   Proof: `--test-name-pattern "eval_"` bzw. `"BrowserEval"`.

3. **Abnahme und Nachlauf — Orchestrator, nicht `ranger-1`.** Kriterien 1–3 und 5
   einzeln am Diff prüfen; die Amendments in `docs/06`, `docs/07`, `docs/09`, `docs/19`
   nachziehen; `docs/README.md`, `docs/PROJECT-STATE.md`, `docs/ROADMAP.md`; Kriterium 5
   und `## Messlauf` sind die Betreiber-Messung **nach** dem Commit.
   Proof: `npm test; echo $?` → `0` mit `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; Secret-grep → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.

### What could go wrong

- **Der Konsumentenvertrag wird an der falschen Stelle gebrochen.** `clickOutcomeOf`,
  `typeOutcomeOf`, `inspectResultOf`, `evalResultOf` und `pageResultOf` lesen seit Spec 24
  einen **Eintrag**; wer ihnen `results` gibt, bekommt über den `Array.isArray`-Fallback
  `undefined` und damit `click_failed`/`inspect_failed` — ein Fehler, der wie ein
  Seitenfehler aussieht. Immer `…Of(tabId, frameTargetOf(results, want))`.
- **`eval`: die Fristprüfung muss vor der Auswahl stehen.** Sie ist der einzige Ort, an
  dem `frameTargetOf` ein `undefined` sehen könnte; `undefined` ist kein Array, also
  `eval_timeout` — genau der Test, den Kriterium 4 verlangt.
- **Die Warte-Injektion schluckt Fehler.** `settleAgentTab` fängt alles und antwortet
  `NO_SETTLE`; ohne die `FrameError`-Ausnahme verschwindet `frame_not_found` aus der
  Ruhe-Erkennung und taucht 300 ms später aus `clickResult` wieder auf.
- **Ein Zwei-Paar-Ruhe-Fixture ist nicht baubar.** Der echte Schnipsel antwortet im
  nicht adressierten Rahmen `not_the_frame`; zwei echte Paare wären zwei Treffer und
  damit `frame_ambiguous`. Der Test lautet deshalb: Eintrag 0 = `{outcome:
  "not_the_frame", href: <Hauptrahmen>}`, Eintrag 1 = das Paar des Rahmens — und die
  Zusicherung ist „`settled`/`waitedMs` sind die des Rahmens, und es wurde **kein**
  300-ms-Rückfall armiert".
- **Ein Klick, der seinen Rahmen entfernt** (Widget schließt sich), endet bei
  `frame_not_found`, obwohl der Klick wirkte. Kein neuer Fall — `clickResult` wirft heute
  schon `ReadError` nach einem erfolgreichen Klick. Kommentar im Code, kein Kriterium.
- **`about:`-Rückfall mischt Tab und Rahmen.** So entschieden (Spec 25, `## Extension`),
  wird kommentiert, nicht repariert.
- **`PAGE_HELPERS_CODE` wächst für jede Seiten-Injektion**, auch für den Warte-Schnipsel
  jedes Klicks. `PAGE_HELPERS_PIN` zieht mit — die Absicht des Pins. Alternative
  (verworfen): die Vergleichszeile fünfmal inline, dann driften fünf Kopien.
- **`test/mcp.test.js` ist mit ~41 s die langsamste Datei.** Durchreich-Beweise über den
  Seam (billig), Sätze über je einen Fixture-Lauf; zwei Codes × vier Werkzeuge = acht
  Spawn-Fälle. Wird die Datei spürbar langsamer, gehört das unter `## Messlauf` — nicht als
  stille Änderung an `CONTRIBUTING.md` (das bleibt unangetastet).
- **Die Werkzeug-Beschreibungen bleiben unverändert.** Der Agent erfährt von `frame` über
  das Schema und über die Beschreibung von `browser_frames` (Spec 24).

### Ordering and dependencies

- Voraussetzung ist 24 (Stufen 1–5): `injectPageCode({allFrames})`, `frameWantedOf`,
  `frameTargetOf`, `FrameError`, die Bridge-Texte, `requestLine`s `frame=yes` und die
  Zwei-Rahmen-Fixture. Diese Spec ändert an `test/fixtures/fake-extension.mjs` nichts.
- 1 → 2, 1 → 3, 1 → 4: Stufe 1 legt Mechanik und Fixture an, die drei folgenden sind
  Wiederholung und untereinander unabhängig. Innerhalb jeder Stufe: Extension, dann
  Bridge, dann Tests.
- Stufe 4 ist die einzige, die `settleAgentTab` berührt — dort hängt auch `read` aus 24;
  der `want`-Parameter ist dort bereits vorhanden; diese Spec ändert den Aufrufer
  **und** den `catch` in `settleAgentTab`, damit ein `FrameError` nicht zu
  `NO_SETTLE` wird.
- `bridge/{hub,websocket,http-transport}.mjs`, `extension/protocol.js`,
  `bridge/protocol.mjs`, `extension/options.*`, `extension/manifest.json`, `CONTRIBUTING.md`,
  und `INSTALL.md` bleiben unangetastet.
  **Ausnahme mit Datum (2026-10-28, Code-Review T2):** `test/http-mcp.test.js`
  zieht mit — der Schema-Pin `tools[9]` (`["code", "tab"]`) wird unter der neuen
  Eigenschaft zwangsläufig rot. Die Datei gehört damit in die Touch boundary.

### What the next increment inherits

- **`type` bleibt ohne Ruhe-Erkennung** — eigener Zuschnitt, wenn es stört.
- **Der `about:`-Rückfall bleibt gemischt** (Tab-Zustand für eine Rahmen-Antwort).
- **Kein `frame` für `navigate`, `focus`, `open_tab`, `close_tab`, `screenshot`,
  `status`**, kein Screenshot eines Rahmens, kein Index, kein Selektor-Zugang.
- **Eltern-Kind-Beziehung der Rahmen** fehlt weiter; `about:srcdoc` und gleichnamige
  `about:blank`-Rahmen bleiben mehrdeutig.
- **`browser_frames` nennt keine Werkzeugliste**; welches Werkzeug `frame` versteht,
  steht in seinem Schema.


## Risiken

- **Vier Werkzeuge teilen sich eine Auswahlregel.** Sie liegt in
  `frameTargetOf` (Spec 24) — eine zweite Kopie wäre der nächste Drift.
- **`click`/`type` antworten mit `url`/`title` des Rahmens.** Wer die Tab-Adresse
  erwartet, liest etwas anderes; dokumentiert statt weggedeutet.
- **Die Ruhe-Erkennung im Rahmen kann länger warten**, wenn der Rahmen träge
  nachlädt — die Fristen bleiben, wie sie sind.
- **`eval` im Rahmen kann die Seite des Rahmens ändern** (Schalter aus Spec 19);
  das gilt unverändert.

## Touch boundary

Angefasst: `extension/background.js`, `bridge/mcp.mjs`, `test/extension.test.js`,
`test/mcp.test.js`, die fünf Dateien aus `## Amendments` (beim **Orchestrator**),
`docs/25-frame-handeln.md` selbst, `docs/README.md`, `docs/PROJECT-STATE.md`,
`docs/ROADMAP.md`.

**Nicht** angefasst: `extension/protocol.js`/`bridge/protocol.mjs` (keine neue
Methode), `bridge/{hub,websocket,http-transport}.mjs`, `extension/options.*`,
`extension/manifest.json`, `CONTRIBUTING.md`, `INSTALL.md`.

## Bekannte Lücken

Stand 2026-10-28, nach der Umsetzung:

- **Der `about:`-Rückfall bleibt gemischt** — `inspect`/`eval` antworten aus einem
  `about:`-Rahmen mit dem Tab-Zustand, weil der Rückfall `before` nimmt.
- **`frameErrorFrame` ist zeilengleich mit `readErrorFrame`** — zwei Rümpfe für
  eine Form; Spec-Stufe 1 hat die eigene Funktion verlangt.
- **`frameFieldsOf` gibt es dreimal** (`readPageSource`, `evalPageSource`, inline
  in `inspectPageSource`); ein vierter Aufrufer (Spec 26) wäre der Moment, die
  Regel in einen gemeinsamen Bau zu ziehen.
- **Kriterium 4 ist gemessen** (2026-10-29, `## Messlauf`): `inspect` und `eval`
  arbeiten im adressierten Rahmen, ohne `frame` unverändert im Hauptrahmen.

Stand 2026-10-28:

- **`frameTargetOf` zählt Objekt-Einträge** (aus Spec 24): liefert `executeScript`
  mit `allFrames` einmal `{}` statt eines Ergebnisses, wird das zum Kandidaten und
  der Aufruf endet bei `frame_ambiguous` statt bei einem Treffer.
- **`about:`-Rahmen antworten mit dem Tab-Zustand** (`url`/`title`), weil der
  Rückfall `before` nimmt — entschieden, nicht repariert.

Noch keine weitere — das Inkrement ist nicht begonnen.

## Open questions

Keine offenen: Adressierung, Werkzeugliste und Fehlerverhalten sind mit Spec 24
entschieden (2026-10-27). Dieses Inkrement ist der abgetrennte zweite Teil.

## Messlauf

Noch keine Messung — Kriterium 4 ist live und nach dem Commit zu messen.
Eingetragen werden: die Seite, der `frame`-Teilstring, die Trefferzahl aus
`inspect` im Rahmen, das Ergebnis eines `eval` daraus, die Gegenprobe im
Hauptrahmen und die Antwortzeit mit und ohne `frame`.

## Review

### Runde 1, 2026-10-27 — `🔧 Fix these`, Blocker: ja (F1–F4)

Zuschnitt, Adressierung, Codes (`frame_not_found`/`frame_ambiguous`,
`details.frames`/`details.candidates`) und Fehlerrangfolge sind mit Spec 24
**wörtlich identisch** — die Naht zwischen den beiden Specs trägt. Blockierend
waren vier Stellen:

1. `:28` versprach die Ruhe-Erkennung „nach `click` **und `type`**"; `type` wartet
   mit `startFixedWaitWindow` und injiziert nichts — es gibt dort keine Ruhe (F1).
2. Kriterium 5 verwies auf `## Messlauf`, den Abschnitt gab es nicht (F2).
3. `pageStateCode(want)` war als Falle benannt, hatte aber weder Kriterium noch
   Test — die Spec wäre grün abnehmbar gewesen, während `click` im Rahmen den Text
   des Hauptrahmens zurückgibt (F3).
4. Der Konsumentenvertrag „`frameTargetOf` liefert einen Eintrag" stand nur in
   Spec 24, also in der Spec ohne diese vier Werkzeuge (F4).

Gering: „`eval_timeout` im Artikelmodus" (F5), der Log-Verweis auf Befunde, die in
Spec 24 nicht protokolliert waren (F6), die Amendments-Zeile für `docs/09` ohne
`:180`/`:191` (F7), `navigate` bei `want === null` nicht festgehalten (F8), der
`about:`-Rückfall mischt Tab- und Rahmenwerte (F10).

Noch keine Runde.

### Runde 2, 2026-10-28 — `🔧 Fix these`, Blocker: ja (G1, G2)

Runde 1 (F1–F10) ist an der Stelle geprüft und sitzt. Der Dev-Plan ist am Code
geprüft und trägt bis auf zwei Sätze: alle Zeilennummern stimmen
(`PAGE_HELPERS_CODE:2509`, `PAGE_HELPERS_PIN` test `:9093`, `PAGE_STATE_CODE:2281`
mit den zwei Verbrauchern `:2783`/`:2976`, `startFixedWaitWindow:2718`),
`isAddressedFrame` als dritte Modulfunktion geht mit dem Wrapping, `frame` fällt
in `clickTool:924`, `typeTool:968` und `eval:1073` wirklich raus, und die
Werkzeug-Indizes `tools[3]/[4]/[6]/[9]` passen.

Blockierend: in Stufe 3 ging „der zweite" Verbraucher auf `pageStateCode(null)` —
das ist `typeResult`, der laut (b) auf `pageStateCode(want)` gehört (G1); und
„diese Spec ändert nur den Aufrufer" widersprach Stufe 4, die den `catch` in
`settleAgentTab` ändern muss, damit ein `FrameError` nicht zu `NO_SETTLE` wird
(G2).

Gering: die Amendments übersprangen `docs/24` und drei „keine Frames"-Non-goals
(G3), Kriterium 2 ohne `about:`-Vorbehalt (G4), die Signaturreihenfolge in
`## Extension` (G5), `CONTRIBUTING.md` in der Boundary gegen den Messhinweis (G6), das
fehlende `frameWantedOf` in Stufe 3 (G7). Alle sieben übernommen.

## Log

Runde 1 (Spec 24, dritter Block) — dieses Inkrement ist die **Teilung**: nach
`CONTRIBUTING.md` Schritt 4 wandert der Rest von Spec 24 hierher. Die dortigen Befunde
Runde 1 (Spec 25): Zuschnitt, Adressierung, Codes und Fehlerrangfolge sind mit
Spec 24 identisch. Blockierend waren vier Stellen — die erfundene Ruhe-Erkennung
für `type` (F1), der fehlende `## Messlauf` (F2), der ungeprüfte Seitenzustand aus
dem Rahmen (F3) und der Konsumentenvertrag „Eintrag statt Array", der in Spec 24
stand (F4). Alle übernommen; F5–F10 als Zeilen.

Runde 2 des Spec-Reviews — alle sieben Befunde übernommen: G1 (Verbraucher in
Stufe 3), G2 (`catch` in `settleAgentTab`), G3 (Amendments für `docs/24` und die
drei Non-goal-Zeilen), G4 (`about:`-Vorbehalt in Kriterium 2 und unter
`## Bekannte Lücken`), G5 (Signaturreihenfolge `want` zuletzt), G6 (`CONTRIBUTING.md`
bleibt unangetastet, der Messhinweis steht unter `## Messlauf`), G7
(`frameWantedOf` in Stufe 3).
