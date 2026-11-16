---
description: Die Bridge als Rust-Binary — dasselbe Protokoll zu beiden Seiten, dieselbe MCP-Oberfläche und dieselben Logzeilen, gebaut für Linux und Windows; parallel aufgebaut und erst nach gemessener Parität löst sie den Node-Weg ab.
status: proposed
---

# Die Bridge in Rust

`bridge/` sind **4.157 Zeilen** JavaScript (ESM, ohne externe Pakete). Sie
funktionieren, aber sie verlangen Node ≥ 22 auf dem Zielrechner, einen
`PATH`, der Node in einer systemd-Unit findet, und unter Windows einen
Ersatz für systemd. Diese Spec ersetzt sie durch ein **einzelnes Binary** in
Rust — bei identischem Verhalten nach außen.

**Das ist ein Ersatz, kein Nebenprojekt.** Am Ende steht *eine*
Implementierung. Bis dahin laufen beide, damit die Parität messbar ist, und der
Node-Weg fällt erst in dem Commit, der die Parität belegt hat.

## Ziel

- **Dasselbe Protokoll zu beiden Seiten.** Die Extension spricht unverändert
  `ws://…:8110` mit `hello`/`welcome`/`request`/`response`, denselben
  Methodennamen, denselben Close-Codes (`4401`, `4408`, `4409`, `1002`, `1003`).
  Ein MCP-Client spricht unverändert `POST /mcp` mit Bearer-Token (und den
  stdio-Rückfall).
- **Dieselbe MCP-Oberfläche.** Dreizehn Werkzeuge, dieselben Schemata, dieselben
  deutschen Sätze aus `extensionFailureText` — zeichengenau, weil
  `test/mcp.test.js` sie pinnt.
- **Dieselben Einstellungen.** `BC_BIND`, `BC_HTTP_PORT`, `BC_TOKEN_FILE`,
  `BC_LOG`, `BC_CALL_TIMEOUT_MS`, `BC_HELLO_TIMEOUT_MS`, dasselbe CLI
  (`--http`), dieselbe Tokenprüfung (≥ 32 Hex-Zeichen, Datei getrimmt), Exit `2`
  bei fehlendem Token, Exit `1` bei belegtem Port mit Besitzerzeile.
- **Dieselben Logzeilen**, damit das Journal nach dem Wechsel vergleichbar
  bleibt (`listening on …`, `extension connected …`, `status windows=… tabs=…`,
  die Werkzeugzeilen aus `hub.mjs`).
- **Ein Binary.** Statisch gelinkt, ohne Runtime, gebaut für **Linux x86_64**
  und **Windows x86_64**. Die systemd-User-Unit bleibt in ihrer Form und zeigt
  nur auf das Binary; unter Windows kommt ein Dienst-Wrapper dazu (Roadmap 30/31
  will genau das, was es heute nicht gibt).
- **Parität wird gemessen, nicht behauptet.** Ein Prüflauf fährt beide
  Implementierungen gegen dieselbe geskriptete Extension und vergleicht die
  Antworten; erst wenn er grün ist, fällt `bridge/`.

## Non-goals

- **Kein Protokollwechsel.** Keine neuen Meldungstypen, keine neuen Felder,
  keine Änderung an `extension/protocol.js`.
- **Keine neuen Werkzeuge, keine neuen Fehlercodes.** Die 13 bleiben 13.
- **Keine Änderung an der Extension.** Sie bleibt JavaScript.
- **Kein macOS, kein arm64.** Linux und Windows x86_64; alles andere ist eine
  spätere Zeile.
- **Kein Parallelbetrieb auf Dauer.** Zwei Implementierungen sind eine
  Übergangsphase mit Enddatum, kein Zustand.
- **Keine neuen Funktionen.** Was heute fehlt, fehlt auch nach dem Port.

## Die Entscheidungen des Betreibers (2026-11-16)

| Frage | Entscheidung |
|---|---|
| Sprache | **Rust** — Ersatz, nicht Parallelbetrieb |
| Ablösung | **paralleler Aufbau**, Löschung von `bridge/` erst nach belegter Parität |
| Plattformen | **Linux x86_64 und Windows x86_64** |

## Das Inventar (aus dem Code gelesen, 2026-11-16)

| Datei | Zeilen | Was sie tut | Muss im Port |
|---|---|---|---|
| `bridge.mjs` | 291 | CLI (`--http`), Start, Verdrahtung, Signalende | ja |
| `config.mjs` | 136 | ENV lesen, Bind/Port parsen, Tokenpfad, Token prüfen | ja |
| `protocol.mjs` | 49 | Drahtkonstanten (Version, Typen, Methoden, Close-Codes) | ja |
| `websocket.mjs` | 432 | **RFC 6455 von Hand**: Handshake, Maskierung, Fragmentierung, Ping/Pong, Nachrichtengrenze, Close | ja |
| `hub.mjs` | 1.021 | eine Sitzung, Fristen, Anfrage-Ids, Statuszeilen-Formatierung, Log | ja |
| `mcp.mjs` | 1.820 | JSON-RPC, `tools/list`, 13 Werkzeuge, Schemata, deutsche Fehlersätze | ja |
| `http-transport.mjs` | 247 | `POST /mcp`, Bearer-Prüfung, Body-Grenze, Statuscodes | ja |
| `port-owner.mjs` | 161 | Portbesitzer (`/proc`, Rückfälle) | ja, **plattformspezifisch** |

