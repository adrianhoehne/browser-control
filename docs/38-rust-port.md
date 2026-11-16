---
description: Teil 2 des Rust-Projekts — die Bridge-Module (Konstanten, Config, WebSocket, Hub, Werkzeuge, HTTP, stdio) nach Rust, danach Windows, Installer und der Schnitt; gemessen wird gegen den Paritätsmaßstab aus Teil 1.
status: proposed
---

# Die Rust-Bridge, Teil 2: der Port

`docs/37-rust-bridge.md` (Teil 1) hat den **Maßstab** gebaut: sieben
eingecheckte Soll-Artefakte und `scripts/parity.sh` mit `--record`, `--check`
und `--self-test`. Dieser Teil portiert die Bridge dagegen und schaltet um.

**Voraussetzung:** Teil 1 ist gebaut — Werkzeugkette, baubares Gerüst,
sieben Artefakte. Ohne ihn gibt es nichts, wogegen gemessen wird.

## Ziel

- **Die Module nach Rust**, eines nach dem anderen, jedes gegen den Maßstab
  gemessen: Konstanten, Config, Log, Portbesitzer, WebSocket-Codec, Hub,
  Werkzeugschicht, HTTP, stdio.
- **Dieselbe Oberfläche.** Dreizehn Werkzeuge, dieselben Schemata, dieselben
  deutschen Sätze aus `mcp.mjs` — **kopiert, nicht formuliert**; dieselben
  Logzeilen, dieselben Exit-Codes `0`/`1`/`2`.
- **Windows** bekommt Portbesitzer (`GetExtendedTcpTable`), stdin-Erkennung
  (`GetFileType`) und einen Startweg (Task Scheduler).
- **Der Schnitt am Ende:** `bridge/` fällt in **einem** Commit, Unit und
  Installer zeigen auf das Binary, `docs/18`/`docs/35` sind nachgezogen.

## Non-goals

- **Kein Protokollwechsel, keine neuen Werkzeuge, keine neuen Codes.** Die 13
  bleiben 13.
- **Keine Änderung an der Extension** (`extension/` bleibt JavaScript).
- **Kein macOS, kein arm64.**
- **Kein Parallelbetrieb auf Dauer** — nach dem Schnitt gibt es eine
  Implementierung.
- **Keine neuen Funktionen.** Was heute fehlt, fehlt danach auch.

## Dependency changes

Neue Abhängigkeiten — und **die einzigen**:

| Crate | Zweck | Lizenz |
|---|---|---|
| `tokio` (`rt-multi-thread`, `net`, `time`, `signal`, `sync`, `io-util`, `macros`) | asynchrones I/O, Fristen, Signalende | MIT |
| `serde` + `serde_json` (`preserve_order`) | JSON-RPC, Schemata, Antworten **in der Reihenfolge von `mcp.mjs`** | MIT / Apache-2.0 |
| `sha1` + `base64` | `Sec-WebSocket-Accept` | MIT / Apache-2.0 |
| `hyper` + `http-body-util` | `POST /mcp` (nur der MCP-Port) | MIT |
| `windows-sys` (`cfg(windows)`) | Portbesitzer, `GetFileType`, Prozessname | MIT / Apache-2.0 |

**Kein `hyper` für den Extension-Port.** Dort steht ein eigener, kleiner
HTTP/1.1-Kopfleser: er sieht genau zwei Formen (`GET` mit `Upgrade`, alles
andere ⇒ `426`), und die Bytes **nach** dem Handshake müssen ohnehin in den
Frame-Codec — genau die Stelle, an der eine Bibliothek Arbeit spart oder Bytes
verschluckt.

**Versionen:** die exakten Versionen stehen im **eingecheckten `Cargo.lock`**.
Er entsteht in Stufe 2a (erste Abhängigkeit) und wird ab dort mitgepflegt; ein
`cargo update` ist ein eigener Commit mit eigenem Parity-Lauf.

## Das Inventar (aus dem Code gelesen, 2026-11-16)

