---
description: Zwei kleine Lügen abgestellt — browser_status markiert den Agenten-Tab, damit niemand raten muss, welcher Tab dem Agenten gehört, und browser_focus meldet focused aus einer zweiten Abfrage statt aus dem Zustand von vor der Änderung.
status: active
---

# Was der Browser meldet, stimmt mit der Wirklichkeit überein

Zwei Befunde aus echten Sitzungen, beide am 2026-10-23 gemessen:

1. **Der Betreiber fragte, welcher seiner Tabs „meiner" ist.** `browser_status`
   listet alle Tabs im Default-Container, aber keiner ist markiert. Der Agent
   musste dafür `browser_focus` aufrufen — eine Aktion, um eine Frage zu
   beantworten.
2. **`browser_focus` meldete `focused: false`, obwohl das Fenster danach
   fokussiert war** — zweimal gemessen, und in Spec 08 als bekannte Lücke
   eingetragen. Ursache: `browser.windows.update` liefert den Zustand **vor** der
   Änderung zurück, und Spec 08 hat den Rückgabewert bewusst als Wahrheit
   genommen.

Beides ist derselbe Fehler in zwei Werkzeugen: die Antwort beschreibt nicht die
Wirklichkeit.

## Ziel

**Teil A — `browser_status` markiert den Agenten-Tab.** Jeder Tab bekommt ein
Feld `agent`:

```json
{"windows":[{"id":1,"focused":false,"type":"normal",
  "tabs":[{"id":2,"active":false,"pinned":false,"agent":false,"url":"about:debugging…","title":"…"},
          {"id":23,"active":true,"pinned":false,"agent":true,"url":"https://…","title":"…"}]}]}
```

- `agent: true` steht an **höchstens einem** Tab: dem, dessen Id in den
  Einstellungen der Erweiterung gespeichert ist (`readAgentTabId`) und der
  **noch existiert und im Default-Container liegt**.
- Alle anderen Tabs bekommen `agent: false` — das Feld ist **immer** da, damit
  niemand zwischen „nein" und „nicht gefragt" raten muss.
- Ist keine Id gespeichert, zeigt sie ins Leere oder liegt in einem anderen
  Container: **kein** Tab ist markiert, kein Fehler. Der Status bleibt nutzbar.
- Scheitert das Lesen der Einstellung (`storage` wirft), gilt dasselbe: kein Tab
  markiert, kein Fehler. `browser_status` darf nicht daran scheitern, dass eine
  Bequemlichkeit nicht lesbar ist.

**Teil B — `browser_focus` liest `focused` nach.** Nach
`windows.update({focused: true})` folgt ein `windows.get(windowId)`, und `focused`
kommt aus **dieser** Antwort.

- `windows.get` wirft ⇒ es gilt weiter der Rückgabewert von `windows.update`
  (der alte, womöglich zu pessimistische Stand). Das ist die schwächste
  verbleibende Aussage und steht in `## Bekannte Lücken`.
- `active` bleibt unverändert aus `tabs.update`.
- Die Fehlerregel bleibt: ein werfendes `tabs.update` ist `focus_failed`, ein
  Fensterfehler ist halber Erfolg (`ok: true`, `focused: false`).
- Kein Slot, kein Timer, keine Seitenänderung — wie bisher.

## Non-goals

- **Kein `tab`-Parameter** für die anderen Werkzeuge (das ist Roadmap 08a).
- **Keine Änderung an `read`/`click`/`type`/`inspect`/`navigate`.**
- **Kein Statusfeld „welcher Tab gehört wem"** jenseits von `agent`: kein
  Besitzer, kein Zeitstempel, keine Farbe.
- **Keine neue Logzeile** und keine Änderung an bestehenden.
- Keine neue Berechtigung. `manifest.json` führt `tabs`, `storage` und
  `<all_urls>`; `windows.getAll`/`windows.update` aus der Erweiterung brauchen
  keine eigene — `windows.get` ebenso wenig.

## Wire-Protokoll

Keine neue Methode, keine neuen Parameter.