**Oberflächen, die nicht verhandelbar sind:** die WS-Frames, die Close-Codes,
die Statuszeilen (`status windows=<n> tabs=<m>`), die Werkzeugantworten als
eingerücktes JSON, die Bildblöcke von `screenshot`, die deutschen Fehlersätze
und die Exit-Codes.

## Die Testlandkarte

Die 9.572 Zeilen Bridge-Tests sind die eigentliche Spezifikation des Verhaltens.
Sie bleiben vorerst, wo sie sind — sie prüfen den Node-Weg — und werden Modul
für Modul nach Rust übertragen:

| Testdatei | Zeilen | Prüft | Rust-Zielmodul |
|---|---|---|---|
| `websocket.test.js` | 466 | Framing, Maskierung, Close-Codes | `ws` |
| `hub.test.js` | 2.029 | Sitzung, Fristen, Statuszeilen, Log | `hub` |
| `mcp.test.js` | 4.692 | Werkzeuge, Schemata, deutsche Sätze | `mcp` |
| `http-mcp.test.js` | 573 | `POST /mcp`, Auth, Statuscodes | `http` |
| `http-transport.test.js` | 697 | Body-Grenzen, Header, Fehler | `http` |
| `protocol.test.js` | 233 | Konstanten gleich `extension/protocol.js` | `protocol` |
| `port-owner.test.js` | 60 | Besitzerzeile der Bridge | `platform` |
| `config.test.js` | 38 | ENV, Tokenpfad | `config` |
| `ports.test.js`, `bridge.test.js` | 784 | Portreservierung, Startverhalten | `main` |

**`extension.test.js` bleibt unberührt** — die Extension ist nicht Teil dieses
Inkrements.

## Die Parität

**Definition:** für dieselben Eingaben liefern beide Implementierungen
dieselben Bytes — mit einer benannten Ausnahme: Zeitstempel im Log.

Ein Prüflauf (`scripts/parity.sh`, Stufe 1 des Plans) startet je
Implementierung mit einem **geskripteten Ersatz für die Extension** (ein
WebSocket-Client, der die Antworten aus Fixtures liefert) und vergleicht:

1. `tools/list` — die vollständige Antwort, zeichengenau.
2. je Werkzeug ein `tools/call` mit Fixture-Ergebnis und eines mit
   Fehlerergebnis — die Antworten, inklusive der deutschen Sätze.
3. eine Anfrage ohne Extension (`ExtensionUnavailable`) und eine mit Frist
   (`ExtensionTimeout`).
4. ein `hello` mit falschem Token ⇒ Close `4401`; ohne `hello` ⇒ Close `4408`.
5. den Start mit belegtem Port ⇒ Exit `1` und die Besitzerzeile.
6. den Start ohne Token ⇒ Exit `2`.
7. die Logausgabe beider Läufe, ohne Zeitstempel verglichen.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/protocol.rs` | `protocol_constants_matchTheExtension` | Version, Typen, Methoden und Close-Codes sind dieselben wie in `extension/protocol.js` |
| `bridge-rs/tests/ws.rs` | `ws_handshakeAndMaskingFollowRfc6455` | unser Framing verhält sich wie das heutige |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsListIsByteIdentical` | dreizehn Werkzeuge, dieselben Schemata |
| `bridge-rs/tests/mcp.rs` | `mcp_failureTextsMatchTheNodeBridge` | die deutschen Sätze, zeichengenau |
| `bridge-rs/tests/http.rs` | `http_rejectsMissingBearerAndOversizedBody` | Auth und Grenzen wie heute |
| `bridge-rs/tests/config.rs` | `config_missingTokenExitsTwo` | Exit `2`, dieselbe Meldung |
| `scripts/parity.sh` | sieben Vergleiche (siehe `## Die Parität`) | **die Parität als Ganzes** |
| **live (Betreiber)** | die echte Extension verbindet sich mit dem Rust-Binary und `browser_status` antwortet | der Port ist kein Selbstgespräch |

## Acceptance criteria

1. **Die Rust-Bridge spricht dasselbe Protokoll.** Beweis:
   `cargo test --manifest-path bridge-rs/Cargo.toml` ⇒ 0, und
   `bash scripts/parity.sh` (Default `--impl node,rust`) ⇒ **sieben Vergleiche,
   alle „identisch"**, Exit 0. Dazu `bash scripts/parity.sh --self-test` ⇒
   „3/3 Gegenproben rot" — ohne diese Gegenprobe ist „identisch" nicht von
   „der Vergleich liest nichts" zu unterscheiden.
2. **Ein Binary, zwei Plattformen.** Beweis:
   `cargo build --release --manifest-path bridge-rs/Cargo.toml` ⇒ 0, und
   `find bridge-rs/target/x86_64-unknown-linux-musl/release -maxdepth 1 -type f
   -executable | wc -l` ⇒ **1** (nicht `ls` zählen: `cargo` legt `.d`-Dateien
   daneben); `cargo build --release --target x86_64-pc-windows-gnu` ⇒ 0 und
   `file` nennt `PE32+ executable (console) x86-64`. Die Größe ist ein
   **Berichtswert**, kein Kriterium.
