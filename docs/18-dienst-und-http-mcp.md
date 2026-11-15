---
description: Die Bridge wird ein Dienst statt ein Kindprozess — sie hält den Extension-Socket und bietet MCP über streamable HTTP auf 127.0.0.1 mit Bearer-Token; jeder MCP-Client (beliebiger Harness) oder wahlweise stdio kann sie nutzen, Portkonflikt und verwaiste Bridges fallen weg.
status: active
---

# Ein Dienst statt eines Kindprozesses

Heute startet **jede** pi-Sitzung ihre eigene Bridge als Kindprozess, weil MCP über
deren stdio läuft (`mcp.json`: `command: node bridge/bridge.mjs`). Daraus zwei
Fehlerbilder, beide am 2026-10-23 gesehen:

| Fall | Was passiert |
|---|---|
| **Zweite Sitzung startet** | Ihre Bridge endet mit `EADDRINUSE` auf `127.0.0.1:8110`; die Sitzung hat **still** kein `browser-control` |
| **Neustart bei laufender alter Sitzung** | Die alte Bridge überlebt als Kind der alten Sitzung, hält den Port, die neue Sitzung steht ohne Werkzeuge da |

Beides ist kein Codefehler, sondern die in Spec 03 notierte Grenze „genau eine
pi-Sitzung hält die Bridge". Im Alltag ist sie nicht haltbar — und die stille
Variante ist die schlechteste Antwort.

## Ziel

Die Bridge läuft **einmal** als Dienst und bietet zwei Endpunkte:

| Endpunkt | Zweck |
|---|---|
| `ws://127.0.0.1:8110/browser-control/ws` | WebSocket für die Erweiterung (unverändert) |
| `http://127.0.0.1:8111/mcp` | **MCP über streamable HTTP**, Bearer-Token nötig |

- **pi spawnt nichts mehr.** `mcp.json` bekommt statt `command` einen `url`-Eintrag;
  alle Sitzungen verbinden sich als Clients. Ein Portkonflikt ist damit unmöglich,
  und ein pi-Neustart lässt den Dienst unberührt.
- **Der Dienst ist harness-neutral** (Anforderung des Betreibers, 2026-10-23). Er
  spricht **Standard-MCP** — `initialize` mit Protokollverhandlung, `tools/list`,
  `tools/call`, sonst nichts. **Kein Harness-Name im Protokoll, in den Werkzeugen,
  in den Beschreibungen oder in den Fehlermeldungen**; die bestehende Schicht erfüllt
  das schon (der einzige Treffer im Code ist ein Kommentar). Damit funktioniert er
  mit jedem Client, der streamable HTTP und einen `Authorization`-Header kann — und
  über **stdio** (`bridge.mjs` ohne `--http`) mit jedem, der einen Prozess startet.
  Beides bleibt vollwertig: HTTP für Dienste und mehrere Sitzungen, stdio für
  Clients, die nur spawnen können.
- **Der Token wird als Umgebungsvariable dokumentiert** (`BROWSER_CONTROL_TOKEN`),
  damit ein fremder Client ihn aus seiner eigenen Konfiguration beziehen kann —
  kein pfadgebundenes Wissen über `~/.config/browser-control/token` außerhalb von
  `INSTALL.md`.
- **Auth ist Pflicht, nicht optional.** Jede Anfrage an `/mcp` braucht
  `Authorization: Bearer <token>`; das Token ist dasselbe wie für die Erweiterung
  (`~/.config/browser-control/token`, 64 Hex, `chmod 600`). Fehlt oder passt es
  nicht: **401**, ohne Auskunft über den Grund. Grund: ein lokaler Port, der den
  Browser des Betreibers steuert, darf nicht für jeden lokalen Prozess offen sein.
- **Der Dienst sagt, wenn der Port besetzt ist.** Beim Start wird geprüft und, statt
  eines nackten `EADDRINUSE`, eine Zeile geschrieben, die den Besitzer nennt
  (PID und — soweit ermittelbar — Prozessname). Das ist der kleine Teil von
  Roadmap 19 und gehört hierher, weil der Dienst der neue Besitzer ist.
- **Nur Loopback.** Beide Endpunkte binden an `127.0.0.1`, nie an `0.0.0.0`.
- **Feste Ports, keine Suche** (Betreiber-Entscheidung, 2026-10-23): Der Dienst bindet
  **8110** (Erweiterung) und **8111** (MCP) aus der Konfiguration
  (`BC_BIND`, `BC_HTTP_PORT`) und **sucht nie** einen freien Port. Ist ein Port
  belegt, endet der Start mit `exit 1` und der Besitzerzeile — kein Probieren, kein
  Warten, keine stille Ausweichlösung. Ein Dienst, dessen Port sich bei jedem Start
  ändert, ist für jeden Client unbrauchbar, und ein Suchlauf verdeckt genau die
  Kollision, die man sehen will.
- **Auch die Tests suchen nicht.** Sie binden **reservierte Testports**
  (`18110`–`18119`, je Testdatei ein Paar aus einem gemeinsamen Modul) und laufen
  **seriell** (`--test-concurrency=1`): feste Ports können sich zwei Dateien nicht
  teilen, und ein belegter Testport muss sofort mit Klartext scheitern, nicht nach
  15 s Wiederholung.
