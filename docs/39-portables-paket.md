---
description: Ein portables Zip — Startskripte, die das Token im Ordner anlegen, das Server-Binary, die XPI und zwei Anleitungen; entpacken, starten, fertig, ohne Installation, ohne Root, ohne Dienst.
status: proposed
---

# Das portable Paket

Heute braucht ein neuer Nutzer einen Klon, eine Rust-Toolchain, `cargo build` und
`./scripts/install.sh`. Danach warten vier Handgriffe in Firefox, die niemand
errät.

Diese Spec macht daraus: **Zip herunterladen, entpacken, Anleitung lesen.** Kein
Compiler, kein Root, kein Dienst, kein systemd.

**Was sie nicht tut:** die Erweiterung signieren (Roadmap 23/24), Firefox
mitliefern, sich als Dienst einrichten, ein Token vorab in ein Firefox-Profil
schreiben.

Die Erweiterung lädt der Nutzer weiterhin über `about:debugging`. Nach einem
Firefox-Neustart ist sie weg. Das ist die Grenze dieses Pakets, und sie steht in
der Anleitung.

## Ziel

- **Ein Zip je Plattform**, beide aus demselben Bau:
  `browser-control-<version>-linux-x86_64.zip` und
  `browser-control-<version>-windows-x86_64.zip`.
- **Alles liegt im entpackten Ordner.** Das Token entsteht beim ersten Start in
  `./data/token`. Geschrieben wird nichts außerhalb des Ordners: kein
  `~/.local/bin`, keine Unit, kein `~/.config`.
- **Zwei Anleitungen, Englisch nach ASD-STE100**: eine für Firefox, eine für die
  MCP-Clients (pi, Codex, OpenCode plus ein generisches Muster). Der Nutzer muss
  danach nichts weiter wissen als das, was dort steht.

  **Kein automatischer Lint:** STE100 ist eine Schreibregel, kein Prüfschritt
  (Betreiberentscheid 2026-11-17). Wer die Anleitungen ändert, liest sie gegen
  die Regeln — nummerierte Schritte, Befehlsform, höchstens 20 Wörter.
- **Die Anleitungen haben eine Quelle.** Sie liegen im Repo und werden vom
  Bündel-Skript ins Zip kopiert — keine zwei Fassungen, die auseinanderlaufen.
- **Der Release hängt die Zips an** — das ist `docs/40` (Job `release`), nicht
  diese Spec. Hier entstehen nur die Dateien.

## Non-goals

- **Keine Signierung, kein AMO.** Die XPI bleibt unsigniert; sie funktioniert in
  Firefox über `about:debugging` (temporär) und in der Developer Edition, Nightly
  oder ESR mit `xpinstall.signatures.required=false`.
- **Kein mitgeliefertes Firefox.** Kein ESR im Zip, keine `policies.json`.
- **Kein Dienst, kein Autostart.** Wer das will, nimmt `scripts/install.sh`.
- **Kein Token im Zip.** Es entsteht beim ersten Start; ein verteiltes Token wäre
  in jedem Download derselbe Schlüssel.
- **Kein Signieren des Binaries, keine Installer (`.deb`, `.msi`).**

## Der Inhalt des Zips

```
browser-control-<version>-linux-x86_64/
  browser-control-bridge          das statisch gelinkte Binary (musl)
  browser-control-<version>.xpi   die unsignierte Erweiterung
  start.sh                        Token anlegen (einmalig), Endpunkt zeigen, starten
  README.txt                      vier Sätze Englisch: was das ist, was zu tun ist, wo die Anleitungen liegen (nicht lint-geprüft, zu kurz)
  FIREFOX.md                      Anleitung Erweiterung (Englisch, STE100)
  CLIENTS.md                      Anleitung MCP-Clients (Englisch, STE100)
  (kein data/ im Zip — es entsteht beim ersten Start im entpackten Ordner)
```

Windows: `browser-control-bridge.exe` und `start.cmd` statt der Linux-Pendants,
sonst gleich.

**`start.sh` — Vertrag:**

1. `data/` anlegen, falls es fehlt.
2. `data/token` anlegen, **nur wenn es fehlt**: 32 Bytes aus einem
   kryptografischen Zufall (`openssl rand -hex 32`, Rückfall `head -c 32
   /dev/urandom | od -An -tx1 | tr -d ' \n'`), `chmod 600`. Ein vorhandenes Token
   wird **nie** überschrieben — sonst wäre jeder Neustart ein Logout der
   Erweiterung.
