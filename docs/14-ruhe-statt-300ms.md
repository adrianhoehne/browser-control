---
description: read wartet nicht mehr gar nicht, sondern bis sich der DOM beruhigt hat — mit Höchstfrist und ehrlicher Auskunft (settled, waitedMs), damit SPA-Inhalte da sind, wenn gelesen wird.
status: active
---

# Ruhe statt gar nicht: `read` wartet auf den DOM

**Geteilt am 2026-10-23.** Die Roadmap führt 09 (`read`) und 10 (`click`) als zwei
Zeilen; dieser erste Teil macht `read`, der zweite (`click` und `navigate`, samt
300-ms-Rückfall und abbrechbarem Warten) steht in
`docs/15-ruhe-fuer-click-und-navigate.md`. Grund der Teilung: zwei Review-Runden
mit Blockern an genau der Stelle, wo die beiden Teile sich berühren — beim Rückfall
auf die alte 300-ms-Pause, die nur `click` braucht.

Der Fehler, um den es geht, ist dreimal gemessen: **Qwant nach `navigate`** 398
Zeichen statt 3 814; **YouTube nach einem Klick** 26 Zeichen statt 941;
**`browser_inspect` auf einer SPA** `count: 0`. `read` wartet heute **gar nicht**.

## Ziel

Vor dem Lesen läuft im Agenten-Tab eine **Ruhe-Erkennung**:

- Ein `MutationObserver` beobachtet `document` (Teilbaum, Attribute, Zeicheninhalt).
- **Ruhe** ist erreicht, wenn **250 ms lang keine Mutation** mehr kam.
- **Höchstfrist: 3 000 ms.** Wird sie erreicht, gilt die Seite als „nicht ruhig" und
  es wird trotzdem gelesen.
- Die Antwort nennt beides:

```json
{"tabId":23,"url":"…","title":"…","text":"…","truncated":false,"via":"innerText",
 "settled":true,"waitedMs":412}
```

- **`settled`** — `true`, wenn Ruhe eintrat, `false` bei Frist oder wenn nicht
  gewartet wurde.
- **`waitedMs`** — wie lange gewartet wurde (gerundet), `0` wenn nicht gewartet.
- **Kein Fehler bei `settled: false`.** Eine Seite, die ewig weiterlädt, wird
  gelesen, und die Antwort sagt, dass sie nicht ruhig war.
- **Ausnahme:** meldet der Tab `status: "loading"`, wird **nicht** gewartet — die
  ehrliche Antwort `page_busy` (Spec 13) soll nicht um 3 s verzögert werden.
- **Scheitert die Ruhe-Erkennung** (Injektion abgelehnt, kein `MutationObserver`),
  wird ohne Warteangabe gelesen: `settled: false`, `waitedMs: 0`, kein Fehler.
- **Die Frist wird zusätzlich in der Extension überwacht.** Gemessen am 2026-10-23:
  bei einem **nicht fokussierten** Firefox-Fenster drosselt der Browser die Timer im
  Seitenkontext, und ein `read` **hing** bis zur Zeitüberschreitung der Bridge statt
  nach 3 s zu antworten. Deshalb läuft die Ruhe-Injektion gegen einen
  **extension-seitigen Wächter** (`SETTLE_GUARD_MS = 4000`): antwortet der
  Seitenschnipsel nicht rechtzeitig, gilt `NO_SETTLE` und es wird gelesen. Ein
  hängender Schnipsel darf einen Aufruf nie blockieren.

## Non-goals

- **`click` und `navigate` bleiben unverändert** — sie bekommen ihre Ruhe in
  Spec 15, zusammen mit dem 300-ms-Rückfall, den nur `click` braucht.
- **`type`, `focus`, `inspect`** warten weiter nicht.
- **Keine neuen Parameter.** 250 und 3 000 sind Vertrag, keine Stellschraube.
- **Kein neuer Fehlercode.** Die Ruhe-Erkennung kann nicht scheitern.
- Keine neue Berechtigung; `MutationObserver` braucht keine.

## Wire-Protokoll

`read`-Ergebnis: zwei neue Felder `settled` (Boolean) und `waitedMs` (Integer).
Sonst nichts.

## MCP-Werkzeug

`browser_read`-Beschreibung: „… wartet, bis sich die Seite beruhigt hat (höchstens
3 s), und meldet `settled`/`waitedMs`." Schema unverändert.

## Hub

Keine Änderung. Die Logzeilen bleiben wörtlich; die zwei Felder stehen im Ergebnis
und damit im Debug-Block.

