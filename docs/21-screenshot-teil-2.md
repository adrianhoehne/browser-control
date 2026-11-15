---
description: browser_screenshot (Teil 2) liefert das Bild als MCP-Bildblock (type image) statt als Base64-Text, damit der Agent es wirklich sieht; dazu steigt die Bildgrenze auf 3 MiB, die Socket-Grenze auf 5 MiB und die Aufruffrist auf 20 s.
status: active
---

# Das Bild ankommen lassen: `browser_screenshot`, Teil 2 (MCP-Bildinhalt)

Teil 1 (Spec 20) hat den Transport gebaut: die Extension liefert PNG oder JPEG als
Base64, mit Größen- und Formatgrenze und einer Verkleinerungsleiter. Für den
Agenten ist das aber noch **Text** — ein Base64-Blob, den er nicht sehen kann.
Teil 2 macht daraus einen **Bildinhalt** im MCP-Protokoll (`type: "image"`), den
ein Modell tatsächlich anschaut.

Beim Nachmessen der Grenzen (Frage des Betreibers: „was ist eine übliche
Grenze?") kam heraus, dass **unser eigener Socket** der Engpass ist, nicht das
Modell: `PROTOCOL.MAX_MESSAGE_BYTES` = 1 MiB, und Base64 bläht um 4/3 auf. Die
verbreitetste Bildgrenze der Anbieter liegt bei **5 MB Base64** (Anthropic;
OpenAI und Gemini bei 20 MB). Deshalb hebt dieses Inkrement die Grenzen an — sonst
wäre „gute Bilder über 2 MiB" von vornherein ausgeschlossen.

## Ziel

Ein `browser_screenshot`-Aufruf liefert **zwei** Content-Blöcke:

```json
{"jsonrpc":"2.0","id":12,"result":{"content":[
  {"type":"text","text":"{\n  \"tabId\": 4,\n  \"url\": \"https://example.org/\",\n  \"title\": \"Example Domain\",\n  \"format\": \"png\",\n  \"width\": 1904,\n  \"height\": 853,\n  \"bytes\": 99232,\n  \"scaled\": false,\n  \"activated\": false\n}"},
  {"type":"image","mimeType":"image/png","data":"iVBORw0…"}
]}}
```

- **Der erste Block ist Text** und trägt die Metadaten wie bisher — aber **ohne**
  `base64`-Feld. Was das Bild ist, steht damit auch für ein Modell lesbar da, das
  den Bildblock nicht auswertet.
- **Der zweite Block ist das Bild**: `type: "image"`, `mimeType` aus dem `format`
  des Ergebnisses (`image/png` oder `image/jpeg`), `data` als reines Base64
  **ohne** `data:`-Präfix — so verlangt es das MCP-Protokoll.
- **Die Reihenfolge ist Vertrag**: Text zuerst, Bild danach.
- **Keine Verdopplung.** Das Base64 steht **nur** im Bildblock. Zwei Kopien
  desselben Bildes wären die doppelte Nutzlast für einen Vorteil, den niemand
  braucht.
- **Die Grenzen, neu gezogen:**
  - `SCREENSHOT_MAX_BYTES = 3145728` (3 MiB dekodiert) → Base64 höchstens
    4 194 304 Byte, also unter den 5 MB, die Anbieter als Bildgrenze führen.
  - `PROTOCOL.MAX_MESSAGE_BYTES = 5242880` (5 MiB) → Luft für Base64 plus
    Nachrichtenrahmen auf dem Socket.
  - `PROTOCOL.CALL_TIMEOUT_MS = 20000` (20 s) → drei Leiterstufen à 3 s plus
    Kodieren und Übertragen passen hinein, statt als `ExtensionTimeout` zu enden.
  - Die HTTP-Anfragegrenze bleibt bei **1 MiB** und wird dafür von der
    Socket-Grenze entkoppelt.
- **`screenshot_too_large` bleibt eine Ablehnung** mit den Zahlen der letzten
  Leiterstufe; ein zu großes Bild wird **nicht** still gekürzt, um es in eine
  Antwort zu quetschen.
- **Fehler bleiben Fehler**: `screenshot_failed`, `screenshot_not_allowed`,
  `screenshot_too_large`, `no_agent_tab`, `invalid_params` liefern unverändert
  **nur** einen Textblock mit `isError: true`.

## Non-goals

- **Kein neues Werkzeug.** `browser_screenshot` behält sein Schema (`{tab?}`);
  nur der Inhalt der Antwort ändert sich.
- **Keine neuen Protokoll-Methoden.** Geändert werden zwei **Zahlen** im
  bestehenden `PROTOCOL` (`MAX_MESSAGE_BYTES`, `CALL_TIMEOUT_MS`), keine Schlüssel.
- **Kein Chunking und keine Dateiablage.** Ein Bild ist eine Nachricht; wenn es
  nicht passt, wird es abgelehnt (Leiter) — kein Aufteilen in Häppchen.
- **Kein Weichzeichnen, keine Schwärzung, keine Markierung** im Bild. Der
  Schalter aus Teil 1 ist die Entscheidung.
- **Keine Bilder aus `read` oder `inspect`**, kein PDF-Rendering, kein
  Video-Frame — eigene Zeilen, wenn sie kommen.
- **Keine Bildkompression auf der Bridge.** Was die Leiter geliefert hat, geht
  raus.
- **Kein Streaming.** Die Antwort ist eine JSON-RPC-Nachricht wie jede andere.

## Wire-Protokoll (zwei Zahlen geändert)

`PROTOCOL.METHODS.SCREENSHOT` und die Antwortform bleiben, wie Spec 20 sie
festgelegt hat. In **beiden** Kopien (`extension/protocol.js`,
`bridge/protocol.mjs`) ändern sich nur:

| Konstante | alt | neu | Grund |
|---|---|---|---|
| `MAX_MESSAGE_BYTES` | 1 048 576 | 5 242 880 | 3 MiB Bild = 4 194 304 Byte Base64 plus Rahmen |
| `CALL_TIMEOUT_MS` | 10 000 | 20 000 | drei Leiterstufen (3 s) plus Kodieren/Übertragen |

Der bestehende `deepStrictEqual`-Vergleich beider Kopien deckt den Gleichlauf ab;
je ein wörtlicher Fall pinnt zusätzlich die beiden neuen Zahlen, damit die
`deepStrictEqual`-Blindheit (beide Seiten falsch) nicht greift.

## MCP-Werkzeug (Antwortform neu)

- `screenshotTool` liefert statt `textResultMessage(...)` einen eigenen Aufbau
  `screenshotResultMessage(id, result)`:
  - `{ type: "text", text: JSON.stringify(metadaten, null, 2) }` mit
    `metadaten = {…result}` **ohne** `base64`,
  - `{ type: "image", mimeType, data }` mit `mimeType` aus `format`.
- Ein `format`, das weder `"png"` noch `"jpeg"` ist, ist ein Fehler **unserer**
  Seite: dann antwortet der Aufruf mit `isError: true` und dem allgemeinen Satz,
  statt ein Bild mit geratenem MIME zu schicken.
- `format: "png"` ⇒ `mimeType: "image/png"`, `format: "jpeg"` ⇒
  `"image/jpeg"` — eine feste Zuordnung, zwei Einträge, kein Raten.
- Die Werkzeugbeschreibung wird ergänzt: „liefert das Bild als MCP-Bildinhalt,
  die Zahlen als Textblock daneben".

## Hub

Die Logzeile aus Teil 1 (`screenshot tab=… bytes=… format=… scaled=… ok=true`)
bleibt die einzige Spur, **kein** Base64 im Journal — auch nicht im Debug-Block.
`CALL_TIMEOUT_MS` steigt auf 20 s; der Hub liest die Zahl aus `PROTOCOL`, es gibt
keine zweite Stelle.

## Bridge (Transport)

- `bridge/http-transport.mjs`: `MAX_BODY_BYTES` wird eine **eigene** Konstante
  `1048576` mit eigenem Kommentar (Grund: eine Anfrage ist ein Aufruf, kein
  Bild; die Socket-Grenze ist keine Anfragegrenze). Der Test, der die 413-Antwort
  bei zu großem `Content-Length` prüft, bleibt in seiner Aussage gleich, pinnt
  aber die **1 MiB** und nicht mehr `PROTOCOL.MAX_MESSAGE_BYTES`.
- `bridge/websocket.mjs`: keine Codeänderung — die Grenzen kommen aus
  `PROTOCOL`; die Tests, die ein zu großes Frame mit `1009` ablehnen, rechnen mit
  der neuen Zahl statt mit einer Literal-Kopie.
- Der stdio-Pfad (`handleMessageText`) prüft weiter gegen
  `PROTOCOL.MAX_MESSAGE_BYTES`; eine 5-MiB-Zeile wird also angenommen, eine
  größere mit `-32700` beantwortet.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/mcp.test.js` | `browser_screenshot` liefert **zwei** Blöcke: `["text","image"]` in dieser Reihenfolge | die neue Antwortform |
| `test/mcp.test.js` | der Textblock ist gültiges JSON **ohne** `base64`-Feld, mit allen neun Metadatenfeldern, unter 1 024 Zeichen | keine Verdopplung, keine Metadaten verloren |
| `test/mcp.test.js` | `image.mimeType` ist `image/png` bei `format: "png"`, `image/jpeg` bei `"jpeg"` | die Zuordnung |
| `test/mcp.test.js` | `image.data` beginnt bei PNG mit `iVBORw0`, bei JPEG mit `/9j/`; `Buffer.from(data,"base64").length === bytes` | das Base64 ist das Bild, kein Platzhalter |
| `test/mcp.test.js` | `format: "gif"` ⇒ `isError: true`, **kein** Bildblock | kein geratenes MIME |
| `test/mcp.test.js` | alle fünf Ablehnungscodes liefern genau **einen** Textblock mit `isError: true` | Fehler bleiben Fehler |
| `test/http-mcp.test.js` | Antwort mit `bytes: 3145728` (4 194 304 Byte Base64) kommt vollständig an, `JSON.parse` gelingt | der Transport trägt 3 MiB |
| `test/http-mcp.test.js` | eine **Anfrage** über 1 MiB wird weiter mit 413 abgelehnt, obwohl der Socket 5 MiB erlaubt | Anfrage- und Socket-Grenze sind entkoppelt |
| `test/websocket.test.js` | ein Frame über `MAX_MESSAGE_BYTES` wird mit `1009` abgelehnt; ein Frame mit 4 200 000 Byte geht durch | die neue Socket-Grenze wirkt |
| `test/protocol.test.js` | `MAX_MESSAGE_BYTES === 5242880` und `CALL_TIMEOUT_MS === 20000` auf **beiden** Seiten wörtlich — und **kein** neuer 20-s-Hub-Fall (`test/hub.test.js` bleibt mit injizierter Frist) | die zwei Zahlen, gegen die Blindheit des Objektvergleichs, ohne 20 s Suite-Zeit |
| `test/extension.test.js` | Bild mit genau 3 145 728 Bytes ⇒ `ok`; 3 145 729 ⇒ Leiter greift | die neue Grenze ist exakt, die Leiter bleibt |
| `test/mcp.test.js` | die Werkzeugbeschreibung nennt „Bild" | ein Agent weiß, was er bekommt |

Die bestehenden Fälle bleiben grün bis auf die, die eine Literal-Kopie der alten
Zahlen tragen (`MAX_MESSAGE_BYTES`, `CALL_TIMEOUT_MS`, `SCREENSHOT_MAX_BYTES`) —
die werden nachgezogen, nicht gelöscht. Die zwei `browser_screenshot`-Fälle aus
Teil 1, die einen Textblock mit Base64 erwarten, werden umgeschrieben.

## Acceptance criteria

**Ausnahme mit Datum** (2026-10-27, `CONTRIBUTING.md`, `## Abnahme`): die Live-Kriterien
9 und 10 sind erst nach dem `git pull` im eigenen Klon und dem Reload der
Erweiterung messbar, also nach dem Commit; fällt eines rot aus, wird vorwärts
korrigiert und die rote Zeile steht unter `## Bekannte Lücken`. **Kernannahme** ist
Kriterium 9.

1. **Zwei Blöcke, Text zuerst** (lokal). `content.length === 2`,
   `content[0].type === "text"`, `content[1].type === "image"`.
2. **Der Textblock trägt die Metadaten ohne Base64** (lokal). Gültiges JSON mit
   `tabId`, `url`, `title`, `format`, `width`, `height`, `bytes`, `scaled`,
   `activated` (neun Felder); **kein** `base64`-Feld. Die Schranke „unter 1 024
   Zeichen" gilt für den **Testfall** mit seiner kurzen Fixture — `screenshot`
   kappt `url`/`title` im Unterschied zu `read` nicht (siehe `## Risiken`).
3. **Das Bild stimmt** (lokal). `mimeType` passt zu `format`; `data` ohne
   `data:`-Präfix; `Buffer.from(data,"base64").length === bytes`; Kopf `iVBORw0`
   bzw. `/9j/`.
4. **Unbekanntes Format wird abgelehnt** (lokal). `format: "gif"` ⇒ `isError`,
   kein Bildblock.
5. **Fehler bleiben Fehler** (lokal). Die fünf Ablehnungscodes liefern je genau
   einen Textblock und kein Bild.
6. **Der Transport trägt 3 MiB** (lokal). HTTP-Antwort mit 4 194 304 Byte Base64
   kommt vollständig und parsebar an; eine Anfrage über 1 MiB wird weiter
   abgelehnt.
7. **Die zwei Zahlen gelten auf beiden Seiten** (lokal).
   `MAX_MESSAGE_BYTES = 5242880`, `CALL_TIMEOUT_MS = 20000` in
   `extension/protocol.js` **und** `bridge/protocol.mjs`, je wörtlich gepinnt;
   ein Frame mit 4 200 000 Byte geht durch, eines über 5 MiB wird mit `1009`
   abgelehnt.
8. **Die neue Bildgrenze ist exakt** (lokal). 3 145 728 Byte ⇒ `ok`; 3 145 729 ⇒
   Leiter greift. Die vier Stufen in `SCREENSHOT_SCALE_STEPS` bleiben unverändert
   — nachgezogen wird nur die Zahl in der Leitertabelle von Spec 20
   (`docs/20:48`).
9. **Ich sehe das Bild** (live, Kernannahme). In einer pi-Sitzung mit dem neuen
   Dienst liefert `browser_screenshot` ein Bild, und ich beschreibe daraus etwas,
   das nicht aus `read`/`inspect`/`eval` stammt (z. B. Aufbau und sichtbare
   Textzeile der `example.org`-Seite) — Beleg: meine Beschreibung, ohne dass im
   selben Zug ein Textwerkzeug lief.
10. **Ein großes Bild kommt lesbar an** (live). Ein Bild, dessen **PNG-Aufnahme**
    zwischen 2 097 152 und 3 145 728 Byte liegt, kommt mit `bytes > 2 097 152`
    als `type: "image"` an; `bytes`, `format` und `scaled` stehen unter
    `## Messlauf`. Wichtig für den Aufbau des Falls: Vollbild-Rauschen landet
    **nicht** in diesem Fenster — es sprengt die Grenze und wird von der Leiter
    auf ~0,3 MB JPEG gedrückt (so im Messlauf von Spec 20 gemessen). Das Rauschen
    gehört deshalb auf einen **Teil** des Viewports, damit die Aufnahme im
    Fenster bleibt. Darüber hinaus bleibt `screenshot_too_large` eine Ablehnung
    mit Text.
11. **Die Abnahme ist grün** (lokal). `npm test; echo $?` → `0` mit `# fail 0`
    **und** `# cancelled 0`; `npm run check; echo $?` → `0`;
    `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1;
    `git diff --exit-code extension/manifest.json` → 0.

## Dev plan

**Vorab, am Code geprüft (nicht angenommen).** Die beiden Zahlen stehen in
`extension/protocol.js` und `bridge/protocol.mjs` (`MAX_MESSAGE_BYTES: 1048576`,
`CALL_TIMEOUT_MS: 10000`); `test/protocol.test.js` vergleicht die Kopien per
`deepStrictEqual` und pinnt heute **nur relativ** (`CALL_TIMEOUT_MS > 2500`) —
keine der beiden Zahlen ist wörtlich gepinnt. Die Literal-Kopien der alten Zahlen
sind **seltener als vermutet**, und eine davon ist gefährlich, weil sie grün
bleibt:

| Datei / Fall | was sie trägt | nach der Änderung |
|---|---|---|
| `test/websocket.test.js::websocket_onMessageLargerThanOneMebibyte_shouldCloseWithMessageTooBig` | `Buffer.alloc(600 * 1024)` zweimal (1 228 800 B) | **rot — und zwar hängend** (`cancelled`, nicht `fail`) |
| `test/http-transport.test.js:42` | `const MAX_BODY_BYTES = PROTOCOL.MAX_MESSAGE_BYTES;` | **grün, aber falsch**: prüft 5 MiB statt 1 MiB |
| `test/mcp.test.js::mcp_withALineLongerThanTheMessageLimit…` | `PROTOCOL.MAX_MESSAGE_BYTES` abgeleitet | grün, ohne Zutun |
| `test/hub.test.js` (alle Fristfälle) | `BC_CALL_TIMEOUT_MS: "200"`/`"2000"` | **keine** Literal-Kopie, grün |
| `test/extension.test.js`, neun Screenshot-Fälle | 524288/524289/600000, kalibriert auf die alte Grenze | rot (Liste in Stufe 3) |
| `test/mcp.test.js:108` `SCREENSHOT_TOOL_DESCRIPTION` | „höchstens 512 KiB", „als Base64" | rot |

**Zu den Kriterien** (Oberaufsicht Orchestrator, hier nur der Befund): Kriterium 2
nennt neun Felder — neun ist die prüfbare Zahl. Die Schranke „unter 1 024 Zeichen" ist keine Eigenschaft des Produkts:
`captureAgentTab` setzt `url`/`title` über `asText` (nur getrimmt), **nicht**
gekappt — die 2 048/1 024 aus `read` gelten hier nicht. Der Fall darf die Schranke
deshalb nur für seine kurze Fixture prüfen; ein langer Titel ist ein eigenes
Risiko (siehe `## Risiken`). Die Testing-Zeile
„`test/hub.test.js` … antwortet nach 20 s" kostet 20 s Suite-Zeit und beweist
nichts über Kriterium 7 hinaus; Stufe 1 pinnt stattdessen Zahl und Default, der
bestehende Hub-Fall bleibt mit injizierter Frist.

1. **Die zwei Protokollzahlen, in beiden Kopien** — `extension/protocol.js` und
   `bridge/protocol.mjs`: `MAX_MESSAGE_BYTES: 5242880`, `CALL_TIMEOUT_MS: 20000`,
   sonst nichts. `test/protocol.test.js`: zwei neue wörtliche Fälle nach dem Muster
   des `SCREENSHOT`-Falls — `…_maxMessageBytes_shouldBothCarryFiveMebibytes` und
   `…_callTimeoutMs_shouldBothCarryTwentySeconds`, je
   `assert.equal(PROTOCOL.X, <zahl>)` **und**
   `assert.equal(extensionProtocol.X, <zahl>)`. `bridge/websocket.mjs` (Kommentar
   bei `FrameDecoder`, „where the 1 MiB limit lives") und die drei Kommentare in
   `extension/background.js` (`:139` „1 MiB frame limit", `:238` „the 1 MiB
   message frame", `:233` „`CALL_TIMEOUT_MS` (10 s)") auf die neuen Zahlen bzw.
   auf „the message limit" umgestellt. **Im selben Schritt**, weil der Fall sonst hängt
   statt zu scheitern:
   `websocket_onMessageLargerThanOneMebibyte_shouldCloseWithMessageTooBig` →
   `…LargerThanTheLimit…`, Größe **abgeleitet**:
   `Buffer.alloc(PROTOCOL.MAX_MESSAGE_BYTES + 1024, 0x61)` (heute 5 243 904) —
   kein Literal, damit die Hänge-Falle beim nächsten Zahlenwechsel nicht
   wiederkommt. Neuer Fall `websocket_onAMessageOfFourMebibytes_shouldEmitIt`:
   `Buffer.alloc(4_200_000, 0x61)` über `startServer`/`connectClient`,
   `once(connection, "message")`, Länge 4 200 000.
   Proof: `npm test` → `# fail 0` **und** `# cancelled 0`;
   `git grep -n "5242880\|20000" extension/protocol.js bridge/protocol.mjs` → je
   eine Zeile.

   **Completed 2026-10-27**

2. **Die Anfragegrenze wird eine eigene Zahl** — `bridge/http-transport.mjs`:
   `const MAX_BODY_BYTES = PROTOCOL.MAX_MESSAGE_BYTES;` (Zeile 32) wird
   `const MAX_BODY_BYTES = 1048576;` mit eigenem Kommentar (eine Anfrage ist ein
   Aufruf, kein Bild; die Socket-Grenze ist keine Anfragegrenze); der
   `PROTOCOL`-Import fällt, wenn er sonst nirgends gebraucht wird.
   `test/http-transport.test.js`: Zeile 42 wird `const MAX_BODY_BYTES = 1048576;`
   (wörtlich, nicht abgeleitet) — die `2 * MAX_BODY_BYTES`-Stellen bleiben dadurch
   2 097 152 und die 413-Fälle aussagekräftig. Neuer Fall
   `startHttpTransport_withABodyOfOneByteOverTheRequestLimit_shouldAnswer413WhileTheSocketAllowsFiveMebibytes`:
   `Content-Length: String(1048577)` ⇒ 413 und `toolSet.receivedTexts` leer.
   Proof: `node --test test/http-transport.test.js` → `# fail 0`;
   `git grep -n "PROTOCOL" bridge/http-transport.mjs` → keine Ausgabe.

   **Completed 2026-10-27**

3. **Drei MiB Bild in der Extension** — `extension/background.js`:
   `SCREENSHOT_MAX_BYTES = 3145728`, Kommentar neu gerechnet
   (`3145728 × 4/3 = 4194304` Base64, Luft bis `MAX_MESSAGE_BYTES` = 5 242 880).
   `SCREENSHOT_SCALE_STEPS` bleibt unverändert — die Leiter greift nur später.
   `test/extension.test.js`, neun Fälle nachziehen (Werte so, dass jede Stufe
   weiter genau einmal läuft):

   | Fall | alt | neu |
   |---|---|---|
   | `…_withAPictureOfExactlyTheLimit_shouldAnswerOk` | 524288 | 3145728 |
   | `…_withAPictureOneByteOverTheLimit_shouldShrinkToTheFirstStage` | 524289 / `[524288]` | 3145729 / `[3145728]` |
   | `…_whenTheFirstStageFits_shouldAnswerTheJpegItEncoded` | 600000 / `[400000]` | 3300000 / `[3000000]` |
   | `…_whenOnlyTheSecondStageFits_shouldAnswerWithQualityHalf` | 600000 / `[600000, 450000]` | 3300000 / `[3300000, 2500000]` |
   | `…_whenOnlyTheThirdStageFits_shouldScaleDownToTwelveHundred` | `[600000, 550000, 500000]` | `[3300000, 3200000, 3100000]` |
   | `…_whenEveryStageIsTooLarge_shouldNameTheLastStageNumbers` | `[600000, 550000, 530000]`, `/524288/` | `[3300000, 3250000, 3200000]`, `/3200000/`, `/3145728/` |
   | `…_withAPictureAlreadyInsideTheStageEdge_shouldNotEnlargeIt` | 600000 / `[400000]` | 3300000 / `[3000000]` |
   | `…_whenTheDecodedPictureHasNoPixels_shouldAnswerScreenshotFailed` | 600000 | 3300000 |
   | `…_whenTheDecodingNeverFinishes_shouldAnswerScreenshotFailedOnTheDeadline` | 600000 / `[400000]` | 3300000 / `[3000000]` |

   Dazu die `assert.equal(answer.result.bytes, …)`-Zahlen und die Kommentare bei
   `createEncoderStub` („falls under 512 KiB is a live question") und bei
   Zeile ~3982 („a frame over 1 MiB"). Kein Megabyte-Literal: `pngOf`/
   `pngDataUrlFor`/`base64OfLength` erzeugen die Bytes.
   Proof: `node --test test/extension.test.js` → `# fail 0`;
   `git grep -n "524288\|600000" test/extension.test.js` → keine Ausgabe.

   **Completed 2026-10-27**

4. **Die Antwortform: Text plus Bild** — `bridge/mcp.mjs`:
   `const SCREENSHOT_MIME_TYPES = Object.freeze({ png: "image/png", jpeg:
   "image/jpeg" });` mit `Object.hasOwn`-Prüfung (ein `"toString"`-Format darf
   kein MIME erfinden — dasselbe Muster wie `Object.hasOwn(parsed, "id")` in
   `handleMessageText`; die `NOT_READABLE_KINDS`-Liste ist dagegen ein Array mit
   `includes` und kennt die Falle gar nicht),
   `function screenshotResultMessage(id, result)`:
   `format`/`base64` prüfen, sonst `toolError(id, TOOL_TEXTS.SCREENSHOT_FAILED)`
   (**nicht werfen** — ein Throw landet in `failureTextFor` und der Betreiber
   liest `BRIDGE_FAILED`); sonst `resultMessage(id, { content: [ { type: "text",
   text: JSON.stringify(metadata, null, 2) }, { type: "image", mimeType, data:
   base64 } ] })`, wobei `metadata = { …result }` ohne `base64`
   (Rest-Destrukturierung, damit die Feldreihenfolge bleibt).
   `optionalArgumentsTool` bekommt einen fünften Schalter `format =
   textResultMessage` und gibt `format(id, await request(hub, args?.tab))` zurück;
   `screenshotTool` reicht `format: screenshotResultMessage` ein — die anderen vier
   Werkzeuge bleiben Zeile für Zeile. Werkzeugbeschreibung: „liefert das Bild als
   MCP-Bildinhalt, die Zahlen als Textblock daneben", Grenze 3 MiB.
   `test/fixtures/fake-extension.mjs`: `base64ImageOf({ format, byteCount })`
   (Magic `/9j/` = 3 Byte bzw. `iVBORw0KGgoA` = 9 Byte, dahinter
   `base64OfLength`-Füllung), `SCREENSHOT_RESULT.base64 = base64ImageOf({ format:
   "jpeg", byteCount: 214311 })`; neuer Modus `BC_TEST_SCREENSHOT_BYTES=<n>` (in
   `main()`, `answers.screenshot`, `screenshotResponse`), der ein Ergebnis mit
   genau `n` dekodierten Bytes liefert — und dabei **`format: "png"` und
   `scaled: false` setzt**, sonst kann die in Stufe 5 erwartete Logzeile
   `screenshot tab=20 bytes=3145728 format=png scaled=false ok=true` nie
   entstehen (`SCREENSHOT_RESULT` trägt heute `scaled: true`). Dazu die Env-Liste
   im Kopfkommentar.
   `test/mcp.test.js`: `INDENTED_SCREENSHOT_RESULT` wird `SCREENSHOT_METADATA`
   (dieselbe Rest-Destrukturierung),
   `mcp_toolsCallBrowserScreenshot_shouldReturnTheBase64ResultAsText` wird
   `…_shouldReturnTheMetadataAsTextAndThenTheImage` (`content.length === 2`,
   `["text","image"]`, JSON ohne `base64`, neun Felder, `mimeType: "image/jpeg"`,
   `data` beginnt `/9j/`, `Buffer.from(data,"base64").length ===
   SCREENSHOT_RESULT.bytes`), neuer Fall mit `BC_TEST_SCREENSHOT_BYTES: "68"`
   (`mimeType: "image/png"`, `data` beginnt `iVBORw0`, Länge 68), neuer Fall
   `format: "gif"` ⇒ `isError: true`, `content.length === 1`; die
   `SCREENSHOT_REFUSAL_CASES`-Schleife bekommt zusätzlich
   `assert.equal(content.length, 1)`; `SCREENSHOT_TOOL_DESCRIPTION` und `tools[10].description` neu geschrieben, und
   `SCREENSHOT_TOO_LARGE_MEASUREMENT` (Beispielsatz mit „Grenze 524288") auf
   3 145 728 nachgezogen — er bliebe sonst grün und trüge die alte Zahl.
   Proof: `node --test test/mcp.test.js` → `# fail 0`; `npm run check` → 0;
   `git grep -n '{ type: "image"' bridge/mcp.mjs` → genau eine Codezeile (der
   JSDoc-Beispielblock daneben zählt nicht).

   **Completed 2026-10-27**

5. **Der Transport trägt 3 MiB** — `test/http-mcp.test.js` (Helfer
   `startBridgeWithExtension`, `requestMcp`, `postMcpText`): Fall
   `httpMcp_aScreenshotOfThreeMebibytes_shouldArriveImageShapedAndParsable` mit
   `BC_TEST_SCREENSHOT_BYTES: "3145728"` im Fixture-Env — Antwort 200,
   `JSON.parse` gelingt, `result.content[1].type === "image"`,
   `data.length === 4194304`, `Buffer.from(data,"base64").length === 3145728`,
   und `bridge.output.stderr` enthält die Zeile `screenshot tab=20
   bytes=3145728 format=png scaled=false ok=true` ohne Base64; Fall
   `httpMcp_aRequestOverTheRequestLimit_shouldStillAnswer413WhileTheSocketAllowsFiveMebibytes`
   mit `postMcpText(port, "x".repeat(1048577))` ⇒ 413 (generiert, kein Literal).
   Die Fixture-Env dafür geht über `startFakeExtension(t, port, env)`;
   `startBridgeWithExtension` bekommt einen optionalen `extensionEnv`-Parameter.
   Proof: `node --test test/http-mcp.test.js` → `# fail 0`; die Logzeile im
   Testfall sichtbar.

   **Completed 2026-10-27**

6. **Doku und Abschluss** (Orchestrator): `docs/README.md`,
   `docs/PROJECT-STATE.md`, `docs/ROADMAP.md`; die Zahlen in den sieben Dateien
   aus `## Amendments to previous spec docs` **nachziehen** (sie stehen dort
   unter „Stelle" mit Zeilennummer); `## Amendments to previous spec docs` in
   **dieser** Spec entfernen; Spec auf `status: active`, Prosa beschreibend.
   Die Doku-Arbeit liegt in dieser Stufe und nicht beim Umsetzer, weil der
   Umsetzer keine Spec anfassen darf — `docs/README.md` verlangt das
   Nachziehen in der Stufe, die das Verhalten umsetzt, und das ist diese. Kriterien 9 und 10 bleiben live und kommen erst nach dem
   Commit (Ausnahme 2026-10-27, Kriterium 9 ist Kernannahme) — fällt eines rot
   aus: vorwärts korrigieren, rote Zeile in `## Bekannte Lücken`.
   Proof: `npm test; echo $?` → 0 mit `# fail 0` und `# cancelled 0`;
   `npm run check; echo $?` → 0; Secret-grep → keine Ausgabe, Exit 1;
   `git diff --exit-code extension/manifest.json` → 0.

   **Completed 2026-10-27** (Stufe 6: Zahlen in sieben Specs nachgezogen,
   `## Amendments` entfernt, Status `active`, Register gepflegt)

### What could go wrong

- **Stufe 1 macht einen Test hängend statt rot.**
  `websocket_onMessageLargerThanOneMebibyte…` schreibt 1,2 MiB — unter der neuen
  Grenze kommt nie ein `1009`, der Fall wartet auf `closeFrame` bis zu **seinem
  eigenen** Socket-Wächter (`SOCKET_TEST_OPTIONS = { timeout: 10_000 }`,
  `test/websocket.test.js:19`). Dieses Ende zählt als `# cancelled`, und
  `# fail 0` überlebt (genau der Grund für die zweite Grep-Zeile in
  `CONTRIBUTING.md`). Deshalb: Rescale im
  selben Schritt, Abnahme prüft **beide** TAP-Zeilen.
- **`test/http-transport.test.js` bleibt grün und verliert seine Aussage.**
  `MAX_BODY_BYTES = PROTOCOL.MAX_MESSAGE_BYTES` folgt der neuen Zahl
  stillschweigend; danach prüft der 413-Fall 10 MiB gegen 5 MiB. Die wörtliche
  `1048576` in Zeile 42 ist Pflicht, nicht Kosmetik.
- **Die Leiterfälle sind implizit kalibriert.** 600 000 Byte liegen nach der
  Änderung unter der Grenze, also greift Stufe 0 und `encodeCalls` bleibt leer —
  fünf Fälle werden rot, ohne dass eine Zahl in ihnen wie „die Grenze" aussieht.
  Darum die Tabelle in Stufe 3 mit allen neun Namen.
- **Ein werfender Formatter.** `screenshotResultMessage` läuft im `try` von
  `optionalArgumentsTool`; ein `throw` wird zu `failureTextFor` → `BRIDGE_FAILED`.
  Der unbekannte `format`-Fall muss deshalb ein `toolError` **zurückgeben**.
- **`Object.freeze` ist keine Whitelist.** `SCREENSHOT_MIME_TYPES[format]` mit
  `format = "toString"` liefert eine Funktion aus dem Prototyp — `Object.hasOwn`
  prüfen, dieselbe Falle, die `NOT_READABLE_KINDS` schon umgeht.
- **Base64-Behauptung ohne Bytes.** Heute ist `SCREENSHOT_RESULT.base64` ein
  erfundener String und `bytes` 214311; `Buffer.from(data,"base64")` ignoriert
  ungültige Zeichen still, die Gleichheit aus Kriterium 3 wäre ein Münzwurf.
  Deshalb der Generator: Kopf echt, Länge echt.
- **`data.length === 4194304` ist Rechnung, kein Zufall:** 3 145 728 =
  3 × 1 048 576 → 4 194 304 Base64-Zeichen ohne `=`-Padding.
- **Speicher und Laufzeit in der Suite.** Neun Extension-Fälle erzeugen je
  ~3,3 MB Puffer und ~4,4-MB-Strings, der `http-mcp`-Fall 4,2 MB über Socket und
  HTTP. `--test-concurrency=1` und `--test-timeout=120000` tragen das.
- **`mimeType` bleibt eine Behauptung über die Bytes**, und Kriterium 9 hängt am
  Client: rendert pi `type: "image"` nicht, ist die Kernannahme widerlegt — lokal
  nicht entscheidbar.

### Ordering and dependencies

- **1 vor 3 und vor 5.** Stufe 3 ist lokal von 1 unabhängig (die Extension-Tests
  stubbeln den Socket), in der Wirklichkeit nicht: 3 MiB Bild sind 4,19 MB Base64
  und passen nur in einen 5-MiB-Rahmen. Stufe 5 hängt hart an 1.
- **1 vor 2:** bliebe die Anfragegrenze einen Commit lang an `PROTOCOL` gekoppelt,
  nähme die Bridge vorübergehend 5-MiB-Anfragen an.
- **4 vor 5:** Stufe 5 prüft den Bildblock über den ganzen Weg; ohne Stufe 4 gibt
  es keinen. 4 selbst hängt an keiner Zahlenstufe.
- **3 ist von 4 unabhängig**, 2 von beiden. Keine Stufe braucht eine spätere.
- **6 zuletzt** und nur vom Orchestrator; die Live-Kriterien 9/10 kommen nach dem
  Commit.

### What the next increment inherits

- **Nicht in diesem Inkrement:** Chunking, Streaming, Ablage auf Platte,
  Bildkompression auf der Bridge, Bilder aus `read`/`inspect`, PDF-Rendering,
  Video-Frames, `rect`/`scale`/`quality` als Werkzeugparameter, ein vierter
  Leiter-Schritt — jede davon eine eigene Spec.
- **Die Frist ist Luft, keine Wartezeit.** `CALL_TIMEOUT_MS` 20 s bei 3 s pro
  Leiterstufe; wer die Leiter verlängert, muss die Rechnung in `## Risiken`
  mitziehen.
- **Die 1-MiB-Anfragegrenze ist ab jetzt eine eigene Entscheidung.**
- **Der Formatter-Schalter in `optionalArgumentsTool`** ist der Ort, an dem ein
  späteres Werkzeug mit Nicht-Text-Ergebnis anschließt.
- **Der Fixture-Generator `base64ImageOf`** und `BC_TEST_SCREENSHOT_BYTES` sind
  Allgemeingut: jeder spätere Größentest erzeugt seine Nutzlast.
- **Der Textblock neben dem Bild bleibt der Rückfall**, wenn ein Client den
  Bildblock fallen lässt; die Doppelung ist bewusst und darf nicht „aufgeräumt"
  werden.
- **Kriterium 9 bleibt die Kernannahme**: wird sie live widerlegt, geht es zurück
  in die Spec, nicht in `## Bekannte Lücken`.


## Risiken

- **Speicher pro Aufruf.** Ein 3-MiB-Bild liegt als Base64 (4,19 MB) in der
  Extension, im Hub und in der Bridge, dazu die JSON-Serialisierung — transient
  das Mehrfache. Bei einem Aufruf ist das unkritisch; niemand sollte zehn
  gleichzeitig fahren.
- **Höhere Frist heißt längere Hänger.** `CALL_TIMEOUT_MS` 20 s ist die Grenze,
  bis der Aufrufer „keine Antwort" liest. Die Leiter bleibt bei 3 s pro Stufe,
  also endet ein hängendes Kodieren nach 9 s mit `screenshot_failed` — die 20 s
  sind Luft für Übertragung, nicht für neue Wartezeiten.
- **Die 5-MiB-Grenze gilt auch für eingehende MCP-Nachrichten** (stdio-Leser).
  Sie ist kein Sicherheitsloch — beide Enden sind loopback und tokenisiert —,
  aber sie ist der Grund, warum die **HTTP-Anfrage**grenze separat bei 1 MiB
  bleibt.
- **Anbieter-Grenzen sind nicht garantiert.** 5 MB Base64 ist die verbreitetste
  Grenze, nicht die kleinste. Ein Modell mit 4 MB Grenze würde an einem 3-MiB-Bild
  scheitern; dann ist die Zahl zu senken, nicht das Format zu ändern.
- **Der Textblock hat keine eigene Grenze.** `url` und `title` gehen ungekappt in
  die Metadaten (anders als bei `read`, wo 2 048/1 024 Zeichen gelten). Ein
  Ausreißer-Titel von einigen hundert Kilobyte könnte zusammen mit einem
  3-MiB-Bild den 5-MiB-Rahmen sprengen — die Folge wäre `1009` statt Bild. Ob
  `screenshot` `url`/`title` kappen soll, ist eine eigene Entscheidung, nicht
  stilles Beiwerk.
- **`mimeType` bleibt eine Behauptung über die Bytes.** Sie kommt aus `format`;
  Kriterium 3 prüft die Köpfe beider Formate.

## Touch boundary

Angefasst: `extension/protocol.js`, `bridge/protocol.mjs` (zwei Zahlen),
`bridge/websocket.mjs` (**nur** der Kommentar bei `FrameDecoder`, der die alte
1-MiB-Grenze nennt — keine Codeänderung),
`extension/background.js` (`SCREENSHOT_MAX_BYTES`), `bridge/http-transport.mjs`
(eigene Anfragegrenze), `bridge/mcp.mjs` (Antwortform, Beschreibung),
`test/{protocol,websocket,http-transport,http-mcp,mcp,extension}.test.js`
  (in `http-transport` fällt zusätzlich ein vorbestehender Hänger: der
  Chunked-413-Fall wartete unbegrenzt, wenn die Verbindung vor der Antwort starb —
  beim Bauen gefunden, vom Orchestrator beauftragt und im selben Inkrement
  behoben, weil er die Abnahme zufällig kippt),
`test/fixtures/fake-extension.mjs`, `docs/README.md`, `docs/PROJECT-STATE.md`, `docs/ROADMAP.md` und die Zahl-
Nachträge in `docs/20`, `docs/18`, `docs/01`, `docs/03`, `docs/04`, `docs/05`,
`docs/19` (beim Orchestrator; `## Review`, `## Log` und die
`**Completed …**`-Marken dieser Dateien bleiben als Historie stehen).

**Nicht** angefasst: `extension/manifest.json`, `bridge/{hub,config,bridge}.mjs`.
`CONTRIBUTING.md` und `package.json` tragen in diesem Commit die Änderung an der Abnahme
(`--test-timeout` von 120 s auf 60 s, Betreiber-Hinweis 2026-10-27); sie ist
Infrastruktur, nicht Inkrement.

## Bekannte Lücken

Stand 2026-10-27, nach den Stufen 1–6 und dem Code-Review:

- **Kriterium 9 bleibt stehen und wird in einer bildfähigen Sitzung gemessen**
  (Betreiberentscheidung 2026-10-27): der Transport ist live bewiesen (zwei
  Blöcke, echtes PNG mit `iVBORw0`, 99 232 Byte), das **Sehen** nicht — das
  treibende Modell dieser Sitzung (`deepseek-v4-flash`) hat keine Bildfähigkeit
  und meldet „tool image output omitted". Das Kriterium wird nicht umgeschrieben;
  es wartet auf eine Sitzung mit einem Vision-Modell.
- **Kriterium 10 steht aus** (2026-10-27): die Erweiterung trägt noch
  `SCREENSHOT_MAX_BYTES = 524288`, muss also für ein Bild über 2 MiB neu geladen
  werden.
- **R1, R2, R4 aus dem Code-Review** (2026-10-27): ein leeres `base64` würde als
  Bild durchgehen; `waitForResponse` hat keinen Default für `timeoutMs`; die
  Base64-Padding-Helfer liegen doppelt. Keiner davon ist heute erreichbar oder
  entscheidend, alle drei stehen hier statt im Code.

## Open questions

Keine offenen. Beantwortet vom Betreiber am 2026-10-27:

1. **Metadaten-Text plus Bildblock**, kein Base64 im Text.
2. **Grenzen: 3 MiB Bild / 5 MiB Socket / 20 s Aufruffrist** — nach der Frage
   „was ist eine übliche Grenze?": 5 MB Base64 ist die verbreitetste Bildgrenze
   (Anthropic), OpenAI/Gemini liegen bei 20 MB; 3 MiB dekodiert bleiben darunter.

## Messlauf (2026-10-27, Betreiber-Profil)

Gemessen über den Dienst (`systemctl --user restart`, neuer Code) und **durch das
Werkzeug selbst** (`browser_screenshot` als MCP-Aufruf, nicht per `curl`):

- **Die Antwortform trägt.** `https://example.org/?neu=2` → zwei Blöcke,
  `["text", "image"]`: Text mit `{"tabId":4,"url":"…?neu=2","title":"Example
  Domain","format":"png","width":1904,"height":853,"bytes":99232,"scaled":false,
  "activated":false}` (neun Felder, **kein** `base64`), danach
  `{"type":"image","mimeType":"image/png","data":"iVBORw0…"}`.
- **Das Bild ist echt.** Der Bildblock dekodiert zu 99 232 Byte, PNG-Kopf
  `89 50 4E 47 0D 0A 1A 0A`, Maße 1904 × 853 — dieselben Zahlen wie im
  Textblock. Der Harness hat die Datei als `/tmp/pi-codemode-….png` abgelegt
  (96,9 KB).
- **Kriterium 9 ist mit dem aktuellen Modell NICHT entscheidbar.** Mein Modell
  ist `deepseek-v4-flash` (Provider `deepseek`); die Antwort des Werkzeugs trägt
  den Hinweis „tool image omitted: model does not support images". Der Transport
  ist damit bewiesen, das **Sehen** nicht: ein Modell ohne Bildfähigkeit wirft den
  Block weg. Das ist keine Schwäche des Inkrements, sondern eine Eigenschaft der
  Sitzung — und es heißt, dass der Nutzen von der Modellwahl abhängt.
- **Kriterium 10 steht noch aus.** Für ein Bild über 2 MiB muss die Erweiterung
  neu geladen werden (sie trägt noch `SCREENSHOT_MAX_BYTES = 524288`, deshalb
  liefert sie bei großen Bildern weiter ein ~0,3-MB-JPEG der Leiter); und „lesbar"
  braucht wieder ein bildfähiges Modell. Die Zahlenseite (Bytes, `mimeType`,
  dekodierte Länge) ist ohne Sehen messbar.

Eine frühere Messung auf demselben Tab ergab `format: "jpeg"`, `scaled: true`,
329 865 Byte — das war das Rausch-Overlay aus dem Messlauf von Spec 20, das eine
Navigation auf dieselbe URL überlebt hatte. Wer nachmisst: erst wirklich neu
laden (`?neu=…`), sonst misst man das alte Bild.

## Review

### Runde 1, 2026-10-27 — `🔧 Fix these` (Blocker dabei)

Geprüft gegen `spec-doc-review`, `CONTRIBUTING.md` und `docs/README.md`. Die
Behauptungen des Dev-Plans wurden am Code gegengeprüft und halten fast alle:
`test/protocol.test.js` pinnt die Frist nur relativ (`> 2500`),
`test/websocket.test.js:421` schreibt 1,2 MiB und endet nach der Änderung als
`# cancelled` (empirisch bestätigt: `testTimeoutFailure` zählt nicht als `fail`),
`test/http-transport.test.js:42` leitet ab und bliebe grün aber falsch,
`test/hub.test.js` injiziert überall, `SCREENSHOT_TOOL_DESCRIPTION` (Zeile 107)
trägt „höchstens 512 KiB", und ein werfender Formatter landet wirklich in
`BRIDGE_FAILED`. Auch die Zahlen sind sauber gerechnet (3 145 728 × 4/3 =
4 194 304 ohne Padding; 1 048 576 Luft im 5-MiB-Rahmen), und die neun
Extension-Fälle existieren mit genau den genannten Werten.

Blockierend: Kriterium 10 maß eine Bildgröße, die sein eigenes Rezept
(Vollbild-Rauschen) auf ~0,3 MB JPEG schrumpft, und verwies auf einen
`## Messlauf`, den diese Spec nicht hat; die Amendments-Liste nannte Dateien statt
Stellen und ließ `docs/18:333` stehen, wo die Körpergrenze ausdrücklich als
`PROTOCOL.MAX_MESSAGE_BYTES` „keine neue Zahl" festgeschrieben ist; Stufe 6 wollte
die Amendments aus den falschen Dateien entfernen; `bridge/websocket.mjs` fehlte
in der Touch-Boundary; `## Testing` forderte einen 20-s-Hub-Fall, den Stufe 1
ausdrücklich nicht baut, während die Boundary `test/hub.test.js` als angefasst
führte; Kriterium 2 behauptete „unter 1 024 Zeichen", obwohl `screenshot`
`url`/`title` gar nicht kappt (die 2 048/1 024 gelten im `read`-Pfad); und
`## Testing` sagte „acht" statt neun Metadatenfelder.

Dazu sechs Zeilen (m1–m6): abgeleitete Frame-Größe statt Literal, der falsche
Wartezeit-Mechanismus (10-s-Socket-Wächter, nicht Runner-Timeout), die falsche
`NOT_READABLE_KINDS`-Analogie, der Fixture-Modus ohne `format`/`scaled`, die alte
Zahl in `SCREENSHOT_TOO_LARGE_MEASUREMENT`, und der Grund, warum die Doku-Arbeit
in Stufe 6 liegt.

### Runde 2, 2026-10-27 — `✅ Ship it` (kein Blocker)

B1–B8 und m1–m6 am Text und am Code nachgeprüft, nicht an der
Log-Zusammenfassung. In Ordnung: Kriterium 10 verlangt eine PNG-Aufnahme zwischen
2 097 152 und 3 145 728 mit dem Rausch-Hinweis (Spec 20s Messlauf belegt die
~0,3 MB: 329 865 Byte); `## Messlauf` existiert und nennt die Felder; die
Amendments-Tabelle trägt Datei, Stellen und neue Zahl, `docs/18:333-334`
eingeschlossen; Stufe 6 zieht die Zahlen in den sieben Dateien nach und entfernt
den Abschnitt nur in `docs/21`; `bridge/websocket.mjs` steht mit „nur der
Kommentar" in der Boundary; die Hub-Zeile in `## Testing` ist durch den
`protocol.test.js`-Pin ersetzt und `test/hub.test.js` aus der Boundary
gestrichen; Kriterium 2 bindet „unter 1 024 Zeichen" an den Testfall, das Risiko
zum ungekappten `title` steht unter `## Risiken`; `## Testing` sagt „neun". Die
Zeilen m1–m6 stimmen ebenfalls: Größe abgeleitet (5 243 904),
`SOCKET_TEST_OPTIONS` (10 s), `Object.hasOwn(parsed,"id")` (`bridge/mcp.mjs:540`),
`format`/`scaled` im Fixture-Modus, `SCREENSHOT_TOO_LARGE_MEASUREMENT`
nachgezogen, Begründung der Doku-Stufe. Zahlen gegengerechnet: 3 145 728 →
4 194 304 ohne Padding, 1 048 576 Luft bis 5 242 880, Magic 9 bzw. 3 Byte.

Acht Kleinigkeiten ohne Entscheidungswert (C1–C8), alle als Zeilen übernommen:
Boundary nennt alle sieben Doku-Dateien (C1), Kriterium 8 trennt Leitertabelle
von `SCREENSHOT_SCALE_STEPS` (C2), die doppelte `CALL_TIMEOUT_MS`-Zeile ist
zusammengefasst (C3), die Amendments-Zeile `docs/20` nennt `:191`/`:196`/`:728`,
`:311-316` und `docs/04:63` (C4), `test/mcp.test.js:108` (C5), die
Kommentar-Zitate in `extension/background.js` sind `:139`/`:238`/`:233` (C6),
„Noch keine Befunde." ist aus `## Log` gestrichen (C7), und der überholte
„acht"-Satz im Plan-Vorabblock ist weg (C8).


### Code-Review 1, 2026-10-27 — `✅ Ship it` (kein Blocker)

Geprüft: `git diff 2efe0d5` ohne die zwei Infra-Dateien (`package.json`,
`CONTRIBUTING.md`), 13 Dateien, +673/−154, keine untracked Dateien. Kriterien 1–8 und
11 am Code und an den Tests nachgeprüft; 9 und 10 sind live und bleiben offen.

In Ordnung: zwei Blöcke, Text zuerst; der Textblock trägt die neun Felder ohne
`base64`; `mimeType` aus `format`, `data` ohne `data:`-Präfix; der
unbekannte-Format-Pfad gibt `toolError` **zurück** statt zu werfen; `Object.hasOwn`
gegen `format: "toString"`; die zwei Zahlen wörtlich in beiden Kopien
(5 242 880 / 20 000); die Anfragegrenze als eigene `1048576` in
`bridge/http-transport.mjs` **und** im Test, keine abgeleitete Kopie mehr;
`SCREENSHOT_MAX_BYTES` 3 145 728 mit nachgerechnetem Kommentar; der 1009-Fall aus
`PROTOCOL` gerechnet statt als Literal; die Fixture liefert echte Bytes; der
3-MiB-Fall kommt über HTTP mit 4 194 304 Base64-Zeichen und 3 145 728 dekodierten
Bytes an; die Journalzeile bleibt eine Zeile ohne Base64. Der Hänger-Fix in
`test/http-transport.test.js` begrenzt jede Richtung (response, error, close,
Zeit), schwächt die Zusicherung nicht ab und war in sechs Läufen hintereinander
grün. Abnahme: 522 Tests, `# fail 0`, `# cancelled 0`, `npm run check` 0,
Secret-Grep Exit 1, `extension/manifest.json` unberührt.

Fünf Befunde ohne Blocker (R1–R5, siehe `## Log`).

## Log

Runde 1 des Spec-Reviews — alle 14 Befunde übernommen (B1–B8, m1–m6):

- **B1** (Kriterium 10 maß eine Größe, die sein Rezept nicht erzeugt:
  Vollbild-Rauschen sprengt die Grenze und landet bei ~0,3 MB JPEG) — übernommen:
  das Kriterium verlangt jetzt eine **PNG-Aufnahme zwischen 2 MiB und 3 145 728**
  und sagt, dass das Rauschen auf einen Teil des Viewports gehört.
- **B2** (Verweis auf `## Messlauf`, den diese Spec nicht hatte) — übernommen:
  der Abschnitt existiert, mit den Feldern, die einzutragen sind.
- **B3** (Amendments nannten Dateien statt Stellen und ließen `docs/18:333`
  stehen) — übernommen: eine Tabelle mit Datei, Stellen und neuer Zahl für
  `docs/20`, `docs/18`, `docs/01`, `docs/03`, `docs/04`, `docs/05`, `docs/19`.
- **B4** (Stufe 6 wollte Amendments aus `docs/20`/`docs/19` entfernen, wo gar
  keine stehen) — übernommen: die Zahlen werden dort **nachgezogen**, der
  Amendments-Abschnitt wird in `docs/21` entfernt.
- **B5** (`bridge/websocket.mjs` fehlte in der Boundary) — übernommen, mit dem
  Zusatz „nur der Kommentar bei `FrameDecoder`".
- **B6** (`## Testing` verlangte einen 20-s-Hub-Fall, den Stufe 1 nicht baut;
  `test/hub.test.js` stand als angefasst) — übernommen: die Testing-Zeile nennt
  jetzt den `test/protocol.test.js`-Pin, `test/hub.test.js` ist aus der Boundary
  gestrichen.
- **B7** (Kriterium 2 verlangte „unter 1 024 Zeichen", obwohl `screenshot`
  `url`/`title` nicht kappt — die 2 048/1 024 gelten nur bei `read`) —
  übernommen: die Schranke gilt für den Testfall, und unter `## Risiken` steht,
  dass ein langer Titel den 5-MiB-Rahmen sprengen könnte (eigene Entscheidung,
  nicht stilles Beiwerk).
- **B8** (`## Testing` sagte „acht Metadatenfelder", Kriterium 2 nennt neun) —
  übernommen.
- **m1** (Frame-Größe als Literal gegen den eigenen Satz „rechnet mit der neuen
  Zahl") — übernommen: `Buffer.alloc(PROTOCOL.MAX_MESSAGE_BYTES + 1024, …)`.
- **m2** („bis zum Runner-Timeout") — übernommen: der eigene Socket-Wächter
  (`SOCKET_TEST_OPTIONS`, 10 s) beendet den Fall, und das zählt als `cancelled`.
- **m3** (falsche `NOT_READABLE_KINDS`-Analogie für `Object.hasOwn`) —
  übernommen: das Muster, das es wirklich gibt, ist `Object.hasOwn(parsed, "id")`
  in `handleMessageText`.
- **m4** (der neue Fixture-Modus ließ `format`/`scaled` offen, die erwartete
  Logzeile wäre nie entstanden) — übernommen: der Modus setzt `format: "png"` und
  `scaled: false`.
- **m5** (`SCREENSHOT_TOO_LARGE_MEASUREMENT` trug weiter „Grenze 524288") —
  übernommen, auf 3 145 728 nachgezogen.
- **m6** (Doku-Arbeit in Stufe 6 ohne Begründung) — übernommen: Stufe 6 sagt
  jetzt, warum die Doku beim Orchestrator liegt und nicht beim Umsetzer.

Code-Review Runde 1 — `✅ Ship it`, fünf Zeilen behandelt:

- **R1** (leeres `base64` gälte als Bild) — **nicht in diesem Inkrement**: aus
  `captureTab` kommt immer mindestens eine Signatur, der Draht kann den Fall nicht
  erzeugen. Als Follow-up unter `## Bekannte Lücken`.
- **R2** (`waitForResponse` hat keinen Default für `timeoutMs`; ein vergessener
  Parameter ergäbe eine 0-ms-Frist) — nicht umgesetzt, der einzige Aufrufer
  übergibt sie; als Follow-up notiert.
- **R3** (die Touch-Boundary nannte `test/http-transport.test.js` nicht und führte
  `CONTRIBUTING.md` als „nicht angefasst") — übernommen: die Boundary nennt die Datei
  samt Hänger-Fix, und die Abnahme-Änderung ist als Infrastruktur ausgewiesen.
- **R4** (die Base64-Padding-Helfer liegen in Fixture und Testdatei doppelt) —
  nicht umgesetzt; eine Kopie ist gepinnt, die Drift fiele spät auf. Follow-up.
- **R5** (ein Dev-Plan-Proof zählte zwei Grep-Treffer statt einem, weil der
  JSDoc-Block mitzählt) — übernommen, der Proof grept jetzt `{ type: "image"`.

- **Kriterium 9**: nicht umgeschrieben, sondern vertagt (Betreiber, 2026-10-27).
  Der Beleg bleibt der Transport (zwei Blöcke, echtes Bild, dekodierbare Maße);
  das „ich sehe das Bild" kommt aus einer Sitzung mit bildfähigem Modell nach.
