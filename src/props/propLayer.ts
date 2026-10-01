// Turns ready chunks (and junctions) into prop meshes. Mirrors RoadMeshLayer: a mesh is built the
// moment its chunk is ready, a REPLACED road keeps its old props visible until the new version is
// complete, and everything is disposed with its road.
//
// One merged mesh per chunk (all props + rails, one group per material). `update(camera)` hides chunks
// beyond `drawDistance`, so far-away roads cost nothing.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import type { JunctionRuntime } from '../runtime/junctionRuntime';
import { PropAssets } from './assets';
import { GeometryBatch } from './batch';
import { buildRail } from './guardrail';
import { PropMaterials } from './materials';
import { placeChunk, type Placement, type RailRun } from './place';
import { DEFAULT_JUNCTION_SIGNS, placeJunctionSigns, type JunctionSignOptions } from './junctionSigns';

type Owner = RoadRuntime | JunctionRuntime;

export interface PropLayerOptions {
  /** chunks whose bounding sphere is further than this from the camera are hidden, metres */
  drawDistance: number;
  castShadow: boolean;
  junctionSigns: JunctionSignOptions | false;
}

export const DEFAULT_PROP_LAYER_OPTIONS: PropLayerOptions = { drawDistance: 700, castShadow: true, junctionSigns: DEFAULT_JUNCTION_SIGNS };

interface Entry {
  mesh: THREE.Mesh;
  placements: Placement[];
  rails: RailRun[];
}

export function placementMatrix(p: Placement, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.compose(p.pos, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), new THREE.Vector3(p.scale, p.scale, p.scale));
}

export class PropLayer {
  readonly group = new THREE.Group();
  readonly materials: PropMaterials;
  readonly assets: PropAssets;
  private readonly byRuntime = new Map<Owner, Map<number, Entry>>();
  private readonly retired = new Map<string, Owner[]>();
  private readonly unsub: Array<() => void> = [];
  private readonly opts: PropLayerOptions;

  constructor(
    system: RoadSystem,
    opts: Partial<PropLayerOptions> = {},
    materials: PropMaterials = new PropMaterials(),
    assets: PropAssets = new PropAssets(),
  ) {
    this.opts = { ...DEFAULT_PROP_LAYER_OPTIONS, ...opts };
    this.materials = materials;
    this.assets = assets;
    this.group.name = 'road-props';
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

  /** every placement currently shown (gameplay queries, tests) */
  allPlacements(): Placement[] {
    const out: Placement[] = [];
    for (const m of this.byRuntime.values()) for (const e of m.values()) out.push(...e.placements);
    return out;
  }

  placementsOf(ownerId: string): Placement[] {
    const out: Placement[] = [];
    for (const [o, m] of this.byRuntime) if (this.ownerId(o) === ownerId) for (const e of m.values()) out.push(...e.placements);
    return out;
  }

  railRuns(): RailRun[] {
    const out: RailRun[] = [];
    for (const m of this.byRuntime.values()) for (const e of m.values()) out.push(...e.rails);
    return out;
  }

  /** hides props of chunks further than `drawDistance` from the camera */
  update(camera: THREE.Vector3 | THREE.Object3D): void {
    const c = camera instanceof THREE.Vector3 ? camera : camera.getWorldPosition(new THREE.Vector3());
    for (const m of this.byRuntime.values()) {
      for (const e of m.values()) {
        const bs = e.mesh.geometry.boundingSphere;
        e.mesh.visible = !bs || bs.center.distanceTo(c) - bs.radius < this.opts.drawDistance;
      }
    }
  }

  /** Re-creates all meshes (after assets or materials were replaced). */
  rebuildAll(system: RoadSystem): void {
    for (const o of [...this.byRuntime.keys()]) this.disposeOwner(o);
    this.retired.clear();
    for (const rt of system.runtimes) for (const ch of rt.chunks) if (ch.state === 'ready') this.buildChunk(rt, ch);
    for (const j of system.junctions) if (j.state === 'ready') this.buildJunction(j);
  }

  private ownerId(o: Owner): string {
    return 'def' in o ? `r:${o.def.id}` : `j:${o.id}`;
  }

  private retire(id: string, prev: Owner): void {
    const list = this.retired.get(id) ?? [];
    list.push(prev);
    this.retired.set(id, list);
  }

  private put(owner: Owner, index: number, batch: GeometryBatch, placements: Placement[], rails: RailRun[]): void {
    let entries = this.byRuntime.get(owner);
    if (!entries) { entries = new Map(); this.byRuntime.set(owner, entries); }
    const built = batch.build();
    const old = entries.get(index);
    if (old) { old.mesh.geometry.dispose(); this.group.remove(old.mesh); entries.delete(index); }
    if (!built) return;
    const mesh = new THREE.Mesh(built.geometry, built.materials.map((m) => this.materials.get(m)));
    mesh.castShadow = this.opts.castShadow;
    mesh.receiveShadow = true;
    mesh.name = `props:${this.ownerId(owner)}#${index}`;
    this.group.add(mesh);
    entries.set(index, { mesh, placements, rails });
  }

  private addPlacements(batch: GeometryBatch, placements: readonly Placement[]): void {
    const m = new THREE.Matrix4();
    for (const p of placements) {
      placementMatrix(p, m);
      for (const part of this.assets.parts(p.asset)) batch.addGeometry(part.material, part.geometry, m);
    }
  }

  private buildChunk(rt: RoadRuntime, chunk: RoadChunk): void {
    const props = placeChunk(rt, chunk);
    const batch = new GeometryBatch();
    this.addPlacements(batch, props.placements);
    if (props.sampler) for (const run of props.rails) buildRail(props.sampler, run, batch);
    this.put(rt, chunk.index, batch, props.placements, props.rails);
    if (rt.pendingCount === 0) this.dropRetired(`r:${rt.def.id}`);
  }

  private buildJunction(j: JunctionRuntime): void {
    if (this.opts.junctionSigns) {
      const placements = placeJunctionSigns(j, this.opts.junctionSigns);
      const batch = new GeometryBatch();
      this.addPlacements(batch, placements);
      this.put(j, 0, batch, placements, []);
    }
    this.dropRetired(`j:${j.id}`);
  }

  private dropRetired(id: string): void {
    for (const prev of this.retired.get(id) ?? []) this.disposeOwner(prev);
    this.retired.delete(id);
  }

  private disposeOwner(o: Owner): void {
    const entries = this.byRuntime.get(o);
    if (!entries) return;
    for (const e of entries.values()) { e.mesh.geometry.dispose(); this.group.remove(e.mesh); }
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
    this.assets.dispose();
    this.materials.dispose();
  }
}
