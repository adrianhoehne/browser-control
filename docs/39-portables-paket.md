---
description: Ein portables Zip — Server-Binary, XPI und zwei Anleitungen (Firefox, MCP-Clients) in Englisch nach STE100; entpacken, starten, fertig, ohne Installation, ohne Root, ohne Dienst.
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

   (Ports aus `BC_BIND`/`BC_HTTP_PORT`, sichtbar als das, was gilt.) Danach
   `exec` auf das Binary mit `--http`. Kein `nohup`, keine PID-Datei: das Skript
   ist der Prozess, Strg+C beendet ihn.

**`start.cmd` — derselbe Vertrag** für Windows, **ohne WSL**, mit **CRLF**-
Zeilenenden (auf Linux gebaut wäre das Zip sonst LF, und `cmd.exe` stolpert).
Token aus einem CSPRNG, nicht aus `Get-Random`:
`[System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)` → Hex →
`data\token`.

## Die zwei Anleitungen

Beide **Englisch**, **ASD-STE100**: nummerierte Schritte, Befehlsform, höchstens
20 Wörter je Anweisung, ein Name je Sache, Warnung **vor** dem Schritt. Sie
liegen im Repo unter `docs/portable/` (kein `NN-`-Präfix und kein Frontmatter: es
sind Nutzertexte, keine Specs — `docs/README.md` regelt Spec-Dateien,
`scripts/check.mjs` prüft nur Code) und werden ins Zip kopiert.

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

## Abgrenzung

Der **CI-Ablauf** (Jobs, lokaler Nachbau, Release-Anhang) steht in
`docs/40-ci-ablauf.md`. Diese Spec liefert das Zip und die Anleitungen. `docs/40`
prüft und veröffentlicht sie. Zwei Inkremente, zwei Specs (`CONTRIBUTING.md`).

## Dependency changes

**Keine.** Das Zip enthält nur, was schon gebaut wird: `bridge-rs` und die XPI
aus `scripts/package.sh`.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/bundle/bundle.test.js` | `bundle_linuxZip_shouldContainExactlyTheSevenEntries` | sechs Dateien (Binary, XPI, `start.sh`, `README.txt`, `FIREFOX.md`, `CLIENTS.md`) plus Ordner-Eintrag — und nichts sonst (kein `data/`, kein `target/`, keine `.git`) |
| `test/bundle/bundle.test.js` | `bundle_windowsZip_shouldContainTheExeAndTheCmd` | dieselbe Liste mit `.exe` und `start.cmd` |
| `test/bundle/bundle.test.js` | `bundle_shouldNotCarryAToken` | kein Eintrag enthält 32+ Hex-Zeichen; das Token entsteht erst beim Start |
| `test/bundle/bundle.test.js` | `startSh_shouldCreateTheTokenOnceAndKeepIt` | erster Lauf legt `data/token` an (0600, 64 Hex), zweiter Lauf lässt es unverändert |
| `test/bundle/bundle.test.js` | `startSh_shouldRefuseATooShortToken` | ein vorhandenes 8-Zeichen-Token führt zu Exit **2** (die Bridge-Regel, nicht eine eigene) |
| `test/bundle/bundle.test.js` | `startSh_shouldNotWriteOutsideItsFolder` | nach dem Lauf ist außerhalb des entpackten Ordners nichts Neues (Sandbox-`HOME`) |
| `test/bundle/bundle.test.js` | `startSh_shouldNotDeriveTheTokenFromTimeOrPid` | zwei frische Ordner ⇒ zwei **verschiedene** Tokens (kein `$RANDOM`, kein `date`) |

## Acceptance criteria

1. **Zwei Zips aus einem Befehl.** `scripts/bundle.sh` ⇒
   `dist/browser-control-<version>-linux-x86_64.zip` und
   `…-windows-x86_64.zip`; `unzip -l` zeigt je **sieben** Einträge: **sechs
   Dateien** (Binary, XPI, `start.sh`, `README.txt`, `FIREFOX.md`, `CLIENTS.md`)
   **plus den Ordner-Eintrag** der obersten Ebene — kein `data/`, keine
   `target/`-Reste, keine `.git`.
2. **Kein Geheimnis im Zip.** `unzip -Z1 … | grep -cE '(^|/)data/'` ⇒ 0 und
   `unzip -p … start.sh | grep -acE '[0-9a-f]{32,}'` ⇒ 0.
3. **Es läuft ohne Installation.** In einem temporären Ordner entpackt, mit
   **freien Ports** (auf dem Betreiber-Rechner gehören 8110/8111 dem Dienst):
   `BC_BIND=127.0.0.1:18117 BC_HTTP_PORT=18118 ./start.sh & PID=$!` ⇒ das Log
   enthält (Teilstring, mit Zeitstempel davor) `listening on 127.0.0.1:18117
   log=info` **und** `listening on 127.0.0.1:18118 for POST /mcp`; `data/token`
   existiert mit 0600 und 64 Zeichen; `curl -s -o /dev/null -w '%{http_code}'
   -X POST http://127.0.0.1:18118/mcp` ⇒ `401` (ohne Token) bzw. `200` (mit
   Token). **Beenden: `kill $PID`** — niemals `pkill -f`, das trifft den Dienst
   (`CONTRIBUTING.md`).
