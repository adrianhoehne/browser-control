---
description: Teil 1 des Rust-Projekts — Werkzeugkette, eine baubare Gerüst-Binary für Linux und Windows und der Paritätsmaßstab (sieben Vergleiche gegen eingecheckte Soll-Artefakte, Selbsttest 7/7), bevor eine Zeile Bridge portiert wird.
status: proposed
---

# Die Rust-Bridge, Teil 1: Werkzeugkette und Paritätsmaßstab

Die Bridge soll nach Rust portiert werden (`docs/38-rust-port.md`, Teil 2). **vor**
dem Port wird das gemessen, was „paritätisch" überhaupt heißt: ein Prüflauf mit
eingefrorenen Soll-Artefakten, gegen den beide Implementierungen antreten.

**Warum zwei Teile.** Das Spec-Gate hat die gemeinsame Fassung **dreimal**
blockiert (`docs/37`, Runden 1–3). `CONTRIBUTING.md`, Schritt 4: „Nach dem
dritten Block ist die Spec zu groß — teilen, nicht durchwinken." Die Naht ist
„Maßstab" gegen „Port", weil ein Maßstab, der falsch misst, jeden Port-Beweis
wertlos macht.

## Ziel

- **Die Werkzeugkette steht** und ist dokumentiert: `rustup`, die Ziele
  `x86_64-unknown-linux-musl` und `x86_64-pc-windows-gnu`, ein Mingw-Linker.
  Auf bigdelli fehlt heute alles drei (gemessen 2026-11-16).
- **Ein Gerüst baut für beide Ziele.** `bridge-rs/` mit `Cargo.toml`, einem
  `[[bin]]` und `main.rs` ohne Verhalten; `cargo build --release --target
  x86_64-unknown-linux-musl` liefert ein **statisch gelinktes** ELF, derselbe
  Befehl mit `--target x86_64-pc-windows-gnu` eine `.exe`. Damit ist bewiesen,
  dass der Cross-Build auf dieser Maschine überhaupt geht — die Frage, die sonst
  erst Wochen später auffällt.
- **Der Paritätsmaßstab steht und ist falsifizierbar.** `scripts/parity.sh`
  zeichnet **sieben** Vergleiche von der Node-Bridge auf, checkt sie als
  Soll-Artefakte ein (`scripts/parity/expected/`), und `--check` misst jede
  Implementierung dagegen. `--self-test` mutiert **je Vergleich eines** der
  sieben Artefakte und muss **7/7** Unterschiede melden.
- **Der Maßstab beschreibt den heutigen Code.** `--impl node --check` ⇒ 7/7 —
  sonst ist das Artefakt falsch, nicht die Bridge.

## Non-goals

- **Kein Port der Module.** Werkzeuge, Hub, Frames, HTTP kommen in Teil 2
  (`docs/38`). Hier entsteht kein Verhalten, nur der Maßstab und ein Gerüst.
- **Keine Löschung von `bridge/`.** Der Node-Weg bleibt unangetastet; die 764
  Tests laufen weiter.
- **Keine Abhängigkeiten im Gerüst.** `Cargo.toml` bleibt leer bis Teil 2.
- **Kein Windows-Dienst, kein Installer, keine Amendments.** Alles Teil 2.
- **Kein macOS, kein arm64.**

## Die Entscheidungen des Betreibers (2026-11-16)

Rust als **Ersatz** (nicht Parallelbetrieb auf Dauer), paralleler Aufbau mit
Löschung erst nach Parität, Zielplattformen **Linux und Windows x86_64**.
Teil 1 setzt davon nur den Maßstab um.

## Was verglichen wird

Sieben Vergleiche, aus dem Bridge-Verhalten gelesen (Details in `docs/38`,
`## Das Inventar`):

