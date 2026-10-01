// Turns ready chunks and junction patches into meshes. Subscribes to a RoadSystem: a mesh is built
// the moment its terrain has settled and removed when its road / junction goes away.
//
// When something is REPLACED (edited), the previous version's meshes stay visible until the new
// version is completely built, then they are disposed — so dragging a point or tweaking a profile
// never makes the road blink out.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadRuntime, RoadChunk } from '../runtime/roadRuntime';
import type { JunctionRuntime } from '../runtime/junctionRuntime';
import type { MaterialRegistry } from '../surface/materials';
import { buildChunkGeometry, DEFAULT_EXTRUDE_OPTIONS, type ExtrudeOptions } from './extrude';
import { buildJunctionGeometry } from './junctionMesh';
import { buildChunkMarkings } from './markings';

/** markings live in the same per-owner mesh map under an offset index */
const MARKING_INDEX = 1_000_000;

type Owner = RoadRuntime | JunctionRuntime;

export class RoadMeshLayer {
  readonly group = new THREE.Group();
  /** meshes per runtime (a runtime = one version of one road / junction) */
  private byRuntime = new Map<Owner, Map<number, THREE.Mesh>>();
  /** older versions still shown until the newest version with the same owner id is complete */
  private retired = new Map<string, Owner[]>();
  private readonly unsub: Array<() => void> = [];

  constructor(
    system: RoadSystem,
    private readonly materials: MaterialRegistry,
    private readonly extrude: ExtrudeOptions = DEFAULT_EXTRUDE_OPTIONS,
  ) {
    this.group.name = 'roads';
    this.unsub.push(system.onChunkReady((rt, chunk) => this.buildChunk(rt, chunk)));
    this.unsub.push(system.onRoadRemoved((rt) => this.removeOwner(`r:${rt.def.id}`)));
    this.unsub.push(system.onRoadReplaced((prev) => this.retire(`r:${prev.def.id}`, prev)));
    this.unsub.push(system.onJunctionReady((j) => this.buildJunction(j)));
    this.unsub.push(system.onJunctionRemoved((j) => this.removeOwner(`j:${j.id}`)));
    this.unsub.push(system.onJunctionReplaced((prev) => this.retire(`j:${prev.id}`, prev)));
  }

  get meshCount(): number {
    let n = 0;
    for (const m of this.byRuntime.values()) n += m.size;
    return n;
  }

  private ownerId(o: Owner): string {
    return 'def' in o ? `r:${o.def.id}` : `j:${o.id}`;
  }

  private retire(id: string, prev: Owner): void {
    const list = this.retired.get(id) ?? [];
    list.push(prev);
    this.retired.set(id, list);
  }

  private put(owner: Owner, index: number, geometry: THREE.BufferGeometry, names: string[]): void {
    let meshes = this.byRuntime.get(owner);
    if (!meshes) { meshes = new Map(); this.byRuntime.set(owner, meshes); }
    const mats = names.map((n) => this.materials.get(n));
    const old = meshes.get(index);
    if (old) {
      old.geometry.dispose();
      old.geometry = geometry;
      old.material = mats;
    } else {
      const mesh = new THREE.Mesh(geometry, mats);
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.name = `${this.ownerId(owner)}#${index}`;
      this.group.add(mesh);
      meshes.set(index, mesh);
    }
  }

  private buildChunk(rt: RoadRuntime, chunk: RoadChunk): void {
    const { geometry, materials } = buildChunkGeometry(rt, chunk, this.extrude);
    this.put(rt, chunk.index, geometry, materials);
    const marks = buildChunkMarkings(rt, chunk);
    if (marks) this.put(rt, MARKING_INDEX + chunk.index, marks.geometry, marks.materials);
    if (rt.pendingCount === 0) this.dropRetired(`r:${rt.def.id}`);
  }

  private buildJunction(j: JunctionRuntime): void {
    if (!j.patch) return;
    const { geometry, materials } = buildJunctionGeometry(j.patch);
    this.put(j, 0, geometry, materials);
    this.dropRetired(`j:${j.id}`);
  }

  private dropRetired(id: string): void {
    for (const prev of this.retired.get(id) ?? []) this.disposeOwner(prev);
    this.retired.delete(id);
  }

  private disposeOwner(o: Owner): void {
    const meshes = this.byRuntime.get(o);
    if (!meshes) return;
    for (const m of meshes.values()) { m.geometry.dispose(); this.group.remove(m); }
    this.byRuntime.delete(o);
  }

  private removeOwner(id: string): void {
    this.dropRetired(id);
    for (const o of [...this.byRuntime.keys()]) if (this.ownerId(o) === id) this.disposeOwner(o);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const o of [...this.byRuntime.keys()]) this.disposeOwner(o);
    this.retired.clear();
    this.group.clear();
  }
}
