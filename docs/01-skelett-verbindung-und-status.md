---
description: Das Skelett des ersten Inkrements — eine Firefox-Extension, die sich per WSS über Caddy zum Server rauswählt, und eine Bridge dort, die das Token prüft, den Status abfragt und Fenster und Tabs aus dem Default-Container protokolliert; ohne MCP, ohne Tool für pi.
status: active
---

# Skelett: Verbindung und `status`

Dieses Inkrement baut die **Naht**, nicht den Zugang: die Extension im echten
Profil des Betreibers wählt sich per WSS zum Server raus, die Bridge
authentifiziert sie, fragt den Status ab und schreibt ihn ins Log. pi ist noch
nicht beteiligt — MCP und das erste Tool sind eine eigene Spec.

Entschieden in `docs/PROJECT-STATE.md` (nicht neu zu verhandeln): Firefox,
Extension + Bridge als ein Projekt, WebSocket aus dem Browser heraus,
Default-Container, Anmeldung macht der Betreiber. Mit dem Betreiber am
2026-10-23 abgestimmt: Zuschnitt „Verbindung + Status, noch kein Tool",
Transport WSS über den bestehenden Caddy mit öffentlichem Namen und
Let's-Encrypt-Zertifikat, **null Laufzeitabhängigkeiten**, Prüfung mit
`node:test`.

## Ziel

Der Betreiber lädt die Extension einmal in seinem echten Firefox-Profil und
trägt Endpunkt und Token ein; danach steht im Bridge-Log, welche Fenster und Tabs
im Default-Container offen sind — mit URL und Titel.

Damit werden vier der fünf unsicheren Stellen belegt, bevor Steuerung dazukommt:
TLS über Caddy, Token-Austausch im ersten Frame, selbstgeschriebenes RFC 6455 und
Wiederaufbau nach Verbindungsabbruch. Die fünfte, der MV3-Lebenszyklus, ist
inzwischen **gemessen**: Firefox entlädt die Eventpage nach 30 s, die Verbindung
fällt (`1001`), ein Wiederaufbau folgt nicht — Reparatur in Spec 02
(`docs/02-persistenter-background.md`). Jede dieser Stellen kann später einen
ganzen Abend kosten; jetzt kostet sie ein Log.

## Non-goals

- **Kein MCP-Server, keine `mcp.json`, kein Tool für pi** — eigene Spec, sobald
  die Naht steht. stdout bleibt in diesem Inkrement leer, damit es im nächsten
  JSON-RPC gehören kann.
- Keine Tab-Steuerung: kein `navigate`, kein Klick, kein Tastendruck, kein
  Screenshot, kein `focus`, kein Anlegen eines Agenten-Tabs.
- Keine Signierung, kein XPI, keine Auslieferung — die Extension wird über
  `about:debugging` temporär geladen.
- Keine unaufgeforderten Nachrichten von der Extension zur Bridge (nur `hello`
  und Antworten auf Anfragen), kein Heartbeat, keine Sitzungsverwaltung, kein
  zweiter Nutzer.
- Kein Umbau von Caddy auf dem Server durch den Umsetzer: das Snippet liefert er,
  der Betreiber trägt es ein.

## Architecture

Ein Node-Prozess auf dem Server, eine Extension im Browser, kein Paket dazwischen:

```
Firefox (echtes Profil, Default-Container)
  extension/background.js ── wss://example.com/browser-control/ws ──▶ Caddy
                                                                                 │ reverse_proxy
                                                                                 ▼
                                                                         127.0.0.1:8110
                                                                  bridge/bridge.mjs
                                                                  ├ websocket.mjs (RFC 6455)
                                                                  ├ hub.mjs       (Anfragen, Zeitlimits)
                                                                  └ config.mjs    (Umgebung, Token-Datei)
                                                                                 │ stderr
                                                                                 ▼
                                                                           Log, Konsole
```

Die Bridge ist ein Prozess ohne MCP: sie lauscht, prüft, fragt `status` und
schreibt das Ergebnis auf stderr. stdout bleibt leer und ist für die
JSON-RPC-Schicht des nächsten Inkrements reserviert.

## Wire-Protokoll (Extension ↔ Bridge)

Eine WebSocket-Verbindung, Textframes, eine JSON-Nachricht pro Frame, `protocol`
ist `1`. Die Konstanten stehen in `extension/protocol.js` (klassisches Skript,
lädt vor `background.js`) und in `bridge/protocol.mjs` (ESM); ein Test vergleicht
beide, damit sie nicht auseinanderlaufen.

1. Verbindung offen (TLS hat Caddy beendet).
2. Extension → Bridge, innerhalb von **5 s**:
   `{"type":"hello","protocol":1,"extensionVersion":"0.1.0",
   "browser":{"name":"Firefox","version":"152.0.3"},"token":"<hex>"}`
3. Bridge prüft das Token zeitkonstant gegen die Token-Datei
   (`crypto.timingSafeEqual` über SHA-256 beider Werte, Längen vorher
   verglichen). Falsch → Close **4401** und eine Logzeile `auth failed`. Kein
   zweiter Versuch auf derselben Verbindung, kein Hinweis auf das erwartete
   Token.
4. Bridge → Extension: `{"type":"welcome","protocol":1,"bridgeVersion":"0.1.0"}`.
   Erst danach gilt die Extension als verbunden.
5. Bridge → Extension: `{"type":"request","id":1,"method":"status","params":{}}`
   — sofort nach `welcome`.
6. Extension → Bridge: `{"type":"response","id":1,"ok":true,"result":{…}}` oder
   `{"type":"response","id":1,"ok":false,"error":{"code":"…","message":"…"}}`.

Regeln: `id` ist eine ganze Zahl, je Verbindung monoton. Nur `status` ist in
diesem Inkrement bekannt; jede andere Methode beantwortet die Extension mit
`ok:false, code:"unsupported_method"`. Kommt innerhalb von **20 s** keine
Antwort, gilt die Anfrage als gescheitert, die Verbindung bleibt bestehen, und
das Log sagt es. Eine `ok:false`-Antwort loggt die Bridge als
`status failed peer=<ip> code=<…>` — ebenfalls ohne die Verbindung zu schließen.

Ist die **erste** Nachricht kein wohlgeformtes `hello` (kein JSON-Objekt,
falscher `type`, fehlendes oder leeres `token`), schließt die Bridge mit **1002**
und loggt `protocol error peer=<ip>`; ein `hello` nach Ablauf der Frist ist damit
kein Sonderfall. `connectedAt` im Ergebnis setzt die Extension in dem Moment, in
dem sie `welcome` empfängt — nur ihre Uhr weiß, wann sie verbunden war.

Nicht verhandelt werden `Sec-WebSocket-Extensions` (keine Kompression) und
`Sec-WebSocket-Protocol` (kein Subprotokoll). Close-Codes der Bridge: 4401 Token
falsch, 4408 kein `hello` in 5 s, 4409 durch eine neuere Verbindung ersetzt (die
neue gewinnt — der Normalfall, wenn der Betreiber die Extension neu lädt), 1002
Protokollfehler (unmaskierter Frame, kaputte Fragmente, erste Nachricht kein
`hello`), 1009 Nachricht über 5 MiB, 1003 Binärframe.

Wiederaufbau in der Extension: nach jedem Close Exponentialbackoff,
`min(30 s, 1 s · 2^(n−1))` plus 0–250 ms Jitter, `n` zurück auf 0 nach
`welcome`. Ein **abgelehnter Endpunkt zählt wie ein Close**: `new WebSocket(...)`
wirft bei einer Nicht-URL synchron, das darf den Wiederaufbau nicht abwürgen —
also einmal ins Konsolen-Log der Extension (ohne Token) und derselbe Backoff.
Ohne gespeicherten Endpunkt oder ohne Token wählt sich die Extension nicht raus
und schreibt das einmal; dann gibt es bis zum nächsten Laden auch keinen Versuch.

