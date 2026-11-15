---
description: Ein Standard-Endpunkt für die Extension — ist das Feld leer, verbindet sie nach ws://127.0.0.1:8110 (die Vorgabe der Bridge), sichtbar vorbelegt und änderbar; gespeicherte Endpunkte bleiben unberührt.
status: proposed
---

# Der Standard-Endpunkt

Wer Bridge und Firefox auf **einem** Rechner laufen lässt, muss heute eine
WebSocket-URL eintippen, die die Gegenseite ohnehin vorgibt: die Bridge bindet
per Default `127.0.0.1:8110` (`bridge/config.mjs`, `DEFAULT_BIND`). Diese Spec
nimmt diesen einen Eintrag aus dem Weg.

**Was sie nicht tut:** die Bridge suchen. Kein Probieren mehrerer Adressen,
kein mDNS, kein Caddy-Erraten. Der Standard ist eine **Vorgabe**, die man
überschreibt — kein Automatismus.

## Ziel

- **Ist der Endpunkt leer, ist er `ws://127.0.0.1:8110`.** Einmal als Konstante
  benutzt, an zwei Stellen: die Optionsseite **zeigt** ihn, der Hintergrund
  **verwendet** ihn. Anzeige und Verhalten dürfen nicht auseinanderlaufen —
  deshalb pinnt ein Test, dass beide Dateien denselben Wert tragen und dass er
  zum Port der Bridge passt.
- **Sichtbar, nicht still.** Das Feld ist vorbelegt, nicht in letzter Sekunde
  gefüllt; darunter ein Satz, wann man ihn ändert (Bridge auf einem anderen
  Rechner). Ein stiller Fallback würde aus „falsch konfiguriert" ein
  „verbindet nicht, und niemand weiß warum" machen.
- **Gespeicherte Endpunkte bleiben unangetastet.** Wer eine `wss://`-Adresse
  hinter Caddy eingetragen hat, merkt nichts — der Standard greift nur bei
  leerem Feld.
- **`ws://` bleibt erlaubt und geprüft wie bisher.** Ein ungültiger Endpunkt
  endet weiter mit `bc: Endpunkt ungültig:` und einem erneuten Versuch, nicht
  mit einem Absturz.
- **Die Optionsseite bleibt abhängigkeitsfrei** (eine Datei, kein Build), und
  das Manifest ändert sich nicht.

## Non-goals

- **Keine Discovery.** Kein Ausprobieren mehrerer Adressen, kein Netzwerk-Scan,
  kein mDNS, kein Lesen des Bridge-Ports aus einer Datei.
- **Keine Caddy-Erkennung.** Der öffentliche Weg bleibt Handarbeit
  (`INSTALL.md` §9).
- **Keine Änderung an gespeicherten Werten**, keine Migration, kein Umschreiben
  von `storage.local`.
- **Kein neues Feld, kein neues Werkzeug, keine neue Berechtigung.**
- **Keine stille Verbindung.** Der Endpunkt, der benutzt wird, steht im Feld —
  was verbindet, ist ablesbar.

## Die Entscheidung des Betreibers (2026-11-15)

| Frage | Entscheidung |
|---|---|
| Welcher Standard? | **`ws://127.0.0.1:8110`** — die Vorgabe der Bridge (`BC_BIND`), kein geratener Wert |
| Sichtbar oder still? | **sichtbar** — Feld vorbelegt, mit einem Hinweis für den Fernfall |
| Gilt für gespeicherte Endpunkte? | **nein** — nur ein leeres Feld |

## Die Messungen

Aus den Dateien gelesen, nicht geschätzt:

- `bridge/config.mjs` bindet per Default `127.0.0.1:8110`; die Bridge sucht
  **keinen** freien Port und beendet sich mit `1`, wenn der belegt ist.
- `extension/background.js` liest `endpoint` und `token` aus `storage.local`;
  ist einer davon leer, schreibt es **eine** Warnung (`missing settings`) und
  verbindet **nicht**. Es gibt heute keinen Default.
- `extension/options.js` schreibt beim Speichern `readFieldValue("endpoint").trim()`;
  ein leeres Feld speichert damit `""`.
- `extension/options.html` trägt heute den Platzhalter
  `wss://example.com/browser-control/ws` — ein Fernbeispiel an der Stelle, an
  der der häufige Fall lokal ist.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/extension.test.js` | `endpoint_withoutAStoredValue_shouldDialTheLoopbackDefault` | leerer Endpunkt ⇒ das Hintergrundskript wählt `ws://127.0.0.1:8110` |
| `test/extension.test.js` | `endpoint_withAStoredValue_shouldDialThatValue` | ein gespeicherter `wss://`-Endpunkt bleibt maßgeblich |
| `test/extension.test.js` | `endpoint_default_matchesTheBridgesDefaultPort` | der Standardendpunkt trägt denselben Port wie `DEFAULT_BIND` in `bridge/config.mjs` (Drift-Wächter: die zwei Dateien dürfen nicht auseinanderlaufen) |
| `test/extension.test.js` | `endpoint_default_isTheSameInOptionsAndBackground` | die Optionsseite zeigt und der Hintergrund benutzt **denselben** Wert |
| `test/extension.test.js` | `endpoint_withAnInvalidDefault_shouldStillLogTheInvalidEndpoint` | ein gespeicherter Unsinn bleibt der Fehlerfall von heute, nicht still |
| `npm test` | `# fail 0`, `# cancelled 0`, `# skipped 0` | nichts ist kaputt |