- **stdio bleibt erhalten** (`bridge.mjs` ohne Argumente verhält sich wie heute):
  Tests und ein Rückfallweg brauchen ihn, und ein Wechsel des Transports soll die
  Werkzeugschicht nicht mitziehen.

## Non-goals

- **Kein Reverse-Proxy, kein TLS, kein Zugang von außen.** Der Server erreicht die
  Bridge weiterhin über Caddy — aber das ist die **Extension**-Seite (Port 8110) und
  bleibt, wie Spec 03 es beschreibt.
- **Keine Änderung an den Werkzeugen, ihren Schemata, Ergebnissen oder Fehlercodes.**
  Der Transport wechselt, der Inhalt nicht.
- **Keine Mehrbenutzer-Trennung**, keine Rollen, kein zweites Token.
- **Keine harness-spezifischen Adapter.** Kein Plugin-Format, keine Extension für
  ein bestimmtes Werkzeug, keine Sonderregel „wenn Client X, dann Y". Der Dienst
  kann nur MCP; was ein Harness daraus macht, ist dessen Sache.
- **Keine Änderung an der Erweiterung.**
- Keine neue Abhängigkeit: der HTTP-Server ist `node:http`, der MCP-Rahmen ist
  JSON-RPC über `POST`.

## Wire-Protokoll

Keine Änderung an den MCP-Nachrichten selbst (dieselben `initialize`,
`tools/list`, `tools/call`). Neu ist nur der **Transport**:

- **Standard-MCP, keine Erweiterungen**: `initialize` verhandelt die
  Protokollversion (`protocolVersion`), meldet `capabilities: {tools: {listChanged:
  false}}` und einen `serverInfo` mit dem **Dienstnamen** — nicht dem Namen eines
  Harness. `tools/list` liefert reine JSON-Schemas ohne herstellerspezifische
  Schlüssel.
- `POST /mcp` mit einem JSON-RPC-Objekt (kein Batch) ⇒ Antwort `200` mit
  `application/json` und einem JSON-RPC-Objekt. **Kein** SSE-Streaming: die
  Werkzeuge antworten einzeln und endlich, ein Strom wäre eine Zusage ohne Nutzen.
- `GET /mcp` ⇒ `405` (kein Server-initiierten Strom).
- Fehlendes/falsches Token ⇒ `401` mit `WWW-Authenticate: Bearer`.
- Unbekannter Pfad ⇒ `404`. Falsche Methode ⇒ `405`.
- Ein `initialize` ohne vorherige Sitzung ist erlaubt; es gibt **keine**
  Sitzungs-Ids (`Mcp-Session-Id` wird nicht ausgegeben und nicht verlangt) — der
  Dienst ist zustandslos gegenüber dem Client, der Zustand liegt in der Extension.

## Hub