| Nr. | Fälle | Was das Artefakt enthält |
|---|---|---|
| 1 | 2 | `initialize` und `tools/list` — die vollständigen Antworten |
| 2 | 39 | je Werkzeug: Fixture-Erfolg, `error:<code>`, Argument-Verweigerung |
| 3 | 2 | ohne Extension (`ExtensionUnavailable`), Fixture schweigt (`ExtensionTimeout`) |
| 4 | 2 | falsches Token ⇒ Close `4401`, kein `hello` ⇒ Close `4408` |
| 5 | 1 | belegter Port ⇒ Exit `1` mit Besitzerzeile |
| 6 | 1 | fehlende Tokendatei ⇒ Exit `2` mit derselben Zeile |
| 7 | 3 | Logzeilenfolge ohne Zeitstempel (`BC_LOG=info`, `debug`, `debug --http`) |

**Eine Datei je Vergleich** (`scripts/parity/expected/<nr>-<name>.txt`) — sie
enthält die Antworten und Ausgaben des Vergleichs, nicht je Fall eine eigene
Datei. **Eine benannte Ausnahme:** das Zeitstempelpräfix
`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ` wird vor dem Vergleich
gestrichen — dasselbe Muster, das `test/bridge.test.js` schon benutzt.

**Warum nicht rein differentiell:** „Node gegen Rust" ist grün, wenn **beide**
dasselbe Falsche tun — zweimal kein Close-Frame, zweimal Exit `0`, zweimal leere
Logausgabe. Ein Vergleich ohne Sollerwartung misst Gleichheit, nicht
Richtigkeit.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `scripts/parity.sh` | `--impl node --record`, dann `git status scripts/parity/expected` | sieben Soll-Artefakte entstehen und liegen im Baum |
| `scripts/parity.sh` | `--impl node --check` ⇒ 7/7 | der Maßstab beschreibt den heutigen Code |
| `scripts/parity.sh` | `--impl node,node` ⇒ 7/7 | der Lauf ist deterministisch (kein Zufall im Vergleich) |
| `scripts/parity.sh` | `--self-test` ⇒ 7/7 | **jeder** der sieben Vergleiche kann fehlschlagen |
| `scripts/parity.sh` | `--only 5,6` | die Auswahl läuft, die anderen bleiben ungeprüft |
| `cargo build … --target x86_64-unknown-linux-musl` | Exit 0 | das Gerüst baut für Linux |
| `cargo build … --target x86_64-pc-windows-gnu` | Exit 0 | der Cross-Build funktioniert auf dieser Maschine |

## Acceptance criteria

1. **Die Werkzeugkette ist da.** Beweis:
   `rustup target list --installed | grep -cE 'x86_64-(unknown-linux-musl|pc-windows-gnu)'`
   ⇒ **2**; `command -v x86_64-w64-mingw32-gcc` ⇒ Pfad.
2. **Das Gerüst baut für beide Ziele.** Beweis:
   `cargo build --release --manifest-path bridge-rs/Cargo.toml --target
   x86_64-unknown-linux-musl` ⇒ 0; `find
   bridge-rs/target/x86_64-unknown-linux-musl/release -maxdepth 1 -type f
   -executable | wc -l` ⇒ **1**; `cargo build --release --manifest-path
   bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu` ⇒ 0 und `file -b
   bridge-rs/target/x86_64-pc-windows-gnu/release/browser-control-bridge.exe`
   ⇒ `PE32+ executable (console) x86-64`.
3. **Der Maßstab ist eingecheckt.** Beweis:
   `git ls-files scripts/parity/expected | wc -l` ⇒ **7**;
   `bash scripts/parity.sh --impl node --check` ⇒ „7/7 wie erwartet", Exit 0.
4. **Der Maßstab ist falsifizierbar.** Beweis:
   `bash scripts/parity.sh --self-test` ⇒ „7/7 rot wie erwartet", Exit 0 —
   **sieben** Proben für **sieben** Vergleiche.
5. **Der Maßstab ist deterministisch.** Beweis:
   `bash scripts/parity.sh --impl node,node` ⇒ „1..7 identisch", Exit 0.
6. **`bridge/` ist unangetastet.** Beweis: `test -d bridge && echo present` ⇒
   `present`; `git status --porcelain` nennt nur `bridge-rs/`,
   `scripts/parity*`, `docs/…`.