4. **Nichts außerhalb des Ordners.** Vor dem Lauf eine Marker-Datei anlegen
   (`touch "$SANDBOX/marker"`), nach dem Lauf `find "$SANDBOX" -newer
   "$SANDBOX/marker" -print` ⇒ leer; und die Prüfsumme der echten
   `~/.config/browser-control/token` ist vor und nach dem Lauf gleich
   (`sha256sum` beideausgeben, vergleichen). Schreibvorgänge in `/tmp` und
   `XDG_*` sind nicht Vertragsgegenstand.
5. **Das Token überlebt.** Zweiter Start ⇒ `grep -c '^token: '` liefert dieselben
   64 Zeichen wie beim ersten (Vergleich über die Datei), `cmp` auf eine Kopie
   ⇒ identisch; `stat -c %a` ⇒ `600`.
6. **Die Anleitungen sind vollständig.** Beweis (Struktur, nicht Stil):
   `grep -c '^1\.' docs/portable/FIREFOX.md docs/portable/CLIENTS.md` ⇒ je **1**
   (jede Anleitung beginnt mit Schritt 1), und `grep -c '^[0-9]\+\. ' …` ⇒ je
   **≥ 5**. Die Regeln selbst prüft niemand automatisch.
7. **Beide Zips tragen dieselbe Version**, und die kommt aus **einer** Quelle:
   `extension/manifest.json` (`scripts/package.sh` liest sie dort schon).
   Beweis: `unzip -l dist/browser-control-<v>-linux-x86_64.zip | grep -c
   'browser-control-<v>.xpi'` ⇒ 1, dasselbe für das Windows-Zip, und
   `<v>` = `node -p 'require("./extension/manifest.json").version'`.
8. **Der Rest bleibt grün.** `npm test` ⇒ `# fail 0`, `# cancelled 0`,
   `# skipped 0`; `npm run check` ⇒ 0; `scripts/parity.sh --impl rust --check`
   ⇒ 7/7, Exit 0; Secret-Grep beidseitig Exit 1.

## Dev plan

**Stufe 1 — Vorlagen und Startskripte**

Dateien: `deploy/portable/start.sh`, `deploy/portable/start.cmd`,
`deploy/portable/README.txt`, `scripts/bundle.sh` (ein Name für das
Bündel-Skript: `bundle.sh`, nicht „Bundel").

`start.sh` erfüllt den Vertrag oben; `start.cmd` dasselbe für Windows. `bundle.sh`
baut nichts (das Binary muss gebaut sein, sonst Exit 1 mit dem Befehl), ruft
`scripts/package.sh` für die XPI, kopiert die Vorlagen, setzt `0755` auf
`start.sh`, schreibt die Zips und prüft den Inhalt gegen die Soll-Liste.

Beweis: `bash scripts/bundle.sh` ⇒ zwei Zips; `unzip -l` zeigt die Soll-Liste;
`bash -n deploy/portable/start.sh` ⇒ 0.

**Stufe 2 — Die zwei Anleitungen**

Dateien: `docs/portable/FIREFOX.md`, `docs/portable/CLIENTS.md`.

Inhalt nach dem Abschnitt oben, Englisch, STE100 — als Schreibregel, ohne
Prüfskript.

Beweis: Kriterium 6 (Struktur) und ein Probelauf durch den Betreiber: Zip
entpacken, Anleitung abarbeiten, Seite öffnen.

**Stufe 3 — Tests**

Dateien: `test/bundle/bundle.test.js` (die sieben Fälle aus `## Testing`),
`package.json` (neues Skript `"test:bundle": "node --test test/bundle/*.test.js"`).

**`npm test` bleibt binary-frei:** die Datei liegt in einem Unterordner, den
`test/*.test.js` nicht erfasst; die CI ruft `npm run test:bundle` im
`bundle`-Job auf (`docs/40`). Wer sie unter `test/` legte, machte die Node-Suite
von einem gebauten Binary abhängig.

Beweis: `npm run test:bundle` ⇒ `# fail 0`, `# skipped 0`.

**Stufe 4 — Release-Anhang und Doku**

Dateien: `.github/workflows/release.yml` (Job `release` bei Tag `v*`, Details in
`docs/40-ci-ablauf.md`), `README.md` (ein Absatz „Portable, no installation"),
`INSTALL.md` (Verweis auf das Zip als kürzesten Weg), `docs/README.md`
(Status-Zelle), `docs/PROJECT-STATE.md`, `CHANGELOG.md`.

Beweis: der Betreiber-Push mit Tag zeigt die Zips am Release — der einzige
Beweis, den niemand lokal führen kann; lokal prüft `docs/40` den Rest.

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

### Runde 1 — steht aus

## Log

- **2026-11-17, Betreiberentscheid:** Weg **C** — portables Zip mit Server und
  XPI, Erweiterung über `about:debugging`; kein mitgeliefertes Firefox
  (Weg A) und keine Signierung (Weg B) in diesem Inkrement.
- **2026-11-17, Betreiberentscheid:** Anleitungen **Englisch nach STE100** — als
  Schreibregel, **ohne** automatischen Lint (kein `ste-lint` in CI, kein
  Prüfskript im Repo).
- **2026-11-17, Betreiberentscheid:** MCP-Hauptweg ist der **HTTP-Endpunkt**;
  Clients pi, Codex, OpenCode plus ein generisches Muster.
