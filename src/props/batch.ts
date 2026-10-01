// Collects geometry per material name and merges it into ONE BufferGeometry with one group per material.
// Props are baked into chunk meshes (a few hundred small meshes would cost far more draw calls than the
// triangles are worth); instancing is the next step if the prop count per chunk ever grows large.

import * as THREE from 'three';

interface Acc {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

export class GeometryBatch {
  private readonly byMat = new Map<string, Acc>();

  private acc(material: string): Acc {
    let a = this.byMat.get(material);
    if (!a) { a = { pos: [], nrm: [], uv: [], idx: [] }; this.byMat.set(material, a); }
    return a;
  }

  get empty(): boolean {
    return this.byMat.size === 0;
  }

  /** Appends a (non-indexed or indexed) geometry transformed by `m`. */
  addGeometry(material: string, g: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const a = this.acc(material);
    const base = a.pos.length / 3;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      a.pos.push(v.x, v.y, v.z);
      if (nrm) { v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize(); a.nrm.push(v.x, v.y, v.z); } else a.nrm.push(0, 1, 0);
      if (uv) a.uv.push(uv.getX(i), uv.getY(i)); else a.uv.push(0, 0);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) a.idx.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) a.idx.push(base + i);
  }

  /** Appends one triangle strip-free quad/triangle list directly (used by the guardrail extrusion). */
  addRaw(material: string): { vertex(p: THREE.Vector3, n: THREE.Vector3, u?: number, v?: number): number; tri(a: number, b: number, c: number): void } {
    const a = this.acc(material);
    return {
      vertex: (p, n, u = 0, v = 0) => {
        a.pos.push(p.x, p.y, p.z); a.nrm.push(n.x, n.y, n.z); a.uv.push(u, v);
        return a.pos.length / 3 - 1;
      },
      tri: (x, y, z) => { a.idx.push(x, y, z); },
    };
  }

  /** The merged geometry and the material name of each group. */
  build(): { geometry: THREE.BufferGeometry; materials: string[] } | null {
    if (!this.byMat.size) return null;
    const materials = [...this.byMat.keys()];
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    const groups: Array<{ start: number; count: number; mi: number }> = [];
    materials.forEach((m, mi) => {
      const a = this.byMat.get(m)!;
      const base = pos.length / 3;
      for (const v of a.pos) pos.push(v);
      for (const v of a.nrm) nrm.push(v);
      for (const v of a.uv) uv.push(v);
      const start = idx.length;
      for (const i of a.idx) idx.push(base + i);
      groups.push({ start, count: idx.length - start, mi });
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mi);
    g.computeBoundingSphere();
    return { geometry: g, materials };
  }
}
