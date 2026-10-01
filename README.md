# RoadSystem

Prozedurales Straßen- und Wegesystem für three.js + Vite (Wingsuit-Spiel, Schweiz).
Eigenständiges Modul – ändert keine Spieldateien. Plan und Architektur: [`docs/PLAN.md`](docs/PLAN.md).

## Stand

Phase 0–3 fertig (Setup, Core, Profile + Extrusion, Persistenz + Editor):

- `src/core` – Weltkonvention (`simToThree`), zentripetaler Catmull-Rom (`PathCurve`), Frames/Banking,
  krümmungsadaptives Sampling, Höhen-Alignment (`drape` mit FIR-Glättung, naht-konsistent)
- `src/network/types.ts` – Datenmodell (`RoadDef`/`RoadPoint`), Schwester von `RiverDef`/`RiverPoint`
- `src/runtime` – `RoadSystem.resync()`: baut Chunks erst, wenn das Terrain darunter *settled* ist (wie `riverField`)
- `src/terrain/mockStreamTerrain.ts` – Mock von `StreamTerrain` (Kachel-Streaming, `null`, grobe Fallback-Höhe, `isSettledAt`)
- `src/profile` – Profil-DSL (`R.profile(...).both(h => h.surface(...))`), Compiler für Profil-*Code*,
  `ProfileLibrary` (Hot-Reload mit Fehler-Isolation), Presets Flurstraße / Hauptstraße / Wanderweg
- `src/mesh` – `buildChunkGeometry` (Extrusion mit Körper, analytische Normalen, UVs in Metern), `RoadMeshLayer`
- `src/surface/materials.ts` – `MaterialRegistry` (Material-*Namen* → prozedurale Lambert-Materialien, später durch Texturen ersetzbar)
- `src/store` – `RoadStore`-Vertrag + `MemoryStore` / `StorageStore` / `HttpRoadStore` (Revisionen, Konflikte)
- `src/editor` (Einstieg `roadsystem/editor`) – `RoadModel` (Undo/Redo), `RoadEditor` (Auswählen, Punkte ziehen/einfügen, Zeichnen,
  Speichern), Panels (Inspector, Parameter-UI, Profil-Code mit CodeMirror + 2-D-Vorschau)
- `docs/backend` – PHP+MySQL-Referenz-Backend (getestet gegen den echten Client)
- `src/debug` – Debug-Layer: rot = wartet aufs Terrain, grün = settled, blau = Brücke

## Befehle

```bash
npm install
npm run dev        # Demo + Editor (Wählen/Zeichnen, Profil-Code live, Speichern im Browser)
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
| Undo / Redo / Speichern | `Strg+Z` / `Strg+Y` / `Strg+S` |
| Profil bearbeiten | Tab „Profil (Code)“ – wirkt sofort an allen Straßen mit diesem Profil |
