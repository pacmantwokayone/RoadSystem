// Geometry of one river chunk: the water ribbon (reaches exactly to the shore, wherever the terrain crosses the water level),
// the bed + bank strip, the boulders, and the obstacles the shader draws foam around. All in THREE space.

import * as THREE from 'three';
import { hash01 } from '../props/rules';
import { flipZ } from '../core/world';
import { poolDims, type RiverSample } from './hydro';
import type { RiverRuntime, WaterChunk, WaterTerrain } from './system';
import { rockSize, type Obstacle, type RockPlacement } from './rocks';

export interface ExternalObstacle {
  /** world position (THREE space) and radius of something that stands in the water (bridge piers …) */
  x: number;
  z: number;
  r: number;
}

export interface RiverChunkGeometry {
  water: THREE.BufferGeometry;
  /** bed + bank strip, textured with the style's bank material (uv in metres, like the road meshes) */
  bank: THREE.BufferGeometry | null;
  rocks: RockPlacement[];
  obstacles: Obstacle[];
  /** surface points for flow particles etc. */
  bounds: THREE.Box3;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const MAX_EXTRA_M = 2.5;
const BED_LIFT_M = 0.05;

/** The highest ground within a mesh cell (±1.6 m) around the point: a strip laid on this never sinks into the terrain mesh,
 *  whose vertices are coarser than the height data. */
export function groundMaxAt(terrain: WaterTerrain, x: number, zThree: number, r = 1.6): number | null {
  let best: number | null = null;
  for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
    const g = groundAt(terrain, x + dx, zThree + dz);
    if (g !== null && (best === null || g > best)) best = g;
  }
  return best;
}

export function groundAt(terrain: WaterTerrain, x: number, zThree: number): number | null {
  return terrain.heightAt(x, flipZ(zThree));
}

/** How far to the left (−1) / right (+1) of the centre line the water reaches at a station: the shore. */
function shoreExtent(terrain: WaterTerrain, s: RiverSample, side: -1 | 1, maxExtra = MAX_EXTRA_M): number {
  let lat = s.width / 2;
  const end = lat + maxExtra;
  for (; lat < end; lat += 0.3) {
    const g = groundAt(terrain, s.pos.x + s.right.x * lat * side, s.pos.z + s.right.z * lat * side);
    // the shore is where the ground comes up to the water (the carve leaves a levee a hair above it; sampling must not step over it)
    if (g === null || g >= s.level - 0.03) break;
  }
  return lat + 0.35; // a little under the bank, so there is never a gap
}