### Ergebnis von `status`

```json
{
  "extension": {"version": "0.1.0", "connectedAt": "2026-10-23T09:12:31.004Z"},
  "windows": [
    {"id": 1, "focused": true, "type": "normal",
     "tabs": [{"id": 101, "active": true, "pinned": false,
               "url": "https://example.org/", "title": "Beispiel"}]}
  ]
}
```

Gefiltert wird in der Extension, nicht erst in der Bridge: nur Fenster mit
`type === "normal"` **und** `incognito === false`, und nur Tabs mit
`cookieStoreId === "firefox-default"` (`docs/PROJECT-STATE.md` Punkt 4 — ein
Container hätte einen eigenen Cookie-Jar und wäre nicht eingeloggt). Private
Fenster sind in Firefox ebenfalls `type: normal`, tragen aber `incognito: true`;
ohne dessen Ausschluss stünde ein leeres Fenster in der Liste. Tabs ohne `url`
(etwa `about:newtab` kurz nach dem Öffnen) erscheinen mit `"url": ""`.

### Was die Bridge ausgibt

Alles auf stderr, nichts auf stdout. stdout bleibt in diesem Inkrement leer —
ein `console.log` beim Start ist deshalb ein Fehler, kein Schönheitsfehler.

Nach jeder erfolgreichen `status`-Antwort steht genau eine Zeile dort:

```
status windows=2 tabs=14
```

Mit `BC_LOG=debug` zusätzlich das vollständige Ergebnis als eingerücktes JSON,
davor und dahinter nichts. Alle Zeilen tragen einen ISO-Zeitstempel:
`extension connected peer=<ip> protocol=1`,
`extension disconnected reason=<…>`, `auth failed peer=<ip>`,
`status failed peer=<ip> code=<…>`, `status timeout peer=<ip>`,
`protocol error peer=<ip>`, `token file missing or too short: <pfad>`.

`peer` ist der Socket-Peer und damit hinter Caddy **immer** `127.0.0.1`; steht
dort eine andere Adresse, läuft der Reverse-Proxy nicht wie beschrieben. Einen
`X-Forwarded-For` liest die Bridge bewusst nicht — das wäre Vertrauen in einen
Header, den jeder Client setzen kann.

## Configuration

Bridge, über Umgebung gelesen, einmal beim Start:

| Variable | Default | Bedeutung |
|---|---|---|
| `BC_BIND` | `127.0.0.1:8110` | Adresse des WebSocket-Listeners; am **letzten** `:` getrennt, damit `[::1]:8110` nicht zerbricht |
| `BC_TOKEN_FILE` | `~/.config/browser-control/token` | Token-Datei, `chmod 600`, Inhalt ≥ 32 Hex-Zeichen |
| `BC_HELLO_TIMEOUT_MS` | `5000` | Frist für `hello` |
| `BC_CALL_TIMEOUT_MS` | `20000` | Frist für eine Extension-Antwort |
| `BC_LOG` | `info` | `info` oder `debug` |

Der Default von `BC_TOKEN_FILE` wird mit `os.homedir()` gebildet — Node expandiert
`~` **nicht**, ein literales `~` in `readFile` wäre ein garantiertes `ENOENT` bei
richtiger Konfiguration. Gelesen wird der expandierte Pfad; der Inhalt wird
getrimmt, weil `openssl rand -hex 32 > token` einen Zeilenumbruch schreibt.

Fehlt die Token-Datei, ist sie kürzer als 32 Hex-Zeichen oder enthält sie nach dem
Trimmen kein Hex, endet die Bridge mit Exit-Code **2** und der stderr-Zeile
`token file missing or too short: <pfad>` — sie startet nicht mit leerem Token.

Extension, über die Optionsseite (`options_ui`), gespeichert in
`browser.storage.local`:

| Schlüssel | Default | Bedeutung |
|---|---|---|
| `endpoint` | (leer) | `wss://example.com/browser-control/ws`; leer = keine Verbindung |
| `token` | (leer) | dasselbe Token wie auf dem Server, getrimmt gespeichert |

Caddy auf dem Server — **ungeprüfter Vorschlag**, weil die Caddy-Konfiguration
nicht gelesen werden konnte (`## Open questions`). Der Betreiber trägt ihn ein;
entscheidend ist nicht der Wortlaut, sondern das Ergebnis: ein Upgrade auf
`/browser-control/ws` darf **kein 401** bekommen. Der Site-Block bedient heute
Basic-Auth (belegt: `curl -I https://example.com/` → 401), und ein
Browser-`WebSocket` kann keinen `Authorization`-Header setzen — der Pfad muss
also aus der Basic-Auth heraus:

```
example.com {
    # Die Extension authentifiziert sich mit dem Token im hello-Frame.
    handle /browser-control/ws {
        reverse_proxy 127.0.0.1:8110
    }

    handle {
        # … bestehende Konfiguration, inklusive basic_auth …
    }
}
```

Der zweite `handle` ist nicht Zierde: bleibt die `basic_auth` auf Site-Ebene
stehen, bekommt der WS-Pfad weiterhin 401 — in Caddys Direktivenreihenfolge
läuft `basic_auth` vor `handle`, und zwei `handle`-Blöcke darunter ändern daran
nichts. Sie muss deshalb **in den zweiten `handle` wandern**; dann schließen sich
die Zweige aus (gleiche Gruppe, erster Treffer gewinnt), und der WS-Zweig liegt
vorn.

Prüfbar ohne Firefox (Kriterium 4): der Upgrade muss mit **101** antworten,
nicht mit 401 und nicht mit 502.

## Sicherheit

- **Das Token steht nirgends im Repo und nie in einer URL.** Der WebSocket-Client
  im Browser kann keine Header setzen, und ein Query-Parameter landet in
  Caddy-Zugriffslogs — also geht das Token als erste Nachricht im `hello`-Frame.
- **Der WS-Pfad liegt außerhalb der Basic-Auth.** Anders ginge es nicht, und es
  ist die einzige Stelle der Site, die ohne Header erreichbar ist; die
  Authentifizierung ist dort das Token im ersten Frame, geprüft vor jeder
  weiteren Nachricht. Erreichbar ist das nur mit dem `handle`-Paar aus
  `## Configuration` — ein einzelner `handle` genügt nicht.
- **Logzeilen nennen das Token nicht**, auch nicht gekürzt; ein Test schneidet
  stderr mit und prüft es.
- **Die Extension sieht alle Tabs des Default-Containers.** Das ist der Zweck,
  aber es erweitert die Sichtbarkeit: mit der `tabs`-Berechtigung bekommt
  später pi jeden Titel und jede URL. Container-Tabs und private Fenster werden
  herausgefiltert.
- **Ein Token, eine Extension.** Eine zweite Verbindung mit gültigem Token
  ersetzt die erste (4409); es gibt keine Sitzungsverwaltung und keine
  Rechteunterscheidung.

## Additional dependencies

Keine npm-Pakete, weder zur Laufzeit noch für Tests (`package.json` bleibt ohne
`dependencies`/`devDependencies`). Laufzeitvoraussetzung ist **Node ≥ 22** (Lizenz
MIT): `node --test`, `node:vm` und der globale `WebSocket`-Client in den Tests
gibt es vorher nicht in dieser Form. Auf der Entwicklungsmaschine gemessen:
`node v22.23.1`, `npm 10.9.8` (2026-10-23).

