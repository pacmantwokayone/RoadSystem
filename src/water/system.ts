// The water system: turns river and lake definitions into runtimes (hydrology + chunks), keeps the terrain's carve field in sync,
// and tells the mesh layer when something is ready to be built. Same idiom as the RoadSystem: a chunk is built only once the
// terrain under it has settled — and, for water, only after the terrain has been re-carved, because the water surface is
// shaped by the terrain it lies on (depth, shore foam).

import { Vector3 } from 'three';
import type { ModifierFn, TintFn } from '../terrain/mockStreamTerrain';
import type { TerrainSource } from '../core/terrain';
import { flipZ } from '../core/world';
import type { Rect } from '../core/terrain';
import { WaterField } from './field';
import { computeRiverHydro, type RiverHydro } from './hydro';
import type { WaterLibrary } from './styleLibrary';
import type { WaterStyle } from './style';
import type { LakeDef, RiverDef } from './types';

/** What the water system needs from a terrain: heights, settledness, and a way to have the carve applied. */
export interface WaterTerrain extends TerrainSource {
  modifier?: ModifierFn | null;
  /** named modifiers (several systems shape the ground); preferred over `modifier` when present */
  setModifier?(id: string, fn: ModifierFn | null): void;
  tint?: TintFn | null;
  /** regenerate the loaded tiles touching the rect (after `modifier` changed); returns how many */
  invalidate?(rect?: Rect): number;
}

export interface WaterChunk {
  index: number;
  /** first / last sample of the chunk (neighbouring chunks share their boundary sample) */
  i0: number;
  i1: number;
  kind: 'river' | 'fall';
  state: 'pending' | 'ready';
}

export interface RiverRuntime {
  readonly def: RiverDef;
  readonly style: WaterStyle;
  readonly hydro: RiverHydro;
  readonly chunks: WaterChunk[];
  readonly seed: number;
  readonly bounds: Rect;
  /** every chunk built */
  readonly pendingCount: number;
}

export interface LakeRuntime {
  readonly def: LakeDef;
  readonly style: WaterStyle;
  readonly seed: number;
  readonly bounds: Rect;
  state: 'pending' | 'ready';
}

export interface WaterOptions {
  /** target chunk length along a river, metres */
  chunkLengthM: number;
  /** wait this long (ms) after the last edit before the terrain is re-carved (regenerating tiles is not free) */
  debounceMs: number;
  /** darken the terrain along the water (wet banks) */
  tintBanks: boolean;
}

export const DEFAULT_WATER_OPTIONS: WaterOptions = { chunkLengthM: 48, debounceMs: 160, tintBanks: true };

export interface WaterBudget {
  /** chunks / lakes built per call */
  builds: number;
}

const DEFAULT_BUDGET: WaterBudget = { builds: 12 };

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const intersects = (a: Rect, b: Rect): boolean => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
const union = (a: Rect | null, b: Rect): Rect => (a ? { minX: Math.min(a.minX, b.minX), minZ: Math.min(a.minZ, b.minZ), maxX: Math.max(a.maxX, b.maxX), maxZ: Math.max(a.maxZ, b.maxZ) } : { ...b });

class River implements RiverRuntime {
  readonly chunks: WaterChunk[] = [];
  readonly seed: number;
  readonly bounds: Rect;

  constructor(readonly def: RiverDef, readonly style: WaterStyle, readonly hydro: RiverHydro, chunkLengthM: number) {
    this.seed = hashString(def.id);
    this.bounds = WaterField.boundsOfRiver(hydro);
    const S = hydro.samples;
    const falls = hydro.falls;
    const push = (a: number, b: number, kind: 'river' | 'fall'): void => { if (b > a) this.chunks.push({ index: this.chunks.length, i0: a, i1: b, kind, state: 'pending' }); };
    let cursor = 0;
    for (const f of falls) {
      // the reach before the lip ends AT the lip sample (the sheet starts there), the reach after starts AT the foot sample
      this.splitReach(cursor, f.i0, S, chunkLengthM, push);
      push(f.i0, f.i1, 'fall');
      cursor = f.i1;
    }
    this.splitReach(cursor, S.length - 1, S, chunkLengthM, push);
  }

