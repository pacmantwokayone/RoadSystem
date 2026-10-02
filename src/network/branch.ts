// Branches: the way a lane leaves or joins a road in real life. No junction patch — the branch starts as a sliver at the edge of the main
// road (its cross-section scaled down to almost nothing), grows to full width, runs alongside as a lane of its own (the deceleration /
// acceleration lane), then swings away and continues as a road of its own. The same geometry serves motorway exits and entries, flyover
// ramps and track switches.
//
//   |<-- grow -->|<------ parallel ------>|<-------- taper -------->|
//   nose: width 0.1 → full width, adjacent   full width, adjacent      the gap opens up (quadratic) → tail
//
// For a switch (`taperStart: 0`) the width grows while the tracks already diverge.
//
// This is a generator over the main road's centre line. Stored in a document it is an `AttachDef` (see attach.ts) that is evaluated again
// whenever the main road changes. Coordinates are SIM space; heights follow the main road's authored heights.

import { Vector3 } from 'three';
import { PathCurve } from '../core/spline';
import { simToThree, threeToSim } from '../core/world';
import type { RoadDef, RoadMode, RoadPoint } from './types';

export interface BranchSpec {
  /** the road the branch leaves from / joins */
  main: Pick<RoadDef, 'points'>;
  /** arc length on the main road where the branch begins (the nose, zero width) */
  s: number;
  /** which side of the main road, seen along increasing arc length: 1 = right, -1 = left */
  side: 1 | -1;
  /** the head runs along increasing (1) or decreasing (-1) arc length from `s` */
  dir?: 1 | -1;
  /** distance of the branch's centre from the main centre line when they are adjacent: half width of the main road's carriageway + half width of the branch (for a track switch: the lateral offset of the track it leaves) */
  halfMain: number;
  halfBranch: number;
  /** length over which the branch grows from a sliver to full width, adjacent to the main road (default 50 m) */
  grow?: number;
  /** length of the full-width lane running alongside (default 0 — a ramp without a separate lane; a motorway exit uses ~100 m) */
  parallel?: number;
  /** length over which the gap opens (default 70 m) */
  taper?: number;
  /** distance between the carriageways at the end of the taper, metres (default 2) */
  gap?: number;
  /** where the gap starts to open, measured from the nose (default grow + parallel; 0 = at once, for track switches) */
  taperStart?: number;
  /** the branch after its head, in order AWAY from the main road */
  tail: RoadPoint[];
  /** the returned list runs towards the main road (the branch is something that merges) */
  merge?: boolean;
  /** station spacing along the head, metres (default 10) */
  step?: number;
  /** lower the branch by this much against the main road's height (a switch must not z-fight with the main track's bed) */
  dy?: number;
}

const smooth = (t: number): number => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };

/** length of the head along the main road */
export function headLength(spec: Pick<BranchSpec, 'grow' | 'parallel' | 'taper' | 'taperStart'>): number {
  const grow = spec.grow ?? 50, parallel = spec.parallel ?? 0, taper = spec.taper ?? 70;
  const start = spec.taperStart ?? grow + parallel;
  return Math.max(grow, start + taper);
}

/** Lateral offset (from the main centre line, + = towards the branch side) and width factor of the branch at distance `d` from the nose. */
export function branchProfileAt(spec: Pick<BranchSpec, 'halfMain' | 'halfBranch' | 'grow' | 'parallel' | 'taper' | 'gap' | 'taperStart'>, d: number): { offset: number; width: number } {
  const grow = spec.grow ?? 50, parallel = spec.parallel ?? 0, taper = spec.taper ?? 70, gap = spec.gap ?? 2;
  const start = spec.taperStart ?? grow + parallel;
  const w = grow > 0 ? Math.max(0.1, smooth(d / grow)) : 1;
  const u = taper > 0 ? Math.min(1, Math.max(0, (d - start) / taper)) : 1;
  return { offset: spec.halfMain + spec.halfBranch * w + gap * u * u, width: w };
}

/** the mode a branch head inherits from the main road at arc length s: bridge only where both neighbouring authored points are a bridge */
function inheritedMode(points: readonly RoadPoint[], pointS: readonly number[], s: number): { mode: RoadMode; fixed: boolean } {
  let k = 0;
  while (k < pointS.length - 2 && pointS[k + 1] <= s) k++;
  const a = points[k], b = points[Math.min(points.length - 1, k + 1)];
  const ma = a.mode ?? 'road', mb = b.mode ?? 'road';
  const mode: RoadMode = ma === mb && ma !== 'road' ? ma : ma === 'bridge' && mb === 'bridge' ? 'bridge' : 'road';
  const fixed = mode !== 'road' || ((a.elev === 'fixed' || ma !== 'road') && (b.elev === 'fixed' || mb !== 'road'));
  return { mode, fixed };
}

/** Points of the branch road from the main road outwards (or the reverse for a merge): the head, then `tail`. */
export function branchPoints(spec: BranchSpec): RoadPoint[] {
  const curve = new PathCurve(spec.main.points.map((p) => simToThree(p.x, p.y, p.z)));
  const dir = spec.dir ?? 1;
  const step = spec.step ?? 10;
  const L = headLength(spec);
  const n = Math.max(3, Math.round(L / step));
  const out: RoadPoint[] = [];
  const P = new Vector3();
  const dy = spec.dy ?? 0;
  for (let k = 0; k <= n; k++) {
    const d = (k / n) * L;
    const s = Math.min(curve.length, Math.max(0, spec.s + dir * d));
    curve.pointAt(s, P);
    const t = curve.tangentAt(s);
    t.y = 0;
    if (t.lengthSq() < 1e-12) t.set(1, 0, 0);
    t.normalize();
    const right = new Vector3(-t.z, 0, t.x);
    const { offset, width } = branchProfileAt(spec, d);
    const off = spec.side * offset;
    const sim = threeToSim(new Vector3(P.x + right.x * off, P.y + dy, P.z + right.z * off));
    const inh = inheritedMode(spec.main.points, curve.pointS, s);
    out.push({
      x: sim.x, y: sim.y, z: sim.z,
      ...(width < 0.999 ? { widthScale: Math.round(width * 1000) / 1000 } : {}),
      ...(inh.mode !== 'road' ? { mode: inh.mode } : inh.fixed ? { elev: 'fixed' as const } : {}),
    });
  }
  const pts = [...out, ...spec.tail];
  return spec.merge ? pts.reverse() : pts;
}

/** arc length (on the same curve the branch uses) of the point of the main road nearest to a SIM position */
export function arcLengthNear(main: Pick<RoadDef, 'points'>, x: number, z: number): number {
  const curve = new PathCurve(main.points.map((p) => simToThree(p.x, p.y, p.z)));
  const q = simToThree(x, 0, z);
  let best = 0, bd = Infinity;
  const P = new Vector3();
  const scan = (a: number, b: number, step: number): void => {
    for (let s = a; s <= b + 1e-9; s += step) {
      const c = Math.min(curve.length, Math.max(0, s));
      curve.pointAt(c, P);
      const d = Math.hypot(P.x - q.x, P.z - q.z);
      if (d < bd) { bd = d; best = c; }
    }
  };
  scan(0, curve.length, 2);
  scan(best - 2, best + 2, 0.1);
  return best;
}
