// Hydrology of one river: where the water is, how high, how wide, how fast. Pure geometry — no terrain, no meshes.
//
//  • Levels. The authored level at every point is made MONOTONE (water never flows uphill) with a tiny minimum fall, clamped by
//    the lake it leaves / enters, and interpolated with a monotone cubic (no overshoot, so the level never rises between points).
//  • Falls. The segment after a point marked 'fall' is a free-falling sheet from the lip to the next point: ballistic curve
//    (leaves the lip horizontally, x ∝ √drop), widening as it falls.
//  • Everything is in THREE space (x, level, −z).

import { Vector3 } from 'three';
import { PathCurve } from '../core/spline';
import { simToThree } from '../core/world';
import type { WaterStyle } from './style';
import { segmentKind, type RiverDef, type SegmentKind } from './types';

/** minimum fall of the water level, metres per metre of river */
export const MIN_SLOPE = 0.0006;
/** a 'fall' lower than this is only rapids */
export const MIN_FALL_HEIGHT_M = 0.8;
const MIN_FALL_RUN_M = 0.6;
const GRAVITY = 9.81;

export interface RiverSample {
  index: number;
  /** arc length along the water path (falls count their 3-D length), metres */
  s: number;
  /** water surface point: x, level, z (THREE space) */
  pos: Vector3;
  /** unit direction of flow; horizontal on a river, 3-D on a fall */
  tangent: Vector3;
  /** horizontal unit vector to the right of the flow direction */
  right: Vector3;
  width: number;
  depth: number;
  level: number;
  /** level drop per metre of horizontal run (0 on a flat reach) */
  slope: number;
  kind: SegmentKind;
  /** surface speed, m/s */
  speed: number;
  /** 0..1 how churned the water is (style turbulence, steepness, rapids) */
  turbulence: number;
  /** authored segment and position within it */
  seg: number;
  t: number;
  /** falls: 0 at the lip … 1 at the foot */
  fallU: number;
}

export interface FallInfo {
  /** index of the lip point */
  point: number;
  lip: Vector3;
  foot: Vector3;
  height: number;
  /** horizontal distance lip → foot */
  run: number;
  width: number;
  /** first / last sample of the fall */
  i0: number;
  i1: number;
}

export interface RiverHydro {
  def: RiverDef;
  style: WaterStyle;
  /** per authored point: the level after the monotone / lake fixes */
  levels: number[];
  /** per authored point: the segment kind after degrading falls that are too small */
  kinds: SegmentKind[];
  samples: RiverSample[];
  falls: FallInfo[];
  length: number;
}

export interface HydroOptions {
  /** the lake this river leaves / enters: its level, SIM y */
  startLevel?: number;
  endLevel?: number;
  /** distance between samples on ordinary reaches, metres (default: from the width) */
  stepM?: number;
}

/** non-increasing levels with a minimum fall per metre of horizontal distance; optional clamps from lakes */
export function monotoneLevels(levels: readonly number[], dist: readonly number[], opts: HydroOptions = {}): number[] {
  const out = levels.slice();
  if (opts.startLevel !== undefined) out[0] = opts.startLevel;
  for (let k = 1; k < out.length; k++) out[k] = Math.min(out[k], out[k - 1] - MIN_SLOPE * dist[k - 1]);
  if (opts.endLevel !== undefined) for (let k = 0; k < out.length; k++) out[k] = Math.max(out[k], opts.endLevel);
  // the clamp can flatten the end; keep it non-increasing
  for (let k = 1; k < out.length; k++) out[k] = Math.min(out[k], out[k - 1]);
  return out;
}

