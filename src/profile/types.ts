// Profile = a cross-section description, evaluated from code (see compile.ts).
// A profile is a polyline of TOP-surface points across the road (x lateral,
// + = right; y relative to the design height) with one segment record per
// consecutive point pair, plus a closed body underneath (thickness, walls).

export interface ProfilePoint {
  x: number;
  y: number;
}

export interface ProfileSegment {
  material: string;
  /** free-form role: 'lane' | 'shoulder' | 'verge' | 'ditch' | 'curb' | 'path' … (queries, props, lane graph) */
  kind: string;
  id?: string;
  /** part of the carriageway footprint (what must never be buried by terrain) */
  core: boolean;
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
  /** terrain-following smoothing radius for this profile, metres */
  smoothRadiusM?: number;
  /** half width of the carriageway footprint (segments with core = true) */
  coreHalfWidth: number;
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
