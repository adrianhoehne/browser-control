---
description: Der Ablauf in GitHub Actions — Bridge bauen und gegen die sieben Artefakte messen, portables Zip bauen, an ein Release hängen; lokal nachbaubar.
status: proposed
---

# Der Ablauf in CI

**Befund 2026-11-17:** `.github/workflows/test.yml` läuft `npm run check` und
`npm test` auf Node 22 und 24 — sonst nichts. Kein `cargo`, kein
`scripts/parity.sh`.

Seit dem Schnitt (`docs/38`) sagt der grüne Haken also nichts über die Bridge,
die tatsächlich läuft. Ein Portierungsfehler im Hub fiele erst beim Betreiber
auf. Das ist genau die Sorte Fehler, gegen die der Paritätsmaßstab gebaut wurde.

Diese Spec schließt das. Sie ist der Altlast-Fix und die Voraussetzung dafür,
dass `docs/39` (das portable Zip) einen Release-Anhang bekommen kann.

**Was sie nicht tut:** keinen Windows-Runner, keine Branch-Protection, keinen
Cache, keine zweite Bauanleitung. Der Workflow ruft dieselben Skripte auf, die
auf dem Betreiber-Rechner laufen.

## Ziel

- **Die Bridge wird bei jedem Push und Pull Request geprüft:** `cargo build`
  (`--release`, musl **und** windows-gnu), `cargo test -- --test-threads=1`,
  `clippy --all-targets -- -D warnings` für beide Ziele, `scripts/parity.sh
  --impl rust --check` ⇒ 7/7 und `--self-test` ⇒ 7/7 rot.
- **Das Zip wird gebaut und getestet**, sobald die Bridge grün ist.
- **Ein Tag `v*` hängt beide Zips an das Release.**
- **Der Ablauf ist lokal nachbaubar** — dieselben Befehle, in derselben
  Reihenfolge, über `scripts/ci-local.sh`. Wer ihn ändert, ändert das Skript;
  der Workflow zitiert es.
- **Die YAML wird geprüft**, nicht nur geschrieben (`actionlint`).

## Non-goals

- **Kein Windows-Runner.** `x86_64-pc-windows-gnu` wird auf `ubuntu-latest`
  gekreuzt; das Binary wird gebaut und gelintet, nicht gestartet (dieselbe
  Grenze wie `docs/38`, Stufe 3).
- **Kein Cache.** `actions/cache` auf `~/.cargo` und `bridge-rs/target` wäre eine
  neue Abhängigkeit im Sinne von `CONTRIBUTING.md`; die Entscheidung steht unter
  `## Open questions`.
- **Keine Branch-Protection, kein Required-Status.** Das ist eine Einstellung im
  Repository, nicht im Baum.
- **Kein `act`.** Der lokale Nachbau ist ein Shell-Skript mit denselben
  Befehlen, kein Container-Runner.

## Die Jobs

| Job | Auslöser | Schritte |
|---|---|---|
| `node` | Push, PR | `actions/checkout`, `actions/setup-node` (Matrix 22/24), `npm run check`, `npm test` — **unverändert** und ohne Rust |
| `rust` | Push, PR | checkout, `dtolnay/rust-toolchain` **oder** rustup (stable, `--profile minimal`, Ziele `x86_64-unknown-linux-musl` + `x86_64-pc-windows-gnu`, Teil `clippy`), `sudo apt-get install -y gcc-mingw-w64-x86-64`, `actions/setup-node` (für `parity.sh` und `package.sh`), `cargo build --release` für beide Ziele, `cargo test -- --test-threads=1`, `clippy -D warnings --all-targets` für beide Ziele, `scripts/parity.sh --impl rust --check`, `scripts/parity.sh --self-test`, `actions/upload-artifact` mit den zwei Binaries |
| `bundle` | nach `rust` | checkout, `download-artifact` (die zwei Binaries), `setup-node`, `scripts/bundle.sh`, `npm run test:bundle`, `node scripts/ste-lint.mjs docs/portable/*.md --language en` (mit `STE_LINT_DIR` aus einem gepinnten Klon), `upload-artifact` mit beiden Zips |
| `release` | nur Tag `v*`, nach `bundle` | `download-artifact`, `permissions: contents: write`, `GH_TOKEN: ${{ github.token }}`, `gh release create "$GITHUB_REF_NAME" dist/*.zip --generate-notes --clobber` |

**Vier Zeilen, die man sonst vergisst und die deshalb hier stehen:**

1. **`permissions: contents: write`** auf Job-Ebene für `release` — der
   Default-`GITHUB_TOKEN` neuer Repositories ist `contents: read`, und
   `gh release create` scheitert mit 403.
