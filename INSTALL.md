# Installation

Zwei Seiten, in dieser Reihenfolge: **der Server** (Token, Caddy, Bridge) und der
**Rechner mit Firefox** (Extension). Wer nur einen Teil macht, sieht entweder
`502` (Bridge fehlt) oder gar nichts (Extension fehlt).

Bezug: `docs/01-skelett-verbindung-und-status.md` — dort stehen `## Configuration`
(Defaults, Variablen) und die Abnahmekriterien; hier steht, was zu tippen ist.

## 1. Token-Datei anlegen (auf dem Server)

Die Bridge startet nicht ohne Token: fehlt die Datei oder ist sie zu kurz, endet
sie mit Exit-Code 2 und der Zeile `token file missing or too short: <pfad>`.

```bash
install -d -m 700 ~/.config/browser-control
openssl rand -hex 32 > ~/.config/browser-control/token
chmod 600 ~/.config/browser-control/token
```

Kontrolle:

```bash
ls -l ~/.config/browser-control/token   # -rw------- (600)
wc -c < ~/.config/browser-control/token # 65 = 64 Hex-Zeichen + Zeilenumbruch
```

Der Zeilenumbruch ist in Ordnung: die Bridge trimmt den Inhalt, bevor sie ihn
vergleicht. Der Pfad ist der Default von `BC_TOKEN_FILE`; wer ihn ändert
(`BC_TOKEN_FILE=…`), muss denselben Pfad beim Start der Bridge setzen.

Derselbe Wert kommt später in die Optionsseite der Extension (Schritt 4) —
nicht in eine URL und nicht ins Repo. Prüfung:

```bash
git grep --untracked -nE '[0-9a-f]{32,}' -- .   # keine Ausgabe, Exit 1
```

### Token wechseln

Ein Wechsel ist Handarbeit und braucht **keinen** Code — das ist bewusst so: es gibt
genau einen Betreiber und einen Dienst, und ein Wechsel ist selten (Verdacht auf
Abfluss, neuer Rechner). In dieser Reihenfolge, mit kurzer Unterbrechung:

```bash
# 1. Neues Token schreiben (die alte Datei wird ersetzt)
openssl rand -hex 32 > ~/.config/browser-control/token
chmod 600 ~/.config/browser-control/token

# 2. Dienst neu starten — er liest das Token nur beim Start
systemctl --user restart browser-control

# 3. Neuen Wert in die Optionsseite der Extension eintragen und speichern
#    (about:addons → browser-control → Einstellungen)
```

Zwischen Schritt 2 und 3 ist die Erweiterung **abgemeldet** — sie versucht es mit
Backoff weiter und verbindet sich, sobald das neue Token in ihren Optionen steht.
Wer die Reihenfolge umdreht (erst Extension, dann Dienst), hat dasselbe Fenster,
nur in der anderen Richtung; beides ist unkritisch, weil nichts verloren geht.

**Merke:** Ein Tokenwechsel braucht **zwei** Stellen — die Datei (für Bridge und
`/mcp`) und die Extension-Optionen. Wer nur eine ändert, sieht `auth failed` im
Journal der Bridge.

## 2. Caddy: der WS-Pfad vor der Basic-Auth (auf dem Server)

Die Extension spricht `wss://example.com/browser-control/ws`; Caddy
beendet TLS und leitet an die Bridge auf `127.0.0.1:8110` weiter. Der Site-Block
bedient heute Basic-Auth, und ein Browser-`WebSocket` kann keinen
`Authorization`-Header setzen — der Pfad muss also aus der Auth heraus.

Wichtig ist die Form: **ein `handle` allein genügt nicht.** In Caddys
Direktivenreihenfolge läuft `basic_auth` vor `handle`, eine Site-weite Auth also
auch vor dem WS-Zweig; zwei `handle`-Blöcke darunter ändern daran nichts. Die
Auth muss **in den zweiten `handle` wandern**, dann schließen sich die Zweige
aus (gleiche Gruppe, erster Treffer gewinnt) und der WS-Zweig liegt vorn:

```
example.com {
    # Die Extension authentifiziert sich mit dem Token im hello-Frame.
    handle /browser-control/ws {
        reverse_proxy 127.0.0.1:8110
    }

    handle {
        # … bestehende Konfiguration, inklusive basic_auth …
    }
}
```

Der Upstream muss **`127.0.0.1`** heißen, nicht `localhost`: Caddy löst
`localhost` im Zweifel nach `[::1]` auf, die Bridge lauscht per Default nur auf
`127.0.0.1`, und die Folge ist ein `502` bei laufender Bridge (im Caddy-Log:
`dial tcp [::1]:8110: connect: connection refused`).

Prüfen und laden:

```bash
caddy validate --config /etc/caddy/Caddyfile   # Exit 0
systemctl reload caddy
```