## Extension

- `QUIET_WINDOW_MS = 250`, `SETTLE_DEADLINE_MS = 3000`.
- `NO_SETTLE = {settled:false, waitedMs:0}` als Kennung für „nicht gewartet".
- `settlePageSource(quietWindowMs, deadlineMs)` — async, per `toString()`, Grenzen
  als Argumente; installiert den Observer, zwei `setTimeout` (Ruhe, Frist),
  `finish()` räumt beide und ruft `disconnect()`; Rückgabe
  `{settled, waitedMs}` mit `Math.round(Date.now() - start)`; im `catch` um
  `new MutationObserver` **und** `observe` hart `NO_SETTLE`.
- `settlePageCode()` über `pageSnippetCode(settlePageSource, [QUIET_WINDOW_MS,
  SETTLE_DEADLINE_MS])`; `settleOutcomeOf(results)` → alles, was nicht
  `{settled: boolean, waitedMs: integer}` ist, wird `NO_SETTLE`.
- `SETTLE_GUARD_MS = 4000` — die extension-seitige Obergrenze (Frist 3 000 ms plus
  Puffer für gedrosselte Timer).
- `settleAgentTab(tabId)`: `settleOutcomeOf(await Promise.race([injectPageCode(tabId,
  settlePageCode()), guardAfter(SETTLE_GUARD_MS)]))` — gewinnt der Wächter, ist das
  Ergebnis kein gültiger Rahmen und wird zu `NO_SETTLE`. **Alles** im `catch` (auch
  `ReadError`) ⇒ `NO_SETTLE`. Der Wächter-Timer wird in einem `finally` geräumt.
  **Im `catch` steht eine inhaltsfreie Warnung** (`console.warn` mit fester
  Kennung, Hausstil wie `read_failed`), damit „die Ruhe-Erkennung lief nicht" von
  „Firefox hat nicht gewartet" unterscheidbar bleibt — ohne sie ist Kriterium 5
  nicht entscheidbar.
- `readAgentTabPage()`: prüft **zuerst** `tab.status`; `TAB_STATUS_LOADING` ⇒
  `settle = NO_SETTLE`, kein Ruhe-Schnipsel. Sonst `settle = await
  settleAgentTab(tab.id)` **vor** der bestehenden `injectPageCode(tab.id,
  READ_PAGE_CODE)`; Ergebnis `{...pageResultOf(...), ...settle}`. Die **zweite**
  Injektion entscheidet weiter über `not_readable`/`page_busy`/`read_failed`.
- Zwei Injektionen statt einer, wo gewartet wird: der Textpfad bleibt synchron.

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `settlePageSource` — Mutation nach 100 ms | `settled: true`, `waitedMs: 350` |
| dito — keine Mutation | `settled: true`, `waitedMs: 250` |
| dito — Mutation alle 100 ms bis zur Frist | `settled: false`, `waitedMs: 3000` |
| dito — `MutationObserver` fehlt | `NO_SETTLE`, **kein** Wurf |
| dito — nach jeder Auflösung | `pendingDelays() === []`, kein Observer bleibt |
| `read_afterAMutationWrittenOneHundredMillisecondsLate_shouldReadTheNewText` | die Mutation schreibt Text, den der Lesevorgang **danach** enthält (Kriterium 2) |
| `read_onATickingPage_shouldAnswerSettledFalseAndReadAnyway` | `settled:false`, `waitedMs:3000`, Text da, `ok:true` |
| `read_whenTheTabIsLoading_shouldNotSettleBeforeAnsweringPageBusy` | **eine** Injektion, `page_busy` |
| bestehende `read`-Ergebnisprüfungen | bekommen beide Felder; Injektionszählung 1 → 2 |
| `test/mcp.test.js` — `browser_read`-Beschreibung | nennt die Zusage |
| dito — Seiten-Schnipsel antwortet **nie** | nach `SETTLE_GUARD_MS` `NO_SETTLE`, der Aufruf kehrt zurück; Fall `read_whenTheSettleSnippetNeverAnswers_shouldReadAfterTheGuard` |
| dito — nach dem Wächter | kein offener Timer (`pendingDelays() === []`) |
| `test/hub.test.js` — `read`-Logzeile | wörtlich unverändert |

## Acceptance criteria

