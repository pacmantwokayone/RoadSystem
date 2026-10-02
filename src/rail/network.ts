// The railway as a graph, for things that move on it. The roads with a railway profile are its edges; roads are joined where their ends
// meet (or share a junction node), and a track switch joins the child road to the parent at the switch's nose. A `Cursor` is a position on a
// road with a direction of travel; `advance` moves it along, through joins and — for facing moves with the switch set diverging — onto the
// branch. Heights come from the road's built design line, so trains ride the same surface the rails are drawn on.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadRuntime } from '../runtime/roadRuntime';
import { RAIL_HEAD_Y, type SwitchState } from './geometry';

/** a position on a road and the direction of travel along its increasing (+1) or decreasing (-1) arc length */
export interface Cursor {
  roadId: string;
  s: number;
  dir: 1 | -1;
}

/** a stretch the front of something has run over: from `from` to `to` on a road (to < from = against the arc length) */
export interface Seg {
  roadId: string;
  from: number;
  to: number;
}

export interface AdvanceResult {
  cursor: Cursor;
  /** the stretches covered, in order (the first starts at the old position) */
  segs: Seg[];
  /** the end of a road with nothing beyond it was reached before the distance was used up */
  hitEnd: boolean;
}

const JOIN_TOLERANCE_M = 3;

export class RailNetwork {
  private joinsCache: { src: readonly RoadRuntime[]; joins: Map<string, Cursor[]> } | null = null;
  private roadMap: { src: readonly RoadRuntime[]; map: Map<string, RoadRuntime> } | null = null;

  constructor(private readonly system: RoadSystem, private readonly switchState: (id: string) => SwitchState = () => 'straight') {}

  /** the roads that carry rails */
  roads(): RoadRuntime[] {
    return this.system.runtimes.filter((r) => !!r.profile.rail);
  }

  road(id: string): RoadRuntime | undefined {
    // the road list is replaced whenever the network changes: one lookup table per list
    const src = this.system.runtimes;
    if (this.roadMap?.src !== src) this.roadMap = { src, map: new Map(src.filter((r) => !!r.profile.rail).map((r) => [r.def.id, r])) };
    return this.roadMap.map.get(id);
  }

  length(id: string): number {
    return this.road(id)?.sampled.curve.length ?? 0;
  }

  /** lateral position of the track used when travelling in `dir` (right-hand traffic on a double track) */
  trackX(rt: RoadRuntime, dir: 1 | -1): number {
    const xs = rt.profile.rail!.tracks.slice().sort((a, b) => a - b);
    return dir === 1 ? xs[xs.length - 1] : xs[0];
  }

  /** a road with a single track is shared by both directions */
  isSingleTrack(rt: RoadRuntime): boolean {
    return rt.profile.rail!.tracks.length === 1;
  }

  // ---- joins ---------------------------------------------------------------------------------------------------

