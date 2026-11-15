---
description: Der Debug-Block auf stderr bekommt eine Whitelist je Werkzeug statt sieben verstreuter Feld-Redaktionen — ein neues Ergebnisfeld landet damit nicht mehr ungefiltert im Log.
status: proposed
---

# Was auf stderr darf: Log-Hygiene mit Whitelist

Heute redigiert **vier** der sieben `#report…`-Zweige in `bridge/hub.mjs` selbst ({...result,
text: "<n chars>"}); die anderen drei haben gar keine Sperrliste, sie haben nur Glück. (Nachgezählt am 2026-10-29: **sieben** Zweige schreiben einen
Debug-Block, **vier** sind bewusst stumm — `open_tab`, `close_tab`, `eval`,
`screenshot`; `frames` hat gar keinen Zweig.) Das ist eine **Sperrliste** — sie zählt, was ersetzt wird.
Kommt ein Ergebnisfeld hinzu (so wie in den letzten acht Inkrementen ständig),
erscheint es automatisch ungefiltert auf stderr: Seiteninhalt, `href` mit
Sitzungsschlüssel, was auch immer. Roadmap 18 dreht die Richtung um.

## Ziel

- **Eine Whitelist je Methode** an **einer** Stelle: für jedes Werkzeug steht dort,
  welche Ergebnisfelder im Debug-Block vollständig gedruckt werden dürfen (Zahlen,
  Kennungen, Formen) und welche nicht.
- **Alles, was nicht auf der Liste steht, wird nicht gedruckt.** Ein Feld, das
  niemand eingetragen hat, erscheint als Marker (Vorschlag: `"<unlisted field>"`),
  nicht mit Inhalt und nicht mit Länge — die Länge selbst kann in einem kurzen Feld
  den Inhalt verraten.
- **Seiteninhalt bleibt Länge.** `text`, `href`, `id`, `ariaLabel`,
  `selector`, `classes`, `clicked`, `typed` — was heute schon als `<n chars>`
  erscheint, bleibt so; die Whitelist entscheidet das, nicht mehr der Zufall, dass
  jemand die Zeile geschrieben hat. **`title` wird neu zur Länge** (in sechs Blöcken;
  in `status` bleibt er voll, siehe `## Risiken`) — heute erscheint er dort vollständig.
- **Die bekannten Logzeilen ändern sich nicht.** Die Zeilen `read tab=… chars=…`,
  `click …`, `inspect …` usw. sind ein eigenes, gepinntes Format und bleiben
  unangetastet; dieses Inkrement betrifft **nur** den Debug-Block
  (`logLevel: "debug"`).
- **Ein Test beweist die Richtung.** Ein künstliches Ergebnisfeld, das kein Mensch
  eingetragen hat, darf im Debug-Block nicht auftauchen — heute täte es das.

## Non-goals

- **Kein eigener Debug-Block für `open_tab`, `close_tab`, `eval`, `screenshot`** — die
  bleiben stumm, wie seit Spec 19/20/21 entschieden (ein Block für `eval` bräuchte
  zuerst eine Form-Regel für beliebiges Seiten-JSON).
- **Keine Änderung an den Logzeilen** (Format, Felder, Reihenfolge).
- **Keine Änderung an `BC_LOG_LEVEL`** oder daran, wann der Debug-Block läuft.
- **Kein Log-Rotations-/Datei-Thema** — stderr bleibt stderr.
- **Keine neue Abhängigkeit**, keine Änderung an `manifest.json`.

## Wo die Änderung sitzt

`bridge/hub.mjs`. Heute: sieben `#report…`-Zweige mit Debug-Block, jeder mit eigener Sperrliste und
teils eigenem `#logDebugResult`. Danach: **eine** Funktion `debugBlockOf(method, result)` und **eine** Tabelle `DEBUG_WHITELIST` (je Werkzeug: Feld → `full` |
`length` | `lengthEach` | `shape`; auf `drop` wird verzichtet, es hätte heute keinen
Nutzer). Die sieben `#report…`-Zweige rufen nur noch diese Funktion; die
Redaktionshelfer (`redactedPageString`, `inspectDebugResult`,
`REDACTED_INSPECT_ELEMENT_FIELDS`) gehen in der Tabelle auf.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/hub.test.js` | jeder der **sieben** Blöcke enthält genau die **vorhandenen** Whitelist-Felder in Tabellenreihenfolge (gelistete, aber fehlende Felder erscheinen nicht); die **vier** stillen Pfade (`open_tab`, `close_tab`, `eval`, `screenshot`) schreiben keinen Block | die Tabelle ist die einzige Wahrheit |
| `test/hub.test.js` | ein erfundenes Ergebnisfeld (`"surpriseField": "geheim"`) ⇒ erscheint als `"<unlisted field>"`, weder Inhalt noch Länge | Richtungsumkehr: unbekannt heißt weg |
| `test/hub.test.js` | `read` mit Seitentext ⇒ Debug-Block trägt `<n chars>`, der Text nicht | Seiteninhalt bleibt draußen |
| `test/hub.test.js` | `inspect`-Treffer mit `href`/`ariaLabel`/`classes` ⇒ Längen, nicht Werte | die alte Regel überlebt in der Tabelle |
| `test/hub.test.js` | die bestehenden Zusicherungen zu den Logzeilen (`read`, `click`, `type`, `focus`, `navigate`, `status`, `screenshot`, `eval`) bleiben **unverändert grün**; der Diff-Beweis in Stufe 4 zeigt zusätzlich, dass kein `format…Line`-Rumpf angefasst wurde | dieses Inkrement fasst sie nicht an |
| `test/hub.test.js` | `logLevel: "info"` ⇒ gar kein Debug-Block | der Schalter bleibt der Schalter |

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-29, `CONTRIBUTING.md`, `## Abnahme`): Kriterium 5 ist live
und nach dem Commit zu messen; **Kernannahme** ist Kriterium 2.

