# RoadSystem – Projektplan

Ein prozedurales Straßen- und Wegesystem für three.js + Vite. Straßen werden als 3D-Körper
(Profil entlang einer Spline extrudiert) direkt auf das Terrain gesetzt. Alle Profile,
Brücken, Tunnel und Props sind **code-basiert** und im Editor live editierbar.

---

## 1. Leitprinzipien

1. **Daten zuerst.** Das Straßennetz ist ein reines Datenmodell (Graph + Splines + Profil-Referenzen).
   Geometrie wird daraus *abgeleitet* und ist jederzeit neu erzeugbar. Dadurch: Speichern/Laden,
   Undo/Redo, inkrementelles Neu-Bauen und Baking funktionieren „von selbst".
2. **Alles prozedural, alles Code.** Profile, Brücken, Tunnel, Schilder, Leitplanken, Materialien
   sind kleine JS/TS-Funktionen mit Parametern (`params`), die der Editor als Slider/Checkboxen
   darstellt. Es gibt *Presets*, aber keine Sonderfälle im Kern.
3. **Terrain ist austauschbar.** Das System kennt nur ein `TerrainSource`-Interface
   (`heightAt(x,z): number | null`, `isSettledAt(x,z): boolean`, optional Änderungs-Events und
   `setModifiers()`), nicht dein konkretes `StreamTerrain`. Details in Kapitel 2a.
4. **Körper statt Decal.** Die Straße hat Dicke (Unterbau). Terrain-Lücken/Durchstoßungen werden
   dadurch verdeckt; zusätzlich optional Böschungen/Einschnitte für saubere Übergänge.
5. **Eigenständiges Modul.** Das Modul ändert **keine bestehenden Spieldateien**. Es kennt das Spiel
   nur über Interfaces (`TerrainSource`, `RoadStore`, `EditorHost`). Die Integration ins Spiel
   (Adapter, `StreamTerrain`-Anbindung, PHP-Endpunkte) ist ein **separater, späterer Schritt**;
   dafür liefere ich dann fertige Adapter-/Patch-Vorschläge als Dateien, ohne sie selbst anzuwenden.
6. **Runtime ≠ Editor.** Editor-Code (Code-Editor, Tools, GUI) ist ein separates Paket und
   wird nicht ins Spiel gebündelt. Das Spiel lädt nur die Runtime (oder vorgebackene Daten).
7. **Performance by design.** Chunking, Instancing, Dirty-Rebuild, optional Worker.

---

## 2. Architektur

```
src/
  core/        Spline (Bézier/Catmull-Rom), Bogenlängen-Parametrisierung, Frames (Banking),
               Krümmung, Sampling, TerrainSource-Adapter, Seeded RNG, Noise
  network/     Graph: Node, Edge, Segment-Abschnitte (Normal/Brücke/Tunnel),
               Kreuzungen, Lane-Graph, Validierung (Trassierungsregeln)
  profile/     Profil-DSL, Strips, Parameter-Schema, Profil-Übergänge, Presets/
  mesh/        Extrusion, Kreuzungs-Mesher, Böschungen, Chunking, Worker-Build
  structures/  Brücken, Tunnel, Stützmauern, Durchlässe, Treppen, Stege
  surface/     Material-Registry, prozedurale Shader (Asphalt, Schotter, Erde, Pflaster…),
               Fahrbahnmarkierungen
  props/       Scatter-Regeln, Leitplanken, Schilder, Laternen, Ampeln + Signalsteuerung
  query/       sampleAt(point) → {edge, s, t, höhe, oberfläche, reibung}, nearestRoad, Lane-Pfade
  editor/      Tools, Inspector, Code-Editor (CodeMirror 6), Live-Preview, Undo/Redo
  io/          JSON (versioniert), glTF-Baking, Import (GeoJSON/OSM)
  index.ts
demo/          Vite-App mit prozeduralem Demo-Terrain + Editor
tests/         Vitest (reine Geometrie-/Graph-Logik)
```