7. **Die 764 Node-Tests laufen weiter.** Beweis: `npm test` ⇒ `# fail 0`,
   `# cancelled 0`, `# skipped 0`; `npm run check` ⇒ 0.
8. **Kein Geheimnis.** Beweis:
   `git grep --untracked -nE '[0-9a-f]{32,}' -- .` ⇒ keine Ausgabe, Exit 1.

## Dev plan

**Stufe 0 — Werkzeugkette** (Betreiber, mit `sudo`)

Gemessen am 2026-11-16: `cargo`, `rustup` und `x86_64-w64-mingw32-gcc` fehlen.
`rustup` installieren, `rustup target add x86_64-unknown-linux-musl
x86_64-pc-windows-gnu`, Mingw-Cross-Linker (`gcc-mingw-w64-x86-64`), dazu
`rustup component add clippy` (Teil 2 braucht es). Gelingt der Linker nicht, ist
die dokumentierte Antwort „Windows wird unter Windows gebaut" — dann wandert
jede Windows-Proof-Zeile dorthin, und das steht in `## Bekannte Lücken`.

**Stufe 1 — Gerüst, das für beide Ziele baut** (Umsetzer)

`bridge-rs/Cargo.toml` (ein `[[bin]]`, **keine** Abhängigkeiten),
`bridge-rs/.gitignore` mit `/target`, `bridge-rs/README.md` (Toolchain,
Cross-Linker, Zielbefehle), `bridge-rs/src/main.rs` ohne Verhalten (gibt
`--version`?). **Kein** `.cargo/config.toml`: Cargo liest Konfiguration ab dem
Arbeitsverzeichnis, ein `[build] target` im Unterordner greift bei
`--manifest-path` aus der Wurzel nicht — `--target` steht deshalb in jedem
Befehl.

Proof:
```
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-unknown-linux-musl; echo $?   # ⇒ 0
file -b bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge | grep -Eq 'statically linked|static-pie linked'; echo $?   # ⇒ 0
cargo build --release --manifest-path bridge-rs/Cargo.toml --target x86_64-pc-windows-gnu; echo $?      # ⇒ 0
```

**Stufe 2 — `scripts/parity.sh` und die Soll-Artefakte** (Umsetzer)

Dateien: `scripts/parity.sh`, `scripts/parity/driver.mjs` (startet eine
Implementierung, spricht JSON-RPC-Zeilen, liest genau eine Antwortzeile mit
Frist), `scripts/parity/hold-port.mjs` (bindet einen Port, wartet auf SIGTERM),
`scripts/parity/ws-probe.mjs` (`--silent`, `--token <t>`, gibt
`code=… reason=…` aus), `scripts/parity/expected/*.txt`. Der Peer ist
**`test/fixtures/fake-extension.mjs`, unverändert** — ein zweiter Ersatz wäre
ein zweiter Maßstab.

Jedes Paar läuft **nacheinander auf demselben Port, mit derselben Tokendatei und
demselben Fixture-Env**; die Soll-Artefakte entstehen per `--record` und werden
**eingecheckt**. Laufzeitartefakte gehen nach `mktemp -d`, nie in den Baum.

Optionen: `--record` (schreibt die sieben Artefakte, nur mit `--impl node`),
`--check` (misst gegen sie), `--impl node|rust|node,node`, `--only 5,6`,
`--keep`, `--self-test` (mutiert je Vergleich eines der sieben Artefakte).

Proof:
```
bash -n scripts/parity.sh; echo $?                            # ⇒ 0
bash scripts/parity.sh --impl node --record                   # ⇒ 7 aufgezeichnet
git ls-files scripts/parity/expected | wc -l                  # ⇒ 7
bash scripts/parity.sh --impl node --check; echo $?           # ⇒ "7/7 wie erwartet", 0
bash scripts/parity.sh --impl node,node; echo $?              # ⇒ "1..7 identisch", 0
bash scripts/parity.sh --self-test; echo $?                   # ⇒ "7/7 rot wie erwartet", 0
npm run check; echo $?                                        # ⇒ 0 (die .mjs-Helfer zählen mit)
```

