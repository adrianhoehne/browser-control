---
description: Ein Installationsskript für die Server-Seite — Token, systemd-Unit, Dienststart und Prüfung in einem Befehl, idempotent, ohne Firefox-Automatisierung; die vier Schritte in der Extension bleiben Handarbeit.
status: proposed
---

# Das Installationsskript

Die Einrichtung der Server-Seite besteht heute aus vierzehn Befehlen in drei
Abschnitten. Sie sind einzeln richtig, aber in der falschen Reihenfolge
gefährlich (Dienst vor Token ⇒ Exit 2) und in der Summe fehleranfällig. Diese
Spec bündelt sie in **einem** Befehl.

**Was das Skript nicht kann und nicht versucht:** die Extension in Firefox laden
oder ihre Optionen füllen. Firefox erlaubt keiner Seite und keinem Skript den
Zugriff auf `about:debugging`, und `storage.local` gehört der Extension. Diese
vier Schritte bleiben Handarbeit — das Skript bereitet sie vor und sagt, was
fehlt.

## Ziel

- **Ein Befehl** auf dem Server: `./scripts/install.sh` legt das Token an,
  installiert die systemd-User-Unit, aktiviert und startet den Dienst und prüft
  ihn. Danach steht da, was in Firefox noch zu tun ist — mit Endpunkt und Token
  zum Einfügen.
- **Idempotent.** Ein zweiter Lauf ändert nichts, was schon stimmt. Ein
  **vorhandenes Token wird nie überschrieben** — Rotation bleibt Handarbeit
  und eine Entscheidung des Betreibers.
- **Das Token erscheint genau einmal**, auf stdout, mit der Aufforderung, es
  jetzt einzufügen. Nicht in einer Datei außer der Tokendatei, nicht im
  Journal, nicht in einer Logzeile des Skripts.
- **Nichts außerhalb von drei Orten.** Geschrieben wird nur nach
  `~/.config/browser-control/`, `~/.config/systemd/user/` (und deren
  `browser-control.service.d/`) und `~/.local/state/browser-control/`. **Kein
  `sudo`**, kein systemweiter Dienst.
- **Vorprüfungen vor dem ersten Schreibvorgang:** Node ≥ 22, freie Ports
  `8110`/`8111` (mit Namensnennung des Besitzers), lesbarer Repo-Pfad,
  beschreibbares `$HOME`. Was fehlt, wird **vor** dem Schreiben gemeldet.
- **Deutsche Ausgabe**, englische Kommentare im Code — wie im Projekt üblich.
- **Kein neues Werkzeug, keine Abhängigkeit.** Bash und die Werkzeuge, die
  ohnehin gebraucht werden (`openssl`, `systemctl`, `ss`, `node`).

## Non-goals

- **Keine Firefox-Automatisierung.** Kein `about:debugging`, kein Policy-File,
  kein Native Messaging.
- **Kein Caddy, kein TLS.** Der öffentliche Endpunkt bleibt der optionale
  Anhang in `INSTALL.md`.
- **Keine Token-Rotation.** Das Skript legt ein Token an, wenn keins da ist;
  ein vorhandenes rührt es nicht an.
- **Kein `git clone`.** Das Skript läuft aus dem Klon.
- **Kein zweiter Installationsweg.** Wer die Einzelbefehle will, findet sie
  weiter in `INSTALL.md`; das Skript ersetzt sie nicht als Wahrheit, sondern
  bündelt sie.

## Die Entscheidungen

| Frage | Entscheidung |
|---|---|
| Wird ein vorhandenes Token überschrieben? | **nein** — es wird geprüft (Länge, Rechte) und sonst gemeldet |
| Darf das Skript `sudo` benutzen? | **nein** — User-Unit, User-Token, User-State |
| Darf es die PATH-Drop-in-Datei schreiben? | **nur mit `--fix-path`**, und nur wenn `node` nicht in `/usr/bin` liegt |
| Darf es den Dienst entfernen? | **nur mit `--uninstall`**, und das Token bleibt dabei stehen |
| Token-Schwelle | **32 Hex-Zeichen**, wie `bridge/config.mjs` — was die Bridge akzeptiert, lehnt das Skript nicht ab; 32–63 Zeichen mit Hinweis |
| Was passiert bei belegten Ports? | Meldung mit Besitzer (`ss`), Abbruch **vor** dem Schreiben; ein laufender eigener Dienst zählt nicht als Konflikt |

## Die Optionen

