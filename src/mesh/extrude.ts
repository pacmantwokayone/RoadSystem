// Extrudes a profile along a chunk of samples into a closed road body:
//   - one quad strip per profile segment (top surface, kerb faces, ditches …)
//   - left/right side walls and a bottom face (the body that gives the road
//     real thickness). The side walls reach down to the terrain beside the
//     road (capped), so a road on a slope never shows a gap under its edge.
// Vertices are duplicated per segment (hard edges between segments), normals
// are analytic (flat across a segment, smooth along the road), UVs are in
// metres: u = distance across the cross-section, v = arc length.
//
// Cross-section frame (three space): world = centre + right*x + up*y.
// A segment running a→b in cross-section has its outward normal at local
// (-dy, dx); quads are wound so that this normal faces the viewer.

import * as THREE from 'three';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { LAT } from '../runtime/roadRuntime';

export interface ExtrudeOptions {
  /** how far below the terrain beside the road the side walls reach, metres */
  wallMarginM: number;
  /** cap on side wall depth, metres */
  maxWallDepthM: number;
  /** keep cross-section points on the inside of a turn within this fraction of the curve radius */
  innerCurveLimit: number;
}

export const DEFAULT_EXTRUDE_OPTIONS: ExtrudeOptions = {
  wallMarginM: 0.35,
  maxWallDepthM: 30,
  innerCurveLimit: 0.85,
};

export interface ChunkGeometry {
  geometry: THREE.BufferGeometry;
  /** material name per geometry group's materialIndex */
  materials: string[];
}