3. `BC_TOKEN_FILE` auf `data/token` setzen, `BC_BIND`/`BC_HTTP_PORT` aus der
   Umgebung durchlassen (Vorgaben `127.0.0.1:8110`/`8111`).
4. Genau **drei Zeilen** auf stdout zeigen, in dieser Form — der Nutzer trägt
   sie in Firefox und im Client ein, die Kriterien greppen sie:

   ```
   endpoint: ws://127.0.0.1:8110
   http: http://127.0.0.1:8111/mcp
   token: <64 hex>
   ```

   Ports aus `BC_BIND`/`BC_HTTP_PORT`, sichtbar als das, was gilt. Eine
   Wildcard-Adresse (`0.0.0.0`, `::`) wird als `127.0.0.1` gedruckt — was nicht
   dialbar ist, wird nicht angezeigt. Danach
   `exec` auf das Binary mit `--http`. Kein `nohup`, keine PID-Datei: das Skript
   ist der Prozess, Strg+C beendet ihn.

**`start.cmd` — derselbe Vertrag** für Windows, **ohne WSL**, mit **CRLF**-
Zeilenenden (auf Linux gebaut wäre das Zip sonst LF, und `cmd.exe` stolpert).
Token aus einem CSPRNG, nicht aus `Get-Random`:
`[System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)` → Hex →
`data\token`.

## Die zwei Anleitungen

Das Zip trägt `FIREFOX.md` und `CLIENTS.md`. **Ihr Inhalt und ihre Prüfung stehen
in `docs/41-anleitungen.md`** (abgespalten am 2026-11-17, `CONTRIBUTING.md`
Schritt 4). Hier zählen nur zwei Dinge: die Dateien liegen im Zip, und sie kommen
aus `docs/portable/` — eine Quelle, keine zweite Fassung.

## Abgrenzung

Der **CI-Ablauf** (Jobs, lokaler Nachbau, Release-Anhang) steht in
`docs/40-ci-ablauf.md`. Diese Spec liefert das Zip und die Anleitungen. `docs/40`
prüft und veröffentlicht sie. Zwei Inkremente, zwei Specs (`CONTRIBUTING.md`).

## Dependency changes

**Keine.** Das Zip enthält nur, was schon gebaut wird: `bridge-rs` und die XPI
aus `scripts/package.sh`.

## Testing

