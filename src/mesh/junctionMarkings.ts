// Paint on the arms of a junction: zebra crossings, stop lines and the dashed give-way line. Built from the
// arms' end chunks (the same ring sections as the road body), lifted a few centimetres like all markings.

import * as THREE from 'three';
import type { JunctionRuntime } from '../runtime/junctionRuntime';
import { planJunction } from '../junction/controls';
import { armEnd, armSampler, layoutArm, ZEBRA } from '../junction/armGeometry';
import type { ChunkSampler } from '../props/sampler';
import { DEFAULT_MARKING_OPTIONS } from './markings';

export interface JunctionMarkings {
  geometry: THREE.BufferGeometry;
  materials: string[];
}

class Paint {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  /** A strip between lateral xA and xB (profile space), from arc length sA to sB (sA < sB), following the road surface. */
  rect(sampler: ChunkSampler, sA: number, sB: number, xA: number, xB: number, lift: number): void {
    const lo = sampler.sMin, hi = sampler.sMax;
    const a = Math.max(lo, sA), b = Math.min(hi, sB);
    if (b - a < 0.02 || xB - xA < 0.02) return;
    const ss = [a];
    for (let r = 0; r < sampler.sections.length; r++) {
      const s = sampler.rt.samples[sampler.sampleIndex(r)].s;
      if (s > a + 1e-6 && s < b - 1e-6) ss.push(s);
    }
    ss.push(b);
    const first = this.pos.length / 3;
    for (const s of ss) {
      const L = sampler.point(s, xA), R = sampler.point(s, xB);
      const n = L.up.clone().lerp(R.up, 0.5).normalize();
      this.pos.push(L.pos.x + n.x * lift, L.pos.y + n.y * lift, L.pos.z + n.z * lift, R.pos.x + n.x * lift, R.pos.y + n.y * lift, R.pos.z + n.z * lift);
      this.nrm.push(n.x, n.y, n.z, n.x, n.y, n.z);
      this.uv.push(0, s, xB - xA, s);
    }
    for (let k = 0; k < ss.length - 1; k++) {
      const a0 = first + k * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
      this.idx.push(a0, b0, a1, b0, b1, a1); // same winding as the road quads → faces up
    }
  }
}

export function buildJunctionMarkings(j: JunctionRuntime, lift = DEFAULT_MARKING_OPTIONS.liftM): JunctionMarkings | null {
  if (!j.patch) return null;
  const node = j.node;
  const controls = planJunction(node.control ?? 'auto', node.crosswalks ?? 'auto', j.arms.map((a) => a.road.profile));
  const paint = new Paint();
  j.arms.forEach((arm, i) => {
    const ctl = controls[i];
    const layout = layoutArm(arm.road.profile, arm, ctl);
    if (!layout.crosswalk && !layout.line) return;
    const sampler = armSampler(arm);
    const { s: sEnd, into } = armEnd(arm);
    // distance d from the end → arc length; a strip [d0, d1] becomes [sA, sB] with sA < sB
    const span = (d0: number, d1: number): [number, number] => (into === 1 ? [sEnd + d0, sEnd + d1] : [sEnd - d1, sEnd - d0]);

    const cw = layout.crosswalk;
    if (cw) {
      const total = cw.left + cw.right;
      const n = Math.max(1, Math.floor((total - ZEBRA.barM) / ZEBRA.pitchM) + 1);
      const start = -cw.left + (total - ((n - 1) * ZEBRA.pitchM + ZEBRA.barM)) / 2;
      const [sA, sB] = span(cw.d0, cw.d1);
      for (let k = 0; k < n; k++) paint.rect(sampler, sA, sB, start + k * ZEBRA.pitchM, start + k * ZEBRA.pitchM + ZEBRA.barM, lift);
    }
    const ln = layout.line;
    if (ln) {
      const [sA, sB] = span(ln.d0, ln.d1);
      // the approach side's lanes in profile space: [inner, outer] on the + or − side
      const x0 = layout.approachSide === 1 ? ln.inner : -ln.outer;
      const x1 = layout.approachSide === 1 ? ln.outer : -ln.inner;
      if (ln.kind === 'stop') paint.rect(sampler, sA, sB, x0, x1, lift);
      else for (let x = x0; x < x1 - 0.05; x += ZEBRA.waitDashM + ZEBRA.waitGapM) paint.rect(sampler, sA, sB, x, Math.min(x1, x + ZEBRA.waitDashM), lift);
    }
  });
  if (!paint.pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(paint.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(paint.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(paint.uv, 2));
  g.setAttribute('aStrip', new THREE.Float32BufferAttribute(new Array(paint.pos.length).fill(0), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(paint.idx), 1));
  g.addGroup(0, paint.idx.length, 0);
  g.computeBoundingSphere();
  return { geometry: g, materials: ['marking_white'] };
}
