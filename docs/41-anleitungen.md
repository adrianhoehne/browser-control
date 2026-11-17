---
description: Zwei Anleitungen für das portable Paket — Firefox mit der XPI und die MCP-Clients pi, Codex, OpenCode; Englisch nach ASD-STE100, als Schreibregel ohne Prüfskript.
status: proposed
---

# Die zwei Anleitungen

Das portable Zip (`docs/39`) enthält zwei Texte, die den Nutzer führen sollen,
ohne dass er etwas über das Projekt wissen muss:

- `FIREFOX.md` — von „Firefox starten" bis „die Erweiterung ist geladen".
- `CLIENTS.md` — von „der Server läuft" bis „der Client sieht die Werkzeuge".

Diese Spec ist abgespalten (`CONTRIBUTING.md`, Schritt 4: nach dem dritten Block
wird geteilt). `docs/39` beschreibt das Paket, diese Spec den Text darin.

**Was sie nicht tut:** keinen automatischen Stil-Lint. STE100 ist eine
Schreibregel, kein Prüfschritt (Betreiberentscheid 2026-11-17). Kein
`ste-lint`, keine Schwelle, kein CI-Job.

## Ziel

- **Beide Texte sind Englisch und folgen ASD-STE100:** nummerierte Schritte,
  Befehlsform, höchstens 20 Wörter je Anweisung, ein Name je Sache, Warnung
  **vor** dem Schritt, den sie betrifft.
- **Sie liegen im Repo** unter `docs/portable/` (kein `NN-`-Präfix, kein
  Frontmatter: es sind Nutzertexte, keine Specs) und werden von
  `scripts/bundle.sh` ins Zip kopiert — eine Quelle, keine zweite Fassung.
- **Sie sind vollständig:** wer sie abarbeitet, hat eine offene Seite im
  Browser beziehungsweise eine funktionierende MCP-Verbindung. Nichts bleibt
  „dem Leser überlassen".
- **Sie sagen die Grenzen:** die Erweiterung ist temporär, das Token steht in
  einer Datei, OpenCode legt das Token in seiner Konfiguration ab.

## Non-goals

