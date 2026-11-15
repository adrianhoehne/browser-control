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

1. **Der Standard ist `ws://127.0.0.1:8110`, genau einmal je Datei.** Beweis —
   der Name **und** der Wert, zeilenweise gepinnt:
   `grep -Fc 'const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";' extension/background.js`
   ⇒ **1**; dieselbe Zeile für `extension/options.js` ⇒ **1**; dazu
   `grep -Fc 'ws://127.0.0.1:8110' extension/background.js` ⇒ **1** (die Adresse
   wird in der Datei nicht wiederholt — auch nicht in einem Kommentar, sonst
   zählt der Beweis zwei Zeilen und wäre falsch-rot).
2. **Der Port ist der der Bridge.** Beweis: der Fall
   `endpoint_default_matchesTheBridgesDefaultPort` liest `DEFAULT_BIND` aus
   `bridge/config.mjs` und vergleicht ihn mit der Dial-Adresse des
   Hintergrunds; grün gezählt:
   `node --test --test-reporter=tap --test-name-pattern='^endpoint_default_matchesTheBridgesDefaultPort$' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_default_matchesTheBridgesDefaultPort'`
   ⇒ **1**. Ändert jemand `DEFAULT_BIND` **oder** die Konstante, wird der Fall rot.
3. **Ein leerer Endpunkt verbindet, statt zu schweigen — fünf Fälle, jeder
   grün.** Beweis:
   `node --test --test-reporter=tap --test-name-pattern='^endpoint_' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_(withoutAStoredValue_shouldDialTheLoopbackDefault|withAStoredValue_shouldDialThatValue|default_matchesTheBridgesDefaultPort|default_isTheSameInOptionsAndBackground|withAnInvalidDefault_shouldStillLogTheInvalidEndpoint)'`
   ⇒ **5**.
4. **Gespeicherte Werte gewinnen.** Beweis: `endpoint_withAStoredValue_shouldDialThatValue`
   fährt einen `wss://`-Endpunkt und beobachtet ihn als Dial-Adresse; der
   Bestandsfall mit gespeichertem Endpunkt bleibt grün:
   `grep -cE '^test\("connect_withEndpointAndToken_shouldSendHelloWithProtocolOneAndToken'
   test/extension.test.js` ⇒ **1** und seine `ok`-Zeile ⇒ **1**.
5. **Anzeige und Verhalten sind derselbe Wert — und nur ein leeres Feld wird
   gefüllt.** Beweis: `endpoint_default_isTheSameInOptionsAndBackground` liest
   die Konstante aus `options.js` und vergleicht sie mit der beobachteten
   Dial-Adresse; dieselbe Zusicherung prüft, dass `options.js` die Form
   `storedEndpoint === "" ? DEFAULT_ENDPOINT : storedEndpoint` trägt (ein
   gespeicherter Wert wird angezeigt, wie er ist); `ok`-Zeile ⇒ **1**.
6. **Der Fernfall bleibt beschrieben.** `extension/options.html` nennt unter dem
   Feld, dass die URL nur für eine Bridge auf einem anderen Rechner geändert
   wird, und der Platzhalter zeigt keine konkrete Fremdadresse mehr. Beweis:
   `grep -c 'example.com' extension/options.html` ⇒ **0** (Exit 1);
   `grep -ciE 'anderer Rechner|another machine' extension/options.html` ⇒ **≥ 1**;
   dazu `INSTALL.md`:
   `sed -n '/^## 4\./,/^## 5\./p' INSTALL.md | grep -Fc 'ws://127.0.0.1:8110'`
   ⇒ **1**; `… | grep -ciE 'another machine|other machine'` ⇒ **≥ 1**;
   `grep -Fc 'endpoint or token empty' INSTALL.md` ⇒ **0** (Exit 1).
7. **Kein neues Feld, keine neue Berechtigung, kein Werkzeug.** Beweis:
   `git diff HEAD -- extension/manifest.json` ⇒ **leer**;
   `grep -c 'TOOL_COUNT = 13' test/http-mcp.test.js` ⇒ **1**; `npm test` grün.
8. **Kein Produktcode außerhalb der Grenze.** Beweis:
   `git status --porcelain` ⇒ nur `extension/background.js`,
   `extension/options.js`, `extension/options.html`, `test/extension.test.js`,
   `INSTALL.md`, `docs/…`; `git diff HEAD -- bridge/` ⇒ **leer** (die Bridge
   wird nur **gelesen**, nicht geändert).
9. **Kein Geheimnis.** Beweis:
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1.

## Dev plan

Bau-Reihenfolge, eine Stufe je Auftrag, keine Stufe hängt von einer späteren
ab. Der Wert `ws://127.0.0.1:8110` steht **einmal je Datei** als
`const DEFAULT_ENDPOINT`; geteilt wird er über die Fälle aus Stufe 2–4, nicht
über ein neues Modul. Alle Beweise ohne `$` am Musterende, damit ein angehängter
TAP-Kommentar den Treffer nicht verschluckt; `grep -c` mit `0` Treffern endet mit
Exit 1 — das ist dort das Ergebnis, nicht der Fehler.

