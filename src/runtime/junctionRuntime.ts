// A junction patch: fills the gap between the trimmed road ends around a node. It is built once all
// arms' end chunks are ready (and the terrain inside the patch has settled) from the arms' ACTUAL end
// cross-sections, so the patch edge meets each arm exactly.

import type { NodeDef } from '../network/types';
import type { End } from '../network/graph';
import { assembleBoundary, polygonArea, rightOf, type Boundary, type Layout, type Vec2 } from '../network/junction';
import { pavementOf, pavementRuns } from '../network/pavement';
import { profileHeightInside, type ProfileData } from '../profile/types';
import type { TerrainSource } from '../core/terrain';
import type { RoadRuntime } from './roadRuntime';

export interface JunctionArm {
  road: RoadRuntime;
  end: End;
}

/** A strip of pavement along part of the patch boundary (see network/pavement.ts). */
export interface PavementStrip {
  /** the patch boundary points the strip starts from (inner edge, at the carriageway height) */
  inner: Vec2[];
  /** outer edge of the strip */
  outer: Vec2[];
  /** carriageway height at each inner point */
  heights: number[];
  /** pavement height above the carriageway at each point (0 = flush) */
  steps: number[];
  /** terrain height at each outer point */
  ground: number[];
  topMaterial: string;
  curbMaterial: string;
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
  /** pavement corners around the patch (empty when the arms have no pavements) */
  pavements: PavementStrip[];
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
      const w = c.halfCarriage;
      const heightAt = (xRoad: number): number =>
        c.pos.y + c.frame.right.y * xRoad + c.frame.up.y * profileHeightInside(a.road.profile, xRoad / c.widthScale);
      // arm-right is road-right for a 'start' end, road-left for an 'end' end
      return {
        end: {
          dir,
          left: { x: E.x - r.x * w, z: E.z - r.z * w },
          right: { x: E.x + r.x * w, z: E.z + r.z * w },
        },
        ws: c.widthScale,
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

    const pavements = this.buildPavements(boundary, ends.map((e) => e.ws), heights);
    if (!pavements) return false;

    // body parameters from the widest arm
    const widest = this.arms.reduce((best, a) => (a.road.profile.carriageHalfWidth > best.road.profile.carriageHalfWidth ? a : best));
    this.patch = {
      boundary, heights, boundaryGround, center: c, centerY, rings, ringCount, pavements,
      thickness: widest.road.profile.thickness,
      topMaterial: mainMaterial(widest.road.profile),
      bodyMaterial: widest.road.profile.bodyMaterial,
    };
    this.state = 'ready';
    return true;
  }

  /** Pavement strips along the boundary; null while the terrain beneath them hasn't settled. */
  private buildPavements(boundary: Boundary, scales: readonly number[], heights: readonly number[]): PavementStrip[] | null {
    const pts = boundary.points;
    const area = polygonArea(pts.map((b) => b.p));
    const sgn = area >= 0 ? 1 : -1;
    const strips: PavementStrip[] = [];
    for (const run of pavementRuns(boundary)) {
      const first = pts[run[0]].tag, last = pts[run[run.length - 1]].tag;
      if (first.type !== 'arm' || last.type !== 'arm') continue;
      const A = this.arms[first.arm], B = this.arms[last.arm];
      // the wedge lies on arm A's right and arm B's left; "right" of an arm that leaves the node is road-right for a 'start' end
      const pa = pavementOf(A.road.profile, A.end === 'start' ? 1 : -1);
      const pb = pavementOf(B.road.profile, B.end === 'start' ? -1 : 1);
      if (!pa && !pb) continue;
      const wa = pa ? pa.width * scales[first.arm] : 0, wb = pb ? pb.width * scales[last.arm] : 0;
      const sa = pa?.step ?? pb!.step, sb = pb?.step ?? pa!.step;
      const P = run.map((i) => pts[i].p);
      // chord-length parameter along the run
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z));
      const total = cum[cum.length - 1] || 1;
      // outward normal of each segment, then a mitred normal per point
      const segN = P.slice(1).map((q, i) => {
        const dx = q.x - P[i].x, dz = q.z - P[i].z;
        const l = Math.hypot(dx, dz) || 1;
        return { x: (sgn * dz) / l, z: (-sgn * dx) / l };
      });
      const outer: Vec2[] = [];
      const ground: number[] = [];
      const steps: number[] = [];
      for (let i = 0; i < P.length; i++) {
        const a = segN[Math.max(0, i - 1)], b = segN[Math.min(segN.length - 1, i)];
        let nx = a.x + b.x, nz = a.z + b.z;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        const miter = Math.min(2.5, 1 / Math.max(0.4, nx * a.x + nz * a.z));
        const f = cum[i] / total;
        const w = (wa + (wb - wa) * f) * miter;
        const q = { x: P[i].x + nx * w, z: P[i].z + nz * w };
        outer.push(q);
        steps.push(sa + (sb - sa) * f);
        const sz = -q.z;
        if (!this.terrain.isSettledAt(q.x, sz)) return null;
        const g = this.terrain.heightAt(q.x, sz);
        if (g === null) return null;
        ground.push(g);
      }
      strips.push({
        inner: P, outer, heights: run.map((i) => heights[i]), steps, ground,
        topMaterial: pa?.top ?? pb!.top, curbMaterial: pa?.curb ?? pb!.curb,
      });
    }
    return strips;
  }
}