1. **Ein Ort** (lokal). Die sieben `#report…`-Zweige enthalten keine eigene
   Feld-Redaktion mehr; `DEBUG_WHITELIST` ist die einzige Stelle, die entscheidet.
2. **Unbekannte Felder erscheinen nicht** (lokal). Ein Ergebnisfeld, das nicht in
   der Tabelle steht, wird als `"<unlisted field>"` gedruckt — nicht mit Inhalt,
   nicht mit Länge.
3. **Bekanntes Verhalten bleibt** (lokal). Alle bestehenden `test/hub.test.js`-Fälle
   zu Debug-Blöcken sind grün, angepasst nur dort, wo ein Feld neu als `length`
   statt `full` geführt wird; die Logzeilen sind zeichengleich.
4. **Die Abnahme ist grün** (lokal). `npm test` (mit `# fail 0` **und**
   `# cancelled 0`), `npm run check`, Secret-grep, `manifest.json` unverändert.
5. **Ein echter Lauf mit `debug`** (live). Der Dienst mit `BC_LOG_LEVEL=debug`, ein
   `browser_read` und ein `browser_inspect` auf einer echten Seite; im stderr steht
   kein Seiteninhalt — nur Längen, Kennungen und der Marker für Unbekanntes.

## Dev plan

**Completed 2026-10-30** (alle vier Stufen; offen: E1, die Doku-Verweise auf die gelöschten Helfer, die Amendments und die Live-Messung).

**Befund vor dem Bau** (in `bridge/hub.mjs` gelesen, nicht geschätzt): `PROTOCOL.METHODS` kennt **zwölf** Methoden, `#reportResult` (`:638`) hat **elf** Zweige — `frames` hat gar keinen. Von den elf schreiben **sieben** einen Debug-Block: `status` (`:698`), `navigate` (`:705`), `focus` (`:779`) über `#logDebugResult` (`:845`), und `read` (`:716`), `click` (`:728`), `type` (`:754`), `inspect` (`:790`) mit eigener Kopie. **Vier** schreiben bewusst keinen: `open_tab` (`:804`), `close_tab` (`:816`), `eval` (`:828`), `screenshot` (`:841`). Die Spec-Zeile „sechs `#report…`-Zweige" zählt also die alten Sperrlisten, nicht die Zweige — die vier stillen Zweige bleiben stumm (§ `#reportEval`-Kommentar, Spec 19/20). `logLevel` wird heute an **fünf** Stellen mit `this.#config.logLevel === "debug"` geprüft (`:715`, `:730`, `:756`, `:792`, `:846`); `#log(message)` ist der injizierte Schreiber, ein Block ist **eine** Message mit Zeilenumbrüchen.

Die Tabelle ist eine, die Funktion ist eine — für **alle** sieben Blöcke. Nur zwei Ergebnisse sind nicht flach (`status`: `windows[].tabs[]`, `inspect`: `elements[]`), und beide sind „Objekt oder Liste von Objekten mit diesen Feldern"; das ist **eine** Regel `shape` in der Tabelle, kein Sonderfall pro Werkzeug. Ein Sonderfall bräuchte nur `eval` (sein `result` ist beliebiges JSON, kein String), und genau deshalb bleibt `eval` blocklos — die Funktion muss das nicht können.

