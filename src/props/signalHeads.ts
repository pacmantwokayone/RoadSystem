// Where the traffic lights of a junction stand: one car head per arm beside the stop line, pedestrian
// heads at both ends of every zebra crossing. Pure placement from the junction topology.

import * as THREE from 'three';
import type { JunctionRuntime } from '../runtime/junctionRuntime';
import { planJunction } from '../junction/controls';
import { armEnd, armSampler, layoutArm } from '../junction/armGeometry';

export interface SignalHead {
  kind: 'car' | 'ped';
  /** index of the arm the light belongs to (cars: faces this arm's approaching traffic; peds: crossing over this arm) */
  arm: number;
  pos: THREE.Vector3;
  /** rotation about +y: the front (+z) of the asset points this way */
  yaw: number;
}

export interface SignalSetup {
  heads: SignalHead[];
  /** arms that take part in the signal plan (motor roads), in arm order */
  arms: number[];
  /** unit direction (xz) pointing away from the node for every arm */
  dirs: Array<{ x: number; z: number }>;
}

/** margin between the roadway edge and a pole, metres */
export const POLE_MARGIN_M = 0.7;
export const MIN_SIGNAL_ARMS = 3;

export function armDirs(j: JunctionRuntime): Array<{ x: number; z: number }> {
  return j.arms.map((a) => {
    const t = a.road.endCross(a.end).frame.tangent;
    const th = Math.hypot(t.x, t.z) || 1;
    const sgn = a.end === 'start' ? 1 : -1;
    return { x: (sgn * t.x) / th, z: (sgn * t.z) / th };
  });
}

/** Signals only exist at nodes with `control: 'signals'` and at least three motor-road arms; otherwise null. */
export function planSignalSetup(j: JunctionRuntime): SignalSetup | null {
  if (!j.patch || j.node.control !== 'signals') return null;
  const arms = j.arms.map((a, i) => (a.road.profile.rank >= 2 ? i : -1)).filter((i) => i >= 0);
  if (arms.length < MIN_SIGNAL_ARMS) return null;
  const controls = planJunction('signals', j.node.crosswalks ?? 'auto', j.arms.map((a) => a.road.profile));
  const heads: SignalHead[] = [];
  for (const i of arms) {
    const arm = j.arms[i];
    const layout = layoutArm(arm.road.profile, arm, controls[i]);
    const sampler = armSampler(arm);
    const { s: sEnd, into } = armEnd(arm);
    const at = (d: number): number => sEnd + into * d;
    // car head: beside the stop line, on the approach side, facing the approaching traffic (= away from the node)
    const c = sampler.point(at(layout.signalD), layout.approachSide * (layout.roadEdge + POLE_MARGIN_M));
    const away = { x: into * c.tangent.x, z: into * c.tangent.z };
    heads.push({ kind: 'car', arm: i, pos: c.pos, yaw: Math.atan2(away.x, away.z) });
    // pedestrian heads at both ends of the crossing, facing across the road
    const cw = layout.crosswalk;
    if (cw) {
      const dMid = (cw.d0 + cw.d1) / 2;
      for (const sign of [1, -1] as const) {
        const edge = sign === 1 ? cw.right : cw.left;
        const p = sampler.point(at(dMid), sign * (edge + POLE_MARGIN_M));
        heads.push({ kind: 'ped', arm: i, pos: p.pos, yaw: Math.atan2(-sign * p.right.x, -sign * p.right.z) });
      }
    }
  }
  return { heads, arms, dirs: armDirs(j) };
}
