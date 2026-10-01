// World conventions, mirrored from the game (see docs/PLAN.md §2b):
//   SIM space   — what is stored on disk and what TerrainSource speaks: (x, y, z)
//   THREE space — what meshes live in: (x, y, -z)
// Everything inside the module works in THREE space (right-handed math, so
// left/right and winding are unambiguous); sim space only appears at the
// boundary (persistence, terrain queries, editor input).

import { Vector3 } from 'three';

export function simToThree(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, y, -z);
}

export function threeToSim(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: -v.z };
}

/** The only axis that flips between the two spaces. */
export function flipZ(z: number): number {
  return -z;
}
