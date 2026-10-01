// Material registry. Profiles only ever reference material NAMES; what a name
// renders as is decided here, so procedural looks can later be replaced by real
// textures per name without touching profiles or saved data.
//
// Default look: MeshLambertMaterial (same as the game's terrain) + a small
// procedural noise texture sampled in METRES (uv.x = lateral metres, uv.y =
// arc length), so a tile is `tileM` metres wide on every road regardless of
// width. Full procedural shaders (wear, markings) follow in Phase 5.

import * as THREE from 'three';

export interface MaterialDef {
  color: number;
  /** edge length of one noise tile, metres */
  tileM: number;
  /** 0..1 strength of the procedural noise */
  noise: number;
  /** optional real texture replacing the procedural one (same metre-based UVs) */
  map?: THREE.Texture;
}

export const DEFAULT_MATERIAL_DEFS: Record<string, MaterialDef> = {
  asphalt:      { color: 0x5b5d62, tileM: 2.5, noise: 0.35 },
  asphalt_worn: { color: 0x72746a, tileM: 2.5, noise: 0.45 },
  gravel:       { color: 0x9a9588, tileM: 1.5, noise: 0.7 },
  dirt:         { color: 0x7a6248, tileM: 2.0, noise: 0.55 },
  path_dirt:    { color: 0x8a7253, tileM: 1.5, noise: 0.6 },
  grass:        { color: 0x5f7f3c, tileM: 3.0, noise: 0.5 },
  curb:         { color: 0xa9a9a4, tileM: 1.0, noise: 0.25 },
  subgrade:     { color: 0x6b5a46, tileM: 2.0, noise: 0.5 },
};

const FALLBACK: MaterialDef = { color: 0xff00ff, tileM: 1, noise: 0 };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable 2-octave value-noise grey texture. */
export function makeNoiseTexture(seed: number, strength: number, size = 128): THREE.DataTexture {
  const rnd = mulberry32(seed);
  const grid = (n: number): Float32Array => Float32Array.from({ length: n * n }, () => rnd());
  const g1 = grid(8);
  const g2 = grid(32);
  const sample = (g: Float32Array, n: number, u: number, v: number): number => {
    const x = u * n, y = v * n;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (i: number, j: number): number => g[((j % n) * n) + (i % n)];
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const n = 0.65 * sample(g1, 8, i / size, j / size) + 0.35 * sample(g2, 32, i / size, j / size);
      const v = Math.round(255 * (1 - strength * (1 - n) * 0.8));
      const k = (j * size + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = v;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface MaterialHooks {
  /** e.g. wire cloud shadows / atmosphere into the material like the terrain does */
  onCreate?(material: THREE.MeshLambertMaterial, name: string): void;
}

export class MaterialRegistry {
  private defs = new Map<string, MaterialDef>();
  private materials = new Map<string, THREE.MeshLambertMaterial>();
  private warned = new Set<string>();

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

  /** Define or replace a material (e.g. swap in a real texture later). */
  define(name: string, def: MaterialDef): void {
    this.defs.set(name, def);
    const old = this.materials.get(name);
    if (old) {
      // replace in place so existing meshes pick up the new look
      this.apply(old, name, def);
    }
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
    this.apply(m, name, def);
    this.materials.set(name, m);
    this.hooks.onCreate?.(m, name);
    return m;
  }

  private apply(m: THREE.MeshLambertMaterial, name: string, def: MaterialDef): void {
    m.color.setHex(def.color);
    let map = def.map ?? null;
    if (!map && def.noise > 0) {
      let seed = 0;
      for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) >>> 0;
      map = makeNoiseTexture(seed, def.noise);
    }
    if (map) map.repeat.set(1 / def.tileM, 1 / def.tileM);
    m.map = map;
    m.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.materials.values()) { m.map?.dispose(); m.dispose(); }
    this.materials.clear();
  }
}
