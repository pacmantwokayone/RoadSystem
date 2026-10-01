# RoadSystem – Backend (PHP + MySQL)

Referenz-Implementierung der Server-Seite für `HttpRoadStore`. **Sie liegt nur in diesem Repo** und
verändert keine bestehenden Skripte; bei der Integration werden die Dateien in `server/php/` kopiert
und die zwei Verdrahtungs-Funktionen in `roads-config.php` an die vorhandene DB-/Auth-Schicht angeschlossen.

Getestet (`tests/php-backend.test.ts`): der echte TypeScript-Client gegen PHP 8.3 (Built-in-Server) mit
SQLite – inkl. Revisionskonflikten, parallelen Speichervorgängen, Validierung und verweigertem
Schreibzugriff. Gegen MySQL ist es **nicht** gelaufen (hier nicht verfügbar); das SQL ist bewusst
portabel gehalten (Compare-and-Swap per `UPDATE … WHERE revision = ?`), `schema.mysql.sql` ist das MySQL-Schema.

## Dateien

| Datei | Zweck |
|---|---|
| `schema.mysql.sql` | Tabellen `road_docs` (aktueller Stand + Revision) und `road_docs_history` (letzte 50 Versionen je Dokument) |
| `roads-config.php` | **Verdrahtung:** `roads_db()` (PDO der userdata-DB) und `roads_require_editor()` (Auth). Standard = sicher geschlossen (500 / 403) |
| `roads-lib.php` | `RoadDocs` (Revisions-Locking), Validierung, JSON-Antworten |
| `roads-save.php` | Straßennetz je Location (gleiches Muster wie `rivers-save.php`) |
| `roadlib-save.php` | Profil-/Material-Bibliothek (Code) |

## Protokoll

```
GET  roads-save.php?location=<loc>        200 { roads: [...], nodes: [...], revision }   404 = noch nichts gespeichert
POST roads-save.php                       Body { location, roads, nodes?, baseRevision? }
                                          200 { ok: true, revision }
                                          409 { ok: false, conflict: true, revision }   ← Server ist weiter
                                          400 ungültige Eingabe · 403 keine Editor-Rechte · 413 zu groß
GET  roadlib-save.php                     200 { profiles: { name: source }, materials: { name: source }, revision }  404 = leer
POST roadlib-save.php                     Body { profiles, materials?, baseRevision? }  (Antworten wie oben)
```

- `nodes` = Kreuzungen (`{ id, x, y, z, radius?, control?, crosswalks?, signalMode?, greenS? }` — die letzten vier steuern Vortritt, Fussgängerstreifen und Ampeln, siehe `docs/PLAN.md` 2h; der Server speichert sie unverändert, der Client validiert beim Laden); Straßen verweisen per `startNode`/`endNode` darauf. Beides gehört in dasselbe Dokument
  und dieselbe Revision, damit ein Speichern nie ein halbes Netz hinterlässt.
- `baseRevision` = die Revision, auf der die Änderung des Editors beruht. Fehlt sie, wird überschrieben
  (der Editor sendet das erst, nachdem der Benutzer einen Konflikt bestätigt hat).
- Der Client probiert zuerst eine statische Datei `api/roads-<loc>.json` (wie bei Flüssen) und fällt dann
  auf `roads-save.php?location=` zurück – eine Auslieferung als statische Datei bleibt also möglich.
- Basis-URL: `window.WINGSUIT_API ?? 'api'`, wie `rivers.ts`.

## Sicherheit

- **Profile sind ausführbarer Code** auf jedem Spieler-Client (`new Function`). Schreiben darf deshalb nur
  ein authentifizierter Editor/Admin: `roads_require_editor()` muss die echte Prüfung bekommen.
  Lesen ist öffentlich (Spieler laden die Daten).
- Eingaben werden validiert (Location-Regex, Größenlimits, Profilnamen). Für ein Release kann man die
  Bibliothek zusätzlich vorkompilieren („Baking“, Phase 15), sodass Spieler gar keinen Code ausführen.

## Einbau (später)

1. `schema.mysql.sql` einspielen (userdata-DB oder eigene).
2. Die vier PHP-Dateien nach `server/php/` kopieren; `roads-config.php` an PDO + Auth anschließen.
3. Im Spiel: `new HttpRoadStore()` an `RoadEditor` übergeben.
