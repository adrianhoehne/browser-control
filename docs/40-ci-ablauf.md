---
description: Der Ablauf in GitHub Actions — Unit-Tests ohne Browser, ein Blackbox-Test auf Windows, der Firefox startet und über MCP eine Seite öffnet, dazu Zip-Bau und Release.
status: proposed
---

# Der Ablauf in CI

**Befund 2026-11-17:** `.github/workflows/test.yml` läuft `npm run check` und
`npm test` auf Node 22 und 24 — sonst nichts. Kein `cargo`, kein
`scripts/parity.sh`, keine Installation. Seit dem Schnitt (`docs/38`) sagt der
grüne Haken also nichts über die Bridge, die tatsächlich läuft.

Diese Spec teilt die Prüfung in zwei ungleiche Hälften:

- **Unit-Tests** — ohne Browser, bei jedem Push. Sie prüfen den Code.
- **Ein Blackbox-Workflow** — auf Windows, mit echtem Firefox. Er prüft die
  Installation von außen: Firefox starten, die Erweiterung installieren, über MCP
  eine Seite öffnen, und **die Seite selbst** meldet sich beim Testserver.

Dazu kommen Zip-Bau (`docs/39`) und Release-Anhang.

**Was sie nicht tut:** keinen Stil-Lint (STE100 ist Schreibregel, kein
Prüfschritt), keine Windows-Dienst-Prüfung, keinen Cache, keine
Branch-Protection.

## Ziel

- **Job `unit`, browserfrei:** `npm run check`, `npm test`,
  `npm run test:bundle`, `npm run test:ci`, `cargo test -- --test-threads=1`,
  `cargo clippy --all-targets -- -D warnings` (beide Ziele),
  `scripts/parity.sh --impl rust --check` (7/7) und `--self-test`
  (`7/7 rot wie erwartet`).
- **Job `e2e`, Windows, Blackbox:** die Kette aus `## Der E2E-Ablauf` läuft und
  endet mit dem Beacon-Treffer. Das ist der Beweis „eine Seite wurde in Firefox
  geöffnet".
- **Job `bundle`:** baut die zwei Zips aus `docs/39`, lädt sie als Artefakt.
- **Job `release`:** nur bei Tag `v*`, hängt beide Zips an das GitHub-Release.
- **Lokal nachbaubar:** `scripts/ci-local.sh` fährt `unit` und `bundle`;
  `node scripts/e2e/run.mjs` fährt denselben E2E-Ablauf auf Linux wie CI auf
  Windows.

## Non-goals

- **Kein Stil-Lint.** Kein `ste-lint`, kein `actionlint`-Zwang.
- **Kein Windows-Dienst.** Task Scheduler, Autostart und `GetFileType` bleiben
  Betreiber-Messungen (`docs/38`, Stufe 3).
- **Kein Cache, keine Branch-Protection, kein `act`.**
- **Kein Signieren** der XPI.

## Additional dependencies

| Abhängigkeit | Version | Lizenz | Wo |
|---|---|---|---|
| `web-ext` | **8.9.0** (gepinnt) | MPL-2.0 | nur im `e2e`-Job und in `scripts/e2e/run.mjs`, nicht im Produkt |

`web-ext` startet Firefox und installiert die Erweiterung als **temporäres
Add-on** — derselbe Weg wie „Load Temporary Add-on" in `about:debugging`. Kein
Produktcode hängt daran.

## Der E2E-Ablauf

Der Ablauf ist am 2026-11-17 **lokal gemessen** (Linux, Firefox 152, Bridge auf
18810/18811, Beacon auf 18990):

```
Installed /tmp/e2e/ext as a temporary add-on
extension connected peer=127.0.0.1 protocol=1     (4 s nach dem Start)
open tab=2 url=http://127.0.0.1:18990/page
PING 2026-11-17T15:15:48.205Z                     (die Seite selbst, 4 s später)
```

**Vorbereiten (Schritte 1–2), dann fahren (3–10):**

1. **Binary bereitstellen.** Im `e2e`-Job das Artefakt `bridge-windows` aus dem
   `unit`-Job (`.exe`, `x86_64-pc-windows-gnu`, `--release`), damit geprüft
   wird, was ausgeliefert wird. Pfad: `E2E_BINARY`.
