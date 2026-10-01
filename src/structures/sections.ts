// Bridge sections of a road: maximal runs of samples in mode 'bridge'. Derived from the samples alone (no terrain,
// no chunk state), so every chunk agrees on where a section starts and ends and on where its piers stand.

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