  private splitReach(a: number, b: number, S: RiverHydro['samples'], len: number, push: (a: number, b: number, kind: 'river' | 'fall') => void): void {
    let start = a;
    for (let i = a + 1; i <= b; i++) {
      if (S[i].s - S[start].s >= len || i === b) { push(start, i, 'river'); start = i; }
    }
  }

  get pendingCount(): number {
    let c = 0;
    for (const ch of this.chunks) if (ch.state === 'pending') c++;
    return c;
  }
}

class Lake implements LakeRuntime {
  state: 'pending' | 'ready' = 'pending';
  readonly seed: number;
  readonly bounds: Rect;

  constructor(readonly def: LakeDef, readonly style: WaterStyle) {
    this.seed = hashString(def.id);
    this.bounds = WaterField.boundsOfLake(def, style);
  }
}

export type RiverListener = (rt: RiverRuntime, chunk: WaterChunk) => void;
export type LakeListener = (lake: LakeRuntime) => void;

export class WaterSystem {
  private riverList: River[] = [];
  private lakeList: Lake[] = [];
  private inputRivers: readonly RiverDef[] = [];
  private inputLakes: readonly LakeDef[] = [];
  private fieldValue = new WaterField([]);
  private dirty: Rect | null = null;
  private dirtySince = 0;
  private lastStyleKey = new Map<string, WaterStyle>();

  private chunkListeners = new Set<RiverListener>();
  private lakeListeners = new Set<LakeListener>();
  private removedRiver = new Set<(rt: RiverRuntime) => void>();
  private replacedRiver = new Set<(prev: RiverRuntime, next: RiverRuntime) => void>();
  private removedLake = new Set<(l: LakeRuntime) => void>();
  private replacedLake = new Set<(prev: LakeRuntime, next: LakeRuntime) => void>();
  private terrainListeners = new Set<(rect: Rect) => void>();

  constructor(
    private readonly terrain: WaterTerrain,
    private readonly library: WaterLibrary,
    private readonly opts: WaterOptions = DEFAULT_WATER_OPTIONS,
    private readonly now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  ) {}

  get rivers(): readonly RiverRuntime[] { return this.riverList; }
  get lakes(): readonly LakeRuntime[] { return this.lakeList; }
  get field(): WaterField { return this.fieldValue; }

  // ---- setting the waters -----------------------------------------------------

