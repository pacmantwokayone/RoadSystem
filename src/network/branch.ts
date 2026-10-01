// Branches: the way a lane leaves or joins a road in real life. No junction patch — the branch starts as a sliver at the edge of the main
// road (its cross-section scaled down to almost nothing), grows to full width over the taper while its centre line swings away, and
// continues as a road of its own. The same geometry serves motorway exits and entries, flyover ramps and track switches.
//
// This is a generator: it computes the branch's first points from the main road's centre line once (the branch does not follow the main
// road if that is edited later). Coordinates are SIM space; heights follow the main road's authored heights through the taper.

import { Vector3 } from 'three';
import { PathCurve } from '../core/spline';
import { simToThree, threeToSim } from '../core/world';
import type { RoadDef, RoadPoint } from './types';

export interface BranchSpec {
  /** the road the branch leaves from / joins */
  main: Pick<RoadDef, 'points'>;
  /** arc length on the main road where the taper STARTS (at zero width) */
  s: number;
  /** which side of the main road, seen along increasing arc length: 1 = right, -1 = left */
  side: 1 | -1;
  /** the taper runs along increasing (1) or decreasing (-1) arc length from `s` */
  dir?: 1 | -1;
  /** half width of the main road's carriageway and of the branch, metres */
  halfMain: number;
  halfBranch: number;
  /** length of the taper, metres (default 90) */
  taper?: number;
  /** extra separation that opens up at the end of the taper, metres (default 2) */
  gap?: number;
  /** the branch after its taper, in order AWAY from the main road */
  tail: RoadPoint[];
  /** the returned list runs towards the main road (the branch is something that merges) */
  merge?: boolean;
  /** station spacing along the taper, metres */
  step?: number;
}

const smooth = (t: number): number => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };

/** Points of the branch road from the main road outwards (or the reverse for a merge): the taper, then `tail`. */
export function branchPoints(spec: BranchSpec): RoadPoint[] {
  const curve = new PathCurve(spec.main.points.map((p) => simToThree(p.x, p.y, p.z)));
  const dir = spec.dir ?? 1;
  const taper = spec.taper ?? 90;
  const step = spec.step ?? 12;
  const gap = spec.gap ?? 2;
  const n = Math.max(2, Math.round(taper / step));
  const out: RoadPoint[] = [];
  const P = new Vector3();
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const s = Math.min(curve.length, Math.max(0, spec.s + dir * u * taper));
    curve.pointAt(s, P);
    const t = curve.tangentAt(s);
    t.y = 0;
    if (t.lengthSq() < 1e-12) t.set(1, 0, 0);
    t.normalize();
    const right = new Vector3(-t.z, 0, t.x);
    const w = Math.max(0.1, smooth(u));
    const off = spec.side * (spec.halfMain + spec.halfBranch * w + gap * u * u);
    const sim = threeToSim(new Vector3(P.x + right.x * off, P.y, P.z + right.z * off));
    out.push({ x: sim.x, y: sim.y, z: sim.z, ...(w < 0.999 ? { widthScale: Math.round(w * 1000) / 1000 } : {}) });
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
  for (let s = 0; s <= curve.length; s += 2) {
    curve.pointAt(s, P);
    const d = Math.hypot(P.x - q.x, P.z - q.z);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
