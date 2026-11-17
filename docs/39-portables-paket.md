---
description: Ein portables Zip — Server-Binary, XPI und zwei Anleitungen (Firefox, MCP-Clients) in Englisch nach STE100; entpacken, starten, fertig, ohne Installation, ohne Root, ohne Dienst.
status: proposed
---

# Das portable Paket

Heute braucht ein neuer Nutzer einen Klon, eine Rust-Toolchain, `cargo build` und
`./scripts/install.sh` — und danach vier Handgriffe in Firefox, die niemand
errät. Diese Spec macht daraus: **Zip herunterladen, entpacken, Anleitung
lesen.** Kein Compiler, kein Root, kein Dienst, kein systemd.

**Was sie nicht tut:** die Erweiterung signieren (Roadmap 23/24), Firefox
mitliefern, sich als Dienst einrichten, ein Token vorab in ein Firefox-Profil
schreiben. Die Erweiterung wird weiterhin über `about:debugging` geladen und ist
nach einem Firefox-Neustart weg — das ist die Grenze dieses Pakets und steht in
der Anleitung.

## Ziel

- **Ein Zip je Plattform**, beide aus demselben Bau: `browser-control-<version>-linux-x86_64.zip`
  und `browser-control-<version>-windows-x86_64.zip`.
- **Alles liegt im entpackten Ordner.** Das Token entsteht beim ersten Start in
  `./data/token`; geschrieben wird nichts außerhalb des Ordners — kein
  `~/.local/bin`, keine Unit, kein `~/.config`.
- **Zwei Anleitungen, Englisch nach ASD-STE100**, geprüft mit dem Linter
  (`~/ste-lint`, Schwelle **90**): eine für Firefox, eine für die MCP-Clients
  (pi, Codex, OpenCode plus ein generisches Muster). Der Nutzer muss danach
  nichts weiter wissen als das, was dort steht.
- **Die Anleitungen haben eine Quelle.** Sie liegen im Repo und werden vom
  Bündel-Skript ins Zip kopiert — keine zwei Fassungen, die auseinanderlaufen.
- **Der Release hängt die Zips an.** Ein Tag `v*` baut beide und legt sie ans
  GitHub-Release; ohne das wäre „Release herunterladen" eine Behauptung.

## Non-goals

- **Keine Signierung, kein AMO.** Die XPI bleibt unsigniert; sie funktioniert in
  Firefox über `about:debugging` (temporär) und in der Developer Edition, Nightly
  oder ESR mit `xpinstall.signatures.required=false`.
- **Kein mitgeliefertes Firefox.** Kein ESR im Zip, keine `policies.json`.
- **Kein Dienst, kein Autostart.** Wer das will, nimmt `scripts/install.sh`.
- **Kein Token im Zip.** Es entsteht beim ersten Start; ein verteiltes Token wäre
  in jedem Download derselbe Schlüssel.
- **Kein Signieren des Binaries, keine Installer (`.deb`, `.msi`).**

## Der Inhalt des Zip

```
browser-control-<version>-linux-x86_64/
  browser-control-bridge          das statisch gelinkte Binary (musl)
  browser-control-<version>.xpi   die unsignierte Erweiterung
  start.sh                        Token anlegen (einmalig), Endpunkt zeigen, starten
  README.txt                      vier Sätze: was das ist, was zu tun ist, wo die zwei Anleitungen liegen
  FIREFOX.md                      Anleitung Erweiterung (Englisch, STE100)
  CLIENTS.md                      Anleitung MCP-Clients (Englisch, STE100)
  data/                           entsteht beim ersten Start; enthält nur `token` (0600)
```

Windows: `browser-control-bridge.exe` und `start.cmd` statt der Linux-Pendants,
sonst gleich.

**`start.sh` — Vertrag:**