| Datei | Zeilen | Was | Muss portiert werden |
|---|---|---|---|
| `bridge.mjs` | 291 | CLI (`--http`), Start, Signalende | ja |
| `config.mjs` | 136 | ENV, Bind/Port, Tokenpfad, Tokenprüfung | ja |
| `protocol.mjs` | 49 | Drahtkonstanten (Version, Typen, Methoden, Close-Codes) | ja |
| `websocket.mjs` | 432 | RFC 6455 von Hand: Handshake, Maskierung, Fragmentierung, Grenze, Close | ja |
| `hub.mjs` | 1.021 | eine Sitzung, Fristen, Anfrage-Ids, Statuszeilen, Log | ja |
| `mcp.mjs` | 1.820 | JSON-RPC, `tools/list`, 13 Werkzeuge, Schemata, deutsche Sätze | ja |
| `http-transport.mjs` | 247 | `POST /mcp`, Bearer, Body-Grenze, Statuscodes | ja |
| `port-owner.mjs` | 161 | Portbesitzer (`/proc`; Windows: `GetExtendedTcpTable`) | ja, plattformspezifisch |

**Nicht verhandelbar:** WS-Frames und Close-Codes, Statuszeilen
(`status windows=<n> tabs=<m>`), Werkzeugantworten als eingerücktes JSON,
Bildblöcke, die deutschen Fehlersätze, Exit-Codes.

## Die Testlandkarte

Die 9.572 Zeilen Bridge-Tests sind die Spezifikation des Verhaltens. Sie bleiben
bis zum Schnitt, wo sie sind, und werden Modul für Modul übertragen:

| Testdatei | Zeilen | Prüft | Rust-Ziel |
|---|---|---|---|
| `websocket.test.js` | 466 | Framing, Maskierung, Close | `ws` |
| `hub.test.js` | 2.029 | Sitzung, Fristen, Statuszeilen, Log | `hub` |
| `mcp.test.js` | 4.692 | Werkzeuge, Schemata, Sätze | `mcp` |
| `http-mcp.test.js` | 573 | `POST /mcp`, Auth, Statuscodes | `http` |
| `http-transport.test.js` | 697 | Body-Grenzen, Header, Fehler | `http` |
| `protocol.test.js` | 233 | Konstanten gleich `extension/protocol.js` | `protocol` |
| `port-owner.test.js` | 60 | Besitzerzeile | `platform` |
| `config.test.js` | 38 | ENV, Tokenpfad | `config` |
| `ports.test.js`, `bridge.test.js` | 784 | Portreservierung, Startverhalten | `main` |

**1:1 übertragbar:** die 14 reinen Fälle aus `test/hub.test.js` (2
`formatStatusLine_*`, 9 `debugBlockOf_*`, 3 `verifyToken_*`), die 13 aus
`test/websocket.test.js`, die 3 aus `test/config.test.js`, die 2 aus
`test/port-owner.test.js`, die Naht-Fälle aus `test/mcp.test.js` (Zahl in 2d
ausgezählt), die 14 aus `test/http-transport.test.js`, die 3 Invarianten aus
`test/ports.test.js`.

**Umgeschrieben, weil sie Node-Interna prüfen:** `test/protocol.test.js` (17) —
`vm.runInNewContext` und `Object.isFrozen` haben keine Entsprechung; Ersatz sind
3 Fälle mit einem Textauszug aus `extension/protocol.js`, der bei unbekannter
Form laut scheitert. Die 41 `hub_*`-Fälle (kein Pollen mehr nötig, der Test
treibt `hub.on_message` direkt). Die Prozessfälle aus `test/mcp.test.js` und die
10 aus `test/bridge.test.js` (`spawn(process.execPath, …)` ⇒ `Command::new`,
Zeile schreiben/lesen mit Frist). `test/deploy.test.js` und
`test/install.test.js` werden **nicht** portiert, sondern in Stufe 4a in der
Node-Suite nachgezogen.