## Testing

Alle Fälle laufen ohne Browser und ohne Netz (`npm test` → `node --test
test/*.test.js`; das Muster ist nötig, weil der Runner sonst auch
`test/fixtures/fake-extension.mjs` als Testdatei startet).

| Datei / Fall | Was er beweist |
|---|---|
| `test/protocol.test.js` — `extension/protocol.js` in `node:vm` laden, gegen `bridge/protocol.mjs` vergleichen | Die beiden Kopien der Protokollkonstanten sind identisch |
| `test/extension.test.js` — `protocol.js` und `background.js` in `node:vm` mit `browser`-Stub, Fake-`WebSocket` und Timer-Stub | Ohne Endpunkt/Token kein Verbindungsversuch, `hello` mit `protocol:1`, `welcome` ⇒ `status`, Container-Tab und privates Fenster fehlen, `url:""` ohne URL, Backoff 1000/2000/4000 ms, ungültiger Endpunkt ⇒ eine Konsolenzeile ohne Token und ein neuer Versuch |
| `test/websocket.test.js` — Handshake mit dem Beispielschlüssel aus RFC 6455 §1.3 (`dGhlIHNhbXBsZSBub25jZQ==` → `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`) | `Sec-WebSocket-Accept` ist korrekt gerechnet |
| dito — fragmentierte Textnachricht (zwei Frames, `fin=0/1`) | Fragmente werden zusammengesetzt |
| dito — Ping → Pong, Close → Close-Echo | Steuerframes werden beantwortet |
| dito — unmaskierter Frame | Close 1002 statt Absturz |
| dito — Binärframe | Close 1003 |
| dito — Nachricht über 5 MiB | Close 1009, Speicher bleibt begrenzt |
| `test/hub.test.js` — echter Server, falsches Token | Close 4401, Logzeile `auth failed`, Token kommt in stderr nicht vor |
| dito — kein `hello` binnen `BC_HELLO_TIMEOUT_MS=200` | Close 4408 |
| dito — gültiges `hello`, dann 400 ms warten | Der Hello-Timer wird nach `welcome` gelöscht: die Verbindung lebt und beantwortet weiter |
| dito — erste Nachricht ist `{"type":"nope"}` | Close 1002, Logzeile `protocol error` |
| dito — zwei Verbindungen mit gültigem Token | Die erste bekommt 4409, die zweite eine Antwort |
| dito — keine Antwort in `BC_CALL_TIMEOUT_MS=200` | Logzeile `status timeout`, kein Absturz, Verbindung lebt weiter |
| dito — Antwort mit `ok:false` | Logzeile `status failed … code=…`, kein Close |
| `test/bridge.test.js` — Bridge als Kindprozess, Fake-Extension (`test/fixtures/fake-extension.mjs`) antwortet mit zwei Fenstern und drei Tabs; `BC_LOG=debug` | stderr enthält **exakt** die Zeile `status windows=2 tabs=3` und das JSON; stdout ist leer; `SIGTERM` → Exit 0 |
| dito — Token-Datei mit abschließendem Zeilenumbruch | Getrimmt gelesen, die Verbindung gelingt |
| dito — Bridge ohne erreichbare Antwort | Exit-Code bleibt 0, stderr nennt den Grund, stdout bleibt leer |

Von Hand, weil nur der Betreiber das Profil hat (Beleg: eingefügte Zeilen):

- **Zwischenschritt, empfohlen:** Bridge lokal starten (`BC_BIND=127.0.0.1:8110`)
  und in den Optionen `ws://127.0.0.1:8110` eintragen. Klappt es dort, liegt ein
  späterer Fehlschlag an Caddy (TLS, Basic-Auth), nicht am Code.
- Extension über `about:debugging` → „Temporäre Erweiterung laden" → kein Fehler
  in der Konsole der Extension.
- Nach Eintrag von Endpunkt und Token: **Extension neu laden** (die Optionsseite
  wirkt erst beim nächsten Verbindungsaufbau, siehe `## Bekannte Lücken`) — dann
  zeigt Bridge-stderr `extension connected peer=…` und
  `status windows=… tabs=…`.
- Mit `BC_LOG=debug` erscheint im JSON der offene Tab, und ein Tab aus einem
  Multi-Account-Container fehlt.
- Falsches Token in den Optionen: Bridge loggt `auth failed` und schließt, die
  Extension versucht es mit Backoff erneut; `grep "<token>"` im Bridge-Log
  findet nichts.
- „Reload" in `about:debugging`: `extension disconnected`, dann
  `extension connected` höchstens 3 s später (1 s Backoff-Basis + ≤250 ms Jitter
  + Handshake).
- MV3-Sonde (Beobachtung, kein Kriterium): zehn Minuten nichts tun, dann stderr
  lesen. **Gefahren am 2026-10-23** — Ausgang: nach 30,0 s `extension
  disconnected reason=1001`, kein Wiederaufbau (siehe `## Bekannte Lücken`). Die
  Reparatur ist Spec 02.

## Acceptance criteria

1. `npm test; echo $?` → `0`, und `node --test --test-reporter=tap
   test/*.test.js 2>&1 | grep -q '^# fail 0'` → Exit 0. Der TAP-Reporter ist
   nötig, weil der Standard-Reporter im Terminal `ℹ fail 0` schreibt; die
   Zeichenkette `# fail 0` erscheint nur in der umgeleiteten Ausgabe. Dasselbe
   für `npm run check; echo $?` → `0`.
2. `BC_TOKEN_FILE=/nonexistent node bridge/bridge.mjs` endet mit Exit-Code 2 und
   der stderr-Zeile `token file missing or too short: /nonexistent`
   (Beleg: `echo $?` im selben Lauf).
3. Kein Geheimnis im Repo: `git grep --untracked -nE '[0-9a-f]{32,}' -- .` gibt
   nichts aus (Exit 1) — `--untracked` ist nötig, weil vor dem ersten Commit
   jede neue Datei untracked ist und `git grep` sie sonst nicht ansieht.
4. Der Upgrade erreicht die Bridge: `curl -isS --http1.1 -o /dev/null
   -w '%{http_code}' --max-time 10
   -H 'Connection: Upgrade' -H 'Upgrade: websocket'
   -H 'Sec-WebSocket-Version: 13'
   -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
   https://example.com/browser-control/ws` gibt `101`. `--http1.1`
   ist Pflicht, nicht Kosmetik: curl verhandelt sonst HTTP/2 mit Caddy, das
   einen h2-Request ohne Upgrade-Semantik als **normale** Anfrage an den
   h1-Upstream weiterreicht — die Bridge antwortet dann korrekt mit `426`, und
   das sieht aus wie ein Fehler. `401` heißt Basic-Auth im Weg, `502` heißt
   Bridge läuft nicht. Ein Exit-Code ungleich 0 ist hier **normal**
   (`curl: (52)` — nach dem 101 kommt kein HTTP-Body, entscheidend ist die
   ausgegebene Zahl).
5. Handprüfung im echten Profil: `about:debugging` lädt die Extension ohne
   Fehler; nach Eintrag von Endpunkt und Token und einem **Reload der Extension**
   erscheint in Bridge-stderr `extension connected` — binnen 5 s, das ist genau
   `BC_HELLO_TIMEOUT_MS`; später als das könnte die Bridge gar nicht verbinden
   (Beleg: Logzeile mit Zeitstempel).
6. Handprüfung: die Bridge schreibt `status windows=<n> tabs=<m>` mit `n ≥ 1`
   und `m ≥ 1`, und im `BC_LOG=debug`-JSON fehlt der Tab, der in einem
   Multi-Account-Container offen ist (Beleg: beide Zeilen, dazu der Container-Tab
   im Profil als Vorbedingung), und stdout des Laufs ist leer.
