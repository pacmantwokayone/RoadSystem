// Signs at junctions, from the topology (see junction/controls.ts): right-of-way signs on the arms,
// and the pedestrian-crossing sign at zebra crossings. They stand on the right-hand edge as seen by traffic
// approaching the node, facing that traffic.

import * as THREE from 'three';
import type { JunctionRuntime } from '../runtime/junctionRuntime';
import { profileHeightAt } from '../profile/types';
import { DEFAULT_CONTROL_OPTIONS, planJunction, signKinds, type ControlOptions, type SignKind } from '../junction/controls';
import { layoutArm, ZEBRA } from '../junction/armGeometry';
import type { Placement } from './place';

export interface JunctionSignOptions extends ControlOptions {
  /** distance from the arm's end to the right-of-way sign, metres */
  setbackM: number;
  /** extra distance beyond the roadway edge, metres */
  edgeGapM: number;
}

export const DEFAULT_JUNCTION_SIGNS: JunctionSignOptions = { ...DEFAULT_CONTROL_OPTIONS, setbackM: 3.5, edgeGapM: 1.3 };

export type JunctionSignKind = SignKind;

/** which sign each arm gets with automatic control (null = none) — pure topology */
export function junctionSignKinds(ranks: readonly number[], opts: Partial<JunctionSignOptions> = {}): Array<JunctionSignKind | null> {
  return signKinds('auto', ranks, { ...DEFAULT_CONTROL_OPTIONS, ...opts });
}

export function placeJunctionSigns(j: JunctionRuntime, opts: JunctionSignOptions = DEFAULT_JUNCTION_SIGNS): Placement[] {
  if (!j.patch) return [];
  const node = j.node;
  const profiles = j.arms.map((a) => a.road.profile);
  const controls = planJunction(node.control ?? 'auto', node.crosswalks ?? 'auto', profiles, opts);
  const out: Placement[] = [];
  j.arms.forEach((arm, i) => {
    const ctl = controls[i];
    const crosswalkSign = ctl.crosswalk && node.control !== 'signals';
    if (!ctl.sign && !crosswalkSign) return;
    const c = arm.road.endCross(arm.end);
    const t = c.frame.tangent;
    const th = Math.hypot(t.x, t.z) || 1;
    const sgn = arm.end === 'start' ? 1 : -1;
    const dir = { x: (sgn * t.x) / th, z: (sgn * t.z) / th }; // away from the node, along the road
    // right-hand side as seen by traffic driving towards the node (direction −dir): right(−dir) = (dir.z, −dir.x)
    const rx = dir.z, rz = -dir.x;
    const profile = arm.road.profile;
    const lateral = Math.min(profile.outerHalfWidth * c.widthScale, c.halfCore + opts.edgeGapM);
    const layout = layoutArm(profile, arm, ctl);
    // arm-right is road-right for the 'end' end (traffic goes along +t), road-left for 'start'
    const xp = layout.approachSide * (lateral / c.widthScale);
    const y = c.pos.y + profileHeightAt(profile, xp);
    const place = (asset: string, d: number): void => {
      out.push({
        asset: `sign:${asset}`,
        pos: new THREE.Vector3(c.pos.x + dir.x * d + rx * lateral, y, c.pos.z + dir.z * d + rz * lateral),
        yaw: Math.atan2(dir.x, dir.z),
        scale: 1, rule: -1, s: 0, side: 'right',
      });
    };
    if (ctl.sign) place(ctl.sign, opts.setbackM);
    if (crosswalkSign) place('fussgaengerstreifen', ZEBRA.startM + ZEBRA.depthM / 2 + (ctl.sign ? 3.2 : 0));
  });
  return out;
}
