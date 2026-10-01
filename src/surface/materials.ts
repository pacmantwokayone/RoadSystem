// Material registry. Profiles only ever reference material NAMES; what a name renders as is decided
// here, so procedural looks can be replaced by real textures per name without touching profiles or saved data.
//
// Look: MeshLambertMaterial (same as the game's terrain) + a procedural surface shader (surfaceShader.ts)
// working in METRES: uv.x = distance across the cross-section, uv.y = arc length. Global weather (wet / snow /
// age) is shared by every road material.

import * as THREE from 'three';
import type { MaterialLibrary } from './materialLibrary';
import { injectSurface, makeSurfaceUniforms, syncSurface, type SurfaceKind, type SurfaceUniforms, type SurfaceWeather } from './surfaceShader';

export interface MaterialDef {
  kind: SurfaceKind;
  color: number;
  /** second tone (stones, mottling, the asphalt under paint) — defaults to `color` */
  color2?: number;
  /** pattern scale, metres (cell size for cobbles/planks, noise wavelength otherwise) */
  tileM: number;
  /** 0..1 strength of the base mottling */
  noise: number;
  /** wheel-track wear 0..1 (needs strips wider than a lane) */
  tracks?: number;
  /** distance of the wheel tracks from the strip centre, metres (default 0.85) */
  trackOffset?: number;
  cracks?: number;
  patches?: number;
  /** dirt creeping in from the strip's edges */
  edgeDirt?: number;
  /** how easily road paint wears away (paint only) */
  wornPaint?: number;
  /** optional real texture replacing the procedural base colour (same metre-based UVs) */
  map?: THREE.Texture;
}

export const DEFAULT_MATERIAL_DEFS: Record<string, MaterialDef> = {
  asphalt:        { kind: 'asphalt', color: 0x4d4f54, tileM: 2.5, noise: 0.5, tracks: 0.8, cracks: 0.5, patches: 0.5, edgeDirt: 0.4 },
  asphalt_worn:   { kind: 'asphalt', color: 0x62645f, tileM: 2.5, noise: 0.6, tracks: 0.4, cracks: 0.8, patches: 0.7, edgeDirt: 0.8 },
  asphalt_dark:   { kind: 'asphalt', color: 0x35373b, tileM: 2.0, noise: 0.45, tracks: 0.3, cracks: 0.2, patches: 0.2, edgeDirt: 0.2 },
  concrete:       { kind: 'concrete', color: 0x9b9a95, tileM: 3.0, noise: 0.5, tracks: 0.4, edgeDirt: 0.3 },
  cobble:         { kind: 'cobble', color: 0x7c7a76, color2: 0xa09d96, tileM: 0.16, noise: 0.5, edgeDirt: 0.5 },
  granite:        { kind: 'stone', color: 0xa8a7a2, color2: 0x7d7c78, tileM: 1.0, noise: 0.6 },
  curb:           { kind: 'stone', color: 0xaaa9a4, color2: 0x84837e, tileM: 1.0, noise: 0.5 },
  sidewalk:       { kind: 'concrete', color: 0xaaa8a2, tileM: 1.5, noise: 0.45, edgeDirt: 0.5 },
  gravel:         { kind: 'gravel', color: 0x9a9588, color2: 0xc4bfae, tileM: 1.5, noise: 0.8, tracks: 0.6, edgeDirt: 0.5 },
  gravel_fine:    { kind: 'gravel', color: 0xa39d8c, color2: 0xcfc9b6, tileM: 1.0, noise: 0.5, tracks: 0.3, edgeDirt: 0.6 },
  dirt:           { kind: 'dirt', color: 0x7a6248, color2: 0x5d4a35, tileM: 2.0, noise: 0.7, tracks: 0.9, edgeDirt: 0.2 },
  path_dirt:      { kind: 'dirt', color: 0x8a7253, color2: 0x6d5841, tileM: 1.5, noise: 0.7, tracks: 0.2, edgeDirt: 0.1 },
  forest:         { kind: 'dirt', color: 0x5d4f38, color2: 0x3e5a2c, tileM: 1.2, noise: 0.9, tracks: 0.1 },
  grass:          { kind: 'grass', color: 0x5f7f3c, color2: 0x7c9a4d, tileM: 3.0, noise: 0.6 },
  wood:           { kind: 'wood', color: 0x8b6a45, color2: 0x6a4f33, tileM: 0.14, noise: 0.5 },
  rock:           { kind: 'stone', color: 0x7b7a76, color2: 0x5c5b57, tileM: 1.5, noise: 0.9 },
  subgrade:       { kind: 'dirt', color: 0x6b5a46, color2: 0x4d3f30, tileM: 2.0, noise: 0.6 },
  marking_white:  { kind: 'paint', color: 0xeeeeea, color2: 0x4d4f54, tileM: 1.0, noise: 0, wornPaint: 0.8 },
  marking_yellow: { kind: 'paint', color: 0xe8c424, color2: 0x4d4f54, tileM: 1.0, noise: 0, wornPaint: 0.8 },
};

