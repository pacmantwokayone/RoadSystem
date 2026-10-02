// Plausibility checks for a railway road: a train cannot take a tight curve or a steep grade. Nothing is changed — the editor shows the
// findings next to the road so they can be fixed (more room for the curve, a longer ramp).

import type { RoadRuntime } from '../runtime/roadRuntime';

export interface RailWarning {
  kind: 'radius' | 'grade';
  /** arc length where it is worst, metres */
  s: number;
  /** radius in metres, or the grade as a fraction */
  value: number;
  text: string;
}

/** tightest curve a mainline train takes comfortably (metres) and steepest grade (fraction) */
export const MIN_RAIL_RADIUS_M = 150;
export const MAX_RAIL_GRADE = 0.04;

export function railWarnings(rt: RoadRuntime): RailWarning[] {
  if (!rt.profile.rail) return [];
  const out: RailWarning[] = [];
  const S = rt.samples;
  // curves: the tightest stretch
  let worst = Infinity, worstS = 0;
  for (const s of S) {
    const k = Math.abs(s.curvature);
    if (k > 1e-6 && 1 / k < worst) { worst = 1 / k; worstS = s.s; }
  }
  if (worst < MIN_RAIL_RADIUS_M) out.push({ kind: 'radius', s: worstS, value: worst, text: `Kurve mit nur ${worst.toFixed(0)} m Radius bei ${worstS.toFixed(0)} m (Zug braucht mindestens ${MIN_RAIL_RADIUS_M} m)` });
  // grades over 60 m windows, from the built heights
  let steep = 0, steepS = 0;
  let j = 0;
  for (let i = 0; i < S.length; i++) {
    if (Number.isNaN(rt.designY[i])) continue;
    while (j < S.length - 1 && S[j + 1].s - S[i].s < 60) j++;
    if (j <= i || Number.isNaN(rt.designY[j])) continue;
    const run = S[j].s - S[i].s;
    if (run < 30) continue;
    const grade = Math.abs(rt.designY[j] - rt.designY[i]) / run;
    if (grade > steep) { steep = grade; steepS = (S[i].s + S[j].s) / 2; }
  }
  if (steep > MAX_RAIL_GRADE) out.push({ kind: 'grade', s: steepS, value: steep, text: `Steigung ${(steep * 100).toFixed(1)} % bei ${steepS.toFixed(0)} m (höchstens ${(MAX_RAIL_GRADE * 100).toFixed(0)} %)` });
  return out;
}
