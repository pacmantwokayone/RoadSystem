// Positions on a ready chunk at arbitrary arc length and lateral offset, built from the same ring
// sections as the road body and the markings — so props stand exactly on the surface they belong to.

import * as THREE from 'three';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import type { RoadMode } from '../network/types';
import { profileHeightAt } from '../profile/types';
import { ringSection, type RingSection } from '../mesh/extrude';

export interface SurfacePoint {
  /** world position (THREE space) */
  pos: THREE.Vector3;
  /** unit tangent of the road in the horizontal plane, pointing along increasing s */
  tangent: THREE.Vector3;
  /** unit vector to the road's right in the horizontal plane */
  right: THREE.Vector3;
  up: THREE.Vector3;
  curvature: number;
  widthScale: number;
  mode: RoadMode;
}

export class ChunkSampler {
  readonly sections: RingSection[] = [];
  readonly sMin: number;
  readonly sMax: number;
  private readonly sArr: number[] = [];

  constructor(readonly rt: RoadRuntime, readonly chunk: RoadChunk) {
    for (let i = chunk.i0; i <= chunk.i1; i++) {
      this.sections.push(ringSection(rt, i));
      this.sArr.push(rt.samples[i].s);
    }
    this.sMin = this.sArr[0];
    this.sMax = this.sArr[this.sArr.length - 1];
  }

  /** index of the ring at or before s (clamped so that r + 1 exists) */
  ringAt(s: number): number {
    const a = this.sArr;
    let lo = 0, hi = a.length - 2;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid] <= s) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  sampleIndex(r: number): number {
    return this.chunk.i0 + r;
  }

  /**
   * Point at arc length `s`, profile-space lateral `xp` (+ = right). `y` is the height above the design
   * line; default: the profile surface at xp. Beyond the profile's outer edge the surface is the terrain
   * when known (else the outer edge height).
   */
  point(s: number, xp: number, y?: number): SurfacePoint {
    const rt = this.rt;
    const r = this.ringAt(s);
    const r2 = Math.min(r + 1, this.sections.length - 1);
    const s0 = this.sArr[r], s1 = this.sArr[r2];
    const f = s1 > s0 ? Math.min(1, Math.max(0, (s - s0) / (s1 - s0))) : 0;
    const A = this.sections[r], B = this.sections[r2];
    const outside = Math.abs(xp) > rt.profile.outerHalfWidth;
    const yy = y ?? profileHeightAt(rt.profile, xp);
    const pa = A.at(A.mapX(xp), yy), pb = B.at(B.mapX(xp), yy);
    const pos = pa.lerp(pb, f);
    if (outside && y === undefined) {
      const g = rt.groundAtThree(pos.x, pos.z);
      if (g !== null) pos.y = g;
    }
    const sa = rt.samples[this.sampleIndex(r)], sb = rt.samples[this.sampleIndex(r2)];
    const tan = new THREE.Vector3().copy(sa.tangent).lerp(sb.tangent, f);
    tan.y = 0;
    if (tan.lengthSq() < 1e-12) tan.set(0, 0, -1);
    tan.normalize();
    const right = new THREE.Vector3(-tan.z, 0, tan.x); // tangent × worldUp, as in frames.ts
    const up = A.frame.up.clone().lerp(B.frame.up, f).normalize();
    return {
      pos, tangent: tan, right, up,
      curvature: sa.curvature + (sb.curvature - sa.curvature) * f,
      widthScale: sa.widthScale + (sb.widthScale - sa.widthScale) * f,
      mode: (f < 0.5 ? sa : sb).mode,
    };
  }
}
