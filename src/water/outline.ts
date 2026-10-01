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