**Fällt ohne Ersatz weg:** die Node-spezifischen Fälle aus `test/mcp.test.js`
(EPIPE auf stdout, `MaxListenersExceededWarning`) — sie prüfen Node-Verhalten.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `bridge-rs/tests/protocol.rs` | `protocol_constants_matchTheExtension` | dieselben Konstanten wie `extension/protocol.js` |
| `bridge-rs/tests/ws.rs` | `ws_onAnAnnouncedOversizedFrame_shouldCloseWith1009BeforeThePayloadArrives` | die Grenze feuert vor dem Puffern |
| `bridge-rs/tests/hub.rs` | die 55 Fälle aus `test/hub.test.js` (14 rein + 41 Sitzung) | Sitzung, Fristen, Statuszeilen |
| `bridge-rs/tests/mcp.rs` | `mcp_toolsListIsByteIdentical`, `failureTextFor_*` | Werkzeuge und deutsche Sätze |
| `bridge-rs/tests/http.rs` | 16 Fälle | Auth, Grenzen, Statuscodes |
| `bridge-rs/tests/bridge.rs` | `mcp_whenStdinEnds_shouldExitZeroAfterASingleShutdownLine`, `mcp_withAnIgnoredStdin_shouldKeepRunningAndListeningAfterTheEof` | stdin-Lebenszyklus |
| **live (Betreiber)** | die echte Extension verbindet sich mit dem Binary | der Port ist kein Selbstgespräch |

## Acceptance criteria

1. **Die Module sind portiert und paritätisch.** Beweis:
   `cargo test --manifest-path bridge-rs/Cargo.toml` ⇒ 0 failed, und
   `bash scripts/parity.sh --impl rust --check` ⇒ **7/7 wie erwartet**, Exit 0.
2. **Dieselben Einstellungen und Exit-Codes.** Beweis:
   `grep -rho 'BC_[A-Z_]*' bridge-rs/src | sort -u` ⇒ sechs Zeilen (`BC_BIND`,
   `BC_CALL_TIMEOUT_MS`, `BC_HELLO_TIMEOUT_MS`, `BC_HTTP_PORT`, `BC_LOG`,
   `BC_TOKEN_FILE`); die Config-Fälle grün; Exit `2`/`1` wie in Teil 1 gemessen.
3. **Dieselben Logzeilen.** Beweis: Paritätsvergleich 7 grün, und
   `grep -rho 'listening on\|extension connected\|status windows=' bridge-rs/src
   | sort -u | wc -l` ⇒ **3**.
4. **Die deutschen Sätze sind kopiert.** Beweis: Paritätsvergleich 2 grün.
   **Eine benannte Ausnahme:** `BRIDGE_FAILED` ist nicht auslösbar und wird von
   einem Rust-Unit-Test gepinnt.
5. **Windows ist gebaut.** Beweis:
   `cargo build --release --manifest-path bridge-rs/Cargo.toml --target
   x86_64-pc-windows-gnu` ⇒ 0; `cargo clippy … --target
   x86_64-pc-windows-gnu -- -D warnings` ⇒ 0; `file -b …/browser-control-bridge.exe`
   ⇒ `PE32+ executable (console) x86-64`. **Der Lauf auf Windows ist eine
   Betreiber-Messung** (`## Bekannte Lücken`).
6. **Der Schnitt ist eine Stufe.** Beweis: `test -d bridge && echo present` ⇒
   `present` bis 4b; danach `gone`; `git log --diff-filter=D --oneline -- bridge/
   | wc -l` ⇒ **1**.
7. **Unit und Installer zeigen auf das Binary.** Beweis:
   `grep -c 'ExecStart=%h/.local/bin/browser-control-bridge --http' deploy/browser-control.service`
   ⇒ **1**; `grep -c 'bridge/bridge.mjs' scripts/install.sh` ⇒ **0**;
   `node --test --test-reporter=tap test/deploy.test.js test/install.test.js |
   grep -cE '^ok [0-9]+ - (install_|browserControlService_|execStart_)'` ⇒ **32**.
8. **Die 764 → kleineren Node-Tests bleiben grün.** Beweis: `npm test` ⇒
   `# fail 0`, `# cancelled 0`, `# skipped 0`; `npm run check` ⇒ 0.