3. **Dieselben Einstellungen und Exit-Codes.** Beweis: die Config-Fälle aus der
   Testlandkarte sind nach Rust übertragen und grün;
   `grep -ho 'BC_[A-Z_]*' bridge-rs/src/*.rs | sort -u` ⇒ genau sechs Zeilen
   (`BC_BIND`, `BC_CALL_TIMEOUT_MS`, `BC_HELLO_TIMEOUT_MS`, `BC_HTTP_PORT`,
   `BC_LOG`, `BC_TOKEN_FILE`) — nicht `grep -c` über eine Dateiliste, das je
   Datei eine Zahl druckt.
4. **Dieselben Logzeilen.** Beweis: der Paritätsvergleich 7 ist grün, und
   `grep -ho 'listening on\|extension connected\|status windows=' bridge-rs/src/*.rs
   | sort -u | wc -l` ⇒ **3**.
5. **Die deutschen Sätze sind nicht neu geschrieben.** Beweis: der
   Paritätsvergleich 2 ist grün — die Sätze stammen aus `mcp.mjs`, nicht aus
   einer Übersetzung. **Eine Ausnahme, benannt:** `BRIDGE_FAILED` setzt einen
   Bridge-Bug voraus und ist darum nicht auslösbar; er wird von einem
   Rust-Unit-Test gepinnt, nicht von der Parität.
6. **Die Ablösung ist eine Stufe, kein Zufall.** Beweis: `bridge/` existiert
   noch, `docs/18` und `docs/35` sind erst in der Stufe geändert, die den
   Wechsel vollzieht (`## Dev plan`, Stufe 4); `git log --oneline -- bridge/`
   zeigt in dieser Stufe **einen** Commit, der alles löscht.
7. **Die systemd-Unit bleibt gültig.** Beweis: `deploy/browser-control.service`
   nennt `ExecStart=%h/.local/bin/browser-control-bridge --http`; das Binary
   lauscht mit `BC_BIND`/`BC_HTTP_PORT` auf `18130`/`18131` (die festen
   `8110`/`8111` sind Konfigurationsaussage, kein Messwert — sie kollidieren mit
   dem laufenden Dienst des Betreibers); Paritätsvergleich 5 und 6 grün.
8. **Windows hat einen Startweg.** Beweis: ein Abschnitt in `INSTALL.md` nennt
   den Dienst-Wrapper und wie er das Binary startet; `docs/30` (falls dort
   offen) nennt ihn ebenfalls.
9. **Kein Node auf dem Zielrechner nötig.** Beweis:
   `file -b bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge`
   ⇒ „ELF 64-bit … statically linked" (der Pfad trägt das Ziel, weil
   `.cargo/config.toml` musl als Default setzt), und
   `ldd <binary>` ⇒ „not a dynamic executable", Exit 1.
10. **Kein Produktcode außerhalb der Grenze vor Stufe 4.** Beweis:
    `git status --porcelain` nennt in den Stufen 0–3 `bridge-rs/`,
    `scripts/parity*`, `docs/…` und **nichts** unter `bridge/` oder `extension/`;
    in Stufe 4a zusätzlich `deploy/`, `scripts/install.sh`, `test/deploy.test.js`,
    `test/install.test.js`; in Stufe 4b die Löschung. Was in welcher Stufe
    erlaubt ist, steht im `## Dev plan`.

## Dev plan

**Der Zuschnitt.** Ein neues Verzeichnis `bridge-rs/` (Binary
`browser-control-bridge`), ein Prüflauf `scripts/parity.sh` mit zwei kleinen
Node-Helfern, und in der letzten Stufe ein Commit, der `bridge/` und seine
Node-Tests löscht. Die 13 Werkzeuge, ihre Schemata und die deutschen Sätze
werden **kopiert**, nicht formuliert; die Drahtkonstanten bleiben datenartig und
werden weiter gegen `extension/protocol.js` gepinnt — nach dem Schnitt ist das
der einzige Wächter dieser Kopie.

```
bridge-rs/
  Cargo.toml  .gitignore (/target)  .cargo/config.toml  README.md
  src/main.rs        argv (`--http`), Verdrahtung, Signal, Exit-Codes
      config.rs      load_config, token_path, read_token
      protocol.rs    die Konstanten (VERSION/TYPES/METHODS/CLOSE)
      log.rs         log_line: `<ISO mit ms>Z <text>`
      ws/{mod,frame,handshake}.rs
      hub.rs         Hub, Session, format_*_line, debug_block_of, verify_token
      mcp/{mod,tools,texts,failure}.rs
      http.rs        POST /mcp (Routing, Bearer, Body-Grenze)
      stdio.rs       Zeilenleser, stdin_is_client_channel
      platform/{mod,linux,windows}.rs
  tests/{common/mod.rs,protocol.rs,config.rs,platform.rs,ports.rs,ws.rs,hub.rs,mcp.rs,http.rs,bridge.rs}
```

