# RoadSystem

Prozedurales Straßen- und Wegesystem für three.js + Vite (Wingsuit-Spiel, Schweiz).
Eigenständiges Modul – ändert keine Spieldateien. Plan und Architektur: [`docs/PLAN.md`](docs/PLAN.md).

## Stand

Phase 0–8 fertig plus Tunnel/Kreisel (Grundlagen) (Setup, Core, Profile + Extrusion, Persistenz + Editor, Netzwerk + Kreuzungen, Oberflächen + Markierungen, Props, Ampeln + Kreuzungsdetails, Brücken) und **Wasser** (handgezeichnete Flüsse, Seen, Wasserfälle):

- `src/core` – Weltkonvention (`simToThree`), zentripetaler Catmull-Rom (`PathCurve`), Frames/Banking,
  krümmungsadaptives Sampling, Höhen-Alignment (`drape` mit FIR-Glättung, naht-konsistent)
- `src/network/types.ts` – Datenmodell (`RoadDef`/`RoadPoint`), Schwester von `RiverDef`/`RiverPoint`
- `src/runtime` – `RoadSystem.resync()`: baut Chunks erst, wenn das Terrain darunter *settled* ist (wie `riverField`)
- `src/terrain/mockStreamTerrain.ts` – Mock von `StreamTerrain` (Kachel-Streaming, `null`, grobe Fallback-Höhe, `isSettledAt`)
- `src/profile` – Profil-DSL (`R.profile(...).both(h => h.surface(...))`), Compiler für Profil-*Code*,
  `ProfileLibrary` (Hot-Reload mit Fehler-Isolation), 19 Presets (Wanderweg → Autobahn), Markierungen
- `src/mesh` – `buildChunkGeometry` (Extrusion mit Körper, analytische Normalen, UVs in Metern), `RoadMeshLayer`
- `src/surface` – `MaterialRegistry` (Material-*Namen* → prozedurale Shader-Materialien mit Verschleiß + Wetter, später durch Texturen ersetzbar),
  `MaterialLibrary` (Materialien als Code, Hot-Reload; Material-Tab im Editor)
- `src/props` – Prop-Regeln im Profil (`scatter`, `lamps`, `guardrail`, `rank`), Platzierung pro Chunk, Leitplanken (Auto-Regel, 4 Varianten),
  Asset-/Material-Registry (ersetzbar), SSV-Schilder (Canvas), Vortrittsschilder aus der Kreuzungstopologie, `PropLayer`
- `src/structures` – Brücken als Code (`B.bridge(…).deck().piers().arch().truss()…`, 6 Typen), `BridgeLibrary`, Geometrie aus Lofts (Pfeiler, Widerlager,
  Träger, Bogen, Fachwerk, Geländer), `BridgeLayer`, Flusskreuzungs-Vorschlag (`suggestBridges`)
- `src/water` – Flüsse, Seen, Stromschnellen und Wasserfälle von Hand gezeichnet (`RiverDef`/`LakeDef` im Strassendokument), Hydrologie (Pegel nie bergauf, ballistischer Fall),
  Terrain-Carve als reine Funktion (`WaterField`), Shader mit Ufer-/Hindernis-/Stromschnellen-Schaum, Felsen, Partikel (Strömung, Gischt, Nebel), Stile als Code (`WaterLibrary`), `WaterLayer`;
  dazu `editor/waterEditor.ts` (Werkzeuge Fluss/See, Inspector) und die Testseite `artifact/`
- `src/tunnel` – Tunnel: Abschnitte aus Punkten mit Typ `tunnel`, Auskleidung + Lichtbänder, Portale, Geländeeinschnitt (`TunnelField`), `TunnelLayer`/`TunnelSystem`
- `src/rail` – Schienen: Gleisprofile (`gleis`, `gleis_doppel`, `bahnhof`; `.rail().catenary().signals()` im Profil-DSL), Schwellen, Schienen, Fahrleitung (Masten mit Auslegern,
  Tragseil mit Durchhang, Fahrdraht mit Zickzack, Hänger), Lichtsignale, Perrondächer; `RailLayer`. Gleisbett = normale Strassenoberfläche, daher gehen Brücken (`eisenbahnbruecke`, Bogenviadukt),
  Tunnel und Geländeanpassung ohne Sonderfall
- `src/network/branch.ts` + `interchange.ts` – Abzweige (Fahrstreifen-/Gleis-Weiche wächst aus dem Rand der Hauptstrasse) und ein Autobahnkreuz (Hochstrasse auf Stelzen, vier Flyover-Rampen); Brückenpfeiler weichen Strassen darunter aus
- `src/network/roundabout.ts` – Kreisel als Ring aus Strassen + Knoten (`buildRoundabout`), `findRoundabouts`; Mittelinsel im `IslandLayer`
- `src/junction` – Knoten-Steuerung (Vortritt, Haltelinien, Fussgängerstreifen) und Ampel-Phasenplan/-Controller (reine Funktionen der Zeit);
  dazu `props/signalLayer.ts` (Ampeln, Lampen per Vertexfarbe), `mesh/junctionMarkings.ts`, `network/pavement.ts` + `mesh/junctionPavement.ts` (Trottoir-Ecken)
