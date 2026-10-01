// Turns ready road chunks of railway profiles into rail meshes (sleepers, rails, overhead line, signals). Same idiom as TunnelLayer /
// BridgeLayer: one merged mesh per chunk, a replaced road keeps its old track visible until the new one is complete, far chunks are hidden.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { PropMaterials } from '../props/materials';
import { buildChunkRail } from './geometry';

export interface RailLayerOptions {
  drawDistance: number;
}

export class RailLayer {
  readonly group = new THREE.Group();
  private readonly byRuntime = new Map<RoadRuntime, Map<number, THREE.Mesh>>();
  private readonly retired = new Map<string, RoadRuntime[]>();
  private readonly unsub: Array<() => void> = [];
  private readonly opts: RailLayerOptions;
  private stats = { sleepers: 0, masts: 0, signals: 0 };

  constructor(system: RoadSystem, private readonly materials: PropMaterials = new PropMaterials(), opts: Partial<RailLayerOptions> = {}) {
    this.opts = { drawDistance: 900, ...opts };
    this.group.name = 'road-rails';
    this.unsub.push(system.onChunkReady((rt, chunk) => this.buildChunk(rt, chunk)));
    this.unsub.push(system.onRoadRemoved((rt) => this.removeOwner(rt.def.id)));
    this.unsub.push(system.onRoadReplaced((prev) => { const l = this.retired.get(prev.def.id) ?? []; l.push(prev); this.retired.set(prev.def.id, l); }));
  }

  get meshCount(): number {
    let n = 0;
    for (const m of this.byRuntime.values()) n += m.size;
    return n;
  }

  /** what has been built so far (diagnostics, tests) */
  get counts(): { sleepers: number; masts: number; signals: number } {
    return { ...this.stats };
  }

  private buildChunk(rt: RoadRuntime, chunk: RoadChunk): void {
    const built = buildChunkRail(rt, chunk);
    if (!built) { if (rt.pendingCount === 0) this.dropRetired(rt.def.id); return; }
    let entries = this.byRuntime.get(rt);
    if (!entries) { entries = new Map(); this.byRuntime.set(rt, entries); }
    const old = entries.get(chunk.index);
    if (old) { old.geometry.dispose(); this.group.remove(old); entries.delete(chunk.index); }
    const g = built.batch.build();
    if (g) {
      const mesh = new THREE.Mesh(g.geometry, g.materials.map((n) => this.materials.get(n)));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `rail:${rt.def.id}#${chunk.index}`;
      this.group.add(mesh);
      entries.set(chunk.index, mesh);
    }
    this.stats.sleepers += built.sleepers; this.stats.masts += built.masts; this.stats.signals += built.signals;
    if (rt.pendingCount === 0) this.dropRetired(rt.def.id);
  }

  /** hides chunks further than `drawDistance` from the camera */
  update(camera: THREE.Vector3 | THREE.Object3D): void {
    const c = camera instanceof THREE.Vector3 ? camera : camera.getWorldPosition(new THREE.Vector3());
    for (const entries of this.byRuntime.values()) for (const mesh of entries.values()) {
      const bs = mesh.geometry.boundingSphere;
      mesh.visible = !bs || bs.center.distanceTo(c) - bs.radius < this.opts.drawDistance;
    }
  }

  private dropRetired(id: string): void {
    for (const prev of this.retired.get(id) ?? []) this.disposeOwner(prev);
    this.retired.delete(id);
  }

  private disposeOwner(rt: RoadRuntime): void {
    const entries = this.byRuntime.get(rt);
    if (!entries) return;
    for (const m of entries.values()) { m.geometry.dispose(); this.group.remove(m); }
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
  }
}
