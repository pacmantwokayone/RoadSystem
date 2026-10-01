// Turns ready chunks into meshes. Subscribes to a RoadSystem: a mesh is built
// the moment its chunk's terrain has settled and removed when its road goes away.
//
// When a road is REPLACED (edited), the previous version's meshes stay visible
// until the new version is completely built, then they are disposed — so
// dragging a point or tweaking a profile never makes the road blink out.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadRuntime, RoadChunk } from '../runtime/roadRuntime';
import type { MaterialRegistry } from '../surface/materials';
import { buildChunkGeometry, DEFAULT_EXTRUDE_OPTIONS, type ExtrudeOptions } from './extrude';

export class RoadMeshLayer {
  readonly group = new THREE.Group();
  /** meshes per runtime (a runtime = one version of one road) */
  private byRuntime = new Map<RoadRuntime, Map<number, THREE.Mesh>>();
  /** older versions still shown until the newest version of the same road is complete */
  private retired = new Map<string, RoadRuntime[]>();
  private readonly unsub: Array<() => void> = [];

  constructor(
    system: RoadSystem,
    private readonly materials: MaterialRegistry,
    private readonly extrude: ExtrudeOptions = DEFAULT_EXTRUDE_OPTIONS,
  ) {
    this.group.name = 'roads';
    this.unsub.push(system.onChunkReady((rt, chunk) => this.build(rt, chunk)));
    this.unsub.push(system.onRoadRemoved((rt) => this.removeRoad(rt.def.id)));
    this.unsub.push(system.onRoadReplaced((prev) => {
      const list = this.retired.get(prev.def.id) ?? [];
      list.push(prev);
      this.retired.set(prev.def.id, list);
    }));
  }

  get meshCount(): number {
    let n = 0;
    for (const m of this.byRuntime.values()) n += m.size;
    return n;
  }

  private build(rt: RoadRuntime, chunk: RoadChunk): void {
    let meshes = this.byRuntime.get(rt);
    if (!meshes) { meshes = new Map(); this.byRuntime.set(rt, meshes); }
    const { geometry, materials } = buildChunkGeometry(rt, chunk, this.extrude);
    const mats = materials.map((n) => this.materials.get(n));
    const old = meshes.get(chunk.index);
    if (old) {
      old.geometry.dispose();
      old.geometry = geometry;
      old.material = mats;
    } else {
      const mesh = new THREE.Mesh(geometry, mats);
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.name = `${rt.def.id}#${chunk.index}`;
      this.group.add(mesh);
      meshes.set(chunk.index, mesh);
    }
    // newest version complete → drop the versions it replaced
    if (rt.pendingCount === 0) this.dropRetired(rt.def.id);
  }

  private dropRetired(roadId: string): void {
    for (const prev of this.retired.get(roadId) ?? []) this.disposeRuntime(prev);
    this.retired.delete(roadId);
  }

  private disposeRuntime(rt: RoadRuntime): void {
    const meshes = this.byRuntime.get(rt);
    if (!meshes) return;
    for (const m of meshes.values()) { m.geometry.dispose(); this.group.remove(m); }
    this.byRuntime.delete(rt);
  }

  private removeRoad(roadId: string): void {
    this.dropRetired(roadId);
    for (const rt of [...this.byRuntime.keys()]) if (rt.def.id === roadId) this.disposeRuntime(rt);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const rt of [...this.byRuntime.keys()]) this.disposeRuntime(rt);
    this.retired.clear();
    this.group.clear();
  }
}