1. `data/` anlegen, falls es fehlt.
2. `data/token` anlegen, **nur wenn es fehlt**: 32 zufällige Bytes als 64
   Hex-Zeichen, `chmod 600`. Ein vorhandenes Token wird **nie** überschrieben —
   sonst wäre jeder Neustart ein Logout der Erweiterung.
3. `BC_TOKEN_FILE` auf `data/token` setzen, `BC_BIND`/`BC_HTTP_PORT` aus der
   Umgebung durchlassen (Vorgaben `127.0.0.1:8110`/`8111`).
4. Endpunkt und Token **einmal** auf stdout zeigen (der Nutzer muss sie in
   Firefox und im Client eintragen), danach `exec` auf das Binary mit `--http`.
   Kein `nohup`, keine PID-Datei: das Skript ist der Prozess, Strg+C beendet ihn.

**`start.cmd` — derselbe Vertrag** für Windows (Token über `certutil` oder
PowerShell, kein WSL).

## Die zwei Anleitungen

Beide **Englisch**, **ASD-STE100**: nummerierte Schritte, Befehlsform, höchstens
20 Wörter je Anweisung, ein Name je Sache, Warnung **vor** dem Schritt. Sie
liegen im Repo unter `docs/portable/` und werden ins Zip kopiert.

**`FIREFOX.md` — was drinstehen muss:**

1. Firefox starten.
2. `about:debugging#/runtime/this-firefox` öffnen.
3. „Load Temporary Add-on…" wählen und **die XPI-Datei** auswählen.
4. Die Einstellungen der Erweiterung öffnen, Endpunkt `ws://127.0.0.1:8110` und
   das Token aus dem Startfenster eintragen, speichern.
5. Die Erweiterung in `about:debugging` einmal neu laden.
6. Warnung: die Erweiterung ist **temporär** und nach einem Firefox-Neustart
   weg — Schritt 3 wiederholen. (Der Endpunkt und das Token bleiben gespeichert.)

**`CLIENTS.md` — was drinstehen muss:**

1. Der Server läuft (`start.sh`), der Endpunkt ist `http://127.0.0.1:8111/mcp`,
   das Token steht in `data/token`.
2. **pi** — Eintrag in `~/.pi/agent/mcp.json`:
   `url` = der Endpunkt, `headers.Authorization` = `!echo Bearer $(cat <pfad>/data/token)`
   (der `!`-Wert liest das Token beim Start, statt es in die Datei zu schreiben).
3. **Codex** — `codex mcp add browser-control --url http://127.0.0.1:8111/mcp --bearer-token-env-var BC_TOKEN`,
   dazu die Zeile, die `BC_TOKEN` in der Shell setzt.
4. **OpenCode** — `opencode mcp add browser-control --url http://127.0.0.1:8111/mcp --header "Authorization=Bearer <token>"`,
   mit dem Hinweis, dass dieser Client das Token in seiner Konfiguration ablegt.
5. **Generisches Muster** — ein JSON- und ein TOML-Ausschnitt für Clients, die
   hier nicht genannt sind (Server-URL, Kopfzeile `Authorization: Bearer …`).
6. Ein Schlusssatz: dasselbe Token gilt für Firefox **und** den Client.

## Dependency changes