7. Handprüfung: „Reload" der Extension führt zu `extension disconnected` und
   spätestens 3 s später zu `extension connected` (Beleg: beide Zeilen mit
   Zeitstempel).
8. Handprüfung: mit falschem Token schließt die Bridge mit 4401 und loggt
   `auth failed`, und `grep -c "<token>"` auf Bridge-stderr ergibt 0 (Beleg:
   beide Ausgaben).

## Dev plan

Es existiert kein Code: jeder Pfad unten wird angelegt. Lokale Beweise sind
`node --test`, Kindprozesse und Exit-Codes; Kriterien 4–8 bleiben Handprüfungen
des Betreibers im echten Profil und stehen in keiner Stufe als Beweis, sondern
als Übergabe (Stufe 7).

1. **Gerüst und Protokollkonstanten** — `package.json` (`"type": "module"`,
   `"private": true`, `"engines": {"node": ">=22"}`, keine
   `dependencies`/`devDependencies`; `test` = `node --test test/*.test.js`,
   `check` = `node --check` über jede `.js`/`.mjs`-Datei), `bridge/protocol.mjs`
   (`export const PROTOCOL` — nur Datenwerte: Version `1`, `TYPES`
   hello/welcome/request/response, `METHODS` mit `status` (Spec 04 ergänzt
   `navigate`), `CLOSE`
   4401/4408/4409/1002/1003/1009, `MAX_MESSAGE_BYTES` 5242880,
   `HELLO_TIMEOUT_MS` 5000, `CALL_TIMEOUT_MS` 20000, `RECONNECT_BASE_MS` 1000,
   `RECONNECT_MAX_MS` 30000, `RECONNECT_JITTER_MS` 250; `bridge/config.mjs`
   importiert seine Defaults später von hier), `extension/protocol.js` als
   klassisches Skript mit `globalThis.BC_PROTOCOL = Object.freeze({…})`,
   `test/protocol.test.js` (`vm.runInNewContext` über den Quelltext, dann
   `assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.BC_PROTOCOL)),
   PROTOCOL)` — der JSON-Umweg ist Pflicht, `deepStrictEqual` vergleicht über
   Realms hinweg auch `[[Prototype]]` und scheitert sonst).
   Proof: `node --test --test-reporter=tap test/protocol.test.js` → `# fail 0`
   (TAP, weil der Standard-Reporter im Terminal `ℹ fail 0` schreibt); zum
   Nachweis, dass der Test beißt, eine Konstante in `extension/protocol.js`
   einmal verstellen (`# fail 1`, danach zurück);
   `grep -c dependencies package.json` → 0. **Completed 2026-10-23**
2. **RFC 6455-Kern (nur Frames, kein HTTP)** — `bridge/websocket.mjs`:
   `acceptKey(key)` (SHA-1, Base64), `class FrameDecoder` mit `push(chunk)`
   (maskieren aus, Fragmente nach `fin` zusammensetzen, Opcode- und
   Maskenbit-Prüfung, 1-MiB-Grenze, 1003 bei Binärframes), `encodeFrame(opcode,
   payload)`, `class WebSocketConnection extends EventEmitter` (`send(text)`,
   `ping()`, `close(code)`, Events `message`/`close`), `upgradeSocket(req,
   socket, head)` (Handshake, `Sec-WebSocket-Accept`, keine
   `Sec-WebSocket-Extensions`, kein `Sec-WebSocket-Protocol`).
   Proof: `node --test test/websocket.test.js` → `# fail 0`. Client im Test ist
   ein handgeschriebener `net`-Socket, weil nur er unmaskierte Frames,
   Fragmente und 1-MiB-Überläufe senden kann; der RFC-Beispielschlüssel
   `dGhlIHNhbXBsZSBub25jZQ==` muss `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=` ergeben.
   **Completed 2026-10-23**
3. **Konfiguration, Token-Datei, Prozessgerüst** — `bridge/config.mjs`:
   `loadConfig(env)` (`BC_BIND` am letzten `:` → `{host, port}`, `BC_LOG`,
   Defaults aus `bridge/protocol.mjs`), `tokenPath(env)` (Default mit
   `path.join(os.homedir(), ".config/browser-control/token")`),
   `readToken(path)` → `null` bei fehlender Datei, weniger als 32 Zeichen nach
   `trim()` oder Nicht-Hex (Rechte `600` sind Betreiberpflicht, nicht
   Code-Prüfung). `bridge/bridge.mjs`: `main()` liest die Konfiguration, bei
   `readToken() === null` die stderr-Zeile `token file missing or too short:
   <pfad>` und `process.exit(2)`; sonst `node:http`-Server, `listen(port, host)`,
   `upgrade` → `upgradeSocket`, `SIGTERM`/`SIGINT` → `server.close()` und Exit 0.
   Kein `console.log`: stdout bleibt leer. `formatStatusLine` kommt erst in
   Stufe 4.
   Proof: `BC_TOKEN_FILE=/nonexistent node bridge/bridge.mjs; echo $?` → Exit 2
   und die Zeile; mit `BC_TOKEN_FILE=$(mktemp -d)/token` und
   `openssl rand -hex 32 > $BC_TOKEN_FILE` (Datei außerhalb des Repos): Prozess
   läuft, `kill -TERM` → Exit 0, stdout leer.
   **Completed 2026-10-23**
4. **Hub: hello, Auth, welcome, `status`** — `bridge/hub.mjs`: `class Hub`
   (`{config, token, log, onStatus}`; seit Spec 03 zusätzlich `requestStatus()`
   mit Promise und `HubRequestError`, Id-Zähler je Session statt der festen
   `STATUS_REQUEST_ID`), `handleConnection(conn, peer)` mit
   Hello-Timer (`BC_HELLO_TIMEOUT_MS`, danach 4408; Timer nach `welcome`
   löschen; erste Nachricht kein wohlgeformtes `hello` → 1002 und
   `protocol error`), `verifyToken(expected, candidate)` (Längenvergleich vor
   `crypto.timingSafeEqual` über SHA-256 beider Werte), falsch → stderr
   `auth failed peer=<ip>` plus Close 4401, richtig → `welcome`, sofort
   `request` `{"id":1,"method":"status","params":{}}`, Antwort per `id`
   zuordnen: `ok:true` → `formatStatusLine(result)` (Tabs = Summe über alle
   Fenster) und bei `BC_LOG=debug` das eingerückte JSON, `ok:false` → `status
   failed peer=<ip> code=<…>`, `BC_CALL_TIMEOUT_MS` → `status timeout
   peer=<ip>`, beide ohne Close; eine neue gültige Verbindung schließt **nur die
   vorherige Referenz** mit 4409; Ereigniszeilen mit ISO-Zeitstempel auf stderr.
   Proof: `node --test test/hub.test.js` → `# fail 0`; echter Server auf Port 0,
   Node-22-`WebSocket` als Client: 4401 + `auth failed` +
   `assert(!stderr.includes(token))`, 4408 bei `BC_HELLO_TIMEOUT_MS=200`,
   Lebendigkeit 400 ms nach `welcome`, 1002 bei fremdem ersten Frame, 4409 für
   die erste von zwei Verbindungen, `status timeout` und `status failed` bei
   `BC_CALL_TIMEOUT_MS=200` bzw. `ok:false`.
   **Completed 2026-10-23**
