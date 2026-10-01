// Turns a profile's prop rules into concrete placements for one ready chunk. Pure data — no meshes.
//
// Seam rules: scatter props are keyed to ABSOLUTE arc length and belong to the chunk whose half-open
// range [sMin, sMax) contains them (the last chunk also owns sMax), so neighbouring chunks never
// duplicate or drop a prop. Guardrail runs are decided per sample from the terrain right at that sample and the
// shared border sample is identical in both chunks, so a rail that crosses a chunk border simply continues.

import * as THREE from 'three';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { ChunkSampler, type SurfacePoint } from './sampler';
import { hash01, sidesOf, type GuardrailRule, type PropContext, type ScatterRule } from './rules';

export interface Placement {
  asset: string;
  /** base of the prop (THREE space) */
  pos: THREE.Vector3;
  /** rotation about +y so that the asset's +z (its front) points in the wanted direction */
  yaw: number;
  scale: number;
  /** index of the rule in profile.props */
  rule: number;
  s: number;
  side: 'left' | 'right';
}

export interface RailRun {
  rule: number;
  side: 'left' | 'right';
  variant: GuardrailRule['variant'];
  /** profile-space lateral position of the rail (+ = right) */
  xp: number;
  sA: number;
  sB: number;
  /** the rail really ends here (terminal / blunt end) instead of continuing into the next chunk */
  startFree: boolean;
  endFree: boolean;
  terminal: number;
  postSpacing: number;
}

export interface ChunkProps {
  placements: Placement[];
  rails: RailRun[];
  /** the sampler the placements were computed with (rails are extruded from it) */
  sampler: ChunkSampler | null;
}

export const POST_SPACING: Record<GuardrailRule['variant'], number> = { steel: 4, concrete: 0, wood: 2, cable: 3 };
export const POST_ASSET: Record<GuardrailRule['variant'], string | null> = {
  steel: 'post_steel', concrete: null, wood: 'post_wood', cable: 'post_cable',
};
/** how far behind the rail (away from the road) the posts stand, metres */
export const POST_SETBACK = 0.1;

/** lateral distances beyond a prop at which the terrain is probed for `ctx.drop`, metres */
export const DROP_PROBES_M = [2, 4, 6];

/** distance from a junction end within which no guardrail / scatter prop is placed, metres */
export const NODE_MARGIN_M = 6;

function faceDir(face: ScatterRule['face'], side: 'left' | 'right', p: SurfacePoint, rnd: number): { x: number; z: number } {
  const sg = side === 'right' ? 1 : -1;
  switch (face) {
    case 'road': return { x: -p.right.x * sg, z: -p.right.z * sg };
    case 'traffic': return { x: -p.tangent.x * sg, z: -p.tangent.z * sg };
    case 'forward': return { x: p.tangent.x, z: p.tangent.z };
    case 'backward': return { x: -p.tangent.x, z: -p.tangent.z };
    default: return { x: Math.sin(rnd * Math.PI * 2), z: Math.cos(rnd * Math.PI * 2) };
  }
}

function makeContext(
  rt: RoadRuntime, sampler: ChunkSampler, s: number, side: 'left' | 'right', xp: number, index: number, rule: number, p: SurfacePoint,
): PropContext {
  const sg = side === 'right' ? 1 : -1;
  let drop: number | undefined;
  const salt = rule * 7919;
  return {
    s, index, side, curvature: p.curvature,
    outer: p.curvature * sg > 0, // turning left (+) puts the right side on the outside
    get drop(): number {
      if (drop === undefined) {
        // the deepest fall within a few metres beyond the prop: a steep embankment starting at the edge counts
        // as much as a sheer drop, a ravine 20 m away does not
        let worst = 0;
        for (const d of DROP_PROBES_M) {
          const q = sampler.point(s, xp + sg * d, 0);
          const g = rt.groundAtThree(q.pos.x, q.pos.z);
          if (g !== null) worst = Math.max(worst, p.pos.y - g);
        }
        drop = worst;
      }
      return drop;
    },
    mode: p.mode,
    seed: rt.seed,
    random: (k = 0) => hash01(rt.seed, salt + k, index, s > 0 ? 1 : 0),
  };
}

function guard<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function placeChunk(rt: RoadRuntime, chunk: RoadChunk): ChunkProps {
  const out: ChunkProps = { placements: [], rails: [], sampler: null };
  const rules = rt.profile.props;
  if (!rules.length || chunk.state !== 'ready') return out;
  const sampler = new ChunkSampler(rt, chunk);
  out.sampler = sampler;
  rules.forEach((rule, ri) => {
    if (rule.kind === 'scatter') placeScatter(rt, chunk, sampler, rule, ri, out);
    else placeGuardrail(rt, chunk, sampler, rule, ri, out);
  });
  return out;
}