**Keine.** Das Zip enthält nur, was schon gebaut wird (`bridge-rs`, die XPI aus
`scripts/package.sh`). Der Linter ist ein **Prüfwerkzeug**, keine
Produktabhängigkeit: `~/ste-lint` (MIT, lokal installiert, Node ≥ 20), im Repo
erreichbar über `scripts/ste-lint.mjs` mit `STE_LINT_DIR` als Überschreibung.
Fehlt das Werkzeug, endet die Prüfung mit Exit **2** — sie darf nicht still
übersprungen werden.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/bundle.test.js` | `bundle_linuxZip_shouldContainExactlyTheSevenEntries` | Binary, XPI, `start.sh`, `README.txt`, `FIREFOX.md`, `CLIENTS.md` — und nichts sonst (kein `data/`, kein `target/`, keine `.git`) |
| `test/bundle.test.js` | `bundle_windowsZip_shouldContainTheExeAndTheCmd` | dieselbe Liste mit `.exe` und `start.cmd` |
| `test/bundle.test.js` | `bundle_shouldNotCarryAToken` | kein Eintrag enthält 32+ Hex-Zeichen; das Token entsteht erst beim Start |
| `test/bundle.test.js` | `startSh_shouldCreateTheTokenOnceAndKeepIt` | erster Lauf legt `data/token` an (0600, 64 Hex), zweiter Lauf lässt es unverändert |
| `test/bundle.test.js` | `startSh_shouldRefuseATooShortToken` | ein vorhandenes 8-Zeichen-Token führt zu Exit **2** (die Bridge-Regel, nicht eine eigene) |
| `test/bundle.test.js` | `startSh_shouldNotWriteOutsideItsFolder` | nach dem Lauf ist außerhalb des entpackten Ordners nichts Neues (Sandbox-`HOME`) |
| `scripts/ste-lint.mjs` (Prüflauf) | `FIREFOX.md`, `CLIENTS.md` ⇒ Score ≥ 90, `language: en` | die Anleitungen sind STE100, nicht nur behauptet |
| `test/bundle.test.js` | `guides_shouldPassTheSteLintThreshold` | ruft denselben Prüfer auf; fehlt `~/ste-lint`, ist der Fall **übersprungen mit Exit 2**, nicht grün |

## Acceptance criteria

1. **Zwei Zips aus einem Befehl.** `scripts/bundle.sh` ⇒
   `dist/browser-control-<version>-linux-x86_64.zip` und
   `…-windows-x86_64.zip`; `unzip -l` zeigt je **sieben** Einträge (sechs
   Dateien plus Ordner), keine `target/`-Reste, keine `.git`.
2. **Kein Geheimnis im Zip.** `unzip -l … | grep -c 'data/'` ⇒ 0 und
   `unzip -p … start.sh | grep -cE '[0-9a-f]{32,}'` ⇒ 0.
3. **Es läuft ohne Installation.** In einem temporären Ordner entpackt:
   `./start.sh` ⇒ Log zeigt `listening on 127.0.0.1:8110 log=info` **und**
   `listening on 127.0.0.1:8111 for POST /mcp`; `data/token` existiert mit 0600
   und 64 Zeichen; `curl -s -o /dev/null -w '%{http_code}' -X POST
   http://127.0.0.1:8111/mcp` ⇒ `401` (ohne Token) bzw. `200` (mit Token).
4. **Nichts außerhalb des Ordners.** Nach dem Lauf ist in einem Sandbox-`HOME`
   nichts entstanden (`find "$SANDBOX" -newer …` ⇒ leer), und der echte
   `~/.config/browser-control/` bleibt unberührt.
5. **Das Token überlebt.** Zweiter Start ⇒ dieselbe Token-Zeile, `cmp` auf die
   Datei ⇒ identisch; `stat -c %a` ⇒ `600`.
6. **Die Anleitungen sind STE100.** `node scripts/ste-lint.mjs
   docs/portable/FIREFOX.md docs/portable/CLIENTS.md --language en` ⇒ Score ≥ 90
   je Datei, keine `procedural`-Befunde; fehlt der Linter, Exit **2**.
7. **Der Release hängt sie an.** `.github/workflows/release.yml` baut bei einem
   Tag `v*` beide Zips und lädt sie ans Release (`gh release upload` mit
   `GITHUB_TOKEN`); der Workflow läuft `scripts/bundle.sh`, nicht eine zweite
   Bauanleitung.
8. **Der Rest bleibt grün.** `npm test` ⇒ `# fail 0`, `# cancelled 0`,
   `# skipped 0`; `npm run check` ⇒ 0; `scripts/parity.sh --impl rust --check`
   ⇒ 7/7, Exit 0; Secret-Grep beidseitig Exit 1.

