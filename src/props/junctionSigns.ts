// Automatic right-of-way signs at junctions, from the topology: every arm has a rank (its profile's
// `rank`). Where the drivable arms of a junction differ in rank, the weaker ones get "Kein Vortritt"
// (or "Stop" for a big rank gap) and the strongest get the "Hauptstrasse" sign; equal ranks mean
// right-before-left (Rechtsvortritt), which needs no sign.
//
// Paths and tracks (rank below `minRank`) take no part. Signs stand on the right-hand edge as seen by
// traffic approaching the node, a few metres before the patch, facing that traffic.

import * as THREE from 'three';
import type { JunctionRuntime } from '../runtime/junctionRuntime';
import { profileHeightAt } from '../profile/types';
import type { Placement } from './place';

export interface JunctionSignOptions {
  /** arms with a lower rank are not roads for motor traffic: no sign, and they don't change who has priority */
  minRank: number;
  /** a minor arm this many ranks below the strongest gets "Stop" instead of "Kein Vortritt" */
  stopRankGap: number;
  /** distance from the arm's end to the sign, metres */
  setbackM: number;
  /** extra distance beyond the carriageway edge, metres */
  edgeGapM: number;
}

export const DEFAULT_JUNCTION_SIGNS: JunctionSignOptions = { minRank: 2, stopRankGap: 99, setbackM: 3.5, edgeGapM: 1.3 };

export type JunctionSignKind = 'hauptstrasse' | 'kein_vortritt' | 'stop';

/** which sign each arm gets (null = none) — pure topology, separate from the geometry below */
export function junctionSignKinds(ranks: readonly number[], opts: JunctionSignOptions = DEFAULT_JUNCTION_SIGNS): Array<JunctionSignKind | null> {
  const eligible = ranks.map((r) => r >= opts.minRank);
  if (eligible.filter(Boolean).length < 3) return ranks.map(() => null);
  const max = Math.max(...ranks.filter((_, i) => eligible[i]));
  const min = Math.min(...ranks.filter((_, i) => eligible[i]));
  if (max === min) return ranks.map(() => null);
  return ranks.map((r, i) => {
    if (!eligible[i]) return null;
    if (r === max) return 'hauptstrasse';
    return max - r >= opts.stopRankGap ? 'stop' : 'kein_vortritt';
  });
}

export function placeJunctionSigns(j: JunctionRuntime, opts: JunctionSignOptions = DEFAULT_JUNCTION_SIGNS): Placement[] {
  if (!j.patch) return [];
  const kinds = junctionSignKinds(j.arms.map((a) => a.road.profile.rank), opts);
  const out: Placement[] = [];
  j.arms.forEach((arm, i) => {
    const kind = kinds[i];
    if (!kind) return;
    const c = arm.road.endCross(arm.end);
    const t = c.frame.tangent;
    const th = Math.hypot(t.x, t.z) || 1;
    const sgn = arm.end === 'start' ? 1 : -1;
    const dir = { x: (sgn * t.x) / th, z: (sgn * t.z) / th }; // away from the node, along the road
    // right-hand side as seen by traffic driving towards the node (direction −dir): right(−dir) = (dir.z, −dir.x)
    const rx = dir.z, rz = -dir.x;
    const profile = arm.road.profile;
    const lateral = Math.min(profile.outerHalfWidth * c.widthScale, c.halfCore + opts.edgeGapM);
    // arm-right is road-right for the 'end' end (traffic goes along +t), road-left for 'start'
    const xp = (arm.end === 'end' ? 1 : -1) * (lateral / c.widthScale);
    const y = c.pos.y + profileHeightAt(profile, xp);
    out.push({
      asset: `sign:${kind}`,
      pos: new THREE.Vector3(c.pos.x + dir.x * opts.setbackM + rx * lateral, y, c.pos.z + dir.z * opts.setbackM + rz * lateral),
      yaw: Math.atan2(dir.x, dir.z),
      scale: 1, rule: -1, s: 0, side: 'right',
    });
  });
  return out;
}
