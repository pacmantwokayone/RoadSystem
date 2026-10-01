// Geometry of a lake: a grid of water over the (smoothed) outline, coloured by the depth of the real terrain below it; a bank strip
// along the shore; boulders on and near the shore.

import * as THREE from 'three';
import { hash01 } from '../props/rules';
import { flipZ } from '../core/world';
import { outlineArea, outlineBounds, pointInOutline, smoothOutline } from './outline';
import { groundMaxAt } from './riverMesh';
import { rockSize, type Obstacle, type RockPlacement } from './rocks';
import type { LakeRuntime, WaterTerrain } from './system';

export interface LakeGeometry {
  water: THREE.BufferGeometry;
  bank: THREE.BufferGeometry | null;
  rocks: RockPlacement[];
  obstacles: Obstacle[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function distToOutline(x: number, z: number, pts: ReadonlyArray<{ x: number; z: number }>): number {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

export function buildLake(lk: LakeRuntime, terrain: WaterTerrain): LakeGeometry {
  const def = lk.def, style = lk.style;
  const outline = smoothOutline(def.outline); // SIM coordinates
  const b = outlineBounds(outline);
  const level = def.level;
  const cell = clamp(Math.sqrt((b.maxX - b.minX) * (b.maxZ - b.minZ)) / 64, 3, 12);
  const margin = cell * 1.6;
  const x0 = b.minX - margin, z0 = b.minZ - margin;
  const nx = Math.ceil((b.maxX + margin - x0) / cell), nz = Math.ceil((b.maxZ + margin - z0) / cell);

  // lattice nodes near the water
  const node = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
  const wet = new Uint8Array((nx + 1) * (nz + 1));
  for (let k = 0; k <= nz; k++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * cell, z = z0 + k * cell;
      wet[k * (nx + 1) + i] = pointInOutline(x, z, outline) || distToOutline(x, z, outline) < cell * 1.2 ? 1 : 0;
    }
  }
  const pos: number[] = [], depth: number[] = [], wx: number[] = [], wz: number[] = [];
  const idx: number[] = [];
  const vertex = (i: number, k: number): number => {
    const key = k * (nx + 1) + i;
    if (node[key] >= 0) return node[key];
    const x = x0 + i * cell, z = z0 + k * cell;
    const g = terrain.heightAt(x, z);
    node[key] = pos.length / 3;
    pos.push(x, level, flipZ(z));
    depth.push(clamp(g === null ? def.depth * 0.5 : level - g, -0.5, 300));
    wx.push(x); wz.push(flipZ(z));
    return node[key];
  };
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      if (!(wet[k * (nx + 1) + i] || wet[k * (nx + 1) + i + 1] || wet[(k + 1) * (nx + 1) + i] || wet[(k + 1) * (nx + 1) + i + 1])) continue;
      const a = vertex(i, k), bb = vertex(i + 1, k), c = vertex(i, k + 1), d = vertex(i + 1, k + 1);
      // sim z grows towards −z in THREE space, so (a, bb, c) faces up
      idx.push(a, bb, c, bb, d, c);
    }
  }
  const vcount = pos.length / 3;
  const water = new THREE.BufferGeometry();
  water.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  water.setAttribute('aLat', new THREE.Float32BufferAttribute(wx, 1));    // world x / z, for the foam rings around rocks
  water.setAttribute('aV', new THREE.Float32BufferAttribute(wz, 1));
  water.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  water.setAttribute('aTurb', new THREE.Float32BufferAttribute(new Array(vcount).fill(0), 1));
  water.setAttribute('aSpeed', new THREE.Float32BufferAttribute(new Array(vcount).fill(0), 1));
  water.setAttribute('aHalf', new THREE.Float32BufferAttribute(new Array(vcount).fill(1), 1));
  water.setAttribute('aDir', new THREE.Float32BufferAttribute(new Array(vcount * 2).fill(0).map((_, i) => (i % 2 === 0 ? 1 : 0)), 2));
  water.setIndex(idx);
  water.computeBoundingSphere();