## Acceptance criteria

1. **Der Standard ist `ws://127.0.0.1:8110`.** Beweis:
   `grep -c 'ws://127.0.0.1:8110' extension/background.js` ⇒ **1**;
   `grep -c 'ws://127.0.0.1:8110' extension/options.js` ⇒ **1**;
   `npm test` grün.
2. **Der Port ist der der Bridge, nicht ein zweiter.** Beweis: der Fall
   `endpoint_default_matchesTheBridgesDefaultPort` liest `bridge/config.mjs`
   und `extension/background.js` und vergleicht die Zahl —
   `grep -cE '^test\("endpoint_default_matchesTheBridgesDefaultPort'
   test/extension.test.js` ⇒ **1**.
3. **Ein leerer Endpunkt verbindet, statt zu schweigen.** Beweis: der Fall
   `endpoint_withoutAStoredValue_shouldDialTheLoopbackDefault` ⇒ `1` im
   Dateitext, und `node --test --test-reporter=tap
   --test-name-pattern 'endpoint_' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_'`
   ⇒ **5**.
4. **Gespeicherte Werte gewinnen.** Beweis:
   `endpoint_withAStoredValue_shouldDialThatValue` ⇒ **1**; dazu der bestehende
   `wss://`-Fall im Fixture bleibt grün.
5. **Anzeige und Verhalten sind derselbe Wert.** Beweis:
   `endpoint_default_isTheSameInOptionsAndBackground` ⇒ **1**.
6. **Der Fernfall bleibt beschrieben.** `extension/options.html` nennt unter dem
   Feld, dass die URL nur für eine Bridge auf einem anderen Rechner geändert
   wird, und der Platzhalter zeigt keine konkrete Fremdadresse mehr. Beweis:
   `grep -c 'example.com' extension/options.html` ⇒ **0**;
   `grep -ciE 'anderer Rechner|another machine' extension/options.html` ⇒ **≥ 1**.
7. **Kein neues Feld, keine neue Berechtigung, kein Werkzeug.** Beweis:
   `git diff -- extension/manifest.json` ⇒ **leer**;
   `grep -c 'TOOL_COUNT = 13' test/http-mcp.test.js` ⇒ **1**;
   `npm test` grün.
8. **Kein Produktcode außerhalb der Grenze.** Beweis:
   `git status --porcelain` ⇒ nur `extension/background.js`,
   `extension/options.js`, `extension/options.html`, `test/extension.test.js`,
   `docs/…`, `INSTALL.md`; `git diff -- bridge/` ⇒ leer (die Bridge wird nur
   **gelesen**, nicht geändert).
9. **Kein Geheimnis.** Beweis:
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1.

## Dev plan

*Wird nach der Absprache über Ziel und Kriterien vom Subagenten `architect`
geschrieben.*

**Was der Plan berücksichtigen muss** (Vorgaben, keine Messungen):

- Der Wert steht **einmal** als benannte Konstante je Datei (`background.js`,
  `options.js`); geteilt wird er über einen Test, nicht über eine neue
  Abhängigkeit — `options.html` lädt nur `options.js`, und `background.js` ist
  eine IIFE.
- Die Optionsseite füllt das Feld nur, wenn **nichts** gespeichert ist
  (`asText(stored[ENDPOINT_KEY]).trim() === ""`); gespeicherte Werte werden
  angezeigt, wie sie sind.
- Der Hintergrund verwendet den Standard **nach** dem Lesen aus
  `storage.local` und **vor** der Prüfung „endpoint oder token leer" — sonst
  bliebe die heutige Warnung stehen und es passierte nichts.
- Ein leerer **Token** führt weiterhin nicht zu einer Verbindung; der Standard
  betrifft nur den Endpunkt.
- `INSTALL.md` (englisch) sagt in §4, dass das Feld vorbelegt ist und wann man
  es ändert; der Caddy-Abschnitt verweist weiter auf den Fernfall.

## Bekannte Lücken

Stand 2026-11-15, vor der Umsetzung:

- **Ungemessen:** ob Firefox `ws://127.0.0.1:8110` aus einer
  `moz-extension://`-Seite unter allen Profil-Einstellungen erlaubt. Loopback
  gilt als vertrauenswürdig; gemessen wird es erst im Live-Lauf.
- **Nicht abgedeckt:** eine Bridge auf einem anderen Port (`BC_BIND` geändert) —
  dann muss der Betreiber den Endpunkt eintragen, wie heute.
- **Nicht abgedeckt:** mehrere Bridges im selben Netz.

## Open questions

**Keine offenen.** Entschieden am 2026-11-15 vom Betreiber: `ws://127.0.0.1:8110`,
sichtbar vorbelegt, nur bei leerem Feld.

## Review

### Runde 1 — steht aus

Die Spec geht durch das Gate, sobald Ziel und Kriterien abgesprochen sind.

## Log

- **2026-11-15, Betreiberentscheid:** Standard-Endpunkt `ws://127.0.0.1:8110`,
  sichtbar vorbelegt; gespeicherte Werte bleiben unberührt.