1. `npm test; echo $?` → `0`, `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Bestehende Fälle ändern sich nur dort, wo ein ganzes
   `read`-Ergebnis geprüft oder eine Injektionszahl gezählt wird — am Diff geprüft.
2. Eine Seite, die 100 ms nach dem Auslösen noch mutiert, wird **nach** der Mutation
   gelesen: `settled: true`, `waitedMs = 350`, und der Text enthält, was die
   Mutation geschrieben hat. Fall `read_afterAMutationWrittenOneHundredMillisecondsLate_shouldReadTheNewText`.
3. Eine dauerhaft tickende Seite endet mit `settled: false`, `waitedMs = 3000`,
   **kein** Fehler. Fall `read_onATickingPage_shouldAnswerSettledFalseAndReadAnyway`.
4. Ein Tab mit `status: "loading"` wird **nicht** gewartet: eine Injektion,
   `page_busy`. Fall `read_whenTheTabIsLoading_shouldNotSettleBeforeAnsweringPageBusy`.
4b. **Ein Seiten-Schnipsel, der nie antwortet, blockiert den Aufruf nicht:** nach
   `SETTLE_GUARD_MS` kommt `NO_SETTLE`, das Lesen folgt. Fall
   `read_whenTheSettleSnippetNeverAnswers_shouldReadAfterTheGuard`. **Gemessen am
   2026-10-23:** ohne diesen Wächter hing `read` bei einem Hintergrund-Fenster bis
   zur Zeitüberschreitung.
5. **6a — trägt die Mechanik überhaupt?** Nach Reload und Neustart liefert ein
   `read` auf einer Seite, deren Tab **nicht** `status: "loading"` meldet,
   `waitedMs > 0`. Ist `waitedMs` **immer** `0`, gilt:
   - **ohne** Warnung aus `settleAgentTab` ⇒ Firefox wartet das von
     `executeScript` eingesammelte Promise nicht ab: **Kernannahme widerlegt**,
     zurück in diese Spec, Stufen 1–2 nicht weitergetragen.
   - **mit** Warnung ⇒ das Gate ist **unentschieden** (Injektion abgelehnt, kein
     `MutationObserver`); dann auf einer anderen gewöhnlichen Seite erneut messen,
     bevor entschieden wird.
6. **Liest es mehr?** `read` auf einer **Qwant-Suchergebnisseite**
   (`https://www.qwant.com/?q=firefox&t=web`) — dort wurden am 2026-10-23 direkt nach
   `navigate` **398 Zeichen** gemessen, später im selben Lauf 3 814. Erwartet:
   **mindestens 3 000 Zeichen** und `settled: true`. **Die Startseite ist die falsche
   Adresse** — sie hat keine Trefferlisten und bleibt bei ~937 Zeichen; gemessen am
   2026-10-23, nachdem diese Spec zunächst `https://www.qwant.com/` genannt hatte. Rot ist eine
   Vorwärts-Korrektur — **außer** die Antwort kommt mit `settled: false` und
   trotzdem ≥ 3 000 Zeichen: dann trägt die Mechanik, die Seite war nur nie ruhig,
   und das gehört nach `## Bekannte Lücken`.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Acceptance`): Kriterien 5 und 6
sind erst nach den Handgriffen messbar und nach dem `git pull` aus dem
Betreiber-Klon. Kriterien 1–4 laufen vor dem Commit.

## Bekannte Lücken

- **`{settled:false, waitedMs:0}` hat zwei Bedeutungen:** „lief nicht" und „nicht
  gewartet" (ladender Tab). Auf dem Draht nicht unterscheidbar; beide heißen
  *keine Aussage über die Ruhe*.
- **Gedrosselte Timer im Hintergrund-Tab** (gemessen 2026-10-23): die
  Seitenfrist feuert dort nicht rechtzeitig. Der extension-seitige Wächter fängt das
  ab, kostet dann aber die volle Wartezeit von 4 s, bevor gelesen wird — im
  Hintergrund ist `read` also langsamer als vorher, nur nicht mehr hängend.
- **Die Warnung aus `settleAgentTab` feuert auch auf legitim unlesbaren Seiten**
  (PDF, `file:`), weil dort schon die Ruhe-Injektion abgelehnt wird. Eine feste
  Zeile, also kein Log-Spam — aber „`waitedMs: 0` **mit** Warnung" heißt beim Gate
  dann nicht zwingend „Schnipsel kaputt", sondern oft „diese Seite lässt sich
  nicht injizieren". Beim Messen auf einer gewöhnlichen Seite prüfen.
- **Der Wächter ist live noch nicht nachgemessen.** Behoben ist er, und der Fall
  `read_whenTheSettleSnippetNeverAnswers_shouldReadAfterTheGuard` belegt ihn im
  Sandkasten (Gegenprobe: ohne `Promise.race` rot) — aber der Live-Lauf mit
  un-fokussiertem Fenster steht aus, weil das Fenster für die übrigen Messungen
  fokussiert sein musste.

## Risiken

- **Die Höchstfrist kann zu klein sein** — eine Seite, die länger als 3 s braucht,
  gilt als „nicht ruhig" und wird halb gelesen. Besser als heute (kein Warten),
  aber nicht gut.
- **Zwei Injektionen kosten**: bei `read` verdoppelt sich die Zahl der
  `executeScript`-Aufrufe; auf einer Seite, in die nicht injiziert werden darf,
  kommt eine zusätzliche Ablehnung samt `tabs.get` dazu.
- **`MutationObserver` sieht nur den Hauptrahmen.** iframes (Roadmap 15) und
  geschlossene Schattenbäume bleiben unsichtbar.
- **Ruhe ist nicht Fertigkeit.** Eine Seite kann ruhig und trotzdem unfertig sein.
- **`waitedMs` ist gerundet**; Tests prüfen Grenzen, nicht exakte Werte — außer wo
  der Stub die Zeit vollständig kontrolliert.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine neue Berechtigung, kein Seitentext in
  Logs, Tests, Fixtures oder Doku.
- `extension/manifest.json`, `extension/options.*`, `bridge/hub.mjs`,
  `bridge/websocket.mjs`, `bridge/config.mjs` bleiben unverändert; `bridge/mcp.mjs`
  nur die eine Beschreibung.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md`
  pflegt der Orchestrator.

