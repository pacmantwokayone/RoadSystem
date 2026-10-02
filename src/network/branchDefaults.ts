// Sensible attachment parameters for a new branch, from the two profiles involved: a motorway exit gets a deceleration lane, a village
// street a short taper, a track a switch (the branch grows out of the track it leaves and diverges at once).

import type { ProfileData } from '../profile/types';
import type { AttachDef, RoadDef } from './types';

export type BranchKind = 'exit' | 'entry';

export interface BranchContext {
  parent: Pick<RoadDef, 'id'>;
  parentProfile: ProfileData;
  childProfile: ProfileData;
  /** where the nose is (SIM) and on which side of the parent the branch lies (seen along the parent's increasing arc length) */
  at: { x: number; z: number };
  side: 1 | -1;
  /** exit = the branch is the START of the new road, entry = its END */
  kind: BranchKind;
  /** run the head along the parent's increasing arc length (default) or against it */
  dir?: 1 | -1;
}

export function defaultAttach(c: BranchContext): AttachDef {
  const base = { road: c.parent.id, at: { ...c.at }, side: c.side, dir: c.dir ?? 1, head: 0 } as const;
  const rail = c.parentProfile.rail;
  if (rail) {
    // a turnout leaves the outermost track on its side
    const xs = rail.tracks.slice().sort((a, b) => a - b);
    const x = c.side === 1 ? xs[xs.length - 1] : xs[0];
    return { ...base, kind: 'switch', halfMain: Math.abs(x) * (Math.sign(x) === c.side || x === 0 ? 1 : -1), halfBranch: 0, grow: 60, taper: 60, taperStart: 0, parallel: 0, gap: 4.5, dy: -0.02, state: 'straight' };
  }
  const halfMain = c.parentProfile.carriageHalfWidth, halfBranch = c.childProfile.carriageHalfWidth;
  if (c.parentProfile.rank >= 7) return { ...base, kind: 'ramp', halfMain, halfBranch, grow: 50, parallel: 100, taper: 70, gap: 2 };
  return { ...base, kind: 'ramp', halfMain, halfBranch, grow: 25, parallel: 0, taper: 35, gap: 1.5 };
}
