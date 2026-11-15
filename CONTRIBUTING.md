# Mitmachen

Kurz: dieses Projekt wird spec-getrieben. Die Spec kommt vor dem Code, sie
geht durch ein Review-Gate, und erst danach wird gebaut. Wer eine Änderung
will, schreibt zuerst eine Spec in `docs/`.

## Voraussetzungen

- **Node ≥ 22** (`package.json`, `engines.node`). Es gibt **keine**
  Abhängigkeiten — kein `npm install` nötig.
- Firefox zum Ausprobieren der Erweiterung (siehe `INSTALL.md`).
- Für die Live-Messungen: ein eigener Browser, ein eigenes Token, ein eigener
  Rechner. Nichts davon ist im Repo.

## Tests und Prüfung

```bash
npm test; echo $?     # 0; Ausgabe enthält "^# fail 0" UND "^# cancelled 0"
npm run check; echo $?  # 0 — node --check über jede .js/.mjs
```

`npm test` läuft mit `--test-concurrency=1 --test-timeout=90000`: eine Datei,
die hängt, scheitert nach 90 s, statt den Lauf offen zu halten. Die langsamste
Datei ist `test/mcp.test.js`.

**Ein Proof braucht einen Fallnamen.** `grep -c '^ok [0-9]* - '` ohne Namen ist
vakuum-grün — Node zählt die Dateizeile `ok 1 - test/…` mit. Immer
`grep -cE '^ok [0-9]+ - <name>'` schreiben, und die erwartete Zahl festnageln.

## Der Ablauf: ein Inkrement

1. **Spec.** `docs/NN-kurzbeschreibung.md` mit Frontmatter (`description`,
   `status: proposed`) und den Pflichtabschnitten aus `docs/README.md`. Kein
   Code vor der Spec. Ist eine Frage nicht beantwortbar, steht sie unter
   `## Open questions` — geraten wird nicht.
2. **Absprache.** Ziel und `## Acceptance criteria` dem Betreiber vorlegen und
   auf dessen OK warten. Ohne diese Absprache wird kein Dev-Plan geschrieben.
3. **Dev-Plan.** Ein Stufenplan (Bau-Reihenfolge, Dateien, Beweis je Stufe)
   kommt von anderer Hand als der Spec und wird in sie eingefügt.
4. **Spec-Review — Gate.** Ein Reviewer prüft die Spec gegen ihre Prüfliste.
   Nur ein `✅ Ship it` öffnet das Gate; `🔧 Fix these` und `🤔 Needs a rethink`
   blockieren. **Nach dem dritten Block ist die Spec zu groß** — dann wird sie
   geteilt, nicht durchgewinkt.
5. **Umsetzung.** Eine Stufe pro Auftrag. Der Umsetzer hält die Touch-Boundary
   ein, fährt die Abnahmebefehle selbst und committet nie.
6. **Code-Review — Gate.** Der Diff wird gegen die Spec geprüft. Ohne `✅ Ship
   it` kein Commit; der Befund geht an **denselben** Umsetzer, mit derselben
   Spec. Blockt es wiederholt, ist das Inkrement zu groß: Stufe teilen.
7. **Abnahme und Commit.** Der Orchestrator liest den Diff, fährt die
   Abnahmebefehle, prüft die Kriterien einzeln und committet erst dann. Er
   pflegt dabei `docs/README.md` (Spalte `Status`) und `docs/PROJECT-STATE.md`.
   Die letzte Stufe stellt die Spec auf `status: active` und beschreibt den
   Ist-Zustand.

**Ein Bericht ist ein Bericht, kein Beweis:** nichts wird auf Prosa abgenommen.

## Rollen

| Rolle | Darf | Darf nicht |
|---|---|---|
| **Orchestrator** | Spec schreiben, zuschneiden, abnehmen, committen, Doku pflegen | Produktivcode schreiben |
| **Umsetzer** | Code und Tests schreiben, die Abnahmebefehle fahren | die Spec ändern, committen, die eigene Arbeit reviewen |
| **Reviewer** | Spec und Diff prüfen, Verdict geben | irgendetwas ändern |

Ein Schreiber pro Arbeitsbaum. Parallele Arbeit nur in getrennten Worktrees;
Reviews dürfen sich überlappen.

## Abnahme

Diese Befehle laufen vor jedem Commit grün:

```bash
npm test; echo $?                    # 0, enthält "^# fail 0" und "^# cancelled 0"
npm run check; echo $?               # 0
git grep --untracked -nE '[0-9a-f]{32,}' -- .   # keine Ausgabe, Exit 1
```

Dazu die Kriterien der jeweiligen Spec. Wo ein Kriterium nur im echten Browser
entscheidbar ist, steht das dort und wird vom Betreiber abgehakt.

Kein Commit ohne grüne Abnahme **und** ohne `✅` aus Schritt 6.

## Touch boundary

- **Kein Patch an Fremdcode.** Anpassungen an fremdem Verhalten laufen über
  eigene Wrapper davor — nie über `node_modules`, ein vendortes Paket oder eine
  heruntergeladene Quelle.
- **Keine Tokens, Secrets oder Zugangsdaten im Repo** — auch nicht in Tests,
  Beispielen oder Logs. Ein Test, der eines braucht, liest es aus der Umgebung.
- **Generierte Artefakte nie von Hand ändern.** Was ein Build erzeugt, wird
  durch den Build erzeugt.
- Dateien, die zu einem anderen Inkrement gehören, werden nicht angefasst.

## Sprache

- **Specs, Doku: Deutsch.**
- **Abschnittsnamen bleiben englisch**, wo ein Prüfskript sie liest:
  `## Testing`, `## Acceptance criteria`, `## Dev plan`, `## Open questions`,
  `## Additional dependencies`, `## Dependency changes`.
- **Code: englisch** — Bezeichner, Kommentare, Dateinamen.
- **Sichtbare Texte: deutsch** — was ein Mensch auf dem Bildschirm liest. Die
  Ausnahme ist, was im Browser gegenüber einer Webseite erscheint.

## Regeln

- **Keine Anforderung erfinden.** Unklare Punkte werden gefragt oder als
  `## Open questions` notiert.
- **Eine Spec, ein Inkrement.** Mehrere Änderungen sind mehrere Specs.
- **Keine neuen Abhängigkeiten ohne Rücksprache.**
- **Der Browser gehört dem Betreiber.** Der Agent arbeitet in seinem eigenen
  Tab und gibt ihn frei, sobald der Betreiber eingreift; Anmeldung,
  Zwei-Faktor und Passkeys macht der Betreiber selbst.

## Verweise

- Spec-Format und Registry: `docs/README.md`
- Einrichtung (Token, Caddy, Dienst, Erweiterung): `INSTALL.md`
- Stand des Projekts: `docs/PROJECT-STATE.md`