**Was jede Stufe zusätzlich tragen muss** (CONTRIBUTING, `## Acceptance`):
`npm test` ⇒ 0 mit `# fail 0`/`# cancelled 0`, `npm run check` ⇒ 0,
`git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe. Das wird unten
nicht wiederholt; die Stufenbeweise kommen dazu.

**Portordnung** (feste Ports, keine Suche — `docs/18`): Node behält
`18110`–`18114`, Parity bekommt `18140`/`18141`, die Rust-Tests `18130`–`18134`
(je Testbinärdatei ein eigener Satz), alles außerhalb `8110`/`8111`. Innerhalb
eines Rust-Testbinärs serialisiert ein `Mutex` in `tests/common/mod.rs`, weil
`cargo test` die Fälle eines Targets parallel fährt und Kriterium 1 kein
`--test-threads=1` nennt.

**Stufe 0 — Werkzeugkette und Gerüst** (Betreiber, dann Umsetzer)

Gemessen am 2026-11-16 auf bigdelli: `command -v cargo` ⇒ leer,
`command -v rustup` ⇒ leer, `command -v x86_64-w64-mingw32-gcc` ⇒ leer.
Vorhanden: `node v22.23.1`, `file`, `ldd`, `objdump`, `strip`.

Betreiber (Systemänderung, `sudo`, nicht Teil des Implementer-Auftrags):
`rustup` installieren, `rustup target add x86_64-unknown-linux-musl
x86_64-pc-windows-gnu`, Mingw-Cross-Linker (`gcc-mingw-w64-x86-64`).
Gelingt der Linker nicht, ist die dokumentierte Antwort „Windows wird unter
Windows gebaut" — und jede Windows-Proof-Zeile wandert auf diese Maschine.

Umsetzer: `bridge-rs/Cargo.toml` (ein `[[bin]]`), `bridge-rs/.gitignore` mit
`/target` (**nicht** die Wurzel-`.gitignore`), `bridge-rs/.cargo/config.toml`
mit `[build] target = "x86_64-unknown-linux-musl"`, `bridge-rs/README.md`
(Toolchain, Cross-Linker, „`cargo test` braucht Node ≥ 22 für den
Fixture-Peer"), `src/main.rs` ohne Verhalten.

Proof:
```
rustup target list --installed | grep -cE 'x86_64-(unknown-linux-musl|pc-windows-gnu)'   # ⇒ 2
cargo build --release --manifest-path bridge-rs/Cargo.toml; echo $?                       # ⇒ 0
find bridge-rs/target/x86_64-unknown-linux-musl/release -maxdepth 1 -type f -executable | wc -l   # ⇒ 1
file -b bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge         # ⇒ "… statically linked"
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu; echo $?  # ⇒ 0
```

**Stufe 1 — `scripts/parity.sh` gegen die Node-Bridge**

Dateien: `scripts/parity.sh`, `scripts/parity/driver.mjs` (startet eine
Implementierung, spricht JSON-RPC-Zeilen, liest genau eine Antwortzeile mit
Frist), `scripts/parity/hold-port.mjs` (bindet einen Port, wartet auf SIGTERM),
`scripts/parity/ws-probe.mjs` (`--silent`, `--token <t>`; gibt
`code=<n> reason=<text>` aus). Der Peer ist
**`test/fixtures/fake-extension.mjs`, unverändert** — ein zweiter Ersatz wäre
ein zweiter Maßstab.

Die sieben Vergleiche:

| Nr. | Fälle | Was verglichen wird |
|---|---|---|
| 1 | 2 | `initialize`, `tools/list` — die vollständige Antwort |
| 2 | 39 | je Werkzeug: Fixture-Erfolg, `error:<code>`, Argument-Verweigerung |
| 3 | 2 | ohne Extension (`ExtensionUnavailable`), Fixture schweigt (`ExtensionTimeout`, `BC_CALL_TIMEOUT_MS=300`) |
| 4 | 2 | falsches Token ⇒ `4401`, kein `hello` ⇒ `4408` |
| 5 | 1 | belegter Port ⇒ Exit `1` + Besitzerzeile, Port vom Harness gehalten |
| 6 | 1 | fehlende Tokendatei ⇒ Exit `2` + dieselbe Zeile |
| 7 | 3 | Logzeilenfolge ohne Zeitstempel: `BC_LOG=info`, `debug`, `debug --http` |

Jedes Paar läuft **nacheinander auf demselben Port, mit derselben Tokendatei und
demselben Fixture-Env**; Artefakte nach `mktemp -d` (nie in den Baum).
`--impl node,rust|node,node`, `--only 5,6`, `--keep`, `--self-test`.
`--self-test` fährt drei **Mutationsproben** und wird nur grün, wenn der
Vergleich „≠" meldet.

Proof:
```
bash -n scripts/parity.sh; echo $?                       # ⇒ 0
bash scripts/parity.sh --impl node,node                  # ⇒ "1..7 identisch", 0
bash scripts/parity.sh --self-test; echo $?              # ⇒ "Gegenproben rot: 3/3", 0
npm run check                                            # ⇒ 0
```
`node,node` grün beweist **Determinismus**, nicht Parität — deshalb ist
`--self-test` in dieser Stufe Pflicht.

**Stufe 2a — `protocol`, `config`, `log`, `platform/linux`, Startverhalten**

Dateien: `src/{protocol,config,log}.rs`, `src/platform/{mod,linux}.rs`,
`src/main.rs` (Token lesen ⇒ `2`; binden ⇒ `1` + Besitzerzeile;
`listening on … log=…`; SIGTERM/SIGINT ⇒ `received SIGTERM, shutting down` +
Exit `0`), `tests/{protocol,config,platform}.rs`, `tests/common/mod.rs`,
`tests/ports.rs`.

Mitzuportieren, weil es Verhalten ist: `parseBind` (letzter Doppelpunkt,
`[::1]`-Klammern, leerer Host ⇒ `127.0.0.1`, ungültiger Port ⇒ `8110`)
**einschließlich der stillen Lüge `:0` ⇒ `8110`** (`docs/18` — nicht
„reparieren"); `BC_LOG` nur `info|debug`; Token ≥ 32 Hex, getrimmt, `ENOENT` ⇒
`2`, jeder andere Lesefehler ⇒ `bridge failed: …` + `1`; `formatAddress` mit
Klammern für IPv6; `EADDRINUSE` als **String** in der Zeile.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test protocol --test config --test platform
# ⇒ protocol_constants_matchTheExtension, loadConfig_* (3), findPortOwner_* (2) ok
bash scripts/parity.sh --impl node,rust --only 5,6       # ⇒ 2/7 identisch
```

