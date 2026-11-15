---
description: browser_read bekommt mode article und liefert dann nur den Artikeltext — ohne Navigation, Fußzeile, Sidebar und Cookie-Banner —, damit eine Aufgabe nicht die halbe Seite in den Kontext zieht.
status: active
---

# Nur der Artikel: `browser_read` mit `mode: "article"`

`browser_read` liefert heute den **ganzen** sichtbaren Text: Navigation,
Fußzeile, Sidebar, „Das könnte dich auch interessieren", Cookie-Banner. Auf
einem Wikipedia-Artikel sind das 78 958 Zeichen (Messlauf von Spec 22) — der
Artikel selbst ist ein Bruchteil davon. Jede Leseaufgabe zahlt das mit Kontext,
und der Agent muss im Rauschen die Absätze finden.

Dieses Inkrement gibt `read` einen Modus, der den **Artikelkörper** liefert. Es
ist ausdrücklich **keine** Zusammenfassung und keine Sprachverarbeitung: die
Auswahl passiert mit einer Heuristik über das DOM, im Seitenkontext, ohne
Netzwerk und ohne Modell.

## Ziel

`browser_read({tab?, offset?, maxChars?, mode?})` — `mode` ist `"text"`
(Default, heutiges Verhalten) oder `"article"`:

```json
{"tabId":4,"url":"https://de.wikipedia.org/wiki/Firefox","title":"Mozilla Firefox – Wikipedia",
 "text":"Mozilla Firefox ist …","offset":0,"chars":18420,"totalChars":51234,
 "truncated":true,"via":"innerText","mode":"article","root":"main",
 "fellBack":false,"settled":true,"waitedMs":241}
```

Die Zahlen im Beispiel sind **erfunden** (Form und Feldreihenfolge sind der
Vertrag); die echten stehen nach der Messung unter `## Messlauf`.

- **`mode: "article"`** wählt **einen** Wurzelknoten und liest nur dessen Text.
  `mode: "text"` (oder weggelassen) verhält sich **exakt** wie heute.
- **Die Auswahl in drei Stufen**, in dieser Reihenfolge:
  1. **Semantische Wurzel**: `article`, `main`, `[role="main"]`, `#content`,
     `#main` — der **erste** Treffer, der mindestens `ARTICLE_MIN_CHARS = 500`
     Zeichen Text hat. Danach **steigt sie ab** wie Stufe 2: hält ein innerer
     Block mindestens `INNER_BLOCK_RATIO = 0.8` des Textes der Wurzel, wird er
     genommen (Wikipedia: `main` → `#mw-content-text`, 75 408 von 75 840).
  2. **Dichte-Heuristik**: gibt es keine solche Wurzel, werden `div`/`section`-
     Kandidaten bewertet (Textmenge, Anzahl der Absätze, Linkdichte) und der
     beste genommen — ebenfalls nur ab 500 Zeichen.
  3. **Rückfall**: findet auch die Heuristik nichts Brauchbares, wird der ganze
     Seitentext geliefert, aber **ehrlich markiert**: `fellBack: true`,
     `root: null`.
- **`root`** nennt, was genommen wurde: **der Selektor, der getroffen hat** —
  `"article"`, `"main"`, `"[role=\"main\"]"`, `"#content"`, `"#main"` —, bei der
  Heuristik `"density"`, beim Rückfall `null`. Der Agent sieht damit, ob er einem
  Ausschnitt traut; das Vokabular ist Teil des Vertrags, weil es in der Antwort
  steht.