/** Monotone cubic interpolation (Fritsch–Carlson): no overshoot, so monotone data stay monotone. */
export function pchip(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
      const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  // limit the end tangents (keeps monotone)
  for (const [i, j] of [[0, 0], [n - 1, n - 2]] as const) {
    if (d[j] === 0) m[i] = 0;
    else if (Math.sign(m[i]) !== Math.sign(d[j])) m[i] = 0;
    else if (Math.abs(m[i]) > 3 * Math.abs(d[j])) m[i] = 3 * d[j];
  }
  return (x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi];
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function computeRiverHydro(def: RiverDef, style: WaterStyle, opts: HydroOptions = {}): RiverHydro {
  const pts = def.points;
  const n = pts.length;
  const p3 = pts.map((p) => simToThree(p.x, 0, p.z));
  const curve = new PathCurve(p3);
  // horizontal distance between consecutive points (for the minimum fall)
  const dist: number[] = [];
  for (let k = 0; k < n - 1; k++) dist.push(Math.hypot(p3[k + 1].x - p3[k].x, p3[k + 1].z - p3[k].z));
  const levels = monotoneLevels(pts.map((p) => p.y), dist, opts);

  // falls that are too small are rapids; a fall needs a drop
  const kinds: SegmentKind[] = pts.map((_, k) => segmentKind(def, k));
  for (let k = 0; k < n - 1; k++) if (kinds[k] === 'fall' && levels[k] - levels[k + 1] < MIN_FALL_HEIGHT_M) kinds[k] = 'rapids';

  const widthAt = (seg: number, t: number): number => lerp(pts[seg].width ?? style.width, pts[seg + 1].width ?? style.width, t);
  const depthAt = (seg: number, t: number): number => lerp(pts[seg].depth ?? style.depth, pts[seg + 1].depth ?? style.depth, t);

  // monotone level interpolators for each run of ordinary / rapids segments (falls separate runs)
  const runOf: number[] = new Array(n - 1).fill(-1);
  const runs: Array<{ from: number; to: number; level: (s: number) => number }> = [];
  for (let k = 0; k < n - 1; ) {
    if (kinds[k] === 'fall') { k++; continue; }
    let e = k;
    while (e + 1 < n - 1 && kinds[e + 1] !== 'fall') e++;
    const xs = [curve.pointS[k]];
    const ys = [levels[k]];
    for (let q = k + 1; q <= e + 1; q++) { xs.push(curve.pointS[q]); ys.push(levels[q]); }
    runs.push({ from: k, to: e, level: pchip(xs, ys) });
    for (let q = k; q <= e; q++) runOf[q] = runs.length - 1;
    k = e + 1;
  }

  const samples: RiverSample[] = [];
  const falls: FallInfo[] = [];
  const baseStep = opts.stepM ?? clamp(style.width / 3, 1.5, 4);
  let sAcc = 0; // arc length including the extra length of falls
  const tmp = new Vector3();

  const push = (s: Partial<RiverSample> & Pick<RiverSample, 'pos' | 'tangent' | 'right' | 'width' | 'depth' | 'level' | 'kind' | 'seg' | 't'>): void => {
    samples.push({ index: samples.length, s: sAcc, slope: 0, speed: 0, turbulence: 0, fallU: 0, ...s });
  };

  for (let seg = 0; seg < n - 1; seg++) {
    const a = curve.pointS[seg], b = curve.pointS[seg + 1];
    const len = b - a;
    if (kinds[seg] === 'fall') {
      const lip = new Vector3(p3[seg].x, levels[seg], p3[seg].z);
      const foot = new Vector3(p3[seg + 1].x, levels[seg + 1], p3[seg + 1].z);
      const H = lip.y - foot.y;
      const hdir = new Vector3(foot.x - lip.x, 0, foot.z - lip.z);
      let run = hdir.length();
      if (run < MIN_FALL_RUN_M) {
        // vertical drop: face the way the river was heading
        curve.tangentAt(a, tmp); hdir.set(tmp.x, 0, tmp.z);
        if (hdir.lengthSq() < 1e-9) hdir.set(1, 0, 0);
        run = MIN_FALL_RUN_M;
      }
      hdir.normalize();
      const N = Math.round(clamp(H / 3, 8, 90));
      const i0 = samples.length;
      const wl = widthAt(seg, 0); // the sheet starts as wide as the river at the lip and only widens
      let prev: Vector3 | null = null;
      for (let i = 0; i <= N; i++) {
        const f = i / N;
        const dh = run * Math.sqrt(f);
        const pos = new Vector3(lip.x + hdir.x * dh, lip.y - H * f, lip.z + hdir.z * dh);
        if (prev) sAcc += pos.distanceTo(prev);
        prev = pos;
        // tangent of the ballistic curve x = run·q, y = −H·q² (q = √f): (run, −2·H·q) — horizontal at the lip, vertical at the bottom
        const q = Math.sqrt(f);
        const tangent = new Vector3(hdir.x * run, -2 * H * q, hdir.z * run).normalize();
        const right = new Vector3(-hdir.z, 0, hdir.x); // hdir × up
        push({
          pos, tangent, right, width: wl * (1 + style.fall.spread * f), depth: 0.4, level: pos.y,
          kind: 'fall', seg, t: f, fallU: f, slope: H / run, speed: Math.min(30, Math.sqrt(2 * GRAVITY * H * f) + style.flow.speed),
          turbulence: 1,
        });
      }
      falls.push({ point: seg, lip, foot, height: H, run, width: wl, i0, i1: samples.length - 1 });
      continue;
    }
    // ordinary reach / rapids: samples every ~baseStep, the first sample of the segment only if it isn't the previous one's end
    const run = runs[runOf[seg]];
    const count = Math.max(1, Math.round(len / (kinds[seg] === 'rapids' ? Math.min(baseStep, 1.2) : baseStep)));
    for (let i = seg === 0 || kinds[seg - 1] === 'fall' ? 0 : 1; i <= count; i++) {
      const t = i / count;
      const s = a + len * t;
      curve.pointAt(s, tmp);
      const level = run.level(s);
      const tan = curve.tangentAt(s);
      tan.y = 0;
      if (tan.lengthSq() < 1e-12) tan.set(1, 0, 0);
      tan.normalize();
      const right = new Vector3(-tan.z, 0, tan.x);
      const w = widthAt(seg, t), d = depthAt(seg, t);
      const pos = new Vector3(tmp.x, level, tmp.z);
      const last = samples[samples.length - 1];
      if (last) sAcc += last.kind === 'fall' ? pos.distanceTo(last.pos) : Math.hypot(pos.x - last.pos.x, pos.z - last.pos.z);
      push({ pos, tangent: tan, right, width: w, depth: d, level, kind: kinds[seg], seg, t });
    }
  }

  // slope, speed, turbulence from the neighbouring samples
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.kind === 'fall') continue;
    const a = samples[Math.max(0, i - 2)], b = samples[Math.min(samples.length - 1, i + 2)];
    const run = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
    s.slope = run > 1e-6 && a.kind !== 'fall' && b.kind !== 'fall' ? Math.max(0, (a.level - b.level) / run) : 0;
    const rapids = s.kind === 'rapids' ? 1 : 0;
    s.speed = clamp(style.flow.speed * (0.7 + 7 * Math.sqrt(s.slope)) * (1 + 0.8 * rapids), 0.1, 12);
    s.turbulence = clamp(style.flow.turbulence + 5 * s.slope + 0.55 * rapids, 0, 1);
  }

  return { def, style, levels, kinds, samples, falls, length: sAcc };
}

/** The sample whose arc length is closest to s (binary search). */
export function sampleIndexAt(h: RiverHydro, s: number): number {
  const a = h.samples;
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid].s <= s) lo = mid; else hi = mid; }
  return Math.abs(a[lo].s - s) <= Math.abs(a[hi].s - s) ? lo : hi;
}

/** Size of the plunge pool at the foot of a fall: wider and deeper the higher the water falls. */
export function poolDims(style: WaterStyle, f: Pick<FallInfo, 'width' | 'height' | 'run'>): { radius: number; depth: number } {
  // never so wide that it reaches back to the lip
  const radius = clamp(Math.max(5, f.width * style.fall.poolRadius, 1.5 * Math.sqrt(f.height)), 5, Math.max(5, Math.min(42, f.run * 0.5)));
  const depth = Math.max(style.fall.poolDepth, Math.min(14, 1 + f.height * 0.035));
  return { radius, depth };
}
