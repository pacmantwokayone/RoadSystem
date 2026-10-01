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

export interface RoadDef {
  id: string;
  name: string;
  /** Name of a profile in the profile library. */
  profile: string;
  /** Parameter overrides for the profile's `params` schema. */
  params?: Record<string, number | boolean | string>;
  points: RoadPoint[];
  /** junction at the first / last point (NodeDef.id) */
  startNode?: string;
  endNode?: string;
}

export interface RoadsDocument {
  version: 1;
  /** Server-assigned, increases on every successful save (optimistic locking). */
  revision?: number;
  roads: RoadDef[];
  nodes?: NodeDef[];
}

export const ROADS_DOC_VERSION = 1 as const;
export const ROAD_POINTS_MAX = 6000;

export function isFixedPoint(p: RoadPoint): boolean {
  const mode = p.mode ?? 'road';
  return mode !== 'road' || p.elev === 'fixed';
}