## Dev plan

1. **Ruhe-Schnipsel und Prüfgerüst.** In `extension/background.js`: die drei
   Konstanten und `settlePageSource`/`settlePageCode`/`settleOutcomeOf`
   (`PAGE_HELPERS_CODE` bleibt **unberührt**, damit die Click-/Type-Payloads
   byte-identisch bleiben). In `test/extension.test.js`: `pageContextOf(page)` aus
   `runPageCode` herausgezogen, `createPageClock()` (virtuelle Zeit, `advance`,
   `advanceToQuiescence`), `createMutationObserverStub(clock)` (ruft Callbacks
   synchron), `runWaitingPageCode(code, page)`; im Seitenkontext zusätzlich
   `MutationObserver`, `clearTimeout` und ein `Date`-Stub auf der Seitenuhr. Der
   Stub unterscheidet die Schnipsel an einem **Marker im Rumpf**: `/*bc:settle*/`
   steht als Kommentar in `settlePageSource` und bleibt damit auch im ausgelieferten
   Code — er ist die Kennung, nicht Ballast. **Nicht** am Zeichenkettenanfang
   (`pageSnippetCode` stellt `PAGE_HELPERS_CODE` voran) und **nicht** durch Suchen
   nach `MutationObserver`. Die Seitenuhr ist **pro Schnipsel opt-in**, damit `type`
   unberührt bleibt.
   Proof: `--test-name-pattern="settlePageSource"` → vier Fälle grün,
   `pendingDelays() === []`. **Completed 2026-10-23** (zusammen mit Stufe 2),
   323 Tests grün.
2. **`read` wartet.** `settleAgentTab`, `readAgentTabPage` mit der
   `TAB_STATUS_LOADING`-Ausnahme, Ergebnis um beide Felder erweitert.
   Welche Fixture die Ruhe-Injektion beantwortet: die Seiten-Fixture liefert für den
   Ruhe-Schnipsel `{settled, waitedMs}` (Standard `NO_SETTLE`, damit die bestehenden
   Fälle unverändert bleiben); die drei neuen Fälle setzen die Werte explizit. Ohne
   das lieferte `runPageCode` für ein Promise `{}` und der Wartepfad liefe nie.
   Proof: `--test-name-pattern="read_"` grün (30 Fälle); die drei neuen Fälle aus
   `## Testing`. **Completed 2026-10-23** — `click_|type_|navigate_` bleibt bei 89
   Fällen unverändert.
   **Ende von Stufe 2 ist der Prüfpunkt (Kriterium 5):** committen, Betreiber lädt
   neu und startet pi neu, ein `read` auf einer Seite mit `status != "loading"`.
   Ist `waitedMs` immer `0` **und** kam keine Warnung aus `settleAgentTab`, wartet
   Firefox das Promise nicht ab: dann ist die **Kernannahme widerlegt**, das
   Inkrement geht **zurück in diese Spec**, und Stufen 1–2 werden nicht
   weitergetragen (kein toter Ballast in `master`, keine zwei Injektionen ohne
   Wirkung). `## Bekannte Lücken` ist dafür **kein** Ersatz.