- **Bereinigung** innerhalb der gewählten Wurzel — das ist der Punkt: `nav`,
  `header`, `footer`, `aside`, `form`, `script`, `style`, `noscript`, `iframe`
  bleiben draußen **und** Knoten, die wie ein Cookie-/Zustimmungsbanner aussehen
  (`[id*="cookie" i]`, `[class*="cookie" i]`, `[aria-label*="cookie" i]`,
  dieselben Muster für `consent`) werden entfernt — **und** die Footer-Familie
  `[role="contentinfo" i]`, `[class*="footer" i]`, `[id*="footer" i]`, weil viele
  Seiten ihren Fuß als `div` und nicht als `<footer>` bauen (Wikipedia:
  „Datenschutz" 15× im Artikeltext, bevor diese Muster dazukamen). Die Bereinigung arbeitet auf
  einer **Kopie** — die Seite des Betreibers wird nicht verändert.
- **`offset`/`maxChars` gelten im Artikelmodus auf dem gefilterten Text**, mit
  derselben Semantik wie in Spec 22 (Fenster in der Seite, `truncated` =
  `offset + chars < totalChars`, `offset > totalChars` ⇒ `offset_out_of_range`).
  Ein Agent kann also auch einen Artikel blättern.
- **`via`, `settled`, `waitedMs`, `url`, `title`** bleiben unverändert; `via`
  sagt weiter, ob `innerText` oder `textContent` die Quelle war.
- **Kein Netzwerk, kein Modell, keine neue Berechtigung.** Alles passiert im
  Seitenkontext mit dem DOM, das ohnehin da ist.

## Non-goals

- **Keine Zusammenfassung, keine Sprache, kein LLM.** Die Auswahl ist eine
  Heuristik über Tags, Textmengen und Klassen — mehr nicht.
- **Kein Vendoring von Readability.js oder einer anderen Bibliothek.** Der
  Betreiber hat das am 2026-10-27 entschieden: keine fremde Quelle im Repo, keine
  stille Abhängigkeit.
- **Kein `mode` für `click`/`type`/`inspect`.** Nur `read` liest Text.
- **Kein Anspruch auf Perfektion.** Eine Heuristik irrt; `root` und `fellBack`
  machen den Irrtum sichtbar, statt ihn zu verstecken.
- **Keine Bilder, keine Tabellen-Sonderbehandlung** über das hinaus, was
  `innerText` ohnehin tut.
- **Kein anderer Text und keine anderen Werte für `mode: "text"`** — der
  Textpfad bleibt Zeile für Zeile, geändert wird nur die Antwort: sie trägt
  zusätzlich `mode: "text"` (und weiterhin kein `root`/`fellBack`).

## Wire-Protokoll (ein Parameter mehr)

`read` bekommt `mode: "text" | "article"`; fehlt er, gilt `"text"`. Die Antwort
trägt in beiden Modi `mode`; **nur** im Artikelmodus zusätzlich `root` und
`fellBack` (im Textmodus sind beide nicht vorhanden — kein `null`, kein `false`,
das etwas behauptet).

Neue Codes: keine. Ein unbekannter `mode` ist `invalid_params` (vor der
Injektion geprüft, wie `offset`/`maxChars` in Spec 22).

## MCP-Werkzeug

`browser_read` bekommt `mode` als vierte optionale Eigenschaft
(`type: "string"`, `enum: ["text", "article"]`), Reihenfolge `offset`, `maxChars`,
`mode`, `tab`. Die Beschreibung nennt den Nutzen in einem Satz: „`mode: article`
liest nur den Artikelkörper — ohne Navigation, Fußzeile und Cookie-Banner."

`READ_ARGUMENTS` bekommt `mode`. Die Prüfung bleibt **geteilt wie bisher**: die
Bridge prüft den **Typ** (ein Nicht-String ist `-32602`), den **Enum-Wert** prüft
die Extension (`"Artikel"` ⇒ `invalid_params`). Das ist dieselbe Regel wie bei
`maxChars` (Schema nennt `1 … 100000`, die Bridge prüft `integer`, die Extension
den Bereich) — eine zweite `READ_MODES`-Liste in der Bridge wäre die zweite
Meinung mit eigenem Drift, die `bridge/mcp.mjs:654-666` ausdrücklich ablehnt.

## Hub

Die Logzeile bleibt, wie sie ist: `chars=`, `truncated=`, `via=`, kein
Textinhalt; `mode` wird **nicht** geloggt. Der **Debug-Block** trägt dagegen die
neuen Felder, weil er `{...result}` mit gekürztem `text` schreibt — `mode`,
`root` und `fellBack` erscheinen dort ab jetzt. Kein Geheimnis, aber der Satz
soll nicht „Debug-Ausgabe bleibt gleich" bedeuten.

## Extension

- `READ_MODES = ["text", "article"]`, `READ_MODE_DEFAULT = "text"`,
  `ARTICLE_MIN_CHARS = 500`; `readRequestParams` prüft `mode` (String, einer der
  zwei Werte) **mit** `offset`/`maxChars`, vor der Tab-Auflösung.
- `readPageSource(offset, maxChars, mode, minChars, urlLimit, titleLimit)` —
  `minChars` fährt mit, weil der Schnipsel über `toString()` in den Seitenkontext
  reist und keinen Modulscope sieht (`ARTICLE_MIN_CHARS` darf nicht als Literal
  zweimal im Repo stehen):
  - `mode === "text"`: unveränderter Pfad.
  - `mode === "article"`: `articleRoot()` wählt die Wurzel (drei Stufen), dann
    `withoutChrome(root)` entfernt die genannten Elemente auf einer Kopie, dann
    läuft `normalise` über deren `innerText` — **mit derselben `via`-Regel wie im
    Textpfad**, angewandt auf die bereinigte Kopie: ist das normalisierte
    `innerText` leer, wird `textContent` **derselben Kopie** genommen und `via:
    "textContent"` gemeldet. Ohne diese Regel meldet eine SPA-Seite einen leeren
    Artikel als Erfolg.
  - **Leert die Bereinigung die gewählte Wurzel vollständig**, gilt derselbe
    Rückfall wie „nichts gefunden": `fellBack: true`, `root: null`, ganzer
    Seitentext. Ein leerer Artikel mit `fellBack: false` wäre die unehrlichste
    aller Antworten.
  - Die Antwort trägt `mode`, im Artikelmodus zusätzlich `root` und `fellBack`.
- `pageResultOf`/`isUsablePageResult`: `mode` ist Pflichtfeld (`"text"` oder
  `"article"`); `root`/`fellBack` sind im Artikelmodus Pflicht (`root` darf `null`
  sein), im Textmodus **verboten** — eine Seitenantwort, die im Textmodus
  `root` setzt, ist eine Panne der Seite und wird `read_failed`.
- `readPageCode` bekommt `mode` als Argument (der Code-String wächst um ein
  Literal `"text"`/`"article"`).

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `mode: "text"` und weggelassen liefern identische Antworten (inklusive fehlendem `root`/`fellBack`) | Rückwärtskompatibilität |
| `test/extension.test.js` | `mode: "article"` auf einer Seite mit `<article>` nimmt `root: "article"` und liefert **nur** dessen Text (`<nav>`- und `<footer>`-Text fehlt) | Stufe 1 der Auswahl (die Innenreinigung belegt die Zeile darunter) |
| `test/extension.test.js` | Seite ohne semantische Wurzel, aber mit einem dichten `<div>` (viele Absätze, wenige Links) ⇒ `root: "density"`, Text aus diesem Block | Stufe 2 |
| `test/extension.test.js` | Seite mit nur Navigation und 200 Zeichen Text ⇒ `fellBack: true`, `root: null`, ganzer Text | Stufe 3, ehrlich markiert |
| `test/extension.test.js` | Cookie-Banner (`<div class="cookie-consent">`) innerhalb der Wurzel ist im Ergebnis **nicht** enthalten | die Banner-Muster |
| `test/extension.test.js` | `<nav>`, `<aside>` und `<form>` **innerhalb** der gewählten Wurzel fehlen im Text, während der Absatztext bleibt | die Bereinigung greift in der Wurzel, nicht nur bei Geschwistern |
| `test/extension.test.js` | leere Wurzel nach der Bereinigung (nur `<nav>` im `<article>`) ⇒ `fellBack: true`, `root: null`, ganzer Seitentext | die unehrlichste Antwort (leerer Artikel mit `fellBack: false`) ist ausgeschlossen |
| `test/extension.test.js` | Artikelmodus auf einer Seite ohne `innerText`-Text (SPA) ⇒ `fellBack: true`, `root: null`, `text` aus der skriptbefreiten Body-Kopie | eine `innerText`-lose Seite landet im Rückfall, nicht in einem leeren „Artikel" |
| `test/extension.test.js` | die Seite wird nicht verändert: die entfernten Knoten sind nach dem Aufruf im DOM noch da (der Stub gibt die Kopie, der Original-Baum bleibt unberührt) | Bereinigung auf einer Kopie |
| `test/extension.test.js` | `offset`/`maxChars` im Artikelmodus schneiden auf dem gefilterten Text; `offset > totalChars` ⇒ `offset_out_of_range` | Fenster-Semantik gilt auch hier |
| `test/extension.test.js` | `mode: "Artikel"` ⇒ `invalid_params`, `tabs.scriptCalls` leer | Prüfung vor der Injektion |
| `test/extension.test.js` | Textmodus-Antwort mit gesetztem `root` ⇒ `read_failed` (Panne der Seite) | die Strenge der Antwortprüfung |
| `test/mcp.test.js` | `mode` wird durchgereicht (`"article"` kommt an), `mode: 1`/`null`/`["article"]` ⇒ `-32602` ohne Anfrage, unbekanntes Argument ⇒ Werkzeugsatz | Typ-Prüfung in der Bridge; der Enum-Wert ist Sache der Extension |
| `test/mcp.test.js` | die Beschreibung nennt `mode: article` und den Nutzen | der Agent findet den Modus |

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-27, `CONTRIBUTING.md`, `## Abnahme`): Kriterium 8 ist
live und nach dem Commit zu messen (Reload der Erweiterung, ein echter Artikel).
Fällt die **Messung** daneben (Größenordnung, ein Chrome-String, die Zeit), wird
vorwärts korrigiert und die rote Zeile steht unter `## Bekannte Lücken`. Ist die
**Kernannahme** widerlegt — der Artikeltext wird nicht kleiner, der erste Satz
fehlt, oder jede Seite landet auf `fellBack` —, geht das Inkrement **zurück in
diese Spec**; `## Bekannte Lücken` ist dafür kein Ersatz.

1. **Textmodus unverändert bis auf das neue Feld** (lokal). `mode: "text"` und
   „ohne `mode`" liefern **denselben Text und dieselben Werte** wie der Stand vor
   diesem Inkrement; die Antwort trägt zusätzlich `mode: "text"`, und `root`/
   `fellBack` fehlen. Beleg: die zwei Aufrufe sind untereinander deckungsgleich,
   und `git diff test/extension.test.js` zeigt in den fünf Objektvergleichen der
   `read`-Fälle **genau eine** zusätzliche Zeile (`mode`).
   **Completed 2026-10-27**

2. **Semantische Wurzel** (lokal). Auf einer Seite mit `<article>` ist
   `root: "article"` und der Text enthält weder `<nav>`- noch `<footer>`-Inhalt.
   **Completed 2026-10-27**

3. **Dichte-Heuristik** (lokal). Ohne semantische Wurzel greift Stufe 2
   (`root: "density"`) und nimmt den dichten Block.
   **Completed 2026-10-27**

4. **Ehrlicher Rückfall** (lokal). Findet keine Stufe etwas, ist
   `fellBack: true`, `root: null`, und der Text ist der ganze Seitentext.
   **Completed 2026-10-27**

5. **Kein Banner im Artikel** (lokal). Ein Cookie-Banner innerhalb der Wurzel
   fehlt im Ergebnis; die Seite bleibt unverändert.
   **Completed 2026-10-27**

6. **Fenster gilt auch hier** (lokal). `offset`/`maxChars` schneiden auf dem
   gefilterten Text, `offset_out_of_range` kommt wie in Spec 22.
   **Completed 2026-10-27**

7. **`mode` wird geprüft, an der richtigen Stelle** (lokal). Der **Typ** wird in
   der Bridge geprüft: `1`, `null`, `["article"]` ⇒ `-32602`, keine Anfrage. Der
   **Enum-Wert** wird in der Extension geprüft: `"Artikel"`, `"ARTICLE"`, `""` ⇒
   `invalid_params`, keine Injektion (`tabs.scriptCalls === []`).
   **Completed 2026-10-27**

