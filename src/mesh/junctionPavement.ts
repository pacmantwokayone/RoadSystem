// Mesh of the pavement corners around a junction patch: kerb face (towards the road), pavement top, and a skirt
// down to the terrain on the outer edge. Triangles are wound to agree with their intended normals.

import * as THREE from 'three';
import type { JunctionPatch, PavementStrip } from '../runtime/junctionRuntime';

export interface JunctionPavement {
  geometry: THREE.BufferGeometry;
  materials: string[];
}

const SKIRT_MARGIN_M = 0.3;
const MAX_SKIRT_M = 30;

export function buildJunctionPavements(patch: JunctionPatch): JunctionPavement | null {
  if (!patch.pavements.length) return null;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [];
  const index: number[] = [];
  // one group per (strip, role); groups sharing a material name share a material slot
  const groups: Array<{ start: number; count: number; material: string }> = [];

  const tmp = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const pushQuad = (list: number[], v0: number, v1: number, v2: number, v3: number, want: THREE.Vector3): void => {
    // quad (v0, v1) at the start, (v2, v3) at the end of a segment: (v0 v1 v2) (v1 v3 v2), flipped if it would face away
    const P = (i: number, o: THREE.Vector3): THREE.Vector3 => o.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    a.subVectors(P(v1, tmp), P(v0, c)); b.subVectors(P(v2, tmp), P(v0, c));
    const n = new THREE.Vector3().crossVectors(a, b);
    if (n.dot(want) >= 0) list.push(v0, v1, v2, v1, v3, v2); else list.push(v0, v2, v1, v1, v2, v3);
  };
  const vert = (x: number, y: number, z: number, n: THREE.Vector3, u: number, v: number): number => {
    pos.push(x, y, z); nrm.push(n.x, n.y, n.z); uv.push(u, v);
    return pos.length / 3 - 1;
  };

  const emit = (strip: PavementStrip): void => {
    const n = strip.inner.length;
    const up = new THREE.Vector3(0, 1, 0);
    // arc length along the strip for the v coordinate
    const arc = [0];
    for (let i = 1; i < n; i++) arc.push(arc[i - 1] + Math.hypot(strip.inner[i].x - strip.inner[i - 1].x, strip.inner[i].z - strip.inner[i - 1].z));
    const kerb: number[][] = [], top: number[][] = [], skirt: number[][] = [];
    const outN: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const P = strip.inner[i], Q = strip.outer[i];
      const dx = Q.x - P.x, dz = Q.z - P.z;
      const l = Math.hypot(dx, dz);
      outN.push(l > 1e-6 ? new THREE.Vector3(dx / l, 0, dz / l) : new THREE.Vector3(1, 0, 0));
    }
    for (let i = 0; i < n; i++) {
      const P = strip.inner[i], Q = strip.outer[i];
      const h = strip.heights[i], st = strip.steps[i], nOut = outN[i];
      const yTop = h + st;
      const w = Math.hypot(Q.x - P.x, Q.z - P.z);
      const inward = nOut.clone().multiplyScalar(-1);
      kerb.push([vert(P.x, h, P.z, inward, arc[i], 0), vert(P.x, yTop, P.z, inward, arc[i], st)]);
      top.push([vert(P.x, yTop, P.z, up, 0, arc[i]), vert(Q.x, yTop, Q.z, up, w, arc[i])]);
      const bottom = Math.max(Math.min(yTop - 0.5, strip.ground[i] - SKIRT_MARGIN_M), yTop - MAX_SKIRT_M);
      skirt.push([vert(Q.x, yTop, Q.z, nOut, arc[i], 0), vert(Q.x, bottom, Q.z, nOut, arc[i], yTop - bottom)]);
    }
    const listTop: number[] = [], listKerb: number[] = [], listSkirt: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const mid = outN[i].clone().add(outN[i + 1]).normalize();
      pushQuad(listTop, top[i][0], top[i][1], top[i + 1][0], top[i + 1][1], up);
      if (strip.steps[i] > 0.005 || strip.steps[i + 1] > 0.005) pushQuad(listKerb, kerb[i][0], kerb[i][1], kerb[i + 1][0], kerb[i + 1][1], mid.clone().multiplyScalar(-1));
      pushQuad(listSkirt, skirt[i][0], skirt[i][1], skirt[i + 1][0], skirt[i + 1][1], mid);
    }
    for (const [list, material] of [[listTop, strip.topMaterial], [listKerb, strip.curbMaterial], [listSkirt, 'subgrade']] as const) {
      if (!list.length) continue;
      groups.push({ start: index.length, count: list.length, material });
      for (const i of list) index.push(i);
    }
  };
  for (const s of patch.pavements) emit(s);
  if (!pos.length) return null;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aStrip', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
  const names: string[] = [];
  for (const gr of groups) {
    let mi = names.indexOf(gr.material);
    if (mi < 0) { names.push(gr.material); mi = names.length - 1; }
    g.addGroup(gr.start, gr.count, mi);
  }
  g.computeBoundingSphere();
  return { geometry: g, materials: names };
}
