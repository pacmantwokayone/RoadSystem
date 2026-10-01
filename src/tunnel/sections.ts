// Tunnel sections of a road: maximal runs of samples in mode 'tunnel' (or 'gallery'). Derived from the samples alone, so every chunk
// agrees on where a section starts and ends. Like bridges, a tunnel starts and ends exactly on its authored points.

import type { RoadRuntime } from '../runtime/roadRuntime';

export interface TunnelSection {
  i0: number;
  i1: number;
  s0: number;
  s1: number;
  /** a portal stands at the start / end (the section meets ordinary road there; false at the very end of a road) */
  portalStart: boolean;
  portalEnd: boolean;
}

export const MIN_TUNNEL_LENGTH_M = 6;
const cache = new WeakMap<RoadRuntime, TunnelSection[]>();

const isTunnelMode = (m: string): boolean => m === 'tunnel' || m === 'gallery';

export function tunnelSections(rt: RoadRuntime): TunnelSection[] {
  const hit = cache.get(rt);
  if (hit) return hit;
  const out: TunnelSection[] = [];
  const n = rt.samples.length;
  for (let i = 0; i < n; i++) {
    if (!isTunnelMode(rt.samples[i].mode)) continue;
    let j = i;
    while (j + 1 < n && isTunnelMode(rt.samples[j + 1].mode)) j++;
    const s0 = rt.samples[i].s, s1 = rt.samples[j].s;
    if (s1 - s0 >= MIN_TUNNEL_LENGTH_M) out.push({ i0: i, i1: j, s0, s1, portalStart: i > 0, portalEnd: j < n - 1 });
    i = j;
  }
  cache.set(rt, out);
  return out;
}

/** interior of the tube, metres: half width at the walls, height of the straight wall, rise of the arch above it */
export interface TunnelDims {
  halfW: number;
  wall: number;
  rise: number;
}

export function tunnelDims(rt: RoadRuntime): TunnelDims {
  // a railway tube is taller: the overhead line hangs under the crown
  if (rt.profile.rail) return { halfW: Math.max(3.6, rt.profile.carriageHalfWidth + 0.5), wall: 4.0, rise: 2.9 };
  return { halfW: Math.max(3.4, rt.profile.carriageHalfWidth + 0.9), wall: 3.1, rise: 2.4 };
}
