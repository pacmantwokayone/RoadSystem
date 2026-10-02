// Attached roads: a road whose first points (`attach`) and/or last points (`attachEnd`) are not authored but computed from another road —
// a motorway exit with its deceleration lane, a flyover ramp, a track switch. The attachment is data (`RoadDef.attach`): which road, where,
// which side, the lane/taper lengths. `resolveAttachments` evaluates it, so the branch follows its parent when that is edited; the points
// between the heads stay authored. Identity is preserved when nothing changes (the runtime diffs by identity).
//
// The nose position is stored as a SIM point and projected onto the parent every time, so it keeps its place in the world when points
// are inserted into or removed from the parent (an arc length would slide).

import { PathCurve } from '../core/spline';
import { simToThree } from '../core/world';
import { arcLengthNear, branchPoints, headLength } from './branch';
import type { AttachDef, RoadDef, RoadPoint } from './types';

const same = (a: RoadPoint, b: RoadPoint): boolean =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6 &&
  (a.widthScale ?? 1) === (b.widthScale ?? 1) && (a.mode ?? 'road') === (b.mode ?? 'road') && (a.elev ?? 'drape') === (b.elev ?? 'drape');

/** The head of an attached road, as computed from its resolved parent. For `merge` the points run towards the parent. */
export function attachHead(parent: Pick<RoadDef, 'points'>, a: AttachDef, merge: boolean): { points: RoadPoint[]; s: number; at: { x: number; z: number }; len: number } {
  const s = arcLengthNear(parent, a.at.x, a.at.z);
  const points = branchPoints({
    main: parent, s, side: a.side, dir: a.dir, halfMain: a.halfMain, halfBranch: a.halfBranch,
    grow: a.grow, parallel: a.parallel, taper: a.taper, gap: a.gap, taperStart: a.taperStart, dy: a.dy, tail: [], merge,
  });
  const curve = new PathCurve(parent.points.map((p) => simToThree(p.x, p.y, p.z)));
  const q = curve.pointAt(s);
  return { points, s, at: { x: q.x, z: -q.z }, len: headLength(a) };
}

interface Cached { parentA?: RoadDef; parentB?: RoadDef; out: RoadDef }
const cache = new WeakMap<RoadDef, Cached>();

export function resolveAttachments(roads: readonly RoadDef[]): RoadDef[] {
  if (!roads.some((r) => r.attach || r.attachEnd)) return roads as RoadDef[];
  const byId = new Map(roads.map((r) => [r.id, r]));
  const done = new Map<string, RoadDef>();
  const visiting = new Set<string>();

  const get = (id: string): RoadDef => {
    const hit = done.get(id);
    if (hit) return hit;
    const r = byId.get(id)!;
    if ((!r.attach && !r.attachEnd) || visiting.has(id)) { done.set(id, r); return r; }
    visiting.add(id);
    const parentOf = (a: AttachDef | undefined): RoadDef | undefined => {
      const p = a ? byId.get(a.road) : undefined;
      return p && p.id !== id ? get(p.id) : undefined;
    };
    const pa = parentOf(r.attach), pb = parentOf(r.attachEnd);
    visiting.delete(id);
    const c = cache.get(r);
    if (c && c.parentA === pa && c.parentB === pb) { done.set(id, c.out); return c.out; }

    const ha = r.attach && pa ? attachHead(pa, r.attach, false) : undefined;
    const hb = r.attachEnd && pb ? attachHead(pb, r.attachEnd, true) : undefined;
    const n = r.points.length;
    const keepA = r.attach ? Math.min(r.attach.head, n - 1) : 0;
    const keepB = r.attachEnd ? Math.min(r.attachEnd.head, n - 1 - keepA) : 0;
    const startPts = ha ? ha.points : r.points.slice(0, keepA);
    const endPts = hb ? hb.points : r.points.slice(n - keepB);
    const points = [...startPts, ...r.points.slice(keepA, n - keepB), ...endPts];
    const upd = (a: AttachDef | undefined, h: typeof ha): AttachDef | undefined => (a && h ? { ...a, at: { ...h.at }, s: h.s, len: h.len, head: h.points.length } : a);
    const attach = upd(r.attach, ha), attachEnd = upd(r.attachEnd, hb);
    const unchanged = points.length === n && points.every((p, i) => same(p, r.points[i]))
      && (!ha || (r.attach!.head === ha.points.length && r.attach!.s !== undefined && Math.abs(r.attach!.s - ha.s) < 1e-6 && r.attach!.len === ha.len))
      && (!hb || (r.attachEnd!.head === hb.points.length && r.attachEnd!.s !== undefined && Math.abs(r.attachEnd!.s - hb.s) < 1e-6 && r.attachEnd!.len === hb.len));
    const out: RoadDef = unchanged ? r : { ...r, points, ...(attach ? { attach } : {}), ...(attachEnd ? { attachEnd } : {}) };
    cache.set(r, { parentA: pa, parentB: pb, out });
    done.set(id, out);
    return out;
  };
  return roads.map((r) => get(r.id));
}