## Dev plan

**Stufe 1 — Vorlagen und Startskripte**

Dateien: `deploy/portable/start.sh`, `deploy/portable/start.cmd`,
`deploy/portable/README.txt`, `scripts/bundle.sh`.

`start.sh` erfüllt den Vertrag oben; `start.cmd` dasselbe für Windows. `bundle.sh`
baut nichts (das Binary muss gebaut sein, sonst Exit 1 mit dem Befehl), ruft
`scripts/package.sh` für die XPI, kopiert die Vorlagen, setzt `0755` auf
`start.sh`, schreibt die Zips und prüft den Inhalt gegen die Soll-Liste.

Beweis: `bash scripts/bundle.sh` ⇒ zwei Zips; `unzip -l` zeigt die Soll-Liste;
`bash -n deploy/portable/start.sh` ⇒ 0.

**Stufe 2 — Die zwei Anleitungen**

Dateien: `docs/portable/FIREFOX.md`, `docs/portable/CLIENTS.md`,
`scripts/ste-lint.mjs`.

Inhalt nach dem Abschnitt oben, Englisch, STE100. `scripts/ste-lint.mjs` importiert
`${STE_LINT_DIR:-$HOME/ste-lint}/src/index.js` und gibt je Datei Score und Befunde
aus; Exit 2 ohne Linter, Exit 1 unter der Schwelle.

Beweis: `node scripts/ste-lint.mjs docs/portable/*.md --language en` ⇒ Score ≥ 90.

**Stufe 3 — Tests**

Dateien: `test/bundle.test.js` (die sieben Fälle aus `## Testing`), `package.json`
(Testdatei ist über `test/*.test.js` schon erfasst).

Beweis: `node --test --test-reporter=tap test/bundle.test.js` ⇒ `# fail 0`.

**Stufe 4 — Release und Doku**

Dateien: `.github/workflows/release.yml`, `README.md` (ein Absatz „Portable, no
installation"), `INSTALL.md` (Verweis auf das Zip als kürzesten Weg),
`docs/README.md` (Status-Zelle), `docs/PROJECT-STATE.md`, `CHANGELOG.md`.

Beweis: Workflow-Datei vorhanden und `act -j bundle` **oder** der Betreiber-Tag;
`grep -c 'browser-control-.*-linux-x86_64.zip' .github/workflows/release.yml` ⇒ 1.

## Bekannte Lücken

- **Die Erweiterung bleibt temporär.** Nach einem Firefox-Neustart muss der
  Nutzer sie neu laden. Das ist der Preis für „keine Signierung" (Roadmap 23/24,
  die MV3 voraussetzt).
- **Windows ist gebaut, nicht gelaufen.** `start.cmd` und der `.exe`-Weg sind
  Betreiber-Messungen auf einem Windows-Rechner.
- **`about:debugging` ist Handarbeit.** Kein Skript darf dorthin — die Anleitung
  führt den Nutzer, sie automatisiert nichts.

## Open questions

**Keine.** Sprache (Englisch/STE100), Transport (HTTP) und Client-Liste (pi,
Codex, OpenCode plus generisches Muster) sind am 2026-11-17 vom Betreiber
entschieden.

## Review

### Runde 1 — steht aus

## Log

- **2026-11-17, Betreiberentscheid:** Weg **C** — portables Zip mit Server und
  XPI, Erweiterung über `about:debugging`; kein mitgeliefertes Firefox
  (Weg A) und keine Signierung (Weg B) in diesem Inkrement.
- **2026-11-17, Betreiberentscheid:** Anleitungen **Englisch nach STE100**,
  geprüft mit `~/ste-lint`, Schwelle 90.
- **2026-11-17, Betreiberentscheid:** MCP-Hauptweg ist der **HTTP-Endpunkt**;
  Clients pi, Codex, OpenCode plus ein generisches Muster.
