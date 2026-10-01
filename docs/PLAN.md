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
   (`heightAt(x,z)`, `normalAt(x,z)`, optional `carve()`), nicht dein konkretes Terrain.
4. **Körper statt Decal.** Die Straße hat Dicke (Unterbau). Terrain-Lücken/Durchstoßungen werden
   dadurch verdeckt; zusätzlich optional Böschungen/Einschnitte für saubere Übergänge.
5. **Runtime ≠ Editor.** Editor-Code (Code-Editor, Tools, GUI) ist ein separates Paket und
   wird nicht ins Spiel gebündelt. Das Spiel lädt nur die Runtime (oder vorgebackene Daten).
6. **Performance by design.** Chunking, Instancing, Dirty-Rebuild, optional Worker.

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

## 3. Kernkonzepte im Detail

### 3.1 Spline & Terrain-Anpassung
- Pro Edge eine Kette kubischer Segmente (Bézier/Hermite) mit Kontrollpunkten
  `{pos, handleIn, handleOut, banking?, profileOverride?, elevationMode}`.
- Zeichnen im Editor: Klick auf Terrain setzt Punkte, Handles werden automatisch (Catmull-Rom)
  oder manuell gesetzt.
- **Elevation-Modi pro Abschnitt:**
  - `drape` – folgt dem Terrain (geglättet)
  - `graded` – Längsprofil-Solver: Terrain abtasten, glätten, **max. Steigung** und
    **Kuppen-/Wannenradius** einhalten, Aushub/Auftrag minimieren
  - `fixed` – manuelle Höhen (Brücken, Rampen)
  - `tunnel` / `bridge` – siehe 3.6
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

| Kategorie | Presets |
|---|---|
| Wege | Trampelpfad, Wanderpfad, Waldweg, Fußweg, Radweg, Treppe, Holzsteg, Hängebrücken-Steg |
| Ländlich | Feldweg (Spurrillen + Mittelgras), Schotterpiste, Forststraße, Passstraße/Serpentine |
| Straßen | Dorfstraße (Pflaster), Stadtstraße (Bordstein, Gehweg, Parkstreifen), Landstraße, Bundesstraße |
| Schnellstraßen | Autobahn (2 Fahrbahnen, Mittelstreifen/Betonleitwand, Standstreifen), Auf-/Abfahrt, Rampe |
| Sonstiges | Kreisverkehr-Ring, Rennstrecke (Kerbs, Auslaufzone), Bahnübergang, Gleis (gleiche Engine) |

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
- **Terrain-Löcher:** Heightfields kennen keine Überhänge. Lösung in zwei Stufen:
  `terrain.carve()` (falls dein Terrain es erlaubt: Einschnitt am Portal absenken) und als
  Fallback eine **Depth-Only-Maske** (Mesh ohne Farbschreiben, Render-Order), die das
  Terrain im Portalbereich ausblendet.
- Weitere Strukturen: Durchlass/Kanal, Furt, Stützmauer, Galerie (Lawinenschutz), Treppen,
  Holzsteg, Hängebrücke für Wanderwege.

### 3.7 Props, Schilder, Ampeln, Leitplanken
- **Scatter-Regeln** entlang Edges:
  `{ asset, side, offset, spacing, jitter, align, when(ctx), seed }` → InstancedMesh.
- **Leitplanken:** durchgehende extrudierte Schiene + instanzierte Pfosten, Endstücke,
  *Auto-Regel* (bei Absturzhöhe > X, Außenkurve, an Brücken, vor Hindernissen).
  Varianten: Stahl, Beton (New Jersey), Holz, Seil.
- **Schilder:** prozedural gezeichnet (Canvas/SVG → Atlas), Katalog **StVO** (Default) und
  umschaltbare Regionen; Masten, Doppelschilder, Wegweiser mit Ortsnamen.
- **Ampeln:** Mast/Ausleger-Varianten, Signalgruppen, **Phasenplan automatisch aus
  Kreuzungstopologie** (Konfliktmatrix), Modi: Festzeit, blinkend, aus; Emissive-Lampen,
  Fußgängerampeln, Haltelinien.
- Weitere: Laternen (**keine** echten PointLights pro Lampe – emissive + gepoolte Lichter /
  Fake-Lichtkegel), Leitpfosten, Poller, Zäune, Alleebäume, Kilometersteine, Kanaldeckel,
  Bodenschwellen, Rüttelstreifen, Lärmschutzwände, Wegkreuze/Bänke an Wanderwegen.

### 3.8 Query-/Gameplay-API (Ergänzung)
- `sampleAt(point)` → Edge, s, Querposition, Höhe, **Oberflächentyp**, Reibung
  (für Fahrzeugphysik/Schritte/Sounds).
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
- Der Editor läuft standalone in `demo/` und kann per `mountEditor(game)` in dein Spiel
  eingehängt werden.

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

- **TypeScript**, ES-Module, `three` als *peerDependency* (≥ r160), WebGL (WebGPU/TSL später).
- **Vite** für Demo/Editor, **Vitest** für Tests, **CodeMirror 6** (leicht) statt Monaco,
  **Tweakpane** für Parameter-UI.