  // ---- shore strip ----------------------------------------------------------------------------------
  const area = outlineArea(outline);
  const sgn = area >= 0 ? 1 : -1;
  let bank: THREE.BufferGeometry | null = null;
  const strip = style.banks.strip;
  if (strip > 0.05) {
    const m = outline.length;
    const bpos = new Float32Array(m * 2 * 3), buv = new Float32Array(m * 2 * 2), bnrm = new Float32Array(m * 2 * 3);
    let acc = 0;
    for (let i = 0; i < m; i++) {
      const p = outline[i], prev = outline[(i + m - 1) % m], next = outline[(i + 1) % m];
      // outward normal (mitred) in sim x/z
      const n1 = { x: sgn * (p.z - prev.z), z: -sgn * (p.x - prev.x) }, n2 = { x: sgn * (next.z - p.z), z: -sgn * (next.x - p.x) };
      const l1 = Math.hypot(n1.x, n1.z) || 1, l2 = Math.hypot(n2.x, n2.z) || 1;
      let nx_ = n1.x / l1 + n2.x / l2, nz_ = n1.z / l1 + n2.z / l2;
      const nl = Math.hypot(nx_, nz_) || 1; nx_ /= nl; nz_ /= nl;
      if (i > 0) acc += Math.hypot(p.x - prev.x, p.z - prev.z);
      for (let side = 0; side < 2; side++) {
        const off = side === 0 ? -1.5 : strip; // from a little under the water to the strip's outer edge
        const x = p.x + nx_ * off, z = p.z + nz_ * off;
        const g = groundMaxAt(terrain, x, flipZ(z));
        const vi = i * 2 + side;
        bpos[vi * 3] = x; bpos[vi * 3 + 1] = (g ?? level - 0.5) + 0.03; bpos[vi * 3 + 2] = flipZ(z);
        buv[vi * 2] = side === 0 ? 0 : strip + 1.5; buv[vi * 2 + 1] = acc;
        bnrm[vi * 3 + 1] = 1;
      }
    }
    const bidx: number[] = [];
    for (let i = 0; i < m; i++) { const a = i * 2, c = ((i + 1) % m) * 2; bidx.push(a, c, a + 1, a + 1, c, c + 1); }
    // orient up whatever the outline's direction
    for (let t = 0; t < bidx.length; t += 3) {
      const a = bidx[t], b2 = bidx[t + 1], c2 = bidx[t + 2];
      const ux = bpos[b2 * 3] - bpos[a * 3], uz = bpos[b2 * 3 + 2] - bpos[a * 3 + 2];
      const vx = bpos[c2 * 3] - bpos[a * 3], vz = bpos[c2 * 3 + 2] - bpos[a * 3 + 2];
      if (uz * vx - ux * vz < 0) { bidx[t + 1] = c2; bidx[t + 2] = b2; }
    }
    bank = new THREE.BufferGeometry();
    bank.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
    bank.setAttribute('normal', new THREE.BufferAttribute(bnrm, 3));
    bank.setAttribute('uv', new THREE.BufferAttribute(buv, 2));
    bank.setAttribute('aStrip', new THREE.BufferAttribute(new Float32Array(m * 2 * 3), 3));
    bank.setIndex(bidx);
    bank.computeVertexNormals();
    bank.computeBoundingSphere();
  }

  // ---- boulders along the shore -------------------------------------------------------------------------------
  const rocks: RockPlacement[] = [];
  const obstacles: Obstacle[] = [];
  if (style.rocks.density > 0) {
    let perimeter = 0;
    const cum = [0];
    for (let i = 0; i < outline.length; i++) { const a = outline[i], bq = outline[(i + 1) % outline.length]; perimeter += Math.hypot(bq.x - a.x, bq.z - a.z); cum.push(perimeter); }
    const expected = (style.rocks.density * perimeter) / 100;
    const count = Math.floor(expected) + (hash01(lk.seed, 9001) < expected - Math.floor(expected) ? 1 : 0);
    for (let k = 0; k < count; k++) {
      const h = (j: number): number => hash01(lk.seed, k, j);
      const d = h(1) * perimeter;
      let seg = 0;
      while (seg < outline.length - 1 && cum[seg + 1] < d) seg++;
      const a = outline[seg], bq = outline[(seg + 1) % outline.length];
      const t = (d - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]);
      const px = a.x + (bq.x - a.x) * t, pz = a.z + (bq.z - a.z) * t;
      const ex = bq.x - a.x, ez = bq.z - a.z, el = Math.hypot(ex, ez) || 1;
      const nxv = (sgn * ez) / el, nzv = (-sgn * ex) / el; // outward
      const size = rockSize(style.rocks.min, style.rocks.max, h(2));
      const inWater = h(3) < style.rocks.inWater;
      const off = inWater ? -(0.3 + h(4) * Math.min(4, size * 2.5)) : 0.3 + h(4) * style.banks.width * 0.6;
      const x = px + nxv * off, z = pz + nzv * off;
      const g = terrain.heightAt(x, z);
      if (g === null) continue;
      const aspect = 0.7 + h(6) * 0.7;
      if (inWater && g < level + 0.02) {
        const prot = 0.08 + h(7) * 0.5;
        const top = level + prot * size, bottom = g - 0.15 * size, H = top - bottom;
        if (H > size * 2.4 || H < size * 0.3) continue;
        rocks.push({ x, y: bottom + H / 2, z: flipZ(z), sx: size / 2, sy: H / 2, sz: (size * aspect) / 2, yaw: h(8) * Math.PI * 2, variant: Math.floor(h(9) * 6), shade: Math.floor(h(10) * 3) });
        obstacles.push({ lat: x, v: flipZ(z), r: Math.max(0.2, size * 0.5), strength: clamp(0.4 + prot, 0, 1) });
      } else {
        const H = size * (0.6 + h(7) * 0.4);
        rocks.push({ x, y: g + H * 0.3, z: flipZ(z), sx: size / 2, sy: H / 2, sz: (size * aspect) / 2, yaw: h(8) * Math.PI * 2, variant: Math.floor(h(9) * 6), shade: Math.floor(h(10) * 3) });
      }
    }
  }
  return { water, bank, rocks, obstacles };
}
