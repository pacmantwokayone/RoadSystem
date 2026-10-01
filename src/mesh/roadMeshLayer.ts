// Turns ready chunks into meshes. Subscribes to a RoadSystem: a mesh is built
// the moment its chunk's terrain has settled and removed when its road goes away.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadRuntime, RoadChunk } from '../runtime/roadRuntime';
import type { MaterialRegistry } from '../surface/materials';
import { buildChunkGeometry, DEFAULT_EXTRUDE_OPTIONS, type ExtrudeOptions } from './extrude';

export class RoadMeshLayer {
  readonly group = new THREE.Group();
  private meshes = new Map<string, THREE.Mesh>();
  private readonly unsub: Array<() => void> = [];

  constructor(
    system: RoadSystem,
    private readonly materials: MaterialRegistry,
    private readonly extrude: ExtrudeOptions = DEFAULT_EXTRUDE_OPTIONS,
  ) {
    this.group.name = 'roads';
    this.unsub.push(system.onChunkReady((rt, chunk) => this.build(rt, chunk)));
    this.unsub.push(system.onRoadRemoved((rt) => this.removeRoad(rt)));
  }

  get meshCount(): number {
    return this.meshes.size;
  }

  private key(rt: RoadRuntime, chunk: RoadChunk): string {
    return `${rt.def.id}#${chunk.index}`;
  }

  private build(rt: RoadRuntime, chunk: RoadChunk): void {
    const k = this.key(rt, chunk);
    this.meshes.get(k)?.geometry.dispose();
    const { geometry, materials } = buildChunkGeometry(rt, chunk, this.extrude);
    const mats = materials.map((n) => this.materials.get(n));
    let mesh = this.meshes.get(k);
    if (mesh) {
      mesh.geometry = geometry;
      mesh.material = mats;
    } else {
      mesh = new THREE.Mesh(geometry, mats);
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.name = k;
      this.group.add(mesh);
      this.meshes.set(k, mesh);
    }
  }

  private removeRoad(rt: RoadRuntime): void {
    for (const chunk of rt.chunks) {
      const k = this.key(rt, chunk);
      const mesh = this.meshes.get(k);
      if (!mesh) continue;
      mesh.geometry.dispose();
      this.group.remove(mesh);
      this.meshes.delete(k);
    }
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const m of this.meshes.values()) m.geometry.dispose();
    this.meshes.clear();
    this.group.clear();
  }
}
