---
description: Teil 2 von browser_transcript — die Sprachspur aus der Spurendatei: Originalspur über den Original-Audiotrack, die en/de-Regel des Betreibers, Wahl im Untertitel-Menü nach dem Namen aus dem Modell, Lesen der signierten api/timedtext-Adresse mit Zeitstempeln; danach Spur und Abspielposition zurückstellen.
status: active
---

# `browser_transcript`, Teil 2: die Sprachspur

`docs/32-transkript-werkzeug.md` liest das YouTube-Transkript aus dem Panel.
Diese Spec sorgt dafür, **dass es die richtige Spur ist** — und dafür, dass der
Text aus der **Spurendatei** kommt statt aus dem Panel.

**Diese Spec ist der zweite von zwei Teilen.** Sie entstand am 2026-11-12
durch **Teilung** der gemeinsamen Fassung, nachdem das Spec-Gate sie in der
dritten Runde blockiert hatte (`CONTRIBUTING.md`, Schritt 4). Der erste Teil ist
`docs/32-transkript-werkzeug.md`; **er ist Voraussetzung** — das Werkzeug, die
Werkzeugliste, `offset`/`maxChars` und die Fehlerklasse stehen dort.

**Am 2026-11-12 neu geschnitten.** Die erste Fassung dieser Spec wollte die
Spur im Menü setzen und das **Panel neu bauen**. Der Live-Lauf hat das
widerlegt: das Panel folgt der Spur nicht, auch nicht über ein Neuladen der
Seite (`## Messlauf der ersten Fassung`, Kriterium 9). Der Betreiber hat am
selben Tag entschieden, Teil 2 auf die **Spurendatei** umzuschreiben.

**Stand 2026-11-12: `active`.** M18 (die Spurendatei ist über `performance`
nicht beobachtbar) hat diese Spec live durchfallen lassen; `docs/34` hat die
Herkunft der Adresse ersetzt (Mitschnitt der Extension). Mit diesem Weg sind
**beide Live-Kriterien grün**: `v=<video-en>` → englische Segmente, `en`/`en`;
`v=<video-ja-2>` → japanische Segmente, `ja`/`ja`. 736 Tests grün.

## Ziel

- **Der Text kommt aus der Spurendatei, nicht aus dem Panel.** Die
  `api/timedtext`-Adresse, die der Player selbst holt, trägt **genau die Spur,
  die der Player benutzt**, mit Zeitstempeln für die ganze Spur (M13). Das
  Panel trägt die Sprache seiner Ladung, nicht die der Spur (M14).
- **Die Spur ist die Originalspur des Videos** — die, auf die der
  **Original-Audiotrack** zeigt (M2). Nicht die, die YouTube beim Laden
  nahelegt (M4).
- **Die Regel des Betreibers (2026-11-11), wörtlich:** „Standard sollte immer
  die Originalspur sein, wenn sie nicht englisch oder deutsch ist, dann die
  englische Übersetzung.“ **Konkretisiert am 2026-11-11:** ist die
  Originalspur `en` oder `de`, gilt sie; sonst gilt die **englische Spur**,
  wenn das Video eine hat; **gibt es keine englische Spur**, nimmt das
  Werkzeug **das Original** und nennt die Sprache in der Antwort.
  Die „englische Übersetzung“ ist damit als **Spur** umgesetzt, nicht als
  YouTubes Übersetzungsfunktion — die existiert zwar (M9), führt aber nur über
  **lokalisierte Menünamen** und würde die Sprachunabhängigkeit aufgeben.
- **Das Werkzeug ist sprachunabhängig.** Kein deutscher `aria-label`, kein
  `hl`-abhängiger Selektor; der Menüeintrag wird über den **Namen aus dem
  Modell** gefunden (M5), Einträge mit `>>` sind ausgeschlossen.
- **Der Weg, in dieser Reihenfolge:** Modell lesen → Zielspur nach der Regel
  bestimmen → Spur im Untertitel-Menü setzen → Player **einmal springen**
  lassen, damit er die Spurendatei holt → die signierte Adresse aus dem
  **Mitschnitt der Extension** nehmen (`docs/34`) → JSON3 lesen → antworten →
  **vorherige Spur und Abspielposition zurückstellen** (Entscheidungen
  2026-11-12).
- **Die Antwort nennt gewählte und gelieferte Sprache.**
  `requestedLanguage` ist der `languageCode` der Zielspur;
  `deliveredLanguage` ist der `lang`-Parameter **der gewählten Adresse** —
  messbar, nicht geraten (M13). Erwartet ist **Gleichheit** mit
  `requestedLanguage`; eine Abweichung wäre ein Fehler und keine stille
  Auskunft. Fehlt der Parameter, ist das ein benannter Fehler, kein `null`.
- **Die signierte Adresse verlässt die Erweiterung nicht.** Sie ist ein
  Zugangsmittel für die Sitzung des Betreibers: nicht in der Antwort, nicht in
  einem Log, nicht in einer Fehlermeldung (M13).
- **Kein stiller Rückfall auf das Panel.** Fehlt die Spurendatei, ist das ein
  **benannter Fehler**; ein Rückfall würde die falsche Sprache liefern und
  wie ein Erfolg aussehen (`## Messlauf der ersten Fassung`).
- **Keine neue Berechtigung, keine Abhängigkeit, kein Token.**

## Non-goals

- **Kein zweites Werkzeug.** Die Erweiterung sitzt in `browser_transcript`;
  die Antwort bekommt Sprachfelder, kein neues Werkzeug.