  /** Whole-list replace (diffed by object identity): only rivers / lakes that changed are rebuilt. */
  setWaters(riversIn: readonly RiverDef[], lakesIn: readonly LakeDef[]): void {
    this.inputRivers = riversIn;
    this.inputLakes = lakesIn;
    const lakeById = new Map(lakesIn.map((l) => [l.id, l]));

    // pass 1: hydrology without river-to-river links
    const base = new Map<string, RiverHydro>();
    const hydroFor = (def: RiverDef, endLevel?: number): RiverHydro => {
      const style = this.library.forRiver(def);
      const start = def.startLake ? lakeById.get(def.startLake)?.level : undefined;
      const end = endLevel ?? (def.endLake ? lakeById.get(def.endLake)?.level : undefined);
      return computeRiverHydro(def, style, { startLevel: start, endLevel: end });
    };
    for (const def of riversIn) base.set(def.id, hydroFor(def));
    // pass 2: a river that joins another one ends at that river's level where they meet
    const hydros = new Map<string, RiverHydro>();
    for (const def of riversIn) {
      const other = def.endRiver ? base.get(def.endRiver) : undefined;
      if (other && !def.endLake) {
        const last = def.points[def.points.length - 1];
        const lp = new Vector3(last.x, 0, flipZ(last.z));
        let best = other.samples[0], bd = Infinity;
        for (const s of other.samples) { const d = Math.hypot(s.pos.x - lp.x, s.pos.z - lp.z); if (d < bd) { bd = d; best = s; } }
        hydros.set(def.id, hydroFor(def, best.level));
      } else hydros.set(def.id, base.get(def.id)!);
    }

    // diff rivers
    const oldR = new Map(this.riverList.map((r) => [r.def.id, r]));
    const nextR: River[] = [];
    const replacedR: Array<[River, River]> = [];
    let changed: Rect | null = null;
    for (const def of riversIn) {
      const style = this.library.forRiver(def);
      const h = hydros.get(def.id)!;
      const old = oldR.get(def.id);
      if (old && old.def === def && old.style === style && sameLevels(old.hydro, h)) { nextR.push(old); continue; }
      const rt = new River(def, style, h, this.opts.chunkLengthM);
      nextR.push(rt);
      changed = union(changed, rt.bounds);
      if (old) { replacedR.push([old, rt]); changed = union(changed, old.bounds); }
    }
    const idsR = new Set(riversIn.map((r) => r.id));
    const removedR = this.riverList.filter((r) => !idsR.has(r.def.id));
    for (const r of removedR) changed = union(changed, r.bounds);

    // diff lakes
    const oldL = new Map(this.lakeList.map((l) => [l.def.id, l]));
    const nextL: Lake[] = [];
    const replacedL: Array<[Lake, Lake]> = [];
    for (const def of lakesIn) {
      const style = this.library.forLake(def);
      const old = oldL.get(def.id);
      if (old && old.def === def && old.style === style) { nextL.push(old); continue; }
      const lk = new Lake(def, style);
      nextL.push(lk);
      changed = union(changed, lk.bounds);
      if (old) { replacedL.push([old, lk]); changed = union(changed, old.bounds); }
    }
    const idsL = new Set(lakesIn.map((l) => l.id));
    const removedL = this.lakeList.filter((l) => !idsL.has(l.def.id));
    for (const l of removedL) changed = union(changed, l.bounds);

    this.riverList = nextR;
    this.lakeList = nextL;
    this.fieldValue = new WaterField(nextR.map((r) => r.hydro), nextL.map((l) => ({ def: l.def, style: l.style })));
    if (changed) this.markTerrainDirty(changed);

    for (const [a, b] of replacedR) for (const cb of this.replacedRiver) cb(a, b);
    for (const r of removedR) for (const cb of this.removedRiver) cb(r);
    for (const [a, b] of replacedL) for (const cb of this.replacedLake) cb(a, b);
    for (const l of removedL) for (const cb of this.removedLake) cb(l);
  }

  /** Re-run the diff (a water style's code changed: its resolved object differs). */
  refresh(): void {
    this.setWaters(this.inputRivers, this.inputLakes);
  }

  // ---- terrain -----------------------------------------------------------------

  private markTerrainDirty(r: Rect): void {
    this.dirty = union(this.dirty, r);
    this.dirtySince = this.now();
    // everything the carve touches has to be rebuilt once the terrain is regenerated: mark it pending now so nothing is
    // built on the old terrain in the meantime
    for (const rt of this.riverList) if (intersects(rt.bounds, r)) for (const c of rt.chunks) c.state = 'pending';
    for (const l of this.lakeList) if (intersects(l.bounds, r)) l.state = 'pending';
  }

  /** Is a terrain update waiting (the debounce hasn't run out yet)? */
  get terrainPending(): boolean {
    return this.dirty !== null;
  }

  /** Re-carves the terrain now (instead of after the debounce). */
  flush(): void {
    const r = this.dirty;
    if (!r) return;
    this.dirty = null;
    const field = this.fieldValue;
    const mod: ModifierFn | null = field.empty ? null : (x, z, b) => field.modify(x, z, b);
    if (this.terrain.setModifier) this.terrain.setModifier('water', mod); else this.terrain.modifier = mod;
    if (this.opts.tintBanks && 'tint' in this.terrain) {
      this.terrain.tint = field.empty ? null : (x, z, _y, out) => {
        const d = field.distanceToWater(x, z, 14);
        if (d < 14) {
          const k = Math.min(1, Math.max(0, 1 - d / 14)) ** 1.5;
          out.r += (0.42 - out.r) * 0.75 * k; out.g += (0.40 - out.g) * 0.75 * k; out.b += (0.36 - out.b) * 0.75 * k; // wet grey pebbles
        }
      };
    }
    this.terrain.invalidate?.(r);
    for (const cb of this.terrainListeners) cb(r);
  }