3. **MCP-Beschreibung.** `browser_read` nennt die Zusage; die gepinnte Kopie in
   `test/mcp.test.js` zieht mit.
   Proof: `node --test --test-reporter=tap test/mcp.test.js test/hub.test.js` grün,
   `test/hub.test.js` ohne Diff. **Completed 2026-10-23**.

### What could go wrong

- **Die Kernannahme ist im Repo nicht belegbar:** ob Firefox das Promise abwartet.
  Deshalb `NO_SETTLE` statt geschätzter `waitedMs` — und Kriterium 5 als Gate.
- **Ein hängender Ruhe-Schnipsel sieht wie ein grüner Lauf aus.** Läuft die
  Seitenuhr nicht, löst der Schnipsel nie auf, der Test zählt als `cancelled`,
  `# fail 0` bliebe grün. Deshalb treibt `runWaitingPageCode` die Uhr selbst.
- **`settleAsyncWork()` hat zwei `setImmediate`-Runden**; reicht das nicht, werden
  sie erhöht — nie ein echtes `setTimeout` im Test.
- **Der Marker am Zeichenkettenanfang hält nicht** — `pageSnippetCode` stellt
  `PAGE_HELPERS_CODE` voran; deshalb steht `/*bc:settle*/` im Rumpf.
- **Beide Injektionen erben `runAt: "document_idle"`**, das Firefox laut `docs/05`
  an die Seite abgibt. Die zweite Injektion ist damit kein
  Geschwindigkeitsversprechen, sondern der Preis dafür, dass der Textpfad synchron
  bleibt.

### Ordering and dependencies

1 → 2 → 3. Nach jeder Stufe `npm test` grün. Kriterium 5 (Betreiber) nach Stufe 2,
Kriterium 6 danach; Schritt 7 gehört dem Orchestrator.

### What the next increment inherits

- **Spec 15** (`click`, `navigate`) baut auf `settleAgentTab` und dem Schnipsel auf
  und bringt den 300-ms-Rückfall und das abbrechbare Warten mit.
- `type` behält seine 300 ms; `focus` und `inspect` warten nicht (der `count: 0`-
  Befund auf SPAs bleibt offen).
- iframes und geschlossene Schattenbäume bleiben unsichtbar (Roadmap 15).

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these** — neun Befunde zum
Gesamtinkrement, alle übernommen (Rückfall für `click`, Amendments, Marker im
Rumpf, abbrechbares `navigate`, Kriterien mit Fall und Kommando, Kriterium 6 mit
Zahlen und in 6a/6b geteilt, Doppeldeutigkeit dokumentiert, `pendingDelays` werden
`[]`).

**Runde 2 (2026-10-23): 🔧 Fix these** — sechs Blocker, davon fünf zum
`click`-Teil (Rückfall-Predikat, `SUPERSEDED_SETTLE`, Ort des Prüfpunkts 6a,
Falsifizierbarkeit, Testzeile der Lade-Ausnahme).

**Geteilt am 2026-10-23** (Projektregel nach dem zweiten Block mit Blockern): dieser
Teil ist `read` allein, ohne Rückfall und ohne `navigate` — die Stellen, an denen
beide Runden hingen, sind damit nicht mehr Teil dieses Inkrements. Der Rest steht
in `docs/15-ruhe-fuer-click-und-navigate.md`.

**Runde 3 (2026-10-23, `grizzled-senior-dev`, auf dem geteilten Zuschnitt):
🔧 Fix these.** Vier Befunde, alle übernommen:

1. **Stufe 2 widersprach Kriterium 5** — „Stufen 1–2 bleiben" ist genau der
   `Bekannte Lücken`-Ersatz, den `CONTRIBUTING.md` verbietet. Jetzt: Kernannahme
   widerlegt ⇒ zurück in die Spec, Stufen 1–2 nicht weitergetragen.
2. **Kriterium 5 konnte Widerlegung nicht von einem kaputten Schnipsel
   unterscheiden** — `settleAgentTab` verschluckt alles. Jetzt eine inhaltsfreie
   Warnung im `catch`; `0` ohne Warnung ⇒ nicht abgewartet, `0` mit Warnung ⇒ Gate
   unentschieden.