| Option | Wirkung |
|---|---|
| *(ohne)* | installieren oder reparieren, dann prüfen und den Rest ansagen |
| `--dry-run` | alles zeigen, nichts schreiben, nichts starten |
| `--print-token` | das vorhandene Token ausgeben, sonst nichts tun |
| `--fix-path` | die Drop-in-Datei für `PATH` schreiben, wenn `node` nicht in `/usr/bin` liegt |
| `--uninstall` | Dienst stoppen und deaktivieren, Unit entfernen; **Token bleibt** |
| `--help` | die Optionen und was sie tun |

**Exit-Codes:** `0` Erfolg; `1` Vorprüfung gescheitert (Node, Ports, `$HOME`);
`2` Token fehlt oder ist unbrauchbar. `2` ist derselbe Code, den die Bridge für
denselben Zustand benutzt.

## Testing

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/install.test.js` | `install_helpPrintsTheOptionsAndWritesNothing` | `--help`: Exit `0`, alle Optionen genannt, nichts geschrieben |
| `test/install.test.js` | `install_withOldNode_abortsBeforeWriting` | fehlendes Node oder Major < 22 ⇒ Exit `1`, keine Datei |
| `test/install.test.js` | `install_withOpenPort_abortsBeforeWriting` | belegter Port ⇒ Exit `1`, Meldung mit Port und PID, kein Token |
| `test/install.test.js` | `install_withMissingUnitTarget_abortsBeforeWriting` | Klon nicht unter `~/browser-control` ⇒ Exit `1`, Meldung nennt beide Pfade |
| `test/install.test.js` | `install_dryRunWritesNothing` | `--dry-run`: Schritte genannt, `readTree(home)` unverändert, kein `systemctl` |
| `test/install.test.js` | `install_createsTokenWithTightPermissions` | Tokendatei `600`, 65 Bytes, Verzeichnis `700` |
| `test/install.test.js` | `install_withAnExistingToken_doesNotTouchIt` | zweiter Lauf: `sha256`, `mtimeNs` und Modus unverändert |
| `test/install.test.js` | `install_withTooShortToken_exitsTwo` | 10-Zeichen-Token ⇒ Exit `2`, Datei byte-gleich |
| `test/install.test.js` | `install_withAShortButUsableToken_keepsGoing` | 32 Zeichen ⇒ Exit `0` mit Hinweis (die Bridge akzeptiert es) |
| `test/install.test.js` | `install_printTokenPrintsOnlyTheToken` | `--print-token`: nur das Token, kein `systemctl`, kein Schreiben |
| `test/install.test.js` | `install_installsAndStartsTheUnit` | Unit liegt unter `~/.config/systemd/user/`; `daemon-reload` vor `enable --now`, danach `is-active` |
| `test/install.test.js` | `install_isIdempotent` | zweiter Lauf: `openssl` einmal, Unit-`mtimeNs` gleich, eigener Dienst kein Portkonflikt |
| `test/install.test.js` | `install_uninstallKeepsTheToken` | `--uninstall`: `disable --now`, Unit weg, Token bleibt |
| `test/install.test.js` | `install_fixPathWritesTheDropInOnlyWhenNeeded` | `--fix-path` schreibt `path.conf` nur, wenn nötig; ohne Flag entsteht sie nicht |
| `test/install.test.js` | `install_printsTheTokenOnce` | Token genau einmal auf stdout, nirgends sonst |
| `test/install.test.js` | `install_writesOnlyUnderHome` | jede neue Datei liegt unter den drei erlaubten Pfaden |
| `npm test` | `# fail 0`, `# cancelled 0`, `# skipped 0` | nichts ist kaputt (auf einem Host mit nicht-interner IPv4) |
| `bash -n scripts/install.sh` | Exit 0 | Syntax |

Die Tests fahren das Skript als **Prozess** mit einem temporären `HOME` und einem
**Stub-Verzeichnis am Anfang von `PATH`** (`systemctl`, `ss`, `openssl`) — nichts
am echten System. `test/install.test.js` ist neu; das Skript selbst bindet keinen
Port, `test/ports.js` bleibt unberührt.

## Acceptance criteria

**Jedes Kriterium nennt zwei Belege:** dass der Fall im Dateitext steht
(`grep -cE '^test\("<name>'` ⇒ **1**) **und** dass er grün läuft
(`node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - <name>'`
⇒ **1**). Ein Name im Text beweist nichts.

1. **Ein Befehl richtet ein.** Auf leerem, temporärem `HOME` (mit Stubs)
   hinterlässt `./scripts/install.sh`: Tokendatei `600`/65 Zeichen, Unit unter
   `~/.config/systemd/user/`, und `systemctl --user daemon-reload` sowie
   `enable --now browser-control` wurden gerufen, danach `is-active`.
   Beweis: `install_installsAndStartsTheUnit`.
