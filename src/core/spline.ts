// Centripetal Catmull-Rom through the authored points (the same curve family
// riverField.ts gets from THREE.CatmullRomCurve3), with an own arc-length table
// so that per-point attributes can be interpolated by (segment, t) and samples
// can be placed at exact arc lengths.

import { Vector3 } from 'three';

const ALPHA = 0.5; // centripetal
const SUBDIV = 24; // arc-length table resolution per segment
const EPS = 1e-4;

function knotDist(a: Vector3, b: Vector3): number {
  return Math.max(Math.pow(a.distanceTo(b), ALPHA), EPS);
}

/** Barry–Goldman evaluation of one centripetal Catmull-Rom segment (p1→p2). */
function evalSegment(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number, out: Vector3): Vector3 {
  const t0 = 0;
  const t1 = t0 + knotDist(p0, p1);
  const t2 = t1 + knotDist(p1, p2);
  const t3 = t2 + knotDist(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const lerp = (a: Vector3, b: Vector3, ta: number, tb: number, o: Vector3): Vector3 => {
    const k = (tt - ta) / (tb - ta);
    return o.copy(a).multiplyScalar(1 - k).addScaledVector(b, k);
  };
  const A1 = lerp(p0, p1, t0, t1, new Vector3());
  const A2 = lerp(p1, p2, t1, t2, new Vector3());
  const A3 = lerp(p2, p3, t2, t3, new Vector3());
  const B1 = lerp(A1, A2, t0, t2, new Vector3());
  const B2 = lerp(A2, A3, t1, t3, new Vector3());
  return lerp(B1, B2, t1, t2, out);
}

export interface CurveLocation {
  /** index of the segment [seg, seg+1] between authored points */
  seg: number;
  /** 0..1 within that segment (curve parameter, not arc length) */
  t: number;
}

export class PathCurve {
  readonly points: Vector3[];
  /** arc length at each authored point; last entry === length */
  readonly pointS: number[] = [];
  readonly length: number;
  private readonly ctrl: Vector3[];
  /** per segment: cumulative arc length at SUBDIV+1 parameter steps (starting at 0) */
  private readonly table: Float64Array[] = [];

  constructor(points: Vector3[]) {
    if (points.length < 2) throw new Error('PathCurve needs at least 2 points');
    this.points = points.map((p) => p.clone());
    const n = this.points.length;
    // reflect end points so the curve passes through them with a natural tangent
    const first = this.points[0].clone().multiplyScalar(2).sub(this.points[1]);
    const last = this.points[n - 1].clone().multiplyScalar(2).sub(this.points[n - 2]);
    this.ctrl = [first, ...this.points, last];

    let acc = 0;
    this.pointS.push(0);
    const tmpA = new Vector3();
    const tmpB = new Vector3();
    for (let seg = 0; seg < n - 1; seg++) {
      const tab = new Float64Array(SUBDIV + 1);
      this.segPoint(seg, 0, tmpA);
      for (let k = 1; k <= SUBDIV; k++) {
        this.segPoint(seg, k / SUBDIV, tmpB);
        acc += tmpA.distanceTo(tmpB);
        tab[k] = acc - this.pointS[seg];
        tmpA.copy(tmpB);
      }
      this.table.push(tab);
      this.pointS.push(acc);
    }
    this.length = acc;
  }

  private segPoint(seg: number, t: number, out: Vector3): Vector3 {
    const c = this.ctrl;
    return evalSegment(c[seg], c[seg + 1], c[seg + 2], c[seg + 3], t, out);
  }

  /** Arc length → (segment, t). Clamped to [0, length]. */
  locate(s: number): CurveLocation {
    const clamped = Math.min(Math.max(s, 0), this.length);
    // binary search the segment
    let lo = 0;
    let hi = this.points.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pointS[mid] <= clamped) lo = mid;
      else hi = mid - 1;
    }
    const seg = lo;
    const local = clamped - this.pointS[seg];
    const tab = this.table[seg];
    const segLen = tab[SUBDIV];
    if (segLen <= 0) return { seg, t: 0 };
    let k = 0;
    while (k < SUBDIV - 1 && tab[k + 1] < local) k++;
    const span = tab[k + 1] - tab[k];
    const f = span > 0 ? (local - tab[k]) / span : 0;
    return { seg, t: (k + f) / SUBDIV };
  }

  pointAt(s: number, out = new Vector3()): Vector3 {
    const { seg, t } = this.locate(s);
    return this.segPoint(seg, t, out);
  }

  /** Unit tangent at arc length s (numerical, robust at segment joints). */
  tangentAt(s: number, out = new Vector3()): Vector3 {
    const h = Math.min(0.5, this.length * 0.25);
    const a = this.pointAt(Math.max(0, s - h));
    const b = this.pointAt(Math.min(this.length, s + h));
    out.copy(b).sub(a);
    if (out.lengthSq() < 1e-12) out.set(0, 0, -1);
    return out.normalize();
  }
}