**Stufe 2b — `ws`: Handshake, Codec, Close**

Dateien: `src/ws/{mod,frame,handshake}.rs`, `tests/ws.rs`.

Entscheidung: **keine WebSocket-Bibliothek**, `bridge/websocket.mjs` wird von
Hand portiert. Gründe: die Close-Codes `4401/4408/4409` und `1002/1003/1009`
sind der Vertrag; die Grenze muss **vor** dem Puffern feuern; Bytes, die mit dem
Handshake ankommen (`head`), sind ein eigener Fall; und die reinen Codec-Fälle
übertragen sich nur dann 1:1. Zusätzliche Abhängigkeiten nur `sha1` und
`base64` (Accept-Key).

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test ws 2>&1 | grep -cE '^test (acceptKey|encodeFrame|frameDecoder|upgradeSocket|websocket)_[A-Za-z0-9]+ \.\.\. ok'   # ⇒ 13
```
Zwei der 13 sind neu geschrieben: der „angekündigt zu große Frame"-Fall wird zum
Socket-Fall `ws_onAnAnnouncedOversizedFrame_shouldCloseWith1009BeforeThePayloadArrives`
(nur Header senden, Close lesen).

**Stufe 2c — `hub`: Authentifizierung, Fristen, Anfrage-Ids, Logzeilen**

Dateien: `src/hub.rs`, `tests/hub.rs`.

Bauform: der Hub kennt keinen Socket, sondern einen Ausgangskanal
(`mpsc::Sender<Outbound>`) und ein `Arc<AtomicBool>` für „offen";
`close(code, reason)` geht als `Outbound::Close` durch denselben Kanal. Fristen
laufen über `tokio::time` mit dem Wert aus der Config — die Tests setzen
`BC_HELLO_TIMEOUT_MS`/`BC_CALL_TIMEOUT_MS` auf 100–300 ms statt eine Uhr zu
stubben.

Mitzuportieren: `BRIDGE_VERSION = "0.1.0"` im `welcome`,
`extension connected peer=<ip> protocol=<n>` (nur die IP, kein Port),
`extension disconnected reason=<code>[ <reason>]`, `${method} timeout peer=…`,
`${method} failed peer=… code=…`, `auth failed peer=…`,
`protocol error peer=…`, `status windows=<n> tabs=<m>`, die elf
`format*Line`-Formate, `DEBUG_WHITELIST` samt Reihenfolge und
`<unlisted field>`, `verifyToken` (konstante Zeit).

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test hub 2>&1 | grep -cE '^test (hub|formatStatusLine|debugBlockOf|verifyToken)_[A-Za-z0-9]+ \.\.\. ok'   # ⇒ 55
bash scripts/parity.sh --impl node,rust --only 4         # ⇒ 1/7
```

**Stufe 2d — `mcp`-Werkzeugschicht und stdio**

Dateien: `src/mcp/{mod,tools,texts,failure}.rs`, `src/stdio.rs`, `src/main.rs`,
`tests/mcp.rs` (Naht-Teil).

`tools.rs` schreibt die 13 Einträge als `serde_json::json!`-Literale **in der
Reihenfolge von `bridge/mcp.mjs`**; `texts.rs` kopiert `TOOL_TEXTS` wörtlich.
Zwingend: `serde_json` mit `preserve_order` — ohne das sortiert `serde_json`
Schlüssel alphabetisch und Vergleich 1/2 wird rot. `SERVER_INFO` bleibt
`{"name":"browser-control","version":"0.1.0"}` (nicht aus `Cargo.toml`).

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test mcp 2>&1 | grep -cE '^test (mcp|failureTextFor)_[A-Za-z0-9]+ \.\.\. ok'   # ⇒ ≥ 50 (Zahl einfrieren)
bash scripts/parity.sh --impl node,rust --only 1,2,3,7   # ⇒ 4/7
```

**Stufe 2e — `http`: `POST /mcp`**

Dateien: `src/http.rs`, `tests/http.rs` (14 Transportfälle + die zwei
„gleiche Antwort über stdio und HTTP"-Fälle).

Mitzuportieren: `MCP_PATH="/mcp"`, Reihenfolge Pfad → Methode → Token → Körper;
`404`; `405` + `Allow: POST`; `401` + `WWW-Authenticate: Bearer` mit leerem
Körper; `413` bei zu großem `Content-Length` **vor** dem ersten Body-Byte und
beim chunked-Körper während des Streamens; `200` + `application/json`; `null` ⇒
`202`; jede Ablehnung mit `Connection: close` und `Content-Length: 0`;
`MAX_BODY_BYTES = 1048576` (nicht die 5 MiB der Socket-Grenze); Log
`http auth failed`, `http request failed, answering 500` ohne `error.message`.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test http 2>&1 | grep -cE '^test http_[A-Za-z0-9]+ \.\.\. ok'   # ⇒ ≥ 16
bash scripts/parity.sh --impl node,rust --only 7         # ⇒ 1/7
```