2. **Idempotent, Token unangetastet.** Zweiter Lauf: Tokendatei byte-gleich
   (`sha256`), Unit nicht neu geschrieben (`mtimeNs`), `openssl` genau einmal.
   Beweis: `install_withAnExistingToken_doesNotTouchIt`, `install_isIdempotent`.
3. **`--dry-run` schreibt nichts.** Beweis: `install_dryRunWritesNothing`.
4. **Vorprüfungen greifen vor dem ersten Schreibvorgang.** Fehlendes Node,
   falsche Version, belegter Port und ein Klon außerhalb `~/browser-control`
   enden mit Exit `1`, ohne Datei. Beweis: `install_withOldNode_abortsBeforeWriting`,
   `install_withOpenPort_abortsBeforeWriting`,
   `install_withMissingUnitTarget_abortsBeforeWriting`.
5. **Token-Codes wie die Bridge.** Unter 32 Hex-Zeichen ⇒ Exit `2` mit Pfad,
   Datei unverändert; 32–63 Zeichen ⇒ akzeptiert (die Bridge startet damit) mit
   einem Hinweis auf die 64 Zeichen aus `INSTALL.md`. Beweis:
   `install_withTooShortToken_exitsTwo`, `install_withAShortButUsableToken_keepsGoing`.
6. **Das Token bleibt geheim.** Es steht auf `stdout` genau einmal und in der
   Tokendatei — nicht in einer zweiten Datei, nicht in `stderr`, nicht in einem
   Stub-Log. Beweis: `install_printsTheTokenOnce`,
   `install_printTokenPrintsOnlyTheToken`.
7. **`--uninstall` lässt das Token stehen.** Beweis:
   `install_uninstallKeepsTheToken`.
8. **`--fix-path` schreibt nur, wenn nötig** — nämlich wenn `node` nicht in
   `/usr/bin` liegt; ohne das Flag entsteht kein Drop-in. Beweis:
   `install_fixPathWritesTheDropInOnlyWhenNeeded`.
9. **Nichts außerhalb der drei Orte, kein `sudo`.** Dynamisch: jede neue Datei
   liegt unter `~/.config/browser-control/`, `~/.config/systemd/user/` oder
   `~/.local/state/browser-control/` (`install_writesOnlyUnderHome`).
   Statisch: `grep -cE '(>|>>)[[:space:]]*/(etc|usr|var|opt|srv|root)'
   scripts/install.sh` ⇒ **0**; `grep -c 'sudo' scripts/install.sh` ⇒ **0**
   (das Wort kommt auch in keiner Ausgabezeile vor).
10. **Syntax und Abnahme.** `bash -n scripts/install.sh` ⇒ **0**;
    `npm test` ⇒ `# fail 0`, `# cancelled 0`, `# skipped 0` (auf einem Host mit
    nicht-interner IPv4-Adresse — `test/bridge.test.js` überspringt sich sonst
    selbst, unabhängig von diesem Inkrement); `npm run check` ⇒ 0.
11. **Die Doku verweist darauf.** `INSTALL.md` nennt das Skript als **einfachen**
    Weg und die Einzelbefehle als Weg daneben; `README.md` nennt es im
    „Quick start". Beweis: `grep -c 'scripts/install.sh' INSTALL.md` ⇒ **≥ 1**;
    `grep -c 'scripts/install.sh' README.md` ⇒ **≥ 1**.
12. **Kein Produktcode außerhalb der Grenze.** Beweis:
    `git status --porcelain` ⇒ nur `scripts/install.sh`,
    `test/install.test.js`, `INSTALL.md`, `README.md`, `docs/…`;
    `git diff -- package.json` ⇒ leer; `git diff -- extension/ bridge/` ⇒ leer.
13. **Die Hilfsoptionen sind belegt.** `--help` nennt alle Optionen, ändert
    nichts und ruft kein `systemctl`. Beweis:
    `install_helpPrintsTheOptionsAndWritesNothing`.

## Dev plan

**Der Zuschnitt.** Eine neue Datei `scripts/install.sh` bündelt die vierzehn
Befehle aus `INSTALL.md` §2/§3 zu einem Lauf, und eine neue Testdatei
`test/install.test.js` fährt sie als Prozess mit temporärem `HOME` und Stubs.
Kein Produktcode im engeren Sinn, kein `package.json`-Eingriff, keine neue
Abhängigkeit.

**Was den Plan bindet** (aus den Dateien gelesen, nicht vermutet):

