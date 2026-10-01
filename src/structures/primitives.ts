// Geometry building blocks for structures. Everything is a LOFT: a list of convex rings (closed polygons with the
// same number of points) joined by quads, with optional end caps. A box is a loft of two rectangles, a column is a
// loft of two circles, a beam is a loft along its axis, a retaining wall is a loft whose height varies along the
// path, a girder is a loft along the road. Normals are analytic; UVs are in metres (u around, v along).

import * as THREE from 'three';
import type { GeometryBatch } from '../props/batch';

export type Raw = ReturnType<GeometryBatch['addRaw']>;

export interface LoftOptions {
  /** smooth (cylinder-like) vertex normals instead of one flat normal per face */
  smooth?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
}

const centroid = (ring: readonly THREE.Vector3[]): THREE.Vector3 => {
  const c = new THREE.Vector3();
  for (const p of ring) c.add(p);
  return c.multiplyScalar(1 / ring.length);
};

export function loft(raw: Raw, rings: readonly (readonly THREE.Vector3[])[], o: LoftOptions = {}): void {
  if (rings.length < 2) return;
  const N = rings[0].length;
  if (N < 3) return;
  const cs = rings.map(centroid);
  const along: number[] = [0];
  for (let k = 1; k < rings.length; k++) along.push(along[k - 1] + cs[k].distanceTo(cs[k - 1]));
  const perim: number[][] = rings.map((ring) => {
    const u = [0];
    for (let j = 1; j <= N; j++) u.push(u[j - 1] + ring[j % N].distanceTo(ring[j - 1]));
    return u;
  });
  const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3(), out = new THREE.Vector3();
  const vn = (k: number, j: number): THREE.Vector3 => new THREE.Vector3().subVectors(rings[k][j], cs[k]).normalize();

  for (let k = 0; k < rings.length - 1; k++) {
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      const p00 = rings[k][j], p01 = rings[k][j1], p10 = rings[k + 1][j], p11 = rings[k + 1][j1];
      a.subVectors(p01, p00); b.subVectors(p10, p00);
      n.crossVectors(a, b);
      if (n.lengthSq() < 1e-12) { // degenerate along the ring edge: try the other diagonal
        a.subVectors(p11, p10); b.subVectors(p10, p00);
        n.crossVectors(a, b);
        if (n.lengthSq() < 1e-12) continue;
      }
      n.normalize();
      out.copy(p00).add(p01).add(p10).add(p11).multiplyScalar(0.25).sub(cs[k]).addScaledVector(cs[k + 1].clone().sub(cs[k]), -0.5);
      const flip = n.dot(out) < 0;
      if (flip) n.negate();
      const nn = o.smooth ? [vn(k, j), vn(k, j1), vn(k + 1, j), vn(k + 1, j1)] : [n, n, n, n];
      const i00 = raw.vertex(p00, nn[0], perim[k][j], along[k]);
      const i01 = raw.vertex(p01, nn[1], perim[k][j + 1], along[k]);
      const i10 = raw.vertex(p10, nn[2], perim[k + 1][j], along[k + 1]);
      const i11 = raw.vertex(p11, nn[3], perim[k + 1][j + 1], along[k + 1]);
      if (!flip) { raw.tri(i00, i01, i10); raw.tri(i01, i11, i10); } else { raw.tri(i00, i10, i01); raw.tri(i01, i10, i11); }
    }
  }

  const cap = (k: number, dir: THREE.Vector3): void => {
    const ring = rings[k];
    dir.normalize();
    const base = raw.vertex(cs[k], dir, 0, 0);
    const idx = ring.map((p, j) => raw.vertex(p, dir, p.x, p.z + j * 0));
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      a.subVectors(ring[j], cs[k]); b.subVectors(ring[j1], cs[k]);
      if (n.crossVectors(a, b).dot(dir) >= 0) raw.tri(base, idx[j], idx[j1]); else raw.tri(base, idx[j1], idx[j]);
    }
  };
  if (o.capStart) cap(0, new THREE.Vector3().subVectors(cs[0], cs[1]));
  if (o.capEnd) cap(rings.length - 1, new THREE.Vector3().subVectors(cs[rings.length - 1], cs[rings.length - 2]));
}

export function rectRing(c: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, hw: number, hh: number): THREE.Vector3[] {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => c.clone().addScaledVector(right, sx * hw).addScaledVector(up, sy * hh));
}

export function circleRing(c: THREE.Vector3, right: THREE.Vector3, fwd: THREE.Vector3, rx: number, rz: number, n = 14): THREE.Vector3[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return c.clone().addScaledVector(right, Math.cos(t) * rx).addScaledVector(fwd, Math.sin(t) * rz);
  });
}

/** An oriented box: centre, axes (unit), half sizes along them. */
export function box(raw: Raw, c: THREE.Vector3, ax: THREE.Vector3, ay: THREE.Vector3, az: THREE.Vector3, hx: number, hy: number, hz: number): void {
  loft(raw, [rectRing(c.clone().addScaledVector(az, -hz), ax, ay, hx, hy), rectRing(c.clone().addScaledVector(az, hz), ax, ay, hx, hy)], { capStart: true, capEnd: true });
}

/** A straight member between two points, rectangular cross-section w × h (h along `upHint`). */
export function beam(raw: Raw, p: THREE.Vector3, q: THREE.Vector3, w: number, h: number, upHint: THREE.Vector3): void {
  const dir = new THREE.Vector3().subVectors(q, p);
  if (dir.lengthSq() < 1e-8) return;
  dir.normalize();
  let right = new THREE.Vector3().crossVectors(dir, upHint);
  if (right.lengthSq() < 1e-6) right = new THREE.Vector3(1, 0, 0).cross(dir);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, dir).normalize();
  loft(raw, [rectRing(p, right, up, w / 2, h / 2), rectRing(q, right, up, w / 2, h / 2)], { capStart: true, capEnd: true });
}
