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

export interface RoadDef {
  id: string;
  name: string;
  /** Name of a profile in the profile library (resolved from Phase 2 on). */
  profile: string;
  points: RoadPoint[];
}

export interface RoadsDocument {
  version: 1;
  /** Server-assigned, increases on every successful save (optimistic locking). */
  revision?: number;
  roads: RoadDef[];
}

export const ROADS_DOC_VERSION = 1 as const;
export const ROAD_POINTS_MAX = 6000;

export function isFixedPoint(p: RoadPoint): boolean {
  const mode = p.mode ?? 'road';
  return mode !== 'road' || p.elev === 'fixed';
}