2. **Token erzeugen** (32 Bytes Zufall, 64 Hex) in eine Datei; `BC_TOKEN_FILE`
   darauf zeigen. `E2E_TOKEN_FILE` benennt sie.
3. **Test-Kopie der Erweiterung bauen** (Verzeichnis, **kein Zip**): `extension/`
   kopieren, dann zwei Zeilen patchen — der Endpunkt (`ws://127.0.0.1:18810`)
   und das Token als Rückfallwert. Beide Patches werden **gezählt**
   (`grep -c` ⇒ genau 1); findet ein Patch seine Zeile nicht, endet der Lauf mit
   `seam moved` und Exit 1. Die ausgelieferte Erweiterung bleibt unverändert.
4. **Bridge starten:** `BC_BIND=127.0.0.1:18810 BC_HTTP_PORT=18811
   <binary> --http`, Ausgabe in eine Logdatei.
5. **Beacon-Server starten** (Node, Port 18990): liefert `/page` mit einem
   eingebetteten `fetch("/ping")` und merkt sich den Treffer.
6. **Firefox starten** mit der Test-Kopie: `npx web-ext@8.9.0 run --source-dir
   <temp> --firefox <pfad> --arg=-headless --no-reload --no-input`. Den Pfad
   bestimmt `E2E_FIREFOX`; ohne ihn `%ProgramFiles%\Mozilla Firefox\firefox.exe`;
   findet sich keins, bricht der Lauf mit `no firefox` ab.
7. **Auf `extension connected`** in der Bridge-Logdatei warten. Deckel 60 s
   (Messwert 4 s, also 15-fach).
8. **Über MCP eine Seite öffnen** — mit Kopfzeile und JSON-RPC-Hülle:

   ```
   POST http://127.0.0.1:18811/mcp
   Authorization: Bearer <token aus Schritt 2>
   {"jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"browser_open_tab","arguments":{"url":"http://127.0.0.1:18990/page"}}}
   ```

9. **Auf den Beacon warten.** Deckel 30 s (Messwert 4 s, also 7-fach). **Das ist
   der Beweis:** die Bridge könnte lügen, die geladene Seite nicht.
10. **Aufräumen per PID** — Bridge, Beacon, `web-ext` **und** das von `web-ext`
    gestartete Firefox, auch im Fehlerfall. Auf Windows `taskkill /T /PID <pid>`
    (der Baum!), auf POSIX `kill`; im Node-Skript `process.kill(pid, "SIGTERM")`
    bzw. `taskkill`. **Niemals `pkill -f`/`taskkill /IM`** — der Betreiber-Dienst
    hat dieselbe Kommandozeile, und genau das hat am 17.11. den Dienst zweimal
    beendet.

**Warum der Patch und kein Klick:** die Erweiterung liest Endpunkt und Token nur
aus `storage.local`; `about:debugging` lässt sich nicht per Skript bedienen.
`web-ext` installiert die Erweiterung temporär — genau das, was der Knopf tut —
und der Patch ersetzt die zwei Werte, die sonst jemand eintippen müsste.
Gemessen: ohne den Endpunkt-Patch verbindet sie sich nach `ws://127.0.0.1:8110`
und der Lauf scheitert mit `auth failed` am Betreiber-Dienst.

**Ports:** 18810/18811/18990 liegen **außerhalb** der beiden reservierten
Bereiche — 8110/8111 gehören dem laufenden Dienst, 18110–18119 den Test-Suiten
(`bridge-rs/tests/common/mod.rs`).

| Frist | Wert | Herkunft |
|---|---|---|
| Verbinden | 60 s | gewählt, 15 × Messwert (4 s) |
| Beacon | 30 s | gewählt, 7 × Messwert (4 s) |
| `web-ext`-Start | ~4 s | gemessen |

## Die Jobs

