// Road markings as thin ribbons lying on the road surface. They are generated per chunk from the
// profile's `markings`, following the extruded cross-section exactly (shared `ringSection`), and are
// lifted a few centimetres so they never z-fight with the road (log-depth makes polygonOffset useless).
//
// The dash pattern is a function of the ABSOLUTE arc length, so dashes continue seamlessly across
// chunk borders: a dash that straddles a border is simply drawn as two clipped pieces.

import * as THREE from 'three';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import type { MarkingDef } from '../profile/types';
import { profileHeightAt } from '../profile/types';
import { ringSection, type RingSection } from './extrude';

export interface MarkingOptions {
  /** lift above the road surface, metres */
  liftM: number;
}

export const DEFAULT_MARKING_OPTIONS: MarkingOptions = { liftM: 0.03 };

export const MARKING_MATERIAL: Record<MarkingDef['color'], string> = {
  white: 'marking_white',
  yellow: 'marking_yellow',
};

export interface Ribbon {
  /** lateral centre in profile space */
  x: number;
  width: number;
  color: MarkingDef['color'];
  dashed: boolean;
  dash: number;
  gap: number;
}

/** A marking definition → one or two ribbons (double lines, dashed + solid pairs). */
export function expandMarking(m: MarkingDef): Ribbon[] {
  const base = { width: m.width, color: m.color, dash: m.dash, gap: m.gap };
  switch (m.style) {
    case 'solid': return [{ ...base, x: m.x, dashed: false }];
    case 'dashed': return [{ ...base, x: m.x, dashed: true }];
    case 'double': return [{ ...base, x: m.x - m.spacing / 2, dashed: false }, { ...base, x: m.x + m.spacing / 2, dashed: false }];
    case 'dashed-solid': {
      const dashedRight = m.dashedSide === 'right';
      return [
        { ...base, x: m.x - m.spacing / 2, dashed: !dashedRight },
        { ...base, x: m.x + m.spacing / 2, dashed: dashedRight },
      ];
    }
  }
}

/** Dash intervals of the pattern (dash, gap) starting at s = 0, clipped to [s0, s1]. */
export function dashIntervals(s0: number, s1: number, dash: number, gap: number): Array<[number, number]> {
  const period = dash + gap;
  if (!(period > 0) || !(dash > 0)) return [];
  const out: Array<[number, number]> = [];
  for (let k = Math.floor(s0 / period); k * period < s1; k++) {
    const a = Math.max(s0, k * period);
    const b = Math.min(s1, k * period + dash);
    if (b - a > 0.02) out.push([a, b]);
  }
  return out;
}

export interface ChunkMarkings {
  geometry: THREE.BufferGeometry;
  materials: string[];
}

export function buildChunkMarkings(rt: RoadRuntime, chunk: RoadChunk, opts: MarkingOptions = DEFAULT_MARKING_OPTIONS): ChunkMarkings | null {
  const defs = rt.profile.markings;
  if (!defs.length) return null;
  const ribbons = defs.flatMap(expandMarking);
  const i0 = chunk.i0, i1 = chunk.i1;
  const sections: RingSection[] = [];
  for (let i = i0; i <= i1; i++) sections.push(ringSection(rt, i));
  const sAt = (r: number): number => rt.samples[i0 + r].s;
  const sMin = sAt(0), sMax = sAt(i1 - i0);

  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const byMat = new Map<string, number[]>();
  const tmpL = new THREE.Vector3(), tmpR = new THREE.Vector3(), tmpL2 = new THREE.Vector3(), tmpR2 = new THREE.Vector3();
  const up = new THREE.Vector3(), up2 = new THREE.Vector3();

  const emitStrip = (rb: Ribbon, a: number, b: number, list: number[]): void => {
    // sample positions: the interval ends plus every ring inside it
    const ss: number[] = [a];
    for (let r = 0; r <= i1 - i0; r++) { const s = sAt(r); if (s > a + 1e-6 && s < b - 1e-6) ss.push(s); }
    ss.push(b);
    const half = rb.width / 2;
    let r = 0;
    const first = pos.length / 3;
    ss.forEach((s) => {
      while (r < sections.length - 2 && sAt(r + 1) < s) r++;
      const s0 = sAt(r), s1 = sAt(r + 1);
      const f = s1 > s0 ? Math.min(1, Math.max(0, (s - s0) / (s1 - s0))) : 0;
      const A = sections[r], B = sections[r + 1] ?? sections[r];
      // lateral position of the ribbon edges at both rings (the paint keeps its width on width-scaled roads)
      const xc = A.mapX(rb.x), xc2 = B.mapX(rb.x);
      const y = profileHeightAt(rt.profile, rb.x);
      A.at(xc - half, y, tmpL); B.at(xc2 - half, y, tmpL2);
      A.at(xc + half, y, tmpR); B.at(xc2 + half, y, tmpR2);
      up.copy(A.frame.up); up2.copy(B.frame.up);
      const L = tmpL.lerp(tmpL2, f), R = tmpR.lerp(tmpR2, f);
      const n = up.lerp(up2, f).normalize();
      L.addScaledVector(n, opts.liftM); R.addScaledVector(n, opts.liftM);
      pos.push(L.x, L.y, L.z, R.x, R.y, R.z);
      nrm.push(n.x, n.y, n.z, n.x, n.y, n.z);
      uv.push(0, s, rb.width, s);
    });
    for (let k = 0; k < ss.length - 1; k++) {
      const a0 = first + k * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
      list.push(a0, b0, a1, b0, b1, a1); // same winding as the road quads → faces up
    }
  };

  for (const rb of ribbons) {
    const name = MARKING_MATERIAL[rb.color];
    let list = byMat.get(name);
    if (!list) { list = []; byMat.set(name, list); }
    const intervals: Array<[number, number]> = rb.dashed ? dashIntervals(sMin, sMax, rb.dash, rb.gap) : [[sMin, sMax]];
    for (const [a, b] of intervals) emitStrip(rb, a, b, list);
  }
  if (!pos.length) return null;

  const materials = [...byMat.keys()];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('aStrip', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([...byMat.values()].flat()), 1));
  let offset = 0;
  materials.forEach((m, i) => {
    const count = byMat.get(m)!.length;
    geometry.addGroup(offset, count, i);
    offset += count;
  });
  geometry.computeBoundingSphere();
  return { geometry, materials };
}
