// Water data: rivers, lakes and waterfalls, drawn by hand in the editor. A river is a polyline of points like a road,
// with its water level `y` at every point; the segment AFTER a point has a kind — an ordinary river reach, rapids
// (small steep drops, lots of white water) or a waterfall (the water leaves the lip, falls free and lands at the next point,
// which can be hundreds of metres lower). A lake is a flat water surface inside an outline.
//
// Coordinates are SIM space (x, y, z) like everything stored in the document; the module computes in THREE space (x, y, −z).

export type SegmentKind = 'river' | 'rapids' | 'fall';
export const SEGMENT_KINDS: readonly SegmentKind[] = ['river', 'rapids', 'fall'];

export interface RiverPoint {
  x: number;
  /** water surface level at this point (SIM y); the level never rises downstream — see hydro.ts */
  y: number;
  z: number;
  /** water surface width, metres (default: the style's) */
  width?: number;
  /** depth in the middle of the channel, metres (default: the style's) */
  depth?: number;
  /** kind of the segment from this point to the next (default 'river') */
  seg?: SegmentKind;
}

export interface RiverDef {
  id: string;
  name: string;
  /** name of a water style in the water library */
  style: string;
  params?: Record<string, number | boolean | string>;
  points: RiverPoint[];
  /** the river leaves / enters this lake (its first / last point is clamped to the lake's level) */
  startLake?: string;
  endLake?: string;
  /** the river joins this river at its last point */
  endRiver?: string;
}

export interface LakePoint {
  x: number;
  z: number;
}

export interface LakeDef {
  id: string;
  name: string;
  style: string;
  params?: Record<string, number | boolean | string>;
  /** water surface level (SIM y) */
  level: number;
  /** depth in the middle, metres */
  depth: number;
  /** shore outline (SIM x, z), at least 3 points */
  outline: LakePoint[];
}

export const RIVER_POINTS_MAX = 4000;
export const LAKE_POINTS_MAX = 1500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function cleanParams(v: unknown): Record<string, number | boolean | string> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, number | boolean | string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'boolean' || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))) out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeRiverPoint(raw: unknown): RiverPoint | null {
  if (!isObj(raw)) return null;
  const x = num(raw.x), y = num(raw.y), z = num(raw.z);
  if (x === undefined || y === undefined || z === undefined) return null;
  const p: RiverPoint = { x, y, z };
  const w = num(raw.width);
  if (w !== undefined) p.width = clamp(w, 0.2, 400);
  const d = num(raw.depth);
  if (d !== undefined) p.depth = clamp(d, 0.05, 80);
  if (typeof raw.seg === 'string' && (SEGMENT_KINDS as readonly string[]).includes(raw.seg) && raw.seg !== 'river') p.seg = raw.seg as SegmentKind;
  return p;
}

export function sanitizeRiver(raw: unknown, fallbackId: string): RiverDef | null {
  if (!isObj(raw) || !Array.isArray(raw.points)) return null;
  const points = raw.points.slice(0, RIVER_POINTS_MAX).map(sanitizeRiverPoint).filter((p): p is RiverPoint => p !== null);
  if (points.length < 2) return null;
  const r: RiverDef = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    name: typeof raw.name === 'string' ? raw.name : 'Fluss',
    style: typeof raw.style === 'string' && raw.style ? raw.style : 'bach',
    points,
  };
  const params = cleanParams(raw.params);
  if (params) r.params = params;
  for (const k of ['startLake', 'endLake', 'endRiver'] as const) if (typeof raw[k] === 'string' && raw[k]) r[k] = raw[k] as string;
  return r;
}

export function sanitizeLake(raw: unknown, fallbackId: string): LakeDef | null {
  if (!isObj(raw) || !Array.isArray(raw.outline)) return null;
  const level = num(raw.level);
  if (level === undefined) return null;
  const outline: LakePoint[] = [];
  for (const q of raw.outline.slice(0, LAKE_POINTS_MAX)) {
    if (!isObj(q)) continue;
    const x = num(q.x), z = num(q.z);
    if (x !== undefined && z !== undefined) outline.push({ x, z });
  }
  if (outline.length < 3) return null;
  const l: LakeDef = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    name: typeof raw.name === 'string' ? raw.name : 'See',
    style: typeof raw.style === 'string' && raw.style ? raw.style : 'bergsee',
    level,
    depth: clamp(num(raw.depth) ?? 6, 0.3, 300),
    outline,
  };
  const params = cleanParams(raw.params);
  if (params) l.params = params;
  return l;
}

export function cloneRiver(r: RiverDef): RiverDef {
  return {
    id: r.id, name: r.name, style: r.style,
    ...(r.params ? { params: { ...r.params } } : {}),
    points: r.points.map((p) => ({ ...p })),
    ...(r.startLake ? { startLake: r.startLake } : {}),
    ...(r.endLake ? { endLake: r.endLake } : {}),
    ...(r.endRiver ? { endRiver: r.endRiver } : {}),
  };
}

export function cloneLake(l: LakeDef): LakeDef {
  return {
    id: l.id, name: l.name, style: l.style,
    ...(l.params ? { params: { ...l.params } } : {}),
    level: l.level, depth: l.depth,
    outline: l.outline.map((p) => ({ ...p })),
  };
}

/** Sanitises both lists (unique ids, valid shapes) and drops links to things that don't exist. */
export function sanitizeWaters(rawRivers: unknown, rawLakes: unknown): { rivers: RiverDef[]; lakes: LakeDef[] } {
  const lakes: LakeDef[] = [];
  const seenL = new Set<string>();
  (Array.isArray(rawLakes) ? rawLakes : []).forEach((raw, i) => {
    const l = sanitizeLake(raw, `lake-${i}`);
    if (!l) return;
    while (seenL.has(l.id)) l.id += '_';
    seenL.add(l.id);
    lakes.push(l);
  });
  const rivers: RiverDef[] = [];
  const seenR = new Set<string>();
  (Array.isArray(rawRivers) ? rawRivers : []).forEach((raw, i) => {
    const r = sanitizeRiver(raw, `river-${i}`);
    if (!r) return;
    while (seenR.has(r.id)) r.id += '_';
    seenR.add(r.id);
    rivers.push(r);
  });
  return normalizeWaters(rivers, lakes);
}

/** Removes links to lakes / rivers that are gone (identity-preserving: untouched objects are returned as they are). */
export function normalizeWaters(rivers: readonly RiverDef[], lakes: readonly LakeDef[]): { rivers: RiverDef[]; lakes: LakeDef[] } {
  const lakeIds = new Set(lakes.map((l) => l.id));
  const riverIds = new Set(rivers.map((r) => r.id));
  const out = rivers.map((r) => {
    const bad = (r.startLake && !lakeIds.has(r.startLake)) || (r.endLake && !lakeIds.has(r.endLake)) || (r.endRiver && (!riverIds.has(r.endRiver) || r.endRiver === r.id));
    if (!bad) return r;
    const c = cloneRiver(r);
    if (c.startLake && !lakeIds.has(c.startLake)) delete c.startLake;
    if (c.endLake && !lakeIds.has(c.endLake)) delete c.endLake;
    if (c.endRiver && (!riverIds.has(c.endRiver) || c.endRiver === c.id)) delete c.endRiver;
    return c;
  });
  return { rivers: out, lakes: lakes.slice() };
}

/** Segment kind after point k (the last point has none). */
export const segmentKind = (r: RiverDef, k: number): SegmentKind => (k >= 0 && k < r.points.length - 1 ? r.points[k].seg ?? 'river' : 'river');
