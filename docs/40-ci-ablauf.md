---
description: Der Ablauf in GitHub Actions — Unit-Tests ohne Browser, ein Blackbox-Test auf Windows, der Firefox startet, die XPI installiert und über MCP eine Seite öffnet, dazu Zip-Bau und Release.
status: proposed
---

# Der Ablauf in CI

**Befund 2026-11-17:** `.github/workflows/test.yml` läuft `npm run check` und
`npm test` auf Node 22 und 24 — sonst nichts. Kein `cargo`, kein
`scripts/parity.sh`, keine Installation. Seit dem Schnitt (`docs/38`) sagt der
grüne Haken also nichts über die Bridge, die tatsächlich läuft.

Diese Spec teilt die Prüfung in zwei ungleiche Hälften:

- **Unit-Tests** — schnell, ohne Browser, bei jedem Push. Sie prüfen den Code.
- **Ein Blackbox-Workflow** — auf Windows, mit echtem Firefox. Er prüft die
  Installation von außen: Firefox starten, XPI installieren, über MCP eine Seite
  öffnen, und **die Seite selbst** meldet sich beim Testserver.

Dazu kommen Zip-Bau und Release-Anhang für `docs/39`.

**Was sie nicht tut:** keinen Stil-Lint (STE100 ist Schreibregel, kein
Prüfschritt), keine Windows-Dienst-Prüfung, keinen Cache, keine
Branch-Protection.

## Ziel

- **`unit`-Job, browserfrei:** `npm run check`, `npm test`, `cargo test
  -- --test-threads=1`, `cargo clippy --all-targets -- -D warnings` (beide
  Ziele), `scripts/parity.sh --impl rust --check` ⇒ 7/7, `--self-test` ⇒ 7/7 rot.
- **`e2e`-Job, Windows, Blackbox:** die Kette aus `## Der E2E-Ablauf` läuft und
  endet mit dem Beacon-Treffer. Das ist der Beweis „eine Seite wurde in Firefox
  geöffnet".
- **`bundle`-Job:** baut die zwei Zips aus `docs/39` und lädt sie als Artefakt.
- **`release`-Job:** nur bei Tag `v*`, hängt beide Zips an das GitHub-Release.
- **Lokal nachbaubar:** `scripts/ci-local.sh` fährt `unit` und `bundle`; den
  E2E fährt `scripts/e2e/run.mjs` — auf Linux mit demselben Ablauf, den CI auf
  Windows nimmt.

## Non-goals

- **Kein Stil-Lint.** Kein `ste-lint`, kein `actionlint`-Zwang, keine
  Schwellenprüfung für Prosa.
- **Kein Windows-Dienst.** Task Scheduler, Autostart und `GetFileType` bleiben
  Betreiber-Messungen (`docs/38`, Stufe 3).
- **Kein Cache, keine Branch-Protection, kein `act`.**
- **Kein Signieren** der XPI — der E2E nutzt eine **Test-XPI** (siehe unten).

## Der E2E-Ablauf

Der Ablauf ist am 2026-11-17 **lokal gemessen** (Linux, Firefox 152, Rust-Bridge
auf 18810/18811):

```
Installed /tmp/e2e/ext as a temporary add-on
extension connected peer=127.0.0.1 protocol=1     (4 s nach dem Start)
open tab=2 url=http://127.0.0.1:18990/page
PING 2026-11-17T15:15:48.205Z                     (die Seite selbst)
```

Die Schritte, in dieser Reihenfolge:

1. **Bridge-Binary bereitstellen.** Im `e2e`-Job das Artefakt aus dem
   `rust`-Job (`x86_64-pc-windows-gnu`, `--release`), damit geprüft wird, was
   ausgeliefert wird.
2. **Token erzeugen** (32 Bytes Zufall, 64 Hex) in eine Datei; `BC_TOKEN_FILE`
   darauf zeigen.
3. **Test-XPI bauen:** `extension/` in ein Temp-Verzeichnis kopieren und **zwei
   Zeilen** patchen — der Endpunkt (`ws://127.0.0.1:18810`) und das Token als
   Rückfallwert. Beide Patches werden **gezählt** (`grep -c` ⇒ genau 1); findet
   ein Patch seine Zeile nicht, endet der Test mit „seam moved" und Exit 1.
   Die ausgelieferte Erweiterung bleibt unverändert.