## 3. Bridge starten (auf dem Server)

```bash
cd ~/browser-control
mkdir -p ~/.local/state/browser-control
nohup node bridge/bridge.mjs >> ~/.local/state/browser-control/bridge.log 2>&1 < /dev/null &
```

Das `< /dev/null` ist wichtig, nicht Zierde: endet stdin, beendet sich die
Bridge (so verschwindet sie, wenn pi sie als MCP-Server startet). Ohne die
Umleitung bekommt sie beim Start über `ssh host 'nohup … &'` eine Pipe statt
`/dev/null` und stirbt beim ersten EOF.

Kontrolle:

```bash
ss -ltn | grep 8110          # LISTEN … 127.0.0.1:8110
tail -1 ~/.local/state/browser-control/bridge.log
# 2026-…Z listening on 127.0.0.1:8110 log=info
```

Für die Handprüfung mit Tab-Liste: `BC_LOG=debug nohup node bridge/bridge.mjs …`
starten, dann steht das Ergebnis als eingerücktes JSON im Log.

Beenden: `kill <pid>`, oder alle Instanzen
`for p in $(ps -eo pid,args | awk '/node bridge\/bridge\.mjs/ && !/awk/ {print $1}'); do kill "$p"; done`.

**Nicht dauerhaft**: der Prozess überlebt das Schließen des Terminals, aber
keinen Reboot und keinen Absturz. Einen systemd-Dienst gibt es noch nicht (siehe
„Nicht abgedeckt").

## 4. Extension im Firefox (Rechner mit Browser)

Die Extension ist **unsigniert**; sie wird darum als *temporäre* Erweiterung
geladen. Ein XPI zum Herunterladen gibt es nicht — Quelle ist das Repo:

```bash
# von GitHub (der veröffentlichte Stand)
git clone https://github.com/<besitzer>/browser-control.git ~/browser-control

# oder per SSH von deinem eigenen Rechner, wenn du dort entwickelst
git clone <user>@<host>:browser-control ~/browser-control
```

Ohne git, nur die Extension:

```bash
mkdir -p ~/browser-control-extension
rsync -av --delete <user>@<host>:browser-control/extension/ ~/browser-control-extension/
```

Dann in Firefox:

1. `about:debugging#/runtime/this-firefox` öffnen.
2. „Temporäre Erweiterung laden…".
3. **`extension/manifest.json` auswählen** (im Klon:
   `~/browser-control/extension/manifest.json`) — nicht den Ordner, nicht die
   einzelnen Dateien.
4. Rechtsklick auf das Symbol → „Add-on-Einstellungen" (oder `about:addons` →
   Browser Control → Einstellungen).
5. Endpunkt eintragen: `wss://example.com/browser-control/ws`
6. Token eintragen: Inhalt von `~/.config/browser-control/token` auf dem Server.
7. „Speichern", dann die Erweiterung in `about:debugging` **einmal neu laden** —
   gespeicherte Optionen wirken erst beim nächsten Verbindungsaufbau.

Seit Spec 34 steht **`webRequest`** im Manifest: nach dem Reload zeigt
`about:addons` unter Berechtigungen zusätzlich das Beobachten von
Netzwerkanfragen. Sie ist nötig, damit `browser_transcript` die signierte
Adresse der Untertitelspur mitschneiden kann — ohne sie gäbe es für das Werkzeug
nichts zu lesen.

Die Erweiterungs-ID ist fest (`browser-control@bergkaese.dev`), Endpunkt und
Token bleiben deshalb in `storage.local` über Reloads hinweg. **Nach einem
Firefox-Neustart** ist die Erweiterung weg und muss neu geladen werden — die
Einstellungen bleiben erhalten.

Aktualisieren, wenn sich im Repo etwas ändert:

```bash
cd ~/browser-control && git pull
```

… dann „Reload" im `about:debugging`.

## 5. Die Bridge als Dienst (empfohlen)

Seit Spec 18 läuft die Bridge **einmal als systemd-User-Unit** und bietet MCP über
HTTP an. Damit teilen sich alle Clients (pi und jeder andere MCP-Client) **einen**
Dienst: kein Portkonflikt mehr, keine verwaiste Bridge nach einem Neustart, und die
Werkzeuge sind sofort da.

```bash
mkdir -p ~/.config/systemd/user
cp ~/browser-control/deploy/browser-control.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now browser-control
systemctl --user status browser-control     # active (running)
journalctl --user -u browser-control -f     # Log, inklusive Logrotation
```

Der Dienst bindet **fest** `127.0.0.1:8110` (Erweiterung) und `127.0.0.1:8111`
(MCP). Er sucht **keinen** freien Port: ist einer belegt, endet er mit `1` und einer
Zeile, die den Besitzer nennt (`port 127.0.0.1:8111 in use, owner pid=… name=…`).