**1. Hintergrund: der Standard greift vor der Leer-Prüfung.** (Umsetzer)
`extension/background.js`: `const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";`
neben `ENDPOINT_KEY`/`TOKEN_KEY` — der Kommentar darüber nennt
`bridge/config.mjs` (`DEFAULT_BIND`) und Spec 36, wiederholt die Adresse aber
**nicht**. In `connect()` direkt nach dem `readSettings`-`try/catch` und **vor**
der Prüfung „endpoint oder token leer": `if (settings.endpoint === "")
settings.endpoint = DEFAULT_ENDPOINT;`. Der Endpunkt-Half der Warnung bleibt
stehen; ein leerer **Token** verbindet weiterhin nicht.
`test/extension.test.js`: `startBackground_withTokenButNoEndpoint_shouldNotOpenConnection`
wird durch `endpoint_withoutAStoredValue_shouldDialTheLoopbackDefault`
**ersetzt** — gleiches GIVEN (`{ token: TOKEN }`), umgekehrtes THEN (Dial-Adresse
ist der Standard, keine `warn:`-Zeile, `storage.local` unverändert). Der
Nachbarfall mit leerem Token bleibt.

Proof:
```
node --test --test-reporter=tap --test-name-pattern='^endpoint_withoutAStoredValue' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_withoutAStoredValue_shouldDialTheLoopbackDefault'   # ⇒ 1
grep -c 'startBackground_withTokenButNoEndpoint_shouldNotOpenConnection' test/extension.test.js; echo $?   # ⇒ 0, Exit 1
npm test; echo $?   # ⇒ 0, "# fail 0" und "# cancelled 0"
```

**2. Wächter: der Port ist der der Bridge.** (Umsetzer, nur Testdatei)
Import `loadConfig` aus `../bridge/config.mjs` mit `NO_ENV = {}` (Vorbild
`test/config.test.js`) — ohne `{}` läse er `process.env` und ein exportiertes
`BC_BIND` vergliche den Standard gegen eine fremde Adresse. Fall
`endpoint_default_matchesTheBridgesDefaultPort`: Hintergrund mit
`{ token: TOKEN }` starten, `new URL(FakeWebSocket.latest().url)` gegen
`loadConfig(NO_ENV)` — `protocol === "ws:"`, `hostname === config.host`,
`port === String(config.port)`.

Proof:
```
node --test --test-reporter=tap --test-name-pattern='^endpoint_default_matchesTheBridgesDefaultPort$' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_default_matchesTheBridgesDefaultPort'   # ⇒ 1
```

**3. Optionsseite: derselbe Wert, sichtbar, mit Hinweis.** (Umsetzer)
`extension/options.js`: `const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";`. In
`loadSettings` die Zuweisung ersetzen durch
`const storedEndpoint = asText(stored[ENDPOINT_KEY]).trim();` und in **einer**
Zeile `… = storedEndpoint === "" ? DEFAULT_ENDPOINT : storedEndpoint;` —
gespeicherte Werte werden angezeigt, wie sie sind, auch `wss://…`.
`extension/options.html`: den Platzhalter `wss://example.com/browser-control/ws`
**entfernen** (das Feld ist vorbelegt; eine zweite Kopie der Adresse wäre eine
dritte Driftstelle), unter dem Feld einen `p class="hint"` mit dem Fernfall, und
den Kopfsatz korrigieren: leer ist jetzt nur noch der **Token**, der eine
Verbindung verhindert.
Fall `endpoint_default_isTheSameInOptionsAndBackground`: `options.js` als Text
lesen, die Konstante per Muster ziehen, mit der im VM **beobachteten**
Dial-Adresse vergleichen; zweite Zusicherung im selben Fall: die Datei trägt die
Form `storedEndpoint === "" ? DEFAULT_ENDPOINT : storedEndpoint`.

Proof:
```
node --test --test-reporter=tap --test-name-pattern='^endpoint_default_isTheSameInOptionsAndBackground$' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_default_isTheSameInOptionsAndBackground'   # ⇒ 1
grep -c 'example.com' extension/options.html; echo $?   # ⇒ 0, Exit 1
grep -c 'anderer Rechner' extension/options.html        # ⇒ 1
```

**4. Unsinn bleibt ein Fehler — und der Gesamtlauf.** (Umsetzer)
Fall `endpoint_withAnInvalidDefault_shouldStillLogTheInvalidEndpoint`: GIVEN
`{ endpoint: "not a url", token: TOKEN }`, THEN genau eine Zeile
`bc: Endpunkt ungültig:`, `FakeWebSocket.instances.length === 0`,
`clock.pendingDelays()` ⇒ `[1000]`, und **keine** Konsolenzeile enthält
`ws://127.0.0.1:8110` — der Standard hat den Tippfehler nicht übernommen. Fall
`endpoint_withAStoredValue_shouldDialThatValue`: `{ endpoint:
"wss://bridge.example.test/browser-control/ws", token: TOKEN }` ⇒ die
Dial-Adresse ist genau dieser Wert.