**Vorbedingung:** die Fälle brauchen ein gebautes Release-Binary
(`bridge-rs/target/x86_64-unknown-linux-musl/release/`) und `zip`/`unzip`. Fehlt
das Binary, **scheitern** sie (kein Skip — ein grüner Lauf ohne Prüfung wäre
schlimmer); fehlen `zip`/`unzip`, skippen die zwei Zip-Fälle wie in
`test/package.test.js`.

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/bundle/bundle.test.js` | `bundle_linuxZip_shouldContainExactlyTheSevenEntries` | sechs Dateien (Binary, XPI, `start.sh`, `README.txt`, `FIREFOX.md`, `CLIENTS.md`) plus Ordner-Eintrag — und nichts sonst (kein `data/`, kein `target/`, keine `.git`) |
| `test/bundle/bundle.test.js` | `bundle_windowsZip_shouldContainTheExeAndTheCmd` | dieselbe Liste mit `.exe` und `start.cmd` |
| `test/bundle/bundle.test.js` | `bundle_shouldNotCarryAToken` | kein Eintrag enthält 32+ Hex-Zeichen; das Token entsteht erst beim Start |
| `test/bundle/bundle.test.js` | `startSh_shouldCreateTheTokenOnceAndKeepIt` | erster Lauf legt `data/token` an (0600, 64 Hex), zweiter Lauf lässt es unverändert; jeder Lauf bindet einen freien Port außerhalb 18110–18119 und wird per PID beendet |
| `test/bundle/bundle.test.js` | `startSh_shouldRefuseATooShortToken` | ein vorhandenes 8-Zeichen-Token führt zu Exit **2** (die Bridge-Regel, nicht eine eigene) |
| `test/bundle/bundle.test.js` | `startSh_shouldNotWriteOutsideItsFolder` | nach dem Lauf ist außerhalb des entpackten Ordners nichts Neues (Sandbox-`HOME`) |
| `test/bundle/bundle.test.js` | `startSh_shouldNotDeriveTheTokenFromTimeOrPid` | zwei frische Ordner ⇒ zwei **verschiedene** Tokens (kein `$RANDOM`, kein `date`) |

## Acceptance criteria

1. **Zwei Zips aus einem Befehl.** `scripts/bundle.sh` ⇒
   `dist/browser-control-<version>-linux-x86_64.zip` und
   `…-windows-x86_64.zip`; `unzip -Z1 <zip> | wc -l` ⇒ **7**: **sechs
   Dateien** (Binary, XPI, `start.sh`, `README.txt`, `FIREFOX.md`, `CLIENTS.md`)
   **plus den Ordner-Eintrag** der obersten Ebene — kein `data/`, keine
   `target/`-Reste, keine `.git`.
2. **Das Binary ist ausführbar im Zip.** `unzip -Z <linux-zip> | grep -cE
   '^-rwxr-xr-x.*browser-control-bridge$'` ⇒ **1**, und für `start.sh` ⇒ **1**.
3. **Kein Geheimnis im Zip.** `unzip -Z1 … | grep -cE '(^|/)data/'` ⇒ 0 und
   `unzip -p … start.sh | grep -acE '[0-9a-f]{32,}'` ⇒ 0.

**Ein Lauf, zwei Beobachtungen.** Vorweg: `export SANDBOX="$(mktemp -d)"`,
dann `mkdir -p "$SANDBOX/home"` und `touch "$SANDBOX/marker"`, dann `sleep 1`
(`find -newer` sieht sonst nichts, was in derselben Sekunde entsteht).

**Kriterien 4 und 5 beobachten den ersten Lauf**, **Kriterium 7 den zweiten**;
`kill $PID` steht jeweils am Ende (4: nicht beenden, 6: vor dem Neustart).

`run.log` liegt fest in `$SANDBOX/run.log`.

4. **Es läuft ohne Installation.** In einem temporären Ordner entpackt, mit
   **freien Ports außerhalb der reservierten Bereiche** — 8110/8111 gehören dem
   Dienst, 18110–18119 den Test-Suiten (`bridge-rs/tests/common/mod.rs`):
   `BC_BIND=127.0.0.1:18130 BC_HTTP_PORT=18131 ./start.sh >
   "$SANDBOX/run.log" 2>&1 & PID=$!` (stdout und stderr zusammen, weil das Skript die drei Zeilen auf
   stdout druckt und die Bridge auf stderr loggt — es enthält das lebende Token
   und liegt deshalb **außerhalb des Baums**); auf die Zeile warten statt
   schlafen: `timeout 20 sh -c 'until grep -q "listening on 127.0.0.1:18130"
   "$SANDBOX/run.log"; do sleep 0.2; done'; echo $?` ⇒ **0**; dann enthält
   `$SANDBOX/run.log`
   (Teilstring, mit Zeitstempel davor) `listening on 127.0.0.1:18130 log=info`
   **und** `listening on 127.0.0.1:18131 for POST /mcp`; `data/token` existiert
   mit 0600 und 64 Zeichen; **ohne** Token ⇒ `curl -s -o /dev/null -w
   '%{http_code}' -X POST http://127.0.0.1:18131/mcp` = `401`; **mit** Token ⇒
   `curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer
   $(cat <ordner>/data/token)" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   http://127.0.0.1:18131/mcp` = `200`. **Nicht beenden** — der Lauf wird bis
   Kriterium 7 gebraucht. Beendet wird per `kill $PID`, **nie** `pkill -f` (das
   trifft den Dienst, `CONTRIBUTING.md`).
5. **Nichts außerhalb des Ordners.** Nach `$SANDBOX` entpackt, startet der Lauf mit
   `HOME="$SANDBOX/home"`; der Ordner wird **vor** dem Marker angelegt. Nachher
   `find "$SANDBOX" -newer "$SANDBOX/marker" -not -path "$SANDBOX/browser-control-*"
   -not -name 'run.log' -not -path "$SANDBOX/home*" -print` ⇒ **leer** — was das
   Skript in seinem eigenen Ordner und in `HOME` anlegt, ist erlaubt. Zusätzlich
   ist die Prüfsumme der echten `~/.config/browser-control/token` vor und nach
   dem Lauf gleich (`sha256sum` beidseitig) — **falls die Datei existiert**;
   fehlt sie (CI-Runner), entfällt der Vergleich und das wird im Lauf notiert. Schreibvorgänge in `/tmp` und
   `XDG_*` sind nicht Vertragsgegenstand.
