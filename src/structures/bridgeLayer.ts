// Turns ready road chunks into bridge structure meshes (everything except the deck, which is part of the road mesh).
// Mirrors PropLayer: one merged mesh per chunk, a REPLACED road keeps its old structure visible until the new version is
// complete, removal disposes. Chunks whose terrain wasn't known yet (pier feet) are retried from `update()`.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import type { MaterialRegistry } from '../surface/materials';
import { PropAssets } from '../props/assets';
import { GeometryBatch } from '../props/batch';
import { PropMaterials } from '../props/materials';
import { placementMatrix } from '../props/propLayer';
import type { Placement } from '../props/place';
import { buildChunkBridge } from './bridgeGeometry';

export interface BridgeLayerOptions {
  drawDistance: number;
  castShadow: boolean;
  /** frames between retries of chunks with incomplete terrain */
  retryEvery: number;
}

export const DEFAULT_BRIDGE_LAYER_OPTIONS: BridgeLayerOptions = { drawDistance: 1500, castShadow: true, retryEvery: 20 };

interface Entry {
  mesh: THREE.Mesh | null;
  placements: Placement[];
  complete: boolean;
}

export class BridgeLayer {
  readonly group = new THREE.Group();
  readonly propMaterials: PropMaterials;
  readonly assets: PropAssets;
  private readonly byRuntime = new Map<RoadRuntime, Map<number, Entry>>();
  private readonly retired = new Map<string, RoadRuntime[]>();
  private readonly unsub: Array<() => void> = [];
  private readonly opts: BridgeLayerOptions;
  private frame = 0;

  constructor(
    system: RoadSystem,
    private readonly roadMaterials: MaterialRegistry,
    opts: Partial<BridgeLayerOptions> = {},
    propMaterials: PropMaterials = new PropMaterials(),
    assets: PropAssets = new PropAssets(),
  ) {
    this.opts = { ...DEFAULT_BRIDGE_LAYER_OPTIONS, ...opts };
    this.propMaterials = propMaterials;
    this.assets = assets;
    this.group.name = 'road-bridges';
    this.unsub.push(system.onChunkReady((rt, chunk) => this.buildChunk(rt, chunk)));
    this.unsub.push(system.onRoadRemoved((rt) => this.removeOwner(rt.def.id)));
    this.unsub.push(system.onRoadReplaced((prev) => this.retire(prev.def.id, prev)));
  }

  get meshCount(): number {
    let n = 0;
    for (const m of this.byRuntime.values()) for (const e of m.values()) if (e.mesh) n++;
    return n;
  }

  /** chunks waiting for terrain */
  get pendingCount(): number {
    let n = 0;
    for (const m of this.byRuntime.values()) for (const e of m.values()) if (!e.complete) n++;
    return n;
  }

  placementsOf(roadId: string): Placement[] {
    const out: Placement[] = [];
    for (const [rt, m] of this.byRuntime) if (rt.def.id === roadId) for (const e of m.values()) out.push(...e.placements);
    return out;
  }

  private material(name: string): THREE.Material {
    return this.propMaterials.has(name) ? this.propMaterials.get(name) : this.roadMaterials.get(name);
  }

  private retire(id: string, prev: RoadRuntime): void {
    const list = this.retired.get(id) ?? [];
    list.push(prev);
    this.retired.set(id, list);
  }

  private buildChunk(rt: RoadRuntime, chunk: RoadChunk): void {
    const built = buildChunkBridge(rt, chunk);
    let entries = this.byRuntime.get(rt);
    if (!entries) { entries = new Map(); this.byRuntime.set(rt, entries); }
    const old = entries.get(chunk.index);
    if (old?.mesh) { old.mesh.geometry.dispose(); this.group.remove(old.mesh); }
    entries.delete(chunk.index);
    if (built) {
      const batch: GeometryBatch = built.batch;
      const m = new THREE.Matrix4();
      for (const p of built.placements) {
        placementMatrix(p, m);
        for (const part of this.assets.parts(p.asset)) batch.addGeometry(part.material, part.geometry, m);
      }
      const g = batch.build();
      let mesh: THREE.Mesh | null = null;
      if (g) {
        mesh = new THREE.Mesh(g.geometry, g.materials.map((n) => this.material(n)));
        mesh.castShadow = this.opts.castShadow;
        mesh.receiveShadow = true;
        mesh.name = `bridge:${rt.def.id}#${chunk.index}`;
        this.group.add(mesh);
      }
      entries.set(chunk.index, { mesh, placements: built.placements, complete: built.complete });
    }
    if (rt.pendingCount === 0) this.dropRetired(rt.def.id);
  }

  /** Retries chunks that were built before all their terrain was known; hides far chunks. */
  update(camera?: THREE.Vector3 | THREE.Object3D): void {
    if (++this.frame % this.opts.retryEvery === 0) {
      for (const [rt, entries] of this.byRuntime) {
        for (const [index, e] of [...entries]) if (!e.complete && rt.chunks[index]?.state === 'ready') this.buildChunk(rt, rt.chunks[index]);
      }
    }
    if (!camera) return;
    const c = camera instanceof THREE.Vector3 ? camera : camera.getWorldPosition(new THREE.Vector3());
    for (const entries of this.byRuntime.values()) {
      for (const e of entries.values()) {
        if (!e.mesh) continue;
        const bs = e.mesh.geometry.boundingSphere;
        e.mesh.visible = !bs || bs.center.distanceTo(c) - bs.radius < this.opts.drawDistance;
      }
    }
  }

  private dropRetired(id: string): void {
    for (const prev of this.retired.get(id) ?? []) this.disposeOwner(prev);
    this.retired.delete(id);
  }

  private disposeOwner(rt: RoadRuntime): void {
    const entries = this.byRuntime.get(rt);
    if (!entries) return;
    for (const e of entries.values()) if (e.mesh) { e.mesh.geometry.dispose(); this.group.remove(e.mesh); }
    this.byRuntime.delete(rt);
  }

  private removeOwner(id: string): void {
    this.dropRetired(id);
    for (const rt of [...this.byRuntime.keys()]) if (rt.def.id === id) this.disposeOwner(rt);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const rt of [...this.byRuntime.keys()]) this.disposeOwner(rt);
    this.retired.clear();
    this.group.clear();
    this.assets.dispose();
    this.propMaterials.dispose();
  }
}