  private joins(): Map<string, Cursor[]> {
    const src = this.system.runtimes;
    if (this.joinsCache?.src === src) return this.joinsCache.joins;
    const rts = this.roads();
    const ends: Array<{ id: string; end: 'start' | 'end'; p: THREE.Vector3; node?: string }> = [];
    for (const r of rts) {
      const c = r.sampled.curve;
      ends.push({ id: r.def.id, end: 'start', p: c.pointAt(0), node: r.def.startNode });
      ends.push({ id: r.def.id, end: 'end', p: c.pointAt(c.length), node: r.def.endNode });
    }
    const joins = new Map<string, Cursor[]>();
    for (const a of ends) {
      const list: Cursor[] = [];
      for (const b of ends) {
        if (a.id === b.id) continue;
        const near = Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z) < JOIN_TOLERANCE_M && Math.abs(a.p.y - b.p.y) < 3;
        if (near || (a.node && a.node === b.node)) list.push({ roadId: b.id, s: b.end === 'start' ? 0 : this.length(b.id), dir: b.end === 'start' ? 1 : -1 });
      }
      joins.set(`${a.id}:${a.end}`, list);
    }
    this.joinsCache = { src, joins };
    return joins;
  }

  // ---- movement ------------------------------------------------------------------------------------------------

  /**
   * Moves a cursor `ds` metres (≥ 0) in its direction of travel. Does not change anything: switch positions are read, not set.
   * `follow` is false for look-aheads that should assume the straight route.
   */
  advance(from: Cursor, ds: number, follow = true): AdvanceResult {
    const segs: Seg[] = [];
    let c: Cursor = { ...from };
    let remaining = ds;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 64) {
      const rt = this.road(c.roadId);
      if (!rt) return { cursor: c, segs, hitEnd: true };
      const L = rt.sampled.curve.length;
      const dEnd = c.dir === 1 ? L - c.s : c.s;
      // a facing switch on this road, set diverging, taken by trains on the track it leaves
      let dSw = Infinity;
      let swInfo: (typeof rt.switches)[number] | null = null;
      if (follow) {
        for (const w of rt.switches) {
          const a = w.attach;
          if (a.s === undefined || a.dir !== c.dir || this.switchState(w.id) !== 'diverging') continue;
          const x = a.side * a.halfMain;
          if (!this.isSingleTrack(rt) && Math.abs(this.trackX(rt, c.dir) - x) > 0.3) continue;
          const d = c.dir * (a.s - c.s);
          if (d >= -1e-6 && d < dSw) { dSw = d; swInfo = w; }
        }
      }
      const step = Math.min(remaining, dEnd, dSw);
      const s1 = c.s + c.dir * step;
      if (step > 0) segs.push({ roadId: c.roadId, from: c.s, to: s1 });
      c = { ...c, s: s1 };
      remaining -= step;
      if (remaining <= 1e-9) break;
      if (swInfo && step === dSw) {
        // onto the branch: it starts at the nose (attach) or ends there (attachEnd, run backwards)
        const child = this.road(swInfo.childId);
        if (child) {
          const cl = child.sampled.curve.length;
          c = swInfo.which === 'attach' ? { roadId: swInfo.childId, s: 0, dir: 1 } : { roadId: swInfo.childId, s: cl, dir: -1 };
          continue;
        }
      }
      // the end of the road: a child leaving by its nose end joins its parent, otherwise a neighbour road, otherwise a dead end
      const at = c.dir === 1 ? 'end' : 'start';
      const a = at === 'start' ? rt.def.attach : rt.def.attachEnd;
      if (a?.kind === 'switch' && a.s !== undefined && this.road(a.road)) {
        c = { roadId: a.road, s: a.s, dir: (-a.dir) as 1 | -1 };
        continue;
      }
      const next = this.joins().get(`${c.roadId}:${at}`)?.[0];
      if (!next) return { cursor: c, segs, hitEnd: true };
      c = { ...next };
    }
    return { cursor: c, segs, hitEnd: false };
  }

  // ---- poses ---------------------------------------------------------------------------------------------------

  /** world position of the rail head on the track used in `dir`, and the direction of the road there (towards increasing s) */
  pose(roadId: string, s: number, dir: 1 | -1, out: { pos: THREE.Vector3; tangent: THREE.Vector3 } = { pos: new THREE.Vector3(), tangent: new THREE.Vector3() }): { pos: THREE.Vector3; tangent: THREE.Vector3 } | null {
    const rt = this.road(roadId);
    if (!rt) return null;
    const curve = rt.sampled.curve;
    const ss = Math.min(curve.length, Math.max(0, s));
    curve.pointAt(ss, out.pos);
    curve.tangentAt(ss, out.tangent);
    // design height from the built road, interpolated along the samples
    const S = rt.samples;
    let lo = 0, hi = S.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (S[mid].s <= ss) lo = mid; else hi = mid; }
    const ya = rt.designY[lo], yb = rt.designY[hi];
    const f = S[hi].s > S[lo].s ? (ss - S[lo].s) / (S[hi].s - S[lo].s) : 0;
    const y = Number.isNaN(ya) || Number.isNaN(yb) ? out.pos.y : ya + (yb - ya) * Math.min(1, Math.max(0, f));
    const hx = out.tangent.x, hz = out.tangent.z, hl = Math.hypot(hx, hz) || 1;
    const x = this.trackX(rt, dir);
    out.pos.set(out.pos.x + (-hz / hl) * x, y + RAIL_HEAD_Y, out.pos.z + (hx / hl) * x);
    out.tangent.normalize();
    return out;
  }

  /** where the switch noses and the platforms are: used by trains for stopping */
  stations(): Array<{ roadId: string; s: number; length: number }> {
    return this.roads().filter((r) => r.profile.name === 'Bahnhof').map((r) => ({ roadId: r.def.id, s: r.sampled.curve.length / 2, length: r.sampled.curve.length }));
  }
}
