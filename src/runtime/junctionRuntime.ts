// A junction patch: fills the gap between the trimmed road ends around a node. It is built once all
// arms' end chunks are ready (and the terrain inside the patch has settled) from the arms' ACTUAL end
// cross-sections, so the patch edge meets each arm exactly.

import type { NodeDef } from '../network/types';
import type { End } from '../network/graph';
import { assembleBoundary, rightOf, type Boundary, type Layout, type Vec2 } from '../network/junction';
import { profileHeightAt, type ProfileData } from '../profile/types';
import type { TerrainSource } from '../core/terrain';
import type { RoadRuntime } from './roadRuntime';

export interface JunctionArm {
  road: RoadRuntime;
  end: End;
}

export interface JunctionPatch {
  boundary: Boundary;
  /** boundary height per point (from the arms' surfaces) */
  heights: number[];
  /** terrain height at each boundary point (for the walls) */
  boundaryGround: number[];
  center: Vec2;
  centerY: number;
  /** interior rings from the centre outwards (ring m at fraction m/ringCount); the boundary is ring `ringCount` */
  rings: Array<{ pts: Vec2[]; y: number[] }>;
  ringCount: number;
  thickness: number;
  topMaterial: string;
  bodyMaterial: string;
}

/** patch resolution: roughly one ring per this many metres of radius, so triangles stay small enough
 * that terrain bumps can't poke through between vertices */
const RING_SPACING_M = 2.5;
export const MIN_PATCH_RINGS = 3;
const MAX_PATCH_RINGS = 10;
const GROUND_MARGIN = 0.12;

export type JunctionState = 'pending' | 'ready';

/** The material to use for the patch surface: the lane next to the centre line of the widest arm. */
export function mainMaterial(profile: ProfileData): string {
  const pts = profile.points;
  for (let k = 0; k < profile.segments.length; k++) {
    if (pts[k].x <= 1e-9 && pts[k + 1].x > 1e-9 && profile.segments[k].core) return profile.segments[k].material;
  }
  return profile.segments.find((s) => s.core)?.material ?? profile.segments[0].material;
}

export class JunctionRuntime {
  state: JunctionState = 'pending';
  patch: JunctionPatch | null = null;
  /** sim (x, z) of the centre → three space is (x, -z) */
  readonly center: Vec2;

  constructor(
    readonly node: NodeDef,
    /** arms in the same order as the layout was computed for */
    readonly arms: readonly JunctionArm[],
    readonly layout: Layout,
    private readonly terrain: TerrainSource,
  ) {
    this.center = { x: node.x, z: -node.z };
  }

  get id(): string {
    return this.node.id;
  }

  private armsReady(): boolean {
    return this.arms.every((a) => a.road.endReady(a.end));
  }

  /** Builds the patch if everything it depends on is ready. */
  tryBuild(): boolean {
    if (this.state === 'ready') return false;
    if (!this.armsReady()) return false;

    // arm end cross-sections (xz corners + surface heights)
    const ends = this.arms.map((a) => {
      const c = a.road.endCross(a.end);
      const t = c.frame.tangent;
      const th = Math.hypot(t.x, t.z) || 1;
      const sign = a.end === 'start' ? 1 : -1; // direction pointing away from the node
      const dir: Vec2 = { x: (sign * t.x) / th, z: (sign * t.z) / th };
      const r = rightOf(dir);
      const E: Vec2 = { x: c.pos.x, z: c.pos.z };
      const w = c.halfCore;
      const heightAt = (xRoad: number): number =>
        c.pos.y + c.frame.right.y * xRoad + c.frame.up.y * profileHeightAt(a.road.profile, xRoad / c.widthScale);
      // arm-right is road-right for a 'start' end, road-left for an 'end' end
      return {
        end: {
          dir,
          left: { x: E.x - r.x * w, z: E.z - r.z * w },
          right: { x: E.x + r.x * w, z: E.z + r.z * w },
        },
        hLeft: heightAt(-sign * w),
        hRight: heightAt(sign * w),
        centerY: c.pos.y,
      };
    });

    const boundary = assembleBoundary(this.layout, ends.map((e) => e.end));
    const pts = boundary.points;
    const n = pts.length;

    // boundary heights: along an arm's end edge from its left to its right corner, along a wedge from
    // the previous arm's right corner to the next arm's left corner
    const heights = pts.map((bp) => {
      if (bp.tag.type === 'arm') {
        const e = ends[bp.tag.arm];
        return e.hLeft + (e.hRight - e.hLeft) * bp.tag.f;
      }
      const a = ends[bp.tag.a], b = ends[bp.tag.b];
      return a.hRight + (b.hLeft - a.hRight) * bp.tag.t;
    });

    // interior rings (shrunken copies of the boundary); the centre sits at the node
    const c = this.center;
    let radius = 0;
    for (const bp of pts) radius = Math.max(radius, Math.hypot(bp.p.x - c.x, bp.p.z - c.z));
    const ringCount = Math.min(MAX_PATCH_RINGS, Math.max(MIN_PATCH_RINGS, Math.ceil(radius / RING_SPACING_M)));
    const rings: Array<{ pts: Vec2[]; y: number[] }> = [];
    for (let m = 1; m < ringCount; m++) {
      const f = m / ringCount;
      rings.push({ pts: pts.map((bp) => ({ x: c.x + (bp.p.x - c.x) * f, z: c.z + (bp.p.z - c.z) * f })), y: [] });
    }

    // terrain probes: boundary (walls), interior rings and the centre — all must be settled
    const probe = (p: Vec2): number | null => {
      const sz = -p.z;
      if (!this.terrain.isSettledAt(p.x, sz)) return null;
      return this.terrain.heightAt(p.x, sz);
    };
    const boundaryGround: number[] = [];
    for (const bp of pts) {
      const g = probe(bp.p);
      if (g === null) return false;
      boundaryGround.push(g);
    }
    const centerGround = probe(c);
    if (centerGround === null) return false;
    const ringGround: number[][] = [];
    for (const ring of rings) {
      const gs: number[] = [];
      for (const p of ring.pts) {
        const g = probe(p);
        if (g === null) return false;
        gs.push(g);
      }
      ringGround.push(gs);
    }

    // heights: centre = mean of the boundary, blended outward; never below the terrain
    const meanH = heights.reduce((s, h) => s + h, 0) / n;
    const centerY = Math.max(meanH, centerGround + GROUND_MARGIN);
    rings.forEach((ring, ri) => {
      const f = (ri + 1) / ringCount;
      ring.y = heights.map((hb, j) => Math.max(centerY + (hb - centerY) * f, ringGround[ri][j] + GROUND_MARGIN));
    });

    // body parameters from the widest arm
    const widest = this.arms.reduce((best, a) => (a.road.profile.coreHalfWidth > best.road.profile.coreHalfWidth ? a : best));
    this.patch = {
      boundary, heights, boundaryGround, center: c, centerY, rings, ringCount,
      thickness: widest.road.profile.thickness,
      topMaterial: mainMaterial(widest.road.profile),
      bodyMaterial: widest.road.profile.bodyMaterial,
    };
    this.state = 'ready';
    return true;
  }
}
