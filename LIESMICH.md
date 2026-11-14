# Zombie Night Survival – eigener Server

Dieser Ordner ist der komplette Server: Er zeigt das Spiel an und sorgt für
Mehrspieler, Bestenliste, Cloud-Speicher und Clans – für alle Spieler, ohne Claude-Konto.

## Kostenlos online stellen (Render + Neon)

1. **Datenbank (Neon, kostenlos):** Auf https://neon.com ein Konto anlegen, ein Projekt erstellen
   und den „Connection string" kopieren (beginnt mit `postgresql://`).
2. **GitHub:** Auf https://github.com ein neues Repository anlegen (z. B. `zombie-night`) und
   diese Dateien hochladen (Knopf „Add file → Upload files"): `server.js`, `package.json`,
   `package-lock.json` und den Ordner `public` mit `index.html`. Den Ordner `node_modules` NICHT hochladen.
3. **Render:** Auf https://render.com anmelden → „New" → „Web Service" → das GitHub-Repository wählen.
   - Runtime: Node · Build Command: `npm install` · Start Command: `npm start` · Instance Type: Free
   - Unter „Environment" zwei Einträge anlegen:
     - `DATABASE_URL` = der Connection string von Neon
     - `ADMIN_SECRET` = ein geheimes Wort, das nur du kennst
4. Nach ein paar Minuten ist das Spiel unter `https://<dein-name>.onrender.com` erreichbar.
5. **Besitzer werden:** Öffne einmal `https://<dein-name>.onrender.com/?admin=<dein geheimes Wort>`.
   Ab dann hast du in diesem Browser unendlich Münzen und Edelsteine. Das Wort verschwindet sofort aus der Adresszeile.
6. Den normalen Link (ohne `?admin=...`) kannst du an Freunde schicken.

Gut zu wissen:
- Der kostenlose Render-Server schläft nach 15 Minuten ohne Spieler ein. Der erste Besuch danach dauert etwa eine Minute.
- Ohne `DATABASE_URL` speichert der Server in eine Datei (`data/spiel-daten.json`). Das reicht auf dem eigenen PC,
  aber auf Render (kostenlos) wird die Datei beim Einschlafen gelöscht – dort also immer Neon benutzen.
- Neue Spiel-Version: die neue `public/index.html` auf GitHub hochladen, Render startet dann von selbst neu.

## Auf dem eigenen PC testen

Node.js (Version 18 oder neuer) installieren, dann in diesem Ordner:

    npm install
    npm start

Danach im Browser `http://localhost:8080` öffnen. Andere im selben WLAN erreichen das Spiel über die IP-Adresse des PCs.

## Einstellungen

| Variable | Bedeutung |
|---|---|
| `PORT` | Port (Standard 8080, Hoster setzen ihn selbst) |
| `ADMIN_SECRET` | geheimes Wort für den Besitzer |
| `DATABASE_URL` | Postgres-Datenbank (Neon, Supabase, Render …) |
| `DATA_DIR` | Ordner für die Datei-Speicherung ohne Datenbank |
| `MAX_PLAYERS` | höchstens so viele gleichzeitig (Standard 300) |
| `MAINTENANCE` | wenn gesetzt (z. B. `Neue Türme kommen`): Wartung, nur der Besitzer kommt rein. Geht auch im Spiel: Einstellungen → „Server abschalten“ |

Das Spiel kann auch woanders liegen (z. B. itch.io): Dann `?server=<dein-name>.onrender.com` an die Adresse hängen.

## Updates

Bei jedem Push startet Render die neue Version. Sie schaltet die alte ab: alle Spieler sehen „Update wird installiert“, laufende Runden werden beendet (Belohnung bleibt), alles wird gespeichert. Erst danach lässt die neue Version Spieler rein, und das Spiel lädt bei allen von selbst neu.
