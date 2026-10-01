// River crossings: where a road crosses a river (a polyline in SIM space, like the game's `RiverDef`), propose a bridge —
// its extent along the road, its deck heights — and apply the proposal as ONE edit (new points at the two banks with
// mode 'bridge', the points in between converted).
//
// The river data is only read through the small `RiverLike` shape, so the module doesn't depend on the game's river code.

import type { RoadDef, RoadPoint } from '../network/types';
import type { TerrainSource } from '../core/terrain';
import { PathCurve } from '../core/spline';
import { sampleRoad } from '../core/sampling';
import { simToThree } from '../core/world';
import { pointAtS } from '../editor/pathTools';
import type { NetworkDraft } from '../editor/model';

export interface RiverLike {
  id: string;
  name?: string;
  /** centre line, SIM space (x, z) */
  points: Array<{ x: number; z: number }>;
  /** river width, metres (default 6) */
  width?: number;
}

export interface BridgeProposal {
  id: string;
  roadId: string;
  riverId: string;
  riverName?: string;
  /** arc length range of the bridge along the road, metres */
  s0: number;
  s1: number;
  /** deck height at both ends (SIM y) */
  y0: number;
  y1: number;
  /** where the road crosses the river's centre line */
  crossingS: number;
}

export interface SuggestOptions {
  /** extra bridge length beyond the river's banks on each side, metres */
  marginM: number;
  minLengthM: number;
  /** deck height above the highest terrain between the abutments, metres */
  clearanceM: number;
  /** crossings of the same river closer than this are one (a meander), metres */
  mergeM: number;
  /** road points closer than this to a bridge end are reused instead of adding a new point, metres */
  snapM: number;
}

export const DEFAULT_SUGGEST_OPTIONS: SuggestOptions = { marginM: 8, minLengthM: 14, clearanceM: 1.2, mergeM: 40, snapM: 3 };

const DEFAULT_RIVER_WIDTH_M = 6;
const SAMPLE_STEP_M = 2;

/** 2-D segment intersection (x, z): parameters along both segments, or null */
function intersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): { t: number; u: number } | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

function alreadyBridge(def: RoadDef, curve: PathCurve, s: number): boolean {
  const { seg } = curve.locate(s);
  return (def.points[seg].mode ?? 'road') === 'bridge' && (def.points[seg + 1].mode ?? 'road') === 'bridge';
}

export function suggestBridges(
  roads: readonly RoadDef[],
  rivers: readonly RiverLike[],
  terrain: TerrainSource | null,
  options: Partial<SuggestOptions> = {},
): BridgeProposal[] {
  const o = { ...DEFAULT_SUGGEST_OPTIONS, ...options };
  const out: BridgeProposal[] = [];
  for (const def of roads) {
    if (def.points.length < 2) continue;
    const curve = new PathCurve(def.points.map((p) => simToThree(p.x, p.y, p.z)));
    const L = curve.length;
    // the road as a polyline
    const pts: Array<{ s: number; x: number; z: number }> = [];
    for (let s = 0; s < L; s += SAMPLE_STEP_M) { const p = curve.pointAt(s); pts.push({ s, x: p.x, z: p.z }); }
    const end = curve.pointAt(L);
    pts.push({ s: L, x: end.x, z: end.z });

    for (const river of rivers) {
      if (river.points.length < 2) continue;
      const rp = river.points.map((p) => ({ x: p.x, z: -p.z })); // sim → three
      const crossings: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        for (let j = 0; j < rp.length - 1; j++) {
          const hit = intersect(pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z, rp[j].x, rp[j].z, rp[j + 1].x, rp[j + 1].z);
          if (hit) crossings.push(pts[i].s + (pts[i + 1].s - pts[i].s) * hit.t);
        }
      }
      crossings.sort((a, b) => a - b);
      // merge crossings that are really one (a meander, or a polyline vertex hit twice)
      const groups: Array<[number, number]> = [];
      for (const s of crossings) {
        const g = groups[groups.length - 1];
        if (g && s - g[1] < o.mergeM) g[1] = s; else groups.push([s, s]);
      }
      for (const [gs0, gs1] of groups) {
        const centre = (gs0 + gs1) / 2;
        if (alreadyBridge(def, curve, gs0) && alreadyBridge(def, curve, gs1)) continue;
        const half = Math.max((river.width ?? DEFAULT_RIVER_WIDTH_M) / 2 + o.marginM + (gs1 - gs0) / 2, o.minLengthM / 2);
        let s0 = Math.max(0, centre - half), s1 = Math.min(L, centre + half);
        if (s1 - s0 < 8) continue;
        // reuse existing points close to the ends
        for (const s of curve.pointS) {
          if (Math.abs(s - s0) <= o.snapM) s0 = s;
          if (Math.abs(s - s1) <= o.snapM) s1 = s;
        }
        // deck heights: the road's own height at the banks, lifted until the deck clears the terrain in between
        const groundAt = (s: number): number => {
          const p = curve.pointAt(s);
          const g = terrain?.heightAt(p.x, -p.z);
          return g ?? p.y;
        };
        let y0 = groundAt(s0), y1 = groundAt(s1);
        let lift = 0;
        for (let s = s0; s <= s1; s += SAMPLE_STEP_M) {
          const lin = y0 + (y1 - y0) * ((s - s0) / (s1 - s0));
          lift = Math.max(lift, groundAt(s) + o.clearanceM - lin);
        }
        y0 += lift; y1 += lift;
        out.push({
          id: `${def.id}:${river.id}:${Math.round(centre)}`, roadId: def.id, riverId: river.id, riverName: river.name,
          s0, s1, y0, y1, crossingS: centre,
        });
      }
    }
  }
  return out;
}

/** Turns the proposal into points: new bridge points at both ends (or the existing points nearby), everything between
 *  converted to mode 'bridge' with a straight deck height. Returns false if the road is gone. */
export function applyBridgeProposal(d: NetworkDraft, p: BridgeProposal): boolean {
  const road = d.road(p.roadId);
  if (!road) return false;
  const sampled = sampleRoad(road);
  const curve = sampled.curve;
  const s0 = Math.max(0, Math.min(p.s0, curve.length)), s1 = Math.max(s0, Math.min(p.s1, curve.length));
  const yAt = (s: number): number => p.y0 + (p.y1 - p.y0) * (s1 > s0 ? (s - s0) / (s1 - s0) : 0);
  const asBridge = (pt: RoadPoint, y: number): RoadPoint => ({ ...pt, y, mode: 'bridge', elev: 'fixed' });

  // existing points before / inside / after the bridge (those close to an end count as inside, snapped by the proposal)
  const before: number[] = [], inside: number[] = [], after: number[] = [];
  curve.pointS.forEach((s, k) => (s < s0 - 1e-6 ? before : s > s1 + 1e-6 ? after : inside).push(k));
  const startExists = inside.length > 0 && Math.abs(curve.pointS[inside[0]] - s0) < 1e-6;
  const endExists = inside.length > 0 && Math.abs(curve.pointS[inside[inside.length - 1]] - s1) < 1e-6;

  const pts = road.points;
  const next: RoadPoint[] = before.map((k) => pts[k]);
  if (!startExists) next.push(asBridge(pointAtS(road, sampled, s0).point, yAt(s0)));
  for (const k of inside) next.push(asBridge(pts[k], yAt(curve.pointS[k])));
  if (!endExists) next.push(asBridge(pointAtS(road, sampled, s1).point, yAt(s1)));
  for (const k of after) next.push(pts[k]);
  d.editRoad(p.roadId, (r) => { r.points = next.map((q) => ({ ...q })); });
  return true;
}