export function buildChunkGeometry(
  rt: RoadRuntime,
  chunk: RoadChunk,
  opts: ExtrudeOptions = DEFAULT_EXTRUDE_OPTIONS,
): ChunkGeometry {
  const profile = rt.profile;
  const M = profile.points.length;
  const S = M - 1;
  const nRings = chunk.i1 - chunk.i0 + 1;
  const V = S * 2 + 6; // top: 2/segment; left wall 2; right wall 2; bottom 2
  const total = nRings * V;

  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  const tp = new Array<THREE.Vector3>(M); // top points of the current ring, world space
  for (let m = 0; m < M; m++) tp[m] = new THREE.Vector3();
  const xs = new Float64Array(M);
  const us = new Float64Array(M);
  const tmpN = new THREE.Vector3();
  const tmpR = new THREE.Vector3();

  const putV = (vi: number, p: THREE.Vector3, n: THREE.Vector3, u: number, v: number): void => {
    pos[vi * 3] = p.x; pos[vi * 3 + 1] = p.y; pos[vi * 3 + 2] = p.z;
    nrm[vi * 3] = n.x; nrm[vi * 3 + 1] = n.y; nrm[vi * 3 + 2] = n.z;
    uv[vi * 2] = u; uv[vi * 2 + 1] = v;
  };

  const wallBottom = new THREE.Vector3();
  for (let r = 0; r < nRings; r++) {
    const i = chunk.i0 + r;
    const sample = rt.samples[i];
    const frame = rt.designFrame(i);
    const cy = rt.designY[i];
    const vary = profile.vary?.({ s: sample.s, seed: rt.seed });
    const wMul = sample.widthScale * (vary?.widthMul ?? 1);
    const offX = vary?.offsetX ?? 0;

    // cross-section x positions, with the inside of tight turns clamped (no self-overlap)
    const k = sample.curvature;
    const limit = Math.abs(k) > 1e-6 ? opts.innerCurveLimit / Math.abs(k) : Infinity;
    for (let m = 0; m < M; m++) {
      let x = profile.points[m].x * wMul;
      const inner = (k > 0 && x < 0) || (k < 0 && x > 0);
      if (inner && Math.abs(x) > limit) x = Math.sign(x) * limit;
      xs[m] = x + offX;
      tp[m].set(
        sample.pos.x + frame.right.x * xs[m] + frame.up.x * profile.points[m].y,
        cy + frame.right.y * xs[m] + frame.up.y * profile.points[m].y,
        sample.pos.z + frame.right.z * xs[m] + frame.up.z * profile.points[m].y,
      );
    }
    us[0] = 0;
    for (let m = 1; m < M; m++) {
      us[m] = us[m - 1] + Math.hypot(xs[m] - xs[m - 1], profile.points[m].y - profile.points[m - 1].y);
    }

    const base = r * V;
    // top segments
    for (let seg = 0; seg < S; seg++) {
      const dx = xs[seg + 1] - xs[seg];
      const dy = profile.points[seg + 1].y - profile.points[seg].y;
      const len = Math.hypot(dx, dy);
      const nx = len > 1e-9 ? -dy / len : 0;
      const ny = len > 1e-9 ? dx / len : 1;
      tmpN.set(
        frame.right.x * nx + frame.up.x * ny,
        frame.right.y * nx + frame.up.y * ny,
        frame.right.z * nx + frame.up.z * ny,
      ).normalize();
      putV(base + seg * 2, tp[seg], tmpN, us[seg], sample.s);
      putV(base + seg * 2 + 1, tp[seg + 1], tmpN, us[seg + 1], sample.s);
    }

    // side walls + bottom
    const horizR = tmpR.set(frame.right.x, 0, frame.right.z);
    if (horizR.lengthSq() < 1e-8) horizR.set(1, 0, 0);
    horizR.normalize();
    const bottomY = (top: THREE.Vector3, groundY: number): number => {
      const byThickness = top.y - profile.thickness;
      const wanted = Number.isFinite(groundY) ? Math.min(byThickness, groundY - opts.wallMarginM) : byThickness;
      return Math.max(wanted, top.y - opts.maxWallDepthM);
    };
    const bL = bottomY(tp[0], rt.lat[LAT.OUTER_L][i]);
    const bR = bottomY(tp[M - 1], rt.lat[LAT.OUTER_R][i]);
    const left = tp[0];
    const right = tp[M - 1];
    const bw = base + S * 2;

    tmpN.copy(horizR).negate();
    putV(bw + 0, wallBottom.set(left.x, bL, left.z), tmpN, left.y - bL, sample.s); // left wall: bottom → top (faces left)
    putV(bw + 1, left, tmpN, 0, sample.s);
    tmpN.copy(horizR);
    putV(bw + 2, right, tmpN, 0, sample.s); // right wall: top → bottom (faces right)
    putV(bw + 3, wallBottom.set(right.x, bR, right.z), tmpN, right.y - bR, sample.s);
    tmpN.set(0, -1, 0);
    putV(bw + 4, wallBottom.set(right.x, bR, right.z), tmpN, 0, sample.s); // bottom: right → left (faces down)
    putV(bw + 5, wallBottom.set(left.x, bL, left.z), tmpN, us[M - 1], sample.s);
  }

  // indices grouped by material
  const byMat = new Map<string, number[]>();
  const listFor = (name: string): number[] => {
    let l = byMat.get(name);
    if (!l) { l = []; byMat.set(name, l); }
    return l;
  };
  const quad = (list: number[], a0: number, b0: number, a1: number, b1: number): void => {
    list.push(a0, b0, a1, b0, b1, a1);
  };
  for (let r = 0; r < nRings - 1; r++) {
    const b0 = r * V;
    const b1 = (r + 1) * V;
    for (let seg = 0; seg < S; seg++) {
      quad(listFor(profile.segments[seg].material), b0 + seg * 2, b0 + seg * 2 + 1, b1 + seg * 2, b1 + seg * 2 + 1);
    }
    const body = listFor(profile.bodyMaterial);
    const w = S * 2;
    quad(body, b0 + w, b0 + w + 1, b1 + w, b1 + w + 1);
    quad(body, b0 + w + 2, b0 + w + 3, b1 + w + 2, b1 + w + 3);
    quad(body, b0 + w + 4, b0 + w + 5, b1 + w + 4, b1 + w + 5);
  }

  const materials = [...byMat.keys()];
  const index = new Uint32Array([...byMat.values()].flat());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  let offset = 0;
  materials.forEach((name, mi) => {
    const count = byMat.get(name)!.length;
    geometry.addGroup(offset, count, mi);
    offset += count;
  });
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return { geometry, materials };
}
