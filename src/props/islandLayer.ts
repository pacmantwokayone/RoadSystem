// The island in the middle of every roundabout: a kerbed grass disc with a tree and some shrubs. Islands are not stored — they are found
// in the network (`findRoundabouts`) and rebuilt whenever the roads change; built once the terrain under them has settled.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { TerrainSource } from '../core/terrain';
import { findRoundabouts, type FoundRoundabout } from '../network/roundabout';
import { hash01 } from './rules';
import type { PropAssets } from './assets';
import type { PropMaterials } from './materials';
import { GeometryBatch } from './batch';

const KERB_H = 0.14;

export class IslandLayer {
  readonly group = new THREE.Group();
  private key = '';
  private built: THREE.Object3D[] = [];
  private pending: FoundRoundabout[] = [];
  private readonly grass = new THREE.MeshLambertMaterial({ color: 0x5f8a45 });
  private readonly granite = new THREE.MeshLambertMaterial({ color: 0xa8a8a2 });
  private readonly shrub = new THREE.IcosahedronGeometry(1, 1);

  constructor(
    private readonly system: RoadSystem,
    private readonly terrain: TerrainSource,
    private readonly assets: PropAssets,
    private readonly materials: PropMaterials,
  ) {
    this.group.name = 'roundabout-islands';
  }

  private signature(): string {
    return this.system.runtimes.filter((r) => r.def.profile === 'kreisel').map((r) => `${r.def.id}:${r.def.points.length}:${r.def.points[0].x.toFixed(1)}:${r.def.points[0].z.toFixed(1)}`).join('|');
  }

  /** call once per frame (cheap when nothing changed) */
  update(): void {
    const sig = this.signature();
    if (sig !== this.key) {
      this.key = sig;
      this.clear();
      this.pending = findRoundabouts(this.system.runtimes.map((r) => r.def));
    }
    if (!this.pending.length) return;
    this.pending = this.pending.filter((rb) => !this.tryBuild(rb));
  }

  private tryBuild(rb: FoundRoundabout): boolean {
    const h = this.terrain.heightAt(rb.x, rb.z);
    if (h === null || !this.terrain.isSettledAt(rb.x, rb.z)) return false;
    const r = Math.max(2, rb.radius - 4.6 - 0.3);
    const top = h + KERB_H;
    const g = new THREE.Group();
    // granite kerb ring and the grass inside it (both reach below ground so a slope never shows a gap)
    const kerb = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.3, r + 0.3, 1.2, 40), this.granite);
    kerb.position.set(rb.x, top - 0.6, -rb.z);
    const lawn = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.2, 40), this.grass);
    lawn.position.set(rb.x, top - 0.6 + 0.07, -rb.z);
    g.add(kerb, lawn);
    // a tree in the middle, shrubs around it
    const batch = new GeometryBatch();
    const tree = this.assets.has('tree_linden') ? 'tree_linden' : undefined;
    const m = new THREE.Matrix4();
    if (tree) {
      m.compose(new THREE.Vector3(rb.x, top + 0.07, -rb.z), new THREE.Quaternion(), new THREE.Vector3(1.5, 1.5, 1.5));
      for (const part of this.assets.parts(tree)) batch.addGeometry(part.material, part.geometry, m);
    }
    const n = Math.max(5, Math.round(r * 1.1));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (hash01(k, 3, 5) - 0.5) * 0.4;
      const rr = r * (0.55 + 0.3 * hash01(k, 4, 5));
      const s = 0.5 + 0.7 * hash01(k, 5, 5);
      m.compose(new THREE.Vector3(rb.x + Math.cos(a) * rr, top + s * 0.35, -(rb.z + Math.sin(a) * rr)), new THREE.Quaternion(), new THREE.Vector3(s * 1.2, s * 0.8, s * 1.2));
      batch.addGeometry('foliage', this.shrub, m);
    }
    const built = batch.build();
    if (built) {
      const mesh = new THREE.Mesh(built.geometry, built.materials.map((name) => this.materials.get(name)));
      mesh.castShadow = true;
      g.add(mesh);
    }
    g.name = `island@${rb.x.toFixed(0)},${rb.z.toFixed(0)}`;
    this.group.add(g);
    this.built.push(g);
    return true;
  }

  private clear(): void {
    for (const o of this.built) {
      this.group.remove(o);
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh && m.geometry && m.geometry !== this.shrub) m.geometry.dispose(); });
    }
    this.built = [];
  }

  dispose(): void {
    this.clear();
    this.grass.dispose(); this.granite.dispose(); this.shrub.dispose();
    this.group.clear();
  }
}