- `deploy/browser-control.service` trägt
  `ExecStart=/usr/bin/env node %h/browser-control/bridge/bridge.mjs --http` —
  der Klonpfad ist **fest** (`INSTALL.md` §4 klont nach `~/browser-control`).
  Die Unit wird deshalb **byte-gleich kopiert**, nicht umgeschrieben; ein Klon
  an anderem Ort ist ein Vorprüfungsfehler, kein stiller Defekt.
- `test/deploy.test.js` pinnt die Unit-Zeilen und verbietet `/home/` und
  tokenförmige Strings — die *Quelle* bleibt unangetastet, das Skript liest sie
  nur.
- `bridge/config.mjs` (`MIN_TOKEN_LENGTH = 32`, `HEX_ONLY`) und
  `bridge/bridge.mjs` (`token file missing or too short: <pfad>`,
  `process.exit(2)`) sind der Token-Vertrag; Exit `2` im Skript meint dasselbe.
- `bridge/port-owner.mjs` nennt Besitzer über `/proc`, **nicht** über `ss`. Das
  Skript fragt `ss` (Spec) — zwei Wege für dieselbe Auskunft; die Meldung des
  Skripts darf nicht wie die der Bridge aussehen.
- `ss -ltnp` liefert auf diesem Host
  `LISTEN 0 512 127.0.0.1:49374 0.0.0.0:* users:(("opencode",pid=…,fd=8))` —
  genau diese Form muss der `ss`-Stub nachbilden, sonst prüft der Test den Stub.
- `test/ports.js` hält `8110`/`8111` für den Betreiber frei; `test/install.test.js`
  **bindet keinen Port** (nur Stubs) ⇒ kein neuer Eintrag, `test/ports.test.js`
  bleibt unberührt.
- `package.json` (`test/*.test.js`) nimmt die neue Datei automatisch mit;
  `scripts/check.mjs` prüft nur `.js`/`.mjs` ⇒ `install.sh` fällt dort nicht
  hinein.
- Testhaus: `spawnSync`/`mkdtempSync` mit `t.after`-Aufräumen
  (`test/check.test.js`), `spawn(..., { env })` mit **nur** den gesetzten
  Variablen (`test/bridge.test.js`).
- `README.md` („736 cases") und `docs/PROJECT-STATE.md` („736 Tests") werden
  durch die neuen Fälle falsch; die README-Zeile fällt unter Kriterium 11.

**Vier Entscheidungen, die die Spec offenließ** (der Plan legt sie fest):

1. **Token-Schwelle = 32 Hex-Zeichen**, wie `bridge/config.mjs`. Ein Token mit
   32–63 Zeichen wird **akzeptiert** (die Bridge startet damit) und mit einem
   deutschen Hinweis auf die 64 Zeichen aus `INSTALL.md` quittiert; unter 32
   ⇒ Exit `2`. Eine strengere Grenze im Skript wäre ein Fehlalarm: sie würde
   ein Token ablehnen, das die Bridge akzeptiert.
2. **Repo-Pfad-Vorprüfung**: (a) `${repo_root}/bridge/bridge.mjs` lesbar,
   (b) das `ExecStart`-Ziel der Unit (`$HOME/browser-control/bridge/bridge.mjs`)
   existiert. Fehlt (b), Exit `1` mit beiden Pfaden. Folge für die Tests: die
   Sandbox legt `home/browser-control/bridge/bridge.mjs` an.
3. **`--fix-path` installiert mit** und schreibt zusätzlich das Drop-in;
   erster `PATH`-Eintrag ist `%h/.local/share/pi-node/current/bin`, wenn dieses
   Verzeichnis existiert, sonst `dirname "$(command -v node)"`.
4. **Unbekannte Option** ⇒ deutsche Meldung + Kurzhilfe + Exit `1`.

**Schreibgrenze als Mechanik.** Alle Schreibvorgänge laufen durch zwei
Funktionen mit Pfadwächter — `ensure_dir(path, mode)` und
`put_file(path, mode)` —, die vor dem Schreiben prüfen, dass `path` unter
`$HOME/.config/browser-control/`, `$HOME/.config/systemd/user/` (inkl.
`browser-control.service.d/`) oder `$HOME/.local/state/browser-control/` liegt,
und sonst mit Exit `1` abbrechen. Nur so ist „nichts außerhalb der drei Orte"
eine Eigenschaft des Codes.

---

**1. Gerüst: Optionen, Ausgabe, Exit-Codes, Vorprüfungen — und das Testgerüst**
(Umsetzer)

Dateien: `scripts/install.sh` (neu), `test/install.test.js` (neu).