4. **Bridge starten:** `BC_BIND=127.0.0.1:18810 BC_HTTP_PORT=18811
   browser-control-bridge --http`, Ausgabe in eine Logdatei.
5. **Beacon-Server starten** (Node, Port 18990): liefert `/page` mit einem
   eingebetteten `fetch("/ping")` und merkt sich den Treffer.
6. **Firefox starten** mit der Test-XPI: `npx web-ext@8.9.0 run --source-dir
   <temp> --firefox <pfad> --arg=-headless --no-reload --no-input`. Das ist
   derselbe Weg wie „Load Temporary Add-on" — nur ohne Klick.
7. **Warten auf `extension connected`** in der Bridge-Logdatei, Deckel 60 s.
8. **Über MCP eine Seite öffnen:** `POST http://127.0.0.1:18811/mcp` mit
   `tools/call` → `browser_open_tab` und `{"url":"http://127.0.0.1:18990/page"}`.
9. **Auf den Beacon warten**, Deckel 30 s. **Das ist der Beweis:** die Bridge
   könnte lügen, die geladene Seite nicht.
10. **Aufräumen per PID** (`kill $PID`), auch im Fehlerfall. **Niemals
    `pkill -f`** — der Betreiber-Dienst hat dieselbe Kommandozeile, und genau
    das hat am 17.11. den Dienst zweimal beendet (einmal durch einen Agenten,
    einmal durch den Orchestrator selbst).

**Warum der Patch und kein Klick:** die Erweiterung liest Endpunkt und Token nur
aus `storage.local`; `about:debugging` lässt sich nicht per Skript bedienen.
`web-ext` installiert die Erweiterung temporär — genau das, was der Knopf tut —
und der Patch ersetzt die zwei Werte, die sonst jemand eintippen müsste.
Gemessen: ohne den Endpunkt-Patch verbindet sie sich nach `ws://127.0.0.1:8110`
und der Test scheitert mit `auth failed` am Betreiber-Dienst.

**Ports und Fristen im E2E:**

| Was | Wert |
|---|---|
| Extension-Port | `18810` (nicht 8110 — dort läuft der Dienst des Betreibers) |
| `/mcp` | `18811` |
| Beacon | `18990` |
| Verbinden | Deckel 60 s, dann Abbruch |
| Beacon | Deckel 30 s, dann Abbruch |
| `web-ext` | gepinnt `8.9.0`, Start ~4 s |

## Die Jobs

| Job | Läuft auf | Schritte |
|---|---|---|
| `node` | `ubuntu-latest`, Matrix 22/24 | checkout, setup-node, `npm run check`, `npm test` — unverändert, ohne Rust |
| `unit` | `ubuntu-latest` | checkout, Node (für `parity.sh`), rustup (stable, Ziele `x86_64-unknown-linux-musl` + `x86_64-pc-windows-gnu`, Teil `clippy`), `gcc-mingw-w64-x86-64`, `cargo build --release` (beide Ziele), `cargo test -- --test-threads=1`, `clippy -D warnings --all-targets` (beide Ziele), `parity.sh --impl rust --check`, `parity.sh --self-test`, Binaries als Artefakt |
| `e2e` | `windows-latest`, braucht `unit` | checkout, Node (für `web-ext` und den Beacon), `download-artifact` (die `.exe`), `node scripts/e2e/run.mjs` — der Ablauf oben |
| `bundle` | `ubuntu-latest`, braucht `unit` | checkout, `download-artifact`, `scripts/bundle.sh`, `npm run test:bundle`, Zips als Artefakt |
| `release` | nur Tag `v*`, braucht `bundle` | `download-artifact`, `permissions: contents: write`, `GH_TOKEN`, `gh release create "$GITHUB_REF_NAME" dist/*.zip --generate-notes --clobber` |

**Vier Zeilen, die man sonst vergisst:**