**Stufe 2f — Prozesstests, stdin-Lebenszyklus, voller Paritätslauf**

Dateien: `tests/bridge.rs` (die zehn Fälle aus `test/bridge.test.js`),
`tests/mcp.rs` (Prozessfälle), `src/{main,stdio}.rs`.

Der Teil, der still kaputtgeht: **stdin-EOF beendet nur, wenn stdin eine Pipe
oder ein Socketpair ist.** Unter systemd ist stdin `/dev/null`; eine
Rust-Bridge, die EOF immer als Shutdown liest, beendet sich sofort und
`Restart=on-failure` dreht eine Schleife. Linux:
`std::fs::metadata("/proc/self/fd/0")` + `FileTypeExt::is_fifo()/is_socket()`.
Beide Fälle sind Pflicht:
`mcp_whenStdinEnds_shouldExitZeroAfterASingleShutdownLine` und
`mcp_withAnIgnoredStdin_shouldKeepRunningAndListeningAfterTheEof`.

Weitere Prozessfälle: `--http`-los bindet nur 8110 (mit gesetztem
`BC_HTTP_PORT`), 426 auf einen einfachen `GET`, Loopback-only (nicht-interne
IPv4 über einen verbindungslosen `UdpSocket::connect`; ohne Route `skipped` mit
Klartext), Exit `0` auf SIGTERM, Fehler **nach** dem Binden ⇒ Exit `1`.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml 2>&1 | tail -1   # ⇒ "test result: ok. N passed; 0 failed"
bash scripts/parity.sh; echo $?                                  # ⇒ "1..7 identisch", 0
```

**Stufe 3 — Windows**

Dateien: `src/platform/windows.rs` (`GetExtendedTcpTable` → PID →
`QueryFullProcessImageNameW`, Name ohne `.exe` wie `/proc/<pid>/comm`),
`src/stdio.rs` (`GetFileType` → `FILE_TYPE_PIPE`), `src/main.rs`
(`tokio::signal::ctrl_c`), `Cargo.toml`
(`[target.'cfg(windows)'.dependencies] windows-sys`), `bridge-rs/README.md`.

Startweg (Entscheidung des Plans): **Task Scheduler, Trigger `AtLogOn`,
`LogonType InteractiveToken`, ohne Admin** — das Gegenstück zur systemd-User-Unit
mit dem Tokenpfad des Betreibers; kein NSSM (fremdes Binary), kein
`windows-service` (Session 0, anderes `%USERPROFILE%`, eigener Tokenpfad). Die
Aufgabendatei ist `deploy/windows/browser-control-bridge.xml`, geprüft in Stufe
4a als Text (wie `test/deploy.test.js` es mit der Unit tut).

Proof:
```
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu; echo $?  # ⇒ 0
cargo clippy --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu -- -D warnings; echo $?  # ⇒ 0
file -b bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe   # ⇒ "PE32+ executable (console) x86-64"
```
**Was diese Stufe nicht beweist:** dass die Windows-Zweige *laufen*. `cargo test
--target x86_64-pc-windows-gnu` startet nichts auf Linux. Der Lauf gehört zum
Betreiber (Kriterium 8) und steht danach in `## Bekannte Lücken`.

**Stufe 4a — Unit, Installer und Doku zeigen auf das Binary**

Dateien: `deploy/browser-control.service` (`ExecStart=%h/.local/bin/browser-control-bridge
--http`, `RestartPreventExitStatus=2` bleibt),
`deploy/windows/browser-control-bridge.xml` (neu), `scripts/install.sh`
(`check_binary` statt `check_node_version`; `install_binary` kopiert nach
`$HOME/.local/bin` mit `0755`; `guard_path` bekommt `$HOME/.local/bin` als
dritten erlaubten Ort; `--fix-path` entfällt, `--uninstall` räumt eine alte
Drop-in-Datei weiter ab), `test/deploy.test.js`, `test/install.test.js`.

Warum vor 4b und getrennt: `bridge/` lebt noch, `npm test` bleibt mit beiden
Bäumen grün, und der Unit-/Installer-Wechsel ist für sich reviewbar. `docs/18`
und `docs/35` bleiben in dieser Stufe **unangetastet** — Kriterium 6 verlangt
das ausdrücklich.

Proof:
```
node --test --test-reporter=tap test/deploy.test.js test/install.test.js 2>&1 | grep -cE '^ok [0-9]+ - (deploy|install)_'   # ⇒ ≥ 26
grep -c 'ExecStart=%h/.local/bin/browser-control-bridge --http' deploy/browser-control.service   # ⇒ 1
grep -c 'bridge/bridge.mjs' scripts/install.sh                                                   # ⇒ 0
bash -n scripts/install.sh; echo $?                                                              # ⇒ 0
```

**Stufe 4b — der Schnitt**

Löschen: `bridge/` (8 Dateien),
`test/{bridge,mcp,hub,websocket,http-transport,http-mcp,protocol,config,port-owner,ports}.test.js`,
`test/ports.js`. Bleiben: `test/fixtures/fake-extension.mjs` (jetzt Peer der
Rust-Tests und von `parity.sh`), `test/{extension,deploy,install,check,package,manifest}.test.js`.
Ändern: `test/extension.test.js` (der eine `loadConfig`-Import wird zu den
Literalen `127.0.0.1`/`8110` plus Drift-Satz), `docs/18` und `docs/35`
(Amendments: `ExecStart`, Binärpfad, `~/.local/bin`, `--fix-path` entfällt,
`cargo build --release` als Vorbedingung), `docs/30` und `INSTALL.md`
(Task-Scheduler-Weg; `## 1. Prerequisites` verliert „Node ≥ 22 für den Betrieb"
und behält es für Tests), `CONTRIBUTING.md` (`## Acceptance` bekommt
`cargo test`, `## Prerequisites` die Toolchain).