Keine Änderung an den Logzeilen. Der Dienst loggt nach **stderr**, im Betrieb fängt
systemd das in journald — damit ist die Logrotation erledigt, ohne eigenen Code
(Roadmap 20, Teil „Logrotation").

## Extension

Keine Änderung.

## Bridge

- `bridge/http-transport.mjs` (neu): `startHttpTransport({port, token, toolSet})`
  mit `node:http`; prüft Token, parst einen JSON-RPC-Rahmen, ruft dieselbe
  Werkzeugschicht wie stdio und antwortet. Keine eigene Logik je Werkzeug.
- `bridge/bridge.mjs`: startet **immer** den Extension-Server; mit `--http` (oder
  `BC_HTTP_PORT` setzt ausschließlich den **Port**, nie den **Modus**. Ohne `--http`
  bleibt es beim stdio-Verhalten von heute — sonst wollte jede von pi gespawnte
  Bridge 8111 binden, bekäme `EADDRINUSE`, endete mit `exit 1`, und die Sitzung
  stünde still ohne Werkzeuge da: genau der Fehler, gegen den dieses Inkrement
  antritt.
- `bridge/config.mjs`: `httpPort` (Default `8111`), `tokenPath` (wie heute).
- **Portprüfung beim Start:** bindet der Extension-Server nicht, wird der Besitzer
  ermittelt (`lsof`-frei: `EADDRINUSE` plus ein `GET` auf den Port, das nach dem
  Extension-Handshake fragt; sonst die PID aus `/proc`-Suche) und eine Zeile
  geschrieben. Kein stiller Exit.

## Betrieb

- `deploy/browser-control.service` (User-Unit): `ExecStart=/usr/bin/env node
  %h/browser-control/bridge/bridge.mjs --http`, `Restart=on-failure`, `RestartSec=2`,
  **`RestartPreventExitStatus=2`** (ein fehlendes Token beendet den Dienst, statt
  ihn alle zwei Sekunden neu zu starten und das Journal zu füllen),
  `Environment=BC_HTTP_PORT=8111`, `StandardError=journal`,
  `WantedBy=default.target`.
- `INSTALL.md` beschreibt den Dienst **harness-neutral**: ein Beispiel mit `url` +
  `Authorization: Bearer ${BROWSER_CONTROL_TOKEN}` und eines mit `command` (stdio),
  dazu die Warnung, `/mcp` nie über einen Proxy zu veröffentlichen.
- `INSTALL.md` beschreibt **auch den Interpreterpfad**: User-Units bekommen einen
  minimalen `PATH`, eine nvm-Installation ist dort unsichtbar (`env: node: No such
  file`). Der absolute Pfad gehört in die Unit oder in `Environment=PATH=…` — er
  wird dokumentiert, nicht geraten.
- `INSTALL.md` beschreibt: Unit installieren (`systemctl --user enable --now`),
  `loginctl enable-linger` (damit der Dienst ohne offene Sitzung läuft), und der
  `mcp.json`-Eintrag wechselt von `command` auf
  `{"url": "http://127.0.0.1:8111/mcp", "headers": {"Authorization": "Bearer ${BROWSER_CONTROL_TOKEN}"}}`
  mit dem Token aus der Umgebung. Der alte `command`-Eintrag bleibt als
  dokumentierter Rückfallweg stehen.

## Exit-Codes des Dienstes

| Code | Bedeutung |
|---|---|
| `0` | beendet durch Signal (systemd-Neustart oder `stop`) |
| `1` | ein Port ließ sich nicht binden (die Zeile nennt den Besitzer) |
| `2` | Tokendatei fehlt oder ist zu kurz — **der bestehende Code** aus Spec 01 |

`2` ist der Grund für `RestartPreventExitStatus=2`: ein fehlendes Token heilt kein
Neustart. Beide Codes bekommen einen Fall in `test/bridge.test.js`
(`BC_TOKEN_FILE` auf einen nicht existierenden Pfad ⇒ `2`; vorbelegter Port ⇒ `1`).

## Testing

| Datei / Fall | Was er beweist |
|---|---|
| `test/http-transport.test.js` — `POST /mcp` mit `tools/list` und gültigem Token | `200`, `application/json`, neun Werkzeuge |
| dito — ohne Token / falsches Token | `401` **und** `WWW-Authenticate: Bearer`, keine Werkzeugdaten |
| dito — `GET /mcp` | `405` |
| dito — unbekannter Pfad | `404` |
| dito — `tools/call` auf `browser_status` | derselbe Rahmen wie über stdio (Vergleich gegen den stdio-Pfad) |
| dito — kaputtes JSON | JSON-RPC-Fehler `-32700` mit `200` (Transportfehler ≠ Protokollfehler) |
| dito — Riesenkörper über der Grenze | `413`, kein Speicherwachstum |
| dito — `initialize` | Antwort ohne `Mcp-Session-Id` |
| `test/bridge.test.js` — Start ohne `--http` | bindet **nur** 8110 (Zähler über gebundene Ports) |
| dito — Port belegt | Prozess endet mit Exit ≠ 0 **und** einer Zeile, die den Besitzer nennt |
| `deploy/browser-control.service` | Datei existiert, enthält `Restart=on-failure`, `RestartPreventExitStatus=2`, `--http`, `StandardError=journal`; kein `/home/`, kein Token, kein `0.0.0.0` (Textprüfung — sie behauptet nicht, dass systemd die Datei akzeptiert) |
| `test/http-mcp.test.js` — dieselbe Anfrage über stdio und über HTTP | beide Antworten gleich (Kriterium 2 als Vergleich) |
| `test/http-mcp.test.js` — **reiner HTTP-Client ohne Harness**: `initialize` → `tools/list` → `tools/call` | der Dienst ist ohne pi benutzbar; `serverInfo` trägt den Dienstnamen, `capabilities` nur `tools` |
| `test/ports.js` (neu) — die reservierte Testport-Tabelle | eine Quelle für alle Testdateien; `findFreePort` kommt in **keiner** Testdatei mehr vor (`grep` = 0) |
| belegter Testport | sofortiger Fehlschlag mit Klartext, **keine** Wiederholung |
| dito — Werkzeugtexte und `serverInfo` | enthalten keinen Harness-Namen (`pi`, `claude`, `cursor`, `copilot`) — Textprüfung über `tools/list` |

## Acceptance criteria

1. `npm test; echo $?` → `0`, `# fail 0` **und** `# cancelled 0`;
   `npm run check; echo $?` → `0`; `git grep --untracked -nE '[0-9a-f]{32,}' -- .`
   → keine Ausgabe, Exit 1. Die **373 bestehenden Fälle bleiben grün** — keiner
   gelöscht, keiner übersprungen; die Gesamtzahl wächst um die neuen Dateien
   (`port-owner`, `config`, `http-transport`, `http-mcp`, `deploy`).
2. Ein HTTP-Aufruf an `/mcp` mit gültigem Token liefert dieselben neun Werkzeuge wie
   der stdio-Pfad — verglichen, nicht behauptet.
2b. **Kein Portsuchlauf:** `grep -rn findFreePort test/` ist leer, die Testports
   stehen in einer Tabelle (`18110`–`18119`), und `npm test` läuft mit
   `--test-concurrency=1`. Ein belegter Testport scheitert in unter einer Sekunde mit
   einer Zeile, die den Port nennt.
3. Ohne Token und mit falschem Token: `401`, keine Werkzeuginhalte.
4. Beide Endpunkte binden nur an `127.0.0.1`: für `/mcp` über
   `server.address().address`, für den Extension-Socket über eine
   Verbindungsprobe auf eine nicht-interne IPv4 aus `os.networkInterfaces()`, die
   scheitern muss. Gibt es keine, wird der Fall als **`skipped` mit Klartext**
   geführt, nicht als grün.
5. Ein belegter Port führt zu einer Zeile, die den Besitzer nennt, und einem
   Exit ≠ 0 — **kein** stiller Start.
6. **Live-Beleg:** der Dienst läuft als User-Unit, **zwei** pi-Sitzungen verbinden
   sich gleichzeitig, beide sehen `browser-control`, und ein pi-Neustart lässt die
   Werkzeuge sofort wieder da sein (kein Portkonflikt). Der Betreiber bestätigt, dass
   `systemctl --user status` den Dienst als `active (running)` zeigt.
7. **Harness-Neutralität, live:** ein **zweiter, fremder MCP-Client** (nicht pi)
   verbindet sich über `http://127.0.0.1:8111/mcp` mit dem Token und ruft
   `browser_status` erfolgreich auf. Beleg ist die Antwort dieses Clients; die
   Anleitung dafür steht in `INSTALL.md` und nennt **zwei** Wege (HTTP mit
   `Authorization`-Header, stdio über `command`), damit ein Client, der nur spawnt,
   nicht ausgeschlossen ist.

**Ausnahme mit Datum** (2026-10-23, `CONTRIBUTING.md`, `## Abnahme`): Kriterium 6 ist nur
im Betreiber-Profil entscheidbar (systemd-Unit, zwei Sitzungen) und läuft nach dem
Commit. Kriterien 1–5 laufen vorher. Ist die **Kernannahme** widerlegt (der Dienst
lässt sich nicht als User-Unit betreiben, oder pi verbindet sich nicht über
`url`), geht das Inkrement zurück in diese Spec.

## Messlauf (2026-10-23, vollständig)

**Betrieb:** Unit installiert als User-Unit, `enable` gesetzt, lokale Drop-in-Datei
für den `PATH` (pis `node` liegt unter `~/.local/share/pi-node/current/bin`, User-Units
sehen ihn nicht). Zwei Fehlerbilder traten dabei **wie vorhergesagt** auf und wurden
beide vom Dienst selbst erklärt:

1. `env: node: No such file or directory` — der minimale `PATH` der User-Unit.
   Gelöst mit `Environment=PATH=%h/.local/share/pi-node/current/bin:…` in einer
   **lokalen** Drop-in-Datei; die Repo-Unit bleibt maschinenunabhängig.
2. `listener failed on 127.0.0.1:8110: EADDRINUSE` gefolgt von
   `port 127.0.0.1:8110 in use, owner pid=1125083 name=node` — der Portbesitzer-Code
   hat live funktioniert und die **alte pi-Sitzung** als Halter genannt.

**Der Beweis, um den es ging:** Nachdem die alte Sitzung beendet war, startete der
Dienst, band 8110 und 8111, und die **Erweiterung verband sich von selbst wieder**
(`connectedAt` acht Sekunden nach dem Dienststart — Spec 02s Reconnect gegen einen
neuen Besitzer, ohne Reload).

| Prüfung | Ergebnis |
|---|---|
| `systemctl --user is-active` | `active`, seit 17:44:08 **ununterbrochen** (über einen pi-Neustart hinweg) |
| Prozesse | **genau ein** `bridge.mjs`, Elternprozess systemd (PID 2345) — **kein** Kind von pi |
| Werkzeuge in pi | alle **neun**, über HTTP |
| `tools/list` per `curl` (kein Harness) | alle neun Werkzeuge |
| `tools/call browser_status` per `curl` | echtes Ergebnis (Fenster und Tabs) |
| `navigate` / `open_tab` / `read(tab)` / `close_tab` über MCP | funktionieren |
| **drei gleichzeitige** `curl`-Clients | alle drei beantwortet |

**Kriterium 6 ist damit belegt:** der Dienst läuft, überlebt einen pi-Neustart, pi
spawnt nichts mehr, und mehrere Clients teilen sich einen Dienst.
**Kriterium 7 ebenfalls:** ein reiner HTTP-Client ohne Harness ruft `browser_status`
erfolgreich auf.

## Vorab-Test (2026-10-23)

Ein Lauf auf **Testports** (18120/18121), ohne die 8110 des Betreibers anzufassen,
mit einem **rohen HTTP-Client** — kein Harness im Spiel:

```
listening on 127.0.0.1:18120 log=info
listening on 127.0.0.1:18121 for POST /mcp

initialize → {"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},
               "serverInfo":{"name":"browser-control","version":"0.1.0"}}
tools/list → browser_status, browser_navigate, browser_read, browser_click, browser_type,
              browser_focus, browser_inspect, browser_open_tab, browser_close_tab
ohne Token → 401
```

Damit ist belegt: der Dienst antwortet über HTTP, verhandelt die Protokollversion,
nennt seinen **eigenen** Namen (kein Harness), listet alle neun Werkzeuge — und ohne
Token kommt niemand hinein. Was **nicht** belegt ist: ob ein Harness (pi) sich über
`url` verbindet; das ist Kriterium 6.

## Bekannte Lücken

- **`BC_BIND=127.0.0.1:0` wird still zu `8110`.** `parsePort` verwirft die `0` und
  der Rückfall auf den Default greift — wer dort „ephemeren Port" erwartet, bekommt
  den Port des laufenden Dienstes. Gemessen am 2026-10-23 (der Umsetzer stolperte
  darüber). Kein Fehler dieses Inkrements, aber dieselbe Sorte stille Lüge, die
  Spec 13 abgeschafft hat: eine **ausdrücklich ungültige** Angabe sollte laut
  scheitern, nicht ersetzt werden.
- **Der Live-Beleg zu Kriterium 6 steht aus** (Unit läuft, `enable-linger`, zwei
  pi-Sitzungen, Neustart ohne Portkonflikt). Bis dahin ist die Kernannahme — pi
  verbindet sich über `url` — **unbestätigt**.
- **`/proc`-Portbesitz ist Linux-only**; anderswo sagt die Zeile „Besitzer nicht
  ermittelbar", und das ist die ehrliche Auskunft.
- **Zu großer HTTP-Körper ergibt `413`, zu große stdio-Zeile weiter `-32700`.**
  Absicht (Transport ≠ Protokoll), nicht vereinheitlicht.

## Dev plan

1. **Portbesitzer** — `bridge/port-owner.mjs` (neu): `findPortOwner({host, port})`
   liest `/proc/net/tcp` und `/proc/net/tcp6`, nimmt die Zeile im Zustand `0A` mit
   passendem lokalen Port, holt ihre Inode und sucht in `/proc/*/fd/*` nach
   `socket:[<inode>]`; Rückgabe `{pid, name}` mit `name` aus `/proc/<pid>/comm`.
   Jeder Fehlschlag ⇒ `null`, dann schreibt der Aufrufer „Besitzer nicht
   ermittelbar" und **rät nicht**. Kein Binary, keine Abhängigkeit, kein
   Probe-Request (der nennt *was* lauscht, nicht *wer*). Aufruf einmal beim Start,
   nie je Anfrage.
   `/proc` gibt es nur unter Linux — der Test wird bei
   `process.platform !== "linux"` als `skipped` geführt.
   Proof: `test/port-owner.test.js` — bindet `net.createServer()` auf
   `127.0.0.1:0` im Testprozess und erwartet `{pid: process.pid, name: "node"}`;
   ein geschlossener Port ergibt `null`.
2. **Die Naht in der MCP-Schicht** — `bridge/mcp.mjs` hat sie schon, privat:
   `messageForLine(text, context)` nimmt einen JSON-RPC-Text und gibt eine Antwort
   oder `null`; sie entscheidet `-32700` selbst. Stufe: in `handleMessageText`
   umbenennen und exportieren; `handleLine` bleibt der einzige Schreiber. Der
   Transport ruft **genau diesen** Namen (`handleMessageText`) — ein Name, eine
   Funktion, nicht zwei. Sonst
   ändert sich nichts — kein Werkzeug, kein Schema, kein Ergebnis, kein Fehlercode.
   Proof: `test/mcp.test.js` unverändert grün, `npm run check` → 0.
3. **Konfiguration für den zweiten Port** — `bridge/config.mjs`: `httpPort` aus
   `BC_HTTP_PORT`, Default `8111`, ungültiger Wert fällt auf den Default zurück wie
   jedes andere Feld. Neu `test/config.test.js` (Default, Override, Unsinn).
   Proof: `node --test test/config.test.js`.
4. **HTTP-Transport** — `bridge/http-transport.mjs` (neu):
   `startHttpTransport({port, token, toolSet, log, host = "127.0.0.1"})` gibt
   `{port, host, close()}` aus `server.address()` zurück; `port: 0` ist erlaubt,
   damit der Test die wirklich gebundene Adresse messen kann. Reihenfolge fest:
   unbekannter Pfad → `404`; alles außer `POST` auf `/mcp` → `405` mit `Allow: POST`;
   dann die Token-Prüfung, `401` + `WWW-Authenticate: Bearer` mit **leerem** Körper.
   Token: `verifyToken` aus `bridge/hub.mjs` (dort schon SHA-256 +
   `timingSafeEqual`, schon exportiert) — **einmal** beim Start gelesen, als String
   übergeben; Rotation ist ein Neustart. Körpergrenze `MAX_BODY_BYTES` (eigene Konstante in `bridge/http-transport.mjs`)
   (1 MiB, unabhängig von der Socket-Grenze): `Content-Length` über der Grenze ⇒ `413` vor dem ersten
   `data`-Ereignis; ein chunked-Körper wird beim Streamen gezählt, damit die Grenze
   feuert, ohne den Rest zu puffern; danach wird die Anfrage zerstört. `200` trägt
   `application/json` und das Objekt aus `toolSet.handleMessage(body)`; `null`
   (Notification) → `202` mit leerem Körper.
- **Ablehnungen schließen den Socket** (`Connection: close`, Anfrage zerstören):
  sonst hält ein lokaler Prozess die Verbindung mit einem getröpfelten
  chunked-Körper, der die Grenze nie erreicht. Zeitgrenzen bleiben bei den
  Node-Vorgaben; `maxConnections` wird nicht gesetzt (loopback-only).
   Proof: `test/http-transport.test.js` mit gestubbtem `toolSet` und Hub:
   `tools/list` 200/json; `401` bei fehlendem Token, falschem Token und `Basic`;
   `GET /mcp` → 405; `/x` → 404; `413` bei zu großem `Content-Length` **und** bei
   einem 2-MiB-chunked-Körper, der die `413` sieht, bevor er fertig ist; danach
   antwortet eine weitere Anfrage weiter mit `200`;
   `server.address().address === "127.0.0.1"`.
5. **Verdrahtung im Einstiegspunkt** — `bridge/bridge.mjs`: `--http` (oder gesetztes
   **nur `--http`** startet zusätzlich den Transport; `BC_HTTP_PORT` setzt nur den
   Port. Nur `--http` wird erkannt, anderes argv ignoriert. `startMcpServer` läuft
   unbedingt weiter — unter systemd ist stdin `/dev/null`, `stdinIsClientChannel()`
   bleibt `false`, und das EOF beendet den Dienst nicht (das ist der Grund, warum
   die Unit überhaupt lebt). Bind-Fehler auf einem der beiden Ports ⇒ zweite Zeile
   mit dem Besitzer aus Stufe 1 (`port 127.0.0.1:8111 in use, owner pid=… name=…`)
   und `exit 1`; kein halblebiger Dienst, der bereits gebundene Extension-Server
   wird geschlossen. `installShutdownHandlers` bekommt das Handle, damit SIGTERM
   beide schließt.
   Proof: `test/bridge.test.js` — ohne `--http` lauscht nichts auf dem
   übergebenen `BC_HTTP_PORT` (auch wenn die Variable gesetzt ist); ein vorbelegter
   Port ergibt `exit 1` **und** die Besitzerzeile mit der eigenen PID des Tests.
6. **Beide Wege verglichen** — `test/http-mcp.test.js` (neu, Kindprozess +
   `test/fixtures/fake-extension.mjs`): ein Bridge-Prozess mit `--http` und
   `stdin: "pipe"` bedient beide Transporte; dasselbe `tools/list` und dasselbe
   `tools/call` auf `browser_status` werden einmal über stdin und einmal über
   `POST /mcp` gestellt und die Antworten nach Normalisierung der `id` verglichen.
   Proof: `node --test test/http-mcp.test.js` — das **ist** Kriterium 2 als
   Vergleich statt Behauptung.
7. **Unit und ihre Textprüfung** — `deploy/browser-control.service` (neu):
   `Environment=BC_HTTP_PORT=8111`, `ExecStart=/usr/bin/env node
   %h/browser-control/bridge/bridge.mjs --http`, `Restart=on-failure`,
   `RestartSec=2`, `RestartPreventExitStatus=2`, `StandardError=journal`,
   `[Install] WantedBy=default.target`. `%h`, weil `INSTALL.md` nach
   `~/browser-control` klont; `/usr/bin/env node`, weil ein fest verdrahteter
   Interpreterpfad geraten wäre. `test/deploy.test.js` pinnt Existenz und diese
   Zeilen plus „kein `/home/`, kein Token, kein `0.0.0.0`" — eine Textprüfung, und
   der Testname sagt das. Sie gehört in `npm test`, weil sie den vergessenen
   `ExecStart` fängt; sie behauptet **nicht**, dass systemd die Datei akzeptiert.
   Dazu die vier Doku-Punkte als eigener Schritt derselben Stufe (Wortlaut liefert
   der Umsetzer im Bericht, geschrieben wird von der Orchester-Seite): der
   Interpreterpfad, `loginctl enable-linger`, der `url`-Eintrag für `mcp.json` und
   der Satz „`/mcp` nie über einen Proxy". Beweis: `grep -c enable-linger
   INSTALL.md`, `grep -c '127.0.0.1:8111' INSTALL.md`, und der bestehende
   `[0-9a-f]{32,}`-Grep belegt, dass **kein wörtliches Token** in der Doku steht.

### What could go wrong

- **pi ist der ungeprüfte Teil.** Ob pi einen `url`-Eintrag nimmt,
  `${BROWSER_CONTROL_TOKEN}` ersetzt und `application/json` ohne
  `text/event-stream` akzeptiert, ist im Repo nicht entscheidbar. Kriterium 6
  entscheidet es; scheitert es, greift die Ausnahme der Spec (zurück in die Spec,
  kein Workaround). Ein Eintrag mit wörtlichem Token bleibt als Messvariante bereit.
- **`node` unter systemd.** User-Units bekommen einen minimalen `PATH`; eine
  nvm-Installation ist unsichtbar und das Journal sagt `env: node: No such file`.
  Deshalb steht der Interpreterpfad in `INSTALL.md` als Handgriff, nicht als
  geratene Zeile in der Unit.
- **Neustartschleife bei fehlendem Token.** `Restart=on-failure` plus ein
  `exit 2` bei fehlender Tokendatei wäre eine 2-Sekunden-Schleife, die das Journal
  füllt — genau das Risiko, das die Spec nennt. `RestartPreventExitStatus=2` ist die
  Zeile dagegen und steht in Stufe 7.
- **Zwei Antworten für eine Bedingung.** Ein zu großer HTTP-Körper ergibt `413`,
  eine zu große stdio-Zeile weiter `-32700`. Absicht (Transport ≠ Protokoll), aber
  es muss aufgeschrieben sein, sonst „repariert" es jemand später.
- **Die laufende Bridge nicht anfassen.** Entwicklung bindet freie Ports über
  `BC_BIND`/`BC_HTTP_PORT`; die 8110 des Betreibers bleibt unberührt.
- **Kriterium 4 ist nur halb so messbar, wie es dasteht.** Für `/mcp` kommt die
  Adresse aus `server.address()`; für den Extension-Socket ist sie
  selbstberichtet. Messbare Alternative: im Test eine nicht-interne IPv4 aus
  `os.networkInterfaces()` nehmen und behaupten, dass ein Verbindungsversuch dort
  scheitert. Die Anforderung bleibt wie in der Spec; nur der Beleg ändert sich.

### Ordering and dependencies

1, 2, 3 und 7 haben keine Voraussetzung und laufen in beliebiger Reihenfolge.
4 braucht 2 (die Naht) und 3 (`httpPort`); 5 braucht 4; 6 braucht 5. Keine Stufe
wartet auf eine spätere, und keine fasst `extension/*`, `bridge/hub.mjs` (über den
Import von `verifyToken` hinaus), die Tokendatei oder ein `docs/`-Dokument an.

### What the next increment inherits

- **stdio bleibt ein vollwertiger Weg**: `bridge.mjs` ohne `--http` behält das
  Verhalten als pi-Kind samt Tests; der `command`-Rückfall in `INSTALL.md` ist kein
  toter Code.
- **Kein SSE, keine Sitzungs-Ids** — ein Client, der `text/event-stream` verlangt,
  ist ein eigenes Inkrement.
- **Ein Token für zwei Oberflächen** (Rotation heute = Dienst-Neustart; Roadmap 21
  und 22 ungebaut). Die Log-Hygiene aus Roadmap 18 bleibt unberührt: der Transport
  schreibt weder Körper noch Kopfzeile ins Log.
- **Roadmap 19s Lock-Datei ist nicht gebaut** — der Dienst ist der Besitzer, eine
  fremde Bridge bekommt weiterhin nur eine Meldung, keine Ausschließung.
- **Caddy und `wss://…/browser-control/ws` unverändert**; `/mcp` ist loopback-only
  und darf nie über einen Proxy gehen — ein Satz für `INSTALL.md`.

## Risiken

- **Ein Token für zwei Oberflächen.** Dasselbe Geheimnis schützt den
  Extension-Socket und `/mcp`. Wer es hat, steuert den Browser — das gilt heute
  schon für die Extension-Seite; neu ist nur der zweite Weg hinein.
- **Loopback ist keine Grenze gegen lokale Prozesse**, nur gegen das Netz. Deshalb
  der Token; ohne ihn wäre jeder Prozess deines Kontos ein Browser-Steuerprogramm.
- **Der Dienst läuft mit deinen Rechten.** `Restart=on-failure` heilt Abstürze, aber
  ein Dienst, der in einer Schleife scheitert, füllt das Journal — `RestartSec=2`
  und die Zeile beim Start sind die Bremse.
- **`enable-linger`** lässt den Dienst ohne Anmeldung laufen — gewollt für Reboots,
  aber es heißt auch: er läuft, wenn du nicht da bist.
- **Zwei Betriebsarten im selben Programm** (stdio und `--http`) sind eine
  Verzweigung, die getestet werden muss; ohne den Test „ohne `--http` bindet nur
  8110" driftet sie.
- **Kein SSE-Streaming** ist eine Einschränkung gegenüber dem vollen MCP-Standard.
  Heute braucht sie niemand; wenn ein Client sie verlangt, ist das ein eigenes
  Inkrement.

## Touch boundary

- Kein Fremdcode, keine neue Abhängigkeit (`node:http` ist dabei), kein Seitentext
  in Logs, Tests, Fixtures oder Doku.
- `extension/*` bleibt **unverändert**. Von `bridge/` werden **nur** `mcp.mjs`
  (die Naht exportieren) und `config.mjs` (`httpPort`) angefasst; alles andere ist
  verboten — auch `hub.mjs`, `websocket.mjs` und `protocol.mjs`.
- `docs/PROJECT-STATE.md`, `docs/README.md`, `docs/ROADMAP.md`, `INSTALL.md` pflegt
  der Orchestrator.

## Open questions

Keine. Der Betreiber hat am 2026-10-23 **Variante A** gewählt (Dienst mit
HTTP-MCP, Token nötig) gegen die Alternative „Dienst + stdio-Shim" (kein zweiter
Port, aber ein Weiterleiter je Sitzung).

## Review

**Runde 1 (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these.** Zehn Befunde, alle
übernommen — der erste war ein Regressionsfehler in der Spec selbst:

1. **`BC_HTTP_PORT` hätte den Transport mitgeschaltet** — stand die Variable im
   Profil, wollte jede von pi gespawnte Bridge 8111 binden und starb mit `exit 1`.
   Jetzt schaltet **nur `--http`**.
2. **„373 unverändert" war selbstwidersprüchlich** — jetzt: bestehende bleiben grün,
   keiner gelöscht, Gesamtzahl wächst.
3. **Exit-Codes halb definiert** — Tabelle `0`/`1`/`2` plus je ein Test; `2` stammt
   aus Spec 01 und war seit damals ungetestet.
4. **Ablehnungen ließen den Socket offen** — jetzt `Connection: close` und Zerstören.
5. **Zwei Namen für eine Funktion** — einer.
6. **Touch boundary weiter als die Reihenfolge** — jetzt nur `mcp.mjs` + `config.mjs`.
7. **Vier Doku-Punkte ohne Stufe und Beweis** — in Stufe 7 mit `grep`-Beweisen.
8. **Kriterium 4 auf Loopback-only nicht rotfähig** — jetzt `skipped` statt grün.
9. **`/proc` ist Linux-only** — Test plattformabhängig.
10. **„Bekannte Lücken: noch keine" war selbst eine Behauptung** — gefüllt.

## Log

Noch keine Befunde.

Befunde beim Schreiben des Dev-Plans (2026-10-23), vom Architekten — und zwei
Entscheidungen des Orchestrators:

- **Die Naht existiert schon**, sie ist nur privat: `messageForLine` in
  `bridge/mcp.mjs` nimmt einen JSON-RPC-Text und gibt eine Antwort. Sie wird
  exportiert, kein Werkzeug angefasst. **Übernommen.**
- **Portbesitzer ohne `lsof`:** `/proc/net/tcp` → Inode → `/proc/*/fd/*`. Kein
  Binary, keine Abhängigkeit, und bei jedem Fehlschlag „nicht ermittelbar" statt
  einer Vermutung. **Übernommen.**
- **`RestartPreventExitStatus=2`** war nicht in der Spec, verhindert aber eine
  Neustartschleife bei fehlendem Token. **Als Orchestrator entschieden: ja.**
- **Der Interpreterpfad unter systemd** (nvm ist in User-Units unsichtbar) wird in
  `INSTALL.md` dokumentiert, nicht in die Unit geraten. **Entschieden: ja.**
- **Kriterium 4 war halb unmessbar** — für den Extension-Socket gibt es keine
  `server.address()`-Quelle; jetzt über eine Verbindungsprobe auf eine
  nicht-interne IPv4. **Übernommen.**

## Nachtrag 2026-10-23: Harness-Neutralität als Anforderung

Der Betreiber hat nachgetragen, dass Dienst und Plugin **mit anderen Harnesses**
funktionieren und über MCP ansprechbar sein müssen. Das ändert den Zuschnitt nicht,
aber es macht eine Eigenschaft zur Pflicht, die vorher nur Nebenwirkung war:

- **Standard-MCP, keine Sonderregeln.** `initialize` mit Protokollverhandlung,
  `capabilities` nur `tools`, `serverInfo` mit dem Dienstnamen. Kein Harness-Name in
  Protokoll, Werkzeugen, Beschreibungen oder Fehlermeldungen.
- **Zwei Transporte bleiben vollwertig:** HTTP für Clients, die einen Dienst
  ansprechen; stdio für Clients, die einen Prozess starten.
- **Beweise:** ein reiner HTTP-Client ohne Harness (`initialize` → `tools/list` →
  `tools/call`) und eine Textprüfung, dass die Werkzeugtexte keinen Harness-Namen
  tragen — plus Kriterium 7 (ein fremder Client, live).
- **Der Token kommt aus der Umgebung** (`BROWSER_CONTROL_TOKEN`), nicht aus einem
  Pfad, den nur diese Maschinenkonvention kennt.

## Nachtrag 2026-10-23: feste Ports, keine Suche

Der Betreiber hat entschieden: **der Dienst bekommt seine Ports fest vorgegeben, er
sucht nicht.** Das präzisiert, was vorher nur für die Produktionsseite galt:

- **Produktion:** `8110` (Erweiterung) und `8111` (MCP), aus `BC_BIND`/`BC_HTTP_PORT`.
  Belegt ⇒ `exit 1` plus Besitzerzeile. Kein Probieren, kein Ausweichen.
- **Tests:** reservierte Ports `18110`–`18119` aus einem gemeinsamen Modul, je
  Testdatei ein Paar, und `--test-concurrency=1`. Die drei Kopien von
  `findFreePort` (in `bridge.test.js`, `http-mcp.test.js`, `mcp.test.js`) entfallen
  samt ihrer Wiederholungsschleifen.
- **Grund, in einem Satz:** ein Dienst mit wechselndem Port ist für Clients
  unbrauchbar, und ein Suchlauf verdeckt die Kollision, die man sehen will — genau
  die Kollision, die am 2026-10-23 zwei gleichzeitige Testläufe zum Hängen brachte.

**Review (2026-10-23, `grizzled-senior-dev`): 🔧 Fix these → ✅ Ship it.** Sechs
Befunde, alle geschlossen; der Reviewer hat die Gegenproben selbst wiederholt. Zwei
waren auf Kriteriumsebene: die **Portbindung des Extension-Sockets** war ungeprüft
(Kriterium 4 war halb unbelegt), und der **Bind-Fehler des HTTP-Ports** war toter Code
im Test — eine Regression hätte einen Dienst ergeben, der 8110 bedient und `/mcp` nie
beantwortet. Dazu: der Transport loggt den Status statt `error.message` (sonst könnte
ein Wurf Anfrage-Text ins Journal tragen), kaputtes JSON über HTTP ist `200` mit
`-32700`, der 405-Fall schickt keinen Token mehr, und der zu große
`Content-Length`-Fall fällt nach 5 s mit Namen statt die Suite aufzuhängen.