### What could go wrong

- **Der Maßstab kann grün sein, ohne hinzusehen.** Deshalb `--self-test` mit
  sieben Proben als Kriterium 4 und `--impl node --check` als Kriterium 3: das
  eine zeigt, dass der Vergleich Unterschiede sieht, das andere, dass er den
  heutigen Code beschreibt.
- **Die Artefakte sind handgepflegt.** Wer sie von Hand ändert, ändert den
  Maßstab. `--record` überschreibt sie nur aus der Node-Bridge und nur
  absichtlich; der Commit, der sie ändert, gehört in den `## Log`.
- **Die Ports.** Node behält `18110`–`18114`, der Parity-Lauf nimmt
  `18140`/`18141` — nie `8110`/`8111`, dort läuft der Dienst des Betreibers.
- **Zeitstempel.** Rust muss `toISOString()` exakt nachbilden (drei
  Millisekunden, `Z`), sonst greift der Strip nicht — Teil 2, aber der
  Maßstab muss es wissen.
- **Kein Mingw-Linker.** Dann bleibt Kriterium 2 halb und Windows wandert in
  Teil 2 unter „unter Windows gebaut".
- **Die Fixture ist geteilt.** Sie wird hier nur gestartet, nicht angefasst.

### Ordering and dependencies

0 → 1 → 2. Stufe 1 braucht die Toolchain aus 0; Stufe 2 braucht weder das
Gerüst noch die Toolchain, nur Node und die Fixture — sie kann parallel zu 1
laufen, aber nicht vor 0 (die Ports und die Fixture sind unabhängig).

### What the next increment inherits

Teil 2 (`docs/38-rust-port.md`) erbt: die Werkzeugkette, das baubare Gerüst, den
Maßstab mit sieben eingecheckten Artefakten, `--record`/`--check`/`--self-test`,
den Grundsatz „eine Datei je Vergleich, Zeitstempel gestrichen", und die
Tatsache, dass die Ports `18140`/`18141` dem Parity-Lauf gehören.

## Bekannte Lücken

Stand 2026-11-16:

- **Keine Werkzeugkette auf bigdelli** — Stufe 0 ist eine Betreiber-Aufgabe.
- **Der Cross-Linker ist ungemessen.** Ob `x86_64-w64-mingw32-gcc` hier linkt,
  zeigt Stufe 0; sonst wird Windows unter Windows gebaut.
- **Die Artefakte sind noch nicht erzeugt** — sie entstehen in Stufe 2.

## Open questions

**Keine.** Entschieden am 2026-11-16: Rust, paralleler Aufbau, Linux und Windows
x86_64; geteilt in zwei Teile nach dem dritten Block.

## Review

### Runden 1–3 der gemeinsamen Fassung — 2026-11-16, `grizzled-senior-dev`

Die gemeinsame Fassung (Maßstab **und** Port in einem Dokument) wurde dreimal
blockiert: Runde 1 `🤔` (7 Blocker), Runde 2 `🔧` (8 Punkte), Runde 3 `🔧`
(5 Punkte). Statt einer vierten Runde wurde **geteilt** (`CONTRIBUTING.md`,
Schritt 4) — dieser Teil enthält nur den Maßstab und das Gerüst.

### Runde 4 — steht aus

Teil 1 geht durch das Gate, sobald Ziel und Kriterien abgesprochen sind.

## Log

- **2026-11-16, Betreiberentscheid:** Rust, paralleler Aufbau, Linux und Windows
  x86_64.
- **2026-11-16, Teilung:** nach dem dritten Block der gemeinsamen Fassung
  getrennt in „Maßstab" (`docs/37`, dieser Teil) und „Port" (`docs/38`).
- **Aus Runde 1–3 übernommen in diesen Teil:** Soll-Artefakte statt rein
  differentiellem Vergleich; `--self-test` mit 7 Proben; `--check` in jedem
  Beweis; keine `.cargo/config.toml` (`--target` in jedem Befehl); Ports
  `18140`/`18141`; `git ls-files` statt `git status` für eingecheckte Artefakte.