  onTerrainChanged(cb: (rect: Rect) => void): () => void {
    this.terrainListeners.add(cb);
    return () => this.terrainListeners.delete(cb);
  }

  // ---- building -------------------------------------------------------------------

  /** Applies a due terrain update and builds pending chunks whose terrain has settled. Returns how many were built. */
  resync(budget: WaterBudget = DEFAULT_BUDGET): number {
    if (this.dirty && this.now() - this.dirtySince >= this.opts.debounceMs) this.flush();
    if (this.dirty) return 0; // wait for the carve before building anything on it
    let built = 0;
    for (const lk of this.lakeList) {
      if (built >= budget.builds) return built;
      if (lk.state === 'pending' && this.lakeSettled(lk)) { lk.state = 'ready'; for (const cb of this.lakeListeners) cb(lk); built++; }
    }
    for (const rt of this.riverList) {
      for (const ch of rt.chunks) {
        if (built >= budget.builds) return built;
        if (ch.state === 'pending' && this.chunkSettled(rt, ch)) { ch.state = 'ready'; for (const cb of this.chunkListeners) cb(rt, ch); built++; }
      }
    }
    return built;
  }

  private chunkSettled(rt: River, ch: WaterChunk): boolean {
    const S = rt.hydro.samples;
    const reach = rt.style.banks.width + rt.style.banks.strip + 2;
    for (let i = ch.i0; i <= ch.i1; i += Math.max(1, Math.floor((ch.i1 - ch.i0) / 6))) {
      const s = S[i];
      const r = s.width / 2 + reach;
      for (const k of [-1, 0, 1]) if (!this.terrain.isSettledAt(s.pos.x + s.right.x * r * k, flipZ(s.pos.z + s.right.z * r * k))) return false;
    }
    return true;
  }

  private lakeSettled(lk: Lake): boolean {
    const b = lk.bounds;
    for (const [x, z] of [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ], [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2]]) if (!this.terrain.isSettledAt(x, z)) return false;
    return true;
  }

  stats(): { chunks: number; ready: number; lakes: number; lakesReady: number } {
    let chunks = 0, ready = 0;
    for (const r of this.riverList) { chunks += r.chunks.length; ready += r.chunks.length - r.pendingCount; }
    return { chunks, ready, lakes: this.lakeList.length, lakesReady: this.lakeList.filter((l) => l.state === 'ready').length };
  }

  /** everything built (and no terrain update pending)? */
  get settled(): boolean {
    const s = this.stats();
    return !this.dirty && s.ready === s.chunks && s.lakesReady === s.lakes;
  }

  // ---- listeners -------------------------------------------------------------------

  onChunkReady(cb: RiverListener): () => void { this.chunkListeners.add(cb); return () => this.chunkListeners.delete(cb); }
  onLakeReady(cb: LakeListener): () => void { this.lakeListeners.add(cb); return () => this.lakeListeners.delete(cb); }
  onRiverRemoved(cb: (rt: RiverRuntime) => void): () => void { this.removedRiver.add(cb); return () => this.removedRiver.delete(cb); }
  onRiverReplaced(cb: (prev: RiverRuntime, next: RiverRuntime) => void): () => void { this.replacedRiver.add(cb); return () => this.replacedRiver.delete(cb); }
  onLakeRemoved(cb: (l: LakeRuntime) => void): () => void { this.removedLake.add(cb); return () => this.removedLake.delete(cb); }
  onLakeReplaced(cb: (prev: LakeRuntime, next: LakeRuntime) => void): () => void { this.replacedLake.add(cb); return () => this.replacedLake.delete(cb); }
}

function sameLevels(a: RiverHydro, b: RiverHydro): boolean {
  if (a.levels.length !== b.levels.length) return false;
  for (let i = 0; i < a.levels.length; i++) if (a.levels[i] !== b.levels[i]) return false;
  return true;
}