| Job | Läuft auf | Schritte |
|---|---|---|
| `test` | `ubuntu-latest`, Matrix 22/24 | **unverändert**: checkout, setup-node, `npm run check`, `npm test` — ohne Rust |
| `unit` | `ubuntu-latest` | checkout, Node (für `parity.sh`), rustup (stable, Ziele `x86_64-unknown-linux-musl` + `x86_64-pc-windows-gnu`, Teil `clippy`), `gcc-mingw-w64-x86-64`; `npm run check`, `npm test`, `npm run test:bundle`, `npm run test:ci`; `cargo build --release` (beide Ziele), `cargo test -- --test-threads=1`, `clippy -D warnings --all-targets` (beide Ziele), `parity.sh --impl rust --check`, `parity.sh --self-test`; `upload-artifact` `bridge-linux` und `bridge-windows` |
| `e2e` | `windows-latest`, braucht `unit` | checkout, Node, `download-artifact` `bridge-windows` **nach** `bridge-rs/target/x86_64-pc-windows-gnu/release/`, `node scripts/e2e/run.mjs` |
| `bundle` | `ubuntu-latest`, braucht `unit` | checkout, Node, `download-artifact` `bridge-linux` nach `target/…/release/`, `scripts/bundle.sh`, `npm run test:bundle`, `upload-artifact` `portable-zips` (beide Zips) |
| `release` | nur Tag `v*`, braucht `bundle` | `download-artifact` `portable-zips` mit `path: dist`, `merge-multiple: true`; `permissions: contents: write`; `GH_TOKEN: ${{ github.token }}`; `gh release create "$GITHUB_REF_NAME" dist/*.zip --generate-notes --clobber` |

**Vier Zeilen, die man sonst vergisst — und wo sie gepinnt sind:**

1. **`--release`** überall, wo ein Binary entsteht (`parity.sh` sucht
   `…/release/…`) — gepinnt in `workflow_unitJob_shouldBuildBothTargetsInRelease`.
2. **Artefakt-Upload/-Download** zwischen `unit` → `e2e` und `unit` → `bundle`,
   mit dem Pfad, den `parity.sh` und `bundle.sh` erwarten — gepinnt in
   `workflow_e2eJob_shouldDownloadTheBinary` und
   `workflow_bundleJob_shouldUploadTheZips`.
3. **`--test-threads=1`** beim Rust-Test (echte Bridges binden Ports) — gepinnt
   in `workflow_unitJob_shouldRunTheRustTestsSerially`.
4. **`permissions: contents: write`** im `release`-Job (der Default-Token ist
   `read`, `gh release create` scheitert mit 403) — gepinnt in
   `workflow_releaseJob_shouldAskForWritePermissions`.

## Lokal nachbauen

`scripts/ci-local.sh` fährt `unit` und `bundle`:

```
cargo build --release --target x86_64-unknown-linux-musl / -windows-gnu
npm run check && npm test && npm run test:bundle && npm run test:ci
cargo test -- --test-threads=1
cargo clippy --all-targets -- -D warnings            (beide Ziele)
bash scripts/parity.sh --impl rust --check
bash scripts/parity.sh --self-test
bash scripts/bundle.sh
→ "ci-local: alle Schritte grün"
```