export function buildRiverChunk(rt: RiverRuntime, chunk: WaterChunk, terrain: WaterTerrain, external: readonly ExternalObstacle[] = []): RiverChunkGeometry {
  const S = rt.hydro.samples;
  const style = rt.style;
  const nAll = chunk.i1 - chunk.i0 + 1;
  // the river that leaves a plunge pool starts at the pool's rim: the pool disc covers the rows inside
  let r0 = 0;
  if (chunk.kind === 'river' && S[chunk.i0].kind === 'fall') {
    const f = rt.hydro.falls.find((x) => x.i1 === chunk.i0);
    if (f) {
      const R = poolDims(style, f).radius * 0.9;
      while (r0 < nAll - 2 && Math.hypot(S[chunk.i0 + r0].pos.x - f.foot.x, S[chunk.i0 + r0].pos.z - f.foot.z) < R) r0++;
    }
  }
  const i0 = chunk.i0 + r0;
  const n = nAll - r0;
  let wmax = 0;
  for (let i = i0; i <= chunk.i1; i++) wmax = Math.max(wmax, S[i].width);
  const cols = clamp(Math.round(wmax / 1.1) + 4, 10, 36); // vertices across

  // ---- water surface ---------------------------------------------------------------------------------------
  const pos = new Float32Array(n * cols * 3);
  const aLat = new Float32Array(n * cols), aV = new Float32Array(n * cols), aDepth = new Float32Array(n * cols);
  const aTurb = new Float32Array(n * cols), aSpeed = new Float32Array(n * cols), aHalf = new Float32Array(n * cols);
  const aDir = new Float32Array(n * cols * 2);
  const aRap = new Float32Array(n * cols), aSlope = new Float32Array(n * cols);
  const box = new THREE.Box3();
  for (let r = 0; r < n; r++) {
    const s = S[i0 + r];
    // rapids fade in and out over a few rows
    let rapSum = 0, rapN = 0;
    for (let q = Math.max(i0, i0 + r - 2); q <= Math.min(chunk.i1, i0 + r + 2); q++) { rapSum += S[q].kind === 'rapids' ? 1 : 0; rapN++; }
    const rap = rapSum / rapN;
    // next to a waterfall's lip the water is exactly as wide as the sheet: no wide plank over the gorge
    const nearFall = S[Math.max(i0, i0 + r - 1)].kind === 'fall' || S[Math.min(chunk.i1, i0 + r + 1)].kind === 'fall' || s.kind === 'fall';
    const extra = nearFall ? 0.35 : MAX_EXTRA_M;
    const left = shoreExtent(terrain, s, -1, extra), right = shoreExtent(terrain, s, 1, extra);
    for (let j = 0; j < cols; j++) {
      const t = j / (cols - 1);
      // denser near the shores, where foam and depth change fastest
      const lat = -left + (left + right) * t;
      const i = r * cols + j;
      const x = s.pos.x + s.right.x * lat, z = s.pos.z + s.right.z * lat;
      pos[i * 3] = x; pos[i * 3 + 1] = s.level; pos[i * 3 + 2] = z;
      box.expandByPoint(new THREE.Vector3(x, s.level, z));
      const g = groundAt(terrain, x, z);
      // without terrain data: a parabolic bed
      const q = Math.min(1, Math.abs(lat) / Math.max(0.01, s.width / 2));
      aDepth[i] = clamp(g === null ? s.depth * (1 - q * q) : s.level - g, -0.5, 40);
      aLat[i] = lat; aV[i] = s.s; aTurb[i] = s.turbulence; aSpeed[i] = s.speed; aHalf[i] = s.width / 2;
      aDir[i * 2] = s.tangent.x; aDir[i * 2 + 1] = s.tangent.z;
      aRap[i] = rap; aSlope[i] = s.slope;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = r * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c); // (right × tangent) points up
    }
  }
  const water = new THREE.BufferGeometry();
  water.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  water.setAttribute('aLat', new THREE.BufferAttribute(aLat, 1));
  water.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  water.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
  water.setAttribute('aTurb', new THREE.BufferAttribute(aTurb, 1));
  water.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
  water.setAttribute('aHalf', new THREE.BufferAttribute(aHalf, 1));
  water.setAttribute('aDir', new THREE.BufferAttribute(aDir, 2));
  water.setAttribute('aRap', new THREE.BufferAttribute(aRap, 1));
  water.setAttribute('aSlope', new THREE.BufferAttribute(aSlope, 1));
  water.setIndex(idx);
  water.computeBoundingSphere();

  // ---- bed + bank strip ------------------------------------------------------------------------------------
  let bank: THREE.BufferGeometry | null = null;
  if (style.banks.strip > 0.05) {
    const bcols = clamp(Math.round((wmax + 2 * style.banks.strip) / 0.9) + 2, 8, 48);
    const bpos = new Float32Array(n * bcols * 3), buv = new Float32Array(n * bcols * 2), bnrm = new Float32Array(n * bcols * 3);
    for (let r = 0; r < n; r++) {
      const s = S[i0 + r];
      const half = s.width / 2 + style.banks.strip;
      for (let j = 0; j < bcols; j++) {
        const lat = -half + (2 * half * j) / (bcols - 1);
        const x = s.pos.x + s.right.x * lat, z = s.pos.z + s.right.z * lat;
        // inside the channel the strip lies safely under the water (steps and waves must never show it); on the banks it stays above the coarse terrain mesh
        const inChannel = Math.abs(lat) < (s.width / 2) * 0.85;
        const g = inChannel ? (groundAt(terrain, x, z) ?? s.level - s.depth) - 0.2 : groundMaxAt(terrain, x, z);
        const i = r * bcols + j;
        bpos[i * 3] = x; bpos[i * 3 + 1] = (g ?? s.level - s.depth) + (inChannel ? 0 : BED_LIFT_M); bpos[i * 3 + 2] = z;
        buv[i * 2] = lat + half; buv[i * 2 + 1] = s.s;
        bnrm[i * 3 + 1] = 1;
      }
    }
    const bidx: number[] = [];
    for (let r = 0; r < n - 1; r++) for (let j = 0; j < bcols - 1; j++) { const a = r * bcols + j, b = a + 1, c = a + bcols, d = c + 1; bidx.push(a, b, c, b, d, c); }
    bank = new THREE.BufferGeometry();
    bank.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
    bank.setAttribute('normal', new THREE.BufferAttribute(bnrm, 3));
    bank.setAttribute('uv', new THREE.BufferAttribute(buv, 2));
    bank.setAttribute('aStrip', new THREE.BufferAttribute(new Float32Array(n * bcols * 3), 3));
    bank.setIndex(bidx);
    bank.computeVertexNormals();
    bank.computeBoundingSphere();
  }

  // ---- boulders and obstacles --------------------------------------------------------------------------------
  const rocks: RockPlacement[] = [];
  const obstacles: Obstacle[] = [];
  const s0 = S[chunk.i0].s, s1 = S[chunk.i1].s;
  const len = s1 - s0;
  const sampleAt = (s: number): RiverSample => {
    let lo = chunk.i0, hi = chunk.i1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid].s <= s) lo = mid; else hi = mid; }
    return S[lo];
  };
  if (chunk.kind === 'river' && style.rocks.density > 0 && len > 0.5) {
    // rapids are boulder fields
    let rapRows = 0;
    for (let i = chunk.i0; i <= chunk.i1; i++) if (S[i].kind === 'rapids') rapRows++;
    const rapFrac = rapRows / (chunk.i1 - chunk.i0 + 1);
    const expected = (style.rocks.density * len * (1 + 1.6 * rapFrac)) / 100;
    const count = Math.floor(expected) + (hash01(rt.seed, chunk.index, 9001) < expected - Math.floor(expected) ? 1 : 0);
    for (let k = 0; k < count; k++) {
      const h = (j: number): number => hash01(rt.seed, chunk.index * 131 + k, j);
      const s = s0 + len * h(1);
      const smp = sampleAt(s);
      const size = rockSize(style.rocks.min, style.rocks.max, h(2));
      const inWater = h(3) < style.rocks.inWater + (1 - style.rocks.inWater) * 0.5 * rapFrac;
      const hw = smp.width / 2;
      const side = h(4) < 0.5 ? -1 : 1;
      let lat: number;
      if (inWater) lat = (h(5) * 2 - 1) * Math.max(0, hw - size * 0.35);
      else lat = side * (hw + 0.2 + h(5) * style.banks.width * 0.7);
      const x = smp.pos.x + smp.right.x * lat, z = smp.pos.z + smp.right.z * lat;
      const g = groundAt(terrain, x, z);
      if (g === null) continue;
      const aspect = 0.7 + h(6) * 0.7;
      if (inWater && g < smp.level + 0.02) {
        // stands in the water: from the bed to a bit above the surface
        const prot = 0.08 + h(7) * 0.5;
        const top = smp.level + prot * size;
        const bottom = g - 0.15 * size;
        const H = top - bottom;
        if (H > size * 2.4 || H < size * 0.3) continue;
        rocks.push({ x, y: bottom + H / 2, z, sx: size / 2, sy: H / 2, sz: (size * aspect) / 2, yaw: h(8) * Math.PI * 2, variant: Math.floor(h(9) * 6), shade: Math.floor(h(10) * 3) });
        obstacles.push({ lat, v: smp.s, r: Math.max(0.2, size * 0.5 * Math.min(1, aspect + 0.2)), strength: clamp(0.45 + prot, 0, 1) });
      } else {
        const H = size * (0.6 + h(7) * 0.4);
        rocks.push({ x, y: g + H * 0.3, z, sx: size / 2, sy: H / 2, sz: (size * aspect) / 2, yaw: h(8) * Math.PI * 2, variant: Math.floor(h(9) * 6), shade: Math.floor(h(10) * 3) });
      }
    }
  }
  // things that stand in the water but belong to somebody else (bridge piers …)
  for (const e of external) {
    let best = chunk.i0, bd = Infinity;
    for (let i = chunk.i0; i <= chunk.i1; i++) { const d = Math.hypot(S[i].pos.x - e.x, S[i].pos.z - e.z); if (d < bd) { bd = d; best = i; } }
    const smp = S[best];
    const lat = (e.x - smp.pos.x) * smp.right.x + (e.z - smp.pos.z) * smp.right.z;
    if (Math.abs(lat) < smp.width / 2 + e.r) obstacles.push({ lat, v: smp.s, r: e.r, strength: 1 });
  }
  return { water, bank, rocks, obstacles, bounds: box };
}