- `scripts/install.sh`: `#!/usr/bin/env bash`, `set -euo pipefail`; Konstanten
  für die Pfade; `repo_root()` über `${BASH_SOURCE[0]}` (nie `$(pwd)`);
  `usage()`; `parse_args()` mit den Modi `install`, `dry-run`, `print-token`,
  `fix-path`, `uninstall`, `help`; `say()/step()/die()`; `guard_path()`;
  `ensure_dir()`/`put_file()` (in dieser Stufe nur definiert, noch kein Aufruf).
- Vorprüfungen **vor** jedem Schreiben, mit Bash-Builtins plus `ss`:
  `check_node_version()` (Major ≥ 22), `check_repo_path()` (Entscheidung 2),
  `check_home_writable()`, `check_ports()` (`ss -ltnp`, Ports `8110`/`8111`,
  Besitzer aus `users:(("name",pid=N`; „Besitzer nicht ermittelbar", wenn `-p`
  nichts liefert), `own_service_pid()` (`systemctl --user show
  --property=MainPID --value browser-control`) — ein belegter Port mit der
  `MainPID` des eigenen Dienstes ist **kein** Konflikt.
- `--help`: Exit `0`, keine Vorprüfung, kein Schreibzugriff. `--dry-run`:
  Vorprüfungen laufen, dann je Schritt eine deutsche Zeile, kein
  `systemctl`-Aufruf, kein Schreibzugriff.
- `test/install.test.js`: `makeSandbox(t)` → `{ root, home, stubs, logPath }`
  (`mkdtempSync`, `home/browser-control/bridge/bridge.mjs` angelegt,
  `t.after` räumt auf); `writeStub(dir, name, body)` (Modus `0o755`);
  `runInstall(sandbox, args)` = `spawnSync(BASH, [SCRIPT, ...args], { env: {
  HOME, PATH: stubs:/usr/bin:/bin, BC_INSTALL_STUB_LOG }, encoding: "utf8" })` —
  nur diese Variablen, nie `process.env`.
- Stubs: `systemctl` protokolliert `--user $*`; `ss` gibt
  `$BC_INSTALL_STUB_SS` aus; `openssl` erzeugt **zur Laufzeit** 64 Hex-Zeichen
  (`head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'`) und protokolliert den
  Aufruf. **Kein 64-Hex-Literal in der Datei** — es würde den Secret-Grep der
  Abnahme rot machen.
- Fälle: `install_helpPrintsTheOptionsAndWritesNothing` (Exit `0`, alle sechs
  Optionen genannt, `readTree(home)` unverändert, keine `systemctl`-Zeile),
  `install_withOldNode_abortsBeforeWriting` (Node-Stub `v20.11.1` ⇒ Exit `1`,
  keine Datei; zweiter Lauf ohne `node` im `PATH` ⇒ dieselbe Meldung),
  `install_withOpenPort_abortsBeforeWriting` (Port `8110` mit fremder PID ⇒
  Exit `1`, Meldung mit Port und PID, kein Token),
  `install_withMissingUnitTarget_abortsBeforeWriting` (Sandbox ohne
  `home/browser-control` ⇒ Exit `1`, keine Datei, Meldung nennt beide Pfade),
  `install_dryRunWritesNothing` (Exit `0`, Schritte genannt, `readTree` gleich,
  kein `systemctl`).

Proof:

```
bash -n scripts/install.sh; echo $?                                    # ⇒ 0
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 5
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_(help|withOldNode|withOpenPort|withMissingUnitTarget|dryRun)'   # ⇒ 5
```

---

**2. Das Token — anlegen, prüfen, nie überschreiben** (Umsetzer)

Dateien: `scripts/install.sh`, `test/install.test.js`.

- `token_is_usable()`: Inhalt trimmen, `^[0-9a-f]+$` (case-insensitiv),
  Länge ≥ 32 (Entscheidung 1); zu kurz ⇒ deutsche Meldung mit Pfad, Exit `2` —
  dasselbe Wort „zu kurz" wie `bridge/bridge.mjs`.
- `ensure_token()`: existiert die Datei, wird sie **gelesen und geprüft**, nie
  angefasst; Rechte ≠ `600` werden gemeldet, nicht stillschweigend korrigiert.
  32–63 Zeichen ⇒ Hinweis, weiter. Sonst `umask 077` **in einer Subshell**,
  `openssl rand -hex 32 > "$TOKEN_FILE"`, danach `chmod 600`.
