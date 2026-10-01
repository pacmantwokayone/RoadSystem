// What a junction needs to know about an arm's profile: where the lanes are, whether there are
// pavements, whether the road has a median barrier. Pure functions of ProfileData.

import { LANE_KINDS, ROADWAY_KINDS, type ProfileData } from '../profile/types';

export interface Span {
  /** distance from the axis where the span starts (profile space, always ≥ 0) */
  inner: number;
  /** … and where it ends */
  outer: number;
}

function spanOf(profile: ProfileData, side: 1 | -1, kinds: ReadonlySet<string>): Span | null {
  let inner = Infinity, outer = -Infinity;
  profile.segments.forEach((seg, k) => {
    if (!kinds.has(seg.kind)) return;
    const a = profile.points[k].x, b = profile.points[k + 1].x;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    // the part of the segment on this side
    const from = side === 1 ? Math.max(0, lo) : Math.max(0, -hi);
    const to = side === 1 ? hi : -lo;
    if (to <= from + 1e-9) return;
    inner = Math.min(inner, from);
    outer = Math.max(outer, to);
  });
  return outer > inner ? { inner, outer } : null;
}

/** Span of the driving lanes on one side (side +1 = right of the road's direction). */
export function laneSpan(profile: ProfileData, side: 1 | -1): Span | null {
  return spanOf(profile, side, LANE_KINDS);
}

/** Span of everything a pedestrian crosses on a zebra crossing on one side: lanes, parking, shoulder. */
export function roadwaySpan(profile: ProfileData, side: 1 | -1): Span | null {
  return spanOf(profile, side, ROADWAY_KINDS);
}

export function hasWalkable(profile: ProfileData): boolean {
  return profile.segments.some((s) => s.kind === 'walkable');
}

export function hasBarrier(profile: ProfileData): boolean {
  return profile.segments.some((s) => s.kind === 'barrier');
}

/** A road built for motor traffic with lane markings worth a stop line. */
export function isMarkedRoad(profile: ProfileData): boolean {
  return profile.rank >= 3 && laneSpan(profile, 1) !== null && laneSpan(profile, -1) !== null && !hasBarrier(profile);
}