1. **Tabelle + Funktion + Einheitstests, noch keine Verdrahtung.** In `bridge/hub.mjs` neu: `FULL`/`LENGTH`/`LENGTH_EACH`/`UNLISTED`, `shapeOf(fields)`, `const DEBUG_WHITELIST` und `export function debugBlockOf(method, result)` (liefert den fertigen Text aus `JSON.stringify(projectShape(result, table), null, 2)`, oder `null`, wenn die Methode keinen Eintrag hat). Schlüssel sind die **Methoden**namen (`[PROTOCOL.METHODS.READ]`), nicht `browser_read`: `hub.mjs` sieht den MCP-Namen nie. Signatur ohne `params` — kein Block druckt heute ein Anforderungsfeld. Regeln: `full` = Wert wie angekommen; `length` = String wird `<n chars>`, `null` bleibt `null`, alles andere wird `UNLISTED`; `lengthEach` = Liste von Strings, Eintrag für Eintrag; `shape` = Objekt mit diesen Feldern bzw. Liste davon, Feld für Feld. Reihenfolge ist die Tabellenreihenfolge, nicht gelistete Felder des Ergebnisses hängen **hinten** an, mit ihrem Schlüssel und dem Wert `"<unlisted field>"` (der Schlüssel bleibt, nur der Wert wird ersetzt — zwei Unbekannte kollidieren nicht); gelistete, aber fehlende Felder erscheinen nicht (kein `null` erfinden). Ergebnis, das kein Objekt ist, wird als JSON gedruckt (`null` bleibt `null`).

   ```js
   const DEBUG_WHITELIST = Object.freeze({
     // Byte-gleich mit Absicht: test/bridge.test.js (`INDENTED_RESULT_LINES`) und
     // test/mcp.test.js (`:4193`) pinnen genau diesen Block gegen die Fixture.
     [PROTOCOL.METHODS.STATUS]: {
       extension: shapeOf({ version: FULL, connectedAt: FULL }),
       windows: shapeOf({
         id: FULL, focused: FULL, type: FULL,
         tabs: shapeOf({ id: FULL, active: FULL, pinned: FULL, agent: FULL, url: FULL, title: FULL }),
       }),
     },
     [PROTOCOL.METHODS.NAVIGATE]: { tabId: FULL, windowId: FULL, url: FULL, title: LENGTH, complete: FULL, settled: FULL, waitedMs: FULL },
     [PROTOCOL.METHODS.READ]: { tabId: FULL, url: FULL, title: LENGTH, text: LENGTH, offset: FULL, chars: FULL, totalChars: FULL, truncated: FULL, via: FULL, mode: FULL, root: FULL, fellBack: FULL, settled: FULL, waitedMs: FULL },
     [PROTOCOL.METHODS.CLICK]: { tabId: FULL, url: FULL, title: LENGTH, clicked: LENGTH, text: LENGTH, truncated: FULL, via: FULL, settled: FULL, waitedMs: FULL },
     [PROTOCOL.METHODS.TYPE]: { tabId: FULL, url: FULL, title: LENGTH, typed: LENGTH, submitted: FULL, text: LENGTH, truncated: FULL, via: FULL },
     [PROTOCOL.METHODS.FOCUS]: { tabId: FULL, windowId: FULL, url: FULL, title: LENGTH, active: FULL, focused: FULL },
     [PROTOCOL.METHODS.INSPECT]: {
       tabId: FULL, url: FULL, title: LENGTH, count: FULL, truncated: FULL,
       elements: shapeOf({ index: FULL, selector: LENGTH, tag: FULL, id: LENGTH, classes: LENGTH_EACH, text: LENGTH, href: LENGTH, ariaLabel: LENGTH, visible: FULL, disabled: FULL, rect: shapeOf({ x: FULL, y: FULL, width: FULL, height: FULL }) }),
     },
     // Ohne Eintrag und damit blocklos: eval (Ergebnis ist beliebiges Seiten-JSON, Spec 19),
     // screenshot (base64 ist das Bild, Spec 20/21), open_tab/close_tab (die Zeile ist der
     // ganze Bericht), frames (hat gar keinen Zweig).
   });
   ```

   Die Feldinhalte stammen aus `extension/background.js` (die Fixture ist hinterher: `READ_RESULT` fehlt `offset`/`chars`/`totalChars`/`mode`/`root`/`fellBack`, `STATUS_RESULT`s Tabs fehlen `agent`) — `pageResultOf` (`:2595`) und `readAgentTabPage` (`:1942`, `{...page, ...settle}` — daher `settled`/`waitedMs` am Ende des `READ`-Eintrags), `inspectResultOf` (`:3647`), `toTabSummary` (`:773`), `navigationResult` (`:965`), `clickResult` (`:3040`), `typeResult` (`:3269`), `evalResultOf` (`:4670`), `SCREENSHOT_RESULT`. Neue Fälle in `test/hub.test.js` (Import `debugBlockOf` ergänzen): `debugBlockOf_withAKnownMethod_shouldPrintExactlyTheWhitelistedFieldsInTableOrder`, `debugBlockOf_withAnUnlistedField_shouldPrintTheMarkerInsteadOfValueAndLength`, `debugBlockOf_withAnUnlistedFieldInsideAnElement_shouldPrintTheMarkerThere`, `debugBlockOf_withAMethodWithoutATableEntry_shouldReturnNull` (für `eval`, `screenshot`, `open_tab`, `close_tab`, `frames` und eine erfundene Methode), `debugBlockOf_withALengthFieldCarryingANonString_shouldPrintTheMarkerAndKeepNull`.
   Proof: `node --test --test-name-pattern=debugBlockOf test/hub.test.js` endet mit `# fail 0`; `npm test` bleibt unverändert grün (die Funktion ist noch unbenutzt).

