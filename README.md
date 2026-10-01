# RoadSystem

Prozedurales Straßen- und Wegesystem für three.js + Vite (Wingsuit-Spiel, Schweiz).
Eigenständiges Modul – ändert keine Spieldateien. Plan und Architektur: [`docs/PLAN.md`](docs/PLAN.md).

## Stand

Phase 0–2 fertig (Setup, Core, Profile + Extrusion):

- `src/core` – Weltkonvention (`simToThree`), zentripetaler Catmull-Rom (`PathCurve`), Frames/Banking,
  krümmungsadaptives Sampling, Höhen-Alignment (`drape` mit FIR-Glättung, naht-konsistent)
- `src/network/types.ts` – Datenmodell (`RoadDef`/`RoadPoint`), Schwester von `RiverDef`/`RiverPoint`
- `src/runtime` – `RoadSystem.resync()`: baut Chunks erst, wenn das Terrain darunter *settled* ist (wie `riverField`)
- `src/terrain/mockStreamTerrain.ts` – Mock von `StreamTerrain` (Kachel-Streaming, `null`, grobe Fallback-Höhe, `isSettledAt`)
- `src/profile` – Profil-DSL (`R.profile(...).both(h => h.surface(...))`), Compiler für Profil-*Code*,
  `ProfileLibrary` (Hot-Reload mit Fehler-Isolation), Presets Flurstraße / Hauptstraße / Wanderweg
- `src/mesh` – `buildChunkGeometry` (Extrusion mit Körper, analytische Normalen, UVs in Metern), `RoadMeshLayer`
- `src/surface/materials.ts` – `MaterialRegistry` (Material-*Namen* → prozedurale Lambert-Materialien, später durch Texturen ersetzbar)
- `src/debug` – Debug-Layer: rot = wartet aufs Terrain, grün = settled, blau = Brücke

## Befehle

```bash
npm install
npm run dev        # Demo: Mock-Terrain, Straßen zeichnen per Klick (Taste D)
npm test           # Vitest
npm run typecheck
```