2. **`--release`** überall dort, wo das Binary entsteht: `scripts/parity.sh`
   sucht `…/target/<ziel>/release/browser-control-bridge`, ein Debug-Build lässt
   den Paritätslauf mit „rust binary missing" stehen.
3. **Die Binaries wandern als Artefakt** vom `rust`- in den `bundle`-Job.
   `bundle.sh` baut nichts (Vertrag in `docs/39`); ohne Upload/Download fehlt ihm
   die Quelle und es endet mit Exit 1.
4. **`--test-threads=1`** beim Rust-Test: echte Bridges binden Ports, und
   `cargo test` fährt Fälle einer Datei parallel (die Node-Suite läuft aus
   demselben Grund mit `--test-concurrency=1`).

**`ste-lint` in CI:** `git clone --depth 1 --branch v0.1.7
https://github.com/adrianhoehne/ste-lint /tmp/ste-lint`, dann
`STE_LINT_DIR=/tmp/ste-lint`. Der Tag ist derselbe wie lokal; `scripts/ste-lint.mjs`
gibt die geladene Version aus und endet mit Exit **2**, wenn sie vom erwarteten
Tag abweicht. Kein `|| true`.

## Der lokale Nachbau

`scripts/ci-local.sh` fährt die Reihenfolge des `rust`- und `bundle`-Jobs mit
denselben Befehlen:

```
rustup target add … / rustup component add clippy
apt-Prüfung: x86_64-w64-mingw32-gcc vorhanden (sonst Hinweis, Exit 1)
cargo build --release --target x86_64-unknown-linux-musl
cargo build --release --target x86_64-pc-windows-gnu
cargo test -- --test-threads=1
cargo clippy --all-targets -- -D warnings            (beide Ziele)
bash scripts/parity.sh --impl rust --check
bash scripts/parity.sh --self-test
bash scripts/bundle.sh
npm run test:bundle
node scripts/ste-lint.mjs docs/portable/*.md --language en
actionlint .github/workflows/*.yml
→ "ci-local: alle Schritte grün"
```

Zwei Schalter: `--only <name>` (einen Schritt fahren) und `--skip-network` (der
`ste-lint`-Klon entfällt). Mit `--skip-network` meldet der Lint-Schritt Exit 2,
und das Skript endet rot — bewusst, nicht als `|| true`.

**Was der lokale Nachbau nicht kann:** den Runner. `actionlint` prüft Syntax und
Ausdrücke, nicht das Verhalten von `actions/checkout` oder `upload-artifact`.
Der erste Push ist der echte Beweis. Deshalb existiert jeder Schritt auch lokal.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/ci/workflow.test.js` | `workflow_rustJob_shouldBuildBothTargetsInRelease` | die YAML enthält `--release` und beide Ziele — gefunden über `run:`-Zeilen, nicht über Kommentare |
| `test/ci/workflow.test.js` | `workflow_bundleJob_shouldDownloadTheBinaries` | `upload-artifact` im `rust`-, `download-artifact` im `bundle`-Job |
| `test/ci/workflow.test.js` | `workflow_releaseJob_shouldAskForWritePermissions` | `permissions: contents: write` und `gh release create` |
| `test/ci/workflow.test.js` | `workflow_parityRunsAfterTheBuild` | die Reihenfolge im `rust`-Job: Build vor `parity.sh` |
| `scripts/ci-local.sh` | der Lauf selbst | die Befehle funktionieren in dieser Reihenfolge (Exit 0, Schlusszeile) |
| `scripts/ste-lint.mjs` | `ste-lint-version mismatch` | die Version im Klon ist die gepinnte (Exit 2 sonst) |

Die Workflow-Fälle lesen die YAML als **Text** (kein YAML-Parser als
Abhängigkeit) und prüfen `run:`-Zeilen — ein Kommentar `# cargo test` darf sie
nicht erfüllen.

## Acceptance criteria

1. **CI prüft die Bridge.** Beweis:
   `grep -cE '^\s*- run: .*(cargo (build|test|clippy)|parity\.sh)' .github/workflows/test.yml`
   ⇒ **≥ 5**, und `grep -c 'x86_64-pc-windows-gnu' .github/workflows/test.yml`
   ⇒ **≥ 1**.
2. **Der lokale Nachbau ist grün.** `bash scripts/ci-local.sh; echo $?` ⇒
   Schlusszeile `ci-local: alle Schritte grün`, Exit **0**.
3. **Die YAML ist sauber.** `actionlint .github/workflows/*.yml; echo $?` ⇒ **0**
   (Version **1.7.7**, Bezug über `scripts/ci-local.sh --install-actionlint`,
   das die Version prüft).