- `status`-Ergebnis: `tabs[]` bekommt das Feld `agent` (Boolean, immer gesetzt).
- `focus`-Ergebnis: Form unverändert (`tabId`, `windowId`, `url`, `title`,
  `active`, `focused`), nur die **Herkunft** von `focused` ändert sich.

## MCP-Werkzeug

Keine Schemaänderung. Die Werkzeugbeschreibungen nennen die neue Zusage:

- `browser_status`: „… und markiert den Agenten-Tab mit `agent: true`."
- `browser_focus`: „… und meldet `focused` aus einer Abfrage **nach** dem
  Fokussieren."

## Hub

Keine Änderung. Die Logzeilen von `status` (`status windows=…`) und `focus`
(`focus tab=… window=…`) bleiben wörtlich, wie sie sind.

## Extension

- `toTabSummary(tab, agentTabId)` bekommt die Id als Argument und setzt
  `agent: tab.id === agentTabId`.
- `collectStatus()` liest die Id **einmal** vor dem Zusammenbau, in einem eigenen
  `try`: ein Fehler ergibt `null`, nicht einen abgebrochenen Status.
- `focusAgentTab`: nach dem `windows.update` ein `windows.get` in einem eigenen
  `try`; `focused` kommt aus `focusedAfter?.focused`, sonst aus
  `window?.focused` (dem alten Rückgabewert).

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/extension.test.js` — Status mit gespeicherter Agenten-Id | genau **ein** Tab hat `agent: true`, und es ist der gespeicherte |
| dito — jeder Tab im Ergebnis | hat das Feld `agent` (auch die fremden, mit `false`) |
| dito — gespeicherte Id zeigt auf einen gelöschten Tab | **kein** Tab markiert, Status kommt trotzdem, kein Fehler |
| dito — gespeicherte Id liegt in einem anderen Container | **kein** Tab markiert |
| dito — keine Id gespeichert | **kein** Tab markiert, alle `agent: false` |
| dito — `storage.local.get` wirft | Status kommt trotzdem, alle `agent: false` |
| `test/extension.test.js` — `focus`, `windows.update` liefert `focused: false`, `windows.get` danach `focused: true` | Antwort sagt `focused: true` — **das ist der Befund aus Spec 08** |
| dito — `windows.get` **sagt `focused: false`**, das Update meldete `true` | Antwort `focused: false` — beweist `??` statt `||` und schlägt ein hartkodiertes `true` |
| dito — `windows.get` wirft | `focused` aus dem Update-Rückgabewert, `ok: true` bleibt |
| dito — `windows.update` wirft (Fenster weg) | `ok: true`, `focused: false` (halber Erfolg, unverändert) |
| dito — `tabs.update` wirft | `focus_failed` (unverändert) |
| dito — genau ein `windows.get`-Aufruf nach dem Update | keine Schleife, kein zweiter Leseversuch je Fenster |
| `test/hub.test.js` — `status` und `focus` (bestehend) | Logzeilen wörtlich unverändert |
| `test/mcp.test.js` — `tools/list` (bestehende Fälle, erweiterte Erwartung) | die zwei Beschreibungen nennen die neue Zusage; Schema unverändert |

## Acceptance criteria

1. `npm test; echo $?` → `0`, Ausgabe enthält `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. **297 der 299 bisherigen Fälle** laufen unverändert —
   am Diff geprüft, nicht an der Gesamtzahl. **Zwei ändern sich, und zwar
   absichtlich:**
   - `mcp_toolsList_shouldOfferExactlyTheSevenToolsOfTheContract` pinnt die
     Werkzeugbeschreibungen wörtlich; `## MCP-Werkzeug` verlangt genau deren
     Änderung.
   - `focus_onANormalTab_shouldActivateTheTabBeforeFocusingItsWindow` pinnt die
     Aufrufsequenz per `deepStrictEqual`; `windows.get` gehört jetzt dazu. Der
     Fall pinnt danach **mehr** als vorher, nicht anderes.

   **Endstand: 308 Fälle** — 299 bestehende (zwei davon mit erweiterter
   Erwartung) plus **9 neue**: sechs zu Teil A, drei zu Teil B.
