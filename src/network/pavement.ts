// Pavement (Trottoir) corners at junctions. The junction patch covers the carriageway only; where the
// arms have kerbs and pavements, a strip of pavement runs along the patch boundary from one arm's pavement
// to the next one's — around fillets and mitres, and across the straight gaps between aligned arms.

import { profileHeightAt, profileHeightInside, type ProfileData } from '../profile/types';
import { roadwaySpan } from '../junction/traits';
import type { Boundary } from './junction';

export interface PavementSide {
  /** pavement width incl. kerb, metres (profile space) */
  width: number;
  /** height of the pavement above the carriageway edge, metres */
  step: number;
  /** material of the pavement top */
  top: string;
  /** material of the kerb face */
  curb: string;
}

/** The pavement beside the carriageway on one side of a profile (side +1 = right), or null when there is none. */
export function pavementOf(profile: ProfileData, side: 1 | -1): PavementSide | null {
  const road = roadwaySpan(profile, side);
  const edge = road ? road.outer : profile.carriageHalfWidth;
  let outer = 0;
  let top: string | null = null;
  let curb: string | null = null;
  profile.segments.forEach((seg, k) => {
    const a = profile.points[k].x * side, b = profile.points[k + 1].x * side;
    if (Math.max(a, b) < edge - 1e-6) return;
    if (seg.kind === 'curb') curb ??= seg.material; // the kerb face is a zero-width step at the roadway edge
    else if (seg.kind === 'walkable' && Math.max(a, b) > edge + 1e-6) { outer = Math.max(outer, a, b); top ??= seg.material; }
  });
  if (!top || outer <= edge + 0.05) return null;
  const step = profileHeightAt(profile, side * outer) - profileHeightInside(profile, side * edge);
  return { width: outer - edge, step: Math.max(0, step), top, curb: curb ?? top };
}

/** Index runs along the boundary that need a pavement: from an arm's right corner, over the wedge points,
 *  to the next arm's left corner. Each run is a list of boundary point indices. */
export function pavementRuns(boundary: Boundary): number[][] {
  const pts = boundary.points;
  const n = pts.length;
  const runs: number[][] = [];
  for (let k = 0; k < n; k++) {
    const t = pts[k].tag;
    if (t.type !== 'arm' || t.f < 1 - 1e-9) continue;
    const run = [k];
    let j = (k + 1) % n;
    while (pts[j].tag.type === 'wedge' && run.length <= n) { run.push(j); j = (j + 1) % n; }
    const end = pts[j].tag;
    if (end.type !== 'arm' || end.f > 1e-9 || end.arm === t.arm) continue; // a dead end's cap has no pavement
    run.push(j);
    runs.push(run);
  }
  return runs;
}