Proof:
```
git log --oneline -- bridge/ | wc -l                       # ⇒ genau der eine Commit dieser Stufe
npm test 2>&1 | grep -E '^# (tests|fail|cancelled|skipped)'  # ⇒ fail/cancelled = 0
cargo test --manifest-path bridge-rs/Cargo.toml 2>&1 | tail -1
bash scripts/parity.sh; echo $?                            # ⇒ 7/7, 0
grep -rn 'bridge/' test/ scripts/ deploy/ package.json     # ⇒ nur test/fixtures-Kopfkommentare
```

### The parity check as built

**Zeichengenaue Gleichheit ist erreichbar — mit vier benannten Bedingungen.**
Am Code geprüft, nicht vermutet:

1. **Zeitstempel** sind der einzige Präfix (`logLine`); gestrichen wird
   `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ` — dasselbe Muster, das
   `test/bridge.test.js` schon benutzt. Rust muss `toISOString()` exakt
   nachbilden (immer drei Millisekunden, `Z`), sonst greift der Strip nicht.
2. **Portnummern** sind kein Problem, solange beide Läufe denselben Port haben —
   also nacheinander, dieselbe Tokendatei, dasselbe Fixture-Env.
3. **Der Peer trägt keinen Port** (`remoteAddress`, nicht `remotePort`); sonst
   wäre Vergleich 7 ohne Normalisierung unmöglich.
4. **Die Besitzerzeile nennt den Halter, nicht die Bridge** — für Vergleich 5
   hält der Harness den Port.

Was trotzdem bricht, mit Gegenmittel: **Schlüsselreihenfolge** (`preserve_order`
plus Reihenfolge beim Parsen); **Zahlen** (`12.0` schreibt Node als `12`,
`serde_json` als `12.0` ⇒ Zahlenformatierer wie Node plus Testfall);
**Escaping** (lone surrogates nimmt Node, `serde_json` nicht ⇒
`## Bekannte Lücken`, kein Blocker).

**Der Maßstab muss falsifizierbar sein.** `--impl node,node` grün heißt nur:
deterministisch. Deshalb ist `--self-test` Teil von Stufe 1.

### The test map, corrected

**1:1 übertragbar:** die 15 reinen Fälle aus `test/hub.test.js`
(`formatStatusLine_*`, `debugBlockOf_*`, `verifyToken_*`), die 13 aus
`test/websocket.test.js`, die 3 aus `test/config.test.js`, die 2 aus
`test/port-owner.test.js`, die ~40 Naht-Fälle aus `test/mcp.test.js`, die 14 aus
`test/http-transport.test.js`, die 2 Invarianten aus `test/ports.test.js`.

**Umgeschrieben, weil sie Node-Interna prüfen:** `test/protocol.test.js` (17) —
`vm.runInNewContext` und `Object.isFrozen` haben keine Entsprechung; Ersatz sind
3 Fälle mit einem Textauszug aus `extension/protocol.js`, der bei unbekannter
Form laut scheitert. Die 15 Socket-Fälle aus `test/hub.test.js` (kein Pollen mehr
nötig, der Test treibt `hub.on_message` direkt). Die ~70 Prozessfälle aus
`test/mcp.test.js` und die 10 aus `test/bridge.test.js`
(`spawn(process.execPath, …)` ⇒ `Command::new(binary)`; die Fixture bleibt
dieselbe Datei). `test/ports.test.js` wird `tests/ports.rs` mit eigener
Port-Tabelle. `test/deploy.test.js` und `test/install.test.js` werden **nicht**
portiert, sondern in Stufe 4a in der Node-Suite nachgezogen.

**Fällt ohne Ersatz weg:** die Node-spezifischen Fälle aus `test/mcp.test.js`
(EPIPE auf stdout, `MaxListenersExceededWarning`) — sie prüfen Node-Verhalten,
nicht Bridge-Verhalten.

### What could go wrong

- **Keine Werkzeugkette auf bigdelli** (`cargo`, `rustup`, Mingw fehlen alle).
  Stufe 0 ist eine Betreiber-Aufgabe mit `sudo`.
- **`EADDRINUSE` ist in Rust kein String** — `kind()`/`raw_os_error()` (98 bzw.
  10048); die Logzeile braucht das Wort, sonst fällt Vergleich 5 leise.
- **`preserve_order` und Zahlenformate** sind die zwei Stellen, an denen
  „zeichengenau" bricht.
- **stdin-EOF unter systemd** — ohne die `fstat`/`GetFileType`-Prüfung startet
  der Dienst im Sekundentakt neu.
- **`hyper` und die Bytes nach dem Handshake** — ob `hyper::upgrade::on` die
  bereits gelesenen Restbytes liefert, entscheidet ein Test; sonst bekommt der
  Extension-Listener einen handgeschriebenen Kopfleser.
- **Die Fixture ist geteilt** — sie wird in Stufe 1 nicht angefasst; `ws-probe.mjs`
  deckt, was sie nicht kann.