- Profile/Brücken/Materialien: **JS-Quelltext als Strings** (in JSON gespeichert), per
  `new Function` in kontrollierter Sandbox mit injiziertem `R`-API ausgewertet.
- Mesh-Building optional im **Web Worker** (transferable Buffers) – zunächst synchron,
  Architektur ist dafür vorbereitet.
- Demo-Terrain: prozedurales Simplex-Noise-Heightfield, damit alles ohne dein Spiel testbar ist.

---

## 6. Roadmap

Jede Phase endet mit etwas **Sichtbarem und Lauffähigem** in der Demo.

| # | Phase | Ergebnis / Abnahmekriterium |
|---|---|---|
| 0 | **Setup** | Vite+TS+Vitest, Demo-Szene mit Terrain, Orbit-Kamera, Debug-Draw |
| 1 | **Core** | Spline, Bogenlänge, Frames, Krümmung, `TerrainSource`, `drape`/`graded`-Alignment; Tests |
| 2 | **Profil + Extrusion (MVP)** | Straße per Klick aufs Terrain zeichnen; Presets Feldweg & Landstraße; Dicke verdeckt Terrain-Lücken |
| 3 | **Mini-Editor (Vertical Slice)** | Punkte verschieben, Profil-Code live editieren, Params-UI, 2D-Querschnitt, Undo/Redo, Speichern/Laden |
| 4 | **Netzwerk + Kreuzungen** | Graph, Y/T/X-Kreuzungen, Profilübergänge, Sackgasse |
| 5 | **Oberflächen & Markierungen** | Prozedurale Materialien, Verschleiß-Layer, alle Fahrbahnmarkierungen, alle Basis-Presets (Wanderpfad → Autobahn) |
| 6 | **Props** | Scatter-System, Leitplanken (+Auto-Regel), Laternen, Schilder (StVO), Vorfahrtsschilder automatisch |
| 7 | **Ampeln** | Signalgruppen, automatischer Phasenplan, Zebrastreifen, Haltelinien |
| 8 | **Brücken** | Balken/Bogen/Viadukt, Pfeiler bis Terrain, Widerlager, Geländer |
| 9 | **Tunnel** | Röhre, Portale, Einschnitt, Terrain-Maske/Carving, Beleuchtung |
| 10 | **Erweiterte Topologie** | Kreisverkehr, Auf-/Abfahrten, Autobahnkreuz-Bausteine, Unterführungen |
| 11 | **Terrain-Integration** | Böschungen/Einschnitte, Road-Mask-Textur, Vegetations-Ausschluss, optionales Carving |
| 12 | **Gameplay-API** | `sampleAt`, Lane-Graph, `findPath`, Collider-Export |
| 13 | **Tools & Performance** | Auto-Routing, Trassierungsvalidierung, Worker-Build, LOD, Baking, GeoJSON-Import |
| 14 | **Politur** | Doku, Beispiele, Tests, API-Stabilisierung |

Phasen 2–3 liefern früh etwas Benutzbares; die Kreuzungen (Phase 4) werden **bereits in
Phase 1 als isolierter Prototyp** angegangen, weil dort das größte Risiko liegt.

---

## 7. Technische Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Robustheit des Kreuzungs-Meshers (spitze Winkel, unterschiedliche Profile) | Früh prototypen, viele Testfälle (Property-Tests mit zufälligen Winkeln/Profilen) |
| Selbstüberschneidung auf Kurveninnenseite | Krümmungs-Clamping + Mindest-Sampling |
| Z-Fighting bei Markierungen | `polygonOffset`, Markierungen als eigene Geometrie mit kleinem Offset, logarithmischer Depth-Buffer bei Bedarf |
| Tunnel unter Heightfield | Carving-Hook + Depth-Mask-Fallback |
| Naht-Konsistenz zwischen Chunks / Kreuzungen | Gemeinsame Rand-Samples, deterministische Tessellierung |
| Rebuild-Kosten bei großen Netzen | Dirty-Flags, Chunking, Worker |
| Floating-Point in großen Welten | Floating-Origin je Chunk |
| Code-Profile mit Fehlern/Endlosschleifen | Fehlerisolierung, letzter gültiger Stand bleibt, Iterationslimit im API-Layer |

---

## 8. Offene Fragen (mit meinem Default)

1. **TypeScript oder JavaScript?** → Default: TypeScript (JS-Nutzung bleibt problemlos möglich).
2. **Wie sieht dein Terrain aus?** (Heightmap-Textur / Mesh / chunked / Funktion / `three-terrain`?)
   → Default: `TerrainSource`-Interface, Adapter für Heightmap + Funktion.
3. **three.js-Version / WebGL oder WebGPU?** → Default: WebGL, r160+.
4. **Editor standalone oder in dein Spiel integriert?** → Default: beides (standalone Demo + `mountEditor`).
5. **Physik-Engine?** (Rapier, cannon-es, Ammo, keine) → bestimmt Collider-Export.
6. **Schilder-Region?** → Default: StVO (Deutschland), umschaltbar.
7. **Texturen**: eigene Texturen vorhanden oder rein prozedural starten? → Default: rein prozedural.
8. **Spielwelt-Maßstab**: 1 Einheit = 1 Meter? → Default: ja.