Die Bindungen und Pfade lassen sich über die Umgebung der Unit ändern
(`systemctl --user edit browser-control` → `[Service] Environment=…`):

| Variable | Voreinstellung | Wirkung |
|---|---|---|
| `BC_BIND` | `127.0.0.1:8110` | Adresse der Erweiterungs-Verbindung (`[::1]:8110` für IPv6) |
| `BC_HTTP_PORT` | `8111` | Port für `POST /mcp` |
| `BC_TOKEN_FILE` | `~/.config/browser-control/token` | wo das Token liegt |
| `BC_LOG` | `info` | `debug` schreibt das JSON jeder Anfrage ins Journal |
| `BC_CALL_TIMEOUT_MS`, `BC_HELLO_TIMEOUT_MS` | Protokollwerte | Fristen; nur zum Debuggen ändern |

**Sitzung und Reboot — was ohne weiteres Zutun gilt:** die Unit läuft in **deinem**
systemd (`systemctl --user`), und das endet mit deiner letzten Sitzung. Solange ein
Terminal, tmux- oder SSH-Fenster offen ist, läuft der Dienst also. Nach einem Reboot
startet er **mit deinem Login**, nicht davor — und genau dann startet auch Firefox,
also ist die Reihenfolge in Ordnung.

**Nur wenn du ihn ohne Login laufen lassen willst** (etwa um nach einem Reboot aus
der Ferne über die Erweiterung zu arbeiten), brauchst du einmalig:

```bash
loginctl enable-linger "$USER"
```

Das lässt den Benutzer-systemd beim Booten starten und nach dem Logout weiterlaufen —
mit dem Preis, dass der Dienst dann **immer** läuft, auch wenn niemand da ist. Wer
ohnehin ständig eingeloggt ist, braucht es nicht; die Entscheidung vom 2026-10-23 war:
**nicht setzen.**

**Wenn der Dienst nicht startet und `env: node: No such file` im Journal steht:** der
`PATH` einer User-Unit ist minimal, eine nvm-Installation (oder pis eigene
Node-Installation) ist dort unsichtbar. Dann **nicht** die Repo-Unit ändern, sondern
eine lokale Drop-in-Datei anlegen — so bleibt die Unit maschinenunabhängig:

```bash
mkdir -p ~/.config/systemd/user/browser-control.service.d
cat > ~/.config/systemd/user/browser-control.service.d/path.conf <<'EOF'
[Service]
Environment=PATH=%h/.local/share/pi-node/current/bin:/usr/local/bin:/usr/bin:/bin
EOF
systemctl --user daemon-reload && systemctl --user restart browser-control
```

Den Pfad `%h/.local/share/pi-node/current/bin` nur nehmen, wenn er existiert
(`command -v node`); sonst den eigenen eintragen. `current` ist ein Symlink auf die
aktive Version und übersteht ein node-Update.

### Client über HTTP (empfohlen, harness-neutral)

Jeder MCP-Client, der streamable HTTP und einen `Authorization`-Header kann:

```json
{
  "mcpServers": {
    "browser-control": {
      "url": "http://127.0.0.1:8111/mcp",
      "headers": { "Authorization": "Bearer ${BROWSER_CONTROL_TOKEN}" }
    }
  }
}
```

Das Token kommt aus der **Umgebung** (`BROWSER_CONTROL_TOKEN`); es ist dasselbe, das
in `~/.config/browser-control/token` liegt. Ein Client, der die Variable nicht selbst
auflöst, setzt sie in seiner eigenen Konfiguration.

So sieht es für pi aus (`~/.pi/agent/mcp.json`, unter `mcpServers`):

```json
{
  "mcpServers": {
    "browser-control": {
      "url": "http://127.0.0.1:8111/mcp",
      "headers": { "Authorization": "Bearer ${BROWSER_CONTROL_TOKEN}" }
    }
  }
}
```

### Rückfallweg: stdio (der alte Eintrag bleibt gültig)

