// Geometry of a tunnel, per road chunk: the lining (the inside of the tube, with light strips along the ceiling) and the portals. The tube
// itself is invisible from outside (it lies inside the hill); what you see is the headwall in the cutting: a concrete face between the
// carved floor and the original hillside with the arched mouth cut out, plus the lining reaching a little way out of it.

import * as THREE from 'three';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { ChunkSampler } from '../props/sampler';
import { GeometryBatch } from '../props/batch';
import { loft, type Raw } from '../structures/primitives';
import { tunnelDims, tunnelSections, type TunnelSection } from './sections';

export interface TunnelBuild {
  batch: GeometryBatch;
  /** false when terrain for a portal wasn't known yet — the layer retries */
  complete: boolean;
}

const FRONT_OFFSET_M = 1.6; // the face stands this far in front of the section end (outside the cutting's step)
const THICK_M = 3.4;
const COPING_M = 0.8;
const COLUMN_M = 0.75;
const WALL_REACH_M = 46;
const ARCH_STEPS = 12;
const FLOOR_EMBED = -0.35;
/** a hillside counts as cut where it was dug at least this deep (natural slopes over the wall's thickness are shallower) */
const MIN_CUT_M = 2.2;

class Ctx {
  complete = true;
  readonly batch = new GeometryBatch();
  readonly isLast: boolean;

  constructor(readonly rt: RoadRuntime, readonly chunk: RoadChunk, readonly sampler: ChunkSampler) {
    this.isLast = chunk.index === rt.chunks.length - 1;
  }

  owns(s: number): boolean {
    return s >= this.sampler.sMin && (s < this.sampler.sMax || (this.isLast && s <= this.sampler.sMax + 1e-9));
  }

  P(s: number, xp: number, y: number): THREE.Vector3 {
    return this.sampler.point(s, xp, y).pos;
  }

  stations(a: number, b: number): number[] {
    const set = new Set<number>([a, b]);
    for (let r = 0; r < this.sampler.sections.length; r++) {
      const s = this.rt.samples[this.sampler.sampleIndex(r)].s;
      if (s > a + 1e-6 && s < b - 1e-6) set.add(s);
    }
    return [...set].sort((x, y) => x - y);
  }

  ground(x: number, z: number): number | null {
    const g = this.rt.groundAtThree(x, z);
    if (g === null) this.complete = false;
    return g;
  }
}

/** the inside of the tube as a closed ring in (lateral, height-above-road) */
function archRing(halfW: number, wall: number, rise: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [[-halfW, FLOOR_EMBED], [-halfW, wall]];
  for (let k = 1; k < ARCH_STEPS; k++) {
    const th = (k / ARCH_STEPS) * Math.PI;
    pts.push([-halfW * Math.cos(th), wall + rise * Math.sin(th)]);
  }
  pts.push([halfW, wall], [halfW, FLOOR_EMBED]);
  return pts;
}

function lining(c: Ctx, a: number, b: number, capStart: boolean, capEnd: boolean): void {
  const d = tunnelDims(c.rt);
  const ring = archRing(d.halfW, d.wall, d.rise);
  const st = c.stations(a, b);
  loft(c.batch.addRaw('tunnel_lining'), st.map((s) => ring.map(([x, y]) => c.P(s, x, y))), { inward: true, capStart: false, capEnd: false });
  // light strips either side of the crown
  const lx = d.halfW * 0.42, ly = d.wall + d.rise * Math.sqrt(1 - 0.42 * 0.42) - 0.04;
  const raw = c.batch.addRaw('tunnel_light');
  for (const side of [-1, 1]) {
    const x = side * lx;
    loft(raw, st.map((s) => [c.P(s, x - 0.2, ly), c.P(s, x + 0.2, ly), c.P(s, x + 0.2, ly + 0.07), c.P(s, x - 0.2, ly + 0.07)]), { capStart: false, capEnd: false });
  }
  void capStart; void capEnd;
}

