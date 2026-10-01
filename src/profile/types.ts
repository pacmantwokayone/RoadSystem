// Profile = a cross-section description, evaluated from code (see compile.ts).
// A profile is a polyline of TOP-surface points across the road (x lateral,
// + = right; y relative to the design height) with one segment record per
// consecutive point pair, plus a closed body underneath (thickness, walls).

import type { PropRule } from '../props/rules';

export interface ProfilePoint {
  x: number;
  y: number;
}

/** segment kinds that carry vehicles (what a junction patch has to cover) and the part of them with driving lanes */
export const ROADWAY_KINDS: ReadonlySet<string> = new Set(['lane', 'rut', 'parking', 'shoulder', 'median']);
export const LANE_KINDS: ReadonlySet<string> = new Set(['lane', 'rut']);

export interface ProfileSegment {
  material: string;
  /** free-form role: 'lane' | 'shoulder' | 'verge' | 'ditch' | 'curb' | 'path' … (queries, props, lane graph) */
  kind: string;
  id?: string;
  /** part of the carriageway footprint (what must never be buried by terrain) */
  core: boolean;
}

export type MarkingStyle = 'solid' | 'dashed' | 'double' | 'dashed-solid';
export type MarkingColor = 'white' | 'yellow';

/** A painted line along the road. `x` is the lateral position in profile space (+ = right). */
export interface MarkingDef {
  x: number;
  /** paint width, metres */
  width: number;
  style: MarkingStyle;
  color: MarkingColor;
  /** dash and gap length for dashed lines, metres */
  dash: number;
  gap: number;
  /** distance between the two lines of a double marking (centre to centre), metres */
  spacing: number;
  /** which line of a 'dashed-solid' pair is the dashed one */
  dashedSide: 'left' | 'right';
}

export interface VaryContext {
  /** arc length along the road, metres */
  s: number;
  /** stable per-road seed */
  seed: number;
}

export interface VaryResult {
  /** multiplies all lateral dimensions (1 = as designed) */
  widthMul?: number;
  /** shifts the whole cross-section sideways, metres (+ = right) */
  offsetX?: number;
}

export interface ProfileData {
  name: string;
  points: ProfilePoint[];
  /** segments.length === points.length - 1 */
  segments: ProfileSegment[];
  /** minimum depth of the body below the top surface, metres */
  thickness: number;
  bodyMaterial: string;
  /** painted lines (centre line, edge lines, …) */
  markings: MarkingDef[];
  /** things placed along the road (lamps, signs, guardrails …) */
  props: PropRule[];
  /** importance of the road in a junction (higher = has right of way); roads of equal rank give way to the right */
  rank: number;
  /** terrain-following smoothing radius for this profile, metres */
  smoothRadiusM?: number;
  /** half width of the carriageway footprint (segments with core = true) */
  coreHalfWidth: number;
  /** half width of what vehicles drive on (lanes, parking, shoulder): `coreHalfWidth` without kerbs and pavements; equals it for paths */
  carriageHalfWidth: number;
  /** half width of the whole cross-section */
  outerHalfWidth: number;
  vary?: (ctx: VaryContext) => VaryResult;
}

export type ParamType = 'int' | 'float' | 'bool' | 'enum';

export interface ParamDef {
  type: ParamType;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  default: number | boolean | string;
  options?: string[];
}

export type ParamSchema = Record<string, ParamDef>;
export type ParamValues = Record<string, number | boolean | string>;

/** Height of the profile's top surface at lateral x (piecewise linear; clamped to the outer points). */
export function profileHeightAt(profile: ProfileData, x: number): number {
  const pts = profile.points;
  if (x <= pts[0].x) return pts[0].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const dx = b.x - a.x;
      return dx > 1e-9 ? a.y + ((b.y - a.y) * (x - a.x)) / dx : Math.min(a.y, b.y);
    }
  }
  return pts[pts.length - 1].y;
}

/** Height at lateral x, taken from the inside (towards the axis) when x lies exactly on a vertical step such as a kerb —
 *  `profileHeightAt` picks whichever neighbouring segment comes first in x order, which differs between the two sides. */
export function profileHeightInside(profile: ProfileData, x: number): number {
  return profileHeightAt(profile, x - Math.sign(x) * 1e-4);
}
