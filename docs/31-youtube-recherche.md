---
description: Recherche-Spec für Roadmap-Zeile 17 — was der Agent von einem YouTube-Video heute schon bekommt (Transkript, Zeitbezug, Bild), welche Wege tragen und welche nicht, und welche Entscheidungen dem Betreiber bleiben.
status: active
---

# YouTube-Recherche: Transkript, Zeitbezug, Bild

Roadmap-Zeile 17 („YouTube-Videos schauen/lernen") ist als **Ziel ohne nächsten
Schritt** notiert. Diese Spec macht daraus einen **entschiedenen Zuschnitt**: sie
misst, was die vorhandenen Werkzeuge heute auf einer YouTube-Watch-Seite
herausbekommen, benennt die Wege, die nicht tragen, und legt die Fragen dem
Betreiber vor, aus denen die Folge-Spec (Werkzeug? Dokumentation? Umfang?)
herausfällt.

**Diese Spec erzeugt keinen Produktcode.** Ihr Ertrag ist die Messung und die
Entscheidung. Sie ist damit eine **Recherche-Spec**: ihre Abnahmekriterien
prüfen ein Dokument, nicht ein Verhalten.

Die Messungen sind am 2026-11-11 **live** im Firefox-Profil des Betreibers
gefahren (YouTube Premium, deutsche Oberfläche, angemeldet), nicht aus dem
Gedächtnis. Jede Zahl in diesem Dokument ist an dem Tag beobachtet worden.

## Ziel

- **Der Zuschnitt ist entschieden, nicht gesammelt.** Am Ende steht, ob das
  YouTube-Thema ein **neues Werkzeug** braucht, ein **Rezept in der
  Werkzeugbeschreibung** genügt, oder gar nicht gebaut wird.
- **Die Messung ist nachprüfbar.** Jede Zahl in diesem Dokument ist mit
  Video-ID, Werkzeugaufruf und Beobachtung belegt — als Beleg, nicht als
  Bericht.
- **Die offenen Fragen sind der Betreiberfrage zugespitzt.** Nicht „was wollen
  wir?", sondern „hier sind drei Wege gemessen, dieser trägt, dieser nicht,
  diese Frage bleibt".
- **Kein Rezept, das nur auf Deutsch funktioniert.** Jeder Selektor, der in
  dieser Spec steht, wird darauf geprüft, ob er an der Oberflächensprache hängt.

**Entschieden am 2026-11-11** (der Betreiber hat jede der fünf Fragen mit der
vorgeschlagenen Antwort beantwortet; die Begründungen stehen in
`## Open questions`):

| Frage | Entscheidung |
|---|---|
| Q1 — Zuschnitt | **Neues Werkzeug `browser_transcript`** |
| Q2 — Sprache | **Originalsprache des Videos** |
| Q3 — Umfang | **Text + Zeitbezug** (Kapitel und Bild sind **nicht entschieden** — nicht ausgeschlossen, nicht zugesagt) |
| Q4 — Oberflächensprache | **sprachunabhängig** (Strukturanker, nicht das `aria-label`) |
| Q5 — Zusammenfassung | **das Modell des Agenten** — im Projekt kommt kein Code dazu |

Die Folge daraus steht in `## Die Folge-Spec`.

## Non-goals

- **Kein neues Werkzeug in dieser Spec.** Der Zuschnitt wird hier entschieden,
  nicht gebaut; das Bauen ist die Folge-Spec.
- **Keine Kapitel, kein Bild im ersten Schnitt.** Q3 hat Text + Zeitbezug
  entschieden. Kapitel (beobachtet, nicht gemessen — siehe `## Bekannte
  Lücken`) und Bild (Screenshot am Zeitpunkt) sind damit **nicht
  ausgeschlossen**, aber **nicht** zugesagt — sie brauchen je eine eigene
  Entscheidung und eine eigene Stufe.
- **Keine YouTube-API.** Die Caption-API von YouTube wird **nicht** benutzt.
  Die Messung M4 zeigt, warum (der Weg liefert nichts) — das ist ein Ergebnis,
  kein offener Punkt.
- **Kein Token, kein API-Key, keine neue Berechtigung.** `<all_urls>` deckt
  youtube.com bereits ab (Beleg in `docs/05`); ein YouTube-Token wäre ein
  Geheimnis im Repo und fällt damit unter die Touch-Boundary.
- **Kein Umgehen von Bot-Walls oder Consent-Mauern.** Fremde Abwehr bleibt
  draußen (`docs/ROADMAP.md`, „Web-Arbeit ohne DOM-Sicht").
- **Keine Aussage über *andere* Video-Seiten.** Gemessen wurde youtube.com.
  Vimeo, Odysee, Twitch und ein eingebetteter Player sind offen.
- **Kein Ersatz für den Menschen.** Der Betreiber schaut weiter selbst; die
  Frage ist nur, was der *Agent* lesen kann.

## Der Befund in einem Satz

**Das Transkript ist heute schon lesbar — mit den vorhandenen Werkzeugen, ohne
neues Werkzeug für den Zugriff, ohne neue Berechtigung** (M1–M3). Was fehlt,
ist nicht der Zugriff, sondern die *Form*: eine Maschinenlesbarkeit mit
Zeitstempeln, eine Sprachwahl, und ein Umgang mit der spät hydrierenden Seite
(M6). Genau daraus folgt Q1 (ein **neues** Werkzeug, aber für die Form, nicht
für den Zugriff).

## Die Messungen

Alle am 2026-11-11, live, im Profil des Betreibers. Werkzeuge aus der
`browser-control`-Bridge, Agenten-Tab, Default-Container.

### M1 — Der UI-Weg trägt, in fünf Schritten

| Schritt | Aufruf | Beobachtung |
|---|---|---|
| 1 | `browser_navigate` → `https://www.youtube.com/watch?v=<video-en>` | Tab 18, Titel „But what is a neural network? \| Deep learning chapter 1" |
| 2 | `browser_focus` (Tab in den Vordergrund) | siehe M6 — **ohne diesen Schritt bleibt die Seite leer** |
| 3 | `browser_click` auf `tp-yt-paper-button#expand` | Beschreibung klappt auf |
| 4 | `browser_click` auf `button[aria-label="Transkript anzeigen"]` | Transkript-Panel öffnet |
| 5 | `browser_read({maxChars: 100000})` | 30 966–31 011 Zeichen, davon 133 Segmente (M2) |

Ohne Schritt 3 gibt es den Knopf nicht: er liegt in der **eingeklappten**
Beschreibung und ist dann `visible: false` — `browser_click` sagt
„Das Element ist nicht sichtbar oder deaktiviert", `browser_inspect` zählt 0
Treffer, obwohl 5 passende Knoten im DOM stehen (M8).

### M2 — Das Transkript steht im Text, mit Zeitstempeln

*Beleg: `browser_read` und `browser_eval` auf `v=<video-en>`, 2026-11-11.*

- 133 Elemente `transcript-segment-view-model`, zusammen **19 645 Zeichen**
  reiner Segmenttext.
- Das Muster je Segment ist dreizeilig:
  `0:04` / `4 Sekunden` / `Das ist eine Drei.` — Zeitstempel, dann die
  ausgeschriebene Form, dann der Satz.
- `browser_read({maxChars: 100000})`: **30 966–31 011 Zeichen**
  (`via: "innerText"`), das Transkript ist darin enthalten. **Der Parameter
  `maxChars` ist nötig** — `docs/22` setzt den Default auf **20 000**, und ein
  `browser_read` ohne Parameter liefert deshalb nur 20 000 Zeichen und damit
  ein **abgeschnittenes** Transkript (mit `truncated: true`, denn
  `offset + chars < totalChars` — `docs/22`). Die Zahl 30 966–31 011 ist die
  Länge des **ganzen** Seitentextes.
- `browser_read({offset: 20000, maxChars: 5000})` funktioniert über das
  Transkript ebenso: → 5 000 Zeichen, `truncated: true`, Anfang mitten in
  einem Satz („…ätzliche Zahl, die vor der Anwendung der Sigmoidfunktion …").
- `browser_read({mode: "article", maxChars: 100000})` liefert das Transkript
  ebenfalls (`root: "[role=\"main\"]"`, 23 482 Zeichen) — **aber ohne
  Zeilenumbrüche**: „0:044 SekundenDas ist eine Drei." Der Artikelmodus eignet
  sich für Transkripte nicht, er verdichtet die Segmente zu einem Bandwurm.

### M3 — Der Zeitbezug ist da: ein Klick springt im Video

*Beleg: `browser_click` auf einen Zeitstempel, `browser_eval` auf
`v=<video-en>`, 2026-11-11.*

Ein Klick auf den Zeitstempel eines Segments setzt den Player:
`video.currentTime` ging von **0** auf **14** Sekunden. Der Weg dorthin ist
der generierte Vollpfad-Selektor aus `browser_inspect` (26 Ebenen tief) — für
eine Handarbeit brauchbar, für eine Spec zu lang.

### M4 — Der API-Weg trägt nicht (drei Versuche, zwei Fehlschlagarten)

*Beleg: `browser_eval` mit `fetch` auf `v=<video-en>` und `v=<video-en-2>`,
2026-11-11.*

| Weg | Aufruf | Ergebnis |
|---|---|---|
| Caption-Datei | `fetch(baseUrl)` aus `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[i].baseUrl` | **HTTP 200, 0 Bytes** — bei `de` manuell, `en` asr, und je `&fmt=json3`, `&fmt=srv3`, `&fmt=vtt` |
| Caption-Datei, ohne Signatur | `fetch("…/api/timedtext?v=…&lang=de&fmt=json3")` | **HTTP 200, 0 Bytes** (`content-type: text/html`) |
| innertube | `POST /youtubei/v1/get_transcript` mit dem `getTranscriptEndpoint.params` der Seite | **HTTP 400 `FAILED_PRECONDITION`** — auch mit `contentCheckOk`/`racyCheckOk` |

Die Seite *hat* die Daten: 31 Caption-Spuren beim ein englisches Erklärvideo-Video (u. a.
`de` manuell, `en` manuell, `en` asr), 6 beim Rick-Astley-Video (u. a.
`en` asr) — nur der Abruf leert aus. **Konsequenz: das Transkript kommt aus
der Oberfläche, nicht aus einer API.** Wer eine API baut, baut gegen
YouTube-Interna, die sich ohne Vorwarnung ändern.

### M5 — `eval` sieht die Seite nur durch `wrappedJSObject`

*Beleg: `browser_eval` auf `v=<video-en>`, 2026-11-11.*

- `window.ytcfg` → `undefined`; `window.wrappedJSObject.ytcfg` → Objekt.
  Ebenso `ytInitialPlayerResponse`.
- **Methoden der Seite mit Callback scheitern:** `tracks.filter(...)` und
  `tracks.map(...)` → „Permission denied to access object". Eine
  Index-Schleife `for (let i = 0; i < t.length; i++)` funktioniert.
  Code, der auf YouTube-Objekte zugeht, braucht Index-Schleifen.
- `await` auf oberster Ebene ist ungültig („await is only valid in async
  functions"). Der Code läuft als `new Function(code)()`; eine
  `return (async () => { … })()` funktioniert und wird erwartet.
- **Ergebnisgrenze 10 000 Zeichen JSON.** 133 Segmente als JSON sind
  **22 368 Zeichen** — ein „alles extrahieren"-Einruf läuft in
  `too_large`. Wer per `eval` extrahiert, muss schneiden.

### M6 — Die Seite hydriert spät, und `read` merkt es nicht

*Beleg: `browser_read` und `browser_focus` auf `v=<video-en>`, 2026-11-11.*

Ein **Hintergrund-Tab** zeigt auf derselben URL nur **12 Zeichen**
(„0:00 / 18:40"), `ytd-watch-flexy` fehlt, fünf Aufrufe hintereinander
gleich. `browser_focus` auf den Tab, und die Seite steht vollständig
(2 676–3 250 Zeichen).

Dabei meldete `browser_read` in diesem Zustand **`settled: true`** — nach
2 812 ms Wartezeit. Die Ruhe-Erkennung kann „Seite lädt noch" nicht von
„Seite ist fertig" unterscheiden. **Für jeden YouTube-Ablauf gilt: `settled`
ist dort keine Aussage.** Das ist die wichtigste Einzelbeobachtung dieser
Recherche.

**Das ist kein Fund und kein Widerspruch.** `docs/14:193` schreibt die Grenze
der Heuristik längst fest: „**Ruhe ist nicht Fertigkeit.** Eine Seite kann
ruhig und trotzdem unfertig sein." M6 ist diese dokumentierte Grenze an einer
konkreten Seite beobachtet — YouTube ist nur der Ort, an dem sie sichtbar
wird, weil die Seite spät hydriert und dann *still* ist. Was M6 hinzufügt, ist
der **Wert**: eine ruhige YouTube-Seite kann 12 Zeichen tragen.

### M7 — Der Untertitel-Knopf ist kein Transkript-Indikator

*Beleg: `browser_eval` (Player-Knopf) und `browser_click` (Transkript-Knopf)
auf `v=<video-en-2>`, 2026-11-11.*

Beim Rick-Astley-Video meldete der Player-Knopf **„Untertitel nicht verfügbar"**
— das Video hat aber ein Transkript (23 Segmente, automatisch erzeugt,
`en/asr`), der Knopf „Transkript anzeigen" existiert und öffnet es. Der
Player-Knopf sagt nichts über die Existenz eines Transkripts aus.

### M8 — `inspect` und `click` sehen (standardmäßig) nur sichtbare Elemente

*Beleg: `browser_inspect` und `browser_click` auf `v=<video-en>`, 2026-11-11.*

Vor dem Aufklappen der Beschreibung: 5 Knoten mit `aria-label` „Transkript"
im DOM, **alle** `visible: false`; `browser_inspect` zählt **0** Treffer,
`browser_click` verweigert. Nach dem Aufklappen: derselbe Knoten sichtbar,
`browser_inspect` findet ihn. Zwei Knoten
`ytd-video-description-transcript-section-renderer` existieren (einer
unsichtbar) — ein Selektor muss die Sichtbarkeit mitentscheiden, sonst
greift er ins Leere.

**Nicht vergessen:** `docs/09` kennt `includeHidden` (Default `false`, mit
`true` kommen die unsichtbaren mit). Die Null-Treffer-Zahl oben ist der
**Standardfall**; die Bereitschaftsprüfung der Folge-Spec braucht
`includeHidden` oder einen eigenen Weg an die unsichtbaren Knoten.

### M9 — Bild ist erreichbar, aber nur über Umwege

*Beleg: `browser_screenshot` und `browser_eval` auf `v=<video-en>`, 2026-11-11.*

`browser_screenshot` zeigt den Player (1904 × 684 im Fenster von
1904 × 853); bei `currentTime = 300` stand das Bild des Videos an der
Minute 5. Ein **eigenes** Werkzeug zum Springen gibt es nicht: Positionieren
geht nur über `eval` (`video.currentTime = …`) oder über einen Klick auf
einen Transkript-Zeitstempel (M3).

### M10 — Der Selektor hängt an der Oberflächensprache

*Beleg: `browser_inspect` auf `v=<video-en>`, 2026-11-11.*

Der Knopf ist `button[aria-label="Transkript anzeigen"]` — **deutsch**, weil
die Oberfläche des Betreibers deutsch ist. Auf englischer Oberfläche heißt er
„Show transcript". Der umgebende Knoten ist stabiler:
`ytd-video-description-transcript-section-renderer` →
`div#button-container` → `yt-button-shape` → `button.ytSpecButtonShapeNextHost`
(dort `aria-label`, `title` **leer**). Die Sprachabhängigkeit steckt also im
`aria-label`, nicht in der Elementstruktur.

## Was daraus folgt

| Beobachtung | Folge für den Zuschnitt |
|---|---|
| M1, M2 | Der Kern („Transkript lesen") ist **gelöst**. Kein neues Werkzeug nötig, um Text zu bekommen. |
| M2 | Der Artikelmodus ist für Transkripte **unbrauchbar** (keine Umbrüche). Entweder `mode: "text"` nutzen oder das Werkzeug muss segmentweise arbeiten. |
| M3, M9 | Der **Zeitbezug** geht ohne `eval` (M3: Klick auf den Zeitstempel). Nur der **nicht entschiedene** Bildpfad (M9) braucht `eval` bzw. `allowScreenshot`. |
| M4 | Eine Caption-API ist **kein** Kandidat. UI-Weg bleibt. |
| M5 | Code auf YouTube braucht Index-Schleifen und Rückschneiden. |
| M6 | Jede Automatik braucht einen **Bereitschafts-Test**, kein `settled`. |
| M7 | „Hat das Video ein Transkript?" ist **nicht** über den Player-Knopf beantwortbar. |
| M8 | Selektoren müssen Sichtbarkeit mitentscheiden. |
| M10 | Ein deutscher `aria-label` ist kein dauerhafter Vertrag. |

**Und was daraus entschieden wurde** — die Entscheidungen selbst stehen in
`## Ziel` (Tabelle am Kopf) und ihre Begründungen bei den Fragen in
`## Open questions`. Hier nur die Zuordnung Frage → tragende Messung:

| Frage | Entscheidung | Welche Messung trägt sie |
|---|---|---|
| Q1 | neues Werkzeug `browser_transcript` | M6 — die Wartelogik gehört in Code, nicht in eine Anleitung |
| Q2 | Originalsprache des Videos | M4 — 31 Spuren, darunter eine deutsche Spur; dass die deutsche eine **Übersetzung** ist, ist daraus **abgeleitet**, nicht gemessen (M4 protokolliert `de`/`en`/`manuell`/`asr`, kein Übersetzungsflag) |
| Q3 | Text + Zeitbezug | M3 — ein Klick auf den Zeitstempel sprang auf 14 s; der Zeitbezug ist benutzbar |
| Q4 | sprachunabhängig | M10 — die Elementstruktur ist stabil, nur das `aria-label` ist deutsch |
| Q5 | das Modell des Agenten | — keine Messung nötig: (b) wäre ein Modell im Repo oder ein externer Dienst |

## Testing

Diese Spec erzeugt **keinen Code**, also gibt es **keine neuen Tests**. Der
Beleg ist das Messprotokoll; die Kriterien unten prüfen das Dokument.

**Nachprüfbarkeit der Messungen.** Jede Zeile der Tabellen M1–M10 ist eine
Beobachtung mit Video-ID, Werkzeug und Wert. Wer sie wiederholen will, öffnet
`https://www.youtube.com/watch?v=<video-en>` bzw.
`https://www.youtube.com/watch?v=<video-en-2>` in einem Agenten-Tab, fokussiert
den Tab und geht die Schritte aus M1 durch. Die Werte schwanken in den
Größenordnungen, die oben genannt sind (Seitenlänge 2 676–3 250 Zeichen im
frischen Zustand, 30 966–31 011 nach dem Transkript) — das ist YouTube, nicht
der Messfehler.

**Das Wiederholungsprotokoll** — je Messung eine Zeile, in der Reihenfolge der
M-Nummern. Der Erwartungswert ist der am 2026-11-11 gemessene Wert, als
Bereich, wo die Messung schwankt; eine Wiederholung, die **außerhalb** des
Bereichs liegt, widerlegt M1 (die Kernannahme der Folge-Spec) und geht
zurück in die Spec, nicht in die Lückenliste.

| Nr. | Wiederholung | Erwartung (2026-11-11) |
|---|---|---|
| **Wiederholung (M1):** | `browser_navigate` → `browser_focus` → `browser_click` (`tp-yt-paper-button#expand`) → `browser_click` (Transkript-Knopf) → `browser_read({maxChars: 100000})` | fünf Schritte, Panel offen, 30 966–31 011 Zeichen |
| **Wiederholung (M2):** | `browser_eval` (Zahl der `transcript-segment-view-model`) und `browser_read({maxChars: 100000})` | 133 Segmente, 19 645 Zeichen reiner Segmenttext, `via: "innerText"` |
| **Wiederholung (M3):** | `browser_click` auf einen Zeitstempel, dann `browser_eval` auf `video.currentTime` | `currentTime` springt von 0 auf **14** |
| **Wiederholung (M4):** | `browser_eval` mit `fetch` auf die `baseUrl` aus `ytInitialPlayerResponse.captions…captionTracks[i]` | HTTP 200 mit **0 Bytes**; innertube `get_transcript` ⇒ HTTP 400 |
| **Wiederholung (M5):** | `browser_eval` mit `window.ytcfg` und `window.wrappedJSObject.ytcfg` | ersteres `undefined`, letzteres ein Objekt |
| **Wiederholung (M6):** | `browser_read` auf einem **Hintergrund**-Tab, dann `browser_focus` und erneut | 12 Zeichen und `settled: true`; nach dem Fokus 2 676–3 250 Zeichen |
| **Wiederholung (M7):** | `browser_eval` (Player-Knopf) und `browser_click` (Transkript-Knopf) auf `v=<video-en-2>` | „Untertitel nicht verfügbar" **und** 23 Segmente |
| **Wiederholung (M8):** | `browser_inspect` vor und nach `browser_click` auf `tp-yt-paper-button#expand` | 0 Treffer vorher, Treffer nachher |
| **Wiederholung (M9):** | `browser_eval` (`video.currentTime = 300`) und `browser_screenshot` | Player 1904 × 684 im Fenster 1904 × 853 |
| **Wiederholung (M10):** | `browser_inspect` auf den Transkript-Knopf | `aria-label="Transkript anzeigen"`, Elternknoten `ytd-video-description-transcript-section-renderer` |

**Das Abkriterien-Protokoll** — der Ersatz für Tests. Jede Zeile ist ein
Befehl aus `## Acceptance criteria`, sein erwartetes Ergebnis und das
**beobachtete** vom 2026-11-11. Die Abnahme-Befehle aus `CONTRIBUTING.md`
(`npm test`, `npm run check`, Secret-grep) stehen daneben: sie beweisen
**nichts** über diese Spec — sie belegen, dass der Baum unversehrt ist, und
`npm run check` sieht Markdown gar nicht.

| Nr. | Befehl | erwartet | beobachtet | ✔ |
|---|---|---|---|---|
| 1 | `grep -n '^status:'` + die beiden `sed`-Zähler | `active`, 5, 1 | `status: active`, **5**, **1** | ✔ |
| 2 | Node-Einzeiler über die M-Abschnitte | 10 Abschnitte, 0 ohne Beleg | **M-Abschnitte: 10 ohne Beleg: 0**, Exit 0 | ✔ |
| 3 | `git status --porcelain` | nur Einträge unter `docs/` | 4 Einträge, alle unter `docs/` | ✔ |
| 4 | die beiden `grep`-Befehle auf `docs/README.md` | 1 und 1 | **1** und **1** | ✔ |
| 5 | `grep -c '^| 17 \|.*31-youtube-recherche' docs/ROADMAP.md` | 1 | **1** | ✔ |
| 6 | `sed`-Zähler für die Marker und das Datum | 5 und 1 | **5** und **1** | ✔ |
| 7 | Dateiname im Folge-Spec-Abschnitt | 1 | **1** | ✔ |
| 8 | die sechs Content-Befehle | je 1 | **1, 1, 1, 1, 1, 1** | ✔ |

**Werkzeuggrenzen, die dabei auffielen und für die Folge-Spec gelten** (aus
dem Code gelesen, `extension/background.js`): `EVAL_RESULT_LIMIT` = 10 000
(`:304`), `EVAL_TIMEOUT_MS` = 2 000 (`:290`), `eval` läuft als
`new Function(cfg.code)()` (`:4850`), `eval` kennt kein Top-Level-`await`.

**Portabilität der Beweise.** Die Abnahme-Befehle dieser Spec laufen in
**Git Bash** (wie `docs/30`), nicht in `cmd.exe`: `grep`, `sed` und `node`
werden vorausgesetzt. Wer auf einem Wirt ohne GNU-Werkzeuge prüfen will,
nimmt die Node-Varianten — die Befehle sind so gewählt, dass `node -e` sie
ersetzen kann. Die eigentlichen Beweise sind **keine** Textbefehle, sondern
die Beobachtungen aus M1–M10: die laufen über die Bridge des Betreibers und
sind überall dort lauffähig, wo die Bridge läuft. Das Abkriterien-Protokoll
oben belegt nur, dass das **Dokument** die Entscheidungen trägt.

## Acceptance criteria

1. **Die Spec ist entschieden.** `docs/31-youtube-recherche.md` trägt
   `status: active`; `## Open questions` sagt „Keine offenen", und die
   Fragen Q1–Q5 tragen je eine mit „→" markierte Entscheidung. Beweis:
   `grep -n '^status:' docs/31-youtube-recherche.md` ⇒ `status: active`;
   `sed -n '/^## Open questions/,/^## Risiken/p' docs/31-youtube-recherche.md
   | grep -c '→ \*\*('` ⇒ **5** (Q1–Q5; der ganze Text zählt 7, weil der
   Dev-Plan das Format zweimal als Beispiel zitiert — deshalb der Abschnitt,
   und deshalb endet er bei `## Risiken`: Review- und Log-Zeilen, die später
   dazukommen, dürfen den Zähler nicht umwerfen);
   `sed -n '/^## Open questions/,/^## Risiken/p' docs/31-youtube-recherche.md
   | grep -c 'Keine offenen'` ⇒ **1** (der Abschnitt allein — der Text des
   Kriteriums zitiert den String mit und würde ihn sonst mehrfach zählen).
2. **Jede Messung ist belegt.** Die Abschnitte M1–M10 nennen zu jedem Wert
   Video-ID, Werkzeugaufruf und Beobachtung; kein Wert steht ohne seinen
   Beleg da. Beweis:
   ```
   node --input-type=commonjs -e "const fs=require('fs');const t=fs.readFileSync('docs/31-youtube-recherche.md','utf8');const b=t.split(/\n(?=### M)/).slice(1);let bad=0;for(const s of b){if(!/v=(aircAruvnKk|dQw4w9WgXcQ)/.test(s)||!/browser_|fetch/.test(s)){bad++;console.log('FEHLT',s.split('\n')[0])}}console.log('M-Abschnitte:',b.length,'ohne Beleg:',bad);process.exit(bad?1:0)"
   ```
   ⇒ `M-Abschnitte: 10 ohne Beleg: 0`, Exit 0.
3. **Kein Produktcode.** Das Inkrement ändert keine Datei außerhalb von
   `docs/`. Beweis: `git diff --name-only <base>..HEAD` ⇒ nur `docs/…`;
   `git diff --stat <base>..HEAD -- bridge extension test scripts package.json
   INSTALL.md` ⇒ **leer**. **`<base>`** ist der Commit **direkt vor** dem
   Commit dieses Inkrements — nicht „irgendein alter Stand". Ergänzend, weil
   `git diff` keine untracked Datei sieht: `git status --porcelain` ⇒ nur
   Einträge unter `docs/`. `docs/README.md` und `docs/PROJECT-STATE.md` werden
   **mit** committet (siehe `## Touch boundary`), beide liegen unter `docs/`
   und stören dieses Kriterium deshalb nicht.
4. **Die Registry führt die Spec.** `docs/README.md` hat **genau eine**
   Registerzeile für `31-youtube-recherche.md`, und die Status-Spalte dieser
   Zeile sagt `active`. Beweis:
   `grep -c '^| `31-youtube-recherche.md`' docs/README.md` ⇒ **1**;
   `grep '^| `31-youtube-recherche.md`' docs/README.md | grep -c '| `active` |'`
   ⇒ **1**.
5. **Die Roadmap zeigt auf die Spec.** Die **Tabellenzeile 17** in
   `docs/ROADMAP.md` (nicht die Dateizeile 17) nennt
   `docs/31-youtube-recherche.md` und den daraus folgenden Zuschnitt. Beweis:
   `grep -c '^| 17 |.*31-youtube-recherche' docs/ROADMAP.md` ⇒ **1**.
6. **Die Entscheidungen stehen in der Spec, nicht im Chat.** Die Fragen Q1–Q5
   aus `## Open questions` tragen je eine Entscheidung des Betreibers mit
   Datum und Begründung aus der Messung. Beweis: `sed -n '/^## Open
   questions/,/^## Risiken/p' docs/31-youtube-recherche.md | grep -c
   '→ \*\*('` ⇒ **5**; `sed -n '/^## Ziel/,/^## Non-goals/p'
   docs/31-youtube-recherche.md | grep -c 'Entschieden am 2026-11-11'` ⇒ **1**
   (der Zielabschnitt, nicht der ganze Text — sonst zählt der Kriteriumstext
   sich selbst mit).
7. **Die Folgespec ist benannt.** Die Spec nennt die **eine** Folge-Spec mit
   Dateiname, Ziel und Zuschnitt. Der Dateiname ist **vorläufig** (die Nummer
   hängt von der Entstehungsreihenfolge ab), deshalb wird er als Muster
   geprüft. Beweis:
   `sed -n '/^## Die Folge-Spec/,/^## Open questions/p' docs/31-youtube-recherche.md
   | grep -cE 'docs/[0-9]{2}-transkript-werkzeug\.md'` ⇒ **1**;
   `grep -c 'browser_transcript' docs/31-youtube-recherche.md` ⇒ mindestens
   eine Zeile.
8. **Die Folge-Spec sagt dasselbe wie die Entscheidungen.** Der Kern einer
   Recherche-Spec ist die Entscheidung — Kriterium 1 und 6 prüfen nur, dass
   sie **da** ist, nicht dass sie **richtig** ist. Dieses Kriterium prüft den
   **Inhalt**: die Zeile „Umfang" der Folge-Spec-Tabelle muss „Text **+**
   Zeitbezug" sagen, die Zeile „Sprache" muss die „Originalspur" nennen, und
   die Zeile „Sprachunabhängigkeit" muss den **Strukturanker** nennen und den
   deutschen `aria-label` **ausdrücklich ausschließen**. Beweis — jede Zeile
   einzeln (der Ausschnitt wird in eine Datei geschrieben, weil der Mustertext
   in Git Bash unter Windows sonst am `%`-/Pipe-Umweg zuschlägt):
   ```
   sed -n '/^## Die Folge-Spec/,/^## Open questions/p' docs/31-youtube-recherche.md > /tmp/fs.txt
   grep -c '| \*\*Umfang\*\* | Text \*\*+ Zeitbezug\*\*' /tmp/fs.txt                          ⇒ 1
   grep -c '| \*\*Sprache\*\* | die \*\*Originalspur\*\*' /tmp/fs.txt                        ⇒ 1
   grep -c 'ytd-video-description-transcript-section-renderer' /tmp/fs.txt                  ⇒ 1
   grep -c '\*\*nicht\*\* über' /tmp/fs.txt                                                ⇒ 1
   grep -c '| \*\*Zusammenfassung\*\* | macht das \*\*Modell des Agenten\*\*' /tmp/fs.txt     ⇒ 1
   grep -c '| \*\*Umfang\*\*.*\*\*Kapitel und Bild sind nicht entschieden\*\*' /tmp/fs.txt    ⇒ 1
   ```
   Der vierte Befehl ist der eigentliche Inhaltsbeleg für Q4: der Anker der
   Folge-Spec darf **nicht** das deutsche `aria-label` sein, sondern der
   Strukturanker. Der deutsche Text darf in der Tabelle also **vorkommen** —
   aber nur als das, was ausgeschlossen wird.

   Der fünfte und der sechste Befehl decken **Q5** und die offene Hälfte von
   **Q3** ab: die Zusammenfassung macht das Modell des Agenten (kein Code im
   Projekt), und Kapitel/Bild sind **nicht entschieden** — nicht ausgeschlossen,
   nicht zugesagt. Wichtig: das sind **negative** Zusagen, und genau deshalb
   muss die Tabelle sie ausschreiben, statt sie wegzulassen — eine Zeile, die
   Kapitel und Bild gar nicht erwähnt, wäre nicht vom Entschiedenen zu
   unterscheiden.

## Dev plan

**Was dieses Inkrement ist.** Eine Recherche-Spec: kein Produktcode. **Keine
Stufe fasst eine Datei außerhalb von `docs/` an** — kein `bridge/`, kein
`extension/`, kein `test/`, kein `scripts/`, kein `package.json`, kein
`INSTALL.md`. Alle vier Stufen sind **Doku-Arbeit an genau einer Datei**
(`docs/31-youtube-recherche.md`); Stufe 4 ist zusätzlich Orchestrator-Arbeit an
`docs/README.md`, `docs/ROADMAP.md` und `docs/PROJECT-STATE.md`.

**Wer hat sie ausgeführt:** alle vier Stufen hat der **Orchestrator**
ausgeführt (2026-11-11). Der Dev-Plan war ursprünglich auf „Stufen 1–3
Umsetzer" ausgelegt; weil die Stufen reine Dokumentarbeit an dieser einen
Datei sind und die Orchestrator-Arbeit an den drei Begleitdateien ohnehin
dieselbe Sitzung brauchte, sind sie zusammengefallen. Das ist eine
**Abweichung vom Plan**, im `## Log` festgehalten — kein heimlicher Wechsel,
und sie ändert am Ergebnis nichts: es gab keinen Produktcode, keinen
Umsetzer-Konflikt und nur einen Schreiber im Arbeitsbaum.

**Befund vor dem Bau** (in den Dateien gelesen, nicht geschätzt):

- `grep -c '^### M' docs/31-youtube-recherche.md` ⇒ **10** (M1–M10 da);
  `sed -n '/^## Open questions/,/^## Risiken/p' docs/31-youtube-recherche.md
  | grep -c '→ \*\*('` ⇒ **5** (Q1–Q5 entschieden); `grep -n '^status:'` ⇒
  `status: proposed`.
- **Die drei Befunde der Review-Runde 1 waren blocking und sind im Rahmen
  dieser Spec behoben** (Review-Runde 1, 2026-11-11): Kriterium 2 war nicht
  erfüllbar, weil die Blöcke M5, M7 und M10 weder `browser_` noch `fetch`
  nannten und nur M1 eine Video-ID trug — alle drei tragen jetzt ihre
  Belegzeile; Kriterium 1 zitierte seinen eigenen Suchstring — es misst jetzt
  über `sed` den Abschnitt `## Open questions` bis `## Risiken`;
  Kriterium 7 war per Grep nicht ausdrückbar, weil der Dateiname außerhalb
  des Wortes „Folge-Spec" stand — es misst jetzt über `sed` den Abschnitt
  `## Die Folge-Spec`.
- Arbeitsbaum: `docs/README.md`, `docs/ROADMAP.md`, `docs/PROJECT-STATE.md`
  sind **bereits geändert** (Orchestrator), `docs/31-youtube-recherche.md` ist
  untracked. Diese drei Dateien gehören Stufe 4, nicht dem Umsetzer.
- `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe (Exit 1) — die
  Video-IDs sind kein Hex.
- `scripts/check.mjs:27` prüft nur `.js`/`.mjs` — **Markdown wird von
  `npm run check` nicht berührt**.

1. **Belegzeilen — bereits erfüllt (2026-11-11), Nachweis statt Arbeit.**
   **Completed 2026-11-11**
   Die Abschnitte `### M1`–`### M10` tragen jetzt je eine Belegzeile mit
   Video-ID und Werkzeugaufruf; das ist die Arbeit, die der Review in Runde 1
   verlangt hat. **Kein beobachteter Wert ändert sich** — die Zahlen bleiben
   die vom 2026-11-11; nur die Herkunft wurde ergänzt. Der Umsetzer prüft
   diesen Zustand und meldet ihn, statt ihn herzustellen.
   Proof: `grep -c '^### M' docs/31-youtube-recherche.md` ⇒ 10 **und**
   ```
   node --input-type=commonjs -e "const fs=require('fs');const t=fs.readFileSync('docs/31-youtube-recherche.md','utf8');const b=t.split(/\n(?=### M)/).slice(1);let bad=0;for(const s of b){if(!/v=(aircAruvnKk|dQw4w9WgXcQ)/.test(s)||!/browser_|fetch/.test(s)){bad++;console.log('FEHLT',s.split('\n')[0])}}console.log('M-Abschnitte:',b.length,'ohne Beleg:',bad);process.exit(bad?1:0)"
   ```
   ⇒ `M-Abschnitte: 10 ohne Beleg: 0`, Exit 0. **Kein** neues Skript unter
   `scripts/` — das ist außerhalb der Touch-Boundary.

2. **Das Messprotokoll wiederholbar machen.** **Completed 2026-11-11**
   Datei: `docs/31-youtube-recherche.md`,
   `## Testing`. Je Messung kommt **eine** Zeile der Form
   `**Wiederholung (M<Nr>):** <Werkzeugaufruf(e)> → <erwartete Beobachtung>` —
   die M-Nummer gehört in die **Zeile**, sonst sind zehn Wiederholungszeilen
   ein unbeschrifteter Haufen. Mit den
   **fünf** Aufrufen aus M1 in der Reihenfolge `browser_navigate` →
   `browser_focus` → `browser_click` (`tp-yt-paper-button#expand`) →
   `browser_click` (Transkript-Knopf) → `browser_read({maxChars: 100000})`.
   **Beide Klicks müssen dastehen** — wer nur einen nennt, schreibt ein Rezept,
   das am eingeklappten Panel hängenbleibt, also genau den Fehler aus M8.
   Die Erwartungswerte sind die Bereiche, die die Spec schon nennt
   (2 676–3 250 Zeichen frisch, 30 966–31 011 nach dem Transkript). Die Zeile
   über die Werkzeuggrenzen bleibt und ihre Verweise stimmen:
   `extension/background.js:290` (`EVAL_TIMEOUT_MS = 2000`),
   `:304` (`EVAL_RESULT_LIMIT = 10000`), `:4850` (`new Function(cfg.code)()`) —
   beim Umschreiben des Abschnitts **nicht** verschieben. Kein Video-Host, kein
   Werkzeugaufruf und keine Oberflächensprache kommt neu hinein, die nicht
   gemessen wurde.
   Proof: `grep -c '^### M' docs/31-youtube-recherche.md` ⇒ 10 **und**
   `grep -c '^| \*\*Wiederholung (M' docs/31-youtube-recherche.md` ⇒ **10**
   (die Zeilen stehen als Tabellenzeilen, deshalb führt der Muster die
   Tabellenpipe mit).

3. **Die Abnahme-Kriterien einmal fahren — der Ersatz für Tests.**
   **Completed 2026-11-11** — das Protokoll steht in `## Testing`.
   Diese Spec
   hat keine Tests; ihr Beleg ist ein **Abkriterien-Protokoll**. Datei:
   `docs/31-youtube-recherche.md`, `## Testing`, als Tabelle mit **acht** Zeilen
   `| <Nr> | <Befehl> | <erwartet> | <beobachtet> | ✔ |`. Der Umsetzer fährt
   jeden der acht Beweisbefehle aus `## Acceptance criteria` gegen das
   Dokument und trägt das **beobachtete** Ergebnis ein — auch dann, wenn es von
   der Erwartung abweicht. Wo ein Beweisbefehl wegen seiner eigenen Form nicht
   entscheidbar ist, protokolliert er die **entscheidbare Variante** daneben
   (Kriterium 1, 6 und 7 pipen ihre `sed`-Schnitte direkt, Kriterium 2 läuft
   über den Node-Einzeiler aus Stufe 1, und nur Kriterium 8 schreibt seinen
   Ausschnitt in eine Datei — dort steht der Mustertext, der in Git Bash
   zuschlägt).
   **`## Acceptance criteria` ändert der Umsetzer nicht** — die Spec gehört dem
   Orchestrator. Weicht ein Kriterium ab, meldet er das in seinem Bericht
   (`## Open`), nicht durch eine Textänderung.
   **Nachgetragen (2026-11-11):** da der Orchestrator die Stufen selbst
   ausgeführt hat, sind die drei Kriterien 1, 3 und 4 **nach** Stufe 4
   nachgefahren worden — die Protokolltabelle trägt deshalb für alle acht
   Zeilen ein beobachtetes Ergebnis.
   **Drei Kriterien sind erst nach Stufe 4 erfüllbar**, und das ist kein
   Fehler, sondern die Bauordnung: Kriterium 1 verlangt `status: active` (setzt
   Stufe 4), Kriterium 3 verlangt `git diff <base>..HEAD` (es gibt vor dem
   Commit keinen Commit), Kriterium 4 verlangt die Status-Spalte `active` in
   der Registerzeile (setzt Stufe 4 ebenfalls). Der Umsetzer trägt diese drei
   Zeilen als **„wartet auf Stufe 4"** ein und fährt die übrigen fünf
   vollständig; er meldet sie **nicht** als rot — ein Rot an dieser Stelle wäre
   eine Falschmeldung, keine Information.
   Proof: `sed -n '/^## Testing/,/^## Acceptance criteria/p'
   docs/31-youtube-recherche.md | grep -cE '^\| [1-8] \|'` ⇒ **8** (der
   Ausschnitt zwingend — im ganzen Text zählt die M1-Tabelle in `## Die
   Messungen` mit, fünf Zeilen der Form `| 1 |` … `| 5 |`);
   jede der acht Zeilen trägt ein beobachtetes Ergebnis, keine leere Spalte.

4. **Abschluss (Orchestrator).** **Completed 2026-11-11**
   Kriterien 1–8 einzeln am Diff prüfen, jede
   Zahl und jeden Video-Wert gegen die Beobachtung lesen, `## Bekannte Lücken`
   fortschreiben (der Kopf „Stand 2026-11-11, **vor der Entscheidung**:" wird
   auf den Stand **nach** der Entscheidung gezogen — die Lücken selbst bleiben:
   andere Hosts, Live, Shorts, Altersbeschränkung, Werbung, der ungeklickte
   Kapitelpfad, der einmalige Screenshot), Prosa beschreibend machen,
   `status: active`, `docs/README.md` (Registerzeile ⇒ `active`),
   `docs/ROADMAP.md` (Zeile 17) und `docs/PROJECT-STATE.md` (der Absatz „Spec 31
   … ist `proposed`" ⇒ `active` mit Datum) pflegen, dann **committen**.
   **Achtung, `## Open questions` bleibt unverändert** — Überschrift,
   „Keine offenen" und die fünf `→ **(`-Marker sind das, was Kriterium 1 und 6
   messen. Wer dort umformuliert, wirft beide Kriterien um, ohne dass sich
   etwas am Inhalt geändert hätte. **Und `## Die Folge-Spec` wird nicht
   umformuliert** — Kriterium 8 hängt an **sechs** gepinnten Formulierungen:
   „Text **+** Zeitbezug", „die **Originalspur**",
   „ytd-video-description-transcript-section-renderer", „**nicht** über",
   „macht das **Modell des Agenten**" und „**Kapitel und Bild sind nicht
   entschieden**". Genau diese beiden letzten Zeilen dürfte der Orchestrator
   beim „Prosa beschreibend machen" umschreiben — und dann kippt Kriterium 8 im
   allerletzten Schritt.
   Die Abnahmebefehle aus `CONTRIBUTING.md` laufen als Gate:
   `npm test; echo $?` ⇒ 0 mit `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` ⇒ 0; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   ⇒ keine Ausgabe, Exit 1. **Diese drei Befehle beweisen nichts über diese
   Spec** — sie belegen, dass der Baum unversehrt ist; `npm run check` sieht
   Markdown gar nicht. Der eigentliche Beweis sind die acht Kriterien aus
   Stufe 3.
   Proof: `grep -n '^status:' docs/31-youtube-recherche.md` ⇒ `status: active`;
   `sed -n '/^## Open questions/,/^## Risiken/p' docs/31-youtube-recherche.md
   | grep -c '→ \*\*('` ⇒ 5; `grep -n '31-youtube-recherche' docs/README.md` ⇒
   genau eine Zeile (Spalte `active`); `grep -n '31-youtube-recherche' docs/ROADMAP.md`
   ⇒ genau eine Zeile; `git diff --name-only <base>..HEAD` ⇒ nur `docs/…`;
   `git diff --stat <base>..HEAD -- bridge extension test scripts package.json`
   ⇒ **leer**.

### Wer macht welche Stufe

*Plan, wie er dasteht — ausgeführt hat ihn der Orchestrator, siehe oben.*

**Stufen 1–3: der Umsetzer**, nur `docs/31-youtube-recherche.md`. Er fasst
`docs/README.md`, `docs/ROADMAP.md` und `docs/PROJECT-STATE.md` **nicht** an
(dirty Baum, gehören Stufe 4) und legt **`docs/32-transkript-werkzeug.md` nicht
an** — die Folge-Spec ist ein eigenes Inkrement mit eigenem Gate. **Stufe 4: der
Orchestrator**, inklusive Commit. Umsetzer und Orchestrator laufen nicht
parallel — ein Schreiber pro Arbeitsbaum.

### What could go wrong

- **Kriterium 2 fällt in Stufe 1 durch und zieht einen Textumbau nach sich.**
  Wer statt einer Belegzeile den Absatz umschreibt, verliert Zahlen. Erkennung:
  der Node-Einzeiler meldet `ohne Beleg: 0`, und die Werte 19 645 / 22 368 /
  12 / 2 812 / 31 stehen unverändert im Text.
- **Kriterium 1 bleibt falsch-rot.** `grep -n 'Keine offenen'` findet fünf
  Zeilen (Kriteriumstext, Proof-Befehl, Stufe-4-Warnung, Diagnose-Absatz,
  echter Treffer), wenn über den ganzen Text gemessen wird. Erkennung: der
  Zeilenzähler ist größer als 1. Auflösung: über den isolierten Abschnitt
  messen (siehe Stufe 3) — **nicht** durch Löschen des Zitats in
  `## Acceptance criteria` (das gehört dem Orchestrator).
- **Kriterium 3 mit `<base>..HEAD` sieht fremde Inkremente.** Landen zwischen
  base und HEAD die Specs 28 oder 30, zeigt der Diff Code-Dateien und das
  Kriterium wird falsch rot. Erkennung: `git log --oneline <base>..HEAD` zeigt
  mehr als den einen Commit. Auflösung: `<base>` = der Commit direkt vor dem
  Commit dieses Inkrements; zusätzlich `git status --short` ⇒ nur `docs/`.
- **Der Pfeilzähler bricht bei einer Formatänderung.** `grep -c '→ \*\*('` ⇒ 5
  verlangt die Form `→ **(`. Wer eine Entscheidung umformatiert (`**→ (b)**`),
  zählt 4 und wirft Kriterium 1 und 6 um. Erkennung: der Zähler.
- **M6 wird als Widerlegung gelesen.** Wer ohne `browser_focus` misst, sieht
  12 Zeichen und schließt „Transkript unlesbar". Das ist die Messumgebung,
  nicht die Spec — M1 Schritt 2 und M6 nennen den Fokus ausdrücklich. Erkennung:
  eine Beobachtung ohne den Fokus-Schritt; die Beobachtung darf nicht in die
  Spec übernommen werden.
- **Die Zahlen sind Momentaufnahmen eines Tages.** 30 966–31 011 Zeichen,
  133 Segmente, 31 Caption-Spuren: YouTube ändert das. Erkennung: eine
  Wiederholung liefert Größenordnungen außerhalb der genannten Bereiche — dann
  ist **M1 widerlegt** (Kernannahme der Folge-Spec), und das Inkrement geht
  zurück in die Spec, nicht in die Lückenliste.
- **Die Grenze von 10 000 Zeichen (M5) verführt zum Abschneiden im Code.**
  Diese Spec baut kein Werkzeug; wer „133 Segmente als JSON" in ein
  `eval`-Skript schreibt, baut Produktcode in eine Doku-Spec. Erkennung:
  `git status --short` zeigt eine Datei außerhalb `docs/`.
- **Der Secret-Grep ist eine Stolperfalle:** die Video-IDs sind kein Hex
  (`aircAruvnKk`, `dQw4w9WgXcQ`), aber ein ausgedruckter 32-stelliger Hex-Wert
  im Dokument macht ihn rot. Erkennung: Exit 1 mit Ausgabe.

### Ordering and dependencies

1 (Nachweis) → 2 → 3 → 4, jede Stufe für sich grün; keine Stufe braucht eine
spätere.
Stufe 1 ist ein Nachweis (der Belegzeilen-Stand ist vom 2026-11-11), Stufe 2
zuerst an der Arbeit, weil Stufe 3 die Kriterien gegen das fertige Dokument
fährt. Stufe 2 vor Stufe 3, weil das Wiederholungsprotokoll die
Beobachtungswerte erst benennt. Stufe 3 vor Stufe 4, weil der Orchestrator
die Kriterien am Diff prüft und das Protokoll das Urteil trägt. Stufe 4
zuletzt, weil sie den Ist-Zustand beschreibt und `status: active` setzt.

### What the next increment inherits

Die Folge-Spec `browser_transcript` (`docs/32-transkript-werkzeug.md` — die
**Nummer ist vorläufig**, verbindlich ist der Zuschnitt) erbt:

- **Die Route (M1):** `navigate` → `focus` → `click` auf
  `tp-yt-paper-button#expand` → `click` auf den Transkript-Knopf → `read`. Ohne
  Schritt 3 (Aufklappen) ist der Knopf unsichtbar, und `browser_inspect` zählt
  0 Treffer bei 5 passenden Knoten (M8).
- **Das Segmentmodell (M2):** je Segment drei Zeilen — Zeitstempel, ausgeschriebene
  Form, Satz; 133 Segmente, 19 645 Zeichen reiner Segmenttext. Der Artikelmodus
  ist für Transkripte unbrauchbar (keine Umbrüche) — der Textmodus oder
  segmentweises Arbeiten.
- **Den Zeitbezug (M3):** ein Klick auf den Zeitstempel setzte `currentTime`
  von 0 auf 14 s. Der Weg dorthin ist der generierte Vollpfad-Selektor (26
  Ebenen) — zu lang für eine Handarbeit, aber vorhanden.
- **Die Regeln von YouTube (M4, M5):** keine Caption-API (HTTP 200/0 Bytes,
  innertube HTTP 400 `FAILED_PRECONDITION`); auf YouTube braucht Code
  Index-Schleifen (Methoden der Seite scheitern mit „Permission denied to
  access object"), kein Top-Level-`await`, und ein Ergebnis über 10 000 Zeichen
  JSON (`too_large`).
- **Die Bereitschaftsprüfung (M6) — der teuerste Teil:** `settled: true` kam
  nach 2 812 ms auf einer Seite, die noch gar nicht geladen war. Das Werkzeug
  prüft die Panel-Bereitschaft selbst; `settled` ist dort keine Aussage.
- **Die Wächter-Regeln (M7, M8, M10):** der Player-Knopf sagt nichts über die
  Existenz eines Transkripts („Untertitel nicht verfügbar" bei einem Video mit
  23 Segmenten); Selektoren müssen Sichtbarkeit mitentscheiden (zwei
  `ytd-video-description-transcript-section-renderer`, einer unsichtbar); der
  Anker ist der Strukturanker, **nicht** `aria-label="Transkript anzeigen"`.
- **Die Entscheidungen Q1–Q5:** neues Werkzeug, Originalspur des Videos, Text +
  Zeitbezug, sprachunabhängig, Zusammenfassung macht das Modell des Agenten.
- **Was die Folge-Spec selbst entscheiden muss:** die **Regel, welche Spur die
  Originalspur ist** (Q2 verlangt sie ausdrücklich — fällt sie falsch aus, liefert
  das Werkzeug die Übersetzung und behauptet, es sei das Original); der
  Fehlerpfad „kein Transkript / Knopf nicht gefunden"; ob `offset`/`maxChars`
  wie bei `read` gelten; ob das Werkzeug hinter einem **eigenen** Schalter
  liegt (der `allowEval`-Schalter aus `docs/19` gilt für Agentenkode, nicht
  für Extension-Code).
- **Was ausdrücklich offen bleibt:** Kapitel und Bild (Q3 — je eine eigene
  Entscheidung und Stufe), andere Video-Hosts, Live-Streams, Shorts, Mobilansicht,
  Altersbeschränkung, private und regionsgesperrte Videos, Netzwerk-Timeouts,
  Werbung. Ein eigenes Werkzeug zum Springen gibt es weiterhin nicht (M9:
  Positionieren nur über `eval` oder den Klick auf einen Zeitstempel).
- **Die Kernannahme:** der Transkriptinhalt ist über die Oberfläche zuverlässig
  erreichbar (M1). Wird sie widerlegt, geht **das Inkrement der Folge-Spec**
  zurück in die Spec — nicht in die Lückenliste.
- **Technisch erbt die Folge-Spec nichts:** keine neue Berechtigung, kein
  Token, keine Abhängigkeit, kein geänderter Produktcode. `browser_transcript`
  wird das **dreizehnte** Werkzeug neben `browser_frames`.

## Die Folge-Spec

Das Inkrement, das aus dieser Recherche folgt, ist **ein** weiteres Inkrement —
die Specs sind nach dem Muster 24/25/26 geteilt, damit jede für sich durch
die Gates kommt.

**`docs/32-transkript-werkzeug.md` — `browser_transcript`**

| | |
|---|---|
| **Werkzeug** | `browser_transcript` — das dreizehnte, neben `browser_frames` |
| **Ziel** | Das Transkript des Video-Tabs als **Segmente**: je Segment ein Zeitstempel und ein Text, statt eines Textbandes mit Zeitstempeln darin (M2) |
| **Sprache** | die **Originalspur** des Videos (Q2). **Konkretisiert am 2026-11-11:** ist die Originalspur `en` oder `de`, gilt sie; sonst die **englische Spur**, wenn es eine gibt; sonst das Original mit genannter Sprache (`docs/33-spurwahl.md`). Die **Übersetzungsspuren bleiben unberührt** |
| **Umfang** | Text **+ Zeitbezug** (Q3). **Kapitel und Bild sind nicht entschieden** — nicht ausgeschlossen, nicht zugesagt (siehe `## Non-goals`) |
| **Zusammenfassung** | macht das **Modell des Agenten** (Q5) — im Projekt kommt **kein Code** dazu |
| **Sprachunabhängigkeit** | Der Knopf wird über den Strukturanker
`ytd-video-description-transcript-section-renderer` gefunden, **nicht** über
`aria-label="Transkript anzeigen"` (M10, Q4) |
| **Bereitschaft** | Das Werkzeug prüft selbst, ob das Panel offen ist — es vertraut **nicht** auf `settled` (M6). Das ist der teuerste Teil des Werkzeugs und der Grund, warum es ein eigenes Werkzeug ist und kein Rezept |
| **Kernannahme** | Der Transkriptinhalt ist über die Oberfläche zuverlässig erreichbar (M1). Wird sie widerlegt, geht das Inkrement zurück in die Spec — nicht in die Lückenliste |
| **Ohne** | neue Berechtigung, YouTube-API, Token, Abhängigkeit |
| **`allowEval`?** | **Eigene Entscheidung der Folge-Spec, hier nicht entschieden.** `browser_transcript` führt Extension-Code aus, keine Agenten-Auswertung — der Schalter aus `docs/19` gilt für `browser_eval` (Agentenkode in der Seite), nicht für Extension-Code. Ob das Folgewerkzeug hinter **einem eigenen** Schalter liegt, entscheidet `docs/32`; stilles Umgehen des `allowEval`-Gates wäre eine stille Umgehung einer Betreiberentscheidung und wird hier ausdrücklich **nicht** unterstellt. **Entschieden am 2026-11-11: kein eigener Schalter** (`docs/33-spurwahl.md`) |

Der Dateiname ist **vorläufig**: `docs/README.md` vergibt `NN` nach
Entstehungsreihenfolge, und bis diese Spec abgenommen ist, kann eine andere
Spec dazwischenkommen. Verbindlich ist der **Zuschnitt**, nicht die Nummer.

## Open questions

**Keine offenen.** Beantwortet vom Betreiber am 2026-11-11 — jede Frage mit
der angenommenen Empfehlung, jede Begründung aus der Messung:

**Q1 — Was ist der Zuschnitt?**
(a) *Rezept in der Werkzeugbeschreibung*: der Agent lernt aus
`browser_read`/`browser_click`, wie er das Transkript öffnet. Kein Code, kein
neues Werkzeug — der Weg aus M1 ist eine Abfolge von fünf vorhandenen
Aufrufen. (b) *Neues Werkzeug `browser_transcript`*: ein Aufruf, der das
Panel öffnet und die Segmente **strukturiert** zurückgibt (Zeitstempel +
Text je Segment, `offset`/`maxChars` wie bei `read`). (c) *Nichts*: das Thema
YouTube wird geschlossen, Roadmap-Zeile 17 wird gestrichen.
→ **(b), ein neues Werkzeug `browser_transcript`.** Die Begründung ist M6:
das Panel zu öffnen ist der teure Teil, und es ist der, der an der
Oberfläche hängt. Als Rezept müsste der Agent diese fünf Schritte selbst
zusammenbauen — inklusive des Wartens auf eine Seite, die sich als „ruhig"
ausgibt, obwohl sie noch gar nicht geladen ist. Genau diese Wartelogik gehört
in Code, nicht in eine Beschreibung, die ein Agent liest und errät. Und M2:
ein Textband ist kein Transkript; die Segmente mit Zeitstempel sind der
eigentliche Gegenstand.

**Q2 — Welche Sprache?**
Das Video bietet viele Spuren (M4: 31 beim ein englisches Erklärvideo-Video, 6 beim
Rick-Astley-Video, darunter `de` manuell, `en` manuell, `en` asr). Die
deutsche Oberfläche zeigte das Transkript auf Deutsch. (a) Originalsprache des
Videos. (b) Deutsch (die Übersetzungsspur). (c) wählbar, mit Parameter.
Zu bedenken: eine Übersetzungsspur ist ein **anderer Text** als das Original —
für Lernen ist das ein Unterschied, für „was sagt der Sprecher" keiner.
→ **(a), die Originalsprache des Videos.** Wer „was sagt der Sprecher" fragt,
will das Original; eine Übersetzung ist eine zweite Stimme. Für die
deutschsprachige Oberfläche heißt das: die deutsche Spur wird **nicht** gewählt,
auch wenn sie angeboten wird — die Auswahl richtet sich nach dem Video, nicht
nach der Oberfläche. Das ist im Werkzeug eine echte Entscheidung und deshalb
in der Folge-Spec ausdrücklich zu benennen (welche Spur als „Original" gilt).

**Q3 — Was zählt als „Videoinhalt erschließen"?**
(a) Nur der Text (Transkript). (b) Text **plus** Zeitbezug: der Agent nennt
„Minute 12: der Sprecher …" und kann dorthin springen. (c) zusätzlich
**Bild**: Screenshot an einem Zeitpunkt, damit der Agent auch das sieht, was
im Bild passiert (M9). (d) zusätzlich **Kapitel**: beim ein englisches Erklärvideo-Video
waren 6 Kapitel mit Zeit und Titel sichtbar (beobachtet, nicht gemessen —
keine M-Nummer, siehe `## Bekannte Lücken`).
→ **(b), Text + Zeitbezug.** M3 belegt, dass der Zeitbezug mehr ist als eine
Angabe: ein Klick auf einen Zeitstempel setzte `currentTime` von 0 auf 14. Mit
Zeitbezug kann der Agent nicht nur sagen, *was* gesagt wurde, sondern *wann* —
und das ist der Unterschied zwischen einem Transkript und einer Zusammenfassung,
die das Modell ohnehin liefert. (c) und (d) kommen **nicht** mit: Bild
braucht den Schalter `allowScreenshot` und einen zweiten Mechanismus zum
Positionieren (M9), Kapitel sind ein eigener Gegenstand mit eigener
Fehlerbehandlung (was, wenn ein Video keine Kapitel hat?). Beides ist
**ausdrücklich nicht ausgeschlossen**, sondern **nicht entschieden**.

**Q4 — Darf das Rezept die deutsche Oberfläche voraussetzen?**
M10: `aria-label="Transkript anzeigen"` ist deutsch. (a) Nein — der
Zuschnitt muss sprachunabhängig sein (Anker
`ytd-video-description-transcript-section-renderer`, nicht das `aria-label`).
(b) Ja — der Betreiber fährt eine deutsche Oberfläche, und ein sprachunabhängiger
Anker kostet einen Selektor mehr. (c) Das Rezept sucht **beides**: erst der
Strukturanker, dann der Text.
→ **(a), sprachunabhängig.** Der Anker
`ytd-video-description-transcript-section-renderer` ist ein Elementname, keine
Oberflächensprache, und kostet keinen Deut mehr als der `aria-label`. M10 hat
zudem gezeigt, dass der `aria-label` der *einzige* sprachabhängige Teil der
Kette ist — die Elementstruktur ist stabil. (c) ist damit **nicht** nötig: der
Strukturanker allein genügt, und ein zweiter Pfad wäre eine zweite
Wartelogik ohne Erkenntnisgewinn.

**Q5 — Wer macht die Zusammenfassung?**
Roadmap-Zeile 17 nennt „Zusammenfassungen". (a) Das **Modell des Agenten**
summiert den Transkripttext — im Projekt kommt kein Code dazu. (b) Ein
Werkzeug, das selbst zusammenfasst — dafür bräuchte es ein Modell im Repo
oder einen externen Dienst, beides außerhalb dieses Projekts. (c) Keine
Zusammenfassung; der Agent liefert Rohtext mit Zeitstempeln.
→ **(a), das Modell des Agenten.** (b) ist außerhalb dieses Projekts: ein
Modell im Repo wäre eine neue Abhängigkeit und ein Geheimnis-Risiko, ein
externer Dienst eine neue Berechtigung und ein fremder Datenabfluss. (c)
wäre (a) ohne das Versprechen: das Werkzeug liefert Segmente, das Modell
fasst zusammen. Der Unterschied zu (c) ist die **Zusage**, nicht der Code —
und eine Zusage gehört ins Projekt.

**Hinweis zur Reihenfolge:** Q1 geht voran, weil die Antwort den Zuschnitt der
übrigen Fragen festlegt: Ein neues Werkzeug, das „deutsches Transkript mit
Zeitstempeln und Kapiteln" liefert, ist etwas anderes als ein Rezept, das „das
Originaltranskript als Fließtext" liefert. **Entschieden wurde in dieser
Reihenfolge** (Q1 zuerst, Q2–Q5 danach).

## Risiken

- **YouTube ändert die Oberfläche.** Der Knopf, die Elementstruktur und der
  Panel-Aufbau sind Web-Innenleben. M1/M8/M10 beschreiben den Stand vom
  2026-11-11, nicht einen Vertrag. Jede Spec, die darauf baut, nennt den
  Stand und hat einen Fehlerpfad für „Button nicht gefunden".
- **Die Caption-API ist launisch.** M4 hat drei Versuche mit zwei
  Fehlschlagarten gezeigt. Sie kann
  morgen funktionieren — sie ist aber kein Vertrag, und wer sie nutzt, jagt
  YouTube-Änderungen hinterher.
- **Die Spät-Hydrierung (M6) ist der wahrscheinlichste Fehler im Betrieb.** Sie
  ist kein Fehler der Bridge, sondern der Seite; sie trifft aber jede
  Automatik, die „geladen" mit „fertig" verwechselt.
- **Die Oberflächensprache ist entschieden (Q4) — und bleibt trotzdem ein
  Risiko.** Der Strukturanker ist sprachunabhängig, aber er ist genauso ein
  YouTube-Internum wie der `aria-label`. Die Entscheidung nimmt nur die
  *Sprachabhängigkeit* heraus, nicht die *Änderungsgefahr*.
- **Ein YouTube-Token wäre ein Geheimnis im Repo.** Es ist hier bewusst
  ausgeschlossen; falls der Betreiber die innertube-Schnittstelle statt der
  Oberfläche will, ändert das diese Entscheidung — und braucht eine eigene
  Spec mit eigener Geheimnis-Regel.
- **„Originalsprache" ist eine Entscheidung, die man treffen muss** (Q2). Bei
  einem Video mit mehreren Spuren muss das Werkzeug *wissen*, welche die
  Originalspur ist — das ist kein Zufall, sondern eine Regel. Fällt sie falsch
  aus, liefert das Werkzeug die Übersetzung und behauptet, es sei das Original.

## Touch boundary

- **Anfassen:** `docs/31-youtube-recherche.md`, `docs/README.md` (die
  Registerzeile **und** der Abschnitt „## Recherche-Specs"), `docs/ROADMAP.md`
  (Tabellenzeile 17), `docs/PROJECT-STATE.md` (der Absatz zum Stand).
- **Nicht anfassen:** `bridge/*`, `extension/*` (kein `manifest.json`, kein
  `background.js`), `test/*`, `scripts/*`, `package.json`, `INSTALL.md`.
- Keine neue Abhängigkeit, kein Token, kein Geheimnis. Kein Netzverkehr aus
  dem Repo — die Messungen liefen über die Bridge des Betreibers, nicht über
  eine Skript-Abhängigkeit.

## Bekannte Lücken

Stand 2026-11-11, **nach** der Entscheidung Q1–Q5. Die Lücken sind dieselben
wie vor der Entscheidung — die Entscheidung hat sie nicht geschlossen, sie hat
sie nur benannt:

- **Nicht gemessen: andere Video-Hosts.** Nur youtube.com, nur die
  Watch-Seite, nur die deutsche Oberfläche, nur ein angemeldetes Konto.
- **Nicht gemessen: Live-Streams.** Dort gibt es kein Transkript-Panel in
  dieser Form; ungeprüft.
- **Nicht gemessen: Altersbeschränkung, privates Video, regionsgesperrte
  Inhalte.** Ob das Panel dort aufgeht, ist offen — und ob die
  Fehlerbehandlung „kein Transkript" sauber trennt, ebenso.
- **Nicht gemessen: YouTube-Shorts und die Mobilansicht.**
- **Nicht gemessen: das Verhalten bei Netzwerk-Timeouts und Werbung.**
- **Der Kapitel-Pfad ist belegt, nicht geprüft:** 6 Kapitel mit Zeit und Titel
  sichtbar, aber nie angeklickt. Kapitel sind nach Q3 **nicht entschieden**.
- **Der Screenshot-Pfad ist belegt, nicht geprüft:** ein Bild bei Minute 5,
  nicht die Serie. Bild ist nach Q3 **nicht entschieden**.
- **Nicht gemessen: die Regel, welche Caption-Spur die Originalspur ist.**
  Q2 entscheidet die Originalsprache, aber die M4-Messung protokolliert nur
  `de`/`en`/`manuell`/`asr` — **kein** Übersetzungsflag. Die Regel, nach der
  das Werkzeug die Originalspur erkennt, ist damit offen; sie gehört in die
  Folge-Spec.
- **Nicht gemessen: die Ziel-Tabelle wird von keinem Kriterium geprüft.**
  Kriterium 8 prüft die Folge-Spec-Tabelle, nicht die Tabelle in `## Ziel`.
  Ein Verschieben einer Entscheidung an der einen Stelle bliebe an den
  Kriterien grün (Review-Runde 3, O2).

## Review

### Runde 1, 2026-11-11 — `🔧 Fix these`, Blocker: ja (B1–B6)

Der Reviewer hat die Spec als **tragfähige neue Form** bestätigt: sie
beschreibt kein Verhalten, das es noch nicht gibt, sie hat keinen Produktcode,
und ihre Kriterien prüfen tatsächlich ein Dokument. Sechs Punkte waren
blocking:

- **B1 (Stufe 3, Proof nie grün):** `grep -cE '^\| [1-7] \|'` zählte die
  M1-Tabelle in `## Die Messungen` mit (5 heute, 12 nach der Stufe). Der Proof
  schneidet jetzt den Abschnitt `## Testing` heraus.
- **B2 (Kriterium 1 und 6):** die Messung lief bis zum Dateiende und damit
  durch `## Review` und `## Log` — die Abschnitte, in denen der Orchestrator
  später selbst schreibt. Sie schneidet jetzt bei `## Risiken` ab.
- **B3 (M2 nicht reproduzierbar):** „`browser_read` ohne Einschränkung:
  30 966–31 011 Zeichen" widersprach `docs/22` (Default **20 000**). Die Zahl
  galt für `browser_read({maxChars: 100000})` — der Aufruf steht jetzt da, und
  die Folge (ein `read` ohne Parameter liefert ein *abgeschnittenes*
  Transkript) ist genannt.
- **B4 („vier Schritte" statt fünf):** M1, Q1 (zwei Stellen) und die
  Stufe-2-Anweisung sprachen von vier Aufrufen — der zweite Klick (auf den
  Transkript-Knopf) fiel durch, und ein nach Vorschrift geschriebenes Rezept
  wäre am eingeklappten Panel hängen geblieben, also genau der Fehler aus M8.
- **B5 (Stufe 3 konstruktionsbedingt rot):** Kriterium 1 verlangt
  `status: active` (Stufe 4) und Kriterium 3 einen Commit (Stufe 4). Der
  Umsetzer trägt sie jetzt als „wartet auf Stufe 4" ein, statt sie als Rot zu
  melden.
- **B6 (Stufe 1 war eine No-Op-Stufe):** die Belegzeilen waren bereits
  gesetzt; die Stufe ist jetzt als **Nachweis** markiert statt als Arbeit.

**Übernommen: alle sechs.** Dazu die tragenden Minor-Befunde: der
`<base>`-Platzhalter in Kriterium 3 (jetzt festgenagelt, plus
`git status --porcelain` für untracked Dateien), die Touch boundary im
Kriterium 3 (jetzt vollständig: `scripts`, `package.json`, `INSTALL.md`),
Kriterium 4 (`active` statt „active oder proposed"), Kriterium 5 (prüft jetzt
die **Tabellenzeile** 17 statt nur den Dateinamen), Kriterium 7 (Dateiname als
Muster, weil er vorläufig ist), M8s Überschrift (`includeHidden` aus
`docs/09` ergänzt), M6 als Bestätigung von `docs/14:193` statt als Bridge-
Verdacht, `allowEval` als offene Entscheidung der Folge-Spec, die doppelte
Q-Tabelle (jetzt eine mit Verweis), `docs/32-…` als vorläufiger Dateiname, das
Absprache-Protokoll zu den Kriterien im `## Log`, und die
Recherche-Spec-Klasse in `docs/README.md`.

**Nicht übernommen:** nichts.

### Runde 2, 2026-11-11 — `🔧 Fix these`, Blocker: ja (B7–B8)

Der Reviewer hat **jeden** Beweisbefehl ausgeführt, statt die Prosa zu lesen.
Ergebnis: **B1, B2, B4 und B6 sind vollständig behoben und durch ausgeführte
Beweise belegt** — B1 und B2 waren die heiklen, und beide halten. B3 war im
Kern behoben, hat aber mit der Korrektur einen neuen Fehler eingebaut; B5 war
halb behoben.

- **B7 (neu, aus der B3-Korrektur):** der ergänzte Satz „(ohne
  `truncated`-Anzeige, weil die Antwort selbst die Grenze ist)" widersprach
  `docs/22` und `extension/background.js:2424` (`truncated` heißt
  `offset + chars < totalChars`). Bei 20 000 von 30 966 Zeichen **erscheint**
  die Anzeige. Die Spec widersprach sich selbst (zwei Zeilen weiter nennt sie
  sie korrekt). Behoben: der Satz nennt jetzt `truncated: true` mit Verweis auf
  `docs/22`.
- **B8 (Kriterium 4 fehlte in der Stufe-4-Liste):** Kriterium 4 verlangt die
  Status-Spalte `active` in der Registerzeile — die setzt Stufe 4 genauso wie
  Kriterium 1. Der Umsetzer hätte entweder eine Falschmeldung oder eine
  erfundene Bestätigung produziert. Behoben: die Liste nennt jetzt **drei**
  Kriterien (1, 3, 4) und vier statt fünf vollständig gefahrene.

Dazu die tragenden Minor-Befunde: der doppelte Absatz „Werkzeuggrenzen" in
`## Testing` (entfernt), die Touch boundary nennt den tatsächlichen Zugriff
(der Orchestrator hat einen ganzen Abschnitt in `docs/README.md` geschrieben),
Stufe 4 verbietet jetzt ausdrücklich, `## Open questions` umzuschreiben
(dort hängen Kriterium 1 und 6), Kriterium 4 und 6 schneiden jetzt auf den
jeweiligen Abschnitt (Kriterium 6 zählte sich sonst selbst mit), M6 als
Bestätigung von `docs/14:193`, „ohne neues Werkzeug **für den Zugriff**"
(statt des Widerspruchs zur Q1-Tabelle), „drei Versuche, zwei
Fehlschlagarten" statt „zwei Fehlschläge", die Übersetzungs-Ableitung in Q2
als **abgeleitet** statt gemessen, die M-Nummer in der Wiederholungszeile, der
Tippfehler „dergenerierte", die Abschnittsfolge-Zählung (vier statt zwei
Treffer) und die Stufenfolge „1 (Nachweis) → 2 → 3 → 4".

**Übernommen: alle.** **Nicht übernommen: nichts.**

### Runde 3, 2026-11-11 — `✅ Ship it`, Blocker: nein

Der Reviewer hat **jeden** Beweisbefehl ausgeführt und B1–B8 als behoben
bestätigt — B1, B2 und B8 waren die heiklen. Kriterium 8 tut, was es sagt: es
prüft den **Inhalt** der Entscheidungen, auch mit einem ehrlich negativen
Befehl, und die `sed`-Schnitte sind immun gegen die spätere Orchestrator-
Arbeit an `## Review` und `## Log` (geprüft: `## Open questions` und
`## Die Folge-Spec` liegen beide **vor** `## Risiken`).

**Übernommen (Ein-Wort-Korrekturen in Stufe 4):** M1 „die sieben Kriterien"
⇒ „acht"; M2 „der ganze Text zählt 6" ⇒ „7" (der Dev-Plan zitiert das Format
zweimal); M3 „findet vier Zeilen" ⇒ „fünf" (die Stufe-4-Warnung kam in
Runde 2 dazu).

**Übernommen (Follow-ups, die dieselben Stellen betreffen):** M5 der Wortlaut
der Q3-Zeile in der Ziel-Tabelle (jetzt „nicht entschieden — nicht
ausgeschlossen, nicht zugesagt", wie in `## Non-goals` und der Folge-Spec-
Tabelle), M7 die Stufe-4-Warnung nennt jetzt **alle sechs** gepinnten
Formulierungen von Kriterium 8 (vorher vier — genau die beiden Zeilen, die der
Orchestrator beim „Prosa beschreibend machen" umschrieben hätte), M8 der
Codeverweis `extension/background.js:2424` (die Zuweisung, nicht der
Kommentar), M4 der `allowEval`-Hinweis in „Was daraus folgt" (der Zeitbezug
geht per Klick, nur der **nicht entschiedene** Bildpfad braucht `eval`),
M6 die Beschreibung des `sed`-Wegs in Stufe 3 (nur Kriterium 8 schreibt in
eine Datei), M9 die Begründung des Datei-Umwegs.

**Bewusst offen gelassen:** O2 — die Ziel-Tabelle wird von Kriterium 8 **nicht**
geprüft (es prüft die Folge-Spec-Tabelle). Wer Q2 dort änderte, bliebe nach
den Kriterien 1, 6, 7 und 8 grün. Der Aufwand wäre eine Zeile, der Nutzen
gering, und der Betreiber hat die Entscheidungen abgenommen — der Log hier
hält sie fest. Als bekannt benannt, nicht verdeckt.

### Runde 4 — noch keine

## Log

Je Befund eine Zeile (aus `CONTRIBUTING.md`, Schritt 4).

- **B1–B6: übernommen** (Review-Runde 1) — alle sechs Blocker, siehe oben.
- **B7–B8: übernommen** (Review-Runde 2) — beide Blocker, siehe oben.
- **Minor-Befunde der Runde 1: übernommen** — mit einer Ausnahme: die
  Kapitel-Beobachtung wird **nicht** als M11 geführt, sondern bleibt
  ausdrücklich „beobachtet, nicht gemessen" in `## Bekannte Lücken`; der
  Verweis „M-Messung" in `## Non-goals` ist raus.
- **Minor-Befunde der Runde 2: übernommen** — alle tragenden; die drei
  **Clarifications** (O1–O3) sind mitentschieden: die Registerzeile in
  `docs/README.md` und der Absatz in `docs/PROJECT-STATE.md` werden **mit**
  committet und stehen deshalb in der Touch boundary; Kriterium 3 prüft beide
  Dateien mit, weil `git diff` sie sonst nicht sieht.
- **Q1–Q5: beantwortet** vom Betreiber am 2026-11-11, je mit der angenommenen
  Empfehlung; die Begründungen stehen bei den Fragen und in
  `## Die Folge-Spec`.
- **Kriterium 8 (neu, aus der Betreiberfrage vom 2026-11-11):** der
  Betreiber fragte, ob die Kriterien zu seinen Entscheidungen passen. Die
  ehrliche Antwort war: **die Form ja, der Inhalt nein** — Kriterium 1 und 6
  prüfen nur, dass Q1–Q5 markiert sind, nicht was sie sagen. Kriterium 8
  schließt die Lücke mit sechs Content-Checks auf die Folge-Spec-Tabelle
  (Umfang, Sprache, Strukturanker, Ausschluss des deutschen `aria-label`,
  Zusammenfassung durch das Modell, Kapitel und Bild ausdrücklich offen).
  Damit ist **jede** deiner fünf Entscheidungen durch einen Befehl abgesichert,
  nicht nur ihre Gegenwart.
- **Abweichung vom Dev-Plan (Code-Review, 2026-11-11):** der Plan sah „Stufen
  1–3 = Umsetzer, Stufe 4 = Orchestrator" vor. Ausgeführt hat **der
  Orchestrator alle vier** — die Stufen sind reine Dokumentarbeit an dieser
  einen Datei, und die Orchestrator-Arbeit an den drei Begleitdateien brauchte
  dieselbe Sitzung. Kein Produktcode, kein Umsetzer-Konflikt, ein Schreiber im
  Arbeitsbaum. Im Dev-Plan steht das jetzt so, und jede Stufe trägt ihren
  `**Completed 2026-11-11**`-Marker.
- **Code-Review, Blocker M1:** die Spec stand auf `active`, während die Proofs
  der Stufen 2 und 3 auf 0 standen (kein Wiederholungsprotokoll, kein
  Abkriterien-Protokoll). Behoben: beide Stufen sind **ausgeführt**, nicht
  gestrichen — `## Testing` trägt jetzt zehn `**Wiederholung (M<n>):**`-Zeilen
  und die achtzeilige Protokolltabelle mit den beobachteten Ergebnissen vom
  2026-11-11. Der Proof von Stufe 2 wurde auf das Tabellenformat angepasst
  (`^| \*\*Wiederholung (M`).
- **Code-Review, Blocker M2:** Kriterium 4 war mit seinem eigenen Beweisbefehl
  falsch-rot — die Backslashes vor den Backticks sind in `grep` (BRE) keine
  Escapes und in Markdown-Code-Spans sowieso nicht. Behoben: die Backslashes
  sind raus, beide Befehle liefern 1 und 1.
- **Minor-Befunde des Code-Reviews: übernommen** — die ROADMAP-Spalte „Größe"
  führt wieder eine Größe (`mittel`) statt eines Status; der Reihenfolge-Hinweis
  bei Q1 trägt jetzt; die PROJECT-STATE-Formulierung zu den Tabs ist ehrlich
  („in Agenten-Tabs wurde geklickt, die danach geschlossen wurden"); die
  README-Regel nennt die erste Recherche-Spec beim Namen.
- **Kriterien dem Betreiber vorgelegt:** Q1–Q5 am 2026-11-11 mit
  `ask_user`; die Abnahme-Kriterien sind aus den Q-Antworten entstanden.
  **Der Betreiber fragte am 2026-11-11 zuerst nach ihrer Passung zu seinen
  Entscheidungen** — statt sie blind zu bestätigen — und diese Frage deckte
  die Lücke auf, aus der Kriterium 8 entstand. **Die acht Kriterien sind ihm
  danach ausdrücklich vorgelegt und von ihm abgenommen worden**
  („Ja — die acht Kriterien so abnehmen"), mit der Auflage, dass der Inhalt
  der Entscheidungen geprüft wird, nicht nur ihre Gegenwart.
- **Kapitel und Bild: nicht entschieden** (Q3). Bewusst offen gelassen und
  als solches in `## Non-goals` und `## Bekannte Lücken` benannt, damit sie
  nicht als vergessen gelesen werden.