2. **`read` als Muster verdrahten.** Neuer privater Helfer `#logDebugBlock(method, result)`: einzige Stelle mit `logLevel`-Prüfung, ruft `debugBlockOf` und schreibt nur, wenn das Ergebnis nicht `null` ist. `#reportRead` (`:713`) verliert sein `JSON.stringify({...result, text: …})` und ruft `this.#logDebugBlock(PROTOCOL.METHODS.READ, result)`; `pageTextCharCount` bleibt (die Zeile `formatReadLine` braucht sie), die Zeile selbst bleibt zeichengleich.
   Tests: `hub_requestWithReadMethod_shouldResolveAndLogOneLineWithoutAnyPageText` (`:421`) verschärfen — `Object.keys(JSON.parse(debugEntry))` gegen die Tabellenreihenfolge, `title` als `<n chars>`; neu `hub_requestWithReadMethodAndAForeignFieldUnderDebugLogging_shouldPrintTheMarkerAndNotTheValue` (Ergebnis mit `surpriseField: "geheim"` ⇒ Block trägt `"<unlisted field>"`, der Block trägt `"surpriseField": "<unlisted field>"`, und das Log enthält `geheim` nicht); neu `hub_requestWithReadMethodUnderInfoLogging_shouldWriteNoDebugBlock` (ohne `BC_LOG`, jede `logLines`-Message beginnt nicht mit `{`).
   Proof: `node --test --test-name-pattern="ReadMethod" test/hub.test.js` ⇒ `# fail 0`.

