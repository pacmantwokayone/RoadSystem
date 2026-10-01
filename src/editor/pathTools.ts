// Geometry helpers for editing a road in the viewport (all in THREE space unless noted).

import { Vector3 } from 'three';
import type { RoadDef, RoadPoint } from '../network/types';
import type { SampledRoad } from '../core/sampling';
import { threeToSim } from '../core/world';

export interface PathProjection {
  /** horizontal distance from the query point to the road centre line, metres */
  distance: number;
  /** arc length of the closest point */
  s: number;
  /** authored segment the closest point lies in (between points seg and seg + 1) */
  seg: number;
  point: Vector3;
}

/** Closest point of the road's centre line to (x, z), measured in the horizontal plane. */
export function projectOnRoad(sampled: SampledRoad, x: number, z: number): PathProjection {
  const ss = sampled.samples;
  let best: PathProjection | null = null;
  for (let i = 0; i < ss.length - 1; i++) {
    const a = ss[i].pos, b = ss[i + 1].pos;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-12 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (!best || d < best.distance) {
      const s = ss[i].s + (ss[i + 1].s - ss[i].s) * t;
      best = { distance: d, s, seg: sampled.curve.locate(s).seg, point: new Vector3(px, a.y + (b.y - a.y) * t, pz) };
    }
  }
  return best ?? { distance: Infinity, s: 0, seg: 0, point: new Vector3() };
}

/** New point on the curve at arc length `s`, inheriting attributes from the segment it splits. */
export function pointAtS(def: RoadDef, sampled: SampledRoad, s: number, y?: number): { index: number; point: RoadPoint } {
  const { seg } = sampled.curve.locate(s);
  const a = def.points[seg], b = def.points[seg + 1];
  const p = sampled.curve.pointAt(s);
  const sim = threeToSim(p);
  const point: RoadPoint = { x: sim.x, y: y ?? sim.y, z: sim.z };
  // keep a bridge/tunnel mode and fixed elevation only if the whole segment has it
  const modeA = a.mode ?? 'road', modeB = b.mode ?? 'road';
  if (modeA === modeB && modeA !== 'road') point.mode = modeA;
  if (a.elev === 'fixed' && b.elev === 'fixed') point.elev = 'fixed';
  if (a.widthScale !== undefined || b.widthScale !== undefined) {
    point.widthScale = ((a.widthScale ?? 1) + (b.widthScale ?? 1)) / 2;
  }
  if (a.banking !== undefined || b.banking !== undefined) point.banking = ((a.banking ?? 0) + (b.banking ?? 0)) / 2;
  return { index: seg + 1, point };
}

/** Road whose centre line is closest to (x, z) within `maxDist`, else undefined. */
export function nearestRoad(
  roads: ReadonlyArray<{ def: RoadDef; sampled: SampledRoad }>,
  x: number, z: number, maxDist: number,
): { id: string; projection: PathProjection } | undefined {
  let best: { id: string; projection: PathProjection } | undefined;
  for (const r of roads) {
    const pr = projectOnRoad(r.sampled, x, z);
    if (pr.distance <= maxDist && (!best || pr.distance < best.projection.distance)) best = { id: r.def.id, projection: pr };
  }
  return best;
}
