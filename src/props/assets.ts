// Prop assets: name → geometry parts (each with a material NAME, see materials.ts). Everything here is
// procedural and low-poly; replace any asset with a model via `register(name, { build })` — e.g. with
// `partsFromObject(gltf.scene, materials)`.
//
// Axes: +y up, +z = the FRONT of the prop (it faces the road for `face: 'road'`), origin at the base.

import * as THREE from 'three';
import { parseSignAsset, plateOutline, type ParsedSign } from './signs';
import type { PropMaterials } from './materials';

export interface AssetPart {
  geometry: THREE.BufferGeometry;
  material: string;
}

export interface PropAssetDef {
  build(): AssetPart[];
}

const T = (g: THREE.BufferGeometry, x = 0, y = 0, z = 0): THREE.BufferGeometry => g.translate(x, y, z);
const box = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry => T(new THREE.BoxGeometry(w, h, d), x, y, z);
const cyl = (rTop: number, rBot: number, h: number, y: number, seg = 8): THREE.BufferGeometry => T(new THREE.CylinderGeometry(rTop, rBot, h, seg), 0, y + h / 2, 0);

function lampHead(len: number, y: number): AssetPart[] {
  return [
    { geometry: box(0.09, 0.09, len, 0, y, len / 2), material: 'steel_dark' },
    { geometry: box(0.34, 0.12, 0.7, 0, y - 0.04, len), material: 'steel_dark' },
    { geometry: box(0.3, 0.02, 0.62, 0, y - 0.11, len), material: 'lamp_glow' },
  ];
}

function tree(trunkH: number, crown: THREE.BufferGeometry, crownY: number, light: boolean): AssetPart[] {
  const c = crown;
  c.translate(0, crownY, 0);
  return [
    { geometry: cyl(0.12, 0.2, trunkH, 0, 6), material: 'bark' },
    { geometry: c, material: light ? 'foliage_light' : 'foliage' },
  ];
}

/** Lamp positions (asset-local, the housing's front faces +z) of the traffic-light assets — the signal layer
 *  draws the lit discs itself so it can switch their colour at run time. */
export const SIGNAL_LAMPS = {
  signal_car: [{ id: 'r', y: 3.6 }, { id: 'y', y: 3.3 }, { id: 'g', y: 3.0 }].map((l) => ({ ...l, x: 0, z: 0.235, r: 0.1 })),
  signal_ped: [{ id: 'r', y: 2.48 }, { id: 'g', y: 2.14 }].map((l) => ({ ...l, x: 0, z: 0.225, r: 0.09 })),
} as const;

export const BUILTIN_ASSETS: Record<string, PropAssetDef> = {
  signal_car: {
    build: () => [
      { geometry: cyl(0.06, 0.07, 3.9, 0, 8), material: 'steel_dark' },
      { geometry: box(0.34, 1.16, 0.25, 0, 3.3, 0.1), material: 'plastic_black' },
      ...SIGNAL_LAMPS.signal_car.map((l) => ({ geometry: box(0.3, 0.02, 0.1, 0, l.y + l.r + 0.02, 0.28), material: 'plastic_black' })), // hoods
    ],
  },
  signal_ped: {
    build: () => [
      { geometry: cyl(0.05, 0.06, 2.7, 0, 8), material: 'steel_dark' },
      { geometry: box(0.3, 0.7, 0.22, 0, 2.3, 0.1), material: 'plastic_black' },
    ],
  },
  post_steel: { build: () => [{ geometry: box(0.1, 1.3, 0.06, 0, 0.2, 0), material: 'steel_dark' }] },
  post_wood: { build: () => [{ geometry: box(0.14, 1.5, 0.14, 0, 0.3, 0), material: 'wood' }] },
  post_cable: { build: () => [{ geometry: box(0.06, 1.2, 0.06, 0, 0.25, 0), material: 'steel_dark' }] },
  lamp: {
    build: () => [{ geometry: cyl(0.06, 0.11, 8.0, 0, 8), material: 'steel_dark' }, ...lampHead(1.9, 8.0)],
  },
  lamp_small: {
    build: () => [
      { geometry: cyl(0.05, 0.08, 4.4, 0, 8), material: 'steel_dark' },
      { geometry: box(0.07, 0.07, 0.9, 0, 4.4, 0.45), material: 'steel_dark' },
      { geometry: box(0.3, 0.1, 0.5, 0, 4.36, 0.9), material: 'steel_dark' },
      { geometry: box(0.26, 0.02, 0.44, 0, 4.3, 0.9), material: 'lamp_glow' },
    ],
  },
  delineator: {
    build: () => [
      { geometry: box(0.11, 1.05, 0.07, 0, 0.2, 0), material: 'plastic_white' },
      { geometry: box(0.112, 0.16, 0.072, 0, 0.62, 0), material: 'plastic_black' },
      { geometry: box(0.05, 0.05, 0.075, 0, 0.62, 0), material: 'reflector' },
    ],
  },
  bollard: {
    build: () => [
      { geometry: cyl(0.07, 0.07, 0.85, 0, 8), material: 'plastic_white' },
      { geometry: cyl(0.072, 0.072, 0.1, 0.6, 8), material: 'reflector' },
    ],
  },
  km_stone: {
    build: () => [
      { geometry: box(0.26, 0.8, 0.12, 0, 0.25, 0), material: 'stone' },
      { geometry: box(0.262, 0.14, 0.122, 0, 0.58, 0), material: 'reflector' },
    ],
  },
  bench: {
    build: () => [
      { geometry: box(1.6, 0.05, 0.45, 0, 0.45, 0), material: 'wood' },
      { geometry: box(1.6, 0.38, 0.04, 0, 0.78, -0.2), material: 'wood' },
      { geometry: box(0.06, 0.45, 0.4, -0.7, 0.22, 0), material: 'steel_dark' },
      { geometry: box(0.06, 0.45, 0.4, 0.7, 0.22, 0), material: 'steel_dark' },
    ],
  },
  tree_poplar: {
    build: () => tree(2.4, new THREE.IcosahedronGeometry(1, 1).scale(1.3, 5.2, 1.3), 7.2, false),
  },
  tree_linden: {
    build: () => tree(3.2, new THREE.IcosahedronGeometry(1, 1).scale(3.0, 2.6, 3.0), 6.0, true),
  },
};