Proof:
```
node --test --test-reporter=tap --test-name-pattern='^endpoint_' test/extension.test.js | grep -cE '^ok [0-9]+ - endpoint_(withoutAStoredValue_shouldDialTheLoopbackDefault|withAStoredValue_shouldDialThatValue|default_matchesTheBridgesDefaultPort|default_isTheSameInOptionsAndBackground|withAnInvalidDefault_shouldStillLogTheInvalidEndpoint)'   # ⇒ 5
npm test; echo $?    # ⇒ 0, "# fail 0", "# cancelled 0", "# skipped 0"
npm run check; echo $?   # ⇒ 0
```

**5. `INSTALL.md` (englisch).** (Umsetzer)
§4 Schritt 5: das Feld ist mit `ws://127.0.0.1:8110` vorbelegt und wird nur
geändert, wenn die Bridge auf einem **anderen** Rechner läuft; der Caddy-Verweis
in §9 bleibt. In §8 die Zeile „endpoint or token empty" auf den Token verkürzen —
ein leeres Feld schweigt nach dieser Änderung nicht mehr.

Proof:
```
sed -n '/^## 4\. Browser/,/^## 5\./p' INSTALL.md | grep -Fc 'ws://127.0.0.1:8110'   # ⇒ 1
sed -n '/^## 4\. Browser/,/^## 5\./p' INSTALL.md | grep -ciE 'another machine|other machine'   # ⇒ ≥ 1
grep -Fc 'endpoint or token empty' INSTALL.md; echo $?   # ⇒ 0, Exit 1
```

### What could go wrong

- **Der widersprechende Bestandsfall.** `…_withTokenButNoEndpoint_shouldNotOpenConnection`
  behauptet „es gibt nichts anzuwählen" — genau das hebt die Spec auf. Bleibt
  er stehen, wird `npm test` rot; er wird **ersetzt**, nicht repariert.
- **Der Standard am falschen Ort.** In `readSettings` gesetzt, wäre der Name
  eine Lüge und die Spec-Formulierung nicht mehr am Code ablesbar.
- **Das Literal ein zweites Mal.** Ein Kommentar mit der Adresse macht aus
  Kriterium 1 eine **2** — formal richtig, aber falsch-rot. Kommentare nennen
  `DEFAULT_ENDPOINT` und `DEFAULT_BIND`.
- **`loadConfig()` ohne Argument** liest `process.env` — `NO_ENV = {}` benutzen.
- **`ENDPOINT` in der Testdatei umbenennen:** die Testdatei trägt die Adresse
  bereits als `ENDPOINT` (rund 40 Verwendungen). Wer sie „aufräumend" zu
  `DEFAULT_ENDPOINT` macht, lässt den Wächter die Testdatei mit sich selbst
  vergleichen — ein grüner Beweis ohne Aussage.
- **Der einzige Optionsbeweis ist Text.** Es gibt keinen DOM-Harness für
  `options.js`; die Regel „nur wenn nichts gespeichert ist" hängt an einem
  Muster auf dem Quelltext. Ein Umformatieren macht den Fall rot, obwohl das
  Verhalten stimmt — dann Zusicherung und Zeile gemeinsam ändern.
- **Die Vorbelegung ist keine Bindung.** Nach dem ersten Speichern steht die
  Adresse in `storage.local` und ist damit der Wert des Betreibers.
- **Loopback in Firefox** bleibt ungemessen (`## Bekannte Lücken`).

### Ordering and dependencies

1 → 2 → 3 → 4 → 5, dann 6 (Orchestrator: `status: active`, `docs/README.md`,
`docs/PROJECT-STATE.md`). Stufe 2 und 3 brauchen den Standard aus Stufe 1;
Stufe 4 braucht alle fünf Fälle, um auf **5** zu zählen. Stufe 5 ist vom Code
unabhängig, nennt aber denselben Wert.

### What the next increment inherits

- **Die Warnung „missing settings"** sagt weiter „Endpunkt oder Token fehlt",
  obwohl nur noch der Token fehlen kann — eine offene Lüge im Log.
- **Kein DOM-Harness für `options.js`**; der ehrliche Test („leere Ablage ⇒ Feld
  zeigt den Standard") braucht einen `document`-Stub — eigene Spec.
- **`docs/PROJECT-STATE.md`** beschreibt den Endpunkt weiter als Handarbeit;
  Stufe 6 zieht nur Spec-Status und Registry nach.
- **Anderer Port, andere Maschine** bleiben Handarbeit (§9) — keine Discovery.

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