4. **Ein Job baut die Zips, einer hängt sie an.** Beweis:
   `grep -c 'upload-artifact' .github/workflows/test.yml` ⇒ **≥ 2** (Binaries,
   Zips), `grep -c 'download-artifact'` ⇒ **≥ 2**, und
   `grep -c 'gh release create' .github/workflows/release.yml` ⇒ **1**.
5. **Das Release hat Schreibrechte.** `grep -c 'contents: write'
   .github/workflows/release.yml` ⇒ **1**.
6. **`npm test` bleibt binary-frei.** `npm test` läuft in einem Baum ohne
   `bridge-rs/target/` ⇒ grün (`# fail 0`); die Bundle-Fälle laufen nur über
   `npm run test:bundle`.
7. **Der Rest bleibt grün.** `npm run check` ⇒ 0; `scripts/parity.sh --impl rust
   --check` ⇒ 7/7; Secret-Grep beidseitig Exit 1.

## Dev plan

**Stufe 1 — `ci-local.sh` und der Linter-Aufruf**

Dateien: `scripts/ci-local.sh`, `scripts/ste-lint.mjs` (aus `docs/39`, Stufe 2 —
hier zuerst gebraucht), `deploy/actions/actionlint-version` (eine Zeile, die
Version).

Beweis: `bash scripts/ci-local.sh --only clippy` ⇒ grün;
`bash scripts/ci-local.sh` ⇒ Schlusszeile, Exit 0 (der Lint-Schritt darf hier
noch Exit 2 melden, solange `docs/portable/*.md` fehlt — dann ist Stufe 2 dran).

**Stufe 2 — der `rust`-Job**

Dateien: `.github/workflows/test.yml` (Job `rust` ergänzt, `node` unverändert).

Beweis: Kriterium 1; `actionlint` ⇒ 0; `bash scripts/ci-local.sh --only rust`
⇒ grün.

**Stufe 3 — `bundle`- und `release`-Job**

Dateien: `.github/workflows/test.yml` (Job `bundle`), `.github/workflows/release.yml`,
`test/ci/workflow.test.js`, `package.json` (`test:ci`).

Beweis: Kriterien 4, 5; `npm run test:ci` ⇒ `# fail 0`.

**Stufe 4 — Doku und der erste echte Lauf**

Dateien: `CONTRIBUTING.md` (der CI-Ablauf in der Abnahme), `README.md`
(Build-Status-Satz, der stimmt), `docs/PROJECT-STATE.md`, `CHANGELOG.md`.

Beweis: der Push — vier Jobs im Actions-Lauf, `rust` und `bundle` grün. Das ist
der einzige Beweis, den niemand lokal führen kann, und er gehört in den Bericht
des Betreibers, nicht in ein Kriterium dieses Dokuments.

## Bekannte Lücken

- **Der erste echte Lauf steht aus.** Alles hier ist lokal nachgebaut; ob
  `actions/checkout` und `upload-artifact` tun, was sie sollen, zeigt erst der
  Push.
- **Windows wird gebaut, nicht gestartet** — dieselbe Grenze wie `docs/38`,
  Stufe 3.
- **Kein Cache:** der `rust`-Job lädt bei jedem Lauf die Registry neu. Langsam,
  aber ohne neue Abhängigkeit.

## Open questions

1. **Darf `actionlint` als Prüfwerkzeug dazukommen** (Version 1.7.7, MIT,
  heruntergeladen von GitHub-Releases)? Es steht in keinem Produktpfad, aber es
  ist eine neue Abhängigkeit im Sinne von `CONTRIBUTING.md` — und ohne es prüft
  niemand die YAML außer GitHub selbst.
2. **Darf `actions/cache` für `~/.cargo` und `bridge-rs/target` dazu?** Es
  verkürzt den `rust`-Job deutlich, ist aber eine Abhängigkeit mehr.

Beide Fragen beantwortet der Betreiber; bis dahin gilt: `actionlint` ja/nein
entscheidet Kriterium 3, Cache bleibt bis zur Antwort weg.

## Review

### Runde 1 — steht aus

## Log

- **2026-11-17, Betreiberfrage:** „können wir den Ablauf in git actions auch
  nachbauen und testen?" — ja, und der Befund dazu: CI prüft die Bridge heute
  gar nicht.
- **2026-11-17, Abspaltung:** dieser Abschnitt war Teil von `docs/39`; der
  Spec-Review hat ihn dort als zweites Inkrement beanstandet (M8) und die
  Teilung verlangt.
