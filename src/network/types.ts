// Road data model — deliberately a sibling of world/rivers.ts (RiverDef /
// RiverPoint): a named point list, attributes authored PER POINT, tangent
// always derived from the path, whole-document persistence. Coordinates are
// SIM space (see core/world.ts).

/** What the road is doing at a point. Consecutive points with the same
 * non-'road' mode form a bridge/tunnel/gallery section. */
export type RoadMode = 'road' | 'bridge' | 'tunnel' | 'gallery';

/** How the design height at a point is determined. */
export type ElevationMode = 'drape' | 'fixed';

export interface RoadPoint {
  x: number;
  /** Authoring-time height: editor preview / fallback before the terrain has
   * settled, and the actual design height when the point is `fixed` (or its
   * mode is bridge/tunnel/gallery). */
  y: number;
  z: number;
  /** Multiplies the profile's lateral dimensions here (1 = as designed). */
  widthScale?: number;
  mode?: RoadMode;
  /** Default 'drape' for mode 'road'; bridge/tunnel/gallery are always fixed. */
  elev?: ElevationMode;
  /** Roll about the path tangent, radians. Positive = right edge lower. */
  banking?: number;
}

/** A junction: where the ends of two or more roads meet. The node position is authoritative —
 * the connected roads' end points are snapped to it. */
export interface NodeDef {
  id: string;
  /** SIM space; y = authoring-time ground height (fallback) */
  x: number;
  y: number;
  z: number;
  /** curb radius of the rounded corners, metres (default DEFAULT_CORNER_RADIUS_M) */
  radius?: number;
  /** who has right of way: 'auto' = from the roads' ranks (default), 'none' = unmarked (Rechtsvortritt), 'stop' / 'yield' = all
   * lower-ranked arms (every arm when the ranks are equal) get Stop / Kein Vortritt, 'signals' = traffic lights */
  control?: JunctionControl;
  /** zebra crossings: 'auto' (village streets with pavements), 'none', 'all' (every road arm) */
  crosswalks?: CrosswalkMode;
  /** traffic lights: 'fixed' time plan (default), 'flashing' yellow, or 'off' */
  signalMode?: SignalMode;
  /** green time per phase, seconds (default DEFAULT_GREEN_S) */
  greenS?: number;
}

export type JunctionControl = 'auto' | 'none' | 'stop' | 'yield' | 'signals';
export type CrosswalkMode = 'auto' | 'none' | 'all';
export type SignalMode = 'fixed' | 'flashing' | 'off';
export const JUNCTION_CONTROLS: readonly JunctionControl[] = ['auto', 'none', 'stop', 'yield', 'signals'];
export const CROSSWALK_MODES: readonly CrosswalkMode[] = ['auto', 'none', 'all'];
export const SIGNAL_MODES: readonly SignalMode[] = ['fixed', 'flashing', 'off'];
export const DEFAULT_GREEN_S = 20;

export const DEFAULT_CORNER_RADIUS_M = 6;

/**
 * A branch of another road: the head of the road (its first points for `RoadDef.attach`, its last points for `RoadDef.attachEnd`) is
 * computed from the parent road, see attach.ts. Everything between the heads is authored as usual.
 */
export interface AttachDef {
  /** parent road id */
  road: string;
  /** the nose (SIM): re-projected onto the parent's centre line each time, so it keeps its place when the parent is edited */
  at: { x: number; z: number };
  /** side of the parent, seen along its increasing arc length: 1 = right */
  side: 1 | -1;
  /** the head runs along +s (1) or -s (-1) of the parent from the nose */
  dir: 1 | -1;
  /** 'switch' = a track turnout (drawn with blades and frog by the RailLayer) */
  kind?: 'ramp' | 'switch';
  /** centre-to-centre distance when adjacent: half carriageway of the parent + half of the branch; for a switch the lateral offset of the track it leaves */
  halfMain: number;
  halfBranch: number;
  grow?: number;
  parallel?: number;
  taper?: number;
  gap?: number;
  taperStart?: number;
  dy?: number;
  /** switch position */
  state?: 'straight' | 'diverging';
  /** number of head points currently at the start (for `attachEnd`: the end) of `points` — kept by resolveAttachments */
  head: number;
  /** derived by resolveAttachments: arc length of the nose on the parent, and the head's length */
  s?: number;
  len?: number;
}

export interface RoadDef {
  id: string;
  name: string;
  /** Name of a profile in the profile library. */
  profile: string;
  /** Parameter overrides for the profile's `params` schema. */
  params?: Record<string, number | boolean | string>;
  /** Name of the bridge type (bridge library) used for this road's bridge sections; default: by the profile's rank. */
  bridge?: string;
  bridgeParams?: Record<string, number | boolean | string>;
  points: RoadPoint[];
  /** junction at the first / last point (NodeDef.id) */
  startNode?: string;
  endNode?: string;
  /** this road branches off another (exit, ramp, switch): its first points follow the parent */
  attach?: AttachDef;
  /** this road joins another (entry, merge): its last points follow the parent */
  attachEnd?: AttachDef;
}

import type { LakeDef, RiverDef } from '../water/types';

export interface RoadsDocument {
  version: 1;
  /** Server-assigned, increases on every successful save (optimistic locking). */
  revision?: number;
  roads: RoadDef[];
  nodes?: NodeDef[];
  /** hand-drawn rivers, waterfalls and lakes (optional) */
  rivers?: RiverDef[];
  lakes?: LakeDef[];
}

export const ROADS_DOC_VERSION = 1 as const;
export const ROAD_POINTS_MAX = 6000;

export function isFixedPoint(p: RoadPoint): boolean {
  const mode = p.mode ?? 'road';
  return mode !== 'road' || p.elev === 'fixed';
}