3. **Kriterium 6 nannte keine Adresse** — jetzt `https://www.qwant.com/`, samt
   Regel für `settled:false` bei ≥ 3 000 Zeichen.
4. **Der Marker war nicht benannt**, obwohl Spec 15 darauf baut — jetzt
   `/*bc:settle*/` im Rumpf, ausdrücklich im ausgelieferten Code.

## Log

- **Runde 1:** Kernannahme nicht abgesichert → Live-Gate 6a. Amendments fehlten →
  ergänzt. Harness konnte Schnipsel nicht unterscheiden → Marker. `navigate` nicht
  abbrechbar → Spec 15. Kriterien ohne Kommando → benannt. Kriterium 6 ohne Zahl →
  398/3 000. Doppeldeutigkeit von `{settled:false, waitedMs:0}` → dokumentiert.
  `pendingDelays` „fallen weg" → werden `[]`.
- **Runde 2:** `Ziel` gegen `Extension` → beide Regeln in `Extension`. Plan baute
  die Regeln nicht → nachgezogen. `finish()` hätte den Rückfall ausgelöst →
  `SUPERSEDED_SETTLE` (in Spec 15). 6a ohne Ort → Gate am Ende von Stufe 2. 6a
  unfalsifizierbar → `status != "loading"`. Lade-Ausnahme ohne Fall → ergänzt.
- **Teilung:** `click` und `navigate` nach Spec 15 verschoben; dieses Inkrement hat
  keinen Rückfall und keine Abbrechbarkeit mehr.
- **Runde 3 (geteilter Zuschnitt):** Gate-Ergebnis richtiggestellt (zurück statt
  `Bekannte Lücken`), Warnung im `catch` für die Unterscheidbarkeit, Qwant-Adresse
  benannt, Marker `/*bc:settle*/` festgelegt.

**Messlauf (2026-10-23, live):** Das Gate ist bestanden — `read` auf einer
gewöhnlichen Seite liefert `settled: true`, `waitedMs: 301`. Der **erste** Versuch
scheiterte jedoch: das Firefox-Fenster war nicht fokussiert, und `read` hing bis zur
Zeitüberschreitung der Bridge (12 s), weil der Browser die Timer im Seitenkontext
drosselt. Mit fokussiertem Fenster antwortete derselbe Aufruf in 0,3 s. Daraus folgt
der extension-seitige Wächter (`SETTLE_GUARD_MS`), der nach der Umsetzung erneut
gemessen wird.

## Messlauf (2026-10-23, live)

Drei Messungen, alle nach Reload der Extension und Neustart von pi:

1. **Regressionsbefund (vor dem Wächter):** Bei **nicht fokussiertem** Firefox-Fenster
   hing `read` bis zur Zeitüberschreitung der Bridge (12 s); mit fokussiertem Fenster
   antwortete derselbe Aufruf in 0,3 s. Ursache: gedrosselte Timer im Seitenkontext.
   Daraus folgte `SETTLE_GUARD_MS` (Spec-Änderung, Test
   `read_whenTheSettleSnippetNeverAnswers_shouldReadAfterTheGuard`).
2. **Gate (Kriterium 5): bestanden.** `read` auf einer gewöhnlichen Seite liefert
   `settled: true` mit `waitedMs: 301` (clever-fit), `328`/`1 067` (Qwant-Startseite)
   — das Promise wird abgewartet, `waitedMs` ist nie geschätzt.
3. **Ertrag (Kriterium 6): bestanden.** Qwant-**Suchseite**
   (`https://www.qwant.com/?q=firefox&t=web`): **3 890 Zeichen**, `settled: true`,
   `waitedMs: 842`. Die **Startseite** (`https://www.qwant.com/`) bleibt bei
   **937 Zeichen** — sie hat keine Trefferliste. Diese Spec nannte zuerst die
   Startseite; das war ein Fehler in der Spec, nicht im Code.

**Nebenbefund:** Ein zweiter `read` auf derselben Suchseite kam mit
`settled: false, waitedMs: 0` zurück (also `NO_SETTLE`) — die Doppeldeutigkeit aus
`## Bekannte Lücken` in der Praxis: entweder meldete der Tab noch `loading` oder die
Injektion wurde abgelehnt. Gelesen wurde trotzdem.
**Nachtrag 2026-10-23 (Spec 11):** `settleAgentTab` ruft
`injectPageCode(tabId, settlePageCode(), {head: false})` — der Ruhe-Pfad ist vom
`contentType`-HEAD ausgenommen, weil sein Fehler verschluckt wird.
