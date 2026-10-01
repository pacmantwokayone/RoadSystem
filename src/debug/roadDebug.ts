// Debug visualisation for the Phase 1 slice (no road mesh yet): each chunk's
// centreline as a polyline — RED at the terrain's current (possibly coarse
// fallback) height while the chunk is pending, GREEN at its final design height
// once the terrain under it has settled. Watching red lines turn green while
// tiles stream in is exactly the settle-before-build behaviour.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadRuntime, RoadChunk } from '../runtime/roadRuntime';
import type { TerrainSource } from '../core/terrain';

const LIFT_M = 0.6;

export class RoadDebugLayer {
  readonly group = new THREE.Group();
  private lines = new Map<string, { line: THREE.Line; ready: boolean }>();
  private frame = 0;
  private readonly pendingMat = new THREE.LineBasicMaterial({ color: 0xff4040 });
  private readonly readyMat = new THREE.LineBasicMaterial({ color: 0x40ff70 });
  private readonly fixedMat = new THREE.LineBasicMaterial({ color: 0x40a0ff });

  constructor(private readonly system: RoadSystem, private readonly terrain: TerrainSource) {}

  /** Call once per frame (after RoadSystem.resync()). */
  update(): void {
    this.frame++;
    const refreshPending = this.frame % 20 === 0;
    for (const rt of this.system.runtimes) {
      for (const chunk of rt.chunks) {
        const id = `${rt.def.id}#${chunk.index}`;
        const cur = this.lines.get(id);
        const ready = chunk.state === 'ready';
        if (cur && cur.ready === ready && (ready || !refreshPending)) continue;
        if (cur) { this.group.remove(cur.line); cur.line.geometry.dispose(); }
        const line = this.build(rt, chunk, ready);
        this.group.add(line);
        this.lines.set(id, { line, ready });
      }
    }
  }

  private build(rt: RoadRuntime, chunk: RoadChunk, ready: boolean): THREE.Line {
    const pts: THREE.Vector3[] = [];
    let anyBridge = false;
    for (let i = chunk.i0; i <= chunk.i1; i++) {
      const s = rt.samples[i];
      const y = ready
        ? rt.designY[i]
        : (this.terrain.heightAt(s.pos.x, -s.pos.z) ?? s.pos.y);
      if (s.mode !== 'road') anyBridge = true;
      pts.push(new THREE.Vector3(s.pos.x, y + LIFT_M, s.pos.z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = !ready ? this.pendingMat : anyBridge ? this.fixedMat : this.readyMat;
    return new THREE.Line(geo, mat);
  }

  dispose(): void {
    for (const { line } of this.lines.values()) line.geometry.dispose();
    this.pendingMat.dispose(); this.readyMat.dispose(); this.fixedMat.dispose();
    this.group.clear();
    this.lines.clear();
  }
}