- `--print-token`: Token lesen und nur ausgeben; fehlt es ⇒ Exit `2`.
- Fälle: `install_createsTokenWithTightPermissions` (Datei `600`, 65 Bytes,
  Verzeichnis `700`, Inhalt `^[0-9a-f]{64}\n$`);
  `install_withAnExistingToken_doesNotTouchIt` (`sha256`, `mtimeNs` und Modus
  vor/nach gleich, Ausgabe sagt „bleibt");
  `install_withTooShortToken_exitsTwo` (10 Zeichen ⇒ Exit `2`, Inhalt
  byte-gleich);
  `install_withAShortButUsableToken_keepsGoing` (32 Zeichen ⇒ Exit `0`,
  Hinweis, Datei unverändert);
  `install_printTokenPrintsOnlyTheToken` (`stdout` ist die Tokendatei, keine
  `systemctl`-Zeile; ohne Token Exit `2`).

Proof:

```
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 10
git grep --untracked -nE '[0-9a-f]{32,}' -- scripts/install.sh test/install.test.js              # keine Ausgabe, Exit 1
```

---

**3. Unit installieren, Dienst starten und prüfen — idempotent** (Umsetzer)

Dateien: `scripts/install.sh`, `test/install.test.js`.

- `ensure_unit()`: `ensure_dir "$UNIT_DIR"`; Ziel fehlt ⇒ `put_file` mit dem
  **byte-gleichen** Inhalt von `${repo_root}/deploy/browser-control.service`
  (Modus `644`); Ziel vorhanden und identisch (`cmp -s`) ⇒ Zeile „Systemd-Unit
  ist schon aktuell", kein Schreiben.
- `start_service()`: `daemon-reload`, `enable --now`, dann
  `is-active --quiet`; nicht `active` ⇒ deutsche Meldung mit
  `journalctl --user -u browser-control`, Exit `1`.
- Fälle: `install_installsAndStartsTheUnit` (Datei vorhanden, Log zeigt
  `daemon-reload` vor `enable --now browser-control`, danach `is-active`);
  `install_isIdempotent` (zweiter Lauf: `openssl` genau **einmal**, Unit-
  `mtimeNs` unverändert, Token-`sha256` gleich; der `ss`-Stub meldet im zweiten
  Lauf die `MainPID` des eigenen Dienstes ⇒ kein Konflikt).
- Zwischen den Läufen ≥ 50 ms, damit `mtimeNs` als Beweis trägt.

Proof:

```
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 12
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_(installsAndStartsTheUnit|isIdempotent)'   # ⇒ 2
```

---

**4. `--uninstall` und `--fix-path`** (Umsetzer)

Dateien: `scripts/install.sh`, `test/install.test.js`.

- `uninstall()`: `systemctl --user disable --now` (Fehler tolerieren: ein nie
  gestarteter Dienst ist kein Abbruch), `rm -f` der Unit, `rmdir` des leeren
  Drop-in-Verzeichnisses. `TOKEN_DIR`, `TOKEN_FILE` und `STATE_DIR` bleiben.
  **Keine Vorprüfungen** — Entfernen muss auch nach einem Umzug des Klons gehen.
- `ensure_dropin()`: nur im Modus `fix-path`, nur wenn
  `dirname "$(command -v node)"` nicht `/usr/bin` ist; schreibt nur, wenn die
  Datei fehlt oder abweicht.
- Fälle: `install_uninstallKeepsTheToken` (`disable --now` im Log, Unit weg,
  Token mit gleichem `sha256` und Modus `600` da);
  `install_fixPathWritesTheDropInOnlyWhenNeeded` (mit `--fix-path` und
  Node-Stub außerhalb `/usr/bin`: `path.conf` mit `[Service]` und
  `Environment=PATH=<stubs>:…`; ohne `--fix-path`: kein
  `browser-control.service.d`; zweiter Lauf: `mtimeNs` unverändert).

Proof:

```
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 14
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_(uninstall|fixPath)'   # ⇒ 2
```

---

**5. Grenze und Geheimnis — die zwei Nachweise über den ganzen Lauf**
(Umsetzer)

Dateien: `test/install.test.js` (`readTree()`, `sha256()`, `textFilesUnder()`);
`scripts/install.sh` nur, wenn ein Befund etwas zu reparieren gibt.

- `install_printsTheTokenOnce`: voller Lauf; Token aus der Tokendatei; Vorkommen
  in `stdout` ⇒ `1`, in `stderr` ⇒ `0`, in den Stub-Logs ⇒ `0`, in jeder Datei
  unter `home` **außer** der Tokendatei ⇒ `0`.
- `install_writesOnlyUnderHome`: `readTree(home)` vor/nach; jede **neue** Datei
  und jedes neue Verzeichnis unter den drei erlaubten Pfaden.

Proof:

```
node --test --test-reporter=tap test/install.test.js | grep -cE '^ok [0-9]+ - install_'          # ⇒ 16
grep -c 'sudo' scripts/install.sh                                                                # ⇒ 0
grep -cE '(>|>>)[[:space:]]*/(etc|usr|var|opt|srv|root)' scripts/install.sh                      # ⇒ 0
```

---

**6. Die Doku verweist darauf** (Umsetzer; `INSTALL.md` und `README.md` sind
öffentlich und bleiben englisch)

Dateien: `INSTALL.md`, `README.md`.

- `INSTALL.md`: in §2 ein Unterabschnitt vor den Einzelbefehlen — `./scripts/install.sh`
  als **einfacher** Weg, die Einzelbefehle darunter als der Weg, der zeigt, was
  passiert; Optionstabelle und Exit-Codes `0`/`1`/`2`; der Satz, dass ein
  vorhandenes Token nie überschrieben wird.
- `README.md`: in „Quick start" `./scripts/install.sh` als erster Schritt, die
  Handbefehle als „what it does"; die Testzahl aus der `# tests N`-Zeile des
  Laufs **ablesen**, nicht schätzen.

Proof:

```
grep -c 'scripts/install.sh' INSTALL.md                     # ⇒ ≥ 1
grep -c 'scripts/install.sh' README.md                      # ⇒ ≥ 1
npm test 2>&1 | grep -E '^# (tests|fail|cancelled|skipped)' # tests N; fail/cancelled/skipped = 0
npm run check; echo $?                                      # ⇒ 0
git status --porcelain                                      # nur scripts/install.sh, test/install.test.js, INSTALL.md, README.md
```

Nicht Teil der Stufen: `docs/README.md` (Status-Zeile), `docs/PROJECT-STATE.md`
und `status: active` — das ist Schritt 7 beim Orchestrator.

---

### What had to change in the Acceptance criteria

Acht Punkte waren nicht so prüfbar, wie sie dastanden; sie sind in
`## Acceptance criteria` korrigiert:

1. **Kriterium 12 widersprach Kriterium 11** (`git status` erlaubte `INSTALL.md`
   und `README.md` nicht, obwohl Kriterium 11 sie verlangt) → beide sind jetzt
   in der Liste.
2. **Kriterien 1–9 bewiesen ihre Fälle nicht:** `grep -c 'install_x'` zählt
   einen Namen im Dateitext. Jetzt je Kriterium **zwei** Belege: die scharfe
   Form `grep -cE '^test\("install_x'` ⇒ 1 **und** der grüne Lauf
   `grep -cE '^ok [0-9]+ - install_x'` ⇒ 1.
3. **Kriterium 6/9, „nichts außerhalb":** dynamisch nur innerhalb `$HOME`
   prüfbar → zusätzlich eine statische Probe auf Schreibziele außerhalb
   (`grep -cE '(>|>>)[[:space:]]*/(etc|usr|var|opt|srv|root)'` ⇒ 0).
4. **Kriterium 9, `sudo`:** das Wort darf im Skript **gar nicht** vorkommen —
   auch nicht in einer Ausgabezeile „kein sudo nötig".
5. **Kriterium 8** ist nur halb prüfbar: den Fall „Node liegt in `/usr/bin`"
   kann ein Stub-Test nicht herstellen (Root nötig) → Kriterium prüft die
   schreibende Seite; die `/usr/bin`-Bedingung steht in `## Bekannte Lücken`.
6. **Kriterium 10, `# skipped 0`** ist hostabhängig (`test/bridge.test.js`
   überspringt sich auf Hosts ohne nicht-interne IPv4-Adresse) → Kriterium
   nennt den Abnahme-Host.
7. **`--help` und `--print-token`** standen in der Optionstabelle, aber in
   keinem Fall → zwei Zusatzfälle (`…_helpPrintsTheOptionsAndWritesNothing`,
   `…_printTokenPrintsOnlyTheToken`).
8. **Die Repo-Pfad-Vorprüfung hatte kein Kriterium** → `…_withMissingUnitTarget_abortsBeforeWriting`.

### What could go wrong

- **`grep` unter `set -euo pipefail`.** `ss … | grep -q ':8110'` liefert `1`,
  wenn der Port frei ist, und beendet mit `pipefail` das Skript, bevor es
  schreibt. Jede solche Zeile braucht `|| true` **mit** Kommentar.
- **`umask 077` leckt.** Global gesetzt bekäme die Unit `600` statt `644` — sie
  gehört in eine Subshell um den Token-Schreibvorgang.
- **Das Token im Prozessargument.** Nie als Argument an `openssl`, `systemctl`
  oder `ss`; nur Redirect beim Anlegen, nur die eine `printf`-Zeile beim
  Ausgeben, kein `set -x`.
- **`mtimeNs` als Beweis.** Inhalt allein beweist „nicht neu geschrieben" nicht,
  und grobe Dateisysteme legen zwei Schreibvorgänge in dieselbe Marke → ≥ 50 ms
  zwischen den Läufen und **beide** Zusicherungen.
- **Der `ss`-Stub prüft sich selbst,** wenn er die Spaltenform nicht nachbildet.
  Zusätzlich ein Fall mit `-p`-loser Ausgabe, damit „Besitzer nicht
  ermittelbar" nicht in einen `set -u`-Abbruch läuft.
- **Der tokenförmige String im Repo.** Ein fest verdrahtetes 64-Hex-Token im
  Stub macht den Secret-Grep der Abnahme rot → Laufzeit-Erzeugung.
- **Sandbox ohne Klon.** Ohne `home/browser-control/bridge/bridge.mjs` scheitert
  jede Stufe an der Vorprüfung → `makeSandbox` legt es an, und
  `install_writesOnlyUnderHome` zählt nur **neue** Einträge.
- **`--fix-path`-Inhalt.** `INSTALL.md` nennt `%h/.local/share/pi-node/current/bin`
  **nur, wenn es existiert** — sonst `dirname(node)`. Ein fester String macht den
  Test auf der Maschine des Betreibers falsch.

### Ordering and dependencies

1 → 2 → 3 → 4 → 5 → 6. Stufe 1 legt Wächter, Vorprüfungen und Sandbox an —
**vor** dem ersten Schreibvorgang; ohne sie ist „Vorprüfung vor dem Schreiben"
nicht nachrüstbar. Stufe 2 ist der erste Schreiber (Token); Stufe 3 setzt sie
voraus (ohne Token startet der Dienst nicht). Stufe 4 setzt Stufe 3 voraus.
Stufe 5 prüft das Ganze und darf reparieren, aber keine Funktionen bringen.
Stufe 6 kommt zuletzt, weil die README-Zahl aus dem fertigen Lauf kommt.
Nicht angefasst: `package.json`, `test/ports.js`, `deploy/`, `bridge/`,
`extension/`, `scripts/check.mjs`.

### What the next increment inherits

- **Token-Rotation** als eigener Befehl — hier bewusst nicht (`## Non-goals`).
- **Der echte systemd-Lauf** auf einer fremden Distribution: die Tests prüfen
  Aufrufe, nicht Wirkung.
- **`--fix-path`-Zweig `/usr/bin`** und **`is-active`-Fehlschlag** sind nur im
  echten Lauf entscheidbar.
- **Klon an anderem Ort als `~/browser-control`**: heute Exit `1` mit Meldung;
  ein `ExecStart=`-Drop-in wäre der saubere Ausweg, ist aber eine eigene Spec.
- **macOS/Windows, Caddy, `ss`-lose Systeme** bleiben in `## Bekannte Lücken`.

## Bekannte Lücken

Stand 2026-11-12, vor der Umsetzung:

- **Kein Test gegen ein echtes systemd.** Die Tests prüfen die Aufrufe über
  Stubs; ob der Dienst auf einer fremden Distribution wirklich startet, sagt
  erst der Lauf dort.
- **Nicht abgedeckt: macOS und Windows.** Das Skript ist Linux + systemd.
- **Caddy bleibt Handarbeit** — das Skript kennt keinen Proxy.
- **Der Zweig „node liegt in `/usr/bin`" von `--fix-path` ist nicht per Stub
  prüfbar** (dafür bräuchte es Root); der Test deckt die schreibende Seite ab,
  die Bedingung selbst entscheidet erst der echte Lauf.
- **`is-active` schlägt fehl** (Dienst startet nicht): der Pfad ist implementiert
  und dokumentiert, aber kein Test stellt ihn her.
- **Ein Klon außerhalb `~/browser-control`** endet mit Exit `1`; ein
  `ExecStart=`-Drop-in wäre der saubere Ausweg, ist aber eine eigene Spec.
- **`ss` fehlt auf manchen Systemen.** Dann kann der Portbesitzer nicht genannt
  werden; die Spec verlangt eine Meldung, nicht den Namen.

## Open questions

**Keine offenen, die den Bau blockieren.** Entschieden am 2026-11-12 vom
Betreiber: Skript bauen, mit Tests und Review; Firefox-Schritte bleiben
Handarbeit.

## Review

### Runde 1 — steht aus

Die Spec geht durch das Gate, sobald Ziel und Kriterien abgesprochen sind.

## Log

- **2026-11-12, Betreiberentscheid:** Installationsskript bauen (statt nur die
  Anleitung zu kürzen), mit Tests und Review; die Extension bleibt Handarbeit.