`node scripts/e2e/run.mjs` fährt den Blackbox-Ablauf. Umgebung:
`E2E_FIREFOX`, `E2E_BINARY`, `E2E_TOKEN_FILE`; `--keep` lässt die Prozesse
stehen, `--windows` setzt die Windows-Pfade, `--self-check --source <dir>` prüft
nur die zwei Patch-Zeilen.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/ci/workflow.test.js` | `workflow_unitJob_shouldBuildBothTargetsInRelease` | `--release` und beide Ziele, gefunden über `run:`-Zeilen |
| `test/ci/workflow.test.js` | `workflow_unitJob_shouldRunTheRustTestsSerially` | `--test-threads=1` steht im `unit`-Job |
| `test/ci/workflow.test.js` | `workflow_e2eJob_shouldRunOnWindowsAndUseTheScript` | `runs-on: windows-latest` und ein `run:` mit `scripts/e2e/run.mjs` |
| `test/ci/workflow.test.js` | `workflow_e2eJob_shouldDownloadTheBinary` | `download-artifact` mit dem Pfad, den der E2E erwartet |
| `test/ci/workflow.test.js` | `workflow_bundleJob_shouldUploadTheZips` | `npm run test:bundle` und `upload-artifact` `portable-zips` |
| `test/ci/workflow.test.js` | `workflow_releaseJob_shouldAskForWritePermissions` | `contents: write`, `merge-multiple`, `gh release create` |
| `test/ci/workflow.test.js` | `workflow_shouldNotContainAStyleLinter` | kein `ste-lint`, kein `actionlint` |
| `test/ci/e2e.test.js` | `e2e_seamPatch_shouldFindBothLines` | der Patch findet in einer Kopie Endpunkt **und** Token-Zeile; nach einer Umbenennung meldet er `seam moved` |

Der E2E-Lauf selbst ist **kein** Unit-Fall: er startet Firefox und steht als
Kriterium 1–3 bei den Betreiber-Kriterien.

## Acceptance criteria

1. **Der E2E läuft und beweist die Seite.** *(Betreiber, echter Browser;
   Voraussetzung `E2E_FIREFOX`, `E2E_BINARY`.)* `node scripts/e2e/run.mjs` ⇒
   Exit **0**, Ausgabe enthält `extension connected`, `open tab=` und die
   Beacon-Zeile (`PING <ISO-8601>`). Ohne Beacon-Treffer Exit 1.
2. **Der Beacon ist unabhängig.** Ein Lauf mit einem Beacon, der `/ping` mit
   **500** beantwortet (`E2E_BEACON_MODE=broken`), ⇒ Exit 1 und **kein**
   `PING` — obwohl die Bridge `open tab=` meldet. Die Bridge kann den Test also
   nicht bestehen, indem sie nur „ok" antwortet.
3. **Der Seam ist gepinnt.** `node scripts/e2e/run.mjs --self-check --source
   extension` ⇒ Exit 0; auf einer **Kopie** mit `sed -i
   's/DEFAULT_ENDPOINT/ENDPOINT/g' <kopie>/background.js` ⇒ Exit 1 mit
   `seam moved`. Die getrackte Datei bleibt unangetastet.
4. **Unit und E2E sind getrennt.** `grep -c 'scripts/e2e/run.mjs'
   .github/workflows/test.yml` ⇒ **1**, dieser Job läuft auf
   `windows-latest`; der `unit`-Job nennt `runs-on: ubuntu-latest` und enthält
   **kein** `firefox`.
5. **Kein Stil-Lint in der CI.** `grep -rlE 'ste-lint|actionlint'
   .github/workflows/; echo $?` ⇒ **1** (keine Datei).
6. **Der Unit-Job prüft den Code** — entschieden über die Testfälle, nicht über
   `grep`-Zählung: `npm run test:ci` ⇒ `# fail 0`, und
   `workflow_unitJob_shouldBuildBothTargetsInRelease` ist darin grün.
7. **Der Release hängt die Zips an.** `grep -c 'gh release create'
   .github/workflows/release.yml` ⇒ **1**; `grep -c 'contents: write'` ⇒ **1**;
   `grep -c 'merge-multiple: true'` ⇒ **1**.
8. **Der lokale Nachbau ist grün.** `bash scripts/ci-local.sh; echo $?` ⇒ Exit
   **0**, letzte Zeile `ci-local: alle Schritte grün`.
9. **Beide Paritätsläufe stehen.** `bash scripts/parity.sh --impl rust --check`
   ⇒ `7/7 wie erwartet`; `--self-test` ⇒ `7/7 rot wie erwartet`.
10. **Der Rest bleibt grün.** `npm run check` ⇒ 0; Secret-Grep beidseitig Exit 1.

## Dev plan

**Stufe 1 — `scripts/e2e/run.mjs` und der lokale Beweis**

Dateien: `scripts/e2e/run.mjs`, `scripts/e2e/beacon.mjs`,
`scripts/e2e/build-test-extension.mjs` (Kopie + zwei gezählte Patches),
`test/ci/e2e.test.js`.

Das Skript fährt die zehn Schritte, endet mit der Beacon-Zeile oder einem
benannten Fehler, räumt per PID auf (`taskkill /T` auf Windows).

Beweis: Kriterien 1–3, auf Linux gemessen (der Ablauf oben ist der Messwert).

**Stufe 2 — Job `unit` und `scripts/ci-local.sh`**

Dateien: `.github/workflows/test.yml` (Job `unit`), `scripts/ci-local.sh`,
`CONTRIBUTING.md` (Abnahme um `npm run test:bundle`, `npm run test:ci`,
`cargo test` ergänzt).

Beweis: Kriterien 6, 8, 9.

**Stufe 3 — Job `e2e`**

Dateien: `.github/workflows/test.yml` (Job `e2e`), `test/ci/workflow.test.js`,
`package.json` (`test:ci`).

