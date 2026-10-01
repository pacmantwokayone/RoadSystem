// Cross-section frame along a path, in THREE space.
//   right — horizontal, = tangent × worldUp  (walking toward -z, right is +x)
//   up    — perpendicular to the road surface (right × tangent), rolled by banking
// Banking: positive = right edge lower (see RoadPoint.banking).

import { Vector3 } from 'three';

export interface Frame {
  tangent: Vector3;
  right: Vector3;
  up: Vector3;
}

const WORLD_UP = new Vector3(0, 1, 0);

export function makeFrame(tangent: Vector3, bankRad = 0): Frame {
  const t = tangent.clone().normalize();
  const right = new Vector3().crossVectors(t, WORLD_UP);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0); // vertical tangent: arbitrary but stable
  right.normalize();
  const up = new Vector3().crossVectors(right, t).normalize();
  if (bankRad !== 0) {
    const c = Math.cos(bankRad);
    const s = Math.sin(bankRad);
    const r2 = right.clone().multiplyScalar(c).addScaledVector(up, -s);
    const u2 = up.clone().multiplyScalar(c).addScaledVector(right, s);
    right.copy(r2);
    up.copy(u2);
  }
  return { tangent: t, right, up };
}

/** Signed horizontal curvature (1/m) from two nearby tangents `ds` apart.
 * Positive = turning left (toward -right), negative = turning right. */
export function horizontalCurvature(t1: Vector3, t2: Vector3, ds: number): number {
  if (ds <= 0) return 0;
  const yCross = t1.z * t2.x - t1.x * t2.z; // y component of t1 × t2
  return yCross / ds;
}
