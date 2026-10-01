// Boulders: low-poly angular rocks (a few seeded variants, flat shaded), placed along rivers and lakes. Rocks that stand in the
// water become OBSTACLES for the shader: foam rings around them and wakes behind them.

import * as THREE from 'three';
import { hash01 } from '../props/rules';

export interface RockPlacement {
  x: number;
  y: number;
  z: number;
  /** half extents (the unit rock has radius 0.5) */
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  variant: number;
  /** 0..2 picks a shade of the style's rock colour */
  shade: number;
}

/** something standing in the water, in the river's own coordinates */
export interface Obstacle {
  /** metres across from the centre line */
  lat: number;
  /** arc length along the river */
  v: number;
  /** radius at the waterline */
  r: number;
  /** 0..1 how much foam */
  strength: number;
}

export const ROCK_VARIANTS = 6;
const cache = new Map<number, THREE.BufferGeometry>();

export function rockGeometry(variant: number): THREE.BufferGeometry {
  const v = ((variant % ROCK_VARIANTS) + ROCK_VARIANTS) % ROCK_VARIANTS;
  let g = cache.get(v);
  if (g) return g;
  const ico = new THREE.IcosahedronGeometry(0.5, 1);
  const pos = ico.getAttribute('position');
  // the same radial noise for coincident vertices (so the rock stays closed), keyed by the rounded position
  const noise = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let k = noise.get(key);
    if (k === undefined) { k = 0.72 + 0.5 * hash01(v + 1, Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000)); noise.set(key, k); }
    pos.setXYZ(i, x * k, y * k * 0.85, z * k);
  }
  ico.computeVertexNormals();
  g = ico.index ? ico.toNonIndexed() : ico;
  g.computeVertexNormals(); // flat: every face its own normal
  cache.set(v, g);
  return g;
}

export function rockMatrix(p: RockPlacement, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.compose(
    new THREE.Vector3(p.x, p.y, p.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw),
    new THREE.Vector3(p.sx * 2, p.sy * 2, p.sz * 2),
  );
}

/** a size from the style's range, biased to small rocks */
export function rockSize(min: number, max: number, r: number): number {
  return min + (max - min) * r * r;
}

export function disposeRockCache(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