- **Kein YouTube-Übersetzungsweg** („Automatisch übersetzen → Englisch", M9).
  Er führt ausschließlich über lokalisierte Menünamen und widerspräche dem
  Ziel „sprachunabhängig". Deshalb bleibt für ein japanisches Video das
  japanische Original — mit genannter Sprache.
- **Keine Kapitel, kein Bild, keine anderen Video-Hosts.** Wie Teil 1.
- **Kein Log-Eintrag.** Wie Teil 1: `bridge/hub.mjs` bleibt unangetastet —
  die signierte Adresse darf ihn nicht erreichen (M13).
- **Keine Spracherkennung.** `deliveredLanguage` wird **gelesen** (aus der
  Adresse), nicht geraten; eine Heuristik über den Text gibt es nicht.
- **Keine Übersetzung im Werkzeug.** Übersetzt wird nicht; welche Spur gilt,
  entscheidet die Regel in `## Ziel`.

## Die Entscheidungen des Betreibers

| Datum | Frage | Entscheidung |
|---|---|---|
| 2026-11-11 | Wie die Originalspur erkennen? | **über den Original-Audiotrack** (M2) — nicht über ein Sprachfeld, das es nicht gibt |
| 2026-11-11 | Wie eine gewünschte Spur erzwingen? | **im Untertitel-Menü wählen** (M5) — die innertube-Schnittstelle kann keine Sprache wählen (M6) |
| 2026-11-11 | Was, wenn das Original weder Englisch noch Deutsch ist? | **die englische Spur suchen** — gibt es keine, das **Original nehmen und die Sprache nennen** |
| 2026-11-11 | Eigener Schalter für das Werkzeug? | **nein** — Extension-Code, keine Agenten-Auswertung; der `allowEval`-Schalter aus `docs/19` gilt für `browser_eval` |
| 2026-11-12 | Woher kommt der Text? | **aus der Spurendatei** (`api/timedtext`), **nicht** aus dem Panel (M12–M14) |
| 2026-11-12 | Spur nach dem Lesen? | **vorherige Spur wiederherstellen** |
| 2026-11-12 | Player bewegen? | **ja, springen; Position danach zurückstellen** |
| 2026-11-12 | Welche Sprache meldet die Antwort? | **beide**: `requestedLanguage` (gewählt) und `deliveredLanguage` (aus der Adresse gelesen, M13) |

## Die Messungen

Alle am 2026-11-11/12, live, im Firefox-Profil des Betreibers (YouTube
Premium, deutsche Oberfläche `hl=de`, angemeldet). Video-IDs:
`aircAruvnKk` (ein englisches Erklärvideo, **Original: Englisch**), `wKv-g1uEoDY`
(**Original: Japanisch**), `dQw4w9WgXcQ` (ein Musikvideo, **Original: Englisch** —
der *Player*-Untertitelknopf meldet „Untertitel nicht verfügbar", **das
Transkript-Panel öffnet aber** und liefert 23 Segmente, `docs/31`, M7).

### M1 — Das Caption-Datenmodell markiert „Original" nicht

*Beleg: `browser_eval` auf `v=<video-en>`, 2026-11-11/12.*

`captionTracks` trägt **kein** Feld, das Original oder Übersetzung
unterscheidet. Es gibt nur `vssId` — und das entscheidet es **nicht**:

| vssId | Beobachtung |
|---|---|
| `a.xx` | automatisch erzeugt (ASR) |
| `.xx` | manuell hochgeladen **oder** Übersetzung — **nicht unterscheidbar** |

**Gemessen am ein englisches Erklärvideo-Video:** 31 Spuren, davon 30 mit Punkt und eine
`a.en`. Die Spur, auf die der Original-Audiotrack zeigt, ist **Index 6** und
trägt **`.en`** — also einen Punkt, obwohl das Video englisch ist. **Ob diese
Spur hochgeladen oder übersetzt ist, ist am Prefix nicht erkennbar** (das ist
genau der Befund). Wer nach dem Prefix filtert, kommt hier falsch heraus.

### M2 — Die Originalspur findet man über den Original-Audiotrack

*Beleg: `browser_eval` auf `v=<video-en>` und `v=<video-ja>`, 2026-11-11/12.*

```
audioTracks[ der Eintrag ohne ".3"-Suffix ].defaultCaptionTrackIndex
          →  Index in captionTracks  →  languageCode
```

- ein englisches Erklärvideo: der Eintrag ohne `.3`-Suffix ist **`en-US.4`** →
  `defaultCaptionTrackIndex` = **6** → Spur 6 ist `en`.
- Japanisch: der einzige Eintrag (kein `.3`-Suffix) → Index **0** → `ja/asr`.

**Der Original-Audiotrack ist an der ID erkennbar:** die
Übersetzungs-Audiotracks heißen `de.3`, `fr.3`, `es.3`, `ar.3`, `hi.3`,
`ru.3`, `th.3`, `uz.3` — **alle mit Suffix `.3`** —, der Original-Audiotrack
heißt **`en-US.4`**.

**Nachtrag 2026-11-12 (live): gibt es genau *einen* Audiotrack, ist das der
Original.** Auf `v=<video-ja>` lieferte das Modell **einen** Eintrag, dessen
`audioTrackId` **fehlt** (im kopierten Modell `""`), und eine ASR-Spur
`ja|a.ja`. Die `.3`-Regel fand damit null Kandidaten und das Werkzeug brach
mit „Originalspur nicht eindeutig" ab, obwohl es nichts zu unterscheiden gab.
Bei mehreren Tracks bleibt die Regel unverändert; mehrere Kandidaten ohne
`.3`-Suffix bleiben ein benannter Fehler. Das gilt auch für den Fall „ein
Track, der `.3` trägt": auch dann ist er der Original — einen einzelnen
Übersetzungstrack ohne Original gibt es nicht.

**Zweiter Nachtrag 2026-11-12 (live): fehlt der `defaultCaptionTrackIndex`
und tragen mehrere Spuren dieselbe Sprache, gilt die Rangfolge der englischen
Spur** — manuelle vor ASR, zwei manuelle ⇒ benannter Fehler. Gemessen auf
`v=<video-ja-2>`: ein Audiotrack ohne ID und ohne Index, zwei `ja`-Spuren
(`.ja` manuell, `a.ja` ASR). **Verschiedene** Sprachen ohne Index bleiben ein
benannter Fehler: dort wäre jede Wahl geraten.

### M3 — Der Audiotrack-**Index** ist nicht stabil

*Beleg: zwei `browser_eval` auf `v=<video-en>`, 2026-11-11.*

`defaultAudioTrackIndex` war beim selben Video einmal **7**, einmal **8** — die
Reihenfolge der `audioTracks` schwankt zwischen Abrufen. **Nur die
`audioTrackId` ist stabil, niemals der Index.** Wer den Index benutzt,
liefert bei jedem zweiten Abruf die falsche Spur.

### M4 — Das Panel zeigt nicht die Originalspur

*Beleg: `browser_read`, `browser_eval`, Player-Einstellungen auf
`v=<video-en>` und `v=<video-ja>`, 2026-11-11.*

Beim **englischen** Video zeigte das Panel **deutschen** Text („Das ist eine
Drei."), obwohl der Player „Untertitel: Englisch" meldete und die Originalspur
Index 6 (`en`) ist. Beim **japanischen** Video zeigte es **japanischen** Text.

Das ist YouTubes automatische Übersetzung (auch der Titel war übersetzt:
„Aber was ist ein neuronales Netz?"). **Konsequenz: „das Panel lesen" liefert
nicht die Originalspur — die Spur muss gesetzt werden.**

### M5 — Das Untertitel-Menü listet die Spuren, aber nach Namen

*Beleg: `browser_click`/`browser_eval` auf die Player-Einstellungen,
`v=<video-en>` und `v=<video-ja>`, 2026-11-11.*

Der Weg: `.ytp-settings-button` → Menüeintrag „Untertitel" → `.ytp-panel-menu`.
Beim ein englisches Erklärvideo-Video **33 Einträge** („Aus", 31 Sprachen, „Automatisch
übersetzen"), jeder ein `.ytp-menuitem` mit dem Sprachnamen als `innerText`.

**Der Index ist kein Spur-Index:** „Aus" steht vorn und verschiebt alles um
eins. Und beim **japanischen** Video stehen **zwei** Einträge mit demselben
Namen im Menü: „Japanisch (automatisch erzeugt)" und „Japanisch (automatisch
erzeugt) >> …" (der zweite ist die Übersetzungswahl). **Ein Vergleich auf
Teilstrings findet zwei Treffer und muss dann abbrechen** — deshalb: exakter
Vergleich auf `innerText.trim()`, und Einträge mit `>>` sind **ausgeschlossen**.

### M6 — Die innertube-Schnittstelle kann keine Sprache wählen — korrigiert

*Beleg: `browser_eval` mit `fetch` auf `v=<video-ja>`, 2026-11-12;
Gegenprobe und Korrektur im `## Messlauf der ersten Fassung`, 2026-11-12.*

`POST /youtubei/v1/get_transcript` antwortet mit **HTTP 400
`Precondition check failed`** (drei Varianten am 2026-11-12, dazu eine
Gegenprobe mit den **originalen** `params`, die dasselbe 400 liefert). Die
Schnittstelle ist damit **kein** Weg zur Spur. Die Spurwahl müsste über die
Oberfläche laufen.

**Korrektur am 2026-11-12.** Der erste Satz dieser Messung lautete: die
`getTranscriptEndpoint.params` enthielten „nur die Video-ID und den
Panel-Typ — **keine Sprache**". Das war **falsch**. Sie enthalten eine
Sprache, nur **verschachtelt und URL-kodiert**: der äußere Base64-Blob trägt
den inneren `CgASAmRlGgA%3D`, und erst dessen Protobuf-Feld 2 nennt `de`.
Messlauf, Befund 3 hat die Kette wörtlich. Die Schlussfolgerung bleibt
dieselbe, der Grund ist jetzt ein anderer.

### M7 — Die Spurwahl im Menü ist als **Bedienung** belegt, als **Wirkung** nicht ⚠️

*Beleg: `browser_click` auf den Menüeintrag, `browser_eval` auf den Paneltext,
`v=<video-en>` und `v=<video-ja>`, 2026-11-11.*

- Der Eintrag „Englisch" lässt sich anklicken; die Player-Anzeige wechselt
  danach auf „Untertitel: **Englisch**".
- **Das Transkript-Panel blieb trotzdem deutsch.** Der Paneltext änderte sich
  **nicht**.
- Beim japanischen Video: „Automatisch übersetzen → Englisch" gewählt, die
  Anzeige wechselte auf „Japanisch (automatisch erzeugt) **>> Englisch**" —
  **das Panel blieb japanisch**, und im Datenmodell erschien **keine** englische
  Spur (`captionTracks` blieb bei 1 Eintrag).

**Das ist die Kernannahme, und sie ist offen.** Zwei Erklärungen sind möglich,
und die Messung entscheidet zwischen ihnen:

1. **Der Panel liest beim Öffnen neu** (aus `getTranscriptEndpoint`, der in
   `ytInitialData.engagementPanels` steht) und folgt dabei der **aktuellen**
   Spurauswahl. Dann wirkt der Neuaufbau — aber nur, wenn er **nach** dem
   Setzen der Spur passiert (damals Stufe 3 der ersten Fassung).
2. **Der Panel liest die Daten, die beim Laden der Seite entstanden sind.**
   Dann ändert kein Neuaufbau etwas, und die Spurwahl ist wirkungslos.

Gegen (1) spricht M6: nach der Korrektur tragen die `params` des Endpoints
eine **feste** Sprache (die der Oberflächensprache) — der Panel-Inhalt hängt
also nicht an der Spurauswahl, und welcher Track beim Übersetzen gelesen wird,
bleibt unbekannt. **Deshalb war M7 ein Live-Kriterium (damals Kriterium 9,
heute die Kriterien 12 und 13) und kein Test.**

**Nachtrag 2026-11-12: Erklärung (1) ist widerlegt.** Ein Neuaufbau des Panels
hilft nicht — gemessen im `## Messlauf der ersten Fassung`.

### M8 — Der Player-Track und der Panel-Track sind zwei Dinge

*Beleg: Gegenprobe zu M7 auf `v=<video-en>`, 2026-11-11.*

Die Originalspur (`en`, Index 6) im Untertitel-Menü gewählt → die
Player-Anzeige meldet „Untertitel: Englisch", **das Panel bleibt deutsch**.
Damit ist belegt: der Player-Track steuert das Panel **nicht**.

### M9 — „Automatisch übersetzen" ist eine Funktion, keine Spur

*Beleg: `browser_click` auf den Menüpunkt, `v=<video-ja>`, 2026-11-11.*

Der Menüpunkt öffnet eine Liste von **156 Zielsprachen**. Er ist **nicht**
dasselbe wie die Spurwahl, sondern YouTubes Übersetzungsfunktion. Beim
japanischen Video ist das der **einzige** Weg zu einer englischen Fassung —
denn es existiert keine englische Caption-Spur. **Diese Spec baut ihn nicht**
(siehe `## Non-goals`).

### M10 — Die gelieferte Sprache ist im DOM nicht feststellbar

*Beleg: `browser_eval` auf `v=<video-en>` mit offenem Panel (133 Segmente),
2026-11-12.*

- `transcript-segment-view-model` trägt **kein** `lang`-Attribut — nur `class`
  und `style`.
- Die Elternkette (`div.ytwTimelineItemViewModelContentItems` →
  `timeline-item-view-model` → … → `yt-item-section-renderer`) trägt **kein**
  `lang`, `data-lang` oder `content-language`.
- Das Panel: `panel.outerHTML.indexOf('lang=')` ⇒ **−1**; die Suche nach
  `[lang], [data-lang], [content-language]` liefert **0** Treffer.
- `ytInitialData.engagementPanels` enthält **kein** `languageCode`, `lang`
  oder `hl`.

**Ergebnis:** die Antwort kann die gelieferte Sprache **nicht** behaupten. Sie
nennt die **gewählte** (`requestedLanguage`) und lässt `deliveredLanguage`
`null`.

**Nachtrag 2026-11-12:** im **DOM** bleibt das blind — das gilt weiter. Die
Sprache steht aber in der **Adresse** der Spurendatei (M13), und von dort
liest `deliveredLanguage` sie. Das `null` beschreibt nur noch den Panel-Weg,
der nicht mehr gebaut wird.

### M11 — Die Container-Pfade sind Vermutung, nicht Beleg

*Beleg: `browser_eval` auf `v=<video-en>`, 2026-11-12.*

Nur **`ytplayer.bootstrapPlayerResponse`** ist gemessen. `ytplayer.response`,
`ytInitialPlayerResponse`, `ytplayer.config.args.player_response` und
`…raw_player_response` sind **Kandidaten**, und der Fall „Container ist ein
JSON-String" ist nicht abgedeckt. Deshalb: Kandidatenliste statt fest
verdrahtetem Pfad, und die Antwort nennt den **getroffenen** Container in
`source`.

### M12 — Der Overlay im Player ist lesbar, aber sprachlich unzuverlässig

*Beleg: `browser_eval` auf `v=<video-en>` und `v=<video-ja>`, 2026-11-12.*

`div.ytp-caption-window-container` → `.caption-window` →
`.caption-visual-line` → `span.ytp-caption-segment`. Der Text steht im DOM,
ohne Shadow-DOM, ohne Leinwand.

- Auf `v=<video-en>`: Spur „Englisch“ → `It's sloppily written and rendered
  at an extremely low resolution of 28x28 pixels,`; Spur „Thailändisch“ →
  `อย่าง 3 รูปนี้ …` Der Overlay folgt dort also der **Spur**.
- Auf `v=<video-ja>` mit gewählter Originalspur `ja`: **deutscher** Text
  („die Grundlagen der japanischen Sprache kennen“) — **Ursache ungeklärt**.

Dazu: der Overlay trägt immer nur die **aktuelle** Zeile, und
`video.textTracks` ist leer (**0**) — die Cues liegen nicht im TextTrack-API.
**Ergebnis: kein Träger für ein Werkzeug.**

### M13 — Die Spurendatei trägt die ganze Spur, mit Zeitstempeln

*Beleg: `browser_eval` mit `fetch`, `v=<video-en>` und `v=<video-ja>`,
2026-11-12.*

Der Player lädt die Untertitel als `api/timedtext`-Anfrage; die Adresse steht
in `performance.getEntriesByType('resource')`. Mit `&fmt=json3` liefert sie die
**ganze** Spur:

| Video | Adresse | Ergebnis |
|---|---|---|
| `aircAruvnKk` | `lang=en` | HTTP 200, 46 010 Bytes, **286 Cues**, 18 145 Zeichen; erster `4s: This is a 3.`, letzter `1105s` |
| `wKv-g1uEoDY` | `lang=ja` | HTTP 200, 163 963 Bytes, **413 Cues**; erster `0s`, letzter `1228s` |

**Die Adresse ist signiert.** Die `baseUrl` aus dem Player-Response liefert
weiter **0 Bytes** (M4/M5 erneut bestätigt — es fehlt die Signatur); nur die
Adresse, die der Player selbst geholt hat, trägt. Ebenso gescheitert: dieselbe
Anfrage an `/youtubei/v1/get_transcript` mit umgeschriebenen `params` (HTTP
400, Gegenprobe mit den Original-`params` ebenfalls 400).

**Folge:** das Werkzeug muss die Spur **setzen** und den Player **zum Holen
bringen**, bevor es die Adresse lesen kann.

### M14 — Die Panel-`params` tragen `(kind, language)` und werden beim Laden gesetzt

*Beleg: `browser_eval` auf beiden Videos, 2026-11-12.*

Der innere, URL-kodierte Blob der `getTranscriptEndpoint.params` ist Protobuf:

| Video | Feld 1 | Feld 2 |
|---|---|---|
| `aircAruvnKk` | `""` (leer) | `de` |
| `wKv-g1uEoDY` | `asr` | `ja` |

Die Seite wählt also beim Laden „die Spur in der Oberflächensprache, **wenn es
eine gibt** (hier die manuelle deutsche Übersetzung), sonst die Standardspur“.
Das erklärt den Messlauf vollständig: das Panel trägt nicht die Spur, sondern
diese Ladungs-Wahl.

### M15 — Das Cue-Format ist nicht einheitlich

*Beleg: dieselbe Messung wie M13.*

Die `ja`-Cues kommen **ohne Leerzeichen** verkettet (`Japanischlernenfür
Anfängerinnen`), die `en`-Cues mit (`This is a 3.`). Ein Parser, der `segs`
stumpf aneinanderhängt, verklebt lateinische Wörter in einer sonst
leerzeichenfreien Spur.

### M16 — Der Menü-Einstieg ist ohne lokalisierten Namen findbar

*Beleg: `browser_eval` auf `v=<video-en>`, 2026-11-12 (Dev-Plan, Stufe 0).*

Das Player-Menü hat **9** Zeilen. Jede trägt ein lokalisiertes Label
(`.ytp-menuitem-label`) und einen Wert (`.ytp-menuitem-content`). Die gesuchte
Zeile hatte den Wert **„Japanisch"** — und „Japanisch" ist genau der `name`
aus dem Modell (`captionTracks[14].name`), es ist also **derselbe String**
(M5 offen: „nur für ein Video belegt" — hier belegt für Menü **und** Modell).

- **Der Anker:** die Zeile, deren `.ytp-menuitem-content` exakt einem `name`
  aus dem Modell entspricht. Gemessen: genau **eine** solche Zeile; ein Klick
  öffnet das Untermenü.
- **Die Gegenprobe:** das Untermenü hat **33** Einträge = 31 `captionTracks`
  (M1) + „Aus" + „Automatisch übersetzen".
- Das Label („Untertitel", „Audiotrack") wird **nicht** gebraucht; es ist die
  lokalisierte Zeichenkette, die diese Spec vermeiden will.

### M17 — Der Sprung holt die Spurendatei, ohne Abspielen

*Beleg: dieselbe Messung wie M16.*

- Nach dem Setzen einer Spur holt der Player **nichts**, solange er sie nicht
  braucht: `performance` enthielt **0** `api/timedtext`-Einträge.
- Ein **Sprung** bei pausiertem Video (`currentTime` 19,1 s → 59,1 s) genügte:
  danach stand `lang=de` mit **49 261** Bytes in der Liste.
- **Kurzes Abspielen** (1 s) genügt ebenfalls (`lang=en`, 46 010 Bytes) — der
  Sprung ist also nicht der einzige Auslöser, aber der billigere.

**Folge:** der Weg aus dem Dev-Plan trägt: setzen → springen → Adresse lesen.

### M18 — Live: die Spurendatei ist im Browser nicht beobachtbar ⚠️

*Beleg: `browser_transcript` und `browser_eval` im Profil des Betreibers,
2026-11-12 abends, nach dem Neustart von Extension und Dienst.*

- Der Werkzeugaufruf auf `v=<video-en>` endet mit **„Die Spurendatei zur
  Sprache „en" wurde auf dieser Seite nicht gefunden."** — zweimal, auf zwei
  frischen Tabs, mit 4 s Wartezeit und über den vollen Menü- und Sprungpfad.
- `performance.getEntriesByType('resource')` enthält **keine**
  `api/timedtext`-Adresse: nicht vor dem Spurwechsel, nicht danach
  (Deutsch → Englisch), nicht bei laufender Wiedergabe, nicht nach einem
  Sprung.
- **Der Kanal ist blind für Anfragen der Seite — und er ist nicht die
  Resource-Timeline der Seite.** Ein `<img>`, das die Seite selbst anfordert,
  erscheint nicht in der Liste (24 Einträge vorher, 24 nachher). Kontrollprobe
  auf `example.org`: dasselbe Bild erscheint **weder** in `performance`
  **noch** in `window.wrappedJSObject.performance` (je 1 Eintrag vorher, 1
  nachher). Was der Schnipsel liest, ist also nicht die Resource-Timeline der
  Seite, sondern die des Ausführungskontexts — Anfragen der Seite kommen dort
  nicht an.
- **Die Untertitel sind da:** der Player rendert sie
  (`.ytp-caption-segment`), und das Transkript-Panel baute **133** Segmente.
  Woher die Daten kommen, ist mit Bordmitteln nicht sichtbar — weder am
  `fetch`-Haken noch am `XMLHttpRequest.open`-Haken der Seite schlug etwas auf
  (beide nach dem Laden installiert).
- **Widerspruch zu M13, ehrlich benannt:** am selben Tag vormittags standen
  zwei `timedtext`-Adressen in derselben Liste (`lang=th` 57 576 Bytes,
  `lang=en` 46 010 Bytes). Diese Beobachtung ist **nicht reproduzierbar**.
  M13 ist damit **nicht widerlegt, aber unbelegt**: sie war einmal da und ist
  weg.

**Folge: Kriterium 12 ist rot.** Die Kernannahme von Stufe 1 und 3 — „die
signierte Adresse steht in `performance`" — trägt live nicht. Das Werkzeug
antwortet jetzt für den Hauptfall mit einem benannten Fehler, wo Teil 1 noch
Text lieferte (in der falschen Sprache, aber lesbar).

## Messlauf der ersten Fassung (Kriterium 9) — rot

Diese Messung gehört zur **ersten** Fassung dieser Spec (Spur setzen, Panel
neu bauen). Sie steht hier, weil sie die Ursache belegt und eine spätere Spec
davor bewahrt, denselben Weg noch einmal zu gehen.

**Gemessen am 2026-11-12** im Profil des Betreibers: Firefox mit der
Extension aus diesem Repo (der Betreiber hat sie neu geladen), Dienst
`browser-control.service` `active` mit **13** Werkzeugen, Agenten-Tab auf
`v=<video-en>`, Tab im Vordergrund. Der Agent hat nur in seinem eigenen Tab
gehandelt und ihn danach geschlossen.

| # | Eingriff | Was das Panel lieferte |
|---|---|---|
| 1 | Kontrolle: Werkzeug aufrufen, nichts ändern | deutsch, „Das ist eine Drei.“ (0:04), `totalChars` **19 777** — wie `docs/32`, M2 |
| 2 | Untertitel-Menü gelesen | Eintrag **„Englisch“ ist angehakt**; das Panel bleibt deutsch |
| 3 | auf **„Englisch (automatisch erzeugt)“** umgestellt | unverändert; kein Live-Neuzeichnen |
| 4 | Seite **neu geladen**, ASR-Englisch gewählt | unverändert deutsch, **dieselben** 19 777 Zeichen |
| 5 | **„Thailändisch“** gewählt (Player meldet „Untertitel: Thailändisch“), neu geladen | unverändert deutsch, dieselben 19 777 Zeichen |
| 6 | **„Automatisch übersetzen → Englisch“** (Anzeige „Englisch >> Englisch“), neu geladen | unverändert deutsch, dieselben 19 777 Zeichen |

**Befund 1 — das Panel folgt der Spur nicht, auch nicht beim Laden.**
Erklärung (1) aus M7 („das Panel liest beim Öffnen neu und folgt der aktuellen
Spurauswahl“) sagt nach Schritt 4 einen Wechsel voraus. Er blieb aus. Übrig
bleibt Erklärung (2): das Panel liest Daten, die nicht von der Spur abhängen.

**Befund 2 — „schließen und neu öffnen“ ist kein Neuaufbau.** Nach einem Klick
auf „Transkript schließen“ lagen weiter **133** `transcript-segment-view-model`
im DOM. Das Schließen blendet aus, es verwirft nicht. Stufe 3 hätte damit
keinen Träger für ihr „neu bauen“.

**Befund 3 — die Sprache steht in den `params` und wird beim Laden
festgelegt.** `ytInitialData … continuationEndpoint …
getTranscriptEndpoint.params` dekodiert zu `…aircAruvnKk…CgASAmRlGgA%3D…`;
der innere, **URL-kodierte** Blob (`%3D`) ist Protobuf und trägt in Feld 2 die
Sprache **`de`**. Dazu passend: `ytcfg.get('HL')` = `de`, `client.hl` = `de`,
`<html lang>` = `de-DE`, und auch der Videotitel ist übersetzt („Aber was ist
ein neuronales Netz?“). **Nachtrag:** der innere Blob trägt **zwei** Felder —
`kind` und `language`. Beim englischen Video `("", "de")`, das ist die
**manuelle** deutsche Spur; beim japanischen Video `("asr", "ja")`. Die
Seite wählt also beim Laden „die Spur in der Oberflächensprache, **wenn es eine
gibt**, sonst die Standardspur“. Kein Menü erreicht diese Wahl.

**Befund 4 — der Gegenweg über innertube bleibt zu.** Ein `fetch` auf
`/youtubei/v1/get_transcript?prettyPrint=false` mit umgeschriebenen `params`
(`CgASAmVuGgA` = `en`) antwortet **HTTP 400 „Precondition check failed“**;
die **Kontrolle mit den originalen `params` liefert dasselbe 400**. Der Fehler
liegt nicht an der Umschreibung, die Schnittstelle nimmt diese Form nicht an —
M6 gilt weiter, jetzt mit Gegenprobe.

**Ergebnis: Kriterium 9 ist rot, die Kernannahme widerlegt.** Über die
Untertitel-Oberfläche gibt es **keinen** Weg zur Originalspur. Nach der Regel
dieser Spec (damals Stufe 4b) heißt das: **kein `active`, kein Bau**; die rote Zeile
steht in `## Bekannte Lücken`, die Frage wieder in `## Open questions`.

**Der Browser des Betreibers ist wie vorgefunden:** Untertitel zurück auf
„Englisch“ (ohne `>>`), Agenten-Tabs geschlossen, die Tabs des Betreibers
unberührt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `transcript_trackForOriginalAudio` (Fixture `en-US.4` + `de.3`) | der Original-Audiotrack wird **über die ID** gefunden (M2) |
| `test/extension.test.js` | `transcript_trackForOriginalAudio_withOriginalAtAnotherIndex` | die Reihenfolge der `audioTracks` ist irrelevant (M3) |
| `test/extension.test.js` | `transcript_trackForOriginalAudio_withTwoCandidates_shouldFail` | bei ≠ 1 Kandidat ein **benannter** Fehler, kein stiller Pick |
| `test/extension.test.js` | `transcript_languageForTrack_withEnglishOriginal` | Originalsprache `en` ⇒ diese Spur |
| `test/extension.test.js` | `transcript_languageForTrack_withGermanOriginal` | Originalspur `de` ⇒ diese Spur |
| `test/extension.test.js` | `transcript_languageForTrack_withJapaneseOriginalAndEnglishTrack` | `ja` und **eine** englische Spur ⇒ englische Spur |
| `test/extension.test.js` | `transcript_languageForTrack_withTwoEnglishTracks` | zwei englische Spuren ⇒ manuell vor ASR; zwei manuelle ⇒ benannter Fehler |
| `test/extension.test.js` | `transcript_languageForTrack_withoutEnglishTrack` | `ja`, keine englische Spur ⇒ **Original** mit `requestedLanguage: "ja"`, kein Fehler |
| `test/extension.test.js` | `transcript_menuEntry_exactNameMatch` | exakter Vergleich auf `innerText.trim()` (M5) |
| `test/extension.test.js` | `transcript_menuEntry_ignoresTranslateEntries` | Einträge mit `>>` sind ausgeschlossen (M5) |
| `test/extension.test.js` | `transcript_menuEntry_withoutMatch_shouldFail` | kein Treffer ⇒ benannter Fehler, kein Klick |
| `test/extension.test.js` | `transcript_menuEntry_withTwoMatches_shouldFail` | zwei Treffer ⇒ benannter Fehler, kein Klick |
| `test/extension.test.js` | `transcript_captionUrl_picksTheMatchingLanguage` | aus mehreren Mitschnitt-Adressen gewinnt die mit dem `lang` der Zielspur (M13, `docs/34`) |
| `test/extension.test.js` | `transcript_captionUrl_withoutMatch_shouldFail` | keine passende Adresse ⇒ benannter Fehler, **kein** Panel-Rückfall |
| `test/extension.test.js` | `transcript_captionUrl_skipsTranslatedAddresses` | eine Adresse mit `tlang` (Auto-Übersetzung) wird **übersprungen** — `deliveredLanguage` behauptet sonst die falsche Sprache |
| `test/extension.test.js` | `transcript_model_keepsPositionsWithAHoleInTheCaptionList` | ein Loch in `captionTracks` verschiebt den Index **nicht**: die Kopie behält die Position |
| `test/extension.test.js` | `transcript_model_holeAtTheOriginalIndex_shouldFail` | zeigt der Original-Index auf ein Loch, ist das ein **benannter** Fehler, keine stille Nachbarspur |
| `test/extension.test.js` | `transcript_cues_parseJson3` | `events[].tStartMs` → `time`/`timeText`, `segs[].utf8` → `text` (M13) |
| `test/extension.test.js` | `transcript_cues_doNotGlueLatinWords` | eine leerzeichenfreie Spur verklebt lateinische Wörter nicht (M15) |
| `test/extension.test.js` | `transcript_captionRow_miscount_shouldFail` | die Gegenprobe greift: ein Eintrag zu viel **ohne** Paar-Eintrag ⇒ benannter Fehler, kein Klick (M16) |
| `test/extension.test.js` | `transcript_captionRow_withAPairEntry_countsOneMore` | ein Paar-Eintrag (`… >> …`) zählt als einer zusätzlich (live gemessen 2026-11-12) |
| `test/extension.test.js` | `transcript_captionRow_withATranslatedSuffix_stillFindsTheRow` | die Zeile trägt bei Auto-Übersetzung `>> …`; der Anker schneidet es ab (live gemessen 2026-11-12) |
| `test/extension.test.js` | `transcript_captionRow_miscountWithAPairEntry_namesTheRealCount` | die Verweigerung nennt die **gerechnete** Zahl (Paar-Eintrag zählt mit), nicht die Modellzahl |
| `test/extension.test.js` | `transcript_menuSetDidNotTakeEffect_shouldFail` | greift der Klick nicht, wird das **gelesen** und benannt, nicht 6 s später als `no_address` |
| `test/extension.test.js` | `transcript_menuLeftClosedAfterSet` | das Spielermenü bleibt zu, wenn es zu war |
| `test/extension.test.js` | `transcript_menuStaysOpenWhenItWasOpen` | ein vom Betreiber offenes Menü wird **ohne Eintragsklick** nicht zugemacht |
| `test/extension.test.js` | `transcript_menuCheckedOnlyWhenOpen_shouldStillSucceed` | die Marke wird nach dem Klick **frisch** gelesen, wenn das Popup sie nur bei offenem Menü hergibt |
| `test/extension.test.js` | `transcript_positionRestoredEvenWhenTheTrackRestoreThrows` | die Position wird auch zurückgeschrieben, wenn der Spur-Teil wirft (`finally`) |
| `test/extension.test.js` | `transcript_languageForTrack_withASingleCaptionTrackAndNoIndex` | ohne Index und mit **einer** Spur ist die die Originalspur (live 2026-11-12: `wKv-g1uEoDY`) |
| `test/extension.test.js` | `transcript_languageForTrack_withTwoTracksOfTheSameLanguageAndNoIndex` | ohne Index und zwei Spuren **einer** Sprache: manuell vor ASR (live 2026-11-12: `SmxSCZzV7j0`) |
| `test/extension.test.js` | `transcript_languageForTrack_withTwoManualTracksAndNoIndex_shouldFail` | zwei manuelle ohne Index ⇒ benannter Fehler |
| `test/extension.test.js` | `transcript_model_withoutCaptionTrack_shouldFailNoPanel` | ohne `captionTracks` bleibt `no_transcript_panel` gedeckt — der alte Panel-Fall fällt weg |
| `test/extension.test.js` | `transcript_seekRestoresPosition` | die Abspielposition wird nach dem Sprung zurückgestellt |
| `test/extension.test.js` | `transcript_trackRestoredAfterReading` | die vorher gewählte Spur wird wieder gesetzt |
| `test/mcp.test.js` | `mcp_toolsCallBrowserTranscript_shouldCarryTheLanguageFields` | das Ergebnis trägt `requestedLanguage`, `deliveredLanguage` und `source` |
| `test/mcp.test.js` | `mcp_toolsCallBrowserTranscript_shouldNotLeakTheUrl` | die signierte Adresse steht **nicht** im Ergebnis (M13) |
| `npm test` (TAP-Ausgabe) | `^# fail 0` **1**, `^# cancelled 0` **1**, `^# skipped 0` **1** | nichts ist kaputt (unter Linux); `npm test 2>&1 \| grep -c '^# fail 0'` ⇒ **1** — ohne Pipe schreibt Node `ℹ fail 0`, nicht `# fail 0` |
| **live (Betreiber)** | Kriterium 12: `aircAruvnKk` → englische Segmente, `requestedLanguage: "en"` | die Regel für ein englisches Original |
| **live (Betreiber)** | Kriterium 13: `SmxSCZzV7j0` → japanische Segmente, `requestedLanguage: "ja"` | die Regel für ein nicht-en/de-Original |

**Keine neue Testdatei.** Die Fälle kommen in die bestehenden
`test/extension.test.js` und `test/mcp.test.js`.

## Acceptance criteria

**Jedes Kriterium nennt einen Befehl, der eine eindeutige Antwort liefert.**

1. **Die Originalspur wird über den Original-Audiotrack gefunden** — über die
   **`audioTrackId`** ohne `.3`-Suffix, **nicht** über
   `defaultAudioTrackIndex` und **nicht** über das `vssId`-Prefix (M1–M3).
   Bei ≠ 1 Kandidat **`transcript_failed`** mit den Kandidaten in der Meldung.
   Beweis: `grep -c 'transcript_trackForOriginalAudio' test/extension.test.js`
   ⇒ **4**; `grep -c 'defaultAudioTrackIndex' extension/background.js` ⇒
   **0**; dazu der `ok`-Lauf aus Dev-Plan-Stufe 1 mit **8** Treffern;
   `npm test` grün.
2. **Die Regel des Betreibers gilt.** Ist die **Sprache des Originals** `en`
   oder `de` ⇒ diese Spur; sonst ⇒ englische Spur, wenn **genau eine**
   existiert (bei mehreren: manuell vor ASR, zwei manuelle ⇒ benannter
   Fehler); **sonst das Original** mit `requestedLanguage` = dessen
   `languageCode` — kein Fehler, kein erfundener englischer Text.
   Beweis: `grep -c 'transcript_languageForTrack' test/extension.test.js`
   ⇒ **8**; `grep -c 'transcript_languageForTrack_withoutEnglishTrack'
   test/extension.test.js` ⇒ **1**;
   `grep -c 'transcript_languageForTrack_withTwoEnglishTracks'
   test/extension.test.js` ⇒ **1**; `npm test` grün.
3. **Die Spur wird im Menü nach dem Namen aus dem Modell gewählt**, exakt auf
   `innerText.trim()`, **ohne** Einträge mit `>>`, **ohne** Index. Dass kein
   Index benutzt wird, entscheidet das Fixture: der Fall
   `transcript_menuEntry_exactNameMatch` verschiebt die **Menüreihenfolge**
   gegenüber der Modellreihenfolge — ohne diese Verschiebung wäre ein
   Index-Pick nicht zu widerlegen. Kein oder mehrere Treffer ⇒
   **`transcript_failed`**, kein Klick. Beweis:
   `grep -c 'transcript_menuEntry' test/extension.test.js` ⇒ **≥ 4**;
   `grep -c 'transcript_menuEntry_ignoresTranslateEntries'
   test/extension.test.js` ⇒ **1**; dazu der `ok`-Lauf
   `--test-name-pattern 'transcript_(menuEntry|seekRestoresPosition|trackRestoredAfterReading)'`
   ⇒ **6**; `npm test` grün.
4. **Gelesen wird die Spurendatei, nicht das Panel.** Aus den
   Mitschnitt wird die Adresse genommen, deren `lang` die Zielspur ist **und**
   deren `kind` zu ihrem `vssId`-Präfix passt (`a.` ⇒ `kind=asr`, sonst ohne)
   und die **kein** `tlang` trägt (eine Auto-Übersetzung würde `deliveredLanguage`
   verfälschen)
   — ohne das zweite Merkmal sind zwei englische Spuren nicht unterscheidbar
   (M1, M13); fehlt sie **oder trägt sie kein `lang`**, ist das
   **`transcript_failed`** — kein Panel-Rückfall (dessen
   Text wäre die falsche Sprache, `## Messlauf der ersten Fassung`). Beweis:
   `grep -c 'transcript_captionUrl' test/extension.test.js` ⇒ **≥ 2**;
   `grep -c 'transcript_captionUrl_withoutMatch_shouldFail'
   test/extension.test.js` ⇒ **1**;
   `grep -c 'transcript_captionUrl_skipsTranslatedAddresses'
   test/extension.test.js` ⇒ **1**; dazu der `ok`-Lauf
   `--test-name-pattern 'transcript_(captionUrl|cues)'` ⇒ **7**; `npm test`
   grün.
5. **Die Cues werden als JSON3 gelesen**, `tStartMs` wird zu `time` und
   `timeText`, die `segs` werden zu `text` (M13); eine leerzeichenfreie Spur
   verklebt lateinische Wörter nicht (M15). Beweis:
   `grep -c 'transcript_cues' test/extension.test.js` ⇒ **≥ 2**;
   `grep -c 'transcript_cues_doNotGlueLatinWords' test/extension.test.js`
   ⇒ **1**; dazu derselbe `ok`-Lauf ⇒ **6**; `npm test` grün.
6. **Position und Spur werden zurückgestellt.** Nach dem Lesen steht die
   Abspielposition wieder da, wo sie war, und die vorher gewählte Untertitelspur
   ist wieder gesetzt (Entscheidungen 2026-11-12). Beweis:
   `grep -c 'transcript_seekRestoresPosition' test/extension.test.js` ⇒ **1**;
   `grep -c 'transcript_trackRestoredAfterReading' test/extension.test.js`
   ⇒ **1**; der Positionsfall pinnt die **exakte Schreibfolge**
   `[start + 1, start]`, der Spürfall die Folge `[Zielname, vorheriger Name]`;
   `npm test` grün.
7. **Die Antwort nennt beide Sprachen und ihre Herkunft.**
   `requestedLanguage` ist der `languageCode` der Zielspur;
   `deliveredLanguage` ist die Sprache **aus der Adresse** (M13); `source`
   nennt den Container, aus dem das Modell kam (M11). Beweis:
   `grep -c 'requestedLanguage' extension/background.js` ⇒ **≥ 1**;
   `grep -c 'deliveredLanguage' extension/background.js` ⇒ **≥ 1**;
   `grep -c 'mcp_toolsCallBrowserTranscript_shouldCarryTheLanguageFields'
   test/mcp.test.js` ⇒ **1**; `grep -c '"requestedLanguage"' test/mcp.test.js`
   ⇒ **≥ 1** (die Schlüsselprüfung, nicht nur ein Variablenname); dazu
   `node --test --test-reporter=tap --test-name-pattern
   'mcp_toolsCallBrowserTranscript_shouldCarryTheLanguageFields'
   test/mcp.test.js | grep -c '^ok [0-9]* -
   mcp_toolsCallBrowserTranscript_shouldCarryTheLanguageFields'` ⇒ **1**;
   `npm test` grün.
8. **Die signierte Adresse verlässt die Erweiterung nicht.** Sie steht nicht
   im Ergebnis, nicht in einer Fehlermeldung und nicht im Log (M13). Der
   entscheidende Fall ist der **Schnipsel-Test**, denn er sieht die echte
   Adresse; der Bridge-Test kann nur zeigen, dass ein Platzhalter keine
   enthält. Beweis:
   `grep -c 'transcript_captionUrl_doesNotLeakIntoTheAnswer'
   test/extension.test.js` ⇒ **1**; `grep -c
   'mcp_toolsCallBrowserTranscript_shouldNotLeakTheUrl' test/mcp.test.js` ⇒
   **1**; `grep -c 'transcript' bridge/hub.mjs` ⇒ **0**;
   `git diff -- bridge/hub.mjs` ⇒ **leer**.
9. **Kein zweites Werkzeug, keine neuen Fehlercodes für dieselbe Sache.**
   Die Zahl der Werkzeuge bleibt **13** — `grep -c 'TOOL_COUNT = 13'
   test/http-mcp.test.js` ⇒ **1** entscheidet dabei **nichts** (die Datei ist
   gesperrt, der Pin bleibt so oder so grün); der Wächter ist `tools.length` in
   `test/mcp.test.js` über `npm test`. Im Bridge-Modul bleibt die Werkzeugfläche
   unverändert: `grep -c '^const BROWSER_TRANSCRIPT = "browser_transcript";'
   bridge/mcp.mjs` ⇒ **1** und `grep -c 'BROWSER_TRANSCRIPT' bridge/mcp.mjs`
   ⇒ **7** (Stand vor diesem Inkrement; die Zahl darf sich nicht ändern —
   **kein** zweiter Werkzeugname, **keine** neuen Codes). Beweis: `npm test`
   grün.
10. **Kein Produktcode außerhalb der Grenze.** Beweis — **im Arbeitsbaum**:

    ```
    git status --porcelain | grep -vE '^( M|M |\?\?) (bridge/mcp\.mjs|extension/background\.js|test/(extension|mcp)\.test\.js|test/fixtures/fake-extension\.mjs|docs/(31-youtube-recherche|32-transkript-werkzeug|33-spurwahl|README|PROJECT-STATE|ROADMAP)\.md)$'
    ```

    ⇒ **keine Ausgabe** — die Liste schließt auch `test/http-mcp.test.js` und
    `extension/manifest.json` ein, denn beide fehlen; `git diff --
    extension/manifest.json` ⇒ leer; `git diff -- package.json` ⇒ leer.
11. **Kein Geheimnis.** Beweis:
    `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1.
12. **LIVE (Betreiber): ein englisches Original.** Auf `v=<video-en>`
    liefert `browser_transcript` **englische** Segmente, `requestedLanguage`
    ist `en`, und `deliveredLanguage` ist `en`. Beweis: die ersten drei
    Segmente wörtlich, beide Sprachfelder wörtlich.
13. **LIVE (Betreiber): ein nicht-en/de-Original.** Auf `v=<video-ja-2>`
    liefert `browser_transcript` **japanische** Segmente mit
    `requestedLanguage: "ja"` — kein deutscher oder englischer Text ohne
    passende Sprachangabe. **Gemessen am 2026-11-12: grün** („皆さんこんにちは！…").
    Das frühere Beispiel `wKv-g1uEoDY` fällt aus: seine einzige Spur ist als
    `ja` etikettiert und enthält deutschen Text (YouTube-Datenfehler, siehe
    `## Bekannte Lücken`). Beweis: die ersten drei Segmente und der Wert von
    `requestedLanguage`.

14. **Der Fehlergrund kommt beim Betreiber an.** Für `transcript_failed`
    antwortet die Bridge mit dem Grund aus der Extension (`details.message`),
    wenn einer da ist — nicht mit dem Satz „nur YouTube-Watch-Seiten haben
    eines" (Stufe 4). Beweis:
    `grep -c 'mcp_toolsCallBrowserTranscript_shouldPassTheFailureDetail'
    test/mcp.test.js` ⇒ **1**; `npm test` grün.

**Ausnahme mit Datum (2026-11-12).** Kriterium 12 und 13 sind nur im echten
Profil des Betreibers messbar (Extension-Reload, ein Aufruf in einer
pi-Sitzung). Sie werden **nach** dem Commit gemessen — die Ausnahme aus
`CONTRIBUTING.md`, `## Abnahme` (2026-10-23). Die Kriterien 1–11 laufen **vor** dem
Commit. Fällt Kriterium 12 rot aus, ist der Weg als Ganzes nicht belegt: dann
geht die Spec zurück in `## Open questions` und `## Non-goals`, nicht in die
Lückenliste.

## Dev plan

**Der Zuschnitt.** Das Werkzeug liest nicht mehr das Panel, sondern die
Spurendatei, die der Player selbst geholt hat (`api/timedtext`, M13). Die
Zielspur kommt aus dem Modell und der Betreiberregel; ihre Adresse wird
gesucht, und nur wenn sie fehlt, wird die Spur im Menü gesetzt und der Player
durch einen Sprung zum Holen gebracht (M5). Danach werden Position und Spur
zurückgestellt.

**Was den Plan bindet** (aus der Spec, nicht neu verhandelt): die Adresse ist
signiert und nur die des Players trägt (M13); der Vergleich im Menü läuft exakt
auf `innerText.trim()`, `>>`-Einträge sind aus (M5); `audioTrackId` ohne
`.3`-Suffix statt Index (M2/M3); `wrappedJSObject` heißt Index-Schleifen und
Feld-für-Feld-Kopieren; `ja` verklebt lateinische Wörter ohne eigene
Verbundregel (M15); `bridge/hub.mjs` bleibt unangetastet; der Fehlercode-Satz
bleibt.

**Vor dem Bau gelesen** (Befunde aus den Dateien):

- `transcriptAgentTab` (`extension/background.js`) macht heute zwei
  Injektionen: `transcriptPanelCode()` und `transcriptSegmentsCode(offset,
  maxChars)`. Die **Fensterlogik** in `transcriptSegmentsSource` (ein
  Leerzeichen Verbinder, ganzes Segment, `truncated = endLast < totalChars`,
  `offset_out_of_range` mit `totalChars`) wird **verschoben, nicht neu
  geschrieben** — `docs/32`, Kriterium 3 bleibt damit gültig.
- Die Fehlerform steht: `TranscriptError`, `transcriptErrorFor`, der
  `BROWSER_TRANSCRIPT`-Zweig in `extensionFailureText` (`bridge/mcp.mjs`). Er
  wird um Übersetzungen erweitert, nicht um Codes.
- `wrappedJSObject` kommt im Repo heute **nicht** vor (`grep -rc
  wrappedJSObject extension/ bridge/ test/` ⇒ überall 0). Xray ist neu und
  muss im Fixture modelliert werden.
- Die Werkzeugzahl **13 ändert sich nicht**: die fünf Pins (`TOOL_COUNT` in
  `test/http-mcp.test.js`, Namensarray, `tools.length`, `tools[12]`,
  `test/mcp.test.js`) bleiben unberührt; `test/http-mcp.test.js` ist ohnehin
  gesperrt. Was sich ändert: `TRANSCRIPT_TOOL_DESCRIPTION` (`test/mcp.test.js`,
  an vier Stellen gepinnt: die Konstante und drei `assert.match`), die Schlüsselreihenfolge
  in `transcript_segments_withThreeSegments` und
  `mcp_toolsCallBrowserTranscript_withAConnectedExtension_…`,
  `TRANSCRIPT_RESULT` (`test/fixtures/fake-extension.mjs`) und der Satz
  `TOOL_TEXTS.NO_TRANSCRIPT_PANEL` samt seiner Testkopie
  `NO_TRANSCRIPT_PANEL_TEXT`.
- `PROTOCOL.CALL_TIMEOUT_MS = 20000` (`bridge/protocol.mjs`,
  `extension/protocol.js`) ist das Zeitbudget des ganzen Laufs: Gate + Modell +
  Menü + Warten + `fetch` + Zurückstellen müssen deutlich darunter bleiben.

---

**0. Die zwei ungemessenen Anker messen — Betreiber/Orchestrator, read-only,
keine Datei im Baum**

Drei `browser_eval`-Aufrufe je Video (`aircAruvnKk`, `wKv-g1uEoDY`), im
Agenten-Tab, nichts wird umgestellt:

1. **Modellname ↔ Menütext.** `captionTracks[i].name.simpleText` (bzw.
   `.runs[0].text`) der Original- und einer ASR-Spur gegen `innerText.trim()`
   des Menüeintrags, auf den sie zeigt. M5 belegt „lokalisierte Namen", nicht
   „derselbe Name".
2. **Die Untertitel-Zeile im Player-Menü ohne ihren lokalisierten Namen.**
   Kandidaten in dieser Reihenfolge: (a) die Zeile, deren
   `.ytp-menuitem-content` einen Namen aus (1) trägt; (b) das Untermenü, dessen
   Eintragszahl zu `captionTracks.length` passt (M5: 33 = 31 + 2); (c) keiner
   von beiden.
3. **Adresse nach dem Spurwechsel.** Hat der Player die `api/timedtext`-Adresse
   nach dem Setzen der Spur **ohne** Sprung geholt, und wie viele solche
   Einträge trägt `performance.getEntriesByType('resource')` dann?

Ergebnis als `### M16` und `### M17` in `docs/33-spurwahl.md` (Orchestrator), je
mit Video-ID, Datum und wörtlichem Befund.
Proof: `grep -c '^### M16' docs/33-spurwahl.md` ⇒ **1**; `grep -c '^### M17'
docs/33-spurwahl.md` ⇒ **1**.

**Erledigt am 2026-11-12** — der Anker (a) trägt, die Gegenprobe (b) stimmt,
und ein Sprung holt die Datei. Belege: M16 und M17.

**Widerlegt (2) beides**, ist der Einstieg ins Menü nicht sprachunabhängig —
dann ist die Kernannahme von M5 als *Bedienung* nicht umsetzbar, und das
Inkrement geht zurück **in die Spec** — `CONTRIBUTING.md`, `## Abnahme`:
`## Bekannte Lücken` ist dafür kein Ersatz.

---

**1. Die Quelle wird die Spurendatei — und der Panel-Weg verschwindet**
(Umsetzer)

Dateien: `extension/background.js`, `test/extension.test.js`.

Was entsteht:

- `transcriptGateSource()` (Marker `/*bc:transcript-gate*/`): Host/Pfad wie
  bisher (`youtube.com` / `.youtube.com`, **nicht** `m.youtube.com`, Pfad
  `/watch`) und dann `ytd-watch-flexy`; Ergebnis `{outcome:
  "ok"|"not_youtube"|"needs_focus", visibilityState}`. Codes und Sätze
  bleiben; die Fälle `transcript_onANonYouTubePage_shouldFail`,
  `transcript_onLookalikeHosts_shouldStillFail`,
  `transcript_inABackgroundTab_shouldFailWithNeedsFocus` bleiben unter ihrem
  Namen.
- `transcriptModelSource(candidates)` (Marker `/*bc:transcript-model*/`):
  **Kandidatenliste statt festem Pfad** (M11) — `ytplayer.bootstrapPlayerResponse`
  (gemessen) und die vier übrigen Kandidaten; ein Kandidat, der ein JSON-String
  ist, wird geparst. Felder **einzeln** kopiert, Index-Schleifen über `length`,
  kein `map`/`filter`/Spread auf Seitenobjekten. Rückgabe: `{outcome:"model",
  source, captionTracks:[{languageCode, vssId, name}],
  audioTracks:[{audioTrackId, defaultCaptionTrackIndex}]}`, sonst
  `{outcome:"no_model"}`.
- Die **Regel im Extensionsteil**, nicht im Schnipsel:
  `transcriptOriginalAudioTrackOf(audioTracks)` (der eine Eintrag ohne
  `.3`-Suffix; ≠ 1 Kandidat ⇒ `transcript_failed` mit den Kandidaten) und
  `transcriptTargetTrackOf(model)` (Original `en`/`de` ⇒ sie; sonst genau eine
  englische Spur, manuell vor ASR, zwei manuelle ⇒ Fehler; sonst Original).
  Reine Funktionen über die kopierten Felder — der Test kann damit am *Abbruch
  vor der nächsten Injektion* prüfen, dass nichts geklickt wurde.
- `transcriptCaptionSource(request)` (Marker `/*bc:transcript-caption*/`):
  `{languageCode, asr, offset, maxChars, deadlineMs, pollMs}`. Sucht in
  `performance.getEntriesByType('resource')` den `api/timedtext`-Eintrag,
  dessen `lang` die Zielsprache ist **und** dessen `kind` zum `vssId`-Präfix
  passt (`a.` ⇒ `kind=asr`, sonst ohne) — ohne dieses zweite Merkmal sind zwei
  englische Spuren nicht unterscheidbar; bei mehreren Treffern gewinnt der
  **letzte** (die Liste ist chronologisch). `fmt` wird gesetzt, nicht doppelt
  angehängt. `fetch` → JSON3 → Cues `{time, timeText, text}`; `timeText` aus
  `tStartMs` (`m:ss`, ab einer Stunde `h:mm:ss`); `segs[].utf8` werden mit
  **einem Leerzeichen** verbunden und Mehrfach-Leerzeichen zusammengezogen
  (M15), danach die **unveränderte** Fensterlogik. Fehlt die Adresse:
  `{outcome:"no_address"}` ⇒ `transcript_failed` — das ist Kriterium 4; der
  Sprung kommt erst in Stufe 3.
- Antwort: `{requestedLanguage, deliveredLanguage, source, segments,
  totalChars, chars, offset, truncated}`. Die drei neuen Felder **vorn**, damit
  die Sprache nicht hinter 20 000 Zeichen Segmenttext steht.
  `deliveredLanguage` wird aus dem `lang`-Parameter der Adresse gelesen. Eine
  Adresse **ohne** `lang` ist ein Fall von `withoutMatch` und damit
  `transcript_failed` — kein `null`, kein stilles Raten. Die Adresse selbst
  wird **nie** zurückgegeben — der
  Schnipsel hat keinen Rückgabepfad für sie; Kandidaten in Meldungen sind
  Sprachnamen, nie Adressen.
- `captionTracks` leer/fehlt ⇒ `no_transcript_panel`; jeder andere Fehlschlag
  ⇒ `transcript_failed`. Der Fall heißt
  `transcript_model_withoutCaptionTrack_shouldFailNoPanel` — **nicht**
  `transcript_segments_…`, sonst kippt der `⇒ 8`-Proof unten.
- **Gelöscht in derselben Stufe, weil ab hier tot:** `transcriptPanelSource`,
  `transcriptPanelCode`, `transcriptSegmentsSource`, `transcriptSegmentsCode`,
  `requireTranscriptPanel`, die Marker `/*bc:transcript-panel*/`/
  `/*bc:transcript-segments*/` samt `isTranscriptPanelCode`/
  `isTranscriptSegmentsCode`, die Fixture-Bausteine `createTranscriptRenderer`/
  `createTranscriptSegment` und die acht Panel-Fälle
  (`transcript_panelVisible_…`, `transcript_buttonMissing_…`,
  `transcript_panelAlreadyOpen_…`, `transcript_expandNotClicked…`,
  `transcript_collapsedDescription_…` zweimal,
  `transcript_readsPanelAfterOpening_…`, `transcript_segments_withoutPanel_shouldFail`).
  **Entscheidung: löschen, nicht als toter Zweig stehen lassen** — ein
  unbenutzter Panel-Schnipsel ist beim nächsten Werkzeug der bequeme Weg
  zurück, und seine Tests blieben grün, ohne etwas zu beweisen (Kriterium 4).
- Fixture: `createTranscriptPage` trägt statt Renderern/Segmenten `pageWindow`
  (Modell für `wrappedJSObject`), `resources`, `cues` je `lang`/`kind`,
  `video`; `pageContextOf` bekommt im `page.transcript`-Zweig
  `performance.getEntriesByType`, `fetch` und `window.wrappedJSObject`;
  `querySelectorAllInTranscriptPage` verliert die Panel-Selektoren und **wirft
  weiter** bei unbekannten. Die Modell-Listen sind **array-artige Objekte ohne
  `map`/`filter`** — der Xray-Zwang ist damit im Test nachgebildet, nicht
  behauptet (`transcript_model_worksWithArrayLikePageObjects`).
- Die acht Fensterfälle (`transcript_segments_*` sieben +
  `transcript_params_outOfRange_shouldFail`) bleiben unter ihrem Namen, nur
  ihre Herkunft ist neu; `transcript_segments_withThreeSegments` pinnt die acht
  Schlüssel in der neuen Reihenfolge. Zusatzfälle:
  `transcript_model_worksWithArrayLikePageObjects`,
  `transcript_model_fallsThroughTheCandidates`,
  `transcript_captionUrl_matchesTheKind`,
  `transcript_captionUrl_doesNotLeakIntoTheAnswer` (die JSON-Antwort enthält
  kein `http`). **Kein neuer Fallname beginnt mit einem Präfix, das ein
  Kriterium zählt** — sonst kippt ein `grep -c` in `## Acceptance criteria`,
  das genau eine Zeile fordert.

Proof:

```
node --test --test-reporter=tap --test-name-pattern 'transcript_(trackForOriginalAudio|languageForTrack)' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_(trackForOriginalAudio|languageForTrack)'   # ⇒ 8
node --test --test-reporter=tap --test-name-pattern 'transcript_(captionUrl|cues)' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_(captionUrl|cues)'   # ⇒ 7
node --test --test-reporter=tap --test-name-pattern 'transcript_(segments|params)' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_(segments|params)'   # ⇒ 8
node --test --test-reporter=tap --test-name-pattern 'transcript_model' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_model'                # ⇒ 5
grep -c 'defaultAudioTrackIndex' extension/background.js   # ⇒ 0 — das Wort darf in dieser Datei nicht stehen, auch nicht im Kommentar (Kriterium 1); die Begründung zu M3 gehört in den Test
grep -rc 'transcript-panel\|transcript-segments' extension/background.js test/extension.test.js   # ⇒ je 0
npm run check; echo $?                                     # ⇒ 0
npm test; echo $?                                          # ⇒ 0, Ausgabe enthält "# fail 0" und "# cancelled 0"
```

---

**2. Doku-Nachzug der Amendments** (Orchestrator, nur `docs/`)

Dateien: `docs/33-spurwahl.md` (`## Amendments`, `## Bekannte Lücken`),
`docs/32-transkript-werkzeug.md` (nur die betroffenen Stellen),
`docs/31-youtube-recherche.md` (nur die Amendments-Zeilen aus `docs/33`).

`docs/32` braucht eine **zusätzliche Amendments-Zeile** — die vorhandene deckt
nur `## Ziel` und `## Non-goals`. Neu zu ändern: `## Testing` (die Panel-Zeilen
fallen weg, `transcript_segments_withoutPanel_shouldFail` heißt jetzt anders),
`## Acceptance criteria` 4 (Panel öffnen — entfällt), 5 (nur der Klammer-Satz
zu `settled` entfällt, das Vordergrund-Gate bleibt), 6 (`no_transcript_panel`
bedeutet jetzt „keine Untertitelspur im Modell"), `## Dev plan` Stufe 2 (als
*zurückgebaut in `docs/33`* markiert, nicht gelöscht — es ist Geschichte),
`## Messlauf der ersten Fassung` (Hinweis, dass die 133 Segmente/19 777 Zeichen
den Panel-Weg beschreiben). **Beide `## Non-goals`-Bullets** werden
umgeschrieben: „Keine Caption-API" ist nach diesem Inkrement falsch (die
Spurendatei **ist** eine Caption-Quelle — nur signiert und über die
Resource-Liste des Players), und „entscheidend ist die Oberflächensprache"
gilt nur noch für das Panel. Die Zeile sagt außerdem, dass
`TOOL_TEXTS.NO_TRANSCRIPT_PANEL` neu formuliert wird (Stufe 4), und dass
`docs/31`s Zeile „**Sprache**" um die Konkretisierung ergänzt wird (Anhängen,
nicht ersetzen — `grep -c '| **Sprache** | die **Originalspur**'
docs/31-youtube-recherche.md` bleibt **1**).

Proof — **abschnittsweise** gezählt, weil die Namen in der Geschichte
(`## Dev plan`, `## Log` von `docs/32`) stehenbleiben dürfen:

```
sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/32-transkript-werkzeug.md | grep -c 'transcript_segments_withoutPanel_shouldFail'   # ⇒ 0
sed -n '/^## Testing/,/^## Acceptance criteria/p' docs/32-transkript-werkzeug.md | grep -c 'transcript_readsPanelAfterOpening'              # ⇒ 0
sed -n '/^## Non-goals/,/^## Die Messungen/p' docs/32-transkript-werkzeug.md | grep -c 'Keine Caption-API'                                  # ⇒ 0
grep -c '^| `docs/32-transkript-werkzeug.md`' docs/33-spurwahl.md                                                                          # ⇒ 2
grep -c '^| `docs/31-youtube-recherche.md`' docs/33-spurwahl.md                                                                            # ⇒ 2
grep -c '| **Sprache** | die **Originalspur**' docs/31-youtube-recherche.md                                                                # ⇒ 1
```

---

**3. Menü, Sprung, Zurückstellen** (Umsetzer)

Dateien: `extension/background.js`, `test/extension.test.js`.

Was entsteht:

- `transcriptMenuSource(request)` (Marker `/*bc:transcript-menu*/`), Aktionen
  `read` und `set`. Öffnet `.ytp-settings-button`, findet die Untertitel-Zeile
  **nach dem in Stufe 0 gemessenen Anker** (nichts anderes wird als gegeben
  angenommen), liest die Menüeinträge als `innerText.trim()`, schließt das Menü
  wieder. `read` liefert `{outcome:"menu", entries, checkedName}`; `set`
  vergleicht exakt, schließt `>>`-Einträge aus und klickt **nur** bei genau
  einem Treffer; 0 oder ≥ 2 Treffer ⇒ `{outcome:"no_match"|"ambiguous",
  candidates}` ohne Klick.
- Die Regel, an **einer** Stelle: **setzen**, wenn `checkedName !== Zielname`;
  **springen**, wenn danach keine Adresse für die Zielspur vorliegt. Ist die
  Adresse schon da (Ziel = laufende Spur), wird **weder gesetzt noch
  gesprungen** — kein sichtbares Flackern. Merken von `video.currentTime`,
  Sprung um **±1 s** (`+1`, wenn das im Video liegt, sonst `−1`, sonst kein
  Sprung), dann pollt der Caption-Schnipsel `performance` bis
  `TRANSCRIPT_CAPTION_DEADLINE_MS = 3000`.
- `fetch` schlägt fehl oder liefert keine `events` ⇒ **ein**
  Sprung-und-nochmal-Versuch, danach `transcript_failed`. Das deckt zugleich
  eine evakuierte Resource-Timing-Liste und eine abgelaufene Signatur ab
  (`## Bekannte Lücken`: Gültigkeitsdauer ungemessen).
- Zurückstellen in dieser Reihenfolge, beides im Abschluss des Laufs und
  **vor** jedem weiteren `throw`: erst die vorher gewählte Spur (der gemerkte
  `checkedName` wird erneut exakt gewählt; war „Aus" gewählt, wird wieder
  ausgeschaltet), dann `video.currentTime`. Position zuletzt, damit keine
  Spurumschaltung sie danach erneut verschiebt.
- Neue Fälle: `transcript_menuEntry_*` (4, exakt die der Spec),
  `transcript_captionRow_foundByTheModelCount`,
  `transcript_captionRow_ambiguous_shouldFail`,
  `transcript_captionRow_absent_shouldFail`,
  `transcript_seekRestoresPosition` (pinnt die **exakte Schreibfolge**
  `[start+1, start]`), `transcript_trackRestoredAfterReading` (pinnt
  `[zielName, vorherName]`), `transcript_captionsWereOff_shouldTurnThemOffAgain`,
  `transcript_captionEntryAlreadyPresent_shouldNotSeek`,
  `transcript_staleAddress_shouldSeekAndRetry`.

Proof:

```
node --test --test-reporter=tap --test-name-pattern 'transcript_(menuEntry|seekRestoresPosition|trackRestoredAfterReading)' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_(menuEntry|seekRestoresPosition|trackRestoredAfterReading)'   # ⇒ 6
node --test --test-reporter=tap --test-name-pattern 'transcript_captionRow' test/extension.test.js | grep -c '^ok [0-9]* - transcript_captionRow'   # ⇒ 7 (vier Griffe + `row_miscount` + Paar-Eintrag + `miscountWithAPairEntry`)
node --test --test-reporter=tap --test-name-pattern 'transcript_(captionEntryAlreadyPresent|staleAddress|captionsWereOff)' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_(captionEntryAlreadyPresent|staleAddress|captionsWereOff)'   # ⇒ 3
node --test --test-reporter=tap --test-name-pattern 'transcript_menu' test/extension.test.js | grep -cE '^ok [0-9]+ - transcript_menu'   # ⇒ 8
npm test; echo $?    # ⇒ 0, "# fail 0" und "# cancelled 0"
```

---

**4. Bridge und Fixture** (Umsetzer)

Dateien: `bridge/mcp.mjs`, `test/fixtures/fake-extension.mjs`,
`test/mcp.test.js`.

Was entsteht: `TRANSCRIPT_TOOL_DESCRIPTION` beschreibt die Spurendatei, die
Sprachfelder und behält die zwei Defaults und den `browser_focus`-Hinweis (drei
`assert.match` pinnen genau das); `TOOL_TEXTS.NO_TRANSCRIPT_PANEL` wird auf
„keine Untertitelspur" umformuliert, `NO_TRANSCRIPT_PANEL_TEXT` in
`test/mcp.test.js` mit, und der Fall `..._whenThePanelIsMissing_...` heißt
`..._whenTheVideoHasNoCaptionTrack_shouldReturnTheNoTranscriptSentence`.
`TRANSCRIPT_RESULT` bekommt `requestedLanguage`, `deliveredLanguage`, `source`
(Zahlen konsistent halten: der Kommentar dort rechnet mit 32 Zeichen). Neue
Fälle: `mcp_toolsCallBrowserTranscript_shouldCarryTheLanguageFields` (Schlüssel
und Werte im Text, inkl. Schlüsselreihenfolge) und
`mcp_toolsCallBrowserTranscript_shouldNotLeakTheUrl` (der Text enthält weder
`timedtext` noch `signature`). **Und der Grund kommt an:** die Extension
liefert sechs benannte `transcript_failed`-Gründe (Kandidaten, „verweist auf
keine Untertitelspur", „englische Spur nicht eindeutig", „Datenmodell nicht
gefunden", „Spurendatei nicht gefunden", nicht lesbar); die Bridge antwortet
heute für **alle** mit dem statischen Satz „nur YouTube-Watch-Seiten haben
eines" — auf einer Watch-Seite ist das falsch. `TRANSCRIPT_FAILED` trägt
deshalb `details.message`, wenn vorhanden, nach dem Muster von
`offset_out_of_range`; Fall
`mcp_toolsCallBrowserTranscript_shouldPassTheFailureDetail`. `tools[12]`-Schema, `TOOL_COUNT` 13 und die
Werkzeugliste bleiben unangetastet. **Die Probe-Adresse liegt in den
Fehler-`details`, nicht in `TRANSCRIPT_RESULT`** — `details` ist der einzige
Pfad, den die Bridge überhaupt weiterreicht; im Ergebnisobjekt bräche sie den
Schlüssel-Pin und machte `shouldCarryTheLanguageFields` rot. Sie trägt einen
kurzen Platzhalter, keinen 32+-Hex-String — sonst wird Kriterium 11 auf dem
Fixture selbst rot.

Proof:

```
node --test --test-reporter=tap --test-name-pattern 'mcp_toolsCallBrowserTranscript' test/mcp.test.js | grep -c '^ok [0-9]* - mcp_toolsCallBrowserTranscript'   # ⇒ 12
node --test --test-reporter=tap --test-name-pattern 'mcp_toolsCallBrowserTranscript_should' test/mcp.test.js | grep -c '^ok [0-9]* - mcp_toolsCallBrowserTranscript_should'   # ⇒ 2
grep -c 'timedtext' bridge/mcp.mjs                      # ⇒ 0
grep -c 'transcript' bridge/hub.mjs                     # ⇒ 0
git diff -- bridge/hub.mjs                              # ⇒ leer
grep -c 'TOOL_COUNT = 13' test/http-mcp.test.js         # ⇒ 1 (unverändert; die Datei ist gesperrt)
npm test; echo $?                                       # ⇒ 0, "# fail 0" und "# cancelled 0"
```

---

**5. Abschluss und Live-Messung** (Orchestrator; die Messung macht der
Betreiber)

`## Bekannte Lücken` fortschreiben (3000 ms und ±1 s sind gewählt, nicht
gemessen; Resource-Buffer; Name-Mapping; `no_transcript_panel` trägt einen
Namen aus Teil 1), `## Log` um die Stufe-0-Befunde, `## Open questions` prüfen,
Prosa beschreibend, `status: active`, `## Amendments` **entfernen**,
`docs/README.md`/`PROJECT-STATE.md`/`ROADMAP.md` pflegen,
committen. Danach die Live-Kriterien 12 und 13 (Ausnahme mit Datum,
`CONTRIBUTING.md` `## Abnahme`): ein englisches und ein japanisches Video, erste drei
Segmente wörtlich, beide Sprachfelder wörtlich.

Proof: `grep -n '^status:' docs/33-spurwahl.md` ⇒ `status: active`;
`grep -c '^## Amendments' docs/33-spurwahl.md` ⇒ **0** (der Anker `^## ` ist
nötig, sonst zählt die Befehlszeile sich selbst);
`git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1;
`git status --porcelain` ⇒ nur `bridge/`, `extension/background.js`, `test/`,
`docs/`.

---

### What had to change in the Acceptance criteria

Der Architekt hat sie geprüft; diese Punkte sind in `## Acceptance criteria`
bereits korrigiert:

1. **Kriterium 1 und 2** zählten Zeilen in der Testdatei mit „≥". Jetzt
   **festgenagelt** (3 bzw. 5), dazu die `ok`-Läufe als zweiter Beleg — ein
   Kommentar, der einen Fallnamen nennt, hebt keinen `ok`-Zähler.
2. **Kriterium 3** verlangte „ohne Index", wofür es keinen Befehl gibt.
   Entscheidbar ist es über das Fixture: die Menüreihenfolge weicht von der
   Modellreihenfolge ab, sonst wäre ein Index-Pick nicht zu widerlegen.
3. **Kriterium 4, 5, 6** sind Namens-Greps; die `ok`-Zahlen aus Stufe 1 und 3
   sind der zweite Beleg, und Kriterium 6 pinnt die **exakte Schreibfolge**.
4. **Kriterium 9** war nicht ausführbar: `grep -c 'BROWSER_TRANSCRIPT
   bridge/mcp.mjs'` hat kein Dateioperand (der Dateiname stand im Muster), und
   die Zahl 3 war falsch — heute sind es **7**. Ersetzt durch zwei scharfe
   Greps.
5. **Kriterium 10** ist jetzt eine Ausschlussliste
   (`git status --porcelain | grep -vE …` ⇒ keine Ausgabe), damit auch
   `test/http-mcp.test.js` gesperrt bleibt.
6. **Kriterium 11** ist nur grün, solange auch das Fixture keine
   32+-Hex-Zeichenfolge trägt — Bauauflage, in Stufe 4 vermerkt.

### What could go wrong

- **Stufe 0 kann den Menü-Einstieg widerlegen.** Dann ist die Untertitel-Zeile
  im Player-Menü nur über ihren lokalisierten Namen erreichbar, und der Weg ist
  nicht sprachunabhängig (`## Ziel`). Das ist der eine Punkt, an dem dieses
  Inkrement scheitern darf; die Antwort ist der Rückweg in die Spec, nicht ein
  geratener Selektor.
- **Der Modellname ist nicht der Menütext.** `## Bekannte Lücken` sagt schon:
  die Zuordnung ist nicht 1:1. Der exakte Vergleich bricht dann ab — benannt,
  nicht still (`transcript_menuEntry_withoutMatch_shouldFail`). Treffen beide
  Live-Videos daneben, ist Kriterium 12/13 rot und das Inkrement geht zurück in
  die Spec, nicht in die Lückenliste.
- **Xray ist im Test nur nachgebildet.** Array-artige Fixture-Objekte erzwingen
  Index-Schleifen; ob `wrappedJSObject` im echten Profil dieselben Werte
  liefert, entscheiden allein Kriterium 12/13 (M2/M3).
- **Die Resource-Timing-Liste ist begrenzt.** Firefox hält standardmäßig wenige
  hundert Einträge; auf einer langen Watch-Seite kann der Eintrag evakuiert
  sein, obwohl der Player die Datei geholt hat. Deshalb ist der
  Sprung-und-nochmal-Versuch **auch** bei „keine Adresse" nötig, nicht nur bei
  einer abgelaufenen. Wer ihn nur als Wiederholung nach einem Fehlschlag baut,
  bekommt auf langen Seiten ein falsches `transcript_failed`.
- **Zwei Spuren mit gleichem `lang`.** Ohne den `kind`-Abgleich (M1: `a.` =
  ASR) sind manuelle und automatische englische Spur an der Adresse nicht
  unterscheidbar; dann gewinnt die falsche Fassung und das Werkzeug sieht
  gesund aus. Der Abgleich gehört deshalb in dieselbe Stufe wie die
  Adresswahl, nicht in eine spätere Verfeinerung.
- **Die zwei Zahlen sind gewählt, nicht gemessen:** 3000 ms Wartezeit auf die
  Adresse und der Sprung um ±1 s (Vorbild: die 5 s aus `docs/32`, dort
  ebenfalls gewählt). Sie gehören nach `## Bekannte Lücken`; der Aufruf bleibt
  mit ~3 s + `fetch` weit unter den 20 s aus `PROTOCOL.CALL_TIMEOUT_MS`.
- **Das Zurückstellen ist der letzte Schritt, nicht der vorletzte.** Spur vor
  Position, Position zuletzt, und beides vor jedem weiteren `throw` — sonst
  steht der Betreiber vor einem verschobenen Video, weil ein Fehler
  dazwischenkam.
- **Das Leck hat nur einen Weg, den man zumachen kann:** die Adresse darf den
  Schnipsel nicht verlassen. Deshalb liefert `transcriptCaptionSource` nur
  Cues, Zahlen und `deliveredLanguage`; ein Feld `url` im Rückgabewert wäre
  schon der Fehler. Der Fall `transcript_captionUrl_doesNotLeakIntoTheAnswer`
  prüft „kein `http` im JSON" — auch in Fehlermeldungen.
- **Stufe 1 ist die große und lässt sich nicht ohne rote Zwischenstufe teilen:**
  entweder das Panel ist die Quelle oder die Spurendatei, ein Zustand dazwischen
  hat keinen grünen Testlauf. Der einzige saubere Schnitt ist „ohne Menü" /
  „mit Menü" — genau Stufe 1 gegen Stufe 3. Blockt der Review Stufe 1 zweimal,
  wird sie nicht durchgewinkt, sondern die Regel (Modell + Zielspur) in eine
  eigene Spec gezogen.
- **Die Fensterlogik wird verschoben, nicht angefasst.** Wer sie beim Umzug
  „aufräumt", verliert `truncated = endLast < totalChars` und den
  `offset`-Hinweis aus `docs/32`, Kriterium 3 — die acht Fälle sind der
  Wächter.

### Ordering and dependencies

0 → 1 → 2 → 3 → 4 → 5. Stufe 0 ist read-only im Browser und kann neben Stufe 1
laufen; ihr Ergebnis bindet nur Stufe 3 (Menü-Anker). Stufe 2 zieht `docs/32` und `docs/31` nach, **weil** Stufe 1 das Verhalten
geändert hat. Das weicht **bewusst** von `docs/README` ab („in **der** Stufe
nachgezogen, die das Verhalten umsetzt"): der Umsetzer fasst keine
`docs/`-Datei an, und der Orchestrator schreibt erst, wenn Stufe 1 grün ist —
ein Schreiber pro Arbeitsbaum, nacheinander. Abweichung mit Grund, keine
Befolgung. Stufe 3 und 4 sind voneinander unabhängig (Antwortfelder stammen
aus Stufe 1, nicht aus Stufe 3), laufen aber nacheinander, weil beide denselben
Baum benutzen. Stufe 5 beschreibt den Ist-Zustand und geht deshalb zuletzt.

### What this increment inherits — and what stays open

- **Der Panel-Weg ist gelöscht, nicht stillgelegt** — er kommt nicht zurück; wer
  ihn will, schreibt eine eigene Spec (`## Messlauf der ersten Fassung` der ersten Fassung bleibt
  der Beleg, warum nicht).
- **`no_transcript_panel` ist ein Name aus Teil 1** und bedeutet jetzt „keine
  Untertitelspur im Modell". Umbenennen wäre ein neuer Code und damit eine
  eigene Spec; der Satz in der Bridge ist nachgezogen, der Name nicht.
- **Ungemessen bleiben:** die Gültigkeitsdauer der signierten Adresse, Videos
  mit 0 Cues, Live-Streams, Premieren, Shorts, Alters- und Regionssperren, das
  Holen im nie gerenderten Tab (`## Bekannte Lücken`).
- **Draußen bleiben:** der Übersetzungsweg (M9), Kapitel, Bild, andere
  Video-Hosts, `frame` und `mode` für dieses Werkzeug.
- **Das Fixture kann jetzt Player-Menü und `performance`-Einträge** —
  wiederverwendbar für jedes Werkzeug, das mit dem Player statt mit dem DOM
  redet, samt array-artiger Seitenobjekte für die Xray-Regel.
- **Offen und nicht angefasst:** die Aufteilung von `test/mcp.test.js` nach
  Werkzeugfamilien (`CONTRIBUTING.md`, `## Abnahme`, 90-s-Frist) und die fünf
  Werkzeugzahl-Pins, die unverändert bleiben.

## Risiken

*Konstruktionsrisiken gehören in den Dev-Plan. Hier nur die, die eine falsche
Zusage an den Agenten wären.*

- **Die Adresse ist ein Zugangsmittel.** Wer sie loggt oder in eine Antwort
  legt, gibt der Sitzung des Betreibers einen Schlüssel weiter. Kriterium 8
  und der Secret-Grep sind der Schutz.
- **Ein Sprung ins Video ist sichtbar.** Der Betreiber sieht den Player kurz
  springen; die Position wird zurückgestellt, das Bild flackert trotzdem.
- **`deliveredLanguage` ist jetzt eine Aussage.** Sie kommt aus der Adresse,
  nicht aus dem Text (M13) — was der Player dort anfragt, ist belegt; was der
  Text wirklich ist, bleibt YouTube.
- **Bleibt die Spurendatei aus, gibt es kein Transkript.** Die Spec nimmt das
  bewusst in Kauf: lieber ein benannter Fehler als ein deutscher Text, der als
  Original durchgeht.

## Touch boundary

- **Anfassen:** `bridge/mcp.mjs`, `extension/background.js`,
  `test/extension.test.js`, `test/mcp.test.js`,
  `test/fixtures/fake-extension.mjs`, `docs/README.md`, `docs/ROADMAP.md`,
  `docs/PROJECT-STATE.md`, `docs/32-transkript-werkzeug.md`
  (nur die Amendments), `docs/31-youtube-recherche.md` (nur die
  Amendments-Zeilen), diese Spec.
- **Nicht anfassen:** `bridge/hub.mjs` (kein Log), `bridge/protocol.mjs`,
  `extension/protocol.js`, `extension/manifest.json` (**keine neue
  Berechtigung**), `extension/options.*`, `bridge/http-transport.mjs`,
  `bridge/websocket.mjs`, `bridge/config.mjs`, `bridge/port-owner.mjs`,
  `test/http-mcp.test.js`, `test/protocol.test.js`, `test/bridge.test.js`,
  `test/deploy.test.js`, `scripts/check.mjs`, `package.json`, `INSTALL.md`.
- Keine neue Abhängigkeit, kein Token, kein Geheimnis. Die signierte
  Untertitel-Adresse wird **nirgends** abgelegt — nicht in Dateien, nicht in
  einer Antwort, nicht im Log.

## Bekannte Lücken

Stand 2026-11-12, vor der Umsetzung des neuen Zuschnitts:

- **Der Panel-Weg der ersten Fassung ist widerlegt** (`## Messlauf der ersten
  Fassung`). Er wird nicht gebaut; der Panel-Code aus Teil 1 wird nach dem
  Dev-Plan (Stufe 1) **gelöscht**. Erreichbar darf er für dieses Werkzeug nicht
  bleiben (Kriterium 4).
- **`checkedName` liest `aria-checked` — ungemessen (Code-Review, 2026-11-12).**
  Setzt YouTube das Attribut im Spuren-Menü nicht, bleibt `checkedName` leer:
  die Regel setzt dann immer (überflüssiger Klick) und stellt die Spur nie
  zurück. Der Fall `transcript_menuSetDidNotTakeEffect_shouldFail` deckt die
  Variante „Klick greift nicht", nicht die Variante „Markierung fehlt".
- **Der Menüzustand bei „Aus" ist eine Annahme (M16 hat nur den Zustand mit
  gewählter Spur gemessen).** Trägt die Zeile im Aus-Zustand keinen
  Spurnamen, findet der Anker sie nicht und der Aufruf scheitert benannt —
  das ist der häufigste Zustand überhaupt.
- **Ein Platzhalter-Loch zählt im Menüzähler mit** (`captionTracks + 2`), das
  Menü listet das Loch aber nicht ⇒ `row_miscount` verweigert konservativ.
- **Die Werkzeugbeschreibung sagt dem Agenten zwei Dinge nicht** (Code-Review,
  2026-11-12): dass das Werkzeug dafür die Untertitelspur setzt und im Player
  kurz springt (der Betreiber sieht das), und die Betreiberregel („ohne
  englische Spur bleibt das Original"). Der Agent sieht das Ergebnis, nicht
  die Regel — ein Halbsatz in `TRANSCRIPT_TOOL_DESCRIPTION` wäre billig.
- **Der generische `TRANSCRIPT_FAILED_MESSAGE` doppelt sich in der neuen
  Form** („ließ sich nicht lesen: Das Transkript der Seite konnte nicht
  gelesen werden."). Acht Wurfstellen schicken denselben Satz; ein eigener
  Grund je Stelle gehört in `extension/background.js`, nicht in die Bridge.
- **`test/mcp.test.js` ist auf 63 s / 151 Fälle gewachsen** (vorher 49–59 s /
  138). Die 90-s-Frist aus `CONTRIBUTING.md` bleibt gültig, der Puffer schrumpft;
  die dort notierte Aufteilung nach Werkzeugfamilien wird dringlicher.
- **Ohne Fall: mehrere Sprachen ohne brauchbaren Index.** Die Regel sagt
  „benannter Fehler", aber kein Test prüft sie (Code-Review, 2026-11-12);
  ebenso ungetestet: eine Spur plus ein Platzhalter-Loch ohne Index (liefert
  jetzt die Spur, vorher einen Fehler).
- **Ein Etikett kann lügen (live, 2026-11-12).** Auf `wKv-g1uEoDY` ist die
  einzige Untertitelspur `ja` (ASR) etikettiert und enthält deutschen Text —
  das Werkzeug nennt `requestedLanguage`/`deliveredLanguage` = `ja` und liefert
  deutschen Text. Spracherkennung ist `## Non-goals`; sichtbar ist das nur dem,
  der den Text liest. Kriterium 13 misst deshalb auf `SmxSCZzV7j0`.
- **Ein werfender Rückstell-Klick lässt das Menü offen** (Code-Review, 2026-11-12):
  das Schließen steht **vor** dem `finally` des Spur-Teils. Die Position wird
  in diesem Fall zurückgeschrieben (gepinnt), der Menüzustand nicht.
- **Der Pfad „kein Sprung möglich" (`seeked: false`, Livestream oder an beiden
  Videoenden) ist durch keinen Fall gedeckt.**
- **„Das tiefste Panel ist das zuletzt geöffnete" ist ungemessen.** M16 hat die
  **Zahl** der Einträge gemessen, nicht die Reihenfolge der Panels; ein falsches
  Panel fängt die Gegenprobe als `row_miscount` ab, aber die Annahme steht im
  Code und nicht in dieser Liste.
- **Die zweite Injection hängt am ungemessenen „die Elternzeile bleibt im DOM,
  wenn ihr Untermenü offen ist"** — sonst findet sie die Zeile nicht, wenn der
  Betreiber das Untermenü offen gelassen hat.
- **Das Menü wird synchron gelesen.** Baut YouTube das Untermenü in einem
  späteren Task, endet der Aufruf in `no_row`; ein begrenztes Nachlesen wäre
  billig (Code-Review, 2026-11-12).
- **`transcript_captionUrl_withoutMatch_shouldFail` prüft heute keinen
  fehlenden Treffer mehr** (die Adresse existiert, ihre Datei antwortet 404):
  `no_address` und `caption_failed` landen im selben Satz. **Follow-up**, nicht
  blockierend.
- **Adressen mit `tlang` (Auto-Übersetzung) sind nicht gemessen.** Das Werkzeug
  überspringt sie (Kriterium 4); ob es Fälle gibt, in denen **nur** eine
  übersetzte Adresse vorliegt, weiß niemand.
- **Wie lange die signierte Adresse gilt, ist nicht gemessen.** Gemessen ist
  nur: sie trägt unmittelbar nach dem Holen durch den Player.
- **Nicht gemessen: das Holen im Hintergrund-Tab.** Teil 1 verlangt
  „gerendert", also Vordergrund; ob die Spurendatei das auch braucht, weiss
  niemand. Das Gate aus Teil 1 bleibt deshalb stehen.
- **Nicht gemessen: Videos mit 0 Cues**, Live-Streams, Premieren, Shorts,
  Altersbeschränkung, regionsgesperrte Videos.
- **Die Zuordnung Menü-Name ↔ `languageCode` ist nicht 1:1.** Bei Varianten
  (`en`/`en-US`, `zh`/`zh-TW`/`zh-CN`) kann der exakte Vergleich scheitern;
  dann gibt es einen benannten Fehler, kein Raten. **Gemessen an einem Video**
  (M16): der Menütext ist derselbe String wie `captionTracks[i].name` — mehr
  als eine Stichprobe ist es nicht.
- **Der Overlay bleibt unerklärt** (M12): deutscher Text bei gewählter
  `ja`-Spur. Für dieses Inkrement ohne Belang — der Overlay wird nicht gelesen.
- **`vssId` sagt nicht, ob eine Spur hochgeladen oder übersetzt ist** (M1).
  Die Regel nimmt die englische Spur als das, was sie ist, und nennt ihre
  Sprache.

## Open questions

**Neu offen seit M18 (2026-11-12, abends): der Weg zur Spurendatei ist
live nicht beobachtbar.** Alles andere ist entschieden.

1. **Wo kommen die Cues her, wenn nicht aus `performance`?** Gemessen ist nur,
   dass die Seite sie hat (Overlay, Panel mit 133 Segmenten) und dass der
   gelesene Kanal für Seiten-Anfragen blind ist (M18). **Nicht gemessen:**
   ob die Seite `api/timedtext` überhaupt anfragt (und wenn ja: über `fetch`,
   `XHR` oder einen Worker), und ob ein Haken **vor** dem Player-Start das
   sieht. Die Antwort entscheidet, ob der Weg reparierbar ist: einen Haken
   kann man bauen, einen fehlenden Request nicht.
2. **Soll das Werkzeug auf das Panel zurückfallen, wenn keine Adresse
   kommt?** Das Ziel sagt „kein stiller Rückfall" — ein **benannter** Rückfall
   (Sprache unbekannt, `deliveredLanguage: null`) wäre ehrlich, aber die
   Spec müsste ihn wollen.
3. **Oder zurück auf Teil 1?** Der Stand vor Stufe 1 las das Panel und lieferte
   Text — in der Sprache der Oberfläche. Für die Recherche brauchbar, für die
   Betreiberregel falsch.
4. **Oder den Overlay-Weg?** M12: der Overlay trägt die gewählte Spur, aber
   immer nur die **aktuelle** Zeile (Springen und Sammeln; lossy, langsam).

**Keine offenen, die den Bau blockieren.** Entschieden am 2026-11-12 vom
Betreiber: Text aus der Spurendatei; vorherige Spur zurückstellen; springen und
die Position zurückstellen.

Zwei Feststellungen, die **nicht** blockieren:

1. **Gilt die Regel auch, wenn die „englische Spur" eine hochgeladene
   Übersetzung ist?** M1 zeigt: das `vssId`-Prefix unterscheidet es nicht. Die
   Spec nimmt die englische Spur als das, was sie ist, und nennt die Sprache.
2. **Soll der YouTube-Übersetzungsweg (M9) später doch gebaut werden?** Diese
   Spec sagt nein (`## Non-goals`). Wird er gewünscht, ist das eine eigene Spec
   mit der Sprachabhängigkeit als bewusster Entscheidung.

## Review

### Runde 1 — 2026-11-12, `grizzled-senior-dev`: 🔧 Fix these

Neunzehn Befunde: zwei Blocker, fünf Major, zehn Minor, zwei Nits. **Alle
übernommen**; die Einzelzeilen stehen in `## Log`.

- **B1** Der Stufe-2-Proof war unerfüllbar, weil die Greps die Geschichte in
  `docs/32` (`## Dev plan`, `## Log`) mitzählten → der Proof zählt jetzt
  abschnittsweise.
- **B2** Die Amendments an `docs/31` waren keinem Schritt zugeordnet und von
  Kriterium 10 verboten → `docs/31-youtube-recherche.md` steht in Stufe 2, in
  der Touch-Boundary und in der Allowlist.
- **M1** `docs/32` verbietet in `## Non-goals` genau die neue Mechanik →
  beide Bullets sind in Stufe 2 eingeplant.
- **M2** `no_transcript_panel` verlor mit dem Panel-Code seinen einzigen Test →
  `transcript_model_withoutCaptionTrack_shouldFailNoPanel`.
- **M3** `deliveredLanguage` kann per Konstruktion nicht abweichen → `## Ziel`
  sagt jetzt „erwartet ist Gleichheit".
- **M4** M10 und M7 lasen sich als geltendes Verhalten → Nachtrag bei M10, neue
  Kriteriennummern bei M7.
- **M5** Kriterium 8 wurde von einem Test entschieden, der nichts entscheiden
  kann → `transcript_captionUrl_doesNotLeakIntoTheAnswer` ist der Beweis, die
  Probe-Adresse liegt in den Fehler-`details`.
- **N1–N10** übernommen (doppelte Einleitung, Verweise auf den Messlauf, eine
  Regel für Setzen und Springen, `ok`-Läufe zu Kriterium 3 und 7, `kind` in
  Kriterium 4, Tautologie-Pin in Kriterium 9, Rückweg in die Spec statt in die
  Lückenliste, README-Abweichung mit Grund, gelöschter Panel-Code, TAP-Form).

### Runde 2 — 2026-11-12, Gegenprüfung der Fixes: 🔧 Fix these

Fünfzehn Punkte mit Beleg grün, die Zahlen gegen den Baum nachgerechnet. Drei
offen — alle drei Zeilenänderungen:

- **`deliveredLanguage`**: Stufe 1 sagte weiter „`null` ohne Parameter",
  während `## Ziel` „benannter Fehler, kein `null`" verlangt → Stufe 1
  gleichgezogen, Kriterium 4 nennt den Fall ausdrücklich.
- **Diese Runde selbst fehlte** in `## Review`, und `## Log` sagte „Noch keine
  Review-Befunde" (`CONTRIBUTING.md`, Schritt 4) → hier nachgetragen.
- **Sprachmix** der Dev-Plan-Unterabschnitte → `### What had to change in the
  Acceptance criteria`.

### Code-Review Runde 1 (Stufe 1) — 2026-11-12, `grizzled-senior-dev`: 🔧

Zwei Major, zwei Minor, ein NIT. **Alle übernommen** (Zeilen in `## Log`).

- **M1** `captionTracksOf` ließ nicht-Spuren weg und verschob damit den Index,
  auf den `defaultCaptionTrackIndex` zeigt (Fixture mit Loch lieferte `en`
  statt `de`) → die Kopie behält jetzt die Position; ein Loch ist ein
  benannter Fehler. Zwei Fälle, beide mutationsgeprüft.
- **M2** `transcript_languageForTrack_withEnglishOriginal` konnte den
  `en`-Zweig nicht widerlegen → Fixture trägt eine zweite englische Spur
  (`en-GB`); den `en`-Zweig zu entfernen macht den Fall jetzt rot.
- **m1** `addressOf` nahm Adressen mit `tlang` → übersprungen, neuer Fall.
- **N1** Leerzeichen-Faltung deckte nur ASCII ab → jetzt Leerzeichen, Tab und
  `\u00a0`.
- **Vor Stufe 4 gemerkt:** der `transcript_failed`-Satz der Bridge ist statisch
  und falsch auf einer Watch-Seite → Kriterium 14 und eine Zeile in Stufe 4.

### Runde 4 — 2026-11-12, Spurregel: `✅ Ship it`

Der Live-Lauf auf `v=<video-ja>` hat eine Lücke in M2 gezeigt (ein
Audiotrack, `audioTrackId` fehlt). Der Betreiber hat am selben Tag entschieden:
**genau ein Audiotrack ⇒ dieser ist der Original.** Der Zusatz ist eine Zeile
plus Fall, mutationsgeprüft; der Reviewer hat ihn mit `✅` abgenommen und
festgehalten, dass `test/hub.test.js` einmal zeitabhängig rot war (200-ms-Frist
auf belasteter Maschine) — **Vorbestand, nicht dieses Inkrement**. Die
Entscheidung ist dieselbe wie 2026-11-11, nur präziser; die Spec ändert ihren
Zuschnitt nicht, deshalb keine neue Spec-Runde.

### Runde 3 — 2026-11-12: keine weitere Runde, Gate per Zusage offen

Der Reviewer hat in Runde 2 festgehalten: „beide sind Zeilenänderungen, danach
ist das Gate offen." Beide sind geändert und mechanisch belegt:

```
grep -c '^### Runde' docs/33-spurwahl.md                  # ⇒ 3 (die Runden stehen jetzt hier)
grep -c '^- \*\*Noch keine' docs/33-spurwahl.md              # ⇒ 0
grep -n '^  `transcript_failed` — kein `null`' docs/33-spurwahl.md   # ⇒ 1 (Stufe 1 sagt dasselbe wie `## Ziel`)
```

Damit gilt das Gate als offen — nach der Zusage des Reviewers, nicht nach einer
dritten Prüfung. Gebaut wird ab hier nach dem `## Dev plan`, beginnend mit
Stufe 0.

## Log

Je Befund eine Zeile (aus `CONTRIBUTING.md`, Schritt 4).

- **Runde 1 (2026-11-12) — B1 übernommen:** Stufe-2-Proof zählt jetzt
  abschnittsweise (`sed -n '/^## Testing/,/^## Acceptance criteria/p'`).
- **Runde 1 — B2 übernommen:** `docs/31` steht in Stufe 2, in der
  Touch-Boundary und in der Allowlist von Kriterium 10.
- **Runde 1 — M1 übernommen:** beide `## Non-goals`-Bullets aus `docs/32`
  (`Keine Caption-API`, `Oberflächensprache entscheidet`) sind in Stufe 2
  eingeplant.
- **Runde 1 — M2 übernommen:** neuer Fall
  `transcript_model_withoutCaptionTrack_shouldFailNoPanel`, in `## Testing` und
  in Stufe 1.
- **Runde 1 — M3 übernommen:** „erwartet ist Gleichheit"; Abweichung wäre ein
  Fehler, nicht `null`.
- **Runde 1 — M4 übernommen:** Nachtrag bei M10, M7 verweist auf Kriterien
  12/13, „Stufe 3" ist als Stufe der ersten Fassung markiert.
- **Runde 1 — M5 übernommen:** Kriterium 8 nennt
  `transcript_captionUrl_doesNotLeakIntoTheAnswer`; die Probe-Adresse liegt in
  den Fehler-`details`.
- **Runde 1 — N1 bis N10 übernommen:** doppelte Einleitung gelöscht;
  Messlauf-Verweise einheitlich; eine Regel für Setzen und Springen;
  `ok`-Läufe zu Kriterium 3 und 7; `kind`-Abgleich in Kriterium 4;
  `TOOL_COUNT`-Grep als „entscheidet nichts" gekennzeichnet; Stufe 0 geht
  zurück in die Spec (nicht in die Lückenliste); Reihenfolge-Abweichung mit
  Grund; Panel-Code wird gelöscht; TAP-Form für `# fail 0`; „an vier Stellen
  gepinnt"; Kriterium 10 als Codeblock; Unterabschnitte einsprachig.
- **Runde 2 (2026-11-12) — übernommen:** Stufe 1 verlangt bei fehlendem
  `lang`-Parameter `transcript_failed` statt `null`, Kriterium 4 nennt den
  Fall; Runde 1 und 2 stehen in `## Review`; der Sprachmix ist behoben.
- **Stufe 0 (2026-11-12) — M16:** der Menü-Einstieg läuft über den
  `.ytp-menuitem-content`, der einem `name` aus dem Modell entspricht („Japanisch");
  Gegenprobe: 33 Untermenü-Einträge = 31 + „Aus" + „Automatisch übersetzen".
  Das lokalisierte Label wird nicht gebraucht.
- **Stufe 0 — M17:** ein Sprung bei pausiertem Video holt die Spurendatei
  (`lang=de`, 49 261 Bytes); ohne Sprung und ohne Abspielen holt der Player
  nichts (0 Einträge). Abspielen genügt auch — der Sprung ist der billigere Weg.
- **Code-Review Runde 1 (2026-11-12) — M1 übernommen:** `captionTracksOf`
  behält die Position, ein Loch ist ein benannter Fehler;
  `transcript_model_keepsPositionsWithAHoleInTheCaptionList` und
  `…_holeAtTheOriginalIndex_shouldFail`.
- **Code-Review Runde 1 — M2 übernommen:** zweite englische Spur im
  `en`-Fixture; Mutation des `en`-Zweigs ist rot.
- **Code-Review Runde 1 — m1 übernommen:** `tlang`-Adressen werden
  übersprungen (`transcript_captionUrl_skipsTranslatedAddresses`).
- **Code-Review Runde 1 — N1 übernommen:** Faltung deckt Tab und `\u00a0`.
- **Code-Review Runde 1 — m2 vorgemerkt:** der statische
  `transcript_failed`-Satz braucht `details.message`; als Kriterium 14 und
  Stufe-4-Zeile aufgenommen, nicht in Stufe 1 gebaut.
- **Stufe 3 (2026-11-12) gebaut:** Menü nach dem Modellnamen (Anker
  `.ytp-menuitem-content`, Gegenprobe `captionTracks + 2`, **plus eins** bei
  einem Paar-Eintrag `… >> …`), Sprung ±1 s,
  Polling 3000 ms, ein Wiederholungsversuch, Zurückstellen Spur vor Position.
- **Code-Review Runde 1 (Stufe 3) — M1 übernommen:** der `>>`-Filter war toter
  Code (die exakte Gleichheit schließt den Paar-Eintrag schon aus) → gestrichen,
  der Fall nagelt jetzt `===` gegen `includes` fest.
- **Code-Review Runde 1 — M2 übernommen:** Klicks und Positions-Schreibungen
  liegen in **einem** Ereignisprotokoll; die verschränkte Folge
  (`click` → `write` → `click` → `write`) ist gepinnt.
- **Code-Review Runde 1 — M4 übernommen:** `transcript_captionRow_miscount_shouldFail`
  deckt die Gegenprobe ab.
- **Code-Review Runde 1 — m5/m6 übernommen:** Flags direkt nach dem `await`,
  Position im `finally`; `set` liest `checkedName` nach dem Klick neu.
- **Nachbesserung außerhalb der Befunde:** `closeMenu()` klickte blind und
  öffnete ein bereits geschlossenes Menü wieder → nur schließen, wenn es offen
  ist und von diesem Aufruf stammt; zwei Fälle pinnen den Menüzustand.
- **Code-Review Runde 2 (Stufe 3) — Blocker übernommen:** `set` las die Marke
  nach dem Klick aus dem Array von vor dem Klick; auf einer Seite, die das
  Popup neu baut, scheiterte damit ein korrekter Lauf. Jetzt wird bei
  Nichtübereinstimmung **einmal** frisch geöffnet und dann geworfen. Fall
  `transcript_menuCheckedOnlyWhenOpen_shouldStillSucceed`, Mutationsprobe rot.
- **Code-Review Runde 2 — zwei kleine Punkte übernommen:** `changed.position`
  folgt dem `seeked`-Flag; ein Fall pinnt die Positions-Schreibung im
  `finally` (`transcript_positionRestoredEvenWhenTheTrackRestoreThrows`).
- **Stufe 4 (2026-11-12) gebaut:** `TRANSCRIPT_TOOL_DESCRIPTION` beschreibt die
  Spurendatei und die Sprachfelder (Defaults und `browser_focus`-Hinweis
  unverändert), `NO_TRANSCRIPT_PANEL` heißt jetzt „keine Untertitelspur",
  `transcriptFailedText` reicht `details.message` weiter (Kriterium 14), das
  Fixture trägt die drei Sprachfelder vorn, drei neue Fälle.
- **Code-Review Runde 1 (Stufe 4) — M1/M2/M3 übernommen (Kommentare):** die
  Zahl „six" in `transcriptFailedText` ist durch die vollständige Aufzählung
  ersetzt; die Panel-Begründung für „kein `frame`" ist auf „eine Spurendatei"
  gezogen (Testkopie mit); die Liste der Codes mit `details.message` nennt die
  beiden Transkript-Codes.
- **2026-11-12, Rangfolge ohne Index (live gemessen):** `v=<video-ja-2>` hat
  zwei `ja`-Spuren ohne `defaultCaptionTrackIndex`; jetzt entscheidet manuell
  vor ASR, zwei manuelle ⇒ benannter Fehler. Fälle:
  `transcript_languageForTrack_withTwoTracksOfTheSameLanguageAndNoIndex`,
  `…_withTwoManualTracksAndNoIndex_shouldFail`.
- **2026-11-12, Menü-Anker an die gemessene Form angepasst (live):** die Zeile
  trägt bei Auto-Übersetzung ein `>> …`, das der Anker jetzt abschneidet; die
  Gegenprobe zählt einen Paar-Eintrag als einen zusätzlich. Drei Fälle pinnen
  das (`_withATranslatedSuffix_stillFindsTheRow`,
  `_withAPairEntry_countsOneMore`, `_miscountWithAPairEntry_namesTheRealCount`).
- **2026-11-12, Spurregel ergänzt (live gemessen):** genau ein Audiotrack ⇒
  dieser ist der Original (`transcript_trackForOriginalAudio_withASingleTrackWithoutId`,
  mutationsgeprüft). Grund: `v=<video-ja>` hat einen Eintrag **ohne**
  `audioTrackId`.
- **Stufe 5 (2026-11-12) — Abnahme, soweit ohne Browser möglich:** Kriterien
  1–11 und 14 mit ihren Befehlen belegt (3/5/4/5/2 Fälle, `defaultAudioTrackIndex`
  0, `transcript` in `bridge/hub.mjs` 0, `TOOL_COUNT` 1, `BROWSER_TRANSCRIPT`
  unverändert 7, Allowlist leer, Secret-Grep leer); `npm test` 720 grün.
  **Kriterien 12 und 13 offen** — sie brauchen den Browser des Betreibers.
  `status` bleibt `proposed`, `## Amendments` bleibt stehen.
- **Live-Messung (2026-11-12, abends) — Kriterium 12 rot:** der
  Werkzeugaufruf endet mit `no_address`; `performance` zeigt keine
  `timedtext`-Adresse, und der Kanal ist blind für Anfragen der Seite
  (Kontrollprobe mit eigenem `<img>`). Die Messung aus M13 ließ sich nicht
  reproduzieren — aufgenommen als **M18**; die Kernannahme von Stufe 1/3 steht
  damit live nicht.
- **Zwei sichtbare deutsche Sätze wurden umformuliert** („Untertitelspur" →
  „Transkriptspur"), weil der Beweis `grep -c 'Untertitel' ⇒ 0` es erzwingt;
  kein Test pinnt sie (Code-Review, m10).
- **Runde 3 (2026-11-12): keine weitere Prüfung.** Der Reviewer hatte sie in
  Runde 2 zur Bedingung gemacht („danach ist das Gate offen"); beide
  Zeilenänderungen sind mit Greps belegt. Gate offen.
- **2026-11-12, Messlauf (Betreiber und Agent): Kriterium 9 gemessen, rot.**
  Sechs Eingriffe — Spur, ASR-Spur, Thai-Spur, Übersetzungsziel, jeder mit
  Neuladen —, das Panel bleibt deutsch mit identischen 19 777 Zeichen.
  Ursache: die `params` tragen `de` aus `hl=de`. Aufgenommen als
  `## Messlauf der ersten Fassung`.
- **2026-11-12, M6 korrigiert:** die `params` tragen sehr wohl eine Sprache —
  verschachtelt und URL-kodiert. Die alte Zeile „keine Sprache“ war falsch.
- **2026-11-12, Betreiberentscheid:** Teil 2 auf Eis, Grenze dokumentieren,
  kein Code. `status` bleibt `proposed`; der Panel-Neuaufbau bleibt gesperrt.
- **2026-11-12, Nachtrag:** der Untertiteltext ist doch erreichbar — Overlay
  (sprachlich unzuverlässig, M12) und `api/timedtext` (ganze Spur mit
  Zeitstempeln, 286 Cues `en`, 413 Cues `ja`, M13).
- **2026-11-12, Betreiberentscheid (zweite Runde):** Teil 2 wird auf die
  **Spurendatei** umgeschrieben; nach dem Lesen werden **vorherige Spur und
  Abspielposition zurückgestellt**. Der Panel-Neuaufbau entfällt. Aufgenommen
  in `## Ziel`, `## Die Entscheidungen des Betreibers` und
  `## Acceptance criteria`.
- **Teilung (2026-11-12):** siehe `docs/32`, `## Log`. Der Betreiber hat die
  Naht bestätigt („Lesen zuerst, Spurwahl danach").
- **Die Betreiberregel (2026-11-11), wörtlich:** „Standard sollte immer die
  Originalspur sein, wenn sie nicht englisch oder deutsch ist, dann die
  englische Übersetzung." Sie steht in `## Ziel` und ist dort konkretisiert;
  die Konkretisierung („sonst das Original nehmen") ist die Entscheidung des
  Betreibers vom selben Tag.