Beweis: Kriterien 4, 5; `npm run test:ci` ⇒ `# fail 0`.

**Stufe 4 — `bundle` und `release`**

Dateien: `.github/workflows/test.yml` (Job `bundle`),
`.github/workflows/release.yml`.

Beweis: Kriterium 7; der erste Push zeigt den `e2e`-Lauf auf Windows.

## Bekannte Lücken

- **Der Windows-E2E ist hier nicht gelaufen** — gemessen ist der identische
  Ablauf auf Linux (Firefox 152). Der erste `windows-latest`-Lauf ist der
  Beweis; deshalb hat das Skript `--windows` und benannte Fehler.
- **Der Seam ist ein Textpatch** auf zwei Zeilen in einer Kopie. Er ist gezählt
  und bricht laut, aber er ist kein Vertrag: ändert jemand die Zeile, muss der
  Patch nach.
- **Kein Signieren, kein Dienst:** der E2E prüft den Handstart, nicht den
  Autostart.

## Open questions

**Keine.** Entschieden am 2026-11-17: Test-Kopie mit eingebautem Token (kein
Managed Storage, kein Klick auf die Optionsseite), `web-ext` statt
`geckodriver`, kein Stil-Lint, Unit und E2E getrennt.

## Review

### Runde 1 — 2026-11-17, `grizzled-senior-dev`: 🔧, Blocker dabei

Sieben Blocker: fehlender Pflichtabschnitt für `web-ext`; zwei Definitionen des
`unit`-Jobs (Ziel vs. Tabelle); „Job `node` unverändert", obwohl der Job `test`
heißt; das Negativkriterium zum Seam ohne Kommando und auf einer getrackten
Datei; Kriterium 2 prüfte den Token-Pfad statt der Beacon-Unabhängigkeit;
`npm run test:ci` lief nirgends; Jobnamen und Artefaktpfade nicht festgelegt.

### Runde 2 — steht aus

## Log

- **2026-11-17, Betreiberfrage:** „können wir den Ablauf in git actions auch
  nachbauen und testen?" — ja; der Befund dazu: CI prüft die Bridge heute gar
  nicht.
- **2026-11-17, Betreiberentscheid:** CI soll die **Installation** prüfen —
  Windows, Firefox, Erweiterung installieren, über MCP eine Seite öffnen; Ziel
  ist der Nachweis, dass die Seite in Firefox geöffnet wurde. Der Rest sind
  Unit-Tests und läuft separat.
- **2026-11-17, Betreiberentscheid:** kein automatischer STE100-Lint.
- **2026-11-17, Messung:** der Ablauf ist lokal gelaufen (Linux, Firefox 152):
  `extension connected` nach 4 s, `open tab=2`, Beacon-Treffer 4 s später.
- **2026-11-17, Abspaltung:** dieser Abschnitt war Teil von `docs/39`; der
  Spec-Review hat ihn dort als zweites Inkrement beanstandet (M8).
- **Runde 1 — übernommen:** `## Additional dependencies` mit `web-ext 8.9.0`
  (MPL-2.0, nur E2E); eine Definition des `unit`-Jobs (Tabelle und Ziel gleich);
  Jobname `test` bleibt (keine Umbenennung, Branch-Protection ist Non-Goal);
  Seam-Negativfall mit Kommando auf einer Kopie; Kriterium 2 prüft jetzt die
  Beacon-Unabhängigkeit (`E2E_BEACON_MODE=broken` ⇒ 500); `npm run test:ci` im
  `unit`-Job, in `ci-local.sh` und in `CONTRIBUTING.md`; Artefaktnamen
  `bridge-linux`/`bridge-windows`/`portable-zips` samt `path:` und
  `merge-multiple: true`; Firefox-Pfad als eigener Schritt; Aufräumen mit
  `taskkill /T /PID` für den Prozessbaum; „Test-XPI" heißt jetzt „Test-Kopie
  (Verzeichnis)"; Schritt 8 mit Kopfzeile und JSON-RPC-Hülle; Fristen mit
  Herkunft; Kriterium für `ci-local.sh` und für den `bundle`-Job; Linter-Check
  über `grep -rl`; `--self-test`-Zeile als eigenes Kriterium gepinnt;
  Portbegründung nennt 18110–18119.