/** Sign: pole + plate (textured front, plain back). */
function signParts(sign: ParsedSign, name: string): AssetPart[] {
  const { def } = sign;
  const outline = plateOutline(def.shape);
  const front = (zz: number, flip: boolean): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const p: number[] = [], u: number[] = [], n: number[] = [], ix: number[] = [];
    outline.forEach(([x, y]) => { p.push(x * def.width, y * def.height, zz); u.push(x + 0.5, y + 0.5); n.push(0, 0, flip ? -1 : 1); });
    for (let i = 1; i < outline.length - 1; i++) { if (flip) ix.push(0, i + 1, i); else ix.push(0, i, i + 1); }
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
    g.setIndex(ix);
    return g;
  };
  const lowEdge = 1.7;
  const cy = lowEdge + def.height / 2;
  const poleTop = cy + def.height / 2 + 0.05;
  return [
    { geometry: cyl(0.035, 0.035, poleTop + 0.3, -0.3, 8), material: 'steel' },
    { geometry: front(0.05, false).translate(0, cy, 0), material: name },
    { geometry: front(0.045, true).translate(0, cy, 0), material: 'sign_back' },
  ];
}

export class PropAssets {
  private readonly defs = new Map<string, PropAssetDef>(Object.entries(BUILTIN_ASSETS));
  private readonly cache = new Map<string, AssetPart[]>();

  /** Registers or replaces an asset. */
  register(name: string, def: PropAssetDef): void {
    this.invalidate(name);
    this.defs.set(name, def);
  }

  has(name: string): boolean {
    return this.defs.has(name) || parseSignAsset(name) !== null;
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  invalidate(name: string): void {
    for (const p of this.cache.get(name) ?? []) p.geometry.dispose();
    this.cache.delete(name);
  }

  /** Geometry parts of an asset (cached; an unknown name yields a visible magenta marker, never an exception). */
  parts(name: string): AssetPart[] {
    let parts = this.cache.get(name);
    if (parts) return parts;
    const def = this.defs.get(name);
    const sign = parseSignAsset(name);
    try {
      parts = def ? def.build() : sign ? signParts(sign, name) : [{ geometry: box(0.4, 1.2, 0.4, 0, 0.6, 0), material: 'marker' }];
    } catch {
      parts = [{ geometry: box(0.4, 1.2, 0.4, 0, 0.6, 0), material: 'marker' }];
    }
    this.cache.set(name, parts);
    return parts;
  }

  dispose(): void {
    for (const name of [...this.cache.keys()]) this.invalidate(name);
  }
}

/** Turns a loaded model into asset parts: every mesh becomes a part, its material is registered under a generated name. */
export function partsFromObject(root: THREE.Object3D, materials: PropMaterials, prefix = 'model'): AssetPart[] {
  const parts: AssetPart[] = [];
  root.updateWorldMatrix(true, true);
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const name = `${prefix}:${n++}`;
    materials.set(name, mat);
    parts.push({ geometry: g, material: name });
  });
  return parts;
}