- **`npm test` wird in 4b kleiner** — das muss im Commit und in
  `PROJECT-STATE.md` stehen, sonst liest es sich wie ein Verlust.
- **`~/.local/bin` ist ein neuer Schreibort** — der Pfadwächter braucht ihn,
  sonst bricht `install_writesOnlyUnderHome`.
- **Zwei Prozesse, echte Sockets, feste Fristen** — die Parität darf nie „was
  nach 2 s da war" vergleichen.
- **`BC_BIND=127.0.0.1:0` bleibt eine stille Lüge** — portieren, nicht beheben.

### Ordering and dependencies

`0 → 1 → 2a → 2b → 2c → 2d → 2e → 2f → 3`, dann `4a → 4b`. Jede Stufe ist ein
Auftrag für einen Implementer.

- **1 vor 2:** der Maßstab muss stehen, bevor gemessen wird.
- **2a** legt Konstanten, Config, Log und den Besitzerweg an; 2b (Codec) und 2c
  (Hub) bauen darauf; 2c braucht 2b.
- **2d** braucht 2c und 2a; **2e** braucht 2d; **2f** braucht 2e.
- **3** braucht 2f; **4a** braucht ein gebautes statisches Binary; **4b** braucht
  4a. Keine Stufe wartet auf eine spätere.
- Unberührt bis 4b: `bridge/**`, `extension/**`, `test/fixtures/fake-extension.mjs`,
  `package.json`. Unberührt bis 4a: `docs/18`, `docs/35`, `deploy/`,
  `scripts/install.sh`.

### What the next increment inherits

- **macOS und arm64** bleiben eine eigene Zeile; `platform/` ist dafür geschnitten.
- **Der Windows-Startweg ist kompiliert, nicht gelaufen** — Betreiber-Messung.
- **JSON-Randfälle** (lone surrogates, `x.0`) sind nicht zeichengleich.
- **`BRIDGE_FAILED`** erreicht die Parität nicht; ein Rust-Unit-Test pinnt ihn.
- **`scripts/parity.sh` ist ab 4b das Regressionsnetz** für alles, was früher
  die Node-Tests waren.
- **Der Prüflauf braucht Node** (Fixture, Helfer), das Binary nicht.
- **Token-Rotation bleibt ein Neustart.**

## Amendments to previous spec docs

Der Port löst **die Umsetzung** von `docs/18` und `docs/35` ab — nicht deren
Verhalten. Beide bleiben `active`; die Zeilen werden in **Stufe 4b** geändert,
wenn das Binary den Node-Weg ersetzt (nicht vorher, sonst beschreiben sie
Verhalten, das es noch nicht gibt).

| Datei | Stelle | alt | neu |
|---|---|---|---|
| `docs/18-…` | `## Konfiguration` / Unit | `ExecStart=/usr/bin/env node %h/browser-control/bridge/bridge.mjs --http` | `ExecStart=%h/.local/bin/browser-control-bridge --http` |
| `docs/18-…` | `## Ziel` und `## Bekannte Lücken` | „Node ≥ 22 auf dem Zielrechner" | „ein statisch gelinktes Binary; Node nur noch für Tests und den Parity-Lauf" |
| `docs/35-…` | `## Ziel` und Stufe 1 | `check_node_version`, `--fix-path` für den Node-`PATH` | `check_binary` (Binary vorhanden), `install_binary` nach `$HOME/.local/bin`; `--fix-path` entfällt |
| `docs/35-…` | `## Bekannte Lücken` | `~/.config/…` und `~/.config/systemd/user/` als einzige Schreiborte | dazu `~/.local/bin` (der Pfadwächter bekommt ihn als dritten Ort) |
| `docs/30-…` | Windows-Betrieb | Konsole startet `node bridge/bridge.mjs` | Konsole startet `browser-control-bridge.exe`; Dienst als Task-Scheduler-Aufgabe (`deploy/windows/browser-control-bridge.xml`) |
| `INSTALL.md`, `CONTRIBUTING.md` | Prerequisites/Abnahme | „Node ≥ 22" als Betriebsvoraussetzung | Node nur für Tests und `scripts/parity.sh`; `cargo test` kommt in die Abnahme |

## Bekannte Lücken

Stand 2026-11-16, vor der Umsetzung:

- **Keine Rust-Werkzeugkette auf dem Zielrechner.** Ob `x86_64-pc-windows-gnu`
  hier baut (Cross-Linker, `mingw-w64`), ist ungemessen.
- **Die Größe ist eine Schätzung** (5–10 MB statisch). Kein Messwert.
- **Windows-Dienst ungemessen:** `windows-service`, NSSM oder Task Scheduler —
  welche Form, entscheidet der Plan, die Machbarkeit der Live-Lauf.
- **Der Paritätsmaßstab ist noch nicht gebaut.** Ob zeichengenaue Gleichheit
  bei Logzeilen und JSON überhaupt erreichbar ist, zeigt erst Stufe 1.

## Open questions

**Keine offenen, die den Bau blockieren.** Entschieden am 2026-11-16: Rust,
paralleler Aufbau mit Löschung nach Parität, Linux und Windows x86_64.

## Review

### Runde 1 — steht aus

Die Spec geht durch das Gate, sobald Ziel und Kriterien abgesprochen sind.

## Log

- **2026-11-16, Betreiberentscheid:** Bridge nach Rust portieren, als **Ersatz**
  mit parallelem Aufbau und Löschung erst nach Parität; Zielplattformen Linux
  und Windows x86_64.