const FALLBACK: MaterialDef = { kind: 'flat', color: 0xff00ff, tileM: 1, noise: 0 };

export interface MaterialHooks {
  /** e.g. wire cloud shadows / atmosphere into the material like the terrain does */
  onCreate?(material: THREE.MeshLambertMaterial, name: string): void;
}

export class MaterialRegistry {
  private defs = new Map<string, MaterialDef>();
  private materials = new Map<string, THREE.MeshLambertMaterial>();
  private warned = new Set<string>();
  /** wet / snow / age — shared by every road material; change via setWeather() */
  readonly surface: SurfaceUniforms = makeSurfaceUniforms();

  constructor(private readonly hooks: MaterialHooks = {}, defs: Record<string, MaterialDef> = DEFAULT_MATERIAL_DEFS) {
    for (const [name, def] of Object.entries(defs)) this.defs.set(name, def);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  getDef(name: string): MaterialDef {
    return this.defs.get(name) ?? FALLBACK;
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  /** Keep this registry in sync with a (code-based, editable) material library. Returns an unsubscribe function. */
  bind(lib: MaterialLibrary): () => void {
    for (const [name, def] of Object.entries(lib.allDefs())) this.define(name, def);
    return lib.onChange((name, def) => { if (def) this.define(name, def); });
  }

  setWeather(w: Partial<SurfaceWeather>): void {
    if (w.wet !== undefined) this.surface.uWet.value = Math.min(1, Math.max(0, w.wet));
    if (w.snow !== undefined) this.surface.uSnow.value = Math.min(1, Math.max(0, w.snow));
    if (w.age !== undefined) this.surface.uAge.value = Math.min(1, Math.max(0, w.age));
  }

  get weather(): SurfaceWeather {
    return { wet: this.surface.uWet.value, snow: this.surface.uSnow.value, age: this.surface.uAge.value };
  }

  /** Define or replace a material; existing meshes pick up the new look (e.g. swap in a real texture). */
  define(name: string, def: MaterialDef): void {
    const old = this.defs.get(name);
    this.defs.set(name, def);
    const mat = this.materials.get(name);
    if (!mat) return;
    this.apply(mat, def);
    if (!old || old.kind !== def.kind || !!old.map !== !!def.map) mat.needsUpdate = true; // different shader → recompile
  }

  get(name: string): THREE.MeshLambertMaterial {
    let m = this.materials.get(name);
    if (m) return m;
    let def = this.defs.get(name);
    if (!def) {
      if (!this.warned.has(name)) { this.warned.add(name); console.warn(`[roadsystem] unknown material '${name}'`); }
      def = FALLBACK;
    }
    m = new THREE.MeshLambertMaterial();
    const key = name;
    injectSurface(m, () => this.defs.get(key) ?? FALLBACK, this.surface);
    this.apply(m, def);
    this.materials.set(name, m);
    this.hooks.onCreate?.(m, name);
    return m;
  }

  private apply(m: THREE.MeshLambertMaterial, def: MaterialDef): void {
    m.color.setHex(def.map ? 0xffffff : def.color);
    m.map = def.map ?? null;
    if (def.map) {
      def.map.wrapS = def.map.wrapT = THREE.RepeatWrapping;
      def.map.repeat.set(1 / def.tileM, 1 / def.tileM);
    }
    syncSurface(m, def);
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
  }
}
