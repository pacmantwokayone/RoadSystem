// Lake outlines: the user clicks a handful of points; the shore is the smoothed closed curve through the middle of the edges
// (Chaikin corner cutting). The terrain carve and the water mesh both use the SAME smoothed outline, so the shore matches exactly.

import type { LakePoint } from './types';

export function smoothOutline(points: readonly LakePoint[], iterations = 2): LakePoint[] {
  let pts = points.map((p) => ({ x: p.x, z: p.z }));
  if (pts.length < 3) return pts;
  for (let it = 0; it < iterations; it++) {
    const out: LakePoint[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, z: 0.75 * a.z + 0.25 * b.z }, { x: 0.25 * a.x + 0.75 * b.x, z: 0.25 * a.z + 0.75 * b.z });
    }
    pts = out;
  }
  return pts;
}

/** signed area (positive = counter-clockwise in the x→z sense) */
export function outlineArea(pts: readonly LakePoint[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.z - q.x * p.z; }
  return a / 2;
}

export function pointInOutline(x: number, z: number, pts: readonly LakePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function outlineBounds(pts: readonly LakePoint[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  return { minX, minZ, maxX, maxZ };
}

/** where the segment a→b crosses the outline (the crossing nearest to a), or null */
export function segmentOutlineCrossing(ax: number, az: number, bx: number, bz: number, outline: readonly LakePoint[]): { x: number; z: number; t: number } | null {
  let best: { x: number; z: number; t: number } | null = null;
  const dx = bx - ax, dz = bz - az;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const p = outline[j], q = outline[i];
    const ex = q.x - p.x, ez = q.z - p.z;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - ax) * ez - (p.z - az) * ex) / den;
    const u = ((p.x - ax) * dz - (p.z - az) * dx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { x: ax + dx * t, z: az + dz * t, t };
  }
  return best;
}

/**
 * Cuts a river polyline where it enters / leaves a lake: the points inside the lake are dropped and the end lands exactly on the
 * shore (so the river's water ends at the lake instead of running across it). Returns the points unchanged when nothing is inside.
 */
export function trimAtLake<T extends { x: number; z: number }>(points: readonly T[], outline: readonly LakePoint[], end: 'start' | 'end', make: (x: number, z: number, from: T) => T): T[] {
  const pts = end === 'end' ? points.slice() : points.slice().reverse();
  let keep = pts.length;
  while (keep > 1 && pointInOutline(pts[keep - 1].x, pts[keep - 1].z, outline)) keep--;
  if (keep === pts.length || keep < 1) return points.slice();
  const a = pts[keep - 1], b = pts[keep];
  const c = segmentOutlineCrossing(a.x, a.z, b.x, b.z, outline);
  const out = pts.slice(0, keep);
  if (c) out.push(make(c.x, c.z, a));
  else out.push(make(b.x, b.z, b)); // no crossing found (touching): end where the first point inside is
  return end === 'end' ? out : out.reverse();
}
