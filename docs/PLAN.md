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
2. **Autoritative Höhe ≠ Terrain-Höhe.** Pro Punkt wird `y` **gespeichert** (wie `RiverPoint.y`),
   der Editor schreibt beim Setzen die *settled* Terrainhöhe. Dadurch „schwebt" nichts, wenn eine
   feinere Kachel nachlädt, und Brücken/Tunnel haben feste Höhen. Optionaler Modus `auto`
   (folgt dem Terrain) wird erst nach `isSettledAt` gebaut und kann per Editor-Button
   „Höhen fixieren" in feste `y`-Werte gebacken werden.
3. **Zirkularität vermeiden.** Carve verändert `heightAt()`. Das Längsprofil darf sich aber
   nicht aus dem *schon abgesenkten* Terrain ableiten (sonst Rückkopplung). Daher:
   Der Adapter liefert die **Basis-Höhe ohne Straßen-Modifier** (`heightAt` mit Modifier-Bypass
   bzw. Straßen-Modifier werden erst *nach* der Alignment-Berechnung eingespeist). Fixierte `y`
   in den Daten lösen das Problem grundsätzlich.
4. **Log-Depth-Buffer ist aktiv.** Materialien werden als `MeshStandardMaterial` +
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
| **GeoJSON/OSM-Import** | Reale Straßennetze → `highway=*` wird auf Profile gemappt |
| **Schienen/Tram/Fluss/Kanal** | Gleiche Extrusions-Engine, fast kostenlos |
| **Straßenschäden/Baustellen** | Schlaglöcher, Absperrungen, Umleitungsschilder als Prop-Regeln |
| **Regionen-Sets** (StVO / MUTCD / …) | Schilder, Markierungen und Ampeln umschaltbar |

---

## 5. Technologie-Entscheidungen (Defaults, gerne ändern)

- **TypeScript**, ES-Module, `three` als *peerDependency* (`^0.170.0` wie im Spiel),
  `WebGLRenderer` mit `logarithmicDepthBuffer` (siehe 2a).
- **Vite** für Demo/Editor, **Vitest** für Tests, **CodeMirror 6** (leicht) statt Monaco,
  **Tweakpane** für Parameter-UI.
- **Materialien:** `MeshStandardMaterial` + `onBeforeCompile`, Definition über eine
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
| 0 | **Setup** | Vite+TS+Vitest, Demo-Szene, **Mock-`StreamTerrain`** (Heightmap, Kachel-Streaming, `null`/`isSettledAt`, Logdepth-Renderer), Orbit-Kamera, Debug-Draw |
| 1 | **Core** | `TerrainSource`-Adapter, `WorldAdapter`, Catmull-Rom + Bogenlänge, Frames, Krümmung, Höhenmodi (`fixed`/`drape`/`graded`), `resync()`; Tests. Parallel: Kreuzungs-Prototyp |
| 2 | **Profil + Extrusion (MVP)** | Straße per Klick aufs Terrain zeichnen (gespeicherte `y`); Presets Flurstraße & Hauptstraße; Dicke verdeckt Terrain-Lücken; Nachladen des Terrains lässt nichts schweben |
| 3 | **Persistenz + Mini-Editor** | Datenmodell + `RoadStore` (Memory/HTTP), Punkte verschieben, Profil-Code live editieren, Params-UI, 2D-Querschnitt, Undo/Redo, Revisionen |
| 4 | **Netzwerk + Kreuzungen** | Graph, Y/T/X-Kreuzungen, Profilübergänge, Sackgasse |
| 5 | **Oberflächen & Markierungen** | Material-Registry + prozedurale Materialien (austauschbar), Verschleiß-Layer, Markierungen, alle Basis-Presets (Wanderweg → Autobahn) |
| 6 | **Props** | Scatter-System, Leitplanken (+Auto-Regel), Laternen, Schilder (SSV), Vortrittsschilder automatisch |
| 7 | **Ampeln** | Signalgruppen, automatischer Phasenplan, Fußgängerstreifen, Haltelinien |
| 8 | **Brücken** | Balken/Bogen/Viadukt, Pfeiler bis Terrain, Widerlager, Geländer, Flusskreuzungs-Vorschlag |
| 9 | **Tunnel** | Röhre, Portal-Fassade, Portal-Graben (Carve), Überdeckungs-Validierung, Beleuchtung, Galerien |
| 10 | **Terrain-Modifier** | `TerrainModifier`-Interface, `RoadTerrainModifier` (Absenken + Anheben), Patch-Vorschlag für `StreamTerrain`, Böschungs-Skirts |
| 11 | **Erweiterte Topologie** | Kreisel, Auf-/Abfahrten, Autobahnkreuz-Bausteine, Unterführungen |
| 12 | **In-Game-Editor** | `mountEditor(host)` im echten Spiel, Eingabe-Arbitrierung, `HttpRoadStore`, Konfliktdialog, Auth-Hinweise |
| 13 | **Gameplay-API** | `sampleAt`, Lane-Graph, `findPath`, Collider-Export, Road-Mask-Textur, Vegetations-Ausschluss |
| 14 | **Tools & Performance** | Auto-Routing, Trassierungsvalidierung, Worker-Build, LOD, Baking (ohne `new Function` im Release), GeoJSON-Import |
| 15 | **Politur** | Doku, Beispiele, Tests, API-Stabilisierung |

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
