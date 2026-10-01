// Turns a RoadDef into cross-section sample positions along its centreline:
// curvature-adaptive spacing, exact samples at every authored point (so
// bridge/tunnel mode boundaries land on a sample), per-point attributes
// interpolated by (segment, t).

import { Vector3 } from 'three';
import type { RoadDef, RoadMode } from '../network/types';
import { isFixedPoint } from '../network/types';
import { PathCurve } from './spline';
import { horizontalCurvature } from './frames';
import { simToThree } from './world';

export interface SampleOptions {
  /** Longest allowed gap between samples, metres. */
  maxStepM: number;
  /** Shortest gap (only matters in very tight curves), metres. */
  minStepM: number;
  /** Max tangent turn between two samples, radians. */
  maxTurnRad: number;
}

export const DEFAULT_SAMPLE_OPTIONS: SampleOptions = {
  maxStepM: 4,
  minStepM: 0.75,
  maxTurnRad: (4 * Math.PI) / 180,
};

export interface RoadSample {
  index: number;
  /** arc length from the road start, metres */
  s: number;
  /** centreline in THREE space; y = authored height interpolated (preview/fallback) */
  pos: Vector3;
  tangent: Vector3;
  /** signed horizontal curvature, 1/m (+ = left) */
  curvature: number;
  seg: number;
  t: number;
  widthScale: number;
  banking: number;
  mode: RoadMode;
  /** 0..1: how much the design height follows the authored y instead of the terrain */
  fixedWeight: number;
}

export interface SampledRoad {
  def: RoadDef;
  curve: PathCurve;
  samples: RoadSample[];
  /** index of the sample that sits exactly on authored point k */
  pointSample: number[];
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Metres cut off each end of the road (a junction patch takes over there). */
export interface Trim {
  start: number;
  end: number;
}

export const NO_TRIM: Trim = { start: 0, end: 0 };
const MIN_ROAD_LEN = 1;

export function sampleRoad(def: RoadDef, opts: SampleOptions = DEFAULT_SAMPLE_OPTIONS, trim: Trim = NO_TRIM): SampledRoad {
  const pts = def.points;
  const curve = new PathCurve(pts.map((p) => simToThree(p.x, p.y, p.z)));
  // never trim away the whole road
  const maxTrim = Math.max(0, curve.length - MIN_ROAD_LEN);
  const total = trim.start + trim.end;
  const k = total > maxTrim && total > 0 ? maxTrim / total : 1;
  const s0 = Math.max(0, trim.start * k);
  const s1 = curve.length - Math.max(0, trim.end * k);
  const forced = curve.pointS.filter((ps) => ps > s0 + 1e-6 && ps < s1 - 1e-6).concat([s1]);
  const delta = Math.min(1, curve.length * 0.25);

  const tangentTmp1 = new Vector3();
  const tangentTmp2 = new Vector3();
  const kappaAt = (s: number): number => {
    const a = Math.max(0, s - delta);
    const b = Math.min(curve.length, s + delta);
    if (b - a < 1e-6) return 0;
    curve.tangentAt(a, tangentTmp1);
    curve.tangentAt(b, tangentTmp2);
    return horizontalCurvature(tangentTmp1, tangentTmp2, b - a);
  };

  const ss: number[] = [s0];
  let s = s0;
  let nextForced = 0;
  while (s < s1 - 1e-6) {
    const k = Math.abs(kappaAt(s));
    let step = k > 1e-6 ? opts.maxTurnRad / k : opts.maxStepM;
    step = Math.min(opts.maxStepM, Math.max(opts.minStepM, step));
    let next = s + step;
    while (nextForced < forced.length && forced[nextForced] <= s + 1e-6) nextForced++;
    if (nextForced < forced.length && next > forced[nextForced] - 0.25 * opts.minStepM) {
      next = forced[nextForced]; // land exactly on the authored point
    }
    if (next > s1 - 0.25 * opts.minStepM) next = s1;
    ss.push(next);
    s = next;
  }

  const samples: RoadSample[] = ss.map((sv, index) => {
    const { seg, t } = curve.locate(sv);
    const a = pts[seg];
    const b = pts[seg + 1];
    const w = smooth(t);
    const pos = curve.pointAt(sv);
    const tangent = curve.tangentAt(sv);
    const modeA = a.mode ?? 'road';
    const modeB = b.mode ?? 'road';
    // a bridge/tunnel section runs exactly from its first point to its last (the abutments / portals stand ON those
    // points); a segment between a road point and a structure point is road; two different structure modes snap to the nearer end
    const mode: RoadMode =
      modeA === modeB ? modeA
        : t < 1e-9 ? modeA // exactly on a point: that point's own mode
        : t > 1 - 1e-9 ? modeB
        : modeA === 'road' || modeB === 'road' ? 'road'
        : t < 0.5 ? modeA : modeB;
    const fa = isFixedPoint(a) ? 1 : 0;
    const fb = isFixedPoint(b) ? 1 : 0;
    return {
      index,
      s: sv,
      pos,
      tangent,
      curvature: kappaAt(sv),
      seg,
      t,
      widthScale: (a.widthScale ?? 1) * (1 - w) + (b.widthScale ?? 1) * w,
      banking: (a.banking ?? 0) * (1 - w) + (b.banking ?? 0) * w,
      mode,
      fixedWeight: mode !== 'road' ? 1 : fa * (1 - w) + fb * w,
    };
  });
  const pointSample = curve.pointS.map((ps) => {
    let best = 0;
    for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i].s - ps) < Math.abs(samples[best].s - ps)) best = i;
    return best;
  });
  return { def, curve, samples, pointSample };
}