- `src/network` – `junction.ts` (Kreuzungsgeometrie: Setbacks, Ecken-Rundung, Randpolygon, Rückfälle), `graph.ts` (Netz normalisieren),
  `RoadSystem.setNetwork` (Diff-Aufbau), `JunctionRuntime` + `junctionMesh` (Patch aus den echten Armenden)
- `src/store` – `RoadStore`-Vertrag + `MemoryStore` / `StorageStore` / `HttpRoadStore` (Revisionen, Konflikte)
- `src/editor` (Einstieg `roadsystem/editor`) – `RoadModel` (Undo/Redo), `RoadEditor` (Auswählen, Punkte ziehen/einfügen, Zeichnen,
  Speichern), Panels (Inspector, Parameter-UI, Profil-Code mit CodeMirror + 2-D-Vorschau)
- `docs/backend` – PHP+MySQL-Referenz-Backend (getestet gegen den echten Client)
- `src/debug` – Debug-Layer: rot = wartet aufs Terrain, grün = settled, blau = Brücke

## Befehle

```bash
npm install
npm run dev        # Demo + Editor (Wählen/Zeichnen, Profil-/Material-Code live, Speichern im Browser)
                   # Query: ?gallery=1&flat=1 (alle Presets), ?wet=0.8&snow=0.3&age=0.7 (Wetter/Alter)
                   # Props: ?cliff=1 (Leitplanken am Abgrund), ?village=1 (Kreuzung mit Allee/Laternen/Vortritt),
                   #        ?assets=1&flat=1 (alle Props + Schilder), ?props=0 (ausblenden)
                   # Brücken: ?bridges=1 (6 Typen über Schluchten), ?rivers=1 (Fluss + Vorschläge im Tab „Brücke“)
                   # Wasser + Verkehrsfeld: ?water=1 (Bergsee, Wildbach, 400-m-Wasserfall, Talfluss mit Brücke, unterer See, Kreisel, Ampelkreuzung, Autobahnkreuz, Bahnstrecke mit Bahnhof/Viadukt/Tunneln, Tunnel), &particles=0
                   # Ampeln: ?signals=1&flat=1 (Kreuzung mit Ampeln + Trottoir), ?t=12 (Ampelzeit einfrieren), ?sigspeed=5 (schneller)
node artifact/build.mjs   # Testseite: artifact/dist/index.html (eine Datei, three.js eingebettet); --csp: Variante ohne eval zum Testen
npm test           # Vitest
npm run typecheck
```

## Editor – Bedienung

| Aktion | Bedienung |
|---|---|
| Straße wählen | Klick auf die Straße |
| Punkt verschieben | Handle ziehen |
| Punkt einfügen | Umschalt+Klick oder Doppelklick auf die gewählte Straße |
| Punkt löschen | `Entf` |
| Zeichnen | `D`, Klicks setzen Punkte, `Enter` fertig, `⌫` letzter Punkt, `Esc` abbrechen |
| Straße an Straße anschließen | Beim Zeichnen Start/Ende auf eine Straße, ein freies Ende oder einen Knoten setzen (die Straße wird dabei geteilt) |
| Freies Ende verbinden | Endpunkt-Handle auf eine Straße / ein Ende / einen Knoten ziehen |
| Kreuzung wählen / verschieben | Gelben Marker anklicken / ziehen (alle Arme folgen) |
| Kurvenradius, Auflösen | Kreuzung wählen → Inspector (oder `Entf`) |
| Undo / Redo / Speichern | `Strg+Z` / `Strg+Y` / `Strg+S` |
| Fluss / See zeichnen | `R` / `L`, Klicks setzen Punkte, `Enter` schliesst ab (Ende im See → mündet dort; Ende auf einem Fluss → Zufluss) |
| Gewässer wählen / Punkt ziehen / einfügen / löschen | Klick auf das Wasser · Handle ziehen · Doppelklick · `Entf` |
| Stromschnelle / Wasserfall | Tab „Wasser“ → Punkt wählen → „Abschnitt danach“ (ein Wasserfall fällt bis zum nächsten Punkt, beliebig tief) |
| Wasserstil bearbeiten | Tab „Wasser-Stil“ (Code) |
| Profil bearbeiten | Tab „Profil (Code)“ – wirkt sofort an allen Straßen mit diesem Profil |
