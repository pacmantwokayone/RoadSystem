// Bridge sections of a road: maximal runs of samples in mode 'bridge'. Derived from the samples alone (no terrain,
// no chunk state), so every chunk agrees on where a section starts and ends and on where its piers stand.

import { Vector3 } from 'three';
import type { RoadRuntime } from '../runtime/roadRuntime';

export interface BridgeSection {
  /** first / last sample index of the section */
  i0: number;
  i1: number;
  /** arc length of the first / last sample */
  s0: number;
  s1: number;
  /** the section's start / end is a transition to ordinary road (abutment there) */
  startsAtRoad: boolean;
  endsAtRoad: boolean;
}

/** shortest section worth a structure, metres */
export const MIN_BRIDGE_LENGTH_M = 3;

const cache = new WeakMap<RoadRuntime, BridgeSection[]>();

export function bridgeSections(rt: RoadRuntime): BridgeSection[] {
  const hit = cache.get(rt);
  if (hit) return hit;
  const out: BridgeSection[] = [];
  const n = rt.samples.length;
  for (let i = 0; i < n; i++) {
    if (rt.samples[i].mode !== 'bridge') continue;
    let j = i;
    while (j + 1 < n && rt.samples[j + 1].mode === 'bridge') j++;
    const s0 = rt.samples[i].s, s1 = rt.samples[j].s;
    if (s1 - s0 >= MIN_BRIDGE_LENGTH_M) out.push({ i0: i, i1: j, s0, s1, startsAtRoad: i > 0, endsAtRoad: j < n - 1 });
    i = j;
  }
  cache.set(rt, out);
  return out;
}

/** Support positions along a section: the section is split into equal spans no longer than `maxSpan`; the interior
 * boundaries are the pier positions (the ends are abutments). */
export function pierPositions(section: Pick<BridgeSection, 's0' | 's1'>, maxSpan: number): number[] {
  const len = section.s1 - section.s0;
  const spans = Math.max(1, Math.ceil(len / maxSpan - 1e-9));
  return Array.from({ length: spans - 1 }, (_, k) => section.s0 + (len * (k + 1)) / spans);
}

// ---- piers that keep clear of roads underneath -------------------------------------------------------------------------

const UNDERPASS_MARGIN_M = 3.5;
const UNDERPASS_CLEARANCE_M = 3.5;
const pierCache = new WeakMap<RoadRuntime, Map<string, number[]>>();

/** Is there a road passing under the bridge deck at plan position (x, z) (THREE space), deck at height y? */
function roadBelow(rt: RoadRuntime, x: number, z: number, y: number): boolean {
  for (const o of rt.siblings()) {
    if (o === rt) continue;
    const reach = o.profile.carriageHalfWidth + UNDERPASS_MARGIN_M;
    const S = o.samples;
    for (let i = 0; i + 1 < S.length; i++) {
      const a = S[i].pos, b = S[i + 1].pos;
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      if (Math.abs(a.x - x) > reach + Math.sqrt(l2) + 1 && Math.abs(b.x - x) > reach + Math.sqrt(l2) + 1) continue;
      const t = l2 > 1e-9 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d < reach && y - (a.y + (b.y - a.y) * t) > UNDERPASS_CLEARANCE_M) return true;
    }
  }
  return false;
}

/**
 * Pier positions of a section: the equal divisions of `pierPositions`, except that a pier which would stand on a road passing beneath
 * moves along the section to the nearest free spot (the neighbouring spans get longer or shorter). Computed from the other roads of the
 * system, so it is cached per (section, set of roads).
 */
export function pierPositionsFor(rt: RoadRuntime, section: Pick<BridgeSection, 's0' | 's1'>, maxSpan: number): number[] {
  const base = pierPositions(section, maxSpan);
  const sibs = rt.siblings();
  if (sibs.length <= 1) return base;
  // no sibling signature: the RoadSystem rebuilds a bridging road (a new runtime) whenever a road close to it changes
  const key = `${section.s0.toFixed(2)}:${section.s1.toFixed(2)}:${maxSpan}`;
  let byKey = pierCache.get(rt);
  if (!byKey) { byKey = new Map(); pierCache.set(rt, byKey); }
  const hit = byKey.get(key);
  if (hit) return hit;
  const curve = rt.sampled.curve;
  const P = new Vector3();
  const blocked = (s: number): boolean => { curve.pointAt(s, P); return roadBelow(rt, P.x, P.z, P.y); };
  const out: number[] = [];
  const minGap = Math.max(4, maxSpan * 0.25);
  for (const s0 of base) {
    let s = s0;
    if (blocked(s0)) {
      let found = false;
      for (let d = 2; d <= maxSpan * 0.45 && !found; d += 2) {
        for (const c of [s0 + d, s0 - d]) {
          if (c < section.s0 + 3 || c > section.s1 - 3) continue;
          if (!blocked(c) && !blocked(c - 2) && !blocked(c + 2)) { s = c; found = true; break; }
        }
      }
    }
    if (out.length === 0 || s - out[out.length - 1] >= minGap) out.push(s);
  }
  byKey.set(key, out);
  return out;
}