1. **`--release`** überall: `parity.sh` sucht `…/target/<ziel>/release/…`; ein
   Debug-Build lässt den Lauf mit „rust binary missing" stehen.
2. **Artefakt-Upload/-Download** zwischen `unit` → `e2e` und `unit` → `bundle`.
   `bundle.sh` und der E2E bauen nichts selbst.
3. **`--test-threads=1`** beim Rust-Test: echte Bridges binden Ports.
4. **`permissions: contents: write`** im `release`-Job: der Default-Token ist
   `read`, `gh release create` scheitert mit 403.

## Lokal nachbauen

`scripts/ci-local.sh` fährt `unit` und `bundle`:

```
cargo build --release --target x86_64-unknown-linux-musl / -windows-gnu
cargo test -- --test-threads=1
cargo clippy --all-targets -- -D warnings            (beide Ziele)
bash scripts/parity.sh --impl rust --check
bash scripts/parity.sh --self-test
bash scripts/bundle.sh
npm run test:bundle
→ "ci-local: alle Schritte grün"
```

`node scripts/e2e/run.mjs` fährt den Blackbox-Ablauf; er nimmt Firefox und das
Binary aus der Umgebung (`E2E_FIREFOX`, `E2E_BINARY`) und funktioniert auf Linux
wie auf Windows. `--keep` lässt die Prozesse stehen, `--windows` setzt die
Windows-Pfade.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/ci/workflow.test.js` | `workflow_unitJob_shouldBuildBothTargetsInRelease` | die YAML enthält `--release` und beide Ziele, gefunden über `run:`-Zeilen (ein Kommentar erfüllt das nicht) |
| `test/ci/workflow.test.js` | `workflow_e2eJob_shouldRunOnWindowsAndUseTheScript` | `runs-on: windows-latest` und ein `run:` mit `scripts/e2e/run.mjs` |
| `test/ci/workflow.test.js` | `workflow_e2eJob_shouldDownloadTheBinary` | `download-artifact` im `e2e`-Job |
| `test/ci/workflow.test.js` | `workflow_releaseJob_shouldAskForWritePermissions` | `contents: write` und `gh release create` |
| `test/ci/workflow.test.js` | `workflow_shouldNotContainAStyleLinter` | kein `ste-lint`, kein `actionlint` — die Entscheidung ist gepinnt, nicht nur notiert |
| `scripts/e2e/run.mjs` | der Lauf selbst (lokal) | Verbindung, `browser_open_tab`, Beacon-Treffer |
| `scripts/e2e/run.mjs` | `--self-check` | der Seam-Patch findet seine zwei Zeilen; sonst Exit 1 mit „seam moved" |

## Acceptance criteria

1. **Der E2E läuft lokal und beweist die Seite.** `node scripts/e2e/run.mjs`
   ⇒ Exit **0**, Ausgabe enthält `extension connected`, `open tab=` und
   `beacon hit`. Ohne Beacon-Treffer Exit 1.
2. **Der Beacon ist unabhängig.** Ein Lauf mit absichtlich falschem Token
   (`E2E_TOKEN=kaputt`) ⇒ Exit 1, **kein** `beacon hit` — die Bridge kann den
   Test nicht bestehen, indem sie nur „ok" antwortet.
3. **Der Seam ist gepinnt.** `node scripts/e2e/run.mjs --self-check` ⇒ Exit 0;
   wird eine der zwei Zeilen in `background.js` umbenannt, ⇒ Exit 1 mit
   `seam moved`.
4. **Unit und E2E sind getrennt.** `grep -c 'scripts/e2e/run.mjs'
   .github/workflows/test.yml` ⇒ **1**, und dieser Job läuft auf
   `windows-latest`; der `unit`-Job nennt `runs-on: ubuntu-latest` und enthält
   **kein** `firefox`.
5. **Kein Stil-Lint in der CI.** `grep -cE 'ste-lint|actionlint'
   .github/workflows/*.yml` ⇒ **0**.
6. **Der Unit-Job prüft den Code.** `grep -cE '^\s*- run: .*(cargo
   (build|test|clippy)|parity\.sh)' .github/workflows/test.yml` ⇒ **≥ 5**.
7. **Der Release hängt die Zips an.** `grep -c 'gh release create'
   .github/workflows/release.yml` ⇒ **1**, `grep -c 'contents: write'` ⇒ **1**.
8. **Der Rest bleibt grün.** `npm test` ⇒ `# fail 0`, `# cancelled 0`;
   `npm run check` ⇒ 0; `parity.sh --impl rust --check` ⇒ 7/7; Secret-Grep
   beidseitig Exit 1.

## Dev plan

**Stufe 1 — `scripts/e2e/run.mjs` und der lokale Beweis**

Dateien: `scripts/e2e/run.mjs`, `scripts/e2e/beacon.mjs` (der Testserver),
`scripts/e2e/build-test-extension.mjs` (Kopie + zwei Patches mit `grep -c`).

Das Skript fährt die zehn Schritte, endet mit `beacon hit` oder einem
benannten Fehler, räumt per PID auf. `--self-check` prüft nur die zwei
Patch-Zeilen.

Beweis: Kriterien 1–3, auf Linux gemessen (der Ablauf oben ist der Messwert).

**Stufe 2 — der `unit`-Job und `scripts/ci-local.sh`**

Dateien: `.github/workflows/test.yml` (Job `unit` ergänzt, `node` unverändert),
`scripts/ci-local.sh`.

Beweis: Kriterium 6; `bash scripts/ci-local.sh` ⇒ Schlusszeile, Exit 0.

**Stufe 3 — der `e2e`-Job**

Dateien: `.github/workflows/test.yml` (Job `e2e`), `test/ci/workflow.test.js`,
`package.json` (`test:ci`).

Beweis: Kriterien 4 und 5; `npm run test:ci` ⇒ `# fail 0`.

**Stufe 4 — `bundle` und `release`**

Dateien: `.github/workflows/test.yml` (Job `bundle`), `.github/workflows/release.yml`.

Beweis: Kriterium 7; der erste Push zeigt den `e2e`-Lauf auf Windows.

## Bekannte Lücken

- **Der Windows-E2E ist hier nicht gelaufen** — gemessen ist der identische
  Ablauf auf Linux (Firefox 152). Der erste `windows-latest`-Lauf ist der
  Beweis; deshalb hat das Skript `--windows` und benannte Fehler.
- **`web-ext` ist eine neue Werkzeugabhängigkeit** (npm, gepinnt `8.9.0`, MPL-2.0)
  — nur im E2E, nicht im Produkt.
- **Der Seam ist ein Textpatch** auf zwei Zeilen in einer Kopie. Er ist gezählt
  und bricht laut, aber er ist kein Vertrag: ändert jemand die Zeile, muss der
  Patch nach.
- **Kein Signieren, kein Dienst:** der E2E prüft den Handstart, nicht den
  Autostart.

## Open questions

**Keine.** Entschieden am 2026-11-17: Test-XPI mit eingebautem Token (kein
Managed Storage, kein Klick auf die Optionsseite), `web-ext` statt
`geckodriver`, kein Stil-Lint, Unit und E2E getrennt.

## Review

### Runde 1 — steht aus

## Log

- **2026-11-17, Betreiberfrage:** „können wir den Ablauf in git actions auch
  nachbauen und testen?" — ja; der Befund dazu: CI prüft die Bridge heute gar
  nicht.
- **2026-11-17, Betreiberentscheid:** CI soll die **Installation** prüfen —
  Windows, Firefox, XPI installieren, über MCP eine Seite öffnen; Ziel ist der
  Nachweis, dass die Seite in Firefox geöffnet wurde. Der Rest sind Unit-Tests
  und läuft separat.
- **2026-11-17, Betreiberentscheid:** kein automatischer STE100-Lint.
- **2026-11-17, Messung:** der Ablauf ist lokal gelaufen (Linux, Firefox 152):
  `extension connected` nach 4 s, `open tab=2`, Beacon-Treffer 4 s später.
- **2026-11-17, Abspaltung:** dieser Abschnitt war Teil von `docs/39`; der
  Spec-Review hat ihn dort als zweites Inkrement beanstandet (M8).
