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
   `bash scripts/parity.sh` ⇒ **sieben Vergleiche, alle „identisch"**.
2. **Ein Binary, zwei Plattformen.** Beweis:
   `cargo build --release --manifest-path bridge-rs/Cargo.toml` ⇒ 0 und genau
   **eine** ausführbare Datei; `cargo build --release --target
   x86_64-pc-windows-gnu` (oder `-msvc` auf Windows) ⇒ 0 und eine `.exe`.
   Größe dokumentiert.
3. **Dieselben Einstellungen und Exit-Codes.** Beweis: die Config-Fälle aus der
   Testlandkarte sind nach Rust übertragen und grün; `grep -c 'BC_' bridge-rs/src/*.rs`
   nennt alle sechs Variablen.
4. **Dieselben Logzeilen.** Beweis: der Paritätsvergleich 7 ist grün, und
   `grep -c 'listening on\|extension connected\|status windows=' bridge-rs/src/*.rs`
   ⇒ ≥ 3.
5. **Die deutschen Sätze sind nicht neu geschrieben.** Beweis: der
   Paritätsvergleich 2 ist grün — die Sätze stammen aus `mcp.mjs`, nicht aus
   einer Übersetzung.
6. **Die Ablösung ist eine Stufe, kein Zufall.** Beweis: `bridge/` existiert
   noch, `docs/18` und `docs/35` sind erst in der Stufe geändert, die den
   Wechsel vollzieht (`## Dev plan`, Stufe 4); `git log --oneline -- bridge/`
   zeigt in dieser Stufe **einen** Commit, der alles löscht.
7. **Die systemd-Unit bleibt gültig.** Beweis: das Binary läuft mit `--http` auf
   `127.0.0.1:8110/8111`, `deploy/browser-control.service` nennt es in
   `ExecStart=`; der Paritätsvergleich 5 und 6 (Port, Token) ist grün.
8. **Windows hat einen Startweg.** Beweis: ein Abschnitt in `INSTALL.md` nennt
   den Dienst-Wrapper und wie er das Binary startet; `docs/30` (falls dort
   offen) nennt ihn ebenfalls.
9. **Kein Node auf dem Zielrechner nötig.** Beweis:
   `file bridge-rs/target/release/browser-control-bridge` zeigt ein statisch
   gelinktes ELF; `ldd` findet keine Node-Bibliothek.
10. **Kein Produktcode außerhalb der Grenze vor Stufe 4.** Beweis:
    `git status --porcelain` nennt `bridge-rs/`, `scripts/parity.sh`, `docs/…`
    und **nichts** unter `bridge/` oder `extension/`.

## Dev plan

*Wird nach der Absprache über Ziel und Kriterien vom Subagenten `architect`
geschrieben.*

**Was der Plan berücksichtigen muss** (Vorgaben, keine Messungen):

- **Schritt 0 ist die Werkzeugkette:** auf bigdelli ist **kein** `cargo`
  installiert (`command -v cargo` ⇒ leer). rustup, ein Ziel-Toolchain für
  `x86_64-pc-windows-gnu` (oder Bauen unter Windows) und ein Cross-Linker
  gehören vor die erste Zeile Code — und in die Doku, nicht in eine Annahme.
- **Die Reihenfolge ist Parität zuerst:** Stufe 1 baut den Prüflauf gegen die
  *Node*-Bridge (er muss dort grün sein, sonst ist er kein Maßstab), Stufe 2 die
  Rust-Module, Stufe 3 die Windows-Seite, Stufe 4 der Wechsel.
- **WebSocket:** eine Bibliothek ist erlaubt, aber die beobachtbaren Details
  (Close-Codes, Nachrichtengrenze, Fragmentierung) bleiben Vertrag; wenn die
  Bibliothek sie nicht hergibt, wird das Stück selbst geschrieben.
- **Portbesitzer** braucht zwei Wege (`/proc` unter Linux, `GetExtendedTcpTable`
  unter Windows) — `port-owner.mjs` hat heute nur den ersten.
- **Die deutschen Sätze** werden aus `mcp.mjs` übernommen, nicht neu formuliert.
- **`bridge/` bleibt unangetastet**, bis Stufe 4 sie in einem Commit löscht;
  vorher prüfen die bestehenden 764 Tests weiter den Node-Weg.
- **`scripts/install.sh`** (Spec 35) muss in Stufe 4 das Binary statt `node`
  einrichten; `docs/18` und `docs/35` bekommen dort ihre Amendments.

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
