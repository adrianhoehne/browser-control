# browser-control

Eine Firefox-Erweiterung steuert den **sichtbaren, eingeloggten Browser** und
eine kleine Bridge macht ihn als **MCP-Server** für Agenten nutzbar. Der Agent
arbeitet in einem eigenen Tab, den du siehst — mit deinen Logins, deinen
Cookies, deinem Profil. Kein Headless-Browser, kein zweites Profil, keine
automatisierte Anmeldung.

```
Agent  ──MCP über HTTP──▶  Bridge (Node)  ──WebSocket──▶  Firefox-Erweiterung
        (Bearer-Token)    127.0.0.1:8111                   Agenten-Tab
```

Die Erweiterung wählt sich **von innen** zur Bridge raus. Deshalb braucht die
Bridge keinen eingehenden Port, und der Agent kann nur Tabs sehen, die er
selbst angelegt hat.

## Was es kann

**Dreizehn Werkzeuge**, alle mit dem Präfix `browser_`:

| Werkzeug | Zweck |
|---|---|
| `status` | Fenster und Tabs als JSON, Agenten-Tabs markiert |
| `navigate`, `read` | Seite öffnen (wartet auf Ruhe), Inhalt als Text lesen |
| `click`, `type`, `focus` | bedienen, tippen, den Tab nach vorn holen |
| `inspect` | DOM abfragen, Selektor und Attribute |
| `open_tab`, `close_tab` | Agenten-Tabs verwalten (höchstens fünf) |
| `eval` | Code im Seitenkontext (**standardmäßig aus**) |
| `screenshot` | sichtbarer Ausschnitt (**standardmäßig aus**) |
| `frames` | iframes auflisten und adressieren |
| `transcript` | YouTube-Transkript als Segmente mit Zeitstempeln, in der Originalspur |

Dazu: Ruhe-Erkennung statt fester Wartezeiten, Shadow DOM und Frames,
Persistenz über einen Hintergrund-Tab, und ein Log, das Seitentext nicht
mitschreibt.

## Sicherheit

- **Ein Token**, das nur im Dateisystem des Betreibers liegt und nie ins Repo
  gehört; die Bridge prüft es bei jeder MCP-Anfrage.
- **Nur Loopback.** Der MCP-Port ist an `127.0.0.1` gebunden und gehört nicht
  hinter einen öffentlichen Proxy.
- **Drei Schalter**, alle aus per Voreinstellung: Passwortfelder, Code-
  Auswertung, Bildschirmfotos. Der Agent schaltet sie nicht selbst um.
- **Der Agent sieht nur seine eigenen Tabs.** Deine Tabs bedient er nicht.

## Schnellstart

Die vollständige Anleitung steht in **[INSTALL.md](INSTALL.md)**: Token-Datei,
Caddy-Pfad, Bridge als systemd-User-Dienst, Erweiterung temporär laden.

Kurzfassung für einen Rechner ohne Proxy:

```bash
# 1. Token
mkdir -p ~/.config/browser-control
openssl rand -hex 32 > ~/.config/browser-control/token

# 2. Bridge als Dienst
cp deploy/browser-control.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now browser-control

# 3. Erweiterung: about:debugging#/runtime/this-firefox → „Temporäre
#    Erweiterung laden…" → extension/manifest.json wählen, dann unter
#    Add-on-Einstellungen Endpunkt und Token eintragen.
```

Die Erweiterung ist **unsigniert**. Nach einem Firefox-Neustart ist sie weg und
muss neu geladen werden; Signierung über AMO ist nicht eingerichtet.

## Entwicklung

Es gibt **keine Abhängigkeiten** — Node ≥ 22 genügt:

```bash
npm test        # 736 Fälle, TAP-Ausgabe, ~90 s
npm run check   # node --check über jede .js/.mjs
```

Wie Änderungen laufen (Spec → Gate → Dev-Plan → Review → Abnahme), steht in
**[CONTRIBUTING.md](CONTRIBUTING.md)**; die Design- und Messgeschichte in
[`docs/`](docs/README.md) — 34 Specs, jede mit ihren Messungen und den
Entscheidungen, die daraus folgten.

## Bekannte Grenzen

- **Unsigned**: temporär zu laden, nach jedem Firefox-Neustart erneut.
- **Windows** ist nur teilweise abgedeckt (`docs/29`, `docs/30`).
- **YouTube-Etiketten können falsch sein**: `browser_transcript` liest die Spur,
  die YouTube als Original ausgibt; Spracherkennung ist bewusst kein Ziel.
- **Ein Betreiber, ein Browser**: die Bridge bedient die Erweiterung, die
  verbunden ist.

## Lizenz

[MIT](LICENSE).