Clients, die nur einen Prozess starten können, spawnen die Bridge selbst:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["~/browser-control/bridge/bridge.mjs"]
    }
  }
}
```

Dieser Weg läuft **nicht neben** dem Dienst: Port `8110` wäre doppelt belegt, die
gespawnte Bridge endet mit `1`. Für den stdio-Weg also den Dienst stoppen
(`systemctl --user stop browser-control`).

**`/mcp` ist loopback-only und darf nie über einen Proxy veröffentlicht werden.**
Wer den Port nach außen reicht, gibt dem eingeloggten Firefox samt Token einen
öffentlichen Eingang.

### Werkzeuge

**Dreizehn**, alle mit dem Präfix `browser_`:
`status` (Fenster und Tabs als JSON, Agenten-Tabs mit `agent: true`), `open_tab`
(legt einen Agenten-Tab an, höchstens fünf), `close_tab`, `navigate`, `read`,
`click`, `type`, `focus`, `inspect`, `eval`, `screenshot`, `frames` (iframes des
Tabs) und `transcript` (Untertitel als Segmente mit Zeitstempeln).

**Drei Verhalten sind per Voreinstellung aus** und antworten bis zum Umlegen mit
einem benannten Fehler (`eval_not_allowed`, `screenshot_not_allowed`,
Passwortfeld abgelehnt). Die Schalter stehen in den Add-on-Einstellungen:

| Schalter (Schlüssel) | Was er erlaubt |
|---|---|
| „Passwortfelder erlauben" (`allowPasswordFields`) | `browser_type` darf `input[type=password]` füllen |
| „Code-Auswertung erlauben" (`allowEval`) | `browser_eval` führt Code im Agenten-Tab aus — inklusive `document.cookie`, `localStorage` und `fetch` mit den Cookies des Profils; hebt zusätzlich die Passwortfeld-Sperre auf |
| „Bildschirmfotos erlauben" (`allowScreenshot`) | `browser_screenshot` nimmt den sichtbaren Ausschnitt des Agenten-Tabs auf — das eingeloggte Profil |

Ein Umstellen wirkt sofort (der Wert wird bei jedem Aufruf gelesen); der Agent
schaltet **keinen** dieser Schalter selbst um, das entscheidet der Betreiber
(`CONTRIBUTING.md`).

`browser_navigate` legt beim ersten Aufruf einen **Agenten-Tab** an: ein normaler Tab
im Default-Container, im Hintergrund, den du in der Tableiste siehst. Mit
`browser_open_tab` kommen weitere dazu — **bis zu fünf**; jeder ist über den
Parameter `tab` einzeln adressierbar, ohne `tab` gilt der zuletzt benutzte. Schließt
du einen, rücken die anderen nach.

Seit `browser_read` steht bei der Erweiterung in `about:addons` **„Zugriff auf alle
Websites"** — die bewusste Entscheidung des Betreibers, damit der Agent Seiten lesen
kann. Sie liest nur, was sie lesen soll: den adressierten Agenten-Tab, und nur wenn
ein Werkzeug aufgerufen wird.

## 6. Prüfen

Nach Änderungen im Repo muss die Extension **einmal neu geladen** werden
(`about:debugging` → Reload), sonst läuft der alte Background im Speicher
weiter — ein neues Werkzeug wie `transcript` fehlt ihm dann. **Hat sich das
Manifest geändert** (Berechtigungen), ist der Reload ebenfalls der einzige
Schritt; die neue Berechtigung steht danach in `about:addons`.

Erst die Naht, ohne Firefox:

```bash
curl -isS --http1.1 -o /dev/null -w '%{http_code}\n' --max-time 10 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://example.com/browser-control/ws
```

`--http1.1` ist Pflicht, nicht Kosmetik: curl verhandelt sonst HTTP/2 mit Caddy,
und ein h2-Request wird als normale Anfrage an den h1-Upstream weitergereicht.
Firefox spricht für `wss://` ohnehin HTTP/1.1.

| Ausgabe | Bedeutung |
|---|---|
| `101` | Naht steht |
| `401` | Basic-Auth greift noch (Auth steht auf Site-Ebene statt im zweiten `handle`) |
| `426` | Bridge lebt, sah aber keine Upgrade-Anfrage — fast immer fehlt `--http1.1` |
| `502` | Caddy kommt durch, aber die Bridge lauscht nicht auf dem Upstream |

Dann im Bridge-Log:

```
2026-…Z extension connected peer=127.0.0.1 protocol=1
2026-…Z status windows=<n> tabs=<m>
```

Mit `BC_LOG=debug` steht darunter das JSON. Erwartung: alle Tabs des
Default-Containers, **kein** Tab aus einem Multi-Account-Container und kein Tab
aus einem privaten Fenster.

Kommt keine Zeile: zuerst in der Konsole **der Erweiterung** nachsehen
(`about:debugging` → „Untersuchen"), nicht in der Web-Konsole der Seite. Dort
steht `bc: background page started`, `bc: Endpunkt ungültig: …` oder nichts.
Schweigen heißt meistens: Endpunkt oder Token leer, oder der Reload aus
Schritt 4.7 fehlt.

## Nicht abgedeckt

- **Signierung und XPI-Auslieferung** — die Erweiterung ist temporär, nach einem
  Firefox-Neustart neu zu laden.
- **Der stdio-Rückfall neben dem Dienst** — Port `8110` wäre doppelt belegt (siehe
  §5); entweder Dienst oder stdio.
- **Token-Rotation und mehrere Tokens** — ein Token, eine Extension; wer es
  ersetzt, muss es an beiden Seiten tauschen.
- **Automatisches Neuladen der Extension nach Optionsänderung** — deshalb
  Schritt 4.7.