function portal(c: Ctx, sec: TunnelSection, atStart: boolean): void {
  const rt = c.rt;
  const d = tunnelDims(rt);
  const s = atStart ? sec.s0 : sec.s1;
  const dirSign = atStart ? -1 : 1; // direction out of the tunnel along s
  const smp = c.sampler.point(s, 0, 0);
  const out = new THREE.Vector3(smp.tangent.x * dirSign, 0, smp.tangent.z * dirSign).normalize();
  const right = new THREE.Vector3(smp.right.x, 0, smp.right.z); // across the road (horizontal)
  const origin = smp.pos.clone();
  const roadY = origin.y;
  const front = origin.clone().addScaledVector(out, FRONT_OFFSET_M);

  // the lining reaches out through the headwall
  const reach = FRONT_OFFSET_M;
  const sa = atStart ? Math.max(c.sampler.sMin, s - reach) : s, sb = atStart ? s : Math.min(c.sampler.sMax, s + reach);
  if (sb - sa > 0.05) lining(c, sa, sb, false, false);

  // columns across the face: bottom = the carved floor in front, top = the original hillside behind
  const vs: number[] = [];
  for (let v = -WALL_REACH_M; v <= WALL_REACH_M + 1e-6; v += COLUMN_M) vs.push(v);
  vs.push(-d.halfW, d.halfW);
  vs.sort((x, y) => x - y);
  const uniq = vs.filter((v, i) => i === 0 || Math.abs(v - vs[i - 1]) > 1e-6);
  const bottom: number[] = [], top: number[] = [];
  for (const v of uniq) {
    const lat = right.clone().multiplyScalar(v);
    const fx = origin.clone().addScaledVector(out, FRONT_OFFSET_M + 1.2).add(lat);
    const bx = origin.clone().addScaledVector(out, -0.4).add(lat);
    const gb = c.ground(fx.x, fx.z), gt = c.ground(bx.x, bx.z);
    bottom.push(gb ?? roadY);
    top.push((gt ?? roadY) + COPING_M);
  }
  // the headwall exists only where the hillside was really cut: walk out from the middle until the cut is gone
  const mid = uniq.findIndex((v) => v >= 0);
  const cutDepth = (i: number): number => top[i] - COPING_M - bottom[i];
  let lo = mid, hi = mid;
  while (lo > 0 && cutDepth(lo - 1) > MIN_CUT_M) lo--;
  while (hi < uniq.length - 1 && cutDepth(hi + 1) > MIN_CUT_M) hi++;
  const raw: Raw = c.batch.addRaw('portal_concrete');
  const v3 = (v: number, y: number, off: number): THREE.Vector3 => origin.clone().addScaledVector(out, off).addScaledVector(right, v).setY(y);
  const tri = (a: THREE.Vector3, b: THREE.Vector3, cc: THREE.Vector3, n: THREE.Vector3): void => {
    const ng = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(cc, a));
    const ia = raw.vertex(a, n, a.x, a.y), ib = raw.vertex(b, n, b.x, b.y), ic = raw.vertex(cc, n, cc.x, cc.y);
    if (ng.dot(n) >= 0) raw.tri(ia, ib, ic); else raw.tri(ia, ic, ib);
  };
  const archTop = (v: number): number => roadY + d.wall + d.rise * Math.sqrt(Math.max(0, 1 - (v / d.halfW) ** 2));
  for (let i = lo; i < hi; i++) {
    const v0 = uniq[i], v1 = uniq[i + 1];
    const inside = Math.abs(v0 + v1) / 2 < d.halfW;
    let l0 = bottom[i], l1 = bottom[i + 1];
    if (inside) { l0 = Math.max(l0, archTop(v0)); l1 = Math.max(l1, archTop(v1)); }
    const t0 = Math.max(top[i], l0), t1 = Math.max(top[i + 1], l1);
    if (t0 - l0 < 0.02 && t1 - l1 < 0.02) continue;
    // face
    const a = v3(v0, l0, FRONT_OFFSET_M), b = v3(v1, l1, FRONT_OFFSET_M), cc = v3(v1, t1, FRONT_OFFSET_M), dd = v3(v0, t0, FRONT_OFFSET_M);
    tri(a, b, cc, out); tri(a, cc, dd, out);
    // coping on top, from the face back into the hill
    const a2 = v3(v0, t0, FRONT_OFFSET_M), b2 = v3(v1, t1, FRONT_OFFSET_M), c2 = v3(v1, t1, FRONT_OFFSET_M - THICK_M), d2 = v3(v0, t0, FRONT_OFFSET_M - THICK_M);
    tri(a2, b2, c2, new THREE.Vector3(0, 1, 0)); tri(a2, c2, d2, new THREE.Vector3(0, 1, 0));
    // the underside of the lintel above the opening reaches back so the mouth has depth
    if (inside) {
      const u0 = v3(v0, l0, FRONT_OFFSET_M), u1 = v3(v1, l1, FRONT_OFFSET_M), u2 = v3(v1, l1, FRONT_OFFSET_M - THICK_M), u3 = v3(v0, l0, FRONT_OFFSET_M - THICK_M);
      tri(u0, u1, u2, new THREE.Vector3(0, -1, 0)); tri(u0, u2, u3, new THREE.Vector3(0, -1, 0));
    }
  }
  // the two ends of the face stand free for a moment: close them
  for (const side of [lo, hi]) {
    if (top[side] - bottom[side] < 0.05) continue;
    const v = uniq[side];
    const a = v3(v, bottom[side], FRONT_OFFSET_M), b = v3(v, top[side], FRONT_OFFSET_M), cc = v3(v, top[side], FRONT_OFFSET_M - THICK_M), dd = v3(v, bottom[side], FRONT_OFFSET_M - THICK_M);
    const n = right.clone().multiplyScalar(side === lo ? -1 : 1);
    tri(a, b, cc, n); tri(a, cc, dd, n);
  }
  void front;
}

export function buildChunkTunnel(rt: RoadRuntime, chunk: RoadChunk): TunnelBuild | null {
  if (chunk.state !== 'ready') return null;
  const sMin = rt.samples[chunk.i0].s, sMax = rt.samples[chunk.i1].s;
  const sections = tunnelSections(rt).filter((s) => s.s1 >= sMin - 4 && s.s0 <= sMax + 4);
  if (!sections.length) return null;
  const sampler = new ChunkSampler(rt, chunk);
  const c = new Ctx(rt, chunk, sampler);
  let any = false;
  for (const sec of sections) {
    const a = Math.max(sec.s0, c.sampler.sMin), b = Math.min(sec.s1, c.sampler.sMax);
    if (b - a > 0.05) { lining(c, a, b, false, false); any = true; }
    if (sec.portalStart && c.owns(sec.s0)) { portal(c, sec, true); any = true; }
    if (sec.portalEnd && c.owns(sec.s1)) { portal(c, sec, false); any = true; }
  }
  return any ? { batch: c.batch, complete: c.complete } : null;
}