2. Bei gespeicherter Agenten-Id trägt **genau ein** Tab `agent: true` und jeder
   andere `agent: false`; Belege sind die sechs Fälle zu Teil A
   (`status_withAStoredAgentTab_shouldMarkExactlyThatTab`,
   `status_shouldCarryTheAgentFieldOnEveryTab`,
   `status_withAStaleAgentId_shouldMarkNoTab`,
   `status_withTheAgentIdInAContainerTab_shouldMarkNoTab`,
   `status_withoutAStoredAgentId_shouldMarkNoTab`,
   `status_whenTheSettingsReadFails_shouldStillAnswer`), gefahren mit
   `node --test --test-reporter=tap test/extension.test.js`.
3. `focus` meldet `focused: true`, wenn `windows.update` `focused: false`
   zurückgibt und `windows.get` danach `focused: true` liefert — Fall
   `focus_whenTheWindowUpdateReportsTheOldFocusAndTheReadReportsTheNew_shouldAnswerFocusedTrue`.
   **Das ist der Kriteriumspunkt, der die bekannte Lücke aus Spec 08 schließt.**
   Gegenprobe im selben Lauf:
   `focus_whenTheFocusReadReportsNoFocus_shouldAnswerFocusedFalse` (Update sagt
   `true`, Read sagt `false` ⇒ Antwort `false`).
4. Scheitert `windows.get`, bleibt es bei `ok: true` und dem alten Rückgabewert —
   kein `focus_failed`; Fall `focus_whenTheFocusReadThrows_shouldKeepTheUpdateAnswer`.
5. **Live-Beleg** (diese zwei Messungen, im echten Browser): `browser_status`
   zeigt genau einen Tab mit `agent: true` und der Betreiber bestätigt, dass es
   sein Agenten-Tab ist; `browser_focus` meldet beim **ersten** Aufruf
   `focused: true`, nachdem der Betreiber in ein anderes Fenster gewechselt hat.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Abnahme`): Kriterium 5 ist
erst nach den Handgriffen messbar (Extension neu laden, pi neu starten), und der
Betreiber lädt die Erweiterung aus seinem eigenen Klon — also nach dem `git pull`.
Kriterien 1–4 laufen vor dem Commit, Kriterium 5 danach; fällt es rot aus, wird
vorwärts korrigiert und die rote Zeile steht mit Datum unter `## Bekannte Lücken`.
Ist die **Kernannahme** widerlegt (die Markierung landet am falschen Tab, oder
`focused` bleibt falsch), geht das Inkrement zurück in diese Spec.

## Messlauf (Kriterium 5, 2026-10-23)

Im echten Browser, mit neu geladener Extension und neu gestartetem pi.