6. **Das Token überlebt.** Vorher `kill $PID` aus dem ersten Lauf. Kopie von `<ordner>/data/token` sichern, zweiter Start ⇒
   `cmp <kopie> <ordner>/data/token` ⇒ **identisch** (das entscheidet die
   Gleichheit; `grep -c '^token: '` sagt nur, dass die Zeile existiert) und
   `stat -c %a <ordner>/data/token` ⇒ `600`. Danach `kill $PID` (Ende von
   Kriterium 7) — danach läuft kein Prozess aus diesem Test mehr.
7. **Die drei gedruckten Zeilen stimmen mit den Ports.** `grep -c
   '^endpoint: ws://127.0.0.1:18130$' "$SANDBOX/run.log"` ⇒ **1**, `grep -c
   '^http: http://127.0.0.1:18131/mcp$' "$SANDBOX/run.log"` ⇒ **1**, `grep -cE
   '^token: [0-9a-f]{64}$' "$SANDBOX/run.log"` ⇒ **1**. Ein Skript, das 8110 druckt und auf 18130
   lauscht, fällt hier durch — das ist der teuerste Fehler, den das Paket machen
   könnte.
8. **Die Anleitungen liegen im Zip.** `unzip -Z1 <zip> | grep -cE
   '/(FIREFOX|CLIENTS)\.md$'` ⇒ **2**; ihr Inhalt ist `docs/41`.
9. **Beide Zips tragen dieselbe Version**, und die kommt aus **einer** Quelle:
   `extension/manifest.json` (`scripts/package.sh` liest sie dort schon).
   Beweis: `unzip -l dist/browser-control-<v>-linux-x86_64.zip | grep -c
   'browser-control-<v>.xpi'` ⇒ 1, dasselbe für das Windows-Zip, und
   `<v>` = `node -p 'require("./extension/manifest.json").version'`.
10. **Der Rest bleibt grün.** `npm test` ⇒ `# fail 0`, `# cancelled 0`
   (`# skipped` hängt an `zip`/`unzip` auf der Maschine — `test/package.test.js`
   überspringt ohne sie); `npm run check` ⇒ 0; `npm run test:bundle` ⇒
   `# fail 0`;
   Secret-Grep beidseitig Exit 1.
11. **`start.cmd` ist Windows-tauglich.** `unzip -p <win-zip> start.cmd | grep -c
    $'\r'` ⇒ **> 0** (CRLF) und `unzip -p <win-zip> start.cmd | grep -c
    'Get-Random'` ⇒ **0** (CSPRNG, nicht der Zufall der Shell).

## Dev plan

**Stufe 1 — Vorlagen und Startskripte**

