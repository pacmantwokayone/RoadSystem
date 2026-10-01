// Turns ready road chunks into tunnel meshes (lining + portals). Same idiom as BridgeLayer: one merged mesh per chunk, a replaced road keeps
// its old tunnel visible until the new one is complete, chunks whose terrain wasn't known yet are retried.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { PropMaterials } from '../props/materials';
import { buildChunkTunnel } from './geometry';

export interface TunnelLayerOptions {
  drawDistance: number;
  retryEvery: number;
}

interface Entry {
  mesh: THREE.Mesh | null;
  complete: boolean;
}

export class TunnelLayer {
  readonly group = new THREE.Group();
  private readonly byRuntime = new Map<RoadRuntime, Map<number, Entry>>();
  private readonly retired = new Map<string, RoadRuntime[]>();
  private readonly unsub: Array<() => void> = [];
  private frame = 0;
  private readonly opts: TunnelLayerOptions;

  constructor(system: RoadSystem, private readonly materials: PropMaterials = new PropMaterials(), opts: Partial<TunnelLayerOptions> = {}) {
    this.opts = { drawDistance: 1600, retryEvery: 20, ...opts };
    this.group.name = 'road-tunnels';
    this.unsub.push(system.onChunkReady((rt, chunk) => this.buildChunk(rt, chunk)));
    this.unsub.push(system.onRoadRemoved((rt) => this.removeOwner(rt.def.id)));
    this.unsub.push(system.onRoadReplaced((prev) => { const l = this.retired.get(prev.def.id) ?? []; l.push(prev); this.retired.set(prev.def.id, l); }));
  }

  get meshCount(): number {
    let n = 0;
    for (const m of this.byRuntime.values()) for (const e of m.values()) if (e.mesh) n++;
    return n;
  }

  private buildChunk(rt: RoadRuntime, chunk: RoadChunk): void {
    const built = buildChunkTunnel(rt, chunk);
    let entries = this.byRuntime.get(rt);
    if (!entries) { entries = new Map(); this.byRuntime.set(rt, entries); }
    const old = entries.get(chunk.index);
    if (old?.mesh) { old.mesh.geometry.dispose(); this.group.remove(old.mesh); }
    entries.delete(chunk.index);
    if (built) {
      const g = built.batch.build();
      let mesh: THREE.Mesh | null = null;
      if (g) {
        mesh = new THREE.Mesh(g.geometry, g.materials.map((n) => this.materials.get(n)));
        mesh.receiveShadow = true;
        mesh.name = `tunnel:${rt.def.id}#${chunk.index}`;
        this.group.add(mesh);
      }
      entries.set(chunk.index, { mesh, complete: built.complete });
    }
    if (rt.pendingCount === 0) this.dropRetired(rt.def.id);
  }

  update(camera?: THREE.Vector3 | THREE.Object3D): void {
    if (++this.frame % this.opts.retryEvery === 0) {
      for (const [rt, entries] of this.byRuntime) for (const [index, e] of [...entries]) if (!e.complete && rt.chunks[index]?.state === 'ready') this.buildChunk(rt, rt.chunks[index]);
    }
    if (!camera) return;
    const c = camera instanceof THREE.Vector3 ? camera : camera.getWorldPosition(new THREE.Vector3());
    for (const entries of this.byRuntime.values()) for (const e of entries.values()) {
      if (!e.mesh) continue;
      const bs = e.mesh.geometry.boundingSphere;
      e.mesh.visible = !bs || bs.center.distanceTo(c) - bs.radius < this.opts.drawDistance;
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
  }
}