**Teil A — `browser_status`:** 7 Tabs in zwei Fenstern, **jeder** trägt das Feld
`agent` (`Object.hasOwn` geprüft), **genau einer** ist markiert: Tab 29
(„Wikimedia Error", der Agenten-Tab der Sitzung). Der Betreiber hat bestätigt,
dass es sein Agenten-Tab ist.

**Teil B — `browser_focus`, der entscheidende Lauf.** Ein erster Versuch war
**nicht unterscheidend** und wurde als solcher protokolliert: Fenster 1 war schon
fokussiert, und auch der alte Code hätte dort `true` gemeldet — der Fehler trat nur
auf, wenn das Fenster **nicht** vorn war. Nachdem der Betreiber in ein anderes
Programm gewechselt hatte:

| Schritt | Ergebnis |
|---|---|
| Status vorher | Fenster 1 `focused: false`, Tab 29 `active: false` — Vorbedingung erfüllt |
| `browser_focus` | `active: true`, **`focused: true`** |
| Status nachher | Fenster 1 `focused: true`, Tab 29 `active: true` |

Das ist genau die Lage, in der der alte Code zweimal `focused: false` gemeldet
hatte: `windows.update` gibt den Zustand **vor** der Änderung zurück. Jetzt wird
nachgelesen, und die Antwort stimmt mit der Wirklichkeit überein.

## Bekannte Lücken

- **`agent: true` heißt genau genommen: „ein Tab mit der gespeicherten Id liegt im
  Default-Container"** — nicht „das ist der Agenten-Tab". Firefox vergibt Ids nach
  einem Neustart niedrig neu; eine veraltete gespeicherte Id könnte auf einem Tab
  des Betreibers landen. Der Code kann das nicht unterscheiden, weil die Id das
  Einzige ist, was er hat. Deshalb ist Kriterium 5 kein Ritual: der Betreiber
  bestätigt, dass der markierte Tab wirklich der Agenten-Tab ist.
- **`windows.get` wirft ⇒ alter Rückgabewert.** Dann kann `focused: false` wieder
  zu pessimistisch sein. Das ist die schwächste verbleibende Aussage und bewusst
  so: eine Ausnahme ist kein Beweis für „nicht fokussiert".

## Dev plan

1. **Testharness: `windows.get` und drei Fenster-Schalter — nur
   `test/extension.test.js`, kein Produktivcode.** `createBrowserStub` bekommt
   `windowGetThrowsFor = []`, `windowFocusedAfter = {}`,
   `windowUpdateStaleFocusFor = []`.
   - `windows.update` bleibt der Echo-Pfad; nennt `windowUpdateStaleFocusFor` die
     Id, antwortet er `{id, focused:false}` — der gemessene Ist-Stand von vorher
     (Spec 08, `## Bekannte Lücken`).
   - neu `windows.get(windowId)`: `windowGetThrowsFor` ⇒ werfen; sonst Eintrag in
     `calls` und `{id: windowId, focused: windowFocusedAfter[windowId] ?? true}`.
     Kein Fenster-Lookup — der Kommentar an `update` („spiegelt, sucht nicht")
     gilt weiter. Der Default `true` hält jede bestehende Antwort so, wie der
     bisherige Echo sie lieferte.
   - `calls` bleibt der **einzige** Reihenfolge-Zeuge: `tabs.update`,
     `windows.update`, `windows.get` in einer Liste. Nur so ist „genau ein
     `windows.get` **nach** dem Update" eine Reihenfolge- und keine Zählaussage.
   - Durchreichen in `createSandbox`, `startBackground`, `connectedBackground`,
     Defaults inert.
   Proof: `npm test; echo $?` → `0`, `# fail 0`, `# cancelled 0`, Passzahl
   unverändert (niemand ruft `windows.get`). **Completed 2026-10-23** — zusammen
   mit Stufe 2, 305 Tests grün.
2. **Teil A: `browser_status` markiert den Agenten-Tab.** `extension/background.js`:
   - `collectStatus`: nach `windows.getAll` **einmal**
     `let agentTabId = null; try { agentTabId = await readAgentTabId(); } catch { }`,
     dann `.map((window) => toWindowSummary(window, agentTabId))`.
     `readAgentTabId` wickelt nichts; `storage.local.get` rejected mit einem plain
     `Error`, also catch-all ohne `instanceof`, ohne Logzeile.
   - `toWindowSummary(window, agentTabId)`: `…filter(isDefaultContainerTab).map((tab) => toTabSummary(tab, agentTabId))`.
   - `toTabSummary(tab, agentTabId)`: `agent: tab.id === agentTabId`.
   - **Kein** `findDefaultContainerTab` in `collectStatus`: die Liste ist schon auf
     den Default-Container gefiltert, eine tote Id oder eine Container-Id trifft
     keinen Tab — „kein Tab markiert" fällt aus der Filterung, ohne zweiten
     `tabs.get` je Status.
   - Tests: neuer Builder `createAgentWindows()` (zwei normale Fenster: 1 = 101
     Default, 102 Container, 500 Default; 2 = 201 und 202, beide im
     Default-Container),
     `requestStatusIdOne(windows = createWindows(), options = {})` — die Optionen
     werden neben Endpunkt und Token in `startBackground` gespreizt und tragen
     `settings: {agentTabId: 500}` bzw. `storageReadFailsFor`; sechs Fälle: genau ein `true` bei
     gespeicherter 500 / jedes Tab hat `agent` (`Object.hasOwn`) / Id 999 in keiner
     Liste ⇒ kein `true`, Antwort `ok:true` / Id 102 im Container ⇒ kein `true` /
     keine Id gespeichert ⇒ alles `false` / `storageReadFailsFor:["agentTabId"]`
     ⇒ `ok:true`, alles `false`. Fallnamen:
     `status_withAStoredAgentTab_shouldMarkExactlyThatTab`,
     `status_shouldCarryTheAgentFieldOnEveryTab`,
     `status_withAStaleAgentId_shouldMarkNoTab`,
     `status_withTheAgentIdInAContainerTab_shouldMarkNoTab` (zusätzlich: Fenster 1
     meldet die Tabs `[101, 500]`, beide `agent:false` — sonst wäre der Fall
     trivial wahr),
     `status_withoutAStoredAgentId_shouldMarkNoTab`,
     `status_whenTheSettingsReadFails_shouldStillAnswer`.
   Proof: `node --test --test-reporter=tap test/extension.test.js` → `# fail 0`,
   `# cancelled 0`, Passzahl = heutige + 6. **Completed 2026-10-23** —
   `# pass 6` für `--test-name-pattern='status_'`, Gesamt 305; keine
   Bestandserwartung geändert.
3. **Teil B: `focus` liest `focused` nach.** `focusAgentTab`, direkt nach dem
   `windows.update`:
   ```js
   let focusedAfter = null;
   if (window !== null) { try { focusedAfter = await browser.windows.get(tab.windowId); } catch {} }
   ...
   focused: (focusedAfter?.focused ?? window?.focused) === true,
   ```
   `??`, nicht `||`: ein ausdrückliches `false` aus `get` darf **nicht** auf den
   Update-Wert zurückfallen. Das `if` ist Absicht — ein geworfenes
   `windows.update` ist der Halb-Erfolg, dort bleibt `focused` aus
   `window?.focused`. Kommentar über der Funktion korrigieren: „nie ein zweiter
   Lesezugriff" gilt nicht mehr (Spec 12, `## Amendments`).
   Tests: `focus_whenTheWindowUpdateReportsTheOldFocusAndTheReadReportsTheNew_shouldAnswerFocusedTrue`
   (`windowUpdateStaleFocusFor:[1]`, `windowFocusedAfter:{1:true}` ⇒ `ok:true`,
   `focused:true`, `calls` = `[tabs.update, windows.update, windows.get]` — beweist
   Reihenfolge, genau einen Leseversuch und den geschlossenen Spec-08-Befund) und
   `focus_whenTheFocusReadThrows_shouldKeepTheUpdateAnswer`. Der bestehende
   Sequenzfall bekommt den dritten Eintrag `{kind:"windows.get", windowId:1}`.
   Dritter Fall (der `??`-Beweis):
   `focus_whenTheFocusReadReportsNoFocus_shouldAnswerFocusedFalse`.
   Proof: `node --test --test-reporter=tap test/extension.test.js` → `# fail 0`,
   `# cancelled 0`. **Completed 2026-10-23** — `# pass 13` für
   `--test-name-pattern='focus_'`; der Sequenzfall pinnt jetzt drei Aufrufe.
4. **MCP-Beschreibungen.** `bridge/mcp.mjs`, nur die `description` von
   `BROWSER_STATUS` und `BROWSER_FOCUS`:
   - status: „… samt Verbindungszustand der Extension, und markiert den
     Agenten-Tab mit `agent: true`."
   - focus: „… die Seite wird dabei nicht verändert, und `focused` kommt aus einer
     Abfrage nach dem Fokussieren."

   `test/mcp.test.js`: die zwei Kopien byte-gleich nachziehen. Schema, Position
   und `additionalProperties` unverändert; `bridge/hub.mjs`,
   `test/fixtures/fake-extension.mjs`, `test/hub.test.js` bleiben unberührt.
   Proof: `node --test --test-reporter=tap test/mcp.test.js` → `# fail 0`,
   `# cancelled 0`. **Completed 2026-10-23** — 65 Fälle, Gesamt 308 grün.

### What could go wrong

- **`map(toTabSummary)` ist die Falle dieser Spec.** `Array.prototype.map` reicht
  den Index als zweites Argument: der erste Tab bekäme `agentTabId = 0`. Beide
  Aufrufstellen brauchen die Pfeilfunktion.
- **Der Stub darf `focused` nicht aus dem Update spiegeln.** `windowUpdateStaleFocusFor`
  (Update sagt `false`) und `windowFocusedAfter` (Read sagt `true`) sind getrennte
  Schalter — nur ihr Zusammenspiel ist der Befund.
- **Der `get` gehört nicht in den Halb-Erfolgs-Pfad.** Ein Fenster, dessen
  `windows.update` geworfen hat, ist in aller Regel weg — eine Abfrage darauf
  würde ebenfalls werfen und die Aussage „Fenster weg" nur teurer machen. Der
  Stub-Default `true` macht diesen Fehler sichtbar, er ist nicht sein Grund.
- **`??` statt `||`**, sonst fällt ein ehrliches `false` auf den Update-Wert zurück.
- **Der Container-Fall beweist nur mit der Container-Tab im Fixture** (102) — ohne
  sie wäre „kein Tab markiert" trivial wahr.
- **Keine neue Logzeile**, auch kein `console.warn`: `formatStatusLine` zählt nur
  Tabs, `#reportFocus` liest nur Ids — beide bleiben wörtlich.

### Ordering and dependencies

1 → 2, 3, 4. Stufe 3 braucht Stufe 1 (`windows.get` samt Schaltern), Stufe 2 nur
die bestehenden Stubs. 2 und 3 sind unabhängig; 4 beschreibt die Zusage der
beiden anderen und steht deshalb zuletzt. Bestandserwartungen ändern sich in
Stufe 3 (eine) und Stufe 4 (eine), beide mit Begründung. Kriterium 5 und
`CONTRIBUTING.md` Schritt 7 gehören dem Betreiber bzw. dem Orchestrator.

### What the next increment inherits

- **Roadmap 08a** erbt `toTabSummary(tab, agentTabId)`: aus einem `agentTabId`
  wird eine Menge, das Feld `agent` bleibt. Die Markierung sitzt bewusst in der
  Funktion, die **einen** Tab formt — die kann das Feld nicht vergessen.
- **Harness:** `windows.get` plus `windowFocusedAfter`,
  `windowUpdateStaleFocusFor`, `windowGetThrowsFor`, `createAgentWindows()`.
- Offen und unverändert: Spec 11, 08f, 08g, Ruhe-Erkennung, Screenshot,
  Ausschnitte, Frames, Shadow DOM, Log-Hygiene, Kriterium 8 aus Spec 01. **Nicht
  dabei:** `tab`-Parameter, Besitzer/Zeitstempel am Tab, ein `windows.get` in
  anderen Werkzeugen, eine neue Berechtigung.

## Risiken

- **`browser_status` wird um einen `storage`-Lesezugriff teurer.** Ein Aufruf je
  Status, nicht je Tab; bei einem Fehler kostet es nichts weiter.
- **`agent: true` ist eine Momentaufnahme.** Die Id stammt aus den Einstellungen
  und wird beim Anlegen des Agenten-Tabs überschrieben. Was passiert, wenn Firefox
  nach einem Neustart dieselbe Id neu vergibt, steht unter `## Bekannte Lücken` —
  es ist die einzige Stelle, an der die Markierung lügen könnte.
- **Der zusätzliche `windows.get` ist ein zweiter Aufruf im Erfolgspfad.** Er
  ersetzt eine Behauptung durch eine Messung; das ist der Punkt des Inkrements.

## Touch boundary

- Kein Fremdcode, keine Abhängigkeiten, keine neue Berechtigung, kein Seitentext
  in Logs, Tests, Fixtures oder Doku.
- `bridge/hub.mjs`, `bridge/protocol.mjs`, `bridge/websocket.mjs`,
  `bridge/config.mjs`, `extension/manifest.json`, `extension/options.*` bleiben
  unverändert — nur `bridge/mcp.mjs` bekommt die zwei Beschreibungstexte.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md` und `INSTALL.md`
  pflegt der Orchestrator.
- **`docs/08-fokus.md` und `docs/03-mcp-browser-status.md` werden in Schritt 7
  mitgezogen**: in 08 ist die Prosa („`active` und `focused` sind das Ergebnis der
  beiden Aufrufe") und die `description` von `browser_focus` nach diesem Inkrement
  falsch, in 03 die `description` von `browser_status`. Beides korrigiert der
  Orchestrator beschreibend; der Umsetzer fasst keine fremde Spec an.

## Open questions

Keine. Beides ist mit dem Betreiber am 2026-10-23 aus der Roadmap gewählt
(Zeilen 08d und 08e) und als **ein** Inkrement zugeschnitten: dieselbe Ursache,
zwei Werkzeuge, keine Verhaltensänderung an Seiten.

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Fünf Befunde, alle
übernommen:

1. **`??` war behauptet, nicht geprüft** — `windows.update` sagt `true`,
   `windows.get` sagt `false`: ohne diesen Fall bestehen `||` und sogar ein
   hartkodiertes `true`. Neuer Fall ergänzt, Endstand der Suite benannt (308).
2. **`## Risiken` beantwortete die falsche Frage** — „höchstens ein Treffer" ist
   trivial (Ids sind eindeutig). Das echte Risiko ist ein **falsch positives**
   `agent: true`, wenn Firefox nach einem Neustart eine Id neu vergibt. Steht jetzt
   unter `## Bekannte Lücken`, und Kriterium 5 ist damit kein Ritual mehr.
3. **Kriterien 2–4 nannten keinen Fall und kein Kommando** — jetzt mit Namen und
   Kommando; „nichts wird auf Prosa abgenommen".
4. **`## Amendments` hatte keinen Eigentümer** — `docs/08-fokus.md` wird in
   Schritt 7 vom Orchestrator mitgezogen, `## Touch boundary` sagt es.
5. **Die Begründung für das `if` war eine Harness-Begründung** — jetzt die
   Produktbegründung: ein Fenster, dessen Update geworfen hat, ist weg.

**Runde 2 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Vier Befunde, alle
übernommen (der Reviewer hat die Arithmetik am Baum geprüft: 299 + 6 + 3 = 308,
und die drei bestehenden Statusfälle prüfen nur Ids und `url`, nicht die Tab-Form
— die „297 unverändert" stimmt):

1. **`## Amendments` kannte nur 08s Prosa, nicht die zwei gepinnten
   `description`-Zeilen** in `docs/03` und `docs/08`. Beide benannt, beide in
   Schritt 7 beim Orchestrator.
2. **Stufe 2 nannte keine Fallnamen**, Kriterium 2 sechs — derselbe Drift, den
   Runde 1 bei `focus` beanstandet hatte. Namen jetzt auch im Plan; der
   Container-Fall bekommt eine Zusatzprüfung, damit er nicht trivial wahr ist.
3. **`requestStatusIdOne`s zweiter Parameter war formlos** — jetzt
   `(windows = createWindows(), options = {})` mit Spreizung in `startBackground`;
   201/202 als Default-Container benannt.
4. **`windows` ist keine Berechtigung** — `manifest.json` führt nur `tabs`,
   `storage`, `<all_urls>`. Korrigiert.

## Log

Noch keine Befunde.

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten:

- **Kriterium 1 war falsch** („299 unverändert"): zwei Fälle ändern sich
  absichtlich — die gepinnten Werkzeugbeschreibungen und die Aufrufsequenz von
  `focus`. **Übernommen**, beide namentlich genannt.
- **`map(toTabSummary)` reicht den Index als zweites Argument** — der erste Tab
  bekäme `agentTabId = 0`. **Übernommen** als eigene Warnung im Plan.
- **`??` statt `||`** beim Zusammenführen von `windows.get` und Update-Wert.
  **Übernommen.**

**Nachtrag 2026-10-23 (Spec 16):** „genau ein Tab trägt `agent: true`" gilt nur noch,
solange nur einer offen ist. Mit mehreren Agenten-Tabs markiert `browser_status`
**jeden** von ihnen; die Regel „höchstens einer" ist damit überholt.