9. **Kein Produktcode außerhalb der Grenze.** Beweis: `git status --porcelain`
   nennt je Stufe nur die dort erlaubten Dateien (siehe `## Dev plan`);
   `git diff HEAD -- extension/` ⇒ leer.
10. **Kein Geheimnis.** Beweis:
    `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1.

## Dev plan

**Stufe 2a — `protocol`, `config`, `log`, `platform/linux`, Startverhalten**

Dateien: `src/{protocol,config,log}.rs`, `src/platform/{mod,linux}.rs`,
`src/main.rs` (Token ⇒ `2`; binden ⇒ `1` + Besitzerzeile; `listening on … log=…`;
SIGTERM ⇒ `received SIGTERM, shutting down` + `0`), `tests/{protocol,config,platform}.rs`,
`tests/common/mod.rs`, `tests/ports.rs`, `Cargo.toml` (tokio), `Cargo.lock`.

Mitzuportieren, weil es Verhalten ist: `parseBind` (letzter Doppelpunkt,
`[::1]`-Klammern, leerer Host ⇒ `127.0.0.1`, ungültiger Port ⇒ `8110`)
**einschließlich `:0` ⇒ `8110`** (nicht „reparieren"); `BC_LOG` nur `info|debug`;
Token ≥ 32 Hex, getrimmt, `ENOENT` ⇒ `2`, sonst `bridge failed: …` + `1`;
`EADDRINUSE` als **String** in der Zeile.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test protocol --test config --test platform
bash scripts/parity.sh --impl rust --check --only 5,6      # ⇒ 2/7
```

**Stufe 2b — `ws`: Handshake, Codec, Close**

Dateien: `src/ws/{mod,frame,handshake}.rs`, `tests/ws.rs`, `Cargo.toml`
(`sha1`, `base64`).

**Keine WebSocket-Bibliothek**: die Close-Codes `4401/4408/4409` und
`1002/1003/1009` sind Vertrag, die Grenze muss **vor** dem Puffern feuern, und
Bytes nach dem Handshake sind ein eigener Fall.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test ws 2>&1 | grep -cE '^test (acceptKey|encodeFrame|frameDecoder|upgradeSocket|websocket)_[A-Za-z0-9]+ \.\.\. ok'   # ⇒ 13
```

**Stufe 2c — `hub`**

Dateien: `src/hub.rs`, `tests/hub.rs`. Der Hub kennt keinen Socket, sondern
`mpsc::Sender<Outbound>` + `Arc<AtomicBool>`; `close(code, reason)` geht als
`Outbound::Close` durch denselben Kanal. Fristen über `tokio::time` mit den
Werten aus der Config (Tests: 100–300 ms).

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test hub 2>&1 | grep -cE '^test (hub|formatStatusLine|debugBlockOf|verifyToken)_[A-Za-z0-9]+ \.\.\. ok'   # ⇒ 55
bash scripts/parity.sh --impl rust --check --only 4        # ⇒ 1/7
```

**Stufe 2d — Werkzeugschicht und stdio**

Dateien: `src/mcp/{mod,tools,texts,failure}.rs`, `src/stdio.rs`, `src/main.rs`,
`tests/mcp.rs` (Naht), `Cargo.toml` (`serde`, `serde_json` mit
`preserve_order`).

`tools.rs` schreibt die 13 Einträge als `json!`-Literale **in der Reihenfolge
von `bridge/mcp.mjs`**; `texts.rs` kopiert `TOOL_TEXTS` wörtlich. `SERVER_INFO`
bleibt `{"name":"browser-control","version":"0.1.0"}` (nicht aus `Cargo.toml`).

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test mcp 2>&1 | tail -1   # ⇒ 0 failed; N im ## Log gegen die Naht-Fälle gestellt
bash scripts/parity.sh --impl rust --check --only 1,2,3    # ⇒ 3/7 (Vergleich 7 braucht --http aus 2e)
```

**Stufe 2e — `POST /mcp`**

Dateien: `src/http.rs`, `tests/http.rs`, `Cargo.toml` (`hyper`,
`http-body-util`). Reihenfolge Pfad → Methode → Token → Körper; `404`, `405` +
`Allow: POST`, `401` + `WWW-Authenticate`, `413` vor dem ersten Body-Byte und
beim chunked-Körper, `200`, `null` ⇒ `202`; jede Ablehnung mit
`Connection: close`; `MAX_BODY_BYTES = 1048576`.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml --test http 2>&1 | grep -cE '^test http_[A-Za-z0-9]+ \.\.\. ok'   # ⇒ 16
bash scripts/parity.sh --impl rust --check --only 7        # ⇒ 1/7
```