8. **Ein echter Artikel verliert seine Chrome** (live). Auf
   `https://de.wikipedia.org/wiki/Firefox` liefert `mode: "article"` den ersten
   Satz des Artikels („Mozilla Firefox …") und **keinen** der vier
   Chrome-Strings, die im Textmodus vorkommen und im Artikelmodus fehlen müssen:
   „Impressum", „Über Wikipedia", „Haftungsausschluss", „Cookie" (alle je 1× im
   Textmodus, 0× im Artikelmodus — gemessen). **„Datenschutz" ist auf dieser Seite
   kein Chrome, sondern Artikelinhalt** (17× im Text, 15× im Artikel): ein
   untauglicher Prüfstring, der aus dem Kriterium entfernt wurde. `root` nennt
   weiter den äußeren Selektor (`"main"`), auch wenn der Abstieg den Text aus
   einem inneren Block holt — der Name ist die Wurzel der Auswahl, nicht die
   Wohnung des Textes.
   **Die Größenzusage gilt auf einer chrome-lastigen Seite**: auf
   `https://www.heise.de/` ist `totalChars` im Artikelmodus **höchstens 80 %** des
   Textmodus (Messlauf: 52 %). Wikipedia selbst trägt kaum Chrome — dort ist die
   Größe kein Maßstab, die Strings sind es. Beide `totalChars`, `root`, der erste
   Satz, die vier Strings mit Trefferzahl und die Antwortzeiten stehen unter
   `## Messlauf`.
9. **Die Abnahme ist grün** (lokal). `npm test; echo $?` → `0` mit `# fail 0`
   **und** `# cancelled 0`; `npm run check; echo $?` → `0`;
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.

## Dev plan

Reihenfolge: Prüfung → Vertrag (Modus fährt mit) → Auswahl (drei Stufen, Fixture
zuerst) → Bereinigung → Fenster → MCP → Abschluss. Kriterien in Klammern.

1. **`mode` prüfen, bevor etwas injiziert wird** (7, Extension-Hälfte) —
   `extension/background.js`: neben `READ_OFFSET_DEFAULT` (~148)
   `READ_MODES = Object.freeze(["text", "article"])`, `READ_MODE_DEFAULT =
   "text"`; neben `READ_MAX_CHARS_MESSAGE` (~217) `READ_MODE_MESSAGE = \`mode muss
   "text" oder "article" sein.\``. In `readRequestParams` (1776) eine dritte
   Prüfung (`undefined` ⇒ Default, sonst `typeof mode === "string" &&
   READ_MODES.includes(mode)`, sonst `new ReadError(INVALID_PARAMS_CODE,
   READ_MODE_MESSAGE)`), Rückgabe `{offset, maxChars, mode}`; `readAgentTabPage`
   (1803) nimmt `mode` mit, reicht es aber **noch nicht** an den Schnipsel. Der
   Doc-Kommentar von `readRequestParams` („The two window parameters") wird zur
   Wahrheit. `readErrorFor`/`readErrorFrame` bleiben unangetastet.
   In `test/extension.test.js` ein Fall nach dem Muster von
   `read_withAnInvalidWindowParameter_shouldAnswerInvalidParamsAndInjectNothing`
   (4276), Bündel `[{mode: "Artikel"}, {mode: "ARTICLE"}, {mode: ""}, {mode: 1},
   {mode: "article", maxChars: 0}]` ⇒ `ok === false`,
   `error.code === "invalid_params"`, `assert.deepStrictEqual(tabs.scriptCalls,
   [])`.
   Proof: `node --test --test-timeout=60000 test/extension.test.js` grün; der
   neue Fall ist vor der Stufe `ok: true` (der Schnipsel ignoriert `mode` noch)
   und danach `invalid_params`; `npm test` unverändert grün.

2. **Der Modus fährt mit: gleicher Schnipsel, neue Antwortfelder** (1, plus die
   Strenge der Antwortprüfung) — `extension/background.js`:
   `readPageSource(offset, maxChars, mode, urlLimit, titleLimit)` (1961) —
   **fünf** Parameter in dieser Stufe; `minChars` kommt erst in Stufe 3 als
   vierter Parameter davor (sonst frisst es `URL_LIMIT`).
   Bei `mode !== "article"` bleibt der **Textpfad Zeile für Zeile** wie heute —
   geändert wird nur die Antwort (siehe unten). Die Antwort (2017)
   bekommt `mode` **hinter `via`** und, nur im Artikelmodus, `root: null,
   fellBack: true` — die Auswahl kommt erst in Stufe 3, bis dahin ist „keine
   Wurzel gefunden" die wahre Auskunft. `readPageCode(offset, maxChars, mode)`
   (2047) interpoliert `JSON.stringify(mode)`; `PAGE_STATE_CODE =
   readPageCode(0, TEXT_LIMIT, "text")` (2055), damit `click`/`type` Text
   bleiben. `pageResultOf` (2151) reicht `mode` durch und hängt `root`/`fellBack`
   nur an, wenn die Seite sie geliefert hat; `isUsablePageResult` (2200) verlangt
   `READ_MODES.includes(value.mode)` und im Textmodus **Abwesenheit** von
   `root`/`fellBack` (sonst `READ_FAILED_CODE` mit der bestehenden Warnzeile). Im
   Artikelmodus: `value.root === null || typeof value.root === "string"` **und**
   `typeof value.fellBack === "boolean"` — das Vokabular der `root`-Etiketten
   wird **nicht** geprüft, weil „density" und spätere Etiketten keine
   geschlossene Menge sind.
   **In dieser Stufe werden `docs/05-seiteninhalt-lesen.md` `:22`, `:79`,
   `:107-118` **und `:40-43`** mitgezogen** — dort entsteht die Antwortform, und
   dort steht der Satz „Kein Readability-Algorithmus … eine ‚nur der
   Artikel'-Extraktion ist eine eigene Entscheidung mit eigenen Fehlern", den
   dieses Inkrement umkehrt.
   `test/extension.test.js`: die fünf `deepStrictEqual(answer.result, …)` der
   `read`-Fälle (3918, 4044, 4096, 4132, 4169), der Feldordnungs-Pin (4361) und
   die zwei Pins auf die **Argumentliste des Schnipsels** (4583/4584, neuer Tail
   `0, 10, "text", ${URL_LIMIT}, ${TITLE_LIMIT})`)
   bekommen `mode: "text"` zwischen `via` und `settled`; die drei
   handgeschriebenen **gültigen** Seitenantworten (4534, 5404, 5457) bekommen
   `mode: "text"`; die `click`/`type`-Pins (5162, 5431) bleiben unverändert und
   sind der Beweis, dass sich deren Antwortform nicht bewegt. Neue Fälle: (a)
   `read_withModeTextAndWithoutMode_shouldAnswerTheSameResult` — zwei Aufrufe auf
   einer Socket, `assert.deepStrictEqual(text.result, bare.result)` und
   `Object.hasOwn(...)`-Prüfungen für `root`/`fellBack`; (b)
   `read_inTextMode_whenThePageSetsARoot_shouldAnswerReadFailed` mit
   `executeScript`, das eine sonst gültige Antwort plus `root: "article"`
   liefert ⇒ `read_failed` und die Warnzeile.
   Proof: `npm test` grün; `git diff test/extension.test.js` zeigt in den fünf
   Pins **nur** die `mode`-Zeile (der lokale Beleg für Kriterium 1) und in den
   `click`/`type`-Pins keine Zeile.

3. **Die Seiten-Fixture und Stufe 1 der Auswahl** (2, 4) — der teuerste Teil.
   *Fixture* (`test/extension.test.js`, neben den Inspect-Fixtures ~6940): Fabrik
   `createArticleElement({tagName, id, className, attributes, text, children})`
   mit `innerText` als Getter (eigener `text` + Kinder, `removed` übersprungen),
   `textContent` als Getter (Skripttext **enthalten**), `getAttribute`,
   `querySelectorAll(selector)` (Komma-Liste; je Teil `tag`, `#id`, `.class`,
   `[attr]`, `[attr="value"]`, `[attr*="value"]`, die letzten beiden mit optionalem
   ` i` — alles andere **wirft**),
   `cloneNode(true)` (tiefe Kopie mit frischen `removed`-Marken), `remove()`.
   Dazu `createArticlePage({children, url, title})` mit `article: true`,
   `documentElement`/`elements`. **Drei** Verdrahtungspunkte, nicht zwei:
   `pageContextOf` (~415) und `bodyOf` (~893) bekommen je einen
   `page.article === true`-Zweig, und **`querySelectorIn` (~786)** braucht den
   dritten — für Nicht-`dom`-Seiten liest es heute `page.elements?.[selector]`,
   auf einem Array kommt `undefined` heraus, und `articleRoot` bliebe `null`. In
   `pageContextOf` wird außerdem `querySelectorAll` für `page.article === true`
   freigegeben (heute nur für `dom`). `createBodyStub`/`createBodyCopy`/
   `createInspectBody` bleiben **unberührt**.
   *Produktion*: `extension/background.js` bekommt `const ARTICLE_MIN_CHARS = 500;`
   neben `READ_MAX_CHARS_LIMIT`; `readPageCode(offset, maxChars, mode, minChars)`
   interpoliert ab hier **vier** Argumente. In `readPageSource` eine verschachtelte
   `articleRoot(minChars)` direkt nach `withoutNonTextElements` (1976-1981), Liste
   `[["article","article"],["main","main"],["[role=\"main\"]","[role=\"main\"]"],
   ["#content","#content"],["#main","#main"]]`, je Paar
   `document.querySelector(selector)`, Kandidat zählt nur ab
   `normalise(element.innerText ?? "").length >= minChars`; Rückgabe `{element,
   label}` oder `null`. `ARTICLE_MIN_CHARS = 500` fährt als **sechstes Argument**
   in den Schnipsel. `readPageSource` setzt `const chosen = mode === "article" ?
   articleRoot(minChars) : null;` und nimmt bei `chosen !== null` `text`
   aus `chosen.element` statt aus `body`; `via` folgt derselben Regel wie im
   Textpfad.
   *Fälle*: `read_inArticleMode_withAnArticleElement_shouldAnswerTheArticleTextOnly`
   — Seite mit `<article>` (~700 Zeichen), `<nav>`/`<footer>` als Geschwister ⇒
   `root === "article"`, Text enthält den ersten Satz, keinen `nav`-/`footer`-Text;
   **im selben Fall** derselbe Aufruf mit `mode: "text"` ⇒ dort steht der
   `nav`-Text **drin** (Selbstprüfung der Fixture).
   `read_inArticleMode_withOnlyNavigation_shouldFallBackHonestly` — Seite mit 200
   Zeichen Navigation ⇒ `fellBack: true`, `root: null`, und
   `assert.deepStrictEqual(article.result.text, textMode.result.text)`.
   Proof: `node --test --test-timeout=60000 test/extension.test.js` grün; im
   Artikel-Fall liefert `root` vor der Stufe `null` und danach `"article"` (der
   Unterschied zwischen „nichts gefunden" und „nichts gesucht").

4. **Stufe 2: die Dichte-Heuristik** (3) — `extension/background.js`:
   verschachtelte `densityRoot(minChars)` neben `articleRoot`; Kandidaten
   `document.querySelectorAll("div, section")`, Bewertung aus Textmenge,
   `p`-Anzahl und Linkdichte (`a`-Textzeichen / Textzeichen), bester Kandidat ab
   `minChars`, Etikett `"density"`; Aufruf, wenn `articleRoot` `null` liefert.
   `test/extension.test.js`: `createArticlePage` ohne semantische Wurzel, mit
   **Köder** — ein `<div>` mit >500 Zeichen, zwanzig Links und null Absätzen neben
   dem dichten Block (viele `<p>`, ein Link) ⇒ `root: "density"`, Text ist der des
   dichten Blocks, der Köder fehlt.
   Proof: `read_inArticleMode_withoutASemanticRoot_shouldTakeTheDenseBlock` grün;
   keine Zusicherung auf die Formel (nur das Ergebnis ist Vertrag).

5. **Bereinigung auf einer Kopie** (5) — `extension/background.js`: verschachtelte
   `withoutChrome(root)` neben `withoutNonTextElements` (1976): `cloneNode(true)`,
   dann `copy.querySelectorAll(CHROME_SELECTOR)` und `remove()` je Treffer;
   `CHROME_SELECTOR` ist ein **Literal in der Funktion** (der Rumpf reist über
   `toString()`): `nav, header, footer, aside, form, script, style, noscript,
   iframe, [id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i],
   [id*="consent" i], [class*="consent" i], [aria-label*="consent" i]` — die
   Anführungszeichen sind Pflicht, weil die Fixture-Grammatik nur
   `[attr*="value"]` kennt. Artikeltext aus
   `copy.innerText`, bei leerem normalisiertem Ergebnis `copy.textContent` mit
   `via: "textContent"` — dieselbe Regel wie im Textpfad. Der **Rückfallpfad
   bleibt ungereinigt**: `fellBack: true` heißt „die ganze Seite, Chrome
   inklusive".
   `test/extension.test.js`: `<div class="Cookie-Consent" id="cookie-banner">`
   **innerhalb** des `<article>` mit sichtbarem Text ⇒ fehlt in der Antwort, und
   die Originalseite bleibt unverändert (die Kopie wird bereinigt). Ein zweiter
   Fall mit `class="consent-hinweis"` ⇒ die `consent`-Familie ist von der
   `cookie`-Familie getrennt.
   Proof: beide Fälle grün; vor der Stufe steht der Banner-Text in
   `answer.result.text`.

6. **Fenster auf dem gefilterten Text** (6) — Produktion: erwartet **keine**
   Änderung; der `slice` (2006-2015) läuft schon auf dem zusammengesetzten `text`.
   Die Stufe pinnt die Reihenfolge und repariert sie, falls der Artikelpfad früh
   zurückkehrt.
   `test/extension.test.js`, eine Socket, drei Aufrufe auf derselben
   Artikel-Fixture: `mode: "article"` ohne Fenster; dann `{offset: 10, maxChars:
   20}` ⇒ `assert.equal(result.text, full.result.text.slice(10, 30))` und
   `totalChars === full.result.text.length`; dann `{offset: full.totalChars + 1}`
   ⇒ `offset_out_of_range` mit der Zahl in der Meldung. Zusätzlich
   `assert.notEqual(article.totalChars, textMode.totalChars)` — die Länge gehört
   zum **gefilterten** Text.
   Proof: die drei Zusicherungen; `npm test` grün.

7. **MCP: Schema, Enum-Prüfung, Durchreichen** (7, Bridge-Hälfte) —
   `bridge/mcp.mjs`: `BROWSER_READ`-Schema (84-98) um `mode: {type: "string",
   enum: ["text", "article"]}` **zwischen `maxChars` und `tab`**; Beschreibung um
   „`mode: article` liest nur den Artikelkörper — ohne Navigation, Fußzeile und
   Cookie-Banner."; `READ_ARGUMENTS` (326) ⇒ `["offset", "maxChars", "mode",
   TAB_ARGUMENT]`; `UNEXPECTED_ARGUMENTS[BROWSER_READ]` (348) ⇒ „…erwartet nur
   `offset`, `maxChars`, `mode` und `tab`."; `hasDeclaredReadArgumentTypes`
   (1038) prüft für `mode` **nur den Typ** (`typeof args.mode !== "string"` ⇒
   `-32602`); den Enum-Wert prüft die Extension. **Die Doc-Kommentare von
   `readTool` (654-665) und im Test (1643-1652) werden präzisiert**: „Typen prüft
   die Bridge, Enum und Bereiche die Extension" — dann bleiben sie wahr.
   `docs/05-seiteninhalt-lesen.md` `:141-142`, `:148`, `:202-204` nachziehen.
   `test/mcp.test.js`: `READ_TOOL_DESCRIPTION` (93), `READ_UNEXPECTED_ARGUMENTS_TEXT`
   (129), Schema-`deepEqual` und `Object.keys` (940-958) nachziehen; neue Fälle
   über den `handleMessageText`-Seam (~1595): `{mode: "article"}` ⇒
   `requests[0].params` ist `{mode: "article"}`; `{offset: 0, maxChars: 100, mode:
   "article"}` ⇒ exakt diese drei Schlüssel in Schema-Reihenfolge;
   `[{mode: 1}, {mode: null}, {mode: ["article"]}]` ⇒ `answer.error.code ===
   -32602` und `requests === []` (der Enum-Wert `"Artikel"` steht schon als
   Extension-Fall in `test/extension.test.js`); `{"artikel": true}` ⇒ der
   Werkzeugsatz.
   Proof: `node --test --test-timeout=60000 test/mcp.test.js` grün; `git diff
   test/fixtures/fake-extension.mjs` ist **leer**.

8. **Abschluss** (9; 8 ist **nicht** Sache des Umsetzers) —
   `docs/23-artikel-extraktion.md`: `status: active`, Prosa beschreibend, der
   beantwortete `## Open questions`-Block bleibt als Feststellung stehen. Die vier
   Abnahmebefehle aus `CONTRIBUTING.md`, `## Abnahme`, plus `git diff --exit-code
   extension/manifest.json`. Kriterium 8 ist live und laut datierter Ausnahme
   **nach** dem Commit zu messen; die Zahlen trägt der Orchestrator in einen
   Abschnitt `## Messlauf` ein, den die Spec heute nur zitiert, aber nicht
   enthält. Registerspalte und `docs/PROJECT-STATE.md` pflegt der Orchestrator.
   Proof: `npm test; echo $?` → `0` mit `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; Secret-grep → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.

   **Completed 2026-10-27** (Abnahme, Register und Live-Messung beim Orchestrator)

### What could go wrong

- **`PAGE_STATE_CODE` hat zwei stille Leser.** `clickResult` (2535) und
  `typeResult` (2728) hängen an `readPageCode`; wird dort nicht `"text"`
  gesetzt, liefert der Schnipsel `mode: undefined`, `JSON.stringify` wirft den
  Schlüssel weg, `isUsablePageResult` schlägt zu und zwei aktive Specs (06/07)
  fallen mit `read_failed` um.
- **Drei handgeschriebene *gültige* Seitenantworten** (4534 für `read`, 5404 und
  5457 für `click`) brauchen `mode: "text"`, sonst werden sie `read_failed`. Die
  `about:`-Zweige in `clickResult`/`typeResult` (2540, 2733) setzen `mode`
  **nicht** — sie bauen ein eigenes Objekt und dürfen es bleiben lassen.
- **Die Fixture ist der teuerste Teil, und sie ist an drei Stellen Behauptung,
  nicht Beweis.** (a) Der Selektor-Matcher der Fixture wird neben dem Schnipsel
  geschrieben: „der Banner ist weg" beweist, dass die Produktionsliste eine
  Familie nennt, die der Stub versteht — nicht, dass Firefox
  `[class*="cookie" i]` so annimmt. Deshalb der Fall mit `Cookie-Consent` in
  Großschreibung und ein Stub, der ` i` **nur bei gesetztem Flag**
  case-insensitiv matcht. (b) Die Dichte-Formel ist nicht beweisbar; bewiesen
  wird nur, dass der Köder nicht gewinnt. (c) `innerText` auf einem echten
  Dokument hängt an CSS; der Stub aggregiert nur. Ob ein echter Wikipedia-Artikel
  sauberer wird, entscheidet allein Kriterium 8.
- **Größenordnung der Fixture**, ehrlich: eine Element-Fabrik mit aggregiertem
  `innerText`/`textContent`, `cloneNode`, `remove` und einem Selektor-Teil-Leser
  plus Realm-Verdrahtung in `pageContextOf`/`bodyOf` und zwei Fixture-Seiten —
  grob 150–200 Zeilen Testcode, mehr als die Produktion dieser Stufe.
- **`ARTICLE_MIN_CHARS` muss als Argument fahren.** Der Schnipsel sieht keinen
  Modulscope; die 500 als Literal in den Code zu schreiben hieße, die Zahl zweimal
  zu pflegen. Deshalb ist sie das sechste Argument — und `readPageCode` muss sie
  ab Stufe 3 mit interpolieren, sonst kennt der Schnipsel sie nicht.
- **Die `root`-Etiketten sind Vertrag.** Sie sind der getroffene Selektor
  (`article`, `main`, `[role="main"]`, `#content`, `#main`), `density` oder
  `null` — eine andere Schreibweise im Code als in der Spec ist ein
  Vertragsbruch, den der Stub nicht bemerkt.
- **`via` folgt im Artikelmodus der Textpfad-Regel, auf der bereinigten Kopie.**
  Immer `innerText` würde bei einer SPA-Seite einen leeren Artikel als Erfolg
  melden; deshalb der `textContent`-Rückfall — und deshalb die eigene Testing-Zeile.
- **Der Rückfall darf nicht bereinigt werden.** Wer `withoutChrome` auch auf den
  `fellBack`-Pfad legt, bricht Kriterium 4 — der Rückfall-Fall der Fixture besteht
  aus Navigation, und `nav` steht in der Liste; der Text würde auf `""` geleert
  und der Vergleich mit dem Textmodus rot.
- **Der Enum-Check gehört nicht in die Bridge.** „The ranges are not checked here
  on purpose … a copy in the bridge would be a second opinion" (654-665) gilt für
  `mode` genauso wie für `maxChars`: die Bridge prüft den Typ, die Extension den
  Wert. Wer `READ_MODES` in die Bridge kopiert, hat zwei Listen und zwei
  Fehlercodes für denselben Tippfehler.
- **Die Fixture der Bridge bleibt gesperrt.** `test/fixtures/fake-extension.mjs`
  steht in der Touch-Boundary. `test/mcp.test.js` kann deshalb nur beweisen, dass
  `mode` *hingeht* und die Antwort unverändert durchläuft — nicht, dass
  `root`/`fellBack` beim Client ankommen. Das gehört in den Testkommentar.

### Ordering and dependencies

- Stufe 1 → 2: ohne geprüftes `mode` darf kein Schnipsel es sehen; Stufe 1 ist die
  einzige, die ohne Injektion grün wird.
- Stufe 2 → 3–6: die Antwortfelder und die strenge `isUsablePageResult` müssen
  stehen, bevor ein Artikel-Fall `root`/`fellBack` behaupten kann.
- Stufe 3 trägt die Fixture und die Realm-Verdrahtung; 4, 5 und 6 hängen daran.
- Stufe 4 setzt 3 voraus, Stufe 5 setzt 3 voraus, Stufe 6 setzt 3 voraus (und
  erwartet 4/5 durch, weil sie die Textlänge bestimmen).
- Stufe 7 hängt nur an 1 und 2 und ist die einzige Stufe ohne Fixture; parallel zu
  3–6 nur in einem getrennten Arbeitsbaum.
- Stufe 8 ist letzte; Kriterium 8 bleibt offen bis nach dem Commit.

### What the next increment inherits

- **`mode` für `click`, `type`, `inspect`** — ausdrücklich draußen;
  `PAGE_STATE_CODE` ist die eine Stelle, an der es anfinge.
- **Kriterium 8 und `## Messlauf`:** die Live-Zahlen (zwei `totalChars`, erster
  Satz, keine Chrome-Strings) und die Antwortzeit auf einem großen Artikel.
- **Eine bessere Heuristik:** Kandidaten-Deckel für sehr große Seiten,
  Zusammenfassen von Geschwisterblöcken, `[itemprop="articleBody"]`,
  `article:not(…)` — je eine eigene Spec.
- **Banner-Erkennung bleibt eine Sperrliste.** Ein Banner ohne
  `cookie`/`consent` im Attribut bleibt stehen — bewusst (`## Risiken`).
- **`ARTICLE_MIN_CHARS = 500` ist eine Konstante, kein Parameter.** Ob sie auf
  den Draht gehört, ist offen; ebenso das `root`-Etikett-Vokabular als geprüfte
  Menge.
- **Die Fixture `createArticlePage` ist wiederverwendbar**; der nächste
  Artikel-nahe Fall baut darauf auf.


## Risiken

- **Eine Heuristik irrt.** Auf einer Seite ohne semantische Struktur kann sie
  den falschen Block nehmen. Deshalb `root` und `fellBack` in der Antwort: der
  Agent kann den Ausschnitt prüfen, statt ihm zu glauben.
- **`innerText` auf einer abgehängten Kopie ist `textContent`.** Ein Klon hängt
  nicht im Dokument, und laut HTML-Standard liefert `innerText` dort `textContent`
  — CSS-versteckter Text kann also im Artikel landen. Eine Alternative gäbe es nur
  durch Einhängen in die Seite, und das wäre ein Schreibzugriff auf das Dokument
  des Betreibers; Kriterium 8 misst, ob es in der Praxis stört.
- **`innerText` im Artikelmodus kostet mehr.** Auf einer Kopie bereinigen heißt:
  ein DOM-Klon plus `innerText` darauf. Bei sehr großen Seiten ist das der
  teuerste Teil — gemessen wird es in Kriterium 8.
- **Banner-Muster sind eine Sperrliste, keine Whitelist.** Ein Banner ohne
  `cookie`/`consent` im Attribut bleibt stehen. Das ist bewusst: eine
  Textheuristik über „was sieht wie Zustimmung aus" wäre geraten.
- **Verschachtelte Links im Artikel bleiben drin** (Fußnoten, Querverweise) —
  sie gehören zum Text; `innerText` liefert sie mit.
- **Der Textmodus bleibt der Rückfall**, nicht der Artikelmodus. Wer Vertrauen
  braucht, nimmt `mode: "text"`.

## Touch boundary

Angefasst: `extension/background.js`, `bridge/mcp.mjs`, `test/extension.test.js`,
`test/mcp.test.js`, `docs/05-seiteninhalt-lesen.md` (Antwortfelder, der
umgekehrte „kein Readability"-Satz, Schema, Testzeile), `docs/23-artikel-extraktion.md` selbst (**Stufe 8** stellt sie auf `active`), `docs/README.md`, `docs/PROJECT-STATE.md`, `docs/ROADMAP.md`.

**Nicht** angefasst: `extension/manifest.json`, `bridge/{protocol,websocket,
http-transport,hub}.mjs`, `extension/{protocol,options.html,options.js}`,
`test/fixtures/fake-extension.mjs`, `CONTRIBUTING.md`, `INSTALL.md`, andere Specs.

## Bekannte Lücken

Stand 2026-10-27, nach den Stufen 1–8 und der Code-Review-Runde:

- **Kriterium 8 steht aus** (2026-10-27): die Live-Messung an einem echten Artikel
  braucht den Reload der Erweiterung und einen Neustart des Dienstes.
- **`pageResultOf` vergleicht den Modus nicht** (2026-10-27, Code-Review R3): eine
  Seitenantwort mit `mode: "article"` auf eine Text-Anfrage (oder umgekehrt) gleitet
  durch die Antwortprüfung. Ein `first.mode !== mode` würde es schließen; es steht
  hier statt im Code, weil die Spec es nicht verlangt und der Fall heute nicht
  erreichbar ist.
- **`root` nennt den äußeren Selektor, auch nach dem Abstieg** (2026-10-27): auf
  Wikipedia steht `root: "main"`, obwohl der Text aus `#mw-content-text` kommt.
  Ein Feld `descended: true` wäre die ehrlichere Auskunft — ein eigener
  Vertragszusatz, nicht in diesem Inkrement.
- **Der Schnipsel trägt die Artikel-Maschinerie in `click`/`type`** (2026-10-27,
  Code-Review R4): `PAGE_STATE_CODE` benutzt denselben Code, gewachsen von 4,3 auf
  10,7 kB (+6,4 kB). Kosten pro Injektion, keine Zeit; ein schlankerer Pfad wäre
  eine zweite Kopie von `readPageSource`.
- **Die Dichte-Stufe wird von Kriterium 8 nie gemessen** (2026-10-27, Code-Review
  R5): Wikipedia landet in Stufe 1. Die Bewertung liest `innerText` je Kandidat und
  je Link — auf sehr großen Seiten teuer. Ein Kandidaten-Deckel oder ein einmaliger
  Durchgang mit gemerkten Textlängen ist ein eigenes Inkrement.

## Open questions

Keine offenen. Beantwortet vom Betreiber am 2026-10-27:

1. **Eigene Heuristik**, kein Vendoring von Readability.js — keine fremde Quelle
   und keine neue Abhängigkeit im Repo.
2. **`mode` an `browser_read`**, kein eigenes Werkzeug: die Werkzeugliste bleibt
   bei elf, und `offset`/`maxChars` gelten auf demselben Text.
3. **Rückfall mit Markierung**: ganze Seite, `root: null`, `fellBack: true` —
   kein `article_not_found`.

## Messlauf

**Erste Messung (2026-10-27): Kriterium 8 rot — Kernannahme widerlegt.** Nach
Reload der Erweiterung und Neustart des Dienstes:

| Seite | Textmodus | Artikelmodus | `root` | Chrome-Reste |
|---|---|---|---|---|
| `de.wikipedia.org/wiki/Firefox` | 77 104 | **78 794 (102 %)** | `main` | „Datenschutz" **15×** |
| `www.heise.de` | 31 893 | 16 657 (**52 %**) | `density` | keine |
| `www.spiegel.de` | 34 001 | 27 191 (**80 %**) | `main` | keine |

Zwei Ursachen: Wikipedia hat kein `<article>`, also greift `main` — und darin
sitzen Footer-Elemente, die die Bereinigung nicht kannte (`footer` schon,
`div[class*="footer"]`/`[role="contentinfo"]` nicht). Und Wikipedia trägt ohnehin
fast nur Artikeltext; „20 % kleiner" war dort von Anfang an unerreichbar. Nach
`CONTRIBUTING.md` ist die **Kernannahme** widerlegt ⇒ zurück in die Spec, mit den drei
Änderungen aus `## Log`. **Zweite Messung (2026-10-27, nach der Nachbesserung):** die Bereinigung wirkt,
die Größenzusage bleibt auf Wikipedia unerreichbar.

| Probe | Textmodus | Artikelmodus |
|---|---|---|
| `de.wikipedia.org/wiki/Firefox` Länge | 78 958 | 78 295 (99 %) |
| „Impressum" | 1 | **0** |
| „Über Wikipedia" | 1 | **0** |
| „Haftungsausschluss" | 1 | **0** |
| „Cookie" | 1 | **0** |
| „Datenschutz" | 17 | 15 — **Artikelinhalt**, kein Chrome |
| `root` | — | `"main"` (der Abstieg holt den Text aus `#mw-content-text`, 75 375 von 75 517) |
| erster Satz „Mozilla Firefox" | enthalten | enthalten |
| `www.heise.de` | 31 268 | **16 415 (52 %)** — Kriterium erfüllt, keine Cookie-Reste |

Damit ist Kriterium 8 erfüllt: die Strings verschwinden, `root` ist die Wurzel der
Auswahl, und die Größe hält auf der chrome-lastigen Seite. Der 20-%-Wert auf
Wikipedia war ein Kriterienfehler, kein Implementierungsfehler — die Seite trägt
kaum Chrome, und „Datenschutz" ist dort ein Thema des Artikels.

## Review

### Runde 1, 2026-10-27 — `🔧 Fix these` (Blocker dabei)

Geprüft gegen `spec-doc-review`, `docs/README.md` und `CONTRIBUTING.md`; die
Behauptungen des Dev-Plans wurden am Code gegengeprüft und halten fast alle: zwei
stille `PAGE_STATE_CODE`-Leser (`clickResult` 2535, `typeResult` 2728) und ihre
`about:`-Zweige (2540/2733), `readPageSource` 1961 mit heute vier Parametern,
exakt fünf `deepStrictEqual` der `read`-Fälle (3918/4044/4096/4132/4169) plus
Feldordnungs-Pin 4361, drei handgeschriebene gültige Seitenantworten
(4534/5404/5457), unveränderte `click`/`type`-Pins,
`hasDeclaredReadArgumentTypes` 1038, die Doc-Kommentare `mcp.mjs:654-666` und
`mcp.test.js:1645-1650`; die Fixture ist wirklich neu (`createInspectElement` hat
statisches `innerText`, kein `cloneNode`/`remove`, der Matcher kennt kein `*=`
und kein ` i`). Nur die MCP-Schema-Zeilen driften um ~5.

Blockierend: Kriterium 1 („dieselbe Antwort wie vor dem Inkrement") war durch den
eigenen Wire-Abschnitt widerlegt, der `mode` in **jede** Antwort legt (B1);
`## Amendments to previous spec docs` fehlte, obwohl die Spec `docs/05:40-43`
umkehrt und Antwortform, Schema und Testing-Tabelle ändert (B2); der Enum-Check
stand an zwei Stellen gegenläufig (B3); `## Messlauf` wurde zitiert, existierte
nicht (B4); `via` im Artikelmodus lebte nur im Plan (B5); die `root`-Etiketten
ließen `[role="main"]`/`#main` aus (B6); die genannte Fünf-Parameter-Signatur
konnte `ARTICLE_MIN_CHARS` nicht tragen (B7); die datierte Ausnahme schrieb für
die widerlegte Kernannahme „vorwärts korrigieren" statt Rückkehr in die Spec
(B8); die Fixture-Verdrahtung nannte `querySelectorIn` nicht und gab
`querySelectorAll` für den Artikel-Realm nicht frei (B9); die Touch boundary
nannte Stufe 5 statt 8 (B10).

Minors: Kriterium 8 pinnte weder Satz noch Größenordnung und prüfte live keinen
Banner (M1); die Testing-Zeile zu `<article>` versprach die Bereinigung und
bewies nur die Auswahl (M2); Produktion und Fixture schrieben denselben Selektor
verschieden (M3); „Rumpf byte-gleich" widersprach der eigenen Antwortänderung
(M4); die Behauptung „kein Kriterium merkt eine bereinigte Rückfall-Seite" war
falsch (M5); die leere Wurzel nach der Bereinigung war undefiniert (M6); der
Debug-Block des Hubs trägt die neuen Felder (M7); die Registry-Zeile für 23 fehlt
(M8); die Beispielzahlen im Ziel-JSON sahen gemessen aus (M9).

### Runde 2, 2026-10-27 — `🔧 Fix these` (Blocker dabei)

Runde 1 hat gehalten: B1, B2, B4, B5, B7, B8, B9, B10 und M1, M3–M9 sind
eingearbeitet, die Belege am Code stimmen (fünf `read`-Pins 3918/4044/4096/4132/
4169, Feldordnungs-Pin 4361, drei handgeschriebene Seitenantworten 4534/5404/5457,
`hasDeclaredReadArgumentTypes` 1038, `READ_ARGUMENTS` 326, `pageContextOf` 411,
`querySelectorIn` 786, `bodyOf` 896, alle sieben `docs/05`-Stellen), und
`clickResult`/`typeResult` bauen ihre Antwort aus Einzelfeldern — die
`click`/`type`-Pins bleiben unberührt. Die Stufen 1–8 sind in der geschriebenen
Reihenfolge baubar.

Zwei Blocker waren nur zur Hälfte erledigt und standen im Dev-Plan gegen die
Kriterien: der Enum-Check lag in Stufe 7 und im Trap-Absatz wieder in der Bridge
und machte Kriterium 7 unerfüllbar (C1); das `root`-Etikett hatte zwei
Schreibweisen, und die Fixture-Grammatik kannte keine davon, sodass Stufe 3 und 4
im dritten Selektor geworfen hätten (C2). Dazu ein Satz aus `docs/05`
(`:40-43`), den die Spec umkehrt und den keine Stufe einsammelte (C3). Klein: zwei
überholte Trap-Bullets (C4), die Testing-Zeile zu `<article>` behauptete die
Bereinigung (C5), und `readPageCode` musste `minChars` mitgeben (C6).

### Runde 3, 2026-10-27 — `✅ Ship it` (kein Blocker)

Die sechs Befunde aus Runde 2 halten. C1: Stufe 7 prüft nur `typeof args.mode ===
"string"`, `{mode: "Artikel"}` lebt nur noch im Extension-Fall, und §MCP-Werkzeug,
Kriterium 7, die Testing-Zeile und die Amendments-Tabelle sagen dieselbe Teilung
(Typ ⇒ `-32602` in der Bridge, Enum und Bereiche in der Extension). C2:
`[role="main"]` steht überall gleich, die Fixture-Grammatik kennt `[attr]`,
`[attr="value"]` und `[attr*="value"]` mit optionalem ` i` — Stufe 3 und 4 sind
baubar. C3: Stufe 2 zieht `docs/05:40-44` mit. C4/C5: die Testing-Zeile zu
`<article>` behauptet die Bereinigung nicht mehr, die Trap-Bullets beschreiben die
beschlossene Fassung. C6: `ARTICLE_MIN_CHARS = 500` und die vier Argumente von
`readPageCode` stehen in Stufe 3.

Kein Blocker geblieben, das Gate ist offen. Acht Zeilen ohne Entscheidungswert
(D1–D8, siehe `## Log`): zwei Ein-Wort-Korrekturen an Stufe 2 (Fünf-Parameter-
Signatur, fehlende Argument-Pins), ein Name (`articleRoot(minChars)`), eine
präzisierte SPA-Testing-Zeile, eine überholte Trap-Überschrift, ein Risiko-Satz zu
`innerText` auf der abgehängten Kopie, zwei Zeilenbereiche und eine
stehengebliebene Log-Zeile.

### Code-Review 1, 2026-10-27 — `🔧 Fix these` (Blocker dabei)

Geprüft wurde `git diff a582c94` gegen diese Spec und die Touch boundary: fünf
Dateien, keine untracked Datei, `extension/manifest.json` und
`test/fixtures/fake-extension.mjs` unberührt; Abnahme selbst gefahren (`npm test`
557/0/0, `npm run check` 0, Secret-Grep Exit 1, `manifest`-Diff 0). Vertragstreu
und belegt: `mode: "text"` ist Zeile für Zeile der alte Pfad (die
`textOf`-Refaktorierung ändert nichts, auch nicht bei leerem `innerText` und
fehlendem Body), die fünf `read`-Pins tragen genau die eine neue Zeile
(Kriterium 1), die fünf `root`-Etiketten stimmen, `articleRoot` nimmt den ersten
Treffer ab `ARTICLE_MIN_CHARS`, `isUsablePageResult` ist im Textmodus streng und
im Artikelmodus pflichtbewusst, die Bereinigung läuft nachweislich auf einer
Kopie, der Rückfall ist ungereinigt, das Fenster schneidet auf dem gefilterten
Text, und die Enum-Teilung hält.

Blockierend: eine Pflichtzeile aus `## Testing` hatte keinen Test (SPA-Fall, R1;
die Fixture konnte den Zustand nicht ausdrücken), und **Stufe 2 der Auswahl nahm
den äußersten Wrapper statt des dichten Blocks** — vom Reviewer mit dem echten
Schnipsel gemessen: `body > div.seite > [div.menue, div.bericht]` ergab
`root: "density"` mit der Länge des Wrappers und Navigationslinks im Text (R2).
Beides behoben; R2 mit Rot-vor-grün-Beleg.

Ohne Entscheidungswert, als Zeilen behandelt (R3–R9): `pageResultOf` vergleicht
den Modus nicht; der Schnipsel wächst um 6,4 kB und reist auch durch
`click`/`type`; die Dichte-Stufe wird von Kriterium 8 nie gemessen; `withoutChrome`
nannte sich „Stage three"; `articleRoot` schrieb die Längenmessung doppelt;
`ownTextContentOf` ist im echten Browser nicht erreichbar; `docs/05:22` listete die
Antwortfelder ohne `offset`/`chars`/`totalChars`.

### Runde 4, 2026-10-27 — Spec nach roter Live-Messung geändert (zurück auf `proposed`)

Die Live-Messung zu Kriterium 8 hat die **Kernannahme** widerlegt (Messlauf:
Wikipedia 102 % und „Datenschutz" 15×, `root: main`). Nach `CONTRIBUTING.md` geht das
Inkrement damit zurück in die Spec, nicht in `## Bekannte Lücken`. Drei Änderungen,
alle aus der Messung begründet:

1. **Stufe 1 steigt ab** wie Stufe 2 (`INNER_BLOCK_RATIO = 0.8`): `main` wird auf
   `#mw-content-text` verkleinert, statt den Fuß mitzunehmen.
2. **Die Bereinigung kennt die Footer-Familie** (`[role="contentinfo" i]`,
   `[class*="footer" i]`, `[id*="footer" i]`), weil Seiten ihren Fuß als `div`
   bauen.
3. **Kriterium 8 ist geteilt**: Chrome-Strings und `root` auf Wikipedia, die
   20-%-Größe auf einer chrome-lastigen Seite (heise: 52 %).

Der Abschnitt `## Amendments to previous spec docs` wird für die geänderte Fassung
wieder aufgenommen (er war beim ersten Abschluss entfernt worden); die
Amendments-Tabelle selbst ändert sich nicht.

## Log

Runde 1 des Spec-Reviews — alle 19 Befunde übernommen:

- **B1** (Kriterium 1 widersprach dem Wire-Abschnitt) — Kriterium 1 sagt jetzt
  „unverändert **bis auf** das Feld `mode`", das Non-goal entsprechend; Beleg ist
  der Diff der fünf Objektvergleiche (genau eine Zeile je Fall).
- **B2** (keine Amendments) — `## Amendments to previous spec docs` nennt
  `docs/05` mit sieben Stellenbereichen und der neuen Bedeutung.
- **B3** (Enum-Prüfung an zwei Stellen gegenläufig) — **entschieden**: die
  Teilung bleibt wie bei `maxChars` — Typ in der Bridge (`-32602`), Enum in der
  Extension (`invalid_params`); eine zweite `READ_MODES`-Liste in der Bridge wäre
  die „zweite Meinung", die `bridge/mcp.mjs:654-666` ablehnt. Kriterium 7 und die
  Testing-Zeilen nennen jetzt je Eingabe die antwortende Seite.
- **B4** (`## Messlauf` fehlte) — Abschnitt angelegt, mit den Feldern, die
  einzutragen sind.
- **B5** (`via` nur im Plan) — Satz in `## Extension` (dieselbe `via`-Regel wie im
  Textpfad, auf der bereinigten Kopie) und zwei Testing-Zeilen.
- **B6** (`root`-Etiketten unvollständig) — Etikett = der getroffene Selektor, alle
  fünf genannt, Schreibweise `[role="main"]`.
- **B7** (Fünf-Parameter-Signatur) — sechs Parameter, `minChars` fährt mit.
- **B8** (datierte Ausnahme widersprach `CONTRIBUTING.md`) — geteilt: Messung daneben ⇒
  vorwärts korrigieren; Kernannahme widerlegt ⇒ zurück in die Spec.
- **B9** (Fixture-Verdrahtung unvollständig) — `querySelectorIn` (~786) als dritter
  Punkt, `querySelectorAll` für `page.article === true` freigegeben.
- **B10** (Stufe 5 statt 8) — korrigiert.
- **M1–M9** — übernommen: Kriterium 8 nennt URL, ersten Satz, „mindestens 20 %
  kleiner" und eine Banner-Probe; Testing-Zeilen für `<nav>`/`<aside>`/`<form>`
  **in** der Wurzel, leere Wurzel und `textContent`-Fallback; ein Selektor-Zitat;
  „Zeile für Zeile" statt „byte-gleich"; die falsche Rückfall-Behauptung ersetzt;
  die leere Wurzel definiert (`fellBack: true`); der Hub-Absatz nennt den
  Debug-Block; die Registry-Zeile gehört zu Stufe 8; die Beispielzahlen sind als
  erfunden markiert.

Runde 2 des Spec-Reviews — alle sechs Befunde übernommen:

- **C1** (der Enum-Check stand in Stufe 7 wieder in der Bridge) — übernommen:
  Stufe 7 prüft nur `typeof args.mode === "string"`; `{mode: "Artikel"}` ist aus
  der mcp-Testliste entfernt (der Fall lebt in `test/extension.test.js`), die
  Doc-Kommentare sagen „Typen in der Bridge, Enum und Bereiche in der Extension".
- **C2** (zwei Schreibweisen des `[role="main"]`-Selektors, und die
  Fixture-Grammatik kannte keine davon) — übernommen: eine Schreibweise überall,
  `[attr="value"]` in die Grammatikliste; sonst hätten Stufe 3 und 4 im dritten
  Selektor geworfen.
- **C3** (`docs/05:40-43`, der umgekehrte „kein Readability"-Satz, hatte keine
  Stufe) — übernommen: Stufe 2 zieht die Stelle mit, die Touch-Boundary nennt sie.
- **C4** (zwei Trap-Bullets beschrieben Fehler, die es nicht mehr gab) —
  übernommen: beide an die beschlossene Fassung angepasst.
- **C5** (die Testing-Zeile zu `<article>` behauptete die Bereinigung) —
  übernommen, Behauptung gestrichen.
- **C6** (`readPageCode` musste `minChars` mitgeben, `ARTICLE_MIN_CHARS` war in
  keiner Stufe deklariert) — übernommen: `ARTICLE_MIN_CHARS = 500` und vier
  Argumente in Stufe 3.

Runde 3 des Spec-Reviews — Gate mit `✅ Ship it` geöffnet; die acht Notizen als
Zeilen übernommen (D1–D8):

- **D1/D2** (Stufe 2 deklarierte sechs Parameter, schob aber fünf Werte in den
  Schnipsel; die zwei Argument-Pins des Schnipsels fehlten in der Liste) —
  übernommen: Stufe 2 behält fünf Parameter, `minChars` kommt in Stufe 3 als
  vierter davor; 4583/4584 stehen mit neuem Tail in der Pin-Liste.
- **D3** (die SPA-Testing-Zeile beschrieb einen Zustand, den die Auswahl nicht
  erzeugen kann) — übernommen: eine `innerText`-lose Seite landet im Rückfall.
- **D4** (`articleRoot(articleMinChars)` statt `minChars`) — übernommen.
- **D5** (Trap-Überschrift behauptete einen offenen Punkt) — übernommen.
- **D6** (`innerText` liefert auf einer abgehängten Kopie `textContent`) —
  übernommen als Risiko-Satz: CSS-versteckter Text kann im Artikel landen, eine
  Alternative wäre ein Schreibzugriff auf die Seite; Kriterium 8 misst es.
- **D7** (zwei Zeilenbereiche der Amendments) — übernommen (`:40-44`, `:202-204`).
- **D8** („Noch keine Befunde." stand über zwei Runden Befunden) — gestrichen.

Code-Review Runde 1 — `🔧 Fix these`, zwei Blocker und sieben Zeilen:

- **R1** (Pflichtzeile aus `## Testing` ohne Test: SPA-Fall) — übernommen:
  `createArticlePage({withoutVisibleText: true})` leert das `innerText` des BODY,
  die `<p>`-Kinder behalten ihren Text; der Fall prüft `root: null`,
  `fellBack: true`, `via: "textContent"` und den Absatz.
- **R2** (Stufe 2 nahm den Wrapper, nicht den dichten Block) — übernommen:
  `densityRoot` nimmt den besten Score nur als Einstieg und steigt dann auf einen
  Nachfahren ab, solange er ≥ 80 % des Scores hält (`DENSITY_INNER_RATIO`); neuer
  Fall mit Wrapper, **rot vor der Korrektur** (der Menü-Text kam zuerst), danach
  grün.
- **R3** (`pageResultOf` vergleicht den Modus nicht) — **nicht** umgesetzt, als
  Zeile unter `## Bekannte Lücken` (die Spec verlangt es nicht, der Fall ist heute
  nicht erreichbar).
- **R4** (der Schnipsel trägt 6,4 kB Artikel-Maschinerie durch `click`/`type`) —
  der Kommentar an `readPageCode` sagt das jetzt ausdrücklich, die Kosten stehen
  unter `## Bekannte Lücken`.
- **R5** (die Dichte-Stufe wird von Kriterium 8 nie gemessen) — als Zeile unter
  `## Bekannte Lücken`.
- **R6** („Stage three" für die Bereinigung) — Kommentar korrigiert.
- **R7** (doppelte Längenmessung) — als Notiz; die Bewertung ist kein Vertrag, der
  Code bleibt.
- **R8** (`ownTextContentOf` als SPA-Rettung) — der Kommentar beschreibt jetzt, was
  die Funktion tut (die Kopie ist schon skriptbefreit).
- **R9** (`docs/05:22` ohne `offset`/`chars`/`totalChars`) — übernommen.

Runde 4 (nach der roten Live-Messung) — die Spec ist geändert, das Inkrement
beginnt bei Stufe 1 erneut:

- **Kernannahme widerlegt** (2026-10-27, Live-Messung): `mode: "article"` lieferte
  auf Wikipedia 78 794 statt ≤ 61 683 Zeichen und „Datenschutz" 15×. Ursachen:
  `main` als Wurzel (kein `<article>` auf der Seite) und eine Footer-Familie, die
  die Bereinigung nicht kannte.
- **Änderung 1**: Stufe 1 steigt ab (innerer Block ab 80 % des Textes) — der
  Fehler war nicht die Auswahl der Wurzel, sondern das Aufhören nach ihr.
- **Änderung 2**: `[role="contentinfo" i]`, `[class*="footer" i]`,
  `[id*="footer" i]` in `CHROME_SELECTOR`.
- **Änderung 3**: Kriterium 8 geteilt — Wikipedia über Strings und `root`, die
  Größe über eine chrome-lastige Seite (heise 52 %, spiegel 80 %).

Zweite Messung (2026-10-27) — Kriterium 8 **erfüllt**, mit einer Korrektur am
Kriterium selbst:

- **Bereinigung wirkt** (Wikipedia): „Impressum", „Über Wikipedia",
  „Haftungsausschluss" und „Cookie" je 1× im Textmodus, **0×** im Artikelmodus.
- **Der Abstieg greift**: `main` 75 517 → innerer Block 75 375, `root` bleibt
  `"main"` (Vokabular unverändert).
- **Größe nur auf chrome-lastiger Seite sinnvoll** (heise: 52 %, Kriterium erfüllt);
  Wikipedia bleibt bei 99 %, weil die Seite fast nur Artikeltext trägt.
- **„Datenschutz" war ein untauglicher Prüfstring** (17× im Text, 15× im Artikel —
  Artikelinhalt). Ersetzt durch die vier gemessenen Proben.
