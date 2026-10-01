// Who gets which sign, stop line and zebra crossing at a junction — pure topology, no geometry.

import type { CrosswalkMode, JunctionControl } from '../network/types';
import type { ProfileData } from '../profile/types';
import { hasBarrier, hasWalkable, isMarkedRoad, laneSpan } from './traits';

export type SignKind = 'hauptstrasse' | 'kein_vortritt' | 'stop';
export type LineKind = 'stop' | 'wait';

export interface ControlOptions {
  /** arms with a lower rank are not roads for motor traffic: no sign, and they don't change who has priority */
  minRank: number;
  /** a minor arm this many ranks below the strongest gets "Stop" instead of "Kein Vortritt" (control 'auto') */
  stopRankGap: number;
}

export const DEFAULT_CONTROL_OPTIONS: ControlOptions = { minRank: 2, stopRankGap: 99 };

export interface ArmControl {
  /** sign beside the arm (null = none) */
  sign: SignKind | null;
  /** line across the incoming lanes: solid stop line, or the dashed "Wartelinie" for give-way */
  line: LineKind | null;
  /** a zebra crossing across this arm */
  crosswalk: boolean;
}

/** Signs by rank. 'auto': equal ranks → none (right-before-left); else the strongest arms get Hauptstrasse,
 *  weaker ones Kein Vortritt (Stop at a big rank gap). 'stop' / 'yield' force that sign on every arm below the
 *  top rank (on every arm when all ranks are equal). */
export function signKinds(control: JunctionControl, ranks: readonly number[], opts: ControlOptions = DEFAULT_CONTROL_OPTIONS): Array<SignKind | null> {
  const none = ranks.map(() => null);
  if (control === 'none' || control === 'signals') return none;
  const eligible = ranks.map((r) => r >= opts.minRank);
  const count = eligible.filter(Boolean).length;
  if (count < 3) return none;
  const top = Math.max(...ranks.filter((_, i) => eligible[i]));
  const low = Math.min(...ranks.filter((_, i) => eligible[i]));
  if (control === 'auto') {
    if (top === low) return none;
    return ranks.map((r, i) => (!eligible[i] ? null : r === top ? 'hauptstrasse' : top - r >= opts.stopRankGap ? 'stop' : 'kein_vortritt'));
  }
  const forced: SignKind = control === 'stop' ? 'stop' : 'kein_vortritt';
  return ranks.map((r, i) => {
    if (!eligible[i]) return null;
    if (top === low) return forced;
    return r === top ? 'hauptstrasse' : forced;
  });
}

/** Does this arm get a zebra crossing? */
export function wantsCrosswalk(mode: CrosswalkMode, profile: ProfileData, armCount: number, opts: ControlOptions = DEFAULT_CONTROL_OPTIONS): boolean {
  if (mode === 'none' || armCount < 3) return false;
  if (profile.rank < opts.minRank || profile.rank >= 7 || hasBarrier(profile)) return false;
  if (laneSpan(profile, 1) === null && laneSpan(profile, -1) === null) return false;
  return mode === 'all' || hasWalkable(profile);
}

export function planJunction(
  control: JunctionControl,
  crosswalks: CrosswalkMode,
  profiles: readonly ProfileData[],
  opts: ControlOptions = DEFAULT_CONTROL_OPTIONS,
): ArmControl[] {
  const ranks = profiles.map((p) => p.rank);
  const signs = signKinds(control, ranks, opts);
  return profiles.map((p, i) => {
    const sign = signs[i];
    const marked = isMarkedRoad(p);
    let line: LineKind | null = null;
    if (marked && control === 'signals' && p.rank >= opts.minRank) line = 'stop';
    else if (marked && sign === 'stop') line = 'stop';
    else if (marked && sign === 'kein_vortritt') line = 'wait';
    return { sign, line, crosswalk: wantsCrosswalk(crosswalks, p, profiles.length, opts) };
  });
}