- **Kein Signieren, kein AMO.** Die XPI bleibt unsigniert; die Anleitung sagt
  das nicht als Entschuldigung, sondern als Schritt („Load Temporary Add-on").
- **Kein mitgeliefertes Firefox.**
- **Keine Screenshots.** Text, der in einem Terminal funktioniert, ist länger
  haltbar als ein Bild von einer Menüleiste.
- **Kein automatischer Lint** (siehe oben).

## `FIREFOX.md`

Die Schritte, in dieser Reihenfolge:

1. Firefox starten.
2. In die Adresszeile `about:debugging#/runtime/this-firefox` eintippen und
   Enter drücken.
3. „Load Temporary Add-on…” wählen.
4. Im Dateidialog **die XPI-Datei** aus dem entpackten Ordner auswählen
   (`browser-control-<version>.xpi`).
5. Die Einstellungen der Erweiterung öffnen.
6. Als Endpunkt `ws://127.0.0.1:8110` eintragen.
7. Das Token aus der Zeile `token: …` des Startfensters eintragen.
8. Speichern.
9. Die Erweiterung in `about:debugging` einmal neu laden.

**Die Warnung steht am Anfang, nicht am Ende:** als Schritt 2, direkt vor dem
Laden — „The extension is temporary. After a Firefox restart it is gone. Repeat
steps 3 to 9. The endpoint and the token stay saved." Wer sie erst nach dem
letzten Schritt liest, hat sie zu spät gelesen.

Ein Schlusssatz: dass im Startfenster `endpoint:` und `http:` stehen und welche
Adresse wofür gilt (Extension bekommt `ws://…:8110`, der MCP-Client
`http://…:8111/mcp`).

## `CLIENTS.md`

Die Schritte, in dieser Reihenfolge:

1. Den Server starten (`start.sh` beziehungsweise `start.cmd`).
2. Aus dem Startfenster die Zeile `http: …` und die Zeile `token: …` nehmen.
3. **pi** — Eintrag in `~/.pi/agent/mcp.json`, **mit** der Hülle:

   ```json
   { "mcpServers": { "browser-control": {
       "url": "http://127.0.0.1:8111/mcp",
       "headers": { "Authorization": "!echo Bearer $(cat <pfad>/data/token)" } } } }
   ```

   Der `!`-Wert liest das Token beim Start, statt es in die Datei zu schreiben.

4. **Codex** — `codex mcp add browser-control --url http://127.0.0.1:8111/mcp
   --bearer-token-env-var BC_TOKEN`, dazu die Zeile, die `BC_TOKEN` in der Shell
   setzt (`export BC_TOKEN=$(cat <pfad>/data/token)`).
5. **OpenCode** — `opencode mcp add browser-control --url
   http://127.0.0.1:8111/mcp --header "Authorization=Bearer <token>"`, mit dem
   Hinweis, dass dieser Client das Token in seiner Konfiguration ablegt.
6. **Generisches Muster** — ein JSON- und ein TOML-Ausschnitt für Clients, die
   hier nicht genannt sind: Server-URL, Kopfzeile `Authorization: Bearer …`.
7. Prüfen: der Client listet **dreizehn** Werkzeuge. `browser_status` aufrufen,
   mit `browser_open_tab` eine Seite öffnen, mit `browser_read` ihren Text
   lesen. Die Namen erscheinen je Client unterschiedlich (pi stellt
   `mcp__browser-control__` voran, Codex und OpenCode zeigen sie
   unverändert) — die Anleitung nennt beide Schreibweisen.
8. Schlusssatz: dasselbe Token gilt für Firefox **und** den Client.

Die Befehle in Schritt 4 und 5 sind am 2026-11-17 gegen die installierten CLIs
geprüft (`codex` 0.154.0, `opencode` 2.2.6).

## Dependency changes

**Keine.**

## Testing

Es gibt keinen Testfall für Prosa. Geprüft wird die **Struktur**, damit ein
fehlender Schritt auffällt:

| Datei | Fall | Was er beweist |
|---|---|---|
| `test/bundle/bundle.test.js` | `guides_shouldStartAtStepOne` | beide Dateien beginnen mit `1.` und haben mindestens fünf numerierte Schritte |
| `test/bundle/bundle.test.js` | `guides_shouldNameThePrintedLines` | `CLIENTS.md` enthält die drei Zeilen, die `start.sh` druckt, in derselben Form (`endpoint: `, `http: `, `token: `) |

## Acceptance criteria

1. **Beide Dateien existieren und sind gegliedert.** `grep -c '^1\. '
   docs/portable/FIREFOX.md docs/portable/CLIENTS.md` ⇒ je **1**;
   `grep -cE '^[0-9]+\. ' docs/portable/FIREFOX.md` ⇒ **≥ 9**,
   `grep -cE '^[0-9]+\. ' docs/portable/CLIENTS.md` ⇒ **≥ 7**.
2. **Sie nennen die richtigen Adressen.** `grep -c 'ws://127.0.0.1:8110'
   docs/portable/FIREFOX.md` ⇒ **≥ 1**; `grep -c
   'http://127.0.0.1:8111/mcp' docs/portable/CLIENTS.md` ⇒ **≥ 3** (pi, Codex,
   OpenCode).
3. **Sie warnen vor der Temporär-Eigenschaft, bevor sie beißt.**
   `grep -ci 'temporary' docs/portable/FIREFOX.md` ⇒ **≥ 1**, und die erste
   Fundstelle steht **vor** dem letzten numerierten Schritt:
   `test "$(grep -ni 'temporary' docs/portable/FIREFOX.md | head -1 | cut -d: -f1)"
   -lt "$(grep -nE '^[0-9]+\. ' docs/portable/FIREFOX.md | tail -1 | cut -d: -f1)"`
   ⇒ Exit **0**.
4. **Kein Werkzeugname ist erfunden.** Die drei Namen in `CLIENTS.md`
   (`browser_open_tab`, `browser_status`, `browser_read`) kommen in
   `docs/portable/CLIENTS.md` **und** in `scripts/parity/expected/1-initialize-and-tools-list.txt`
   vor: `grep -c` je Name in beiden Dateien ⇒ je ≥ 1.
5. **Das Zip enthält sie.** `unzip -Z1
   dist/browser-control-<version>-linux-x86_64.zip | grep -cE
   '/(FIREFOX|CLIENTS)\.md$'` ⇒ **2**.
6. **Kein Stil-Lint im Baum.** `grep -rl 'ste-lint' package.json scripts test
   .github 2>/dev/null; echo $?` ⇒ **1** (die Specs selbst nennen das Wort, weil
   sie die Entscheidung dokumentieren — sie zählen nicht).

## Dev plan

**Stufe 1 — `FIREFOX.md`**

Dateien: `docs/portable/FIREFOX.md`.

Inhalt nach dem Abschnitt oben, Englisch, STE100 als Schreibregel.

Beweis: Kriterien 1, 2, 3.

**Stufe 2 — `CLIENTS.md`**

Dateien: `docs/portable/CLIENTS.md`.

Beweis: Kriterien 1, 2, 4.

**Stufe 3 — Struktur-Tests und Zip**

Setzt `docs/39`, Stufe 1 voraus (dort entstehen `scripts/bundle.sh` und
`test/bundle/bundle.test.js`).

Dateien: `test/bundle/bundle.test.js` (die zwei Fälle aus `## Testing`),
`scripts/bundle.sh` (kopiert `docs/portable/*.md` ins Zip).

Beweis: Kriterium 5; `npm run test:bundle` ⇒ `# fail 0`.

## Bekannte Lücken

- **Niemand prüft den Stil.** Die Regeln sind aufgeschrieben, ihre Einhaltung
  nicht. Ein neuer Satz mit 40 Wörtern fällt keinem Test auf.
- **Die Befehle der Clients können sich ändern.** Geprüft am 2026-11-17 gegen
  `codex 0.154.0` und `opencode 2.2.6`; eine neue Version kann andere Flags
  haben.
- **Der Nutzer liest Englisch.** Wer kein Englisch kann, ist auf die
  Firefox-Oberfläche angewiesen — bewusste Entscheidung (`## Open questions`
  von `docs/39`).

## Open questions

**Keine.**

## Review

### Runde 1 — steht aus

## Log

- **2026-11-17, Abspaltung:** Diese Spec war der Abschnitt „Die zwei
  Anleitungen" in `docs/39`. Der dritte Block im Spec-Review von `docs/39` hat
  die Teilung erzwungen (`CONTRIBUTING.md`, Schritt 4).
- **2026-11-17, Betreiberentscheid:** Englisch nach STE100, **ohne**
  automatischen Lint.
- **2026-11-17, Betreiberentscheid:** MCP-Hauptweg ist der HTTP-Endpunkt;
  Clients pi, Codex, OpenCode plus ein generisches Muster.
