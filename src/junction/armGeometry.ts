// Positions at a junction arm, measured from the arm's END (the patch side) into the road, and the
// layout of the marked things on it (zebra crossing, stop line, signal poles). Shared by the markings
// mesh, the signs and the traffic lights so that they always agree.

import type { RoadChunk } from '../runtime/roadRuntime';
import type { JunctionArm } from '../runtime/junctionRuntime';
import type { ProfileData } from '../profile/types';
import { ChunkSampler } from '../props/sampler';
import { laneSpan, roadwaySpan } from './traits';
import type { ArmControl } from './controls';

export const ZEBRA = {
  /** distance from the arm's end to the nearest edge of the crossing, metres */
  startM: 1.6,
  /** length of the crossing along the road, metres */
  depthM: 4.0,
  barM: 0.5,
  pitchM: 1.0,
  /** gap between the crossing and the stop line, metres */
  stopGapM: 1.2,
  stopLineM: 0.5,
  /** depth of the dashed give-way line, metres */
  waitLineM: 0.35,
  waitDashM: 0.5,
  waitGapM: 0.3,
} as const;

export interface ArmLayout {
  /** +1 / −1: profile side the approaching traffic uses (right of the road's direction for an 'end' end) */
  approachSide: 1 | -1;
  crosswalk: { d0: number; d1: number; left: number; right: number } | null;
  line: { kind: 'stop' | 'wait'; d0: number; d1: number; inner: number; outer: number } | null;
  /** distance of the signal pole / signs from the end */
  signalD: number;
  /** where a pole beside the roadway stands: profile x of the roadway edge on the approach side (+ margin) */
  roadEdge: number;
}

export function layoutArm(profile: ProfileData, arm: JunctionArm, control: ArmControl): ArmLayout {
  const side: 1 | -1 = arm.end === 'end' ? 1 : -1;
  const L = roadwaySpan(profile, -1), R = roadwaySpan(profile, 1);
  const crosswalk = control.crosswalk && L && R ? { d0: ZEBRA.startM, d1: ZEBRA.startM + ZEBRA.depthM, left: L.outer, right: R.outer } : null;
  const lane = laneSpan(profile, side);
  const lineD = crosswalk ? crosswalk.d1 + ZEBRA.stopGapM : ZEBRA.startM;
  const line = control.line && lane
    ? { kind: control.line, d0: lineD, d1: lineD + (control.line === 'stop' ? ZEBRA.stopLineM : ZEBRA.waitLineM), inner: lane.inner + 0.08, outer: lane.outer - 0.08 }
    : null;
  const edge = (side === 1 ? R : L)?.outer ?? profile.coreHalfWidth;
  return { approachSide: side, crosswalk, line, signalD: line ? line.d1 + 0.4 : ZEBRA.startM + 1.5, roadEdge: edge };
}

/** Sampler over the arm's end chunk, extended towards the road's interior (as far as its design heights are known)
 *  so that features a few metres behind the end still lie inside it. */
export function armSampler(arm: JunctionArm, reachM = 14): ChunkSampler {
  const rt = arm.road;
  const ch = rt.endChunk(arm.end);
  let i0 = ch.i0, i1 = ch.i1;
  const s = (i: number): number => rt.samples[i].s;
  if (arm.end === 'end') while (i0 > 0 && Number.isFinite(rt.designY[i0 - 1]) && s(i1) - s(i0) < reachM) i0--;
  else while (i1 < rt.samples.length - 1 && Number.isFinite(rt.designY[i1 + 1]) && s(i1) - s(i0) < reachM) i1++;
  const chunk: RoadChunk = { index: ch.index, i0, i1, state: 'ready' };
  return new ChunkSampler(rt, chunk);
}

/** arc length of the arm's end, and the direction into the road (+1 = increasing s) */
export function armEnd(arm: JunctionArm): { s: number; into: 1 | -1 } {
  const rt = arm.road;
  return arm.end === 'start' ? { s: rt.samples[0].s, into: 1 } : { s: rt.samples[rt.samples.length - 1].s, into: -1 };
}