**Stufe 2f — Prozesstests, stdin, voller Paritätslauf**

Dateien: `tests/bridge.rs`, `tests/mcp.rs` (Prozessfälle), `src/{main,stdio}.rs`.

**stdin-EOF beendet nur, wenn stdin eine Pipe oder ein Socketpair ist** — unter
systemd ist stdin `/dev/null`, sonst beendet sich der Dienst sofort und
`Restart=on-failure` dreht eine Schleife. Linux:
`metadata("/proc/self/fd/0")` + `FileTypeExt::is_fifo()/is_socket()`.

Proof:
```
cargo test --manifest-path bridge-rs/Cargo.toml 2>&1 | tail -1   # ⇒ 0 failed
bash scripts/parity.sh --impl rust --check; echo $?              # ⇒ 7/7, 0
```

**Stufe 3 — Windows**

Dateien: `src/platform/windows.rs` (`GetExtendedTcpTable` → PID →
`QueryFullProcessImageNameW`), `src/stdio.rs` (`GetFileType`), `src/main.rs`
(`ctrl_c`), `Cargo.toml` (`windows-sys`), `bridge-rs/README.md`,
`deploy/windows/browser-control-bridge.xml` (Task Scheduler, `AtLogOn`,
`InteractiveToken`, ohne Admin).

Proof:
```
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu; echo $?   # ⇒ 0
cargo clippy --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu -- -D warnings; echo $?   # ⇒ 0
file -b bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe   # ⇒ "PE32+ … (console) x86-64"
```

**Stufe 4a — Unit, Installer, `docs/35`**

Dateien: `deploy/browser-control.service` (`ExecStart=%h/.local/bin/browser-control-bridge
--http`, `RestartPreventExitStatus=2` bleibt), `scripts/install.sh`
(`check_binary`, `install_binary` aus
`<clone>/bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge`
nach `$HOME/.local/bin` mit `0755`; fehlt die Quelle: „nicht gebaut, `cargo
build --release --target x86_64-unknown-linux-musl` zuerst" + Exit `1`;
`guard_path` bekommt `$HOME/.local/bin` als dritten Ort, und
`install_guardPathRejectsAPathOutsideTheAllowedSet` wird **erweitert**, nicht
aufgeweicht; `--fix-path` entfällt), `test/deploy.test.js`,
`test/install.test.js` (Sandbox legt nur noch `home/browser-control/` an, nicht
mehr `…/bridge/bridge.mjs`; zwei neue Fälle
`install_copiesTheBinaryToLocalBin`, `install_withMissingBinary_abortsBeforeWriting`;
`install_withOldNode_abortsBeforeWriting` und
`install_fixPathWritesTheDropInOnlyWhenNeeded` werden **an Ort und Stelle**
umgeschrieben und behalten ihr `install_`-Präfix), **`docs/35` wird hier
nachgezogen** (`docs/README.md`: die Stufe, die das Verhalten ändert).
`docs/18` bleibt bis 4b unangetastet.

Proof:
```
node --test --test-reporter=tap test/deploy.test.js test/install.test.js 2>&1 | grep -cE '^ok [0-9]+ - (install_|browserControlService_|execStart_)'   # ⇒ 32
grep -c 'ExecStart=%h/.local/bin/browser-control-bridge --http' deploy/browser-control.service   # ⇒ 1
grep -c 'bridge/bridge.mjs' scripts/install.sh                                                   # ⇒ 0
bash -n scripts/install.sh; echo $?
```

**Stufe 4b — der Schnitt**

