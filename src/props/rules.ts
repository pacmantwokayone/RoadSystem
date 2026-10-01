// Prop rules: what a profile wants placed along its road (lamps, signs, guardrails, trees …).
// Rules are plain data + an optional `when(ctx)` predicate, written in profile code:
//
//   prof.guardrail('both', { variant: 'steel' })                       // auto: only where the terrain drops away
//   prof.lamps({ spacing: 35, side: 'left' })
//   prof.scatter('delineator', { spacing: 50, offset: 0.9 })
//   prof.scatter('sign:speed_50', { at: [20, -20], side: 'right' })    // negative = from the road's end
//
// Placement happens per chunk from ABSOLUTE arc length (so chunk borders never duplicate or drop a prop)
// with deterministic randomness (road seed + rule + index).

import type { RoadMode } from '../network/types';

export type PropSide = 'left' | 'right' | 'both';

/** Which way the prop's FRONT (+z of the asset) points.
 *  road: towards the road · traffic: towards oncoming traffic (road signs) · forward / backward: along ±tangent ·
 *  along: front along the tangent, so the long side is parallel to the road · random */
export type PropFacing = 'road' | 'traffic' | 'forward' | 'backward' | 'random';

export interface PropContext {
  /** arc length along the road, metres */
  s: number;
  /** running index of this placement within the rule */
  index: number;
  side: 'left' | 'right';
  /** signed horizontal curvature, 1/m (+ = left turn) */
  curvature: number;
  /** this side is the OUTSIDE of the bend */
  outer: boolean;
  /** deepest fall (metres) of the terrain below the road surface within 6 m beyond the prop; 0 when unknown */
  drop: number;
  mode: RoadMode;
  seed: number;
  /** deterministic random number in [0, 1) for this placement; `random(k)` gives further independent values */
  random(k?: number): number;
}

export interface ScatterRule {
  kind: 'scatter';
  /** asset name (registry); `sign:<id>[:<text>]` draws a road sign */
  asset: string;
  side: PropSide;
  /** metres outward from the carriageway edge (profile `core` width) */
  offset: number;
  spacing: number;
  /** explicit arc lengths instead of `spacing`; negative = measured from the end */
  at?: number[];
  /** arc length of the first prop (default: spacing / 2) */
  start: number;
  /** random shift along / across the road, metres (±) */
  jitterAlong: number;
  jitterLateral: number;
  face: PropFacing;
  /** random uniform scale in [min, max] */
  scale: [number, number];
  /** with side 'both': shift the left row by half a spacing */
  stagger: boolean;
  /** road modes the rule applies to (default: plain road) */
  modes: RoadMode[];
  when?: (ctx: PropContext) => boolean;
}

export type GuardrailVariant = 'steel' | 'concrete' | 'wood' | 'cable';

export interface GuardrailRule {
  kind: 'guardrail';
  side: PropSide;
  variant: GuardrailVariant;
  /** metres outward from the carriageway edge */
  offset: number;
  /** distance between posts, metres (variant default when 0) */
  postSpacing: number;
  /** auto rule: guard where the terrain falls at least this far below the road … */
  minDrop: number;
  /** … or this far on the outside of a bend tighter than `bendRadius` (lower threshold) */
  minDropBend: number;
  bendRadius: number;
  /** replaces the auto rule completely */
  when?: (ctx: PropContext) => boolean;
  /** shortest run worth building, metres */
  minRun: number;
  /** gaps shorter than this between two runs are bridged, metres */
  mergeGap: number;
  /** the rail starts this early / ends this late around the dangerous stretch, metres */
  pad: number;
  /** end the rail with a lowered terminal, metres long (0 = blunt end) */
  terminal: number;
  modes: RoadMode[];
}

export type PropRule = ScatterRule | GuardrailRule;

export type ScatterOpts = Partial<Omit<ScatterRule, 'kind' | 'asset'>>;
export type GuardrailOpts = Partial<Omit<GuardrailRule, 'kind' | 'side'>>;

export const SCATTER_DEFAULTS: Omit<ScatterRule, 'kind' | 'asset'> = {
  side: 'right', offset: 1.0, spacing: 50, start: Number.NaN, jitterAlong: 0, jitterLateral: 0,
  face: 'road', scale: [1, 1], stagger: false, modes: ['road'],
};

export const GUARDRAIL_DEFAULTS: Omit<GuardrailRule, 'kind' | 'side'> = {
  variant: 'steel', offset: 0.35, postSpacing: 0, minDrop: 1.8, minDropBend: 0.9, bendRadius: 180,
  minRun: 8, mergeGap: 14, pad: 8, terminal: 3.5, modes: ['road'],
};

export function makeScatter(asset: string, o: ScatterOpts = {}): ScatterRule {
  const r = { kind: 'scatter' as const, asset, ...SCATTER_DEFAULTS, ...o };
  if (!(r.spacing > 0) && !r.at) throw new Error(`scatter('${asset}'): spacing must be > 0`);
  if (!Number.isFinite(r.start)) r.start = r.spacing / 2;
  return r;
}

export function makeGuardrail(side: PropSide, o: GuardrailOpts = {}): GuardrailRule {
  return { kind: 'guardrail', side, ...GUARDRAIL_DEFAULTS, ...o };
}

export function sidesOf(side: PropSide): Array<'left' | 'right'> {
  return side === 'both' ? ['left', 'right'] : [side];
}

/** deterministic hash → [0, 1) */
export function hash01(a: number, b: number, c = 0, d = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39) ^ Math.imul(d + 0x1b873593, 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
