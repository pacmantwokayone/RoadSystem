// The terrain's view of the water: where beds are cut, banks ramp up, lakes lie in basins and waterfalls have gorges.
// A pure function of the water definitions — it never reads the terrain itself, only receives the BASE height at the point it is
// asked about, so it cannot feed back into itself (see docs/PLAN.md §2a: carve never derives from carved heights).
//
//   modify(x, z, base) → the height the terrain should have at (x, z)        (SIM coordinates)
//
// Rivers: inside the channel the bed is set exactly (cut or fill: a river always sits `depth` below its level); the banks ramp up
// from the bed at the style's slope and only ever cut (min with the base); a small levee keeps the water in where the ground
// would be lower. Falls: the bed follows the sheet, with steep gorge walls; a plunge pool is dug at the foot.
// Lakes: a bowl inside the outline, a shore ramp outside.

import type { Rect } from '../core/terrain';
import type { WaterStyle } from './style';
import type { RiverHydro } from './hydro';
import { smoothOutline } from './outline';
import type { LakeDef } from './types';

export interface WaterHit {
  kind: 'river' | 'fall' | 'pool' | 'lake';
  level: number;
  /** depth of water at the point, metres */
  depth: number;
  id: string;
}

interface Contribution {
  v: number;
  /** sets the height exactly (a channel or basin) instead of only shaping it */
  hard: boolean;
}

interface Seg {
  ax: number; az: number; bx: number; bz: number;
  la: number; lb: number;
  hwa: number; hwb: number;
  da: number; db: number;
  slope: number;
  bank: number;
  kind: 'river' | 'fall';
  id: string;
}

interface Pool {
  x: number; z: number; r: number; level: number; depth: number; slope: number; bank: number; id: string;
}

interface Lake {
  def: LakeDef;
  style: WaterStyle;
  xs: Float64Array;
  zs: Float64Array;
  bowl: number;
  bank: number;
  slope: number;
  rect: Rect;
}

const CELL = 24;
const smooth = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const cellKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

/** gentle edge of the channel: the bed at the rim is this fraction of the full depth */
const RIM_DEPTH = 0.15;
/** against lower ground the bank is built up as a dike: a crest this wide and this far above the water, falling away at this slope */
const LEVEE_M = 1.0;
const LEVEE_HEIGHT_M = 0.25;
const LEVEE_SLOPE = 1.5;
/** the bank ramp may reach this many times the style's bank width when the ground beside the water is much higher (a V valley) */
const REACH = 8;

export class WaterField {
  private readonly segs: Seg[] = [];
  private readonly pools: Pool[] = [];
  private readonly lakes: Lake[] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly poolGrid = new Map<number, number[]>();
  private bounds_: Rect | null = null;

  constructor(rivers: readonly RiverHydro[], lakes: ReadonlyArray<{ def: LakeDef; style: WaterStyle }> = []) {
    for (const h of rivers) this.addRiver(h);
    for (const l of lakes) this.addLake(l.def, l.style);
  }

  get bounds(): Rect | null {
    return this.bounds_;
  }

  get empty(): boolean {
    return this.segs.length === 0 && this.lakes.length === 0 && this.pools.length === 0;
  }

  private grow(r: Rect): void {
    const b = this.bounds_;
    this.bounds_ = b ? { minX: Math.min(b.minX, r.minX), minZ: Math.min(b.minZ, r.minZ), maxX: Math.max(b.maxX, r.maxX), maxZ: Math.max(b.maxZ, r.maxZ) } : { ...r };
  }

  private addRiver(h: RiverHydro): void {
    const st = h.style;
    const S = h.samples;
    for (let i = 0; i < S.length - 1; i++) {
      const a = S[i], b = S[i + 1];
      const fall = a.kind === 'fall' && b.kind === 'fall';
      const seg: Seg = {
        ax: a.pos.x, az: -a.pos.z, bx: b.pos.x, bz: -b.pos.z,
        la: a.level, lb: b.level,
        hwa: a.width / 2 + (fall ? 0.5 : 0.3), hwb: b.width / 2 + (fall ? 0.5 : 0.3),
        da: fall ? 0.4 : a.depth, db: fall ? 0.4 : b.depth,
        slope: fall ? st.fall.wallSlope : st.banks.slope,
        bank: fall ? Math.min(45, Math.max(14, h.falls.find((f) => f.i0 <= i && i <= f.i1)?.height ?? 30) * 0.12) : st.banks.width,
        kind: fall ? 'fall' : 'river', id: h.def.id,
      };
      this.insertSeg(seg);
    }
    for (const f of h.falls) {
      const s = S[f.i1];
      const r = Math.max(5, f.width * st.fall.poolRadius);
      const pool: Pool = { x: f.foot.x, z: -f.foot.z, r, level: s.level, depth: st.fall.poolDepth, slope: st.banks.slope, bank: st.banks.width + r * 0.3, id: h.def.id };
      this.pools.push(pool);
      const R = pool.r + pool.bank;
      const rect = { minX: pool.x - R, maxX: pool.x + R, minZ: pool.z - R, maxZ: pool.z + R };
      this.grow(rect);
      const idx = this.pools.length - 1;
      for (let cx = Math.floor(rect.minX / CELL); cx <= Math.floor(rect.maxX / CELL); cx++) {
        for (let cz = Math.floor(rect.minZ / CELL); cz <= Math.floor(rect.maxZ / CELL); cz++) {
          const k = cellKey(cx, cz);
          const list = this.poolGrid.get(k);
          if (list) list.push(idx); else this.poolGrid.set(k, [idx]);
        }
      }
    }
  }

