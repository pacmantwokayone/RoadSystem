// Geometry of a waterfall: the falling sheet (a ribbon along the ballistic curve, DoubleSide) and the plunge pool at its foot.

import * as THREE from 'three';
import { flipZ } from '../core/world';
import type { FallInfo } from './hydro';
import type { RiverRuntime, WaterChunk, WaterTerrain } from './system';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function buildFallSheet(rt: RiverRuntime, chunk: WaterChunk): THREE.BufferGeometry {
  const S = rt.hydro.samples;
  const n = chunk.i1 - chunk.i0 + 1;
  const cols = 14;
  const pos = new Float32Array(n * cols * 3);
  const aLat = new Float32Array(n * cols), aV = new Float32Array(n * cols), aDepth = new Float32Array(n * cols).fill(1);
  const aTurb = new Float32Array(n * cols), aSpeed = new Float32Array(n * cols), aHalf = new Float32Array(n * cols);
  const aDir = new Float32Array(n * cols * 2);
  for (let r = 0; r < n; r++) {
    const s = S[chunk.i0 + r];
    const half = s.width / 2;
    for (let j = 0; j < cols; j++) {
      const lat = -half + (2 * half * j) / (cols - 1);
      const i = r * cols + j;
      // the sheet bulges a little in the middle (the centre falls faster and juts out)
      const bulge = 0.04 * s.width * (1 - (lat / half) ** 2) * s.fallU;
      pos[i * 3] = s.pos.x + s.right.x * lat + s.right.z * bulge;
      pos[i * 3 + 1] = s.pos.y;
      pos[i * 3 + 2] = s.pos.z + s.right.z * lat - s.right.x * bulge;
      aLat[i] = lat; aV[i] = s.s; aTurb[i] = s.fallU; aSpeed[i] = s.speed; aHalf[i] = half;
      aDir[i * 2] = s.right.z; aDir[i * 2 + 1] = -s.right.x; // horizontal flow direction
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < n - 1; r++) for (let j = 0; j < cols - 1; j++) { const a = r * cols + j, b = a + 1, c = a + cols, d = c + 1; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aLat', new THREE.BufferAttribute(aLat, 1));
  g.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  g.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
  g.setAttribute('aTurb', new THREE.BufferAttribute(aTurb, 1));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
  g.setAttribute('aHalf', new THREE.BufferAttribute(aHalf, 1));
  g.setAttribute('aDir', new THREE.BufferAttribute(aDir, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** radius of the plunge pool of a fall, metres */
export function poolRadius(rt: RiverRuntime, f: FallInfo): number {
  return Math.max(5, f.width * rt.style.fall.poolRadius);
}

/** The pool at the foot: a disc of water (drawn with the river shader, churned in the middle where the sheet lands). */
export function buildPoolDisc(rt: RiverRuntime, f: FallInfo, terrain: WaterTerrain): THREE.BufferGeometry {
  const R = poolRadius(rt, f) * 1.18;
  const rings = 12, spokes = 40;
  const level = f.foot.y;
  const cx = f.foot.x, cz = f.foot.z;
  const count = 1 + rings * spokes;
  const pos = new Float32Array(count * 3);
  const aLat = new Float32Array(count), aV = new Float32Array(count), aDepth = new Float32Array(count);
  const aTurb = new Float32Array(count), aSpeed = new Float32Array(count).fill(0.9), aHalf = new Float32Array(count).fill(R);
  const aDir = new Float32Array(count * 2);
  const put = (i: number, x: number, z: number, r: number): void => {
    pos[i * 3] = x; pos[i * 3 + 1] = level; pos[i * 3 + 2] = z;
    const g = terrain.heightAt(x, flipZ(z));
    aDepth[i] = clamp(g === null ? rt.style.fall.poolDepth * (1 - (r / R) ** 2) : level - g, -0.5, 60);
    aLat[i] = x - cx; aV[i] = z - cz + 5000; // isotropic pattern around the pool
    aTurb[i] = clamp(0.95 - 0.7 * (r / R), 0.15, 1);
    aDir[i * 2] = 1;
  };
  put(0, cx, cz, 0);
  for (let k = 1; k <= rings; k++) {
    const r = (R * k) / rings;
    for (let j = 0; j < spokes; j++) {
      const a = (j / spokes) * Math.PI * 2;
      put(1 + (k - 1) * spokes + j, cx + Math.cos(a) * r, cz + Math.sin(a) * r, r);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < spokes; j++) {
    const j2 = (j + 1) % spokes;
    idx.push(0, 1 + j2, 1 + j); // up-facing: x→z mirrored in THREE, checked against the ribbon winding below
  }
  for (let k = 1; k < rings; k++) {
    for (let j = 0; j < spokes; j++) {
      const j2 = (j + 1) % spokes;
      const a = 1 + (k - 1) * spokes + j, b = 1 + (k - 1) * spokes + j2, c = 1 + k * spokes + j, d = 1 + k * spokes + j2;
      idx.push(a, b, c, b, d, c);
    }
  }
  // make every triangle face up whatever the orientation of the polar grid
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ux = pos[b * 3] - pos[a * 3], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    if (uz * vx - ux * vz < 0) { idx[t + 1] = c; idx[t + 2] = b; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aLat', new THREE.BufferAttribute(aLat, 1));
  g.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  g.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
  g.setAttribute('aTurb', new THREE.BufferAttribute(aTurb, 1));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
  g.setAttribute('aHalf', new THREE.BufferAttribute(aHalf, 1));
  g.setAttribute('aDir', new THREE.BufferAttribute(aDir, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