3. **Die vier flachen Blöcke.** `#reportNavigate` (`:703`), `#reportClick` (`:728`), `#reportType` (`:754`), `#reportFocus` (`:777`) rufen nur noch `#logDebugBlock`; `clickedCharCount` (`:155`), `elementDescriptionCharCount` (`:190`) und der letzte Aufrufer von `#logDebugResult` in diesen Zweigen fallen weg (`#logDebugResult` selbst erst in Stufe 4, `status` ruft es noch). Die `format…Line`-Funktionen werden **nicht angefasst**.
   Tests: `hub_withDebugLogging_shouldLogTheNavigateLineAndTheIndentedResult` (`:375`) und `hub_requestWithFocusMethod_shouldLogOneLineWithoutUrlAndTheWholeDebugResult` (`:840`, umbenennen: „…_shouldLogOneLineAndOnlyTheWhitelistedFields") — das `deepEqual(JSON.parse(debugEntry), result)` wird zum Vergleich gegen das erwartete Blockobjekt mit `title` als Länge; `hub_requestWithClickMethodUnderDebugLogging_…` (`:627`) und `hub_requestWithTypeMethodUnderDebugLogging_…` (`:774`) bekommen die exakte Schlüsselliste.
   Proof: `node --test --test-name-pattern="NavigateMethod|ClickMethod|TypeMethod|FocusMethod" test/hub.test.js` ⇒ `# fail 0`.

4. **Die zwei verschachtelten Blöcke, dann die alten Helfer weg.** `#reportStatus` (`:696`) und `#reportInspect` (`:790`) rufen `#logDebugBlock`; `#logDebugResult` (`:845`), `inspectDebugResult` (`:296`), `redactedInspectElement` (`:309`), `REDACTED_INSPECT_ELEMENT_FIELDS` (`:307`) und `redactedPageString` (`:322`) werden gelöscht. `status` muss **byte-gleich** bleiben (Tabellenreihenfolge = Fixture-Reihenfolge, `title`/`url` dort `FULL`).
   Tests: `hub_withDebugLogging_shouldLogTheStatusLineAndTheIndentedResult` (`:348`) verschärfen auf `assert.equal(jsonLine, JSON.stringify(result, null, 2))`; `hub_requestWithInspectMethodWithDebugLog_shouldRedactEveryPageString` (`:1353`) — `debugBlock.title` wird `<${result.title.length} chars>` (die Zahl aus dem Ergebnis nehmen, nicht hinschreiben), `url` bleibt voll; ein Fall mit `surpriseField` im Element kommt dazu. Unangetastet und damit der Beweis für „kein Eintrag = kein Block": `hub_requestWithOpenTabMethod…` (`:885`), `hub_requestWithCloseTabMethod…` (`:922`), `hub_eval_shouldLogOnlyTabElapsedAndOk` (`:1478`), `hub_screenshot_shouldLogExactlyOneLineAndNoBase64EvenAtTheDebugLevel` (`:1609`).
   Proof: `node --test test/bridge.test.js test/hub.test.js` ⇒ `# fail 0` (bridge pinnt den Status-Block von außen), dann die Abnahme aus `CONTRIBUTING.md`: `npm test; echo $?` mit `# fail 0` **und** `# cancelled 0`, `npm run check; echo $?` = 0, Secret-grep ohne Ausgabe, `git status --porcelain extension/manifest.json` leer. Zusätzlich: `grep -n 'logLevel === "debug"' bridge/hub.mjs` ⇒ genau **eine** Zeile; `git grep -nE 'function (inspectDebugResult|redactedInspectElement|redactedPageString|clickedCharCount|elementDescriptionCharCount)\b|const REDACTED_INSPECT_ELEMENT_FIELDS|^  #logDebugResult' -- bridge/hub.mjs` ⇒ keine Ausgabe, Exit 1 (die Kommentare der stillen Zweige werden im selben Zug umgeschrieben: ‚kein `DEBUG_WHITELIST`-Eintrag‘ ist der ehrlichere Grund); `git diff bridge/hub.mjs | grep -E '^[-+].*(format[A-Za-z]*Line|singleLine|textSource|inspectCount)'` ⇒ keine Ausgabe (Logzeilen samt Rümpfen unberührt).

### Wer die Schlussstufe macht

**Der Orchestrator, nicht `ranger-1`:** Kriterien 1–4 am Diff prüfen, die Amendments
in `docs/05`, `docs/07`, `docs/08`, `docs/09` nachziehen, `docs/README.md`,
`docs/PROJECT-STATE.md`, `docs/ROADMAP.md` pflegen, die Spec auf `status: active`
stellen, die Prosa beschreibend machen und `## Amendments` entfernen. Kriterium 5
hakt der Betreiber ab.

### What could go wrong

- **Der `status`-Block ist außerhalb der Touch-Boundary byte-genau gepinnt.** `test/bridge.test.js:70-71,380,394` (`INDENTED_RESULT_LINES`, Zeile für Zeile) und `test/mcp.test.js:4193,4202` verlangen `JSON.stringify(STATUS_RESULT, null, 2)`. Jede andere Feldmenge, jede andere Reihenfolge und jedes `title` als Länge machen `npm test` rot, und der Umsetzer darf diese zwei Dateien nicht anfassen (Kriterium 4 verlangt trotzdem `# fail 0`). Deshalb ist `status` der einzige Eintrag mit `url` **und** `title` als `full`. Wer das angleichen will, braucht vorher eine breitere Boundary — Entscheidung des Orchestrators, nicht des Umsetzers.
- **`title` ist heute nirgends Länge.** Die Spec sagt „text, title, href … was heute schon als `<n chars>` erscheint, bleibt so" — für `title` stimmt das nicht: `status`, `navigate`, `focus` und `inspect` drucken ihn voll (`inspectDebugResult`-Kommentar `:284`). Dieser Plan macht ihn in den sechs Blöcken zur Länge (Spec-Absicht) und lässt ihn in `status` voll (siehe oben). Kosten: drei bestehende Fälle ändern sich (`:375`, `:840`, `:1419`) — genau die in Kriterium 3 erlaubte Art. Der Nutzen: ein Seitentitel hat keine Logzeile, hinter der er sich verstecken könnte (`formatOpenTabLine`-Kommentar `:225`).
- **`url` bleibt `full`, auch wenn er Query-Parameter trägt.** Sechs der elf Zeilen drucken dieselbe Adresse unmittelbar davor voll (`read tab=42 url=…`); sie im Block zu kürzen wäre Theater und würde dem Betreiber die einzige Stelle nehmen, an der er die Adresse im Block sieht. Restrisiko (Session-Parameter in der Adresse) ist älter als dieses Inkrement und steht in den Zeilen-Formaten von Spec 05/06 — nicht hier umdrehen.
- **Falsch eingetragene Felder schützt kein Test.** Kriterium 2 fängt nur *neue* Felder. Die zwei Stellen, an denen das heute weh täte, sind `eval.result` und `screenshot.base64`; beide haben bewusst keinen Eintrag und keinen Block. Wer ihnen je einen Block gibt, braucht für `result` eine reine Form-Regel (Typ/Länge), die es nicht gibt — dann ist eine neue Spec fällig, keine Zeile in der Tabelle.
- **`length` auf einem Nicht-String.** `redactedPageString` gab bisher alles Nicht-String durch (Fixtures `ariaLabel: null`). Der Plan hält `null` als `null` (die Aussage „kein aria-label" ist wertvoll) und macht aus jedem anderen Nicht-String den Marker. Kein Test in `test/hub.test.js` hängt an der alten Durchreiche; die Fixture-`null` läuft nur auf `info`.
- **Struktur ist nicht fälschbar, Inhalt schon.** Der Block entsteht in einem `JSON.stringify`, ein eingeschmuggeltes `\n` bleibt als `\\n` im String und kann keine zweite Zeile forgen (anders als eine Logzeile, die `singleLine`/`textSource` braucht). Nicht auf String-Verkettung umbauen.
- **Vier stille Zweige sind Absicht, kein Vergessen.** `open_tab`, `close_tab`, `eval`, `screenshot` und `frames` bekommen keinen Tabelleneintrag; `debugBlockOf` liefert dort `null`. Das ist die einzige Stelle, an der „unbekannt" *nichts* druckt statt eines Markers — bei einer unbekannten *Methode* gibt es keinen einzigen als sicher eingetragenen Feldschlüssel, ein Marker-Block wäre also nur Rauschen. Diese Asymmetrie gehört als Kommentar an die Tabelle, sonst liest sie sich wie eine Lücke in der Richtungsumkehr.
- **Testnamen lügen sonst.** `hub_requestWithFocusMethod_shouldLog…TheWholeDebugResult` beschreibt nach Stufe 3 nicht mehr, was der Fall prüft — im selben Diff umbenennen.

### Ordering and dependencies

Stufen 1 → 2 → 3 → 4, jede für sich grün; keine Stufe braucht eine spätere. Stufe 1 ist verhaltensfrei (die Funktion ist noch unbenutzt), deshalb bleibt `npm test` dort grün und der Review kann Tabelle und Projektion isoliert lesen. `read` kommt als Muster zuerst, weil es die kleinste Form ist (flach, kein Zusatzfeld außer `text`) und sein Debug-Fall bereits existiert. Die vier flachen Blöcke danach in **einer** Stufe: ihre Fälle existieren schon und sind der Beleg, eine weitere Teilung ergäbe Stufen ohne eigenen Beweis. `status` und `inspect` zuletzt, weil sie die einzige neue Logik (Verschachtelung) und das einzige Byte-Pin außerhalb der Boundary tragen; `#logDebugResult` und `inspectDebugResult` sterben erst hier, weil `status` sie bis dahin benutzt. Nicht umsortieren: die Helfer vor dem letzten migrierten Zweig zu löschen lässt einen halb roten Testlauf zurück. `#reportResult` (`:638`) bleibt in Zweigen und `return`s unverändert (der fehlende `return` ist der Spec-08-Verlust, Kommentar `:666`) — nur die Rümpfe der sieben Berichtsmethoden ändern sich.

### What the next increment inherits

- **`status` behält `url` und `title` in voller Länge**, bis `test/bridge.test.js` und `test/mcp.test.js` angefasst werden dürfen. Ein Folgeinkrement „einheitliche Titel-Länge" muss diese zwei Dateien mitnehmen und die Boundary ausdrücklich erweitern.
- **`title`/`url`-Entscheidung ist pro Werkzeug, nicht global.** Das ist Absicht (die Tabelle ist je Werkzeug), sieht aber wie eine Inkonsistenz aus; wer sie auflöst, ändert das Byte-Pin.
- **`drop` gibt es nicht.** Die Spec nennt `full` | `length` | `drop`; gebraucht werden `full`, `length`, `lengthEach` und `shape`. `drop` hätte heute keinen einzigen Nutzer (`eval.result` und `screenshot.base64` liegen in blocklosen Methoden), und eine ungenutzte Regel ist toter Code. Wenn der Betreiber `drop` will, ist es eine Zeile in `applyRule`.
- **`eval` und `screenshot` bleiben ohne Debug-Block** (Spec 19/20/21). Ein Block für `eval` braucht zuerst eine Regel für beliebiges JSON — nicht in diesem Inkrement.
- **`frames` hat weiterhin keinen `#report`-Zweig** und damit keine Zeile und keinen Block; ein Tabelleneintrag allein würde nichts drucken.
- **Keine neuen Abhängigkeiten, kein `manifest.json`, keine Änderung an `BC_LOG_LEVEL` oder an den Logzeilen.** Sichtbare Folge für den Betreiber: ab jetzt kann ein neues Ergebnisfeld nicht mehr stillschweigend auf stderr landen — es erscheint als `"<unlisted field>"`, und das Eintragen ist eine bewusste Zeile in `DEBUG_WHITELIST`.

## Open questions

**Keine.** Entschieden vom Betreiber am 2026-10-29:

1. **Unbekannte Felder erscheinen als `"<unlisted field>"`**, nicht weglassen — sonst
   sieht ein neues Feld aus wie „gibt es nicht". Der **Schlüssel bleibt**, ersetzt
   wird nur der Wert.
2. **Eine Tabelle `DEBUG_WHITELIST` je Methode** ist die einzige Entscheidungsstelle.
3. **Der Debug-Block darf seine Form ändern** — er ist Text für den Betreiber, kein
   Vertrag; `title` wird in den sechs redigierenden Blöcken zur Länge, in `status`
   bleibt er voll (Grund unter `## Risiken`).
4. **Kriterium 5 hakt der Betreiber ab** (Live-Messung im eigenen Profil).
## Amendments to previous spec docs

| Datei | Stellen | neu |
|---|---|---|
| `docs/05-seiteninhalt-lesen.md` | `:190`–`:196` (Logzeile, „keine Inhalte", und der Satz „`status`/`navigate`, wo der Debug-Block das Ergebnis zeigt"), `## Bekannte Lücken` (Sperrliste) | der Debug-Block ist eine Whitelist; `title` ist dort Länge |
| `docs/08-fokus.md` | `:93`–`:95` („das ganze Ergebnis"), `:123` | der Block zeigt die Whitelist, `title` als Länge |
| `docs/09-dom-abfrage.md` | `:129` („`url`, `title` bleiben"), `:345` | `title` ist Länge; alles andere bleibt |
| `docs/07-tippen.md` | `:538`–`:541` (Falle: `title` im Debug-Block trägt den getippten Text) | die Falle ist geschlossen — `title` erscheint als Länge |
| `docs/ROADMAP.md` | `:69` (Zeile 18) | erledigt |

## Risiken

- **Der `status`-Block ist außerhalb der Umsetzer-Boundary byte-genau gepinnt.**
  `test/bridge.test.js` und `test/mcp.test.js` verlangen `JSON.stringify(STATUS_RESULT,
  null, 2)` Zeile für Zeile. Deshalb ist `status` der einzige Eintrag, in dem `url`
  **und** `title` vollständig erscheinen — jede andere Wahl macht `npm test` rot, ohne
  dass der Umsetzer die Datei anfassen darf. Ein Folgeinkrement „einheitliche
  Titel-Länge" muss diese zwei Dateien mitnehmen und die Boundary erweitern.
  (Nachgetragen 2026-10-29 nach dem Dev-Plan.)

- **Der Debug-Block wird unleserlicher**, wenn zu viele Felder als Länge erscheinen.
  Die Tabelle muss großzügig `full` vergeben, wo es sicher ist (Zahlen, `tabId`,
  `count`, `truncated`, `settled`, `waitedMs`), sonst verliert der Betreiber sein
  Werkzeug.
- **Sieben Aufrufstellen umzubauen** heißt, sieben Verhalten zu vergleichen; die
  bestehenden Debug-Fälle in `test/hub.test.js` sind dabei der Beleg, nicht die
  Behauptung.
- **Ein Feld, das heute `full` ist und Inhalt trägt, wird als sicher eingetragen.**
  Die Tabelle ist eine Entscheidung, die man begründen muss — der Test mit dem
  erfundenen Feld schützt nur gegen *neue*, nicht gegen *falsch eingetragene*.

## Touch boundary

**Der Umsetzer** fasst an: `bridge/hub.mjs`, `test/hub.test.js`.

**Der Orchestrator** fasst an: diese Spec, `docs/05-seiteninhalt-lesen.md`, `docs/07-tippen.md`, `docs/08-fokus.md`, `docs/09-dom-abfrage.md`,
`docs/README.md`, `docs/PROJECT-STATE.md`, `docs/ROADMAP.md`.

**Nicht angefasst:** `bridge/mcp.mjs`, `bridge/{websocket,http-transport}.mjs`,
`extension/**`, `CONTRIBUTING.md` — **und `test/bridge.test.js` sowie `test/mcp.test.js`**,
weil dort der `status`-Block byte-genau gepinnt ist (siehe `## Risiken`).

## Bekannte Lücken

Stand 2026-10-30, nach den Stufen 1–2:

- **Ein Ergebnis, das kein Objekt ist, druckt `debugBlockOf` als JSON im Klartext.**
  So schreibt es Stufe 1 vor (für die blocklosen Methoden gedacht), und der alte Code
  war an derselben Stelle genauso undicht — aber es ist eine offene Flanke, die die
  Whitelist aussieht, als hätte sie sie geschlossen. Ein Ergebnis, das kein Objekt ist,
  gehört eigentlich als Marker gedruckt, nicht als Wert.
- **Ein Tabellen-Tippfehler reißt den Dienst** statt nur eine Anfrage: `#handleResponse`
  nimmt den Eintrag **vor** `#reportResult` aus der Liste, ein werfender `applyRule`
  lässt die Promise ewig hängen, und weil niemand `uncaughtException` fängt, endet der
  Prozess. Ein lautes Scheitern beim **Laden** der Tabelle wäre die richtige Stelle.
- **`Object.freeze` ist flach**: `shapeOf` friert seine Felder ein, die sieben
  Methodeneinträge nicht.
- **`title` als Länge ist in `click` und `type` nicht gepinnt** — beide Fälle prüfen nur
  die Schlüsselliste, nicht die Form des Wertes (`navigate`, `read`, `focus`, `inspect`
  tun es). Ein `title: FULL` in der Tabelle bliebe dort grün.
- **`__proto__` als Feldname fällt lautlos weg**, statt den Marker zu tragen
  (`projected[field] = UNLISTED` greift den Setter). Kein Leak, keine Pollution, aber
  die Zusage „der Schlüssel bleibt" gilt für diesen einen Namen nicht.

## Messlauf

Noch keine Messung — Kriterium 5 ist live und nach dem Commit zu messen.

## Review

### Runde 1, 2026-10-29 — `🔧 Fix these`, Blocker: L1–L7

Der Plan hat den Code ehrlich nachgelesen: elf Zweige, sieben Blöcke, vier stumme,
alle Helfernamen und Zeilennummern stimmen, der `status`-Byte-Pin in
`test/bridge.test.js`/`test/mcp.test.js` ist real, und kein bestehender Fall prüft
heute ein unbekanntes Feld — die Richtungsumkehr ist wirklich neu.

Blockierend: L1 (die `read`-Tabelle vergaß `settled`/`waitedMs`, die die Extension
über `{...page, ...settle}` liefert), L2 (`## Open questions` führte zwei entschiedene
Fragen, die Abnahme stand nirgends), L3 (die Touch boundary nannte die zwei
Byte-Pin-Dateien nicht), L4 (vier Stellen sagten weiter „sechs", eine davon
Kriterium 1), L5 (`## Ziel` behauptete, `title` sei heute schon Länge), L6 (der
Grep-Beweis konnte nicht grün werden, weil die Kommentare der stillen Zweige den
alten Helfer nennen), L7 (der neue Test prüfte auf eine erfundene Länge „11").

Gering: L8 (fünf statt sieben `logLevel`-Prüfstellen), L9 (die `unlisted`-Regel sagte
nicht, dass der Schlüssel bleibt), L10 (zwei Signaturen für `debugBlockOf`), L11 (der
Diff-Beweis griff nur Signaturen), L12 (eine Testing-Zeile war kein Testfall). Alle
zwölf übernommen.

### Runde 2, 2026-10-29 — `🔧 Fix these`, Blocker: M1

L1–L12 sind nachprüfbar, und die sieben Tabelleneinträge treffen die Ergebnisse von
`collectStatus`, `navigationResult`, `pageResultOf`, `clickResult`, `typeResult`,
`inspectResultOf` und `described` **feld- und reihenfolgegenau** — auch `status`
(Byte-Pin hält, weil fehlende Felder nicht erscheinen) und `read` (`settleOutcomeOf`
wirft das `href` aus `frameFieldsOf` weg, also kein Streufeld im iframe-Fall). Zahlen
stimmen: zwölf Methoden, elf Zweige, sieben Blöcke, vier stille, fünf
`logLevel`-Prüfstellen, sechs `title`-Längen.

Blockierend war M1: die `title`-Länge macht fünf Stellen in aktiven Specs falsch
(`docs/05:196`, `docs/08:93-95` + `:123`, `docs/09:129` + `:345`, `docs/07:538-541`),
die `## Amendments`-Tabelle nannte nur `docs/05:190-192` und `ROADMAP:69`, und die
Touch boundary gab dem Orchestrator keine dieser Dateien.

Gering: M2 (`<12 chars>` — „Beispielseite" hat 13), M3 (`inspectionResultOf` heißt
`inspectResultOf`, Extension-Zeilen driften), M4 (Testing-Zeile „genau die Felder"
gegen „fehlende erscheinen nicht"), M5 (das Eingangsbild „jeder Zweig redigiert" gilt
für vier von sieben), M6 (niemand sagte, wer die Schlussstufe macht). Alle sechs
übernommen.

Noch keine Runde.

### Code-Review Stufen 1–2, 2026-10-30 — `✅ Ship it`

Die Tabelle trifft `pageResultOf`/`clickResult`/`typeResult`/`navigationResult`/
`inspectResultOf`/`toTabSummary`/`collectStatus` feld- und reihenfolgegenau; der
`status`-Block bleibt byte-gleich, weil fehlende gelistete Felder nicht erscheinen.
Sechs Befunde, keiner blockierend: D1 (`debugBlockOf` fragte die Prototypenkette —
`"constructor"` lieferte einen Marker-Block statt `null`), D2 (`applyRule` fiel bei
unbekanntem Regelnamen auf `shape` zurück), D3 (zwei Abwehrzweige ungetestet, davon
einer fail-open), D4–D6 Kosmetik. Entscheidend: Kriterium 2 für `read` entschieden,
Kriterium 1 noch nicht. D1, D2 und die zwei Abwehrfälle sind in Stufen 3–4
mitgenommen.

### Code-Review Stufen 3–4, 2026-10-30 — `✅ Ship it`

Sechs Zweige migriert plus `read` = sieben Aufrufe von `#logDebugBlock`,
`logLevel === "debug"` genau eine Stelle, die alten Helfer ohne Aufrufer, die
`format…Line`-Rümpfe nachweislich unberührt, die vier stillen Pfade diff-unberührt.
Kriterien 1–4 entschieden. Fünf Nits, keiner blockierend: E1 (`title` als Länge ist in
`click`/`type` nicht gepinnt), E2 (`__proto__` als Feldname fällt weg statt Marker),
E3 (die Lückenzeile zu D2 beschrieb „Timeout", tatsächlich hängt die Promise und der
Prozess kann sterben — korrigiert), E4/E5 Kommentar- und Zahlenreste.

**Zwei Korrekturen am eigenen Text**, die der Reviewer gefunden hat: `pageTextCharCount`
und `lengthOf` **dürfen nicht** gleich sein (`"12"` gegen `"<12 chars>"`), und die
verbleibenden `logLevel`-Stellen waren vier Stellen mit sechs Zweigen dahinter, nicht
vier Zweige.

## Log

Runde 1: L1–L12, alle übernommen. Runde 2: M1–M6, alle übernommen — darunter der
einzige echte Blocker (die Amendments übersahen drei aktive Specs) und zwei
erfundene Zahlen.

Code-Review Stufen 1–2: D1 (Object.hasOwn) und D2 (unbekannte Regel wirft) in Stufen
3–4 übernommen, die zwei Abwehrfälle als Tests nachgelegt, D4–D6 als Kosmetik offen
gelassen. Code-Review Stufen 3–4: E3 sofort in `## Bekannte Lücken` korrigiert, E4
(Kommentar mit dem gelöschten Helfer) als Kleinigkeit notiert, E1 zurückgestellt —
Testcode gehört zu `ranger-1`.