**Pipeline** (jeder Schritt cachebar, nur „dirty" Edges werden neu gebaut):

```
Netzdaten → Spline → vertikales Alignment (Terrain-Anpassung) → Samples/Frames
         → Profil auswerten (Params, Variation entlang s) → Extrusion (Ringe → Mesh)
         → Kreuzungs-Patches → Strukturen (Brücke/Tunnel) → Böschungen
         → Markierungen → Props (Instancing) → Chunk-Merge → Scene
```

---

## 2a. Integration in das Spiel (Stand der Infos zum Spiel)

### Terrain: `StreamTerrain` (Heightmap, Quadtree-Kacheln, Streaming, WebGL, three ^0.170)
Das Modul spricht nur dieses Interface; ein dünner Adapter bindet `StreamTerrain` an:

```ts
interface TerrainSource {
  heightAt(x: number, z: number): number | null;   // null = dort noch nichts gestreamt
  isSettledAt(x: number, z: number): boolean;      // feinste existierende Kachel ist fertig
  onTilesChanged?(cb: (bounds: Rect) => void): () => void;   // optional, sonst Polling
  setModifiers?(mods: TerrainModifier[]): void;    // Carve/Raise-Quellen (siehe unten)
}
```

**Konsequenzen für das Design:**

1. **`resync()`-Pattern (wie `riverField.ts`).** Jeder Sample-Punkt kennt `groundY: number | null`.
   Chunks werden gebaut, sobald alle Samples im Footprint `settled` sind (bzw. provisorisch
   sofort und danach neu gebaut). Ein budgetierter `resync()` pro Frame (max. N Chunks)
   verhindert Frame-Spikes.
2. **Höhen: settled-Terrain ist stabil (siehe 2b).** `drape` (Standard) liest die Terrainhöhe erst
   nach `isSettledAt`, danach ändert sie sich nicht mehr. Pro Punkt wird zusätzlich `y` gespeichert
   (wie `RiverPoint.y`): Editor-Vorschau/Fallback vor dem Settling und feste Höhe für `fixed`,
   Brücken und Tunnel. Ein Editor-Button „Höhen fixieren" kann `drape` in feste `y` backen.
3. **Zirkularität vermeiden.** Carve verändert `heightAt()`. Das Längsprofil darf sich aber
   nicht aus dem *schon abgesenkten* Terrain ableiten (sonst Rückkopplung). Daher:
   Der Adapter liefert die **Basis-Höhe ohne Straßen-Modifier** (`heightAt` mit Modifier-Bypass
   bzw. Straßen-Modifier werden erst *nach* der Alignment-Berechnung eingespeist). Fixierte `y`
   in den Daten lösen das Problem grundsätzlich.
4. **Log-Depth-Buffer ist aktiv.** Materialien werden als `MeshLambertMaterial` (wie das Terrain) +
   `onBeforeCompile` gebaut (nicht als rohes `ShaderMaterial`) → Logdepth, Nebel, Schatten,
   Spiel-Beleuchtung funktionieren automatisch. Wo doch ein `ShaderMaterial` nötig ist,
   werden `logdepthbuf_*`-Chunks eingebunden.
5. **Koordinaten.** Daten werden wie bei den Flüssen in **Spiel-Weltkoordinaten** gespeichert;
   ein zentraler `WorldAdapter` rechnet an der Modulgrenze in den three.js-Raum (z gespiegelt).
   Intern rechnet alles im three.js-Raum (rechtshändig), damit Windungsrichtung/Links-Rechts
   im Profil eindeutig sind. 1 Einheit = 1 m.

### Terrain-Eingriffe (Carve/Raise) – Verallgemeinerung von `setRivers()`
`StreamTerrain` bekommt statt `setRivers()` allein einen generischen Mechanismus
(Flüsse bleiben unverändert eine Quelle davon):

```ts
interface TerrainModifier {          // räumlich indiziert (Grid wie bei Flüssen)
  bounds: Rect;
  // Delta in Metern relativ zur Basishöhe + Gewicht; negativ = absenken, positiv = anheben
  sample(x: number, z: number, baseY: number): { dy: number; weight: number } | null;
}
```

- Das Modul liefert einen `RoadTerrainModifier`: Abstand zur Straßen-Mittellinie (Grundriss),
  Zielhöhe aus dem Längsprofil, **weicher Übergang** (`margin`, analog `BANK_MARGIN_M`).
  Anheben (Dämme) **und** Absenken (Einschnitte, Portal-Gräben).
- Mehrere Quellen (Flüsse + Straßen) werden im Spiel kombiniert; Regel: `min` für Absenken,
  `max` für Anheben, Straße gewinnt innerhalb ihrer Kernbreite.
- Mesh **und** `heightAt()` müssen konsistent verändert werden (wie `carveAt`). Das ist eine
  kleine Änderung in `StreamTerrain`; ich liefere dafür einen konkreten Patch-Vorschlag.
- **Carving ist optional.** Ohne Patch funktioniert das Modul vollständig über den
  3D-Straßenkörper (Dicke + Böschungs-Skirts).

### Flüsse
Die `RiverDef`-Daten werden als Hindernis gelesen: Kreuzt eine Straße einen Fluss, schlägt der
Editor automatisch eine Brücke/Furt/Durchlass vor; Straßen-Carve und Fluss-Carve werden
verträglich kombiniert.

### Persistenz & Server
- **Format** wie `rivers-<location>.json`: ein JSON pro Location (`roads-<location>.json`),
  whole-document replace. Zusätzlich eine **Bibliothek** (`roadlib.json`) mit den
  Code-Definitionen (Profile, Brücken, Tunnel, Materialien, Prop-Regeln), ortsübergreifend
  wiederverwendbar, per Location überschreibbar.
- **Zugriff über ein `RoadStore`-Interface** (`load(location)`, `save(location, doc, baseRevision)`),
  Implementierungen: `MemoryStore` (Tests), `LocalFileStore` (Demo), `HttpRoadStore` (REST gegen PHP).
- **Backend ist PHP + MySQL** (Muster wie bei Rivers/Gaps). Empfehlung für Phase 12:
  - ein PHP-Endpunkt `roads.php` (GET lädt, POST speichert; Auth wie bei den anderen
    Editor-/Save-Endpoints),
  - Tabelle `roads(location, revision, doc JSON/LONGTEXT, updated_by, updated_at)` plus
    `roads_history` für Versionsverlauf, und `road_library` für die Code-Bibliothek,
  - **Optimistisches Locking:** `save` sendet `baseRevision`; PHP lehnt mit 409 ab, wenn sie
    nicht mehr aktuell ist.
  - Das Dokument bleibt **ein JSON pro Location** (kein relationales Zerlegen) – genau wie
    `rivers-<location>.json`; MySQL liefert nur Speicher, Revision und Verlauf. Die Variante „JSON-Datei"
    bleibt als einfachster Start möglich. Der Node-Prozess (`highscores.mjs`) wird nicht gebraucht.
  - Dieses PHP-Skript schreibe ich später als **neue, separate Datei** zum Einfügen in
    `server/php/` – ohne bestehende Skripte zu berühren.
- **Sicherheit:** Profile/Brücken sind ausführbarer JS-Code. Der Schreib-Endpunkt muss
  **authentifiziert und nur für Editoren/Admins** sein; Spieler laden nur, was Admins gespeichert
  haben. Für den Spiel-Release kann der Code zusätzlich **vorkompiliert/gebacken** werden
  (nur Daten + Funktionen aus Whitelist, kein `new Function` beim Spieler).
- Konflikte: Beim Speichern mit veralteter Revision → Dialog „Neu laden / überschreiben /
  zusammenführen (pro Edge)".

### Tunnel – kein Loch im Terrain nötig
`StreamTerrain` hat keine CSG-Fähigkeit. Strategie (in dieser Reihenfolge):
1. **Portal-Graben + Stirnwand (Standard):** Terrain wird vor dem Portal per Carve
   (nur *Absenken*, das existiert bereits) zu einem Einschnitt bis auf Straßenniveau abgetragen.
   Am Ende des Einschnitts steht eine **Portal-Fassade** (Mesh mit Öffnung, Stützmauern,
   Flügelmauern), die die steile Terrainwand verdeckt. Dahinter beginnt die **Tunnelröhre
   als eigene Geometrie** unter dem Gelände. Terrain wird von unten durch Backface-Culling
   nicht gerendert → innen sieht man nur die Röhre.
2. **Sichtbarkeits-Trick (Fallback):** Depth-only-Maske im Portalbereich, falls das Terrain die
   Öffnung dennoch verdeckt.
3. **Validierung:** Liegt das Gelände über einem Tunnelabschnitt zu niedrig (Überdeckung
   < Mindestmaß), warnt der Editor und schlägt **Galerie/Einschnitt** vor (typisch Schweiz:
   Lawinengalerien).

---

## 2b. Erkenntnisse aus den Referenzdateien (`streamTerrain.ts`, `rivers.ts`, `riverField.ts`)

Gelesen, nicht verändert. Folgendes ist **verifiziert** und fließt ins Design ein:

| Befund | Konsequenz für das Modul |
|---|---|
| `heightAt()` liefert die Höhe der **feinsten bereits geladenen** Kachel (auch grobe Fallback-Kachel) **minus `carveAt()`** (Flüsse). `null` nur, wenn gar nichts geladen ist. | Höhen nur lesen, wenn `isSettledAt` – genau wie `riverField.resync()`. Rivers sind bereits im `heightAt` eingerechnet. |
| `isSettledAt` = feinste je existierende Kachel ist bereit. Die Höhe ist dann **endgültig** (kein späteres Nachladen ändert sie). | Gesettelte Terrainhöhe ist stabil → `drape` darf **die Standardeinstellung** sein (wie bei Flüssen); gespeicherte `y` sind Editor-Vorschau/Fallback und für `fixed`/Brücke/Tunnel. *(Korrektur ggü. Kapitel 2a, Punkt 2.)* |
| Kein Event bei fertig geladenen Kacheln; `riverField.resync()` pollt jeden Frame und baut Chunks, sobald **alle** Samples `isSettledAt` sind. | Gleiches Muster: budgetiertes `resync()`, Chunk-Bau erst wenn Samples **plus Alignment-Fenster** gesettelt sind. |
| Mesh-Rasterung: Quads → 2 Dreiecke; `heightAt` interpoliert **bilinear**; `meshStride` (Mobil) macht das Mesh gröber als die Höhendaten. Auflösung fein: ~1,5 m Raster, 0,1 m Höhe. | Sichtbare Abweichung Mesh ↔ `heightAt` (Dezimeter bis Meter an Steilhängen) → die **Dicke des Straßenkörpers + Böschungs-Skirt** ist nötig, nicht nur Kosmetik. |
| Carve: `y = Höhe − carveAt(x,z)`, **nur für Kacheln gebaut nach `setRivers()`**; Normalen werden nicht angepasst; `carveAt` ist ein heißer Pfad (Grid, 100 m Zellen). | Der spätere `TerrainModifier` muss **signiert** sein (negatives Carve = Anheben ist trivial), billig (Grid), und braucht ein `invalidate(rect)` zum Neu-Meshen; Normalen-Gradient sollte mitkorrigiert werden. Alles Teil des späteren Patch-Vorschlags. |
| Terrain nutzt **`MeshLambertMaterial`** + `onBeforeCompile`, Szenen-Nebel, `atmo.applyCloudShadow(mat)`; Fluss nutzt `ShaderMaterial` mit manuellem Fog + `uLight`. | Straßenmaterialien **standardmäßig `MeshLambertMaterial`** (gleicher Look, günstig), mit **Material-Hooks** (`onMaterialCreated(mat)`) zum Anschließen von Atmosphäre/Wolkenschatten und `setLight(0..1)` für Tag/Nacht. *(Korrektur ggü. Kap. 5: nicht `MeshStandardMaterial`.)* |
| Weltkonvention: Sim-Raum `(x, y, z)`, three-Raum `(x, y, −z)` – überall (`placedObjects`, `riverField`, `buildMesh`). Terrain-Index: `z0 = tz·size`. | `WorldAdapter` = exakt `simToThree(x,y,z) = (x,y,−z)`. Modul rechnet intern **im three-Raum**; Daten werden im **Sim-Raum** gespeichert. Links/Rechts-Berechnung ausschließlich im three-Raum, damit Windung/Normalen stimmen. |
| Persistenz: `GET api/rivers-<loc>.json` (statisch) **oder** `api/rivers-save.php?location=`; `POST api/rivers-save.php {location, rivers}`; Basis `window.WINGSUIT_API ?? 'api'`; ganze Liste wird ersetzt; kein Revisionsfeld, Auth nicht sichtbar. | `HttpRoadStore` spiegelt das 1:1 (`roads-<loc>.json` / `roads-save.php`), Revision/409 als **abwärtskompatible Erweiterung**. |
| Rivers werden per Skript aus **swissTLM3D** erzeugt (10 m Resampling, bis 6000 Punkte/Fluss). | **Straßen-Seed aus swissTLM3D** (analog `extract_rivers.py`): Objektarten → Profile (Autobahn…Wanderweg), Kunstbauten → Brücke/Tunnel/Galerie. Das Netz wird also **groß** (tausende Kanten): lazy Chunk-Bau, räumlicher Index, Props instanziert, LOD. |
| Physik/Crash nutzt `heightAt()`. | Straßen brauchen eine **eigene** Kollisionsabfrage (siehe 3.8); `heightAt` weiß nichts von Straßenkörpern/Brücken. |

---

## 2c. Umsetzungsnotizen Phase 2 (was sich beim Bauen ergeben hat)

- **Straße nie unter dem Terrain (garantiert):** Das Terrain wird auch *quer* zur Straße gesampelt
  (Mitte, Fahrbahnränder, Außenkanten). Die Höhe entsteht per „aufweiten, dann glätten":
  lokales Maximum im Radius *r*, danach FIR-Glättung mit Radius *r*. Das ist mathematisch
  ≥ Terrain unter der Fahrbahn und bleibt rein lokal (naht-konsistent). Gemessen im Demo-Terrain:
  0 von 1011 Messpunkten vom sichtbaren Mesh verdeckt (max. 8 cm).
- **Körper statt Lücke:** Die Seitenwände reichen bis unter das Terrain neben der Straße (gedeckelt).
  Am Hang entsteht dadurch talseitig eine „Stützwand"-Optik – die echte Böschung/der Einschnitt
  kommt mit Phase 10 (Terrain-Modifier).
- **Frames aus der Entwurfshöhe**, nicht aus den gesetzten Punkten: Normalen kippen mit der Steigung
  (Beleuchtung stimmt am Hang). Dafür löst jeder Chunk die Höhe ±1 Sample über seinen Rand hinaus auf.
- **Profile sind Code** (`export const params` + `export default (p, R) => R.profile(…)`), ein
  fehlerhafter Edit lässt die letzte funktionierende Version aktiv (`ProfileLibrary`).
- **LOD-Übergang (gilt auch im Spiel):** `isSettledAt` ist wahr, sobald die feine Kachel *bereit* ist –
  angezeigt wird aber evtl. noch das grobe Eltern-Mesh, bis alle vier Geschwister geladen sind. In diesem
  kurzen Fenster kann Gelände die Straße verdecken. Gegenmaßnahme später (Phase 10): Straßen-Modifier
  senkt das Gelände ab bzw. Chunk-Sichtbarkeit wartet auf `visible`-Info des Terrains.

---

## 2d. Umsetzungsnotizen Phase 3 (Persistenz + Editor)

- **`RoadStore`-Vertrag** mit Revisionen: `MemoryStore`, `StorageStore` (Demo), `HttpRoadStore`
  (spiegelt `rivers.ts`: statische Datei → `…-save.php`-Fallback). Konflikt = 409 + Server-Revision; der
  Editor fragt dann „trotzdem überschreiben?“. Dazu eine **PHP+MySQL-Referenz** in `docs/backend/`
  (getestet gegen den echten Client, siehe dort).
- **Undo/Redo** über unveränderliche Snapshots; Drags und Slider werden zu *einem* Schritt zusammengefasst
  (Zeitfenster **oder** ausdrücklich gehaltene Geste – ein Drag auf einem langsamen Frame bleibt ein Schritt).
- **Kein Flackern beim Bearbeiten:** ersetzt der Editor eine Straße, bleiben die alten Meshes sichtbar, bis
  die neue Version komplett gebaut ist.
- **Klick-Erkennung** nutzt `event.timeStamp` statt der Verarbeitungszeit (robust gegen langsame Frames);
  Picking trifft Straßen-Meshes *und* Gelände (Parallaxe: die Straße liegt über dem Gelände).
- **Profil-Code live:** CodeMirror 6 mit Autovervollständigung für die DSL und Materialnamen, Fehler
  isoliert (letzte gültige Version bleibt aktiv), 2-D-Querschnitt daneben, Parameter-UI automatisch.
- **Datenhygiene:** `y` aus dem Editor ist eine Terrainhöhe; Daten mit uneinheitlichen `y` (z. B. 0 neben
  857) verzerren die 3D-Bogenlänge. Importer (swissTLM3D) müssen konsistente Höhen liefern.
- **Editor ist ein eigener Einstiegspunkt** (`roadsystem/editor`), Runtime und Editor sind getrennt bündelbar.

---

## 2e. Umsetzungsnotizen Phase 4 (Netzwerk + Kreuzungen)

**Datenmodell.** Straßen bleiben Punktlisten; eine Kreuzung ist ein `NodeDef` (Position, Kurvenradius), auf den
Straßenenden per `startNode`/`endNode` zeigen. Ein T entsteht, indem die durchgehende Straße am Knoten **geteilt**
wird. Ein Knoten braucht ≥ 2 Straßenenden; die Netz-Normalisierung (`normalizeNetwork`) entfernt hängende
Referenzen und Knoten mit < 2 Armen und rastet verbundene Enden exakt auf den Knoten ein. Dokument-Version bleibt
abwärtskompatibel (`nodes` ist optional).

**Geometrie** (`network/junction.ts`, reine 2D-Mathematik, zufällig getestet an 6000 Kreuzungen):
- Arme nach Winkel sortiert; zwischen zwei Nachbarn liegt ein **Keil** (Fillet, Außenecke, „gerade weiter“ oder
  Kappe). Setback je Arm aus Breiten und Winkel: `s = (wA·cosγ + wB)/sinγ + Tangentenlänge`.
- Das Randpolygon wird aus den **tatsächlichen** Enden der (am Knoten gekürzten) Straßen gebaut, nicht aus
  idealisierten Geraden – dadurch passt der Patch auch bei gekrümmten Armen **ohne Spalt** an (Test: Patch-Ecken
  stimmen auf 5 cm mit den Endringen überein, auch in der Höhe).
- **Rückfälle** für Extremgeometrie (z. B. 1 m und 5 m Halbbreite fast gerade zusammen): erst alle Ecken gerade
  verbinden, dann konvexe Hülle – das Polygon ist damit immer einfach (< 1 % der Zufallsfälle brauchen es).
- Ab ±12° zur Geraden gilt ein Keil als „gerade weiter“ → **Profilübergang** (Verjüngung über `3·|ΔBreite|`).
- Höhen: Randhöhen aus den Straßenoberflächen, Ringe zur Mitte hin geblendet, nie unter Terrain; Wände bis zum
  Terrain wie bei den Straßen. Straßen bekommen **Abschlusskappen**, der Körper ist überall geschlossen.

**Laufzeit.** `RoadSystem.setNetwork` berechnet Layouts → Trims → baut nur Straßen/Kreuzungen neu, deren Eingaben
sich (nach Objektidentität) geändert haben. 3120 Straßen / 1600 Knoten: 0,8 s erster Aufbau, danach 40–60 ms je
Änderung. Der Mesh-Layer hält Vorgängerversionen sichtbar, bis die neue komplett steht (auch für Kreuzungen).

**Editor.** `RoadModel` arbeitet jetzt mit Snapshots → *Teilen + Knoten + Verbinden* ist **ein** Undo-Schritt.
Zeichnen: Start/Ende nahe einer Straße/einem Ende/einem Knoten dockt an (Straße wird geteilt). Freies Ende auf
ein Ziel ziehen verbindet. Knoten-Marker ziehen verschiebt alle Arme. Inspector: Radius, Armliste, auflösen.

**Bekannte Grenzen (bewusst, siehe Roadmap):**
- Die Höhen der Arme werden unabhängig vom Terrain ausgerichtet; der Patch vermittelt dazwischen. Bei sehr
  unruhigem Gelände kann das einen leichten Höhenversatz erzeugen. Verbesserung: Knotenhöhe als gemeinsamer
  Anker (mit Phase 10 / Terrain-Modifier).
- Der Patch deckt nur die **Fahrbahn** (Core-Breite); Bankett/Graben/Gehweg enden an den Armenden (Gehweg-Ecken,
  Bordstein und Markierungen im Patch kommen mit Phase 7 → erledigt, siehe 2h).
- Patch-Material = Hauptfahrstreifen der breitesten Straße; Unterseite des Patches fehlt (nur von unten sichtbar).
- Kreisel, Auf-/Abfahrten, Unterführungen: Phase 11.

---

## 2f. Umsetzungsnotizen Phase 5 (Oberflächen & Markierungen)

**Material-Shader.** Materialien bleiben `MeshLambertMaterial` (wie das Spielterrain, gleiche Beleuchtung); ein
`onBeforeCompile`-Einschub (`src/surface/surfaceShader.ts`) liefert die prozedurale Optik: Meter-basierte UVs,
`aStrip`-Attribut (Streifenindex quer zur Fahrbahn), Verschleiß-Layer (Spurrillen, Risse, Flicken, Randschmutz).
Wetter (`wet`/`snow`/`age`) sind **gemeinsame Uniforms** für alle Straßenmaterialien. Echte Texturen: `def.map`
bzw. `M.texture(url)` ersetzt die prozedurale Farbe.

**Materialien als Code.** `MaterialLibrary` (analog `ProfileLibrary`): `export default (M) => M.asphalt({...})`,
Hot-Reload mit letzter funktionierender Version bei Fehlern; Material-Tab im Editor; `roadlib-save.php` trägt
`materials` mit (nur Editor-Rechte schreiben – Material-Code ist ausführbar).

**Markierungen.** `MarkingDef` im Profil (`edgeLine`, `mark`, `markCenter`; solid/dashed/double/dashed-solid,
weiß/gelb). Als leicht angehobene Bänder (3 cm, geometrisch – Polygon-Offset wirkt bei Log-Depth nicht) mit
Strichphase aus der absoluten Bogenlänge, damit Chunk-Nähte nahtlos bleiben.

**Presets.** 19 Presets von Wanderweg bis Autobahn (Mittelleitplanke, Spuren, Standstreifen). Regressionstest:
alle Presets auf flachem Terrain nie unter/koplanar zum Terrain (`clearanceM` 0.15, kronenbewusste Hüllkurve).

**Backend.** `roads-lib.php` wiederholt bei transienten DB-Sperren (SQLite „locked", MySQL 1205/1213) – parallele
Speicherungen enden sauber in 409 statt in einem Fehler.

**Bekannte Grenzen:**
- Kreuzungs-Patch hat noch keine Markierungen, Haltelinien, Bordsteine oder Gehweg-Ecken (Phase 7).
- Markierungsmaße sind Annäherungen an die Schweizer Norm (VSS), keine exakten Werte.
- Nur Lambert-Optik (kein PBR); Nässe/Schnee sind Shader-Näherungen.

---

## 2g. Umsetzungsnotizen Phase 6 (Props)

**Regeln im Profil-Code.** `prof.scatter(asset, {side, offset, spacing | at, face, jitterAlong, jitterLateral, scale, stagger, modes, when})`,
`prof.lamps(...)`, `prof.guardrail(side, {variant, offset, minDrop, when, …})`, `prof.rank(n)`. `offset` = Meter nach aussen ab der
Fahrbahnkante (`core`), negativ = einwärts (z. B. Laterne auf dem Trottoir). Regeln sind Daten + optionales `when(ctx)`
(`ctx`: `s`, `side`, `curvature`, `outer`, `drop`, `mode`, `random()`); ein werfendes `when` lässt nur das Prop weg.

**Platzierung (`props/place.ts`).** Pro bereitem Chunk, aus der **absoluten Bogenlänge** (halboffenes Intervall pro Chunk ⇒ nie doppelt/
fehlend an Chunk-Grenzen), Zufall deterministisch (Strassen-Seed + Regel + Index). Position über dieselben `ringSection`s wie Körper und
Markierungen ⇒ Props stehen exakt auf der Oberfläche; ausserhalb des Profils auf dem Terrain. Nahe Knoten (6 m) keine Props.

**Leitplanken.** Auto-Regel: Rail dort, wo das Terrain innerhalb 6 m neben der Schiene ≥ `minDrop` (1.8 m) abfällt, oder ≥ `minDropBend`
(0.9 m) auf der Aussenseite einer Kurve mit R < `bendRadius`; Brücken (`bridge`) bringen ab Phase 8 ihr eigenes Geländer mit und sind ausgeschlossen. Läufe: Lücken < 14 m
überbrückt, Läufe < 8 m verworfen, 8 m Vor-/Nachlauf. Varianten `steel` (W-Profil, abgesenktes Endstück), `concrete` (New-Jersey, Endstück
läuft aus), `wood`, `cable`. Schiene = extrudiertes Querprofil mit analytischen Normalen (naht-konsistent), Pfosten = normale Placements.

**Assets & Materialien.** `PropAssets` (Name → Geometrieteile + Materialname; prozedural, low-poly; `register(name, {build})` ersetzt jedes
Asset, `partsFromObject(gltf.scene, materials)` macht aus einem Modell Teile), `PropMaterials` (Name → Material, `set` ersetzt). Eingebaut:
Pfosten, Laterne (gross/klein), Leitpfosten, Poller, Kilometerstein, Bank, Pappel, Linde.

**Schilder (SSV-Stil).** `sign:<id>[:<text>]`; 22 Entwürfe (Höchstgeschwindigkeit 20–120, 9 Stufen, Stop, Kein Vortritt, Hauptstrasse, Einfahrt verboten,
Fussgängerstreifen, Autobahn, Kurve links/rechts, Gefahr, Wegweiser blau/grün/Wanderweg, Ortstafel) per Canvas gezeichnet (Farben/Layout
nach Norm, Proportionen/Piktogramme vereinfacht; keine SSV-Artikelnummern, weil ungeprüft). Ohne Canvas (headless) Fallback auf Einheitsfarbe.

**Vortritt automatisch.** `profile.rank` (Presets: Wanderweg 0 … Autobahn 8; Standard aus der Breite). Pro Kreuzung: gleiche Ränge ⇒ keine
Schilder (Rechtsvortritt); sonst bekommen schwächere Arme „Kein Vortritt“ (bei Rangabstand ≥ `stopRankGap` „Stop“), stärkere „Hauptstrasse“.
Wege (Rang < 2) zählen nicht. Schild steht rechts am Arm (aus Sicht des anfahrenden Verkehrs), 3.5 m vor dem Patch, zum Verkehr gedreht.

**Layer.** `PropLayer` spiegelt `RoadMeshLayer` (Ersetzen behält die alte Version sichtbar bis die neue komplett ist, Entfernen räumt auf);
**ein zusammengeführtes Mesh pro Chunk** (je Material eine Gruppe), `update(camera)` blendet Chunks jenseits `drawDistance` aus.
Messung (headless, 40 Strassen / 1280 Chunks / 24 000 Props): +0.75 ms pro Chunk.

**Bekannte Grenzen (bewusst):**
- Props sind pro Chunk **gebacken**, nicht instanziert – bei sehr dichten Props (Wälder) ist Instancing der nächste Schritt (Phase 15).
- Leitplanken-Läufe werden **chunk-lokal** entschieden (Vor-/Nachlauf und Lückenüberbrückung wirken nicht über Chunk-Grenzen); ein Lauf, der
  die Grenze erreicht, setzt sich im Nachbarchunk nahtlos fort, aber ein kurzer Vorlauf kann an der Grenze fehlen.
- Leitplanken: einfache Endstücke (abgesenkt/auslaufend), kein Anprallelement, Pfosten kippen nicht mit dem Hang.
- Kreuzungs-Patches haben keine Laternen/Leitplanken/Haltelinien/Fussgängerstreifen (Phase 7); der Vortritt hängt nur am Rang, nicht an einer
  Knoteneigenschaft („Stop“ erzwingen, Lichtsignal): kommt mit Phase 7.
- Laternen leuchten nur optisch (emissive Köpfe), keine Lichtquellen; Nacht/Lichtkegel in Phase 16.
- Keine Kollision: `PropLayer.allPlacements()`/`railRuns()` liefern die Daten für die Gameplay-API (Phase 14).
- Brücken-/Tunnelgeländer und Portale kommen mit Phase 8/9.

---

## 2h. Umsetzungsnotizen Phase 7 (Ampeln, Fussgängerstreifen, Haltelinien, Trottoir-Ecken)

**Knoten-Einstellungen** (`NodeDef`, nur Nicht-Standardwerte werden gespeichert, alles validiert in `sanitizeNode`; das PHP-Backend reicht
Knoten unverändert durch): `control` = `auto` (Vortritt aus dem Rang) | `none` (Rechtsvortritt) | `stop` | `yield` | `signals`,
`crosswalks` = `auto` (Strassen mit Trottoir) | `none` | `all`, `signalMode` = `fixed` | `flashing` | `off`, `greenS`. Im Editor im
Kreuzungs-Inspector (ein Undo-Schritt pro Änderung).

**Steuerlogik (`src/junction`, reine Funktionen).** `traits` (Fahrstreifen-/Fahrbahn-Spannen, Trottoir, Mittelleitwand), `controls`
(`planJunction` → pro Arm: Schild, Linie `stop`/`wait`, Fussgängerstreifen), `signals` (Phasenplan + Controller).

**Markierungen im Knoten** (`mesh/junctionMarkings.ts`): Fussgängerstreifen (0.5 m Balken im 1-m-Raster, 4 m lang, 1.6 m vor dem Patch),
Haltelinie (durchgehend, 0.5 m) bei Stop/Ampel, gestrichelte Wartelinie bei „Kein Vortritt“; nur auf der Anfahrtsseite, aus denselben
Ring-Sections wie der Strassenkörper (liegen exakt auf der Oberfläche). Fussgängerstreifen-Schild und Vortrittsschilder aus derselben Planung.

**Ampeln.** Phasenplan automatisch: Arme, die ±30° gegenüberliegen, teilen eine Phase, alle anderen haben eine eigene; Reihenfolge nach Winkel.
Pro Phase: Rot-Gelb 1 s (letzte Sekunde der Räumzeit) · Grün (Standard 20 s) · Gelb 3 s · Alles-Rot 2 s. Fussgänger über einen Arm haben
Grün in allen Phasen, die diesen Arm nicht freigeben (1 s Verzögerung, 5 s Räumzeit vor Phasenende; abbiegender Verkehr ist
bedingt verträglich). `SignalController.at(t)` ist eine **reine Funktion der Zeit** (Server-/Spielzeit, Test), Versatz pro Knoten aus der
Knoten-ID. Modi: Festzeit, gelb blinkend, aus. `SignalLayer`: pro Knoten ein Mesh für Masten/Gehäuse und eines für die Lampen
(Vertexfarben, nur bei Zustandswechsel neu geschrieben); `update(sekunden, camera)`.

**Trottoir-Ecken & Fahrbahnbreite.** Neu: `ProfileData.carriageHalfWidth` (Fahrstreifen, Parkfeld, Bankett; ohne Bordstein/Trottoir).
Layout und Patch der Kreuzung verwenden diese statt der `core`-Breite — der Patch deckt nur noch die Fahrbahn. Entlang des Patch-Randes
läuft pro Ecke ein Trottoir-Streifen (`network/pavement.ts`, `mesh/junctionPavement.ts`): Bordsteinfläche, Trottoir-Oberseite, Schürze bis
zum Terrain; er läuft um Rundungen, Spitzen und über die geraden Lücken zwischen fluchtenden Armen und verjüngt sich auf 0, wenn nur ein
Nachbar ein Trottoir hat. Gefundener und behobener Fehler: `profileHeightAt` lieferte auf einer senkrechten Stufe (Bordstein) je nach Seite
die obere oder untere Höhe → Patch-Kante und Trottoir-Höhe an der linken Armseite waren um 12 cm versetzt (`profileHeightInside`).

**Bekannte Grenzen:**
- Fussgängerampeln zeigen nur Rot/Grün-Scheiben (kein Männchen-Symbol, kein Blinkgrün); keine Anforderungstaster, keine Abbiegepfeile/-phasen,
  keine Linksabbieger-Konfliktmatrix (der Phasenplan kennt nur „gegenüber“ vs. „quer“), keine Koordination („grüne Welle“) zwischen Knoten.
- Signale brauchen ≥ 3 Motorstrassen-Arme (Rang ≥ 2); sonst keine Ampel.
- Pro Arm nur ein Signalkopf (rechts) — kein Gegenmast, kein Ausleger; Köpfe stehen neben dem Fahrbahnrand, nicht über der Fahrbahn.
- Die gestrichelte Wartelinie ist ein Strich-Raster, nicht die genormten Haifischzähne; alle Masse sind Näherungen.
- Das Trottoir folgt dem Patch-Rand: bei sehr engen Radien (Radius < Trottoirbreite) wird der Streifen schmal/degeneriert; Radien unter
  ~2 m werden im Editor nicht verhindert. Zwischen Strassen mit unterschiedlichem Trottoir-Niveau gibt es keine Rampen/Absenkungen.
- Der Patch hat noch keine Fahrspur-Führungslinien (Abbiegepfeile, Leitlinien durch die Kreuzung).
- Kreisel, Auf-/Abfahrten: Phase 11.

---

## 2i. Umsetzungsnotizen Phase 8 (Brücken)

**Eine Brücke ist ein Abschnitt einer Strasse**: aufeinanderfolgende Punkte mit `mode: 'bridge'` (immer fest in der Höhe). Der Abschnitt
beginnt und endet jetzt **exakt auf diesen Punkten** (vorher: halbe Strecke zum Nachbarpunkt) — dort stehen die Widerlager. Zwei
verschiedene Bauwerksmodi direkt nebeneinander (Brücke → Tunnel) schnappen weiterhin zum näheren Ende.

**Brücken als Code** (wie Profile/Materialien): `export default (p, B) => B.bridge('Name').deck(…).girders(…).piers(…).abutments(…).railing(…)`
plus `.arch(…)`, `.truss(…)`, `.lamps(…)`; `export const params` erzeugt die Parameter-UI. Alle Optionen werden validiert/geklemmt
(`BridgeBuilder.finish`). `BridgeLibrary`: letzte funktionierende Version bleibt bei Fehlern, Auswertung pro (Name, Parameter) gecacht
(Objekt-Identität stabil → der Diff im `RoadSystem` baut nur die betroffenen Strassen neu). 6 Typen: **Holzsteg** (Wanderwege),
**Plattenbrücke** (Bäche), **Balkenbrücke** (Längsträger, Hammerpfeiler), **Viadukt** (Kastenträger, Zwillingspfeiler), **Bogenbrücke**
(Steinbögen, Zwickelstützen oder massiver Zwickel), **Fachwerkbrücke** (Stahlfachwerk). `RoadDef.bridge` / `bridgeParams` wählen den
Typ; ohne Angabe passt der Typ zum Rang des Profils (`defaultBridgeName`). Gespeichert wird im Bibliotheksdokument
(`roadlib-save.php` trägt `bridges` mit; Schreiben nur für Editoren — Code ist ausführbar).

**Deck.** Der Strassenkörper ist auf Brücken eine **Platte** der Dicke `deck.thickness` (statt Wände bis zum Terrain), seitlich auf
die Fahrbahn (`core`) beschnitten: Bankett/Graben fallen weg (gleiche Punktzahl, die Aussenpunkte kollabieren auf die Kante, damit ein
Chunk Strassen- und Brückenringe mischen kann); Material der Unterseite = `deck.material`. Brücken-Samples lesen das Terrain
trotzdem (Pfeiler brauchen es), ihre Höhe folgt ihm nie.

**Bauwerk** (`structures/bridgeGeometry.ts`, alles aus **Lofts** konvexer Ringe, analytische Normalen, UVs in Metern): Längsträger,
Pfeiler (Säule/Wand/Zwilling/Hammer, rund/eckig, Anzug, Querriegel, Fundament; wachsen bis zum Terrain, Spannweiten teilen den Abschnitt
gleichmässig — nur vom Abschnitt abhängig, nie vom Chunk), Widerlager + Flügelmauern (oben Fahrbahnkante, unten Terrain), Geländer
(Stahl, Brüstung, Holz), Bogenrippen + Zwickel, Fachwerk (Warren, Querriegel), Laternen. **Nahtregeln:** kontinuierliche Teile aus den
Ring-Samples des Chunks (die gemeinsame Randsample ⇒ nahtlos), diskrete Teile gehören dem Chunk, der ihre Position enthält, das
Fachwerk teilt jeden Chunk in ganze Felder (ein Knoten liegt immer auf der Chunk-Grenze). `BridgeLayer` spiegelt `PropLayer`
(zusammengeführtes Mesh pro Chunk, Ersetzen/Entfernen, Wiederholung bei noch unbekanntem Terrain, Sichtweite).

**Flusskreuzungs-Vorschlag** (`structures/suggest.ts`): `suggestBridges(roads, rivers, terrain)` mit `RiverLike` (Polylinie in SIM-Koordinaten +
Breite — unabhängig vom Spielcode): Schnittpunkte Strasse × Fluss, Mäander (< 40 m) zu einer Kreuzung zusammengefasst, Länge = Flussbreite +
2 × 8 m (min. 14 m), Deckhöhe = Höhe an den Ufern, angehoben bis das Deck das Terrain dazwischen um 1.2 m überragt. `applyBridgeProposal` setzt
neue Punkte an den Ufern (vorhandene in der Nähe werden wiederverwendet), wandelt die Punkte dazwischen um — **ein Undo-Schritt**. Editor:
Tab „Brücke“ (Code + Typwahl + Liste der Kreuzungen mit „Brücke setzen“), Strassen-Inspector (Typ + Parameter).

**Gefundene und behobene Fehler:** (1) `cloneRoad` verlor unbekannte Strassenfelder (`bridge`/`bridgeParams`) bei jeder Bearbeitung/Speicherung;
(2) Annäherungsrampen zu einem festen Punkt (Brückenende) mischten Terrain- und Entwurfshöhe und konnten **unter** dem Terrain liegen →
gemischte Samples werden jetzt nie unter Terrain + Abstand gedrückt (`RoadRuntime.tryBuildChunk`).

**Bekannte Grenzen:**
- Kein echtes Wasser / keine Flussdaten im Modul: Pfeiler stehen auf dem Terrain, auch mitten im Fluss; Vorschläge brauchen die Flüsse als Eingabe
  (`RiverLike`) — die Anbindung an das `RiverDef` des Spiels ist ein dünner Adapter (Phase 12). Das Flussbett wird nicht freigestellt.
- Brückenhöhe/-länge sind einfach: gerades Deck zwischen den Ufern, keine Prüfung auf Lichtraumprofil (Unterführungen), keine Steigungs-/Rampenwarnung.
- Das Terrain unter der Brücke wird nicht verändert (kein Böschungs-Carve, Phase 10); steile Hänge neben Widerlagern bleiben steile Hänge.
- Bogenbrücken: Parabelbogen pro Spannweite, Stützen/Zwickel nur senkrecht; auf schiefem Gelände (Spannweitenenden auf verschiedenen Höhen) werden die
  Bogenfüsse einzeln auf das Terrain gesetzt, ohne Rücksicht auf Bogenschub. Fachwerk: Warren-Muster, Knoten pro Chunk neu aufgeteilt (Feldlänge
  kann pro Chunk um wenige Prozent abweichen).
- Brückenstrassen in Kurven: die Unterkonstruktion folgt der Strasse, aber Pfeilerachsen sind gerade Quader (bei engen Radien sichtbar).
- Beleuchtung/Unterseite sind Lambert wie alles: die Deckunterseite ist dunkel. Keine Lager, Fugen, Entwässerung, Kabel/Hängebrücken (später).
- Brücken über Strassen (Überführung): der Strassenkörper darunter ist unabhängig; Pfeiler stehen auf dem Terrain, nicht neben der Strasse.

---

## 2j. Umsetzungsnotizen Wasser (Flüsse, Seen, Wasserfälle)

**Entscheid:** Die generierten swissTLM3D-Flüsse werden **nicht** mehr benutzt. Die wenigen Flüsse werden von Hand im Tool gezeichnet; das Modul hat dafür
ein eigenes Datenmodell (Schwester von `RoadDef`), das im selben Dokument liegt (`RoadsDocument.rivers` / `lakes`, optional → ältere Dokumente bleiben gültig).

**Datenmodell** (`water/types.ts`): `RiverDef` = Punktliste `{x, y, z, width?, depth?, seg?}` — `y` ist der **Wasserspiegel** am Punkt, `seg` die Art des
Abschnitts *nach* dem Punkt: `river` · `rapids` (Stromschnelle) · `fall` (Wasserfall: fällt frei vom Punkt zum nächsten, beliebig tief; unter 0.8 m Höhe wird er zur
Stromschnelle). `startLake` / `endLake` / `endRiver` verbinden Enden mit Seen bzw. anderen Flüssen. `LakeDef` = Spiegel `level`, `depth`, Umriss (Chaikin-geglättet, die
gleiche Linie für Terrain und Mesh). Alles wird validiert/geklemmt (`sanitizeWaters`), `normalizeWaters` erhält die Objektidentität (Diff im System).

**Hydrologie** (`water/hydro.ts`): Pegel nie bergauf (monotone Pegel + `MIN_SLOPE`, PCHIP pro Lauf), Gefälle → Geschwindigkeit/Turbulenz; Wasserfälle als ballistische
Kurve `x = run·√f, y = −H·f` (analytische Tangente), Breite aus der Kante. **Terrain-Carve** (`water/field.ts`): reine Funktion `modify(x, z, base)`: Kanal und Becken setzen die
Höhe *exakt* (schneiden **und** füllen), Böschung und Deich nur formend (V-Tal bis 8× Uferbreite; gegen tieferes Gelände ein Deich 0.25 m über dem Wasser, Böschung 1:1.5).
Wasserfälle bekommen Schluchtwände und einen Gumpen (Becken am Fuss). Das Terrain bekommt dafür nur zwei Haken (am Mock: `modifier`, `tint`, `invalidate(rect)`,
`baseHeightAt`) — derselbe Mechanismus, den die Strassen später für ihr Carve brauchen (Phase 10).

**System** (`water/system.ts`, wie `RoadSystem`): Diff nach Identität, Chunks (48 m, Fälle als eigene Chunks), gebaut erst nach dem Carve (`flush()` nach Debounce) und wenn das Terrain
*settled* ist. Strassen, die dem veränderten Terrain nahe sind, werden danach neu gebaut (`RoadSystem.invalidateRect`; die alten Meshes bleiben bis zum Ersatz sichtbar).

**Darstellung:** ein Shader-Material für Fluss/See/Fall (`water/waterMaterial.ts`, ohne Texturen): tiefenabhängige Farbe aus dem echten Terrain, Wellen, **Strömungsstreifen in
Fliessrichtung**, Schaum am Ufer (aus der Tiefe), auf Stromschnellen (Turbulenz) und **um und hinter allem, was aus dem Wasser ragt** (Felsen, Brückenpfeiler → `Obstacle`),
weisse Schleier mit Streifen am Wasserfall. **Stromschnellen** sind eine echte Treppe (Vertex-Versatz): bei jedem Absatz eine schaumige Stufe in Form einer Rinne, dahinter ein Wechselsprung und eine ruhigere „Zunge“, dazu stehende Wellen, dichte Felsen. **Gumpen** (`pool`-Shader) wachsen mit der Fallhöhe (Radius/Tiefe nach `poolDims`): weisser Aufprall, Ringe, Schaumstreifen nach aussen, Randfelsen. Ufer: Streifen mit einem Strassen-Material (`banks.material`), Felsen (6 Varianten, in/neben dem Wasser), nasses Gelände (Tint).
**Partikel** (`water/particles.ts`): Spritzer an jeder Stromschnellen-Stufe und im Gumpen, Nebel/Dunst am Fuss von Wasserfällen (Grösse nach Fallhöhe), nur nahe der Kamera; die Fliessrichtung zeigt der Shader (Streifen und Schaum, die mit der Strömung wandern), nicht Partikel.

**Stile als Code** (`water/style.ts`, `WaterLibrary`, wie Profile/Brücken): `W.river('Name').size().colors().clarity().banks().flow().foam().rocks().particles().fall()` /
`W.lake(…)…waves()`; Presets: bach, wildbach, fluss, strom, bergsee, gletschersee, weiher. Gespeichert im Bibliotheksdokument (`waters`).

**Editor** (`editor/waterEditor.ts`): Werkzeuge **Fluss (R)** und **See (L)**, Handles, Einfügen, Verschieben, Entf, Undo; Inspector-Tab „Wasser“ (Stil + Parameter, Breite/Tiefe pro Punkt,
**Abschnitt danach: Fluss / Stromschnelle / Wasserfall**, Verbindungen, „Pegel aus Terrain“), Tab „Wasser-Stil“ (Code). Pegel folgen beim Zeichnen/Ziehen dem Gelände
(`water/autolevel.ts`: laufendes Minimum, Wasserfall-Fuss auf dem Boden darunter). Ein Fluss, dessen Ende in einem See liegt, mündet dort (und wird am Ufer gekappt,
`trimAtLake`). Brückenvorschläge lesen die gezeichneten Flüsse mit; Brückenpfeiler im Wasser werden Schaum-Hindernisse (`water/bridgeObstacles.ts`).

**Testseite:** `artifact/` baut `artifact/dist/index.html` — eine einzige Datei (three.js und Modul gebündelt) mit Testgelände (`water/demoScene.ts`: Bergsee → Wildbach mit Stromschnellen →
~390 m Wasserfall mit Gumpen → Talfluss mit kleinem Fall, Brücke, Seitenbach → unterer See), Kamera-Ansichten, Längsprofil und dem echten Editor. Die mitgelieferten Stile sind **vorkompiliert**
(`core/codeEval.ts`), die Seite läuft also auch, wo `eval` gesperrt ist (nur das Bearbeiten von Code braucht eval). `node artifact/build.mjs` baut sie (`--csp` zusätzlich eine Variante mit strikter CSP zum Testen).

**Bekannte Grenzen:**
- Das Wasser ist eine Oberfläche, kein Volumen: keine Interaktion mit dem Spieler (Eintauchen, Strömungskraft) — Abfrage `WaterField.waterAt()` ist vorbereitet.
- Der Carve gilt dem Mock-Terrain; im echten `StreamTerrain` braucht es den gleichen kleinen Patch (Modifier-Hook in der Kachelhöhe + Mesh, Phase 10).
  Die Auflösung des Terrains begrenzt die Ufer: bei 3 m Mesh-Abstand sind Flüsse unter ~3 m Breite eher Rinnen als Kanäle.
- Flüsse verzweigen nicht (nur Mündung in einen anderen Fluss, kein Delta); Wasserfälle sind eine Kurve in einer Ebene (keine Kaskaden mit mehreren Stufen — dafür mehrere Fälle hintereinander).
- Partikel sind CPU-gesteuerte Punkte (max. ~6000), keine Wasseroberfläche-Refraktion/-Reflexion der Umgebung (Himmelsfarbe + Fresnel).
- Seen haben keinen Abfluss-Pegel: Pegel ändern sich nur von Hand; ein See mit zwei Ausflüssen ist erlaubt, aber nicht überprüft.
- Wasserfarben/Schaum sind Lambert-unabhängig: kein Schattenwurf auf dem Wasser, keine Nacht-Beleuchtung.

---

## 2k. Umsetzungsnotizen Kreisel, Autobahn-Abzweigung, Tunnel

**Kreisel** (`network/roundabout.ts`): kein neuer Datentyp. Ein Kreisel ist ein Ring aus kurzen Strassen (Profil `kreisel`, Rang 6) zwischen Knoten, je ein Knoten pro Zufahrt; jeder Knoten ist eine
gewöhnliche Kreuzung, die Zufahrten haben einen niedrigeren Rang und bekommen dadurch automatisch „Kein Vortritt“. `buildRoundabout({x, z, radius, arms})` erzeugt Ring, Knoten und Zufahrten (oder nimmt eigene Punktlisten für eine
Zufahrt, z. B. die Talstrasse mit Brücke); `findRoundabouts` erkennt Ringe im Netz wieder (zusammenhängende `kreisel`-Strassen auf einem Kreis). Die **Mittelinsel** (Bordstein, Rasen, Baum, Sträucher) macht der
`IslandLayer` aus dem erkannten Ring — sie wird nicht gespeichert, sondern folgt dem Netz.

**Abzweige** (`network/branch.ts`): ein Abzweig (Ausfahrt, Einfahrt, Rampe, Gleis-Weiche) braucht keine Kreuzung. `branchPoints({main, s, side, halfMain, halfBranch, taper, gap, tail, merge})` erzeugt die ersten Punkte
einer neuen Strasse aus der Mittellinie der Hauptstrasse: sie beginnt als schmaler Streifen am Rand der Hauptfahrbahn (Querschnitt über `widthScale` auf ~0.1 verkleinert), wächst über den Taper (default 90 m) auf volle Breite
und entfernt sich dabei seitlich (`halfMain + halfBranch·w + gap·u²`); die Höhe folgt der Hauptstrasse. Es ist ein Generator: wird die Hauptstrasse später verschoben, folgt der Abzweig nicht. Mit `merge` läuft die Punktliste
zur Hauptstrasse hin (Einfahrt). Für Gleise: `halfMain` = Abstand des Hauptgleises von der Achse, `halfBranch = 0`, `gap` = Gleisabstand.

**Autobahnkreuz** (`network/interchange.ts`, `buildStackInterchange`): Autobahn A auf dem Boden, Autobahn B auf einer Hochstrasse darüber (Brücke `viadukt`, Zufahrtsdämme mit ≤ 4.5 % Steigung), vier Flyover-Rampen (je ein Quadrant),
die in der Luft von B abzweigen, in einer Vierteldrehung sinken und am Boden in A einfädeln — alles gewöhnliche `RoadDef`s. Rampenabschnitte > 4.5 m über Grund sind Brücken, tiefere liegen auf einem Damm (`elev: 'fixed'`).
**Pfeiler weichen aus** (`pierPositionsFor`, `sections.ts`): ein Pfeiler, der auf eine Strasse unter der Brücke fallen würde, rutscht zum nächsten freien Punkt (Spannweiten werden dadurch länger/kürzer); die Strasse unten wird über
`RoadRuntime.siblings()` gefunden. **Grenze:** das Ausweichen wird beim Bau berechnet — wird nur die untere Strasse später verschoben, ziehen die Pfeiler nicht nach, bis die Brücke neu gebaut wird.
Keine Verzögerungs-/Beschleunigungsspuren, keine Verflechtungsstrecken.

**Schienen** (`rail/`, Profile `gleis`, `gleis_doppel`, `bahnhof`): ein Gleis ist eine Strasse, deren Profil ein **Gleisbett** (Material `ballast`, Segmentart `ballast`/`walkway`/`platform` — keine Fahrbahnart, also kein Kreuzungs-Patch) und eine `RailSpec`
(`R.profile(..).rail({tracks, gauge, sleeperSpacing}).catenary({height, spacing}).signals({spacing, start})`) hat. Das Gleisbett ist normale Strassenoberfläche — Geländeanpassung, Brücken, Tunnel und Pfeilerausweichen gelten ohne Sonderfall.
Der `RailLayer` baut pro Chunk (aus absoluten Bogenlängen, damit Chunkgrenzen nichts verdoppeln): **Schwellen** (Betonbalken alle 0.6 m), **Schienen** (Prisma pro Seite, durchgehend), **Fahrleitung** (Masten mit Ausleger/Strebe
alle 56 m aussen am Bett, Tragseil mit Durchhang, Fahrdraht 5.5 m über Schienenoberkante mit ±0.2 m Zickzack, Hänger; im Tunnel nur Fahrdraht mit Hängern an der Decke; keine Masten im Tunnel), **Lichtsignale** (rechts neben dem Gleis,
dem Zug zugewandt, Zeigerbild statisch rot/gelb/grün aus dem Strassen-Seed). Eisenbahnbrücken: `defaultBridgeName` wählt bei Gleisprofilen `eisenbahnbruecke`; der Demo-Viadukt ist eine Bogenbrücke. Der Bahntunnel ist höher
(`tunnelDims`: Wand 4.0 m + Bogen 2.9 m, damit der Fahrdraht Platz hat). Der Bahnhof hat Aussenbahnsteige (55 cm über SO) mit gelber Kante, Dächern (`platform_canopy`), Bänken und Leuchten als normale Prop-Regeln.
**Grenzen:** keine Züge/Fahrzeuge; keine Bahnübergänge (Gleis kreuzt Strassen nur über/unter ihnen); die Weiche ist ein Abzweig-Generator ohne Herzstück/Zungen (zwei Gleise laufen auseinander); Masten nur an den Aussenseiten
(Mittelgleise bei > 2 Gleisen ohne Mast); Signale statisch; Gleise brauchen grosse Radien (`smooth(140…200)`), enge Kurven werden nicht geprüft.

**Tunnel** (`tunnel/`): Punkte mit Typ `tunnel` (oder `gallery`, bisher gleich behandelt) bilden einen Abschnitt, der exakt auf den Punkten beginnt und endet (`tunnelSections`). Die Röhre liegt im Berg und ist von aussen nicht sichtbar; man sieht
(1) das **Portal** — eine Stirnwand aus Spalten zwischen dem abgegrabenen Boden und dem Hang dahinter, mit ausgeschnittenem Bogen, und (2) die **Auskleidung** (Bogenquerschnitt, Lichtbänder an der Decke), die man durch die Öffnung sieht. Dafür wird das
Gelände vor dem Portal ausgehoben (`TunnelField`, wie `WaterField` eine reine Funktion `modify(x, z, base)`): ein Einschnitt mit flachem Boden und Böschung 1 : 1.5, der nach 28 m mit 5.5 % ansteigt und ausläuft; hinter dem Portal wird der Hang ab der Portaloberkante mit 45° zurückgeschnitten.
`TunnelSystem` hält das in Sync (Debounce, Terrain neu erzeugen, nahe Strassen neu bauen; `RoadSystem.invalidateRect`). Das Mock-Terrain hat dafür **benannte Modifier** (`setModifier(id, fn)`): Wasser und Tunnel formen das Gelände gleichzeitig.

**Bekannte Grenzen (Tunnel):** keine Lüftungsschächte, Nothaltebuchten, Querstollen, Beleuchtungsgruppen; keine Galerie mit einseitiger Öffnung; Portale sind eine ebene Stirnwand senkrecht zur Strasse (keine schräge Stirn, keine Flügelmauern ausser den Spalten der Schnittkante);
das Terrain über der Röhre wird nicht geprüft (die Überdeckung ist Sache des Entwurfs; ist der Hang niedriger als die Röhre, ragt die Auskleidung heraus); im echten `StreamTerrain` braucht der Einschnitt denselben Modifier-Hook wie das Wasser.

---

## 3. Kernkonzepte im Detail

### 3.1 Spline & Terrain-Anpassung
- **Datenmodell wie `RiverDef`:** Punktliste pro Edge, Attribute **pro Punkt**:
  `{x, y, z, widthScale?, profile?, mode: 'road'|'bridge'|'tunnel'|'gallery'…, banking?, tension?}`.
  Bridge/Tunnel-Abschnitte ergeben sich aus aufeinanderfolgenden Punkten mit gleichem `mode`
  (einfach editierbar, keine getrennten Bereichs-Objekte).
- Interpolation: **zentripetaler Catmull-Rom** durch die Punkte (wie `riverField.ts`), Richtung
  immer aus der Pfad-Tangente, nie manuell; optionale „Ecke"-Markierung pro Punkt.
  Eigene Bogenlängen-Parametrisierung für gleichmäßiges Sampling und Attribut-Interpolation.
- Zeichnen im Editor: Klick auf Terrain setzt Punkte (mit gespeicherter `y`).
- **Höhenmodi:**
  - `fixed` – gespeicherte `y` der Punkte (Standard, stabil gegen Nachladen)
  - `drape` – folgt dem (settled) Terrain, geglättet
  - `graded` – Längsprofil-Solver: Terrain abtasten, glätten, **max. Steigung** und
    **Kuppen-/Wannenradius** einhalten, Aushub/Auftrag minimieren
  - `bridge` / `tunnel` – siehe 3.6
- **Banking/Überhöhung** automatisch aus Kurvenradius + Designgeschwindigkeit (Autobahn),
  oder manuell.
- Robuste **Frames** (rotation-minimizing + Banking), damit Profile in Steigungen/Kurven nicht
  verdrehen.
- Adaptives Sampling: nach Krümmung, Terrain-Rauheit und max. Segmentlänge.

### 3.2 Profile (das Herzstück)
Ein Profil ist eine **Querschnittsbeschreibung**, ausgewertet pro Sample-Ring entlang der Spline.

- Besteht aus **Strips** (Fahrstreifen, Bankett, Gehweg, Bordstein, Graben, Mittelstreifen,
  Randstein, Leitplankenfuß, Böschung …). Jeder Strip: Breite, Höhe/Quergefälle, Dicke,
  Material, UV-Modus, Tags (`lane`, `walkable`, `drivable`, …) für Queries/Lane-Graph.
- Rohmodus: beliebiges 2D-Polygon pro Strip (`R.strip({points:[[x,y],…]})`) für Sonderformen.
- **Variation entlang s:** Funktionen/Keyframes (`(s, ctx) => …`) für Breite, Spuranzahl,
  Rauschen (Wanderpfad „wackelt"), Aufweitungen (Abbiegespuren), Übergänge zwischen Profilen
  (Strips werden per ID gematcht und interpoliert).
- **Params-Schema** → Editor generiert UI automatisch.

Beispiel (so soll sich das anfühlen):

```js
export const params = {
  lanes:     { type: 'int',   min: 1, max: 4, default: 2 },
  laneWidth: { type: 'float', min: 2.5, max: 4, default: 3.25 },
  guardrail: { type: 'bool',  default: true },
};

export default (p, R) => R.profile('Landstraße')
  .thickness(0.6)                                   // Unterbau: verdeckt Terrain-Lücken
  .lanes(p.lanes, { width: p.laneWidth, material: 'asphalt', crown: 0.025 })
  .marking.center({ style: 'dashed', dash: [3, 6] })
  .marking.edge('both', { style: 'solid' })
  .shoulder('both', { width: 1.0, material: 'asphalt_worn' })
  .verge('both',    { width: 1.5, material: 'grass', slope: -0.08 })
  .ditch('both',    { depth: 0.5, width: 1.2 })
  .embankment({ slope: 1 / 2, material: 'terrain_blend' })
  .props.guardrail('both', { when: ctx => p.guardrail && ctx.dropHeight > 1.5 });
```

Mitgelieferte Presets (alle als editierbarer Code):

Die Preset-Familie orientiert sich an der **Schweizer Straßenhierarchie** (Normen VSS):

| Kategorie | Presets |
|---|---|
| Wege (Schweizer Wanderwege) | Wanderweg (gelb), **Bergwanderweg** (weiß-rot-weiß), **Alpinwanderweg** (weiß-blau-weiß), Trampelpfad, Waldweg, Fußweg, Radweg, Treppe, Holzsteg, Hängebrücken-Steg |
| Ländlich | Flurstraße/Feldweg (Spurrillen + Mittelgras), Schotterpiste, Waldstraße (Forst), Alp-/Güterstraße, Passstraße/Serpentine |
| Straßen | Gemeindestraße, Dorfstraße (Pflaster/Granitrandstein), Quartierstraße (Bordstein, Trottoir, Parkstreifen), Nebenstraße, Hauptstraße, Kantonsstraße |
| Schnellstraßen | Autobahn (2 Fahrbahnen, Mittelstreifen/Betonleitwand, Pannenstreifen), **Autostraße**, Auf-/Abfahrt, Rampe |
| Sonstiges | Kreisel, Rennstrecke (Kerbs, Auslaufzone), Bahnübergang, Gleis (gleiche Engine), Schmalspur/Zahnrad (später) |

Schweiz-typische Details als Props/Strukturen: Trockensteinmauern, Lawinengalerien, Pannenbuchten
in Tunneln, Postauto-Haltestellen, Brunnen, Wegkreuze, Randsteine aus Granit, gelbe
Wanderweg-Wegweiser, rot-weiße Bergwanderweg-Markierungen auf Steinen/Pfosten.

### 3.3 Extrusion / Mesh
- Querschnitt → Ringe → quer verbundene Strips; **gemeinsame Vertices** wo glatt,
  **dupliziert** an harten Kanten (Bordstein, Seitenwände).
- Geschlossene Körper (Oberseite, Seiten, Unterseite) → echte Dicke.
- UVs in Metern (u quer, v längs) → Texturen/Shader tilen konsistent; Tangenten für Normal Maps.
- **Kurven-Cusps:** Offsetkurven auf der Innenseite enger Kurven werden per Krümmung geklemmt,
  sonst entstehen Selbstüberschneidungen.
- **Floating-Origin pro Chunk** gegen Präzisionsprobleme in großen Welten.
- Chunking (z. B. 64–128 m Edge-Abschnitte) für Culling, LOD und schnelles Teil-Rebuild.

### 3.4 Straßennetz & Kreuzungen
- Graph: `Node` (Endpunkt/Kreuzung) und `Edge` (Spline + Profil + Abschnitte).
- **Kreuzungs-Mesher** (größtes technisches Risiko, daher früh prototypen):
  1. Arme am Node nach Winkel sortieren
  2. Jeden Arm um einen Setback zurückstutzen
  3. Zwischen benachbarten Armen Eckverrundung (Fillet-Kurve, Radius = Bordsteinradius)
  4. Randpolygon triangulieren, Höhen aus den Armen interpolieren (Coons-Patch)
  5. Dicke/Unterbau + Bordsteine + Gehwege um die Ecke
- Unterstützte Typen: Y, T, X, n-Arm, Einmündung mit Profilwechsel, Sackgasse (Wendekreis),
  Kreisverkehr, Auf-/Abfahrt mit Beschleunigungsstreifen, **ebenengleiche Kreuzung mit
  Brücken-/Unterführungs-Variante** (Kleeblatt/Rampen später).
- Profilwechsel (z. B. Landstraße → Feldweg): automatische Übergangszone.
- **Vorfahrtsregeln** pro Node (rechts-vor-links, Vorfahrtstraße, Stop, Ampel) → erzeugt
  automatisch Schilder, Haltelinien, Zebrastreifen.

### 3.5 Oberflächen & Markierungen
- Material-Registry: PBR-Texturen **oder** prozedurale Shader (`onBeforeCompile`/ShaderMaterial,
  später optional TSL). Prozedural: Asphalt, Schotter, Erde, Pflaster, Holz, Beton, Kies, Gras.
- **Layer pro Strip:** Basis + Verschleiß (Spurrillen, Mittelabnutzung, Risse, Flicken,
  Pfützen) + Kantenverschmutzung + globale Uniforms (nass, Schnee, Laub, Alter).
- **Markierungen** aus dem Profil generiert (gestrichelt, durchgezogen, doppelt, Randlinie,
  Pfeile, Zebrastreifen, Haltelinie, Sperrflächen) als dünne Geometrie mit `polygonOffset`;
  an Kreuzungen als projizierte Patches.
- Alle Materialien per Code definierbar & im Editor live editierbar.

### 3.6 Brücken & Tunnel
Beides sind **Abschnitte `[s0, s1]` einer Edge**, deren Generator Code ist.

- **Brücken:** Balken/Platte, Bogen, Fachwerk, Viadukt; Seil-/Hängebrücke später.
  Fahrbahn entkoppelt vom Terrain (`fixed`-Höhenprofil), **Pfeiler** wachsen automatisch bis
  zum Terrain (Abstand, Form, Fundament konfigurierbar), **Widerlager** an den Enden,
  Geländer/Brüstung/Leitplanke, Lichtraumprofil-Prüfung (Unterführung).
- **Tunnel:** Röhre aus eigenem Profil (Wand, Decke, Beleuchtung), **Portale** (Stile),
  Einschnitt + Stützwände am Portal, Lampen/Notausgänge als Props.
- **Terrain-Löcher:** Heightfield-Terrain kennt keine Überhänge und kein CSG. Siehe Kapitel 2a
  („Tunnel – kein Loch im Terrain nötig"): Portal-Graben per Carve + Stirnwand, Tunnelröhre als
  eigene Geometrie, Depth-Maske nur als Fallback.
- Weitere Strukturen: Durchlass/Kanal, Furt, Stützmauer, Galerie (Lawinenschutz), Treppen,
  Holzsteg, Hängebrücke für Wanderwege.

### 3.7 Props, Schilder, Ampeln, Leitplanken
- **Scatter-Regeln** entlang Edges:
  `{ asset, side, offset, spacing, jitter, align, when(ctx), seed }` → InstancedMesh.
- **Leitplanken:** durchgehende extrudierte Schiene + instanzierte Pfosten, Endstücke,
  *Auto-Regel* (bei Absturzhöhe > X, Außenkurve, an Brücken, vor Hindernissen).
  Varianten: Stahl, Beton (New Jersey), Holz, Seil.
- **Schilder:** prozedural gezeichnet (Canvas/SVG → Atlas), Katalog **Schweiz (SSV)** als
  Default, umschaltbare Regionen; Masten, Doppelschilder, Wegweiser mit Ortsnamen
  (Autobahn grün, Hauptstraßen blau, Wanderwege gelb). Schweizer Besonderheiten: gelbe
  Markierungen (Parkverbot, Zonen), blaue Zone, Vortritt/Rechtsvortritt.
- **Ampeln:** Mast/Ausleger-Varianten, Signalgruppen, **Phasenplan automatisch aus
  Kreuzungstopologie** (Konfliktmatrix), Modi: Festzeit, blinkend, aus; Emissive-Lampen,
  Fußgängerampeln, Haltelinien.
- Weitere: Laternen (**keine** echten PointLights pro Lampe – emissive + gepoolte Lichter /
  Fake-Lichtkegel), Leitpfosten, Poller, Zäune, Alleebäume, Kilometersteine, Kanaldeckel,
  Bodenschwellen, Rüttelstreifen, Lärmschutzwände, Wegkreuze/Bänke an Wanderwegen.

### 3.8 Query-/Gameplay-API (Ergänzung)
Spielkontext: **Wingsuit-Spiel** (Flug über das Gelände, Crash auf der Straße) und
**später evtl. Fahrzeuge** auf der Straße. Daraus folgt:
- **Crash-/Kollisionsabfrage** ohne Physik-Engine: `roads.intersectSegment(a, b)` /
  `roads.raycast(origin, dir)` (Schnitt mit Straßenkörper, Leitplanken, Schildern, Brücken/
  Tunnelwänden, Masten) → Treffer mit Oberfläche und Normale. Basis: räumlicher Index
  (Grid/BVH) über vereinfachte Kollisionsgeometrie, nicht über die Render-Meshes.
- **Oberflächentyp** (Asphalt, Kies, Gras, Wasser…) für Crash-Effekte/Sounds.
- **Hohe Fluggeschwindigkeit:** LOD und Streaming der Straßen-Chunks (Fernsicht, Nachladen
  vorausschauend entlang der Flugbahn) werden früh mitgedacht; Props haben Sicht-/Detail-Distanzen.
- **Fahrzeug später:** Reibungswerte pro Oberfläche, Lane-Graph, Fahrbahnhöhe/Normale
  (`sampleAt`) mit glatter Tangenten-Interpolation, optional Collider-Export.
- `sampleAt(point)` → Edge, s, Querposition, Höhe, **Oberflächentyp**, Reibung.
- `nearestRoad`, `raycast`, **Lane-Graph** (Spuren + Abbiegebeziehungen) für Verkehr/AI,
  `findPath(a, b)`.
- **Collider-Export**: vereinfachte Trimesh/Heightfield-Daten für Rapier/cannon-es/Ammo.

### 3.9 Editor (Live, code-basiert)
- **Viewport-Tools:** Straße zeichnen (auf Terrain klicken), Punkte/Handles verschieben
  (TransformControls), Segment teilen, Edges verbinden → Kreuzung, Löschen,
  Snapping (Node, Winkel, Raster, Höhe), Brücken-/Tunnelbereich per Slider auf der Edge markieren.
- **Code-Editor (CodeMirror 6)** für Profile, Brücken, Tunnel, Materialien, Prop-Regeln:
  Auto-Complete für die DSL-API, Fehler mit Zeilenangabe, Debounce + Hot-Reload der Auswertung
  (Fehler im Code zerstören nie den letzten funktionierenden Zustand).
- **2D-Querschnittsvorschau** des Profils live neben dem Code, plus Inspector mit
  auto-generierten Params-Controls (Tweakpane).
- **Undo/Redo** (Command-Pattern), Autosave, Speichern/Laden (JSON), Preset-Bibliothek.
- **Debug-Overlays:** Spur-Graph, Frames/Normalen, Krümmungs- und Steigungs-Heatmap,
  Trassierungswarnungen (zu steil, Radius zu klein, Brückenhöhe zu niedrig).
- **Primär: integrierter In-Game-Editor.** `mountEditor(host)` mit einem `EditorHost`
  (`scene`, `camera`, `renderer`, `terrain`, `store`, Eingabe-Arbitrierung gegenüber den
  Spielsteuerungen). Editiert wird direkt im geladenen Spielgelände (richtige Terrain-Streaming-
  Situation, `y` aus *settled* Terrain). Speichern per `RoadStore` auf den Server
  (Revision/Locking, siehe 2a). Zusätzlich läuft derselbe Editor in `demo/` gegen ein
  **Mock-`StreamTerrain`**, das `null`/`isSettledAt`/Nachladen simuliert.

---

## 4. Ergänzende Ideen (über deinen Wunsch hinaus)

| Idee | Nutzen |
|---|---|
| **Road-Mask-Textur fürs Terrain** (Distanzfeld) | Gras/Erde blendet sauber an der Straße, Vegetation wird auf Straße automatisch ausgespart |
| **Terrain-Carving / Böschungen / Einschnitte** | Straße sitzt „eingebettet", Hanglagen sehen glaubwürdig aus |
| **Auto-Routing (A\* über Terrain)** | Straße von A nach B mit Steigungskosten → natürliche Serpentinen, Wanderwege entlang von Höhenlinien |
| **Trassierungsvalidierung** (Entwurfsgeschwindigkeit → Mindestradius/Max-Steigung) | Realistische Autobahnen/Passstraßen, Warnungen im Editor |
| **Lane-Graph + Verkehrs-API** | Fahrzeug-AI, Navigation, Ampelsteuerung funktionieren sofort |
| **Wetter/Alter/Jahreszeit-Uniforms** | Nasse Straße, Schnee, Laub, Verschleiß ohne neue Meshes |
| **Baking** (glTF + JSON) | Im Spiel nur Loader; Editor/Generator müssen nicht ausgeliefert werden |
| **swissTLM3D-Import** (analog zum Fluss-Seed) | Reales Schweizer Straßennetz als Startpunkt, im Editor nachbearbeitbar; GeoJSON/OSM später |
| **Schienen/Tram/Fluss/Kanal** | Gleiche Extrusions-Engine, fast kostenlos |
| **Straßenschäden/Baustellen** | Schlaglöcher, Absperrungen, Umleitungsschilder als Prop-Regeln |
| **Regionen-Sets** (StVO / MUTCD / …) | Schilder, Markierungen und Ampeln umschaltbar |

---

## 5. Technologie-Entscheidungen (Defaults, gerne ändern)

- **TypeScript**, ES-Module, `three` als *peerDependency* (`^0.170.0` wie im Spiel),
  `WebGLRenderer` mit `logarithmicDepthBuffer` (siehe 2a).
- **Vite** für Demo/Editor, **Vitest** für Tests, **CodeMirror 6** (leicht) statt Monaco,
  **Tweakpane** für Parameter-UI.
- **Materialien:** `MeshLambertMaterial` (wie das Terrain) + `onBeforeCompile`, optional
  `MeshStandardMaterial` in der Demo; Definition über eine
  **Material-Registry** (`kind: 'procedural' | 'texture'`): zunächst rein prozedural; eigene
  Texturen ersetzen später einzelne Registry-Einträge, ohne Profile/Daten zu ändern
  (Profile referenzieren nur Material-*Namen*).
- Profile/Brücken/Materialien: **JS-Quelltext als Strings** (in JSON gespeichert), per
  `new Function` in kontrollierter Sandbox mit injiziertem `R`-API ausgewertet.
- Mesh-Building optional im **Web Worker** (transferable Buffers) – zunächst synchron,
  Architektur ist dafür vorbereitet.
- Demo-Terrain: prozedurales Simplex-Noise-Heightfield, damit alles ohne dein Spiel testbar ist.

---

## 6. Roadmap

Jede Phase endet mit etwas **Sichtbarem und Lauffähigem** in der Demo (gegen das Mock-`StreamTerrain`).

| # | Phase | Ergebnis / Abnahmekriterium |
|---|---|---|
| 0 | **Setup** ✅ | Vite+TS+Vitest, Demo-Szene, **Mock-`StreamTerrain`** (Heightmap, Kachel-Streaming, `null`/`isSettledAt`, Logdepth-Renderer), Orbit-Kamera, Debug-Draw |
| 1 | **Core** ✅ (ohne Kreuzungs-Prototyp) | `TerrainSource`-Adapter, `WorldAdapter`, Catmull-Rom + Bogenlänge, Frames, Krümmung, Höhenmodi (`fixed`/`drape`/`graded`), `resync()`; Tests. Parallel: Kreuzungs-Prototyp |
| 2 | **Profil + Extrusion (MVP)** ✅ | Straße per Klick aufs Terrain zeichnen (`drape` auf gesettelte Höhe, `y` als Fallback); Presets Flurstraße & Hauptstraße; Dicke verdeckt Terrain-Lücken; Nachladen des Terrains lässt nichts schweben |
| 3 | **Persistenz + Mini-Editor** ✅ | Datenmodell + `RoadStore` (Memory/HTTP), Punkte verschieben, Profil-Code live editieren, Params-UI, 2D-Querschnitt, Undo/Redo, Revisionen |
| 4 | **Netzwerk + Kreuzungen** ✅ | Graph, Y/T/X-Kreuzungen, Profilübergänge, Sackgasse |
| 5 | **Oberflächen & Markierungen** ✅ | Material-Registry + prozedurale Materialien (austauschbar), Verschleiß-Layer, Markierungen, alle Basis-Presets (Wanderweg → Autobahn) |
| 6 | **Props** ✅ | Scatter-System, Leitplanken (+Auto-Regel), Laternen, Schilder (SSV), Vortrittsschilder automatisch |
| 7 | **Ampeln** ✅ | Signalgruppen, automatischer Phasenplan, Fußgängerstreifen, Haltelinien |
| 8 | **Brücken** ✅ | Balken/Bogen/Viadukt, Pfeiler bis Terrain, Widerlager, Geländer, Flusskreuzungs-Vorschlag |
| 8b | **Wasser** ✅ | Handgezeichnete Flüsse, Seen, Stromschnellen, Wasserfälle (Carve, Schaum, Partikel, Stil-Code), Testseite (Artefakt) |
| 9 | **Tunnel** ✅ (Grundlage) | Röhre mit Auskleidung + Licht, Portale, Einschnitt (Carve) — siehe 2k; offen: Überdeckungs-Validierung, Galerien, Lüftung |
| 10 | **Terrain-Modifier** | `TerrainModifier`-Interface, `RoadTerrainModifier` (Absenken + Anheben), Patch-Vorschlag für `StreamTerrain`, Böschungs-Skirts |
| 11 | **Erweiterte Topologie** | Kreisel ✅ (Ring aus Knoten, 2k), Auf-/Abfahrten mit Spurzusatz, Autobahnkreuz-Bausteine, Unterführungen |
| 12 | **In-Game-Editor** | `mountEditor(host)` im echten Spiel, Eingabe-Arbitrierung, `HttpRoadStore`, Konfliktdialog, Auth-Hinweise |
| 13 | **swissTLM3D-Import** | `tools/`-Skript (Python wie `extract_rivers.py`) + Importer → Netz aus Objektart/Belag/Kunstbaute (nur Strassen: Flüsse werden von Hand gezeichnet, siehe 2j) |
| 14 | **Gameplay-API** | `sampleAt`, Lane-Graph, `findPath`, Collider-Export, Road-Mask-Textur, Vegetations-Ausschluss |
| 15 | **Tools & Performance** | Auto-Routing, Trassierungsvalidierung, Worker-Build, LOD, Baking (ohne `new Function` im Release) |
| 16 | **Politur** | Doku, Beispiele, Tests, API-Stabilisierung |

Phasen 2–3 liefern früh etwas Benutzbares. Die Kreuzungen werden bereits in Phase 1 als
isolierter Prototyp angegangen (größtes Geometrie-Risiko). Der Terrain-Modifier (Phase 10)
ist bewusst *nach* dem Straßenkörper: Das Modul funktioniert vollständig ohne Eingriff ins Terrain.

---

## 7. Technische Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Robustheit des Kreuzungs-Meshers (spitze Winkel, unterschiedliche Profile) | Früh prototypen, viele Testfälle (Property-Tests mit zufälligen Winkeln/Profilen) |
| Selbstüberschneidung auf Kurveninnenseite | Krümmungs-Clamping + Mindest-Sampling |
| Z-Fighting bei Markierungen | `polygonOffset`, Markierungen als eigene Geometrie mit kleinem Offset, logarithmischer Depth-Buffer bei Bedarf |
| Tunnel unter Heightfield (kein CSG) | Portal-Graben (nur Absenken) + Stirnwand, Tunnelröhre als eigene Geometrie, Depth-Mask-Fallback |
| Schweben/Springen durch nachladende Terrain-Kacheln | Gespeicherte `y` pro Punkt, Bau erst nach `isSettledAt`, budgetiertes `resync()` |
| Rückkopplung Carve ↔ `heightAt()` | Alignment aus Basis-Höhe bzw. fixierten `y`, nie aus bereits abgesenktem Terrain |
| Log-Depth-Buffer bei eigenen Shadern | `onBeforeCompile` auf `MeshStandardMaterial`; sonst `logdepthbuf_*`-Chunks |
| Ausführbarer Code aus Server-Daten | Authentifizierter Schreibzugriff, Backup/Revisionen, Release-Baking ohne `new Function` |
| Naht-Konsistenz zwischen Chunks / Kreuzungen | Gemeinsame Rand-Samples, deterministische Tessellierung |
| Rebuild-Kosten bei großen Netzen | Dirty-Flags, Chunking, Worker |
| Floating-Point in großen Welten | Floating-Origin je Chunk (niedrige Priorität bei Location-Größe) |
| Code-Profile mit Fehlern/Endlosschleifen | Fehlerisolierung, letzter gültiger Stand bleibt, Iterationslimit im API-Layer |

---

## 8. Entscheidungen & offene Punkte

**Entschieden:**
- three.js `^0.170.0`, `WebGLRenderer` mit Logdepth-Buffer, TypeScript (Default).
- Terrain: `StreamTerrain` über `TerrainSource`-Adapter (`heightAt`, `isSettledAt`).
- Datenmodell/Persistenz/Mesh-Bau nach dem Vorbild der Flüsse (Punktliste, JSON pro Location,
  Catmull-Rom, manuelle `BufferGeometry`, `resync()`).
- In-Game-Editor mit Server-Speicherung; zunächst JSON-Datei pro Location mit Revisionen,
  DB später über `RoadStore` austauschbar.
- Prozedurale Materialien zuerst, später durch eigene Texturen ersetzbar (Material-Registry).
- Lokalisierung Schweiz (SSV-Schilder, Wanderweg-Farbcodes, VSS-orientierte Profile).

**Noch offen (Defaults in Klammern):**
1. **Koordinatenkonvention:** `x=Ost, z=Süd`, Spiegelung nur beim Mesh? (`WorldAdapter` mit
   konfigurierbarem Vorzeichen; wird gegen `riverField.ts` geprüft.)
2. **Crash-Mechanik:** Wie prüft das Spiel heute eine Bodenberührung des Wingsuit-Spielers
   (nur `heightAt`, oder Physik-Engine)? Bestimmt das Format der Kollisions-Query. (Eigener Index im Modul)
3. **Fahrzeuge:** Erst später; die Datenstrukturen (Lane-Graph, Reibung) sind vorbereitet. (Ja)
4. **Maßstab:** 1 Einheit = 1 m. (Ja)
5. **`StreamTerrain`-Anpassung** (generische Modifier, Anheben) erfolgt später als Patch-Vorschlag
   beim Integrationsschritt – bis dahin läuft das Modul gegen ein Mock-Terrain.