Löschen: `bridge/` (8 Dateien), die zehn Node-Bridge-Testdateien, `test/ports.js`.
Ändern: `test/extension.test.js` (der `loadConfig`-Import wird zu den Literalen
`127.0.0.1`/`8110` plus Drift-Satz), `docs/18` (Amendments; der
Amendments-Abschnitt von `docs/35` wird **entfernt**), `docs/30` und
`INSTALL.md` (Task-Scheduler-Weg; Node nur noch für Tests), `CONTRIBUTING.md`
(`cargo test` in der Abnahme).

Proof:
```
test -d bridge && echo present || echo gone                 # ⇒ "gone"
git log --diff-filter=D --oneline -- bridge/ | wc -l        # ⇒ 1
npm test 2>&1 | grep -E '^# (tests|fail|cancelled|skipped)'  # ⇒ fail/cancelled = 0
cargo test --manifest-path bridge-rs/Cargo.toml 2>&1 | tail -1
bash scripts/parity.sh --impl rust --check; echo $?         # ⇒ 7/7, 0
grep -rnE 'bridge/config\.mjs|bridge/bridge\.mjs|bridge\.mjs' test/ scripts/ deploy/ package.json   # ⇒ keine Ausgabe
```

### What could go wrong

- **`EADDRINUSE` ist in Rust kein String** — `kind()`/`raw_os_error()` (98 bzw.
  10048); die Logzeile braucht das Wort, sonst fällt Vergleich 5 leise.
- **`preserve_order` und Zahlenformate** — ohne `preserve_order` sortiert
  `serde_json` Schlüssel alphabetisch (Vergleich 1 sofort rot); ein `12.0`
  schreibt Node als `12`, Rust als `12.0` ⇒ Zahlenformatierer wie Node plus
  Testfall.
- **stdin-EOF unter systemd** — ohne die Prüfung startet der Dienst im
  Sekundentakt neu.
- **Bytes nach dem Handshake** — der eigene Kopfleser muss die Restbytes an den
  Codec weiterreichen, sonst geht ein `hello` im selben Paket verloren.
- **Die Fixture ist geteilt** — sie wird nicht angefasst; `ws-probe.mjs` deckt,
  was sie nicht kann.
- **`npm test` wird in 4b kleiner** — das gehört in den Commit und in
  `PROJECT-STATE.md`, sonst liest es sich wie ein Verlust.
- **`~/.local/bin` ist ein neuer Schreibort** — ohne Pfadwächter-Eintrag bricht
  `install_writesOnlyUnderHome`.
- **`BC_BIND=127.0.0.1:0` bleibt eine stille Lüge** — portieren, nicht beheben.
- **Lone surrogates** nimmt Node, `serde_json` nicht — benannte Lücke, kein
  Blocker.

### Ordering and dependencies

`2a → 2b → 2c → 2d → 2e → 2f → 3`, dann `4a → 4b`. Voraussetzung ist Teil 1
(`docs/37`). 2c braucht 2b; 2d braucht 2c und 2a; 2e braucht 2d; 2f braucht 2e;
3 braucht 2f; 4a braucht ein gebautes statisches Binary; 4b braucht 4a.
Unberührt bis 4a: `docs/18`, `deploy/browser-control.service`; unberührt bis 4b:
`bridge/**`, `extension/**`, `test/fixtures/fake-extension.mjs`.

### What the next increment inherits

- **macOS und arm64** bleiben eine eigene Zeile; `platform/` ist dafür geschnitten.
- **Der Windows-Startweg ist kompiliert, nicht gelaufen.**
- **`scripts/parity.sh --check` ist ab 4b das Regressionsnetz** für alles, was
  früher die Node-Tests waren.
- **Node bleibt für Tests und Parity** — nicht für den Betrieb.

## Amendments to previous spec docs