  private insertSeg(seg: Seg): void {
    const idx = this.segs.length;
    this.segs.push(seg);
    const R = Math.max(seg.hwa, seg.hwb) + seg.bank * REACH;
    const rect = {
      minX: Math.min(seg.ax, seg.bx) - R, maxX: Math.max(seg.ax, seg.bx) + R,
      minZ: Math.min(seg.az, seg.bz) - R, maxZ: Math.max(seg.az, seg.bz) + R,
    };
    this.grow(rect);
    for (let cx = Math.floor(rect.minX / CELL); cx <= Math.floor(rect.maxX / CELL); cx++) {
      for (let cz = Math.floor(rect.minZ / CELL); cz <= Math.floor(rect.maxZ / CELL); cz++) {
        const k = cellKey(cx, cz);
        const list = this.grid.get(k);
        if (list) list.push(idx); else this.grid.set(k, [idx]);
      }
    }
  }

  private addLake(def: LakeDef, style: WaterStyle): void {
    const smooth = smoothOutline(def.outline);
    const n = smooth.length;
    const xs = new Float64Array(n), zs = new Float64Array(n);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    smooth.forEach((p, i) => { xs[i] = p.x; zs[i] = p.z; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
    const bank = style.banks.width;
    const m = bank * REACH;
    const lake: Lake = { def, style, xs, zs, bowl: Math.max(4, def.depth / Math.max(0.1, style.banks.slope)), bank, slope: style.banks.slope, rect: { minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m } };
    this.lakes.push(lake);
    this.grow(lake.rect);
  }

  /** the rect of everything one river / lake touches (for invalidating terrain tiles) */
  static boundsOfRiver(h: RiverHydro): Rect {
    const f = new WaterField([h]);
    return f.bounds ?? { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  }

  static boundsOfLake(def: LakeDef, style: WaterStyle): Rect {
    const f = new WaterField([], [{ def, style }]);
    return f.bounds ?? { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  }

  /** the height the terrain should have at (x, z), given its base height */
  modify(x: number, z: number, base: number): number {
    const b = this.bounds_;
    if (!b || x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return base;
    // channels and basins (`hard`) set the height exactly; banks and levees (`soft`) only shape it around them
    let hard = Infinity;
    let soft = Infinity;
    const add = (r: Contribution | null): void => {
      if (!r) return;
      if (r.hard) hard = Math.min(hard, r.v); else soft = Math.min(soft, r.v);
    };

    const cell = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
    const cand = this.grid.get(cell);
    if (cand) {
      // per river the nearest segment decides; a point close to two rivers takes the lower result
      const nearest = new Map<string, { seg: Seg; t: number; d: number }>();
      for (const i of cand) {
        const s = this.segs[i];
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / l2)) : 0;
        const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
        const cur = nearest.get(s.id);
        if (!cur || d < cur.d) nearest.set(s.id, { seg: s, t, d });
      }
      for (const e of nearest.values()) add(this.riverValue(e.seg, e.t, e.d, base));
    }
    const pc = this.poolGrid.get(cell);
    if (pc) for (const i of pc) add(this.poolValue(this.pools[i], x, z, base));
    for (const l of this.lakes) {
      if (x < l.rect.minX || x > l.rect.maxX || z < l.rect.minZ || z > l.rect.maxZ) continue;
      add(this.lakeValue(l, x, z, base));
    }
    if (hard === Infinity && soft === Infinity) return base;
    return Math.min(hard, soft);
  }

  private riverValue(s: Seg, t: number, d: number, base: number): Contribution | null {
    const hw = s.hwa + (s.hwb - s.hwa) * t;
    if (d >= hw + s.bank * REACH) return null;
    const level = s.la + (s.lb - s.la) * t;
    const depth = s.da + (s.db - s.da) * t;
    if (d <= hw) {
      const q = d / hw;
      return { v: level - depth * (RIM_DEPTH + (1 - RIM_DEPTH) * (1 - q * q)), hard: true }; // channel: set exactly (cut or fill)
    }
    return { v: this.bank(base, level - depth * RIM_DEPTH, s.slope, d - hw, s.bank, level), hard: false };
  }

  /** bank ramp from the rim (`rimY`) outwards: only cuts. Where the ground beside the water is much higher the ramp keeps climbing
   *  (a V valley, up to REACH × the style's bank width) and rounds off into the terrain; plus a thin levee against lower ground. */
  private bank(base: number, rimY: number, slope: number, u: number, width: number, level: number, reachMul = REACH): number {
    const reach = Math.min(width * reachMul, Math.max(width, (base - rimY) / Math.max(slope, 1e-3)));
    let v = Math.min(base, rimY + slope * u);
    v = v + (base - v) * smooth(reach * 0.6, reach, u);
    const rise = Math.min(1, u / 0.5); // up from the rim to the crest within half a metre
    v = Math.max(v, rimY + (level + LEVEE_HEIGHT_M - rimY) * rise - LEVEE_SLOPE * Math.max(0, u - LEVEE_M));
    return v;
  }

  private poolValue(p: Pool, x: number, z: number, base: number): Contribution | null {
    const r = Math.hypot(x - p.x, z - p.z);
    if (r >= p.r + p.bank) return null;
    if (r <= p.r) { const q = r / p.r; return { v: p.level - p.depth * (RIM_DEPTH + (1 - RIM_DEPTH) * (1 - q * q)), hard: true }; }
    return { v: this.bank(base, p.level - p.depth * RIM_DEPTH, p.slope, r - p.r, p.bank, p.level, 1), hard: false };
  }

  private lakeValue(l: Lake, x: number, z: number, base: number): Contribution | null {
    const n = l.xs.length;
    let inside = false;
    let dmin = Infinity;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = l.xs[i], zi = l.zs[i], xj = l.xs[j], zj = l.zs[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      const dx = xj - xi, dz = zj - zi;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - xi) * dx + (z - zi) * dz) / l2)) : 0;
      const d = Math.hypot(x - (xi + dx * t), z - (zi + dz * t));
      if (d < dmin) dmin = d;
    }
    const level = l.def.level;
    if (inside) {
      // a bowl that only cuts: ground that already lies deeper stays
      return { v: Math.min(base, level - l.def.depth * smooth(0, l.bowl, dmin)), hard: true };
    }
    if (dmin >= l.bank * REACH) return null;
    return { v: this.bank(base, level, l.slope, dmin, l.bank, level), hard: false };
  }

  /** Is there water at (x, z)? The deepest/highest answer wins (lakes before rivers). */
  waterAt(x: number, z: number): WaterHit | null {
    for (const l of this.lakes) {
      if (x < l.rect.minX || x > l.rect.maxX || z < l.rect.minZ || z > l.rect.maxZ) continue;
      let inside = false;
      const n = l.xs.length;
      let dmin = Infinity;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = l.xs[i], zi = l.zs[i], xj = l.xs[j], zj = l.zs[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        const dx = xj - xi, dz = zj - zi, l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - xi) * dx + (z - zi) * dz) / l2)) : 0;
        dmin = Math.min(dmin, Math.hypot(x - (xi + dx * t), z - (zi + dz * t)));
      }
      if (inside) return { kind: 'lake', level: l.def.level, depth: l.def.depth * smooth(0, l.bowl, dmin), id: l.def.id };
    }
    const cand = this.grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (cand) {
      let best: { s: Seg; t: number; d: number } | null = null;
      for (const i of cand) {
        const s = this.segs[i];
        const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / l2)) : 0;
        const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
        if (!best || d < best.d) best = { s, t, d };
      }
      if (best) {
        const { s, t, d } = best;
        const hw = s.hwa + (s.hwb - s.hwa) * t;
        if (d <= hw) {
          const q = d / hw;
          const depth = (s.da + (s.db - s.da) * t) * (RIM_DEPTH + (1 - RIM_DEPTH) * (1 - q * q));
          return { kind: s.kind, level: s.la + (s.lb - s.la) * t, depth, id: s.id };
        }
      }
    }
    const pc = this.poolGrid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (pc) for (const i of pc) { const p = this.pools[i]; const r = Math.hypot(x - p.x, z - p.z); if (r <= p.r) return { kind: 'pool', level: p.level, depth: p.depth * (1 - (r / p.r) ** 2), id: p.id }; }
    return null;
  }

  /** distance (m) from (x, z) to the nearest water edge, 0 inside; Infinity when far away — for tinting wet banks */
  distanceToWater(x: number, z: number, maxM: number): number {
    const b = this.bounds_;
    if (!b || x < b.minX - maxM || x > b.maxX + maxM || z < b.minZ - maxM || z > b.maxZ + maxM) return Infinity;
    let best = Infinity;
    const cand = this.grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (cand) {
      for (const i of cand) {
        const s = this.segs[i];
        const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - s.ax) * dx + (z - s.az) * dz) / l2)) : 0;
        const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)) - (s.hwa + (s.hwb - s.hwa) * t);
        if (d < best) best = d;
      }
    }
    for (const l of this.lakes) {
      if (x < l.rect.minX - maxM || x > l.rect.maxX + maxM || z < l.rect.minZ - maxM || z > l.rect.maxZ + maxM) continue;
      const w = this.waterAt(x, z);
      if (w?.kind === 'lake') return 0;
      const n = l.xs.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = l.xs[i], zi = l.zs[i], xj = l.xs[j], zj = l.zs[j];
        const dx = xj - xi, dz = zj - zi, l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - xi) * dx + (z - zi) * dz) / l2)) : 0;
        best = Math.min(best, Math.hypot(x - (xi + dx * t), z - (zi + dz * t)));
      }
    }
    return Math.max(0, best);
  }
}