Dateien: `deploy/portable/start.sh`, `deploy/portable/start.cmd`,
`deploy/portable/README.txt`, `scripts/bundle.sh` (ein Name für das
Bündel-Skript: `bundle.sh`, nicht „Bundel").

`start.sh` erfüllt den Vertrag oben; `start.cmd` dasselbe für Windows. `bundle.sh`
baut nichts: es nimmt je Ziel ein Binary aus `bridge-rs/target/<ziel>/release/`
oder aus `--binary <ziel>=<pfad>` (zweimal angebbar; für lokale Läufe und fremde
Binaries — in CI liegen sie an ihrem `target`-Pfad) und endet mit Exit 1, wenn
eines fehlt; es ruft
`scripts/package.sh` für die XPI, kopiert die Vorlagen, setzt `0755` auf
`start.sh` **und** auf das Binary (Artefakte aus `upload-artifact` verlieren es,
`zip` schreibt sonst `-rw-r--r--` ins Linux-Zip), schreibt die Zips und prüft den Inhalt gegen die Soll-Liste.

Beweis: `bash scripts/bundle.sh` ⇒ zwei Zips; `unzip -Z1 <zip> | wc -l` ⇒ 7 je
Zip; `bash -n deploy/portable/start.sh` ⇒ 0.

**Kein Schritt für die Anleitungen.** Ihr Text und ihre Prüfung sind
`docs/41-anleitungen.md` (geteilt am 2026-11-17). Diese Spec nimmt die fertigen
Dateien nur ins Zip.

**Reihenfolge über beide Specs:** `docs/41` Stufe 1–2 (die zwei Texte) →
`docs/39` Stufe 1 (`bundle.sh` kopiert sie) → `docs/41` Stufe 3 (Struktur-Tests
gegen das Zip) → `docs/39` Stufe 2 (Zip-Tests) → `docs/39` Stufe 3 (Doku).

**Stufe 2 — Tests**

Dateien: `test/bundle/bundle.test.js` (die sieben Fälle aus `## Testing`),
`package.json` (neues Skript `"test:bundle": "node --test test/bundle/*.test.js"`).

**`npm test` bleibt binary-frei:** die Datei liegt in einem Unterordner, den
`test/*.test.js` nicht erfasst; die CI ruft `npm run test:bundle` im
`bundle`-Job auf (`docs/40`). Wer sie unter `test/` legte, machte die Node-Suite
von einem gebauten Binary abhängig.

Beweis: `npm run test:bundle` ⇒ `# fail 0` (ohne `# skipped 0` — der hängt an
`zip`/`unzip` auf der Maschine).

Die **Startvorlagen und `README.txt`** liegen unter `deploy/portable/`, die
**Anleitungen** unter `docs/portable/`; `bundle.sh` kopiert aus beiden Bäumen.

**Stufe 3 — Doku**

Dateien: `README.md` (ein Absatz „Portable, no installation"), `INSTALL.md`
(Verweis auf das Zip als kürzesten Weg), `docs/README.md` (Status-Zelle),
`docs/PROJECT-STATE.md`, `CHANGELOG.md`.

Beweis: `grep -c 'linux-x86_64.zip' README.md INSTALL.md` ⇒ je ≥ 1; der
Release-Anhang selbst ist `docs/40`.

## Bekannte Lücken

- **Die Erweiterung bleibt temporär.** Nach einem Firefox-Neustart muss der
  Nutzer sie neu laden. Das ist der Preis für „keine Signierung" (Roadmap 23/24;
  die MV3-Migration steht dort als 26–28 **nach** der Signierung, nicht davor).
- **Windows ist gebaut, nicht gelaufen.** `start.cmd` und der `.exe`-Weg sind
  Betreiber-Messungen auf einem Windows-Rechner.
- **`about:debugging` ist Handarbeit.** Kein Skript darf dorthin — die Anleitung
  führt den Nutzer, sie automatisiert nichts.

## Open questions

**Keine.** Sprache (Englisch/STE100), Transport (HTTP) und Client-Liste (pi,
Codex, OpenCode plus generisches Muster) sind am 2026-11-17 vom Betreiber
entschieden.

## Review

### Runden 1–3 (alter Zuschnitt) — 2026-11-17, `grizzled-senior-dev`: 🔧

Acht Blocker: zwei Inkremente in einer Spec (Zip **und** CI); die Bundle-Tests
hätten `npm test` an ein gebautes Binary gebunden; `data/` stand gleichzeitig im
Zip-Baum und im Verbot; das Lint-Kriterium verlangte einen Befund, den der
Linter nicht liefert; dem `bundle`-Job fehlten die Binaries; `npm test` und der
`node`-Job waren unvereinbar; die Release-Credentials fehlten; die
Runde-1-Zeile im Log war rückdatiert.

### Runde 2 — 2026-11-17, `grizzled-senior-dev`: 🔧, Blocker dabei

Fünf Blocker: `## Review` behauptete „steht aus", während der Log keinen der acht
Befunde beantwortete; Kriterium 4 („nichts außerhalb") konnte in einer korrekten
Umsetzung nicht leer werden, weil der entpackte Ordner **in** der Sandbox liegt;
der Release stand in beiden Specs; die Prüfports 18117/18118 lagen im
reservierten Bereich 18110–18119; die drei gedruckten Zeilen wurden von keinem
Kriterium entschieden.

### Runde 3 — 2026-11-17, `grizzled-senior-dev`: 🔧, Blocker dabei

Fünf Blocker, alle Einzeiler: ein `--binary` für zwei Ziele; `<log>` existierte
in keinem Kriterium; Stufe 2 zeigte auf das falsche Kriterium; der „mit
Token"-Aufruf fehlte; `# skipped 0` hing an `zip`/`unzip`. Dazu zwei
Nacharbeiten.

**Folge: geteilt, nicht durchgewinkt** (`CONTRIBUTING.md`, Schritt 4). Die
Anleitungen sind `docs/41-anleitungen.md`, der CI-Ablauf `docs/40-ci-ablauf.md`.
Diese Datei beschreibt seither nur das Zip; die Rundenzählung beginnt mit dem
neuen Zuschnitt neu.

### Runde 1 (neuer Zuschnitt) — 2026-11-17, `grizzled-senior-dev`: 🔧

Sechs Einzeiler: `$SANDBOX/home` fehlte im `find`-Ausschluss; die Kriterien
sagten nicht, wer wann startet und killt; `run.log` hatte zwei Orte; die
Prüfsumme verlangte eine Datei, die es auf CI nicht gibt; die Reihenfolge zu
`docs/41` war nicht entscheidbar; die Rundenzählung widersprach sich.

### Runde 2 (neuer Zuschnitt) — steht aus

## Log

- **2026-11-17, Betreiberentscheid:** Weg **C** — portables Zip mit Server und
  XPI, Erweiterung über `about:debugging`; kein mitgeliefertes Firefox
  (Weg A) und keine Signierung (Weg B) in diesem Inkrement.
- **2026-11-17, Betreiberentscheid:** Anleitungen **Englisch nach STE100** — als
  Schreibregel, **ohne** automatischen Lint (kein `ste-lint` in CI, kein
  Prüfskript im Repo).
- **2026-11-17, Betreiberentscheid:** MCP-Hauptweg ist der **HTTP-Endpunkt**;
  Clients pi, Codex, OpenCode plus ein generisches Muster.
- **Runde 1 — übernommen:** CI abgespalten (`docs/40`); Testdatei nach
  `test/bundle/` mit eigenem Skript `test:bundle`, damit `npm test` binary-frei
  bleibt; `data/` nur noch als Laufzeit-Ordner beschrieben; Lint-Kriterium
  ersetzt (STE100 ist Schreibregel); Binaries per `upload-artifact` im
  `unit`-Job; `--test-threads=1`; `permissions: contents: write` und
  `gh release create` (in `docs/40`). **Nicht** übernommen: eigene
  Release-Spec — der Anhang ist Teil des CI-Inkrements.
- **Runde 1 (neuer Zuschnitt) — übernommen:** `$SANDBOX/home` wird vor dem
  Marker angelegt und im `find` ausgeschlossen; ein beobachteter Lauf (Start in
  Kriterium 4, `kill` am Ende von 7, Kriterium 6 = zweiter Start); `run.log`
  liegt fest in `$SANDBOX/run.log`; Prüfsummen-Vergleich nur „falls vorhanden";
  die Reihenfolge über beide Specs steht ausgeschrieben; die Rundenzählung ist
  getrennt (alt 1–3, neu ab 1).
- **Runde 3 — übernommen, dann geteilt:** `--binary <ziel>=<pfad>` (zweimal
  angebbar); `run.log` als feste Logdatei in den Kriterien 3, 5 und 6; der
  „mit Token"-Aufruf ausgeschrieben; Stufe-1-Beweis mit `unzip -Z1 | wc -l`;
  `# skipped` nicht mehr gepinnt (hängt an `zip`/`unzip`); Kriterium 4 nennt den
  Entpackort. **Geteilt:** Anleitungen → `docs/41`, CI → `docs/40`.
- **Runde 2 — übernommen:** Review-Runden mit Datum und Verdict eingetragen;
  Kriterium 4 schließt den entpackten Ordner und `run.log` aus und setzt
  `HOME="$SANDBOX/home"`; Release aus Ziel und Stufe 4 entfernt (zeigt auf
  `docs/40`); Prüfports 18130/18131 außerhalb 18110–18119; Kriterium 6 prüft die
  drei gedruckten Zeilen gegen die laufenden Ports; `unzip -Z1 | wc -l` statt
  `unzip -l`; Kriterium 5 killt vorher und nennt den Tokenpfad; `start.cmd` hat
  ein Kriterium (CRLF, kein `Get-Random`); `bundle.sh --binary <pfad>`;
  pi-Eintrag mit `mcpServers`-Hülle; Wildcard-Adressen werden als `127.0.0.1`
  gedruckt; ein Satz zu den zwei Quellordnern; Tippfehler behoben.