/** A stretch of a road's edge where nothing may stand (railing, guardrail): a branch leaves or joins there. */
export interface EdgeOpening {
  /** +1 = right of the road looking along increasing arc length */
  side: 1 | -1;
  s0: number;
  s1: number;
}

const OPENING_PAD_M = 4;

/** Openings that attachments cut into each road (keyed by road id): along the parent where the branch leaves, and along the branch's own inner side. */
export function openingsByRoad(roads: readonly RoadDef[], lengthOf: (id: string) => number): Map<string, EdgeOpening[]> {
  const out = new Map<string, EdgeOpening[]>();
  const add = (id: string, o: EdgeOpening): void => { const l = out.get(id) ?? []; l.push(o); out.set(id, l); };
  for (const r of roads) {
    for (const [a, merge] of [[r.attach, false], [r.attachEnd, true]] as Array<[AttachDef | undefined, boolean]>) {
      if (!a || a.s === undefined || a.len === undefined) continue;
      if (a.kind === 'switch') continue; // tracks have no railing
      const dir = a.dir ?? 1;
      const len = a.len * 0.85;
      // along the parent: from the nose to the point where the carriageways are a lane apart
      const sEnd = a.s + dir * Math.max(len, 10);
      add(a.road, { side: a.side, s0: Math.min(a.s, sEnd) - OPENING_PAD_M, s1: Math.max(a.s, sEnd) + OPENING_PAD_M });
      // along the branch itself: its inner side faces the parent. The branch travels along the parent's +s unless dir and merge disagree
      const travelsPlus = (dir === 1) !== merge;
      const inner = (travelsPlus ? -a.side : a.side) as 1 | -1;
      const own = lengthOf(r.id);
      add(r.id, merge ? { side: inner, s0: own - len - OPENING_PAD_M, s1: own + OPENING_PAD_M } : { side: inner, s0: -OPENING_PAD_M, s1: len + OPENING_PAD_M });
    }
  }
  return out;
}

/** A track switch seen from the road it leaves (the parent): which child hangs on it, where, and in which position. */
export interface SwitchInfo {
  /** `${childId}:${which}` */
  id: string;
  childId: string;
  which: 'attach' | 'attachEnd';
  attach: AttachDef;
}

export const switchId = (childId: string, which: 'attach' | 'attachEnd'): string => `${childId}:${which}`;

/** The track switches of a network, keyed by the PARENT road id. */
export function switchesByParent(roads: readonly RoadDef[]): Map<string, SwitchInfo[]> {
  const out = new Map<string, SwitchInfo[]>();
  for (const r of roads) {
    for (const which of ['attach', 'attachEnd'] as const) {
      const a = r[which];
      if (!a || a.kind !== 'switch' || a.s === undefined) continue;
      const l = out.get(a.road) ?? [];
      l.push({ id: switchId(r.id, which), childId: r.id, which, attach: a });
      out.set(a.road, l);
    }
  }
  return out;
}

/** geometry-relevant parts of a switch (everything but its position) as a string: the parent road is rebuilt when it changes */
export const switchGeometryKey = (list: readonly SwitchInfo[]): string =>
  list.map((w) => { const a = w.attach; return `${w.id}:${a.s?.toFixed(2)}:${a.len}:${a.side}:${a.dir}:${a.halfMain}:${a.halfBranch}:${a.gap ?? ''}:${a.taper ?? ''}:${a.grow ?? ''}:${a.taperStart ?? ''}`; }).join(',');