5. **Extension** — `extension/manifest.json` (`name`, `version: "0.1.0"`,
   `background: {"scripts": ["protocol.js", "background.js"]}`,
   `permissions: ["tabs", "storage"]`, `options_ui`; die Manifest-Version hat
   Spec 02 auf MV2 mit `persistent: true` gestellt),
   `extension/options.html` + `extension/options.js` (kein Inline-Skript,
   MV3-CSP; `loadSettings`/`saveSettings` auf `browser.storage.local`, Token
   getrimmt gespeichert, sichtbare Texte deutsch), `extension/background.js`:
   `readSettings()`, `connect()` (`extensionVersion` aus
   `browser.runtime.getManifest().version`), `scheduleReconnect(n)`
   (`min(30000, 1000·2^(n−1))` + 0–250 ms Jitter, `n` nach `welcome` auf 0),
   `collectStatus()` (`browser.windows.getAll({populate: true})`, nur
   `type === "normal" && !incognito`, Tabs nur
   `cookieStoreId === "firefox-default"`, `url ?? ""`, `connectedAt` beim
   `welcome`), `onMessage()` (`welcome` → `status`-Antwort), Konsolenzeilen
   `bc: background page started` und einmalig die Meldung bei fehlendem
   Endpunkt oder Token.
   Proof: `node --test test/extension.test.js` → `# fail 0`. Lokale Gegenprobe
   für die Extension-Hälfte ohne Browser: `protocol.js` und `background.js` per
   `vm.runInNewContext` mit `browser`-Stub, Fake-`WebSocket` und Timer-Stub;
   geprüft werden „ohne Endpunkt/Token kein Verbindungsversuch", `hello` mit
   `protocol:1` und Token, `welcome` → `request status id 1`, fehlender
   Container-Tab, fehlendes privates Fenster, `url: ""` ohne URL und die
   Backoff-Folge 1000/2000/4000 ms und der abgelehnte Endpunkt (eine Zeile,
   kein Token, neuer Versuch). **Completed 2026-10-23**
6. **Bridge als Kindprozess mit Fake-Extension** —
   `test/fixtures/fake-extension.mjs` (globales `WebSocket`, Token aus
   `process.env.BC_TEST_TOKEN`, antwortet mit zwei Fenstern und drei Tabs) und
   `test/bridge.test.js`: freien Port über `net`-Bind auf 0 ermitteln und wieder
   schließen, `spawn(process.execPath, ["bridge/bridge.mjs"], {env})`, auf
   annehmenden TCP-Port warten, dann Fake-Extension starten; Fälle mit
   `BC_LOG=debug`, mit Token-Datei samt Zeilenumbruch, ohne Antwort, und
   `SIGTERM`.
   Proof: `node --test test/bridge.test.js` → `# fail 0`, mit stdout leer und
   stderr exakt `status windows=2 tabs=3` plus JSON, `code === 0` nach
   `SIGTERM`; im antwortlosen Fall Exit 0 und stderr nennt den Grund.
   **Completed 2026-10-23**
7. **Lokaler Gesamtlauf und Übergabe an den Betreiber** — kein Produktcode,
   bewusst. Der Umsetzer fährt `npm test`, `npm run check`, Kriterium 2 wörtlich
   und `git grep --untracked -nE '[0-9a-f]{32,}' -- .`, und schreibt die
   Handprüfungen aus `## Testing` als Übergabe in seinen Bericht
   (`## Verification`). Er führt sie **nicht** aus: sie brauchen das echte
   Profil, das Caddy-Snippet und die Token-Datei — Betreiberarbeit
   (`CONTRIBUTING.md`, „Der Browser gehört dem Betreiber"). Die MV3-Sonde ist eine
   Beobachtung des Betreibers, keine Stufe besteht oder fällt daran.
   Proof: `npm test; echo $?` → 0 und
   `node --test --test-reporter=tap test/*.test.js 2>&1 | grep -q '^# fail 0'`
   → Exit 0; `npm run check; echo $?` → 0;
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` → keine Ausgabe, Exit 1.
   **Completed 2026-10-23**

### What could go wrong

- **`const` im klassischen Skript.** `const BC_PROTOCOL = …` landet in `node:vm`
  nicht als Kontext-Property; der Test sieht dann `undefined`. Die Reparatur ist
  die Zuweisung an `globalThis`, nicht ein anderer Test.
- **Realms in `deepStrictEqual`.** Ein Objekt aus `runInNewContext` hat
  `Object.prototype` des anderen Realms; `deepStrictEqual` meldet „same
  structure but not reference-equal". Deshalb der JSON-Umweg im Proof von
  Stufe 1 — und Funktionen in den Konstanten wären damit ohnehin verboten.
- **Keine 32+-Hex-Literale im Repo.** Kriterium 3 greppt über alles: Testtoken
  zur Laufzeit erzeugen (`crypto.randomBytes(16).toString("hex")`) und dem
  Kindprozess über `BC_TEST_TOKEN` geben, nie in Fixture, Beispiel oder Log.
- **`npm run check` ist nur Syntax.** `node --check` lädt keine Importe; ein
  falscher Pfad in `bridge/hub.mjs` fällt erst in `npm test`.
- **Port-Wahl in `test/bridge.test.js`** ist ein Wettlauf (Port frei, dann
  belegt). Retry-Schleife mit Zeitlimit; nicht auf 8110 festnageln, das
  kollidiert mit einer laufenden Bridge.
- **`WebSocket`-Client kann nicht alles.** Node maskiert immer und fragmentiert
  nicht — 1002-, 1003- und 1009-Fälle brauchen rohe `net`-Sockets (Stufe 2).
- **stdout ist reserviert.** Eine vergessene `console.log` beim Start bricht die
  stdout-ist-leer-Assertion in Stufe 6 und im nächsten Inkrement das JSON-RPC.
- **Timer-Hygiene.** Der Hello-Timer muss nach `welcome` gelöscht werden, sonst
  schließt ein später 4408 eine funktionierende Verbindung.
- **4409 nicht selbst schließen.** Nur die gemerkte vorherige Verbindung
  schließen, nie „die neueste gewinnt" prüfen — sonst trifft es die neue.
- **MV3-CSP.** `options.html` ohne Inline-Skript, sonst lädt die Extension nicht
  (Kriterium 5 wäre ein Manifest-Fehler, kein TLS-Problem).
- **Kriterien 4–8 sind nicht lokal entscheidbar.** Sie setzen Caddy-Snippet,
  Token-Datei und geladene Extension voraus. Ein Fehlschlag ist zuerst ein
  Verdacht auf die Naht davor: `401` = Basic-Auth, `502` = Bridge tot,
  Handshake-Fehler ohne `hello` = TLS — nicht das Token.

### Ordering and dependencies

Stufen 1 → 7 sind strikt in dieser Reihenfolge baubar. Stufe 2 braucht aus 1
`MAX_MESSAGE_BYTES` und die `CLOSE`-Codes, Stufe 3 braucht 1 **und** 2 (`bridge.mjs` verdrahtet
`upgrade` → `upgradeSocket`), Stufe 4 braucht 2 und 3, Stufe 6 braucht 4 und 5.
Stufe 5 hängt nur an Stufe 1 und darf parallel zu 2–4 in einem separaten
Worktree laufen (`CONTRIBUTING.md`, „Arbeitsbaum": ein Schreiber pro Baum).

Betreiber-Voraussetzungen vor Stufe 7, keine Code-Stufen: der WS-Pfad außerhalb
der Basic-Auth (Snippet aus `## Configuration`, Ergebnis per Kriterium 4
geprüft), `~/.config/browser-control/token` (`openssl rand -hex 32`,
`chmod 600`), Endpunkt und Token in der Optionsseite, Extension über
`about:debugging` geladen.

