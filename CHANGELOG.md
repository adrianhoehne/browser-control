# Changelog

Alle nennenswerten Änderungen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [SemVer](https://semver.org/lang/de/).

## [Unreleased]

**Das portable Zip.** `bash scripts/bundle.sh` baut je Plattform ein Zip —
Binary, XPI, Startskript und zwei Anleitungen —, das ohne Installation läuft.

- **Inhalt (sieben Einträge):** Ordner-Eintrag, `browser-control-bridge`, die
  XPI, `start.sh`, `README.txt`, `FIREFOX.md`, `CLIENTS.md`; Windows mit `.exe`
  und `start.cmd` (CRLF, kein WSL). Startskript und Binary liegen mit `0755` im
  Archiv.
- **`start.sh` / `start.cmd`** legen `data/token` beim ersten Lauf an
  (`openssl rand -hex 32`, Rückfall `/dev/urandom`; Windows
  `RandomNumberGenerator`), überschreiben es nie, drucken genau drei Zeilen und
  werden das Binary mit `--http`. Nichts wird außerhalb des Ordners geschrieben.
- **`docs/portable/FIREFOX.md` und `CLIENTS.md`** — Englisch nach STE100: die
  XPI in `about:debugging` laden, Endpunkt und Token eintragen; pi, Codex,
  OpenCode plus ein generisches JSON- und TOML-Muster.
- **Neu:** `scripts/bundle.sh`, `npm run test:bundle` (9 Fälle in
  `test/bundle/bundle.test.js`); `npm test` bleibt binary-frei.
- `docs/39` und `docs/41` sind `active`.

## [0.4.0] — 2026-11-15

**Die Einstellungsseite der Erweiterung ist englisch.** Das Projekt ist
öffentlich und die Doku ist englisch; die Optionen folgen jetzt.

- Labels: „Endpoint URL", „Token", „Allow password fields", „Allow code
  evaluation", „Allow screenshots", „Save"; die Hinweistexte sind übersetzt,
  `lang="en"`.
- Die Statuszeilen der Seite („Saved.", „Settings could not be loaded.") ebenso.
- **Unverändert deutsch** bleiben die Meldungen, die der Agent sieht
  (Werkzeugfehler, Logzeilen) — sie richten sich an den Betreiber, nicht an den
  Browser.
- 760 Tests (die Manifest-Pins prüfen die englischen Labels).

## [0.3.0] — 2026-11-15

**Der Endpunkt muss nicht mehr getippt werden.** Läuft die Bridge auf derselben
Maschine, ist das Feld in den Add-on-Einstellungen mit `ws://127.0.0.1:8110`
vorbelegt — dem Port, den die Bridge per Default bindet. Es bleibt sichtbar und
änderbar; ein gespeicherter Wert, etwa hinter Caddy, gewinnt unverändert.

- Gilt nur für ein **leeres** Feld; nichts wird in `storage.local`
  zurückgeschrieben.
- Ein leerer **Token** verhindert die Verbindung weiterhin.
- Ein Test wacht darüber, dass Optionsseite und Hintergrund denselben Wert
  tragen **und** dass er zum `DEFAULT_BIND` der Bridge passt.
- 760 Tests.

## [0.2.0] — 2026-11-15

**Installation in einem Befehl.** `scripts/install.sh` legt das Token an,
installiert die systemd-User-Unit, aktiviert und startet den Dienst und prüft
ihn — dann sagt es, was in Firefox noch zu tun ist.

- **Idempotent:** ein zweiter Lauf ändert nichts, was stimmt; ein vorhandenes
  Token wird nie überschrieben.
- **Das Token erscheint genau einmal**, auf dem Terminal — nicht in einer
  zweiten Datei, nicht im Journal.
- **Kein `sudo`**, geschrieben wird nur nach `~/.config/browser-control/` und
  `~/.config/systemd/user/`; jeder Schreibvorgang läuft durch einen
  Pfadwächter.
- **Vorprüfungen vor dem ersten Schreibvorgang:** Node ≥ 22, Klonpfad,
  beschreibbares `$HOME`, freie Ports (mit Besitzer).
- Optionen: `--dry-run`, `--print-token`, `--fix-path`, `--uninstall`,
  `--help`; Exit `0`/`1`/`2` wie die Bridge.
- **21 neue Tests** (`test/install.test.js`) mit temporärem `HOME` und Stubs —
  nichts am echten System. Insgesamt 757 Tests.

**Doku:** `README.md` und `INSTALL.md` sind englisch (Specs bleiben deutsch);
`CONTRIBUTING.md` ersetzt `AGENTS.md` und beschreibt denselben Ablauf.

## [0.1.0] — 2026-11-12

Erste Fassung, aus 34 Specs gebaut (`docs/`).

**Werkzeuge (13):** `browser_status`, `navigate`, `read`, `click`, `type`,
`focus`, `inspect`, `open_tab`, `close_tab`, `eval`, `screenshot`, `frames`,
`transcript`.

**Bridge:** WebSocket zur Erweiterung (`127.0.0.1:8110`), MCP über HTTP
(`127.0.0.1:8111/mcp`, Bearer-Token), ein systemd-User-Dienst, persistenter
Hintergrunddienst ohne Portsuche, Log im Journal.

**Erweiterung (MV2):** Agenten-Tabs im Default-Container (höchstens fünf),
Ruhe-Erkennung für `navigate`/`click`, Frames und Shadow DOM, Screenshots,
Protokollierung ohne Seitentext.

**`browser_transcript`:** liest das YouTube-Transkript als Segmente mit
Zeitstempeln, in der Originalspur des Videos — die signierte Spurendatei wird
über `webRequest` mitgeschnitten, die Spur bei Bedarf im Player gesetzt, und
Spur wie Abspielposition werden danach zurückgestellt.

**Sicherheit:** drei Schalter in den Add-on-Einstellungen
(Passwortfelder, Code-Auswertung, Bildschirmfotos), alle aus per Voreinstellung;
keine Secrets im Repo; Token nur im Dateisystem des Betreibers.

**Bekannte Grenzen:** die Erweiterung ist unsigniert (temporär zu laden, nach
einem Firefox-Neustart erneut); Windows nur teilweise (Spec 29/30); ein
YouTube-Spurenetikett kann falsch sein, und Spracherkennung ist kein Ziel.