function placeScatter(rt: RoadRuntime, chunk: RoadChunk, sampler: ChunkSampler, rule: ScatterRule, ri: number, out: ChunkProps): void {
  const sFirst = rt.samples[0].s;
  const sLast = rt.samples[rt.samples.length - 1].s;
  const isLast = chunk.index === rt.chunks.length - 1;
  const { sMin, sMax } = sampler;
  const inRange = (s: number): boolean => s >= sMin && (s < sMax || (isLast && s <= sMax + 1e-9));
  const core = rt.profile.coreHalfWidth;

  for (const side of sidesOf(rule.side)) {
    const sg = side === 'right' ? 1 : -1;
    const positions: Array<{ s: number; k: number }> = [];
    if (rule.at) {
      rule.at.forEach((a, k) => positions.push({ s: a >= 0 ? sFirst + a : sLast + a, k }));
    } else {
      const phase = rule.start + (rule.stagger && side === 'left' ? rule.spacing / 2 : 0);
      const k0 = Math.max(0, Math.ceil((sMin - sFirst - phase) / rule.spacing - 1e-9));
      for (let k = k0; sFirst + phase + k * rule.spacing < sMax + 1e-9; k++) positions.push({ s: sFirst + phase + k * rule.spacing, k });
    }
    for (const { s: s0, k } of positions) {
      const sideSeed = side === 'right' ? 0 : 1;
      const rnd = (j: number): number => hash01(rt.seed, ri * 131 + j * 17 + sideSeed, k);
      const s = s0 + (rule.jitterAlong ? (rnd(1) * 2 - 1) * rule.jitterAlong : 0);
      if (!inRange(s0) || s < sMin || s > sMax) continue;
      if (!rule.at) {
        if (rt.trim.start > 0 && s < sFirst + NODE_MARGIN_M * 0.5) continue;
        if (rt.trim.end > 0 && s > sLast - NODE_MARGIN_M * 0.5) continue;
      }
      const lateral = sg * (core + rule.offset) + (rule.jitterLateral ? (rnd(2) * 2 - 1) * rule.jitterLateral : 0);
      const p = sampler.point(s, lateral);
      if (!rule.modes.includes(p.mode)) continue;
      if (rule.when) {
        const ctx = makeContext(rt, sampler, s, side, lateral, k, ri, p);
        if (!guard(() => rule.when!(ctx), false)) continue;
      }
      const d = faceDir(rule.face, side, p, rnd(3));
      const scale = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * rnd(4);
      out.placements.push({ asset: rule.asset, pos: p.pos, yaw: Math.atan2(d.x, d.z), scale, rule: ri, s, side });
    }
  }
}

function placeGuardrail(rt: RoadRuntime, chunk: RoadChunk, sampler: ChunkSampler, rule: GuardrailRule, ri: number, out: ChunkProps): void {
  const n = chunk.i1 - chunk.i0 + 1;
  const sFirst = rt.samples[0].s;
  const sLast = rt.samples[rt.samples.length - 1].s;
  const core = rt.profile.coreHalfWidth;
  const postSpacing = rule.postSpacing > 0 ? rule.postSpacing : POST_SPACING[rule.variant];

  for (const side of sidesOf(rule.side)) {
    const sg = side === 'right' ? 1 : -1;
    const xp = sg * (core + rule.offset);
    const sOf = (r: number): number => rt.samples[chunk.i0 + r].s;
    const cond: boolean[] = [];
    for (let r = 0; r < n; r++) {
      const s = sOf(r);
      const p = sampler.point(s, xp);
      let ok = rule.modes.includes(p.mode);
      if (ok) {
        const ctx = makeContext(rt, sampler, s, side, xp, r, ri, p);
        if (rule.when) ok = guard(() => rule.when!(ctx), false);
        else {
          const bend = Math.abs(p.curvature) * rule.bendRadius > 1;
          ok = ctx.drop >= rule.minDrop || (ctx.outer && bend && ctx.drop >= rule.minDropBend);
        }
      }
      // never next to a junction: the patch takes over there
      if (rt.trim.start > 0 && s < sFirst + NODE_MARGIN_M) ok = false;
      if (rt.trim.end > 0 && s > sLast - NODE_MARGIN_M) ok = false;
      cond.push(ok);
    }
    // runs → merge small gaps → drop short runs → pad
    let runs: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) {
      if (!cond[r]) continue;
      let e = r;
      while (e + 1 < n && cond[e + 1]) e++;
      runs.push([r, e]);
      r = e;
    }
    const merged: Array<[number, number]> = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last && sOf(run[0]) - sOf(last[1]) < rule.mergeGap) last[1] = run[1]; else merged.push([...run]);
    }
    runs = merged;
    for (const [a, b] of runs) {
      const touchesStart = a === 0, touchesEnd = b === n - 1;
      if (!touchesStart && !touchesEnd && sOf(b) - sOf(a) < rule.minRun) continue;
      let ra = a, rb = b;
      if (!touchesStart) while (ra > 1 && sOf(a) - sOf(ra - 1) <= rule.pad) ra--;
      if (!touchesEnd) while (rb < n - 2 && sOf(rb + 1) - sOf(b) <= rule.pad) rb++;
      const startFree = !(ra === 0 && chunk.index > 0);
      const endFree = !(rb === n - 1 && chunk.index < rt.chunks.length - 1);
      const run: RailRun = {
        rule: ri, side, variant: rule.variant, xp, sA: sOf(ra), sB: sOf(rb),
        startFree, endFree, terminal: rule.terminal, postSpacing,
      };
      out.rails.push(run);
      addPosts(sampler, run, ri, out);
    }
  }
}

function addPosts(sampler: ChunkSampler, run: RailRun, ri: number, out: ChunkProps): void {
  const asset = POST_ASSET[run.variant];
  if (!asset || run.postSpacing <= 0) return;
  const sg = run.side === 'right' ? 1 : -1;
  const ss: number[] = [];
  if (run.startFree) ss.push(run.sA);
  for (let k = Math.ceil(run.sA / run.postSpacing - 1e-9); k * run.postSpacing < run.sB - 1e-9; k++) {
    const s = k * run.postSpacing;
    if (s > run.sA + 0.3 || (!run.startFree && s >= run.sA)) ss.push(s);
  }
  if (run.endFree) ss.push(run.sB);
  for (const s of ss) {
    const p = sampler.point(s, run.xp + sg * POST_SETBACK);
    out.placements.push({ asset, pos: p.pos, yaw: Math.atan2(-p.right.x * sg, -p.right.z * sg), scale: 1, rule: ri, s, side: run.side });
  }
}