| Datei | Stelle | alt | neu | Stufe |
|---|---|---|---|---|
| `docs/18-…` | `## Konfiguration` / Unit | `ExecStart=/usr/bin/env node %h/browser-control/bridge/bridge.mjs --http` | `ExecStart=%h/.local/bin/browser-control-bridge --http` | 4b |
| `docs/18-…` | `## Ziel`, `## Bekannte Lücken` | „Node ≥ 22 auf dem Zielrechner" | „ein statisch gelinktes Binary; Node nur für Tests" | 4b |
| `docs/35-…` | `## Ziel`, Stufe 1 | `check_node_version`, `--fix-path` | `check_binary`, `install_binary` nach `$HOME/.local/bin`; `--fix-path` entfällt | 4a |
| `docs/35-…` | `## Bekannte Lücken` | zwei Schreiborte | dazu `~/.local/bin` | 4a |
| `docs/30-…` | Windows-Betrieb | `node bridge/bridge.mjs` | `browser-control-bridge.exe`, Task-Scheduler-Aufgabe | 4b |
| `INSTALL.md`, `CONTRIBUTING.md` | Prerequisites/Abnahme | „Node ≥ 22" als Betriebsvoraussetzung | Node nur für Tests/Parity; `cargo test` in der Abnahme | 4b |
| `docs/ROADMAP.md` | Zeilen 23/24, 26–28 | Signierung setzt MV3 voraus | unverändert — der Port berührt die Signatur nicht | — |

## Bekannte Lücken

Stand 2026-11-16:

- **Windows ist kompiliert, nicht gelaufen.** Task Scheduler,
  `GetExtendedTcpTable`, `GetFileType` sind Betreiber-Messungen.
- **Lone surrogates und `x.0`-Zahlen** sind nicht zeichengleich zu Node —
  benannt, nicht behoben.
- **`BRIDGE_FAILED`** erreicht die Parität nicht; ein Rust-Unit-Test pinnt ihn.
- **`test/mcp.test.js`-Fälle, die Node-Verhalten prüfen** (EPIPE,
  `MaxListenersExceededWarning`) fallen ohne Ersatz weg.
- **Die Zahl der Naht-Fälle** in `test/mcp.test.js` wird in Stufe 2d ausgezählt
  und im `## Log` eingetragen.

## Open questions

**Keine.** Die HTTP-Frage (eigener Kopfleser am Extension-Port, `hyper` nur für
`/mcp`) ist mit `## Dependency changes` entschieden.

## Review

### Runden 1–3 der gemeinsamen Fassung — 2026-11-16, `grizzled-senior-dev`

Die gemeinsame Fassung wurde dreimal blockiert (Runde 1 `🤔` mit 7 Blockern,
Runde 2 `🔧` mit 8 Punkten, Runde 3 `🔧` mit 5 Punkten und vier neuen
Textwidersprüchen). Statt einer vierten Runde wurde **geteilt**
(`CONTRIBUTING.md`, Schritt 4). Aus Runde 3 sind hier eingearbeitet: der
2b-Nachsatz („tokio und serde erst mit 2a/2d") ist weg, `docs/35` steht nur
noch in 4a (in 4b wird nur der Amendments-Abschnitt entfernt), der Plan-Baum
nennt **kein** `.cargo/config.toml` mehr, die 2f-Begründung „Node-Seite gibt es
nicht mehr" ist nach 4b gewandert, und die beiden `install_`-Fälle, die 4a
umschreibt, behalten ihr Präfix (Zahl **32** hält).

### Runde 4 — steht aus

Teil 2 geht durch das Gate, sobald Teil 1 gebaut ist — vorher ist sein Maßstab
nur Papier.

## Log

- **2026-11-16, Betreiberentscheid:** Rust, paralleler Aufbau, Linux und Windows
  x86_64.
- **2026-11-16, Teilung:** nach dem dritten Block in „Maßstab" (`docs/37`) und
  „Port" (dieser Teil) getrennt.
- **Aus Runde 1–3 übernommen:** `## Dependency changes` mit sechs Crates;
  eigene Abhängigkeiten in 2a/2b/2d/2e/3 statt einer Sammelzeile; kein
  `.cargo/config.toml`; Zahlen statt „≥" (16 in 2e, 32 in 4a); `--check` in
  jedem Parity-Beweis; `docs/35` in 4a, `docs/18` in 4b; `git log
  --diff-filter=D` in 4b; `deploy/windows/` in Stufe 3 erlaubt.
