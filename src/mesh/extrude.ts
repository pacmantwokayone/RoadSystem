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
import { profileHeightAt } from '../profile/types';

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

/** How a profile is placed on the road at one sample: shared by the extrusion and the markings so both agree exactly. */
export interface RingSection {
  centre: THREE.Vector3;
  frame: ReturnType<RoadRuntime['designFrame']>;
  /** profile x → lateral position in metres (width scale, `vary`, inside-of-turn clamp) */
  mapX(xProfile: number): number;
  /** world position of the top surface at profile x */
  surface(xProfile: number, out?: THREE.Vector3): THREE.Vector3;
  /** world position at a lateral distance (metres, + = right) and height above the design line */
  at(lateral: number, y: number, out?: THREE.Vector3): THREE.Vector3;
}

export function ringSection(rt: RoadRuntime, i: number, innerCurveLimit = DEFAULT_EXTRUDE_OPTIONS.innerCurveLimit): RingSection {
  const profile = rt.profile;
  const sample = rt.samples[i];
  const frame = rt.designFrame(i);
  const cy = rt.designY[i];
  const vary = profile.vary?.({ s: sample.s, seed: rt.seed });
  const wMul = sample.widthScale * (vary?.widthMul ?? 1);
  const offX = vary?.offsetX ?? 0;
  const k = sample.curvature;
  const limit = Math.abs(k) > 1e-6 ? innerCurveLimit / Math.abs(k) : Infinity;
  const mapX = (xp: number): number => {
    let x = xp * wMul;
    const inner = (k > 0 && x < 0) || (k < 0 && x > 0);
    if (inner && Math.abs(x) > limit) x = Math.sign(x) * limit;
    return x + offX;
  };
  const centre = new THREE.Vector3(sample.pos.x, cy, sample.pos.z);
  return {
    centre, frame, mapX,
    surface(xp, out = new THREE.Vector3()) {
      return this.at(mapX(xp), profileHeightAt(profile, xp), out);
    },
    at(x, y, out = new THREE.Vector3()) {
      return out.set(
        centre.x + frame.right.x * x + frame.up.x * y,
        centre.y + frame.right.y * x + frame.up.y * y,
        centre.z + frame.right.z * x + frame.up.z * y,
      );
    },
  };
}

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
  // closed ends: the road body is capped where the road starts / ends (free end or junction patch)
  const capStart = chunk.i0 === 0;
  const capEnd = chunk.i1 === rt.samples.length - 1;
  const capVerts = ((capStart ? 1 : 0) + (capEnd ? 1 : 0)) * 2 * M;

  const pos = new Float32Array((total + capVerts) * 3);
  const nrm = new Float32Array((total + capVerts) * 3);
  const uv = new Float32Array((total + capVerts) * 2);
  const strip = new Float32Array((total + capVerts) * 3); // aStrip: (lateral from strip centre, strip half width, 0) — zero on walls / caps

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
  const bridgeRing: boolean[] = new Array(nRings).fill(false);
  const caps: Array<{ start: boolean; tops: THREE.Vector3[]; bottoms: THREE.Vector3[]; us: number[]; normal: THREE.Vector3 }> = [];
  for (let r = 0; r < nRings; r++) {
    const i = chunk.i0 + r;
    const sample = rt.samples[i];
    const frame = rt.designFrame(i);
    const cy = rt.designY[i];
    const vary = profile.vary?.({ s: sample.s, seed: rt.seed });
    const wMul = sample.widthScale * (vary?.widthMul ?? 1);
    const offX = vary?.offsetX ?? 0;
    const onBridge = sample.mode === 'bridge';
    bridgeRing[r] = onBridge;
    const pts = onBridge ? rt.bridgePoints() : profile.points;

    // cross-section x positions, with the inside of tight turns clamped (no self-overlap)
    const k = sample.curvature;
    const limit = Math.abs(k) > 1e-6 ? opts.innerCurveLimit / Math.abs(k) : Infinity;
    for (let m = 0; m < M; m++) {
      let x = pts[m].x * wMul;
      const inner = (k > 0 && x < 0) || (k < 0 && x > 0);
      if (inner && Math.abs(x) > limit) x = Math.sign(x) * limit;
      xs[m] = x + offX;
      tp[m].set(
        sample.pos.x + frame.right.x * xs[m] + frame.up.x * pts[m].y,
        cy + frame.right.y * xs[m] + frame.up.y * pts[m].y,
        sample.pos.z + frame.right.z * xs[m] + frame.up.z * pts[m].y,
      );
    }
    us[0] = 0;
    for (let m = 1; m < M; m++) {
      us[m] = us[m - 1] + Math.hypot(xs[m] - xs[m - 1], pts[m].y - pts[m - 1].y);
    }

    const base = r * V;
    // top segments
    for (let seg = 0; seg < S; seg++) {
      const dx = xs[seg + 1] - xs[seg];
      const dy = pts[seg + 1].y - pts[seg].y;
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
      const hw = Math.abs(dx) / 2; // vertical faces (kerbs) have none → no wheel tracks / edge dirt
      strip[(base + seg * 2) * 3] = -hw; strip[(base + seg * 2) * 3 + 1] = hw;
      strip[(base + seg * 2 + 1) * 3] = hw; strip[(base + seg * 2 + 1) * 3 + 1] = hw;
    }

    // side walls + bottom
    const horizR = tmpR.set(frame.right.x, 0, frame.right.z);
    if (horizR.lengthSq() < 1e-8) horizR.set(1, 0, 0);
    horizR.normalize();
    const bottomY = (top: THREE.Vector3, groundY: number): number => {
      // a bridge is a slab in the air: it is as thick as its deck, whatever lies below
      if (onBridge) return top.y - rt.bridge.deck.thickness;
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

    if ((r === 0 && capStart) || (r === nRings - 1 && capEnd)) {
      const span = xs[M - 1] - xs[0];
      caps.push({
        start: r === 0 && capStart,
        tops: tp.map((v) => v.clone()),
        bottoms: tp.map((v, m) => {
          const f = Math.abs(span) > 1e-9 ? (xs[m] - xs[0]) / span : m / (M - 1);
          return new THREE.Vector3(v.x, bL + (bR - bL) * f, v.z);
        }),
        us: Array.from(us),
        normal: frame.tangent.clone().multiplyScalar(r === 0 && capStart ? -1 : 1),
      });
    }
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
    const body = listFor(bridgeRing[r] && bridgeRing[r + 1] ? rt.bridge.deck.material : profile.bodyMaterial);
    const w = S * 2;
    quad(body, b0 + w, b0 + w + 1, b1 + w, b1 + w + 1);
    quad(body, b0 + w + 2, b0 + w + 3, b1 + w + 2, b1 + w + 3);
    quad(body, b0 + w + 4, b0 + w + 5, b1 + w + 4, b1 + w + 5);
  }

  // end caps (body material): a vertical face over the whole cross-section
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  caps.forEach((cap, ci) => {
    const base = total + ci * 2 * M;
    for (let m = 0; m < M; m++) {
      putV(base + 2 * m, cap.tops[m], cap.normal, cap.us[m], 0);
      putV(base + 2 * m + 1, cap.bottoms[m], cap.normal, cap.us[m], cap.tops[m].y - cap.bottoms[m].y);
    }
    const list = listFor(profile.bodyMaterial);
    for (let k = 0; k < S; k++) {
      const t0 = base + 2 * k, t1 = base + 2 * (k + 1), b0 = t0 + 1, b1 = t1 + 1;
      ab.subVectors(cap.tops[k + 1], cap.tops[k]);
      ac.subVectors(cap.bottoms[k], cap.tops[k]);
      const front = ab.cross(ac).dot(cap.normal) > 0;
      if (front) list.push(t0, t1, b0, t1, b1, b0);
      else list.push(t0, b0, t1, t1, b0, b1);
    }
  });

  const materials = [...byMat.keys()];
  const index = new Uint32Array([...byMat.values()].flat());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aStrip', new THREE.BufferAttribute(strip, 3));
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
