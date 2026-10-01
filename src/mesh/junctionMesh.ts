// Mesh of a junction patch: the top surface as a fan of rings from the centre to the boundary
// (smooth heights, no long thin triangles), and walls down to the terrain along every boundary
// segment that is not a seam to an arm.

import * as THREE from 'three';
import type { JunctionPatch } from '../runtime/junctionRuntime';
import { polygonArea } from '../network/junction';

export interface JunctionGeometry {
  geometry: THREE.BufferGeometry;
  materials: string[];
}

export interface JunctionMeshOptions {
  wallMarginM: number;
  maxWallDepthM: number;
}

export const DEFAULT_JUNCTION_MESH_OPTIONS: JunctionMeshOptions = { wallMarginM: 0.35, maxWallDepthM: 30 };

export function buildJunctionGeometry(patch: JunctionPatch, opts: JunctionMeshOptions = DEFAULT_JUNCTION_MESH_OPTIONS): JunctionGeometry {
  const B = patch.boundary.points;
  const n = B.length;
  const rings = patch.ringCount; // vertex rings 1..rings; ring `rings` is the boundary
  const topCount = 1 + n * rings;
  const wallCount = 2 * n;
  const total = topCount + wallCount;

  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const put = (i: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void => {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  };

  // --- top vertices: 0 = centre; ring m (1..rings), boundary index j → 1 + (m-1)*n + j
  const ringIdx = (m: number, j: number): number => 1 + (m - 1) * n + j;
  const ringY = (m: number, j: number): number => (m === rings ? patch.heights[j] : patch.rings[m - 1].y[j]);
  const ringP = (m: number, j: number): { x: number; z: number } => (m === rings ? B[j].p : patch.rings[m - 1].pts[j]);
  put(0, patch.center.x, patch.centerY, patch.center.z, 0, 1, 0, patch.center.x, patch.center.z);
  for (let m = 1; m <= rings; m++) {
    for (let j = 0; j < n; j++) {
      const p = ringP(m, j);
      put(ringIdx(m, j), p.x, ringY(m, j), p.z, 0, 1, 0, p.x, p.z);
    }
  }

  // --- top triangles (winding checked per triangle so normals point up whatever the polygon orientation)
  const idxTop: number[] = [];
  const tri = (a: number, b: number, c: number): void => {
    const ux = pos[b * 3] - pos[a * 3], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    // y component of (b-a) × (c-a) must be positive for an upward face
    if (uz * vx - ux * vz >= 0) idxTop.push(a, b, c);
    else idxTop.push(a, c, b);
  };
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    tri(0, ringIdx(1, j), ringIdx(1, k));
    for (let m = 1; m < rings; m++) {
      const a = ringIdx(m, j), b = ringIdx(m, k), c = ringIdx(m + 1, j), d = ringIdx(m + 1, k);
      tri(a, b, c);
      tri(b, d, c);
    }
  }

  // smooth normals for the top from the triangles (centre + rings)
  const acc = new Float32Array(topCount * 3);
  for (let t = 0; t < idxTop.length; t += 3) {
    const a = idxTop[t], b = idxTop[t + 1], c = idxTop[t + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { acc[i * 3] += nx; acc[i * 3 + 1] += ny; acc[i * 3 + 2] += nz; }
  }
  for (let i = 0; i < topCount; i++) {
    const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
    nrm[i * 3] = acc[i * 3] / l; nrm[i * 3 + 1] = acc[i * 3 + 1] / l; nrm[i * 3 + 2] = acc[i * 3 + 2] / l;
  }

  // --- walls along free boundary segments; vertex pairs (top, bottom) per boundary point
  const wallBase = topCount;
  const area = polygonArea(B.map((b) => b.p));
  // outward horizontal normal of boundary point j: average of the free segments touching it
  const segNormal = (j: number): { x: number; z: number } => {
    const a = B[j].p, b = B[(j + 1) % n].p;
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    // for a positively-oriented (x→z CCW) polygon the outside is to the right of the travel direction
    const s = area >= 0 ? 1 : -1;
    return { x: (s * dz) / l, z: (-s * dx) / l };
  };
  const vertexNormal = (j: number): { x: number; z: number } => {
    const prev = (j + n - 1) % n;
    let x = 0, z = 0;
    if (!patch.boundary.attached[prev]) { const s = segNormal(prev); x += s.x; z += s.z; }
    if (!patch.boundary.attached[j]) { const s = segNormal(j); x += s.x; z += s.z; }
    const l = Math.hypot(x, z) || 1;
    return { x: x / l, z: z / l };
  };
  let u = 0;
  for (let j = 0; j < n; j++) {
    const p = B[j].p;
    const top = patch.heights[j];
    const byThickness = top - patch.thickness;
    const bottom = Math.max(Math.min(byThickness, patch.boundaryGround[j] - opts.wallMarginM), top - opts.maxWallDepthM);
    const vn = vertexNormal(j);
    if (j > 0) u += Math.hypot(p.x - B[j - 1].p.x, p.z - B[j - 1].p.z);
    put(wallBase + 2 * j, p.x, top, p.z, vn.x, 0, vn.z, u, 0);
    put(wallBase + 2 * j + 1, p.x, bottom, p.z, vn.x, 0, vn.z, u, top - bottom);
  }
  const idxWall: number[] = [];
  for (let j = 0; j < n; j++) {
    if (patch.boundary.attached[j]) continue;
    const k = (j + 1) % n;
    const t0 = wallBase + 2 * j, b0 = t0 + 1, t1 = wallBase + 2 * k, b1 = t1 + 1;
    const sn = segNormal(j);
    // outward-facing winding for the quad (t0, t1, b0) / (t1, b1, b0)
    const ex = pos[t1 * 3] - pos[t0 * 3], ez = pos[t1 * 3 + 2] - pos[t0 * 3 + 2];
    // triangle (t0, b0, t1) has normal ∝ (−ez, ex) in the xz plane — it must agree with the outward normal
    const front = -ez * sn.x + ex * sn.z > 0;
    if (front) idxWall.push(t0, b0, t1, t1, b0, b1);
    else idxWall.push(t0, t1, b0, t1, b1, b0);
  }

  const materials = [patch.topMaterial];
  if (patch.bodyMaterial === patch.topMaterial) materials.push(patch.bodyMaterial + ' '); // keep two groups apart
  else materials.push(patch.bodyMaterial);
  const index = new Uint32Array([...idxTop, ...idxWall]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.addGroup(0, idxTop.length, 0);
  if (idxWall.length) geometry.addGroup(idxTop.length, idxWall.length, 1);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return { geometry, materials: materials.map((m) => m.trimEnd()) };
}