Nicht Stufenarbeit: `status: active` und die Prosa der Spec
(`docs/README.md`, „Änderungen an bestehenden Specs") sowie der Eintrag der
Abnahmebefehle in `CONTRIBUTING.md ## Abnahme` — der kommt in Schritt 7, also vor dem
ersten Commit, wörtlich `npm test` und `npm run check` aus Kriterium 1. Der
Umsetzer fasst beides nicht an.

### What the next increment inherits

- **MCP-Schicht** über den Hub (`## Non-goals`): umgesetzt in Spec 03
  (`docs/03-mcp-browser-status.md`) — stdio-JSON-RPC auf stdout,
  `mcp.json`, erstes Tool. Das Wire-Protokoll und `protocol.mjs` bleiben
  unverändert; die MCP-Schicht nimmt `Hub.requestStatus()` statt `onStatus`
  (das bleibt unbenutzt), und weil stdout hier noch leer war, musste die
  Statuszeile beim Umzug nicht verschoben werden.
- **Tab-Steuerung** (`navigate`, `click`, `focus`, Screenshot, Agenten-Tab):
  wächst in `METHODS`, `extension/background.js:onMessage` und einer Erweiterung
  von `collectStatus`. Nicht hier.
- **MV3-Lebenszyklus-Reparatur**: entschieden und umgesetzt — MV2 mit
  `persistent: true` in Spec 02. `browser.alarms` wird nicht eingebaut. Eine
  Rückkehr zu MV3 braucht einen Tab, der den Socket hält (eigene Spec, nicht
  entschieden).
- **Signierung/XPI, Heartbeat, unaufgeforderte Ereignisse Extension → Bridge,
  mehrere Tokens/Scopes, Rotation**: bleiben Nicht-Ziel.
- Die Caddy-Konfiguration auf dem Server bleibt Betreibereigentum; das Snippet
  steht in der Spec, nicht in einem Skript.

## Risiken

- **MV3-Eventpage in Firefox — gemessen, nicht mehr offen** (2026-10-23). Das
  Background-Skript war keine dauerhaft laufende Seite
  (`"background": {"scripts": ["protocol.js", "background.js"]}`); Firefox wertet
  eine offene WebSocket-Verbindung **nicht** als Aktivität und entlädt die Seite
  nach 30 s. Gegenmittel und Entscheidung liegen in Spec 02: MV2 mit
  `persistent: true`, nicht `browser.alarms`.
- **Basic-Auth vor dem WS-Pfad.** Der Site-Block bedient heute Basic-Auth; ein
  Browser-`WebSocket` kann keinen `Authorization`-Header setzen. Greift die Auth
  auf `/browser-control/ws`, antwortet Caddy mit 401, die Extension sieht einen
  fehlgeschlagenen Connect ohne Close-Code, und in Bridge-stderr steht nichts.
  Deshalb Kriterium 4 als eigener Schritt vor jedem Firefox-Test: `401` ist
  Auth, nicht Code.
- **TLS auf dem Weg dorthin.** Der Endpunkt ist `example.com`
  (belegt am 2026-10-23: `getent hosts` → `<server-ip>`; `curl https://…` →
  HTTP 401 mit `ssl_verify_result=0`, also ein Zertifikat, dem das System
  traut). Firefox prüft gegen seinen eigenen Speicher, nicht gegen den des
  Systems; scheitert der Handshake, äußert sich das als Close ohne `hello` —
  dann ist die Ursache TLS, nicht das Token.
- **Berechtigungen der Extension.** `permissions` sind `tabs` und `storage`,
  ohne `host_permissions` — der WebSocket-Client braucht keine. Sollte Firefox
  dennoch blocken, ist die Reparatur eine `connect-src`-Angabe in der CSP; sie
  gehört dann in diese Spec, nicht in einen stillen Manifest-Umbau. Achtung beim
  Schlüsselnamen: unter MV2 (Spec 02) heißt er `content_security_policy`,
  `content_security_policy.extension_pages` gilt nur für MV3.
- **Selbstgeschriebenes RFC 6455.** Nur der Teil, den dieser Use Case braucht:
  Textframes, Fragmente, Ping/Pong/Close, Maskierung, 1-MiB-Grenze. Keine
  Kompression, keine Binärdaten, keine Subprotokolle. Ein Fehler hier kostet eine
  Debug-Sitzung, keine Daten.
- **Temporäre Installation.** Eine über `about:debugging` geladene Extension ist
  nach einem Firefox-Neustart weg; der Betreiber lädt in diesem Inkrement jedes
  Mal von Hand nach. Signierung ist Nicht-Ziel.
- **Ein Token für alles.** Wer das Token hat, sieht die Tab-Liste. Für ein
  Ein-Personen-Setup bewusst akzeptiert; Scopes und Rotation kommen erst mit
  einem zweiten Nutzer.

## Touch boundary

- Kein Patch an Fremdcode: keine `node_modules`, kein Caddy-Binary, keine
  Dateien im Firefox-Profil. Das Caddy-Snippet wird geliefert und vom Betreiber
  eingetragen.
- Keine Tokens, Secrets oder Zugangsdaten im Repo — auch nicht in Tests,
  Fixtures oder Logs. Tests erzeugen ihr Token zur Laufzeit, der Handtest liest
  es aus der Umgebung bzw. aus der Token-Datei.
- `docs/PROJECT-STATE.md`, `docs/README.md` und `CONTRIBUTING.md` fasst der Umsetzer
  nicht an; die pflegt der Orchestrator bei der Abnahme.
- Kein Produktivcode für spätere Inkremente: kein MCP-Server, kein
  `mcp.json`-Eintrag, keine Tab-Steuerung, kein Agenten-Tab.

## Messlauf (Kriterium 8, 2026-10-23, live)

Der letzte offene Punkt dieser Spec, nachgeholt am Ende von Spec 18 — mit dem Dienst
als Gegenüber statt einer handgestarteten Bridge.

**Aufbau:** Ein eigener WebSocket-Client (Node, keine Harness-Hilfe) verbindet sich mit
`ws://127.0.0.1:8110/`, schickt ein `hello` mit einem **fremden** Token und protokolliert
den Close-Code. Der Dienst läuft dabei normal mit dem echten Token.

| Prüfung | Ergebnis |
|---|---|
| Close-Code bei falschem Token | **`4401`** (Reason leer) |
| Logzeile der Bridge | **`auth failed peer=127.0.0.1`** |
| Fremdes Token im Journal | **0 Treffer** |
| Das echte Token im Journal | **0 Treffer** |

Zusätzlich gemessen (dafür brauchte es einen Dienst-Neustart): mit einem **abweichend
konfigurierten** Token auf der Bridge-Seite meldet die echte Erweiterung sich an und
bekommt zweimal `auth failed` — sie versucht es erneut, statt aufzugeben, und das
Journal bleibt tokenfrei.

**Kriterium 8 ist damit erfüllt** — gegen den laufenden Dienst, nicht gegen eine
Testinstanz.

**Zwei Betriebslehren** aus dem Messlauf, festgehalten, weil sie Zeit gekostet haben:
Ein Prüfskript, das einen WebSocket öffnet, muss ihn schließen **und** `process.exit()`
rufen — sonst wartet die Shell, bis jemand abbricht (hier: 15 Minuten). Und wer auf der
Bridge-Seite das Token tauscht, muss danach Dienst **und** Erweiterung wieder in
Übereinstimmung bringen; die Erweiterung braucht dafür bis zu 30 s Backoff.

## Bekannte Lücken

Stand 2026-10-23:

- **Kriterien 4–7** sind in früheren Sitzungen gelaufen (Verbindungsaufbau, Status,
  Reconnect); die Belege stehen in den Specs 02 und 03, die auf dieser aufbauen.
  Kriterium 8 ist oben nachgetragen.
- **Die Optionsseite wirkt erst beim nächsten Verbindungsaufbau** (2026-10-23):
  kein `storage.onChanged`-Neuaufbau, weil die Spec keinen verlangt. Nach dem
  Speichern von Endpunkt oder Token muss die Extension neu geladen werden —
  Kriterium 5 sagt das jetzt. Fehlten beide Werte, plant `connect()` gar keinen
  Versuch; ohne Reload passiert dann nichts.
- **Debug-JSON trägt den Zeitstempel nur auf der ersten Zeile** (2026-10-23).
  Die Regel „alle Zeilen tragen einen ISO-Zeitstempel" gilt für die
  Ereigniszeilen; ein Präfix vor jeder JSON-Zeile würde den Block unparsbar
  machen.
- **Drei RFC-6455-Randfälle winkt der Decoder durch** (2026-10-23, je ohne
  Testfall): ein Close-Frame mit genau einem Byte Nutzlast wird zu `1005`
  statt zu einem Protokollfehler; verbotene Close-Codes (0–999, 1005, 1006,
  1015) werden zurückgespiegelt statt mit `1002` beantwortet; `Sec-WebSocket-Key`
  wird nicht auf 16-Byte-Base64 geprüft. Alle drei brauchen einen Peer, der
  absichtlich kaputte Frames schickt — hinter Caddy ist das keiner.
- **`BRIDGE_VERSION` in `bridge/hub.mjs` ist ein handgepflegter Spiegel** der
  `version` aus `package.json` (2026-10-23), ohne Test auf Gleichheit.
- **SIGTERM schickt keinen Close-Frame** (2026-10-23): `server.close()`s Callback
  feuert bei upgegradeten Sockets nicht, deshalb `closeAllConnections()` plus
  `process.exit(0)`. Der Peer sieht ein FIN (`1006`) statt `1001` — für die
  Extension dasselbe: sie baut mit Backoff neu auf.
- **MV3-Lebenszyklus gemessen und negativ** (2026-10-23, Firefox 152): die
  Eventpage wird nach **30 Sekunden** Leerlauf entladen, die Verbindung schließt
  mit `1001` (going away), und es folgt **kein** Wiederaufbau, weil mit der Seite
  auch der Backoff-Timer stirbt. Belegt aus dem Bridge-Log: `connected`
  16:00:30.471 → `disconnected reason=1001` 16:01:00.496 (30,0 s), danach
  4,5 Minuten ohne Verbindung bis zum manuellen Reload. **Behoben in Spec 02**
  (persistenter Background unter MV2, `persistent: true`), nicht mit
  `browser.alarms`.
- **Kriterium 8 (falsches Token) ist noch nicht gelaufen** (2026-10-23): der
  Betreiber hat den Test vertagt. Kriterien 4–7 sind gelaufen —
  4 (`101` über Caddy, auch von einem zweiten Rechner), 5 (`extension connected`
  sofort), 6 (`status windows=1 tabs=6` bei 7 offenen Tabs, Container-Tab fehlt),
  7 (Reconnect 0,6 s nach einem Bridge-Neustart).

## Open questions

Keine offenen. Beantwortet:

1. **DNS-Name und Zertifikat des WSS-Endpunkts** (Betreiber, 2026-10-23):
   `example.com` über den bestehenden Caddy mit Let's-Encrypt-
   Zertifikat. Nachgeprüft am 2026-10-23: `getent hosts` → `<server-ip>`,
   `curl -I https://example.com/` → HTTP 401 (Caddy mit Basic-Auth)
   und `ssl_verify_result=0`.
2. **Caddy-Konfiguration auf dem Server**: **nicht geprüft**, weil der SSH-Zugang
   an einem geänderten Hostkey scheitert (`known_hosts:5`, 2026-10-23). Das
   Snippet und die Basic-Auth-Frage sind deshalb Vorschläge mit Prüfbefehl
   (Kriterium 4), keine Behauptung über den Ist-Zustand.

## Review

| Runde | Datum | Verdict | Blocker |
|---|---|---|---|
| 1 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (5 Major) |
| 2 | 2026-10-23 | 🔧 Fix these and I'll sign off | ja (Snippet, Kriteriennummer) |
| 3 | 2026-10-23 | ✅ Ship it | nein (drei Nacharbeiten ohne Gate-Wirkung) |

## Log

Runde 1 — je Befund eine Zeile:

- **M1** (`git grep` sieht untracked Dateien nicht, Kriterium 3 und Stufe 7
  könnten nicht fehlschlagen) — **übernommen**: `git grep --untracked` in
  Kriterium 3 und Stufe 7, mit Begründung im Kriterium.
- **M2** (`deepStrictEqual` über zwei `vm`-Realms scheitert) — **übernommen**:
  JSON-Umweg im Proof von Stufe 1, zusätzlich als Falle notiert.
- **M3** (`~` wird von Node nicht expandiert) — **übernommen**:
  `tokenPath()` mit `os.homedir()`, dazu Trimmen des Dateiinhalts.
- **M4** (MV3-Sonde war Umsetzerpflicht) — **übernommen**: als
  Betreiber-Beobachtung formuliert, kein Kriterium hängt daran.
- **M5** (Snippet ignoriert Basic-Auth) — **übernommen**: WS-Pfad muss außerhalb
  der Basic-Auth liegen, neues Kriterium 4 prüft den Upgrade mit `curl` auf
  `101`, Risiko „Basic-Auth vor dem WS-Pfad" ergänzt.
- **m1** (`node --test` startet Fixtures) — **übernommen**:
  `node --test test/*.test.js`.
- **m2** (Token-Whitespace) — **übernommen**: `trim()` in `readToken` und
  `saveSettings`, Testfall mit Zeilenumbruch.
- **m3** (private Fenster bleiben als leere Fenster) — **übernommen**:
  `!incognito` in `collectStatus()`, Testfall, Spec-Text korrigiert.
- **m4** (`peer` hinter Caddy immer `127.0.0.1`) — **übernommen**: im Abschnitt
  „Was die Bridge ausgibt" benannt, kein `X-Forwarded-For`.
- **m5** (stdout ist der MCP-Kanal) — **übernommen**: alle Zeilen nach stderr,
  stdout bleibt leer und wird in Stufe 6 als leer geprüft.
- **m6** (1003 und Timer-Hygiene ohne Test) — **übernommen**: zwei Zeilen in
  `## Testing`, Fall in Stufe 4.
- **m7** (`ok:false` ohne Verhalten) — **übernommen**: `status failed`-Zeile,
  Testfall.
- **m8** (Snippet als geprüft dargestellt) — **übernommen**: als ungeprüfter
  Vorschlag markiert, Caddy-Zustand unter `## Open questions` Punkt 2.
- **m9** (Manifest ohne `name`/`version`) — **übernommen**: beide Felder,
  `extensionVersion` aus `runtime.getManifest().version`.
- **m10** (Stufe 3 braucht Stufe 2, `formatStatusLine` erst Stufe 4) —
  **übernommen**: Reihenfolge korrigiert, Querverweis in Stufe 3.
- **m11** (`BC_BIND`-Parsing) — **übernommen**: am letzten `:` trennen.
- **m12** (5 s / 6 s ohne Herleitung) — **übernommen**: 5 s =
  `BC_HELLO_TIMEOUT_MS`, Reconnect-Zeit auf 3 s (1 s Backoff + ≤250 ms Jitter +
  Handshake) korrigiert.
- **m13** (Node-Version, `## Additional dependencies`) — **übernommen**:
  `"engines": {"node": ">=22"}` in Stufe 1, eigener Abschnitt.
- **m14** („enthält" vs. „exakt") — **übernommen**: Testtabelle sagt jetzt
  exakt.
- **m15** (Zitate: Manifest-Liste, `curl`-Auslassung, „Ereignisse") —
  **übernommen**: echte Werte zitiert, Formulierung „unaufgeforderte
  Nachrichten".
- **Sprache** (kaputter Satz in Stufe 2, „belegt" vs. „nicht belegt",
  fehlendes Verb, „davor") — **übernommen**, alle vier Stellen.
- **Klarstellung 1** (wo der Abnahmebefehl landet) — **übernommen**: Schritt 7,
  vor dem ersten Commit, wörtlich die Kommandos aus Kriterium 1.
- **Klarstellung 2** (`00-project-overview.md` fehlt) — **nicht übernommen**:
  `docs/README.md` führt es als Ausnahme, nicht als Pflicht; die Landkarte trägt
  `docs/PROJECT-STATE.md`, und ein zweites Übersichtsdokument wäre eine zweite
  Wahrheit. Wird beim Commit in `PROJECT-STATE.md` nachgezogen.
- **Klarstellung 3** (Caddy-Access-Log-Pfad unbekannt) — **übernommen**: die
  Grep-Zeile gegen das Caddy-Log ist aus Kriterium 8 gestrichen; das Argument
  trägt der `hello`-Frame, geprüft wird nur Bridge-stderr.
- **Klarstellung 4** (lokaler `ws://`-Zwischenschritt) — **übernommen**: als
  empfohlener Handprüfungsschritt in `## Testing`.

Runde 2 — je Befund eine Zeile:

- **Snippet hebt die Site-Basic-Auth nicht auf** (in Caddys Direktivenreihenfolge
  läuft `basic_auth` vor `handle`; vom Reviewer mit `caddy adapt` belegt) —
  **übernommen**: zwei `handle`-Blöcke, WS-Zweig zuerst; Begründung im
  Abschnitt, Sicherheitsabschnitt nennt den Grund jetzt ebenfalls („ein
  einzelner `handle` genügt nicht").
- **Verweis `Kriterium 8` statt `Kriterium 4`** beim `curl`-Prüfbefehl —
  **übernommen**.
- **`npm test` „endet mit `# fail 0`"** (die Zeile steht vor der
  Dauer-Zusammenfassung) — **übernommen**: Exit-Code 0 **und** enthält
  `# fail 0`.
- **`Stufe 2 braucht aus 1 nur MAX_MESSAGE_BYTES`** — **übernommen**: die
  `CLOSE`-Codes gehören dazu.

Runde 3 — Verdict `✅ Ship it`, drei Nacharbeiten ohne Gate-Wirkung:

- **Kausalsatz im Snippet-Abschnitt** („zwei `handle` schließen sich aus")
  behauptete den Erfolg dem falschen Ding: den 401 verhindert erst, dass die
  `basic_auth` **in den zweiten `handle` wandert**; zwei `handle` unter einer
  Site-`basic_auth` bekommen weiterhin 401 (vom Reviewer auf Port 8111/8112
  gemessen) — **übernommen**, Satz umgeschrieben.
- **`# fail 0` erscheint nur in der umgeleiteten TAP-Ausgabe**, im Terminal
  schreibt der Reporter `ℹ fail 0` — **übernommen**: Kriterium 1 und die
  Stufen-Proofs nennen `--test-reporter=tap`.
- **Kriterium 4 ohne Exit-Code 0**: `curl` meldet nach einem echten 101
  `(52) Empty reply` — **übernommen**: Exit-Code ungleich 0 als normal
  benannt, `--max-time 10` empfohlen.
- **Log-Buchhaltung** sagte „verweist darauf statt es zu behaupten", während der
  Sicherheitsabschnitt es behauptete — **übernommen**: Log-Zeile an den
  tatsächlichen Text angepasst.

Code-Review Runde 1 (Schritt 6, 2026-10-23) — Verdict `🔧`, zwei Blocker:

- **S1** (`connect()` fing nur `readSettings()` ab, `openSocket()` stand
  außerhalb: ein ungültiger Endpunkt wirft in `new WebSocket(...)` synchron
  `SyntaxError`, es kommt kein `close`-Event, die Extension bleibt bis zum
  Neuladen still) — **übernommen**: `openSocket()` steht im selben
  `try`/`catch`, eine Zeile `bc: Endpunkt ungültig: <wert>` (ohne Token), danach
  `scheduleReconnect(...)` wie bei einem Close; Testfall mit Endpunkt
  `not a url` in `test/extension.test.js`, Gegenprobe ohne Absicherung
  → `# fail 1`.
- **S2** (Kriterium 5 war so nicht erfüllbar: die Optionsseite wirkt erst beim
  nächsten Verbindungsaufbau, und ohne gespeicherten Endpunkt plant `connect()`
  gar keinen Versuch) — **übernommen, Spec-Seite**: Kriterium 5 und der
  Handprüfungsschritt verlangen jetzt einen Reload; kein `storage.onChanged` im
  Code, weil die Spec keins anfordert.
- **Nits** — **teilweise übernommen**: Zeitstempel-Regel für das Debug-JSON, die
  drei RFC-6455-Randfälle, der `BRIDGE_VERSION`-Spiegel, das SIGTERM-Verhalten
  und die fehlende MV3-Messung stehen jetzt unter `## Bekannte Lücken` statt in
  einer stillen Änderung. Ein eigenes `hello timeout`-Log und ein
  Versions-Gleichheitstest bleiben offen — beide stehen in keiner Anforderung.

Code-Review Runde 2 (2026-10-23) — Verdict `✅ Ship it`: S1 und S2 belegt
behoben, `npm test` zweimal 42/42, keine Regression im Backoff- oder `hello`-Pfad.
Zwei Doku-Nacharbeiten vor dem Commit (doppelter Log-Block, das neue
Endpunkt-Verhalten gehörte in `## Wire-Protokoll`) — hier erledigt.

Lauf auf dem Server (2026-10-23) — zwei Befunde aus dem ersten echten Betrieb:

- **Bridge starb an jeder Anfrage ohne Upgrade-Header** (`rejectPlainRequest`
  hatte die Signatur `(res)`, `http.createServer` ruft `(req, res)`; Caddy
  schickt genau so eine Anfrage, wenn der Client h2 spricht). Der Fehler kam
  durch beide Review-Runden, weil kein Test eine Nicht-Upgrade-Anfrage an den
  Prozess schickte — **übernommen**: Signatur korrigiert (426 statt Absturz),
  Regressionstest in `test/bridge.test.js`.
- **Kriterium 4 war nicht entscheidbar**: ohne `--http1.1` verhandelt curl h2
  und bekommt `426` statt `101` — **übernommen**: `--http1.1` samt Begründung
  im Kriterium und in `INSTALL.md`.

Code-Review Runde 2 / Lauf auf dem Server (2026-10-23) — eine Anfrage ohne
`Upgrade`-Header tötete die Bridge (`http.createServer` ruft den Listener als
`(req, res)`, `rejectPlainRequest(res)` band den Request → `TypeError:
res.writeHead is not a function`; Caddy schickt genau so eine für HTTP/2) —
**behoben**: Signatur `(req, res)`, 426 mit `Connection: close`, Prozess läuft
weiter und beantwortet danach einen echten Upgrade mit `101`; Regressionstest
in `test/bridge.test.js`, Gegenprobe ohne Fix → `# fail 1`.
