// Turns ready water chunks into meshes. Same idiom as RoadMeshLayer / PropLayer: a mesh is built the moment its chunk is ready,
// a REPLACED river or lake keeps its old meshes until the new version is complete, everything is disposed with its owner.
//
// One owner = one river version or one lake version. Per river chunk: the water ribbon (own material, because the foam obstacles
// differ per chunk), the bed/bank strip (road MaterialRegistry material), merged boulders. Per fall: the sheet and the plunge pool.

import * as THREE from 'three';
import type { MaterialRegistry } from '../surface/materials';
import { GeometryBatch } from '../props/batch';
import type { LakeRuntime, RiverRuntime, WaterChunk, WaterSystem, WaterTerrain } from './system';
import { createWaterMaterial, makeWaterShared, setObstacles, type WaterShared } from './waterMaterial';
import { buildRiverChunk, type ExternalObstacle } from './riverMesh';
import { buildFallSheet, buildPoolDisc, poolRadius } from './fallMesh';
import { buildLake } from './lakeMesh';
import { rockGeometry, rockMatrix, type RockPlacement } from './rocks';
import { WaterParticles, type FallEmitter, type ParticleOptions } from './particles';
import type { WaterStyle } from './style';

export interface WaterLayerOptions {
  /** meshes whose bounding sphere is further than this from the camera are hidden, metres */
  drawDistance: number;
  /** false = no flow particles / spray (cheap preview) */
  particles: boolean;
  particleOptions?: Partial<ParticleOptions>;
  /** things standing in the water (bridge piers …) per river id, THREE space */
  externalObstacles?: (riverId: string) => readonly ExternalObstacle[];
}

export const DEFAULT_WATER_LAYER_OPTIONS: WaterLayerOptions = { drawDistance: 1800, particles: true };

type Owner = RiverRuntime | LakeRuntime;

interface Entry {
  objects: THREE.Object3D[];
  /** world-space rocks of this chunk (queries, tests) */
  rocks: RockPlacement[];
}

const isRiver = (o: Owner): o is RiverRuntime => 'hydro' in o;

export class WaterLayer {
  readonly group = new THREE.Group();
  readonly shared: WaterShared = makeWaterShared();
  readonly particles: WaterParticles | null;
  private readonly byOwner = new Map<Owner, Map<number, Entry>>();
  private readonly retired = new Map<string, Owner[]>();
  private readonly rockMaterials = new Map<string, THREE.Material>();
  private readonly unsub: Array<() => void> = [];
  private readonly opts: WaterLayerOptions;
  private clock = 0;
  private particlesDirty = true;

  constructor(
    private readonly system: WaterSystem,
    private readonly terrain: WaterTerrain,
    private readonly materials: MaterialRegistry,
    opts: Partial<WaterLayerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_WATER_LAYER_OPTIONS, ...opts };
    this.group.name = 'water';
    this.particles = this.opts.particles ? new WaterParticles({ maxFlecks: 3500, maxSpray: 2600, range: 260, ...this.opts.particleOptions }) : null;
    if (this.particles) this.group.add(this.particles.group);
    this.unsub.push(system.onChunkReady((rt, chunk) => this.buildChunk(rt, chunk)));
    this.unsub.push(system.onLakeReady((lk) => this.buildLakeMesh(lk)));
    this.unsub.push(system.onRiverRemoved((rt) => this.removeOwner(this.ownerId(rt))));
    this.unsub.push(system.onRiverReplaced((prev) => this.retire(this.ownerId(prev), prev)));
    this.unsub.push(system.onLakeRemoved((lk) => this.removeOwner(this.ownerId(lk))));
    this.unsub.push(system.onLakeReplaced((prev) => this.retire(this.ownerId(prev), prev)));
  }

  get meshCount(): number {
    let n = 0;
    for (const m of this.byOwner.values()) for (const e of m.values()) n += e.objects.length;
    return n;
  }

  /** every boulder currently shown (tests, gameplay) */
  allRocks(): RockPlacement[] {
    const out: RockPlacement[] = [];
    for (const m of this.byOwner.values()) for (const e of m.values()) out.push(...e.rocks);
    return out;
  }

  private ownerId(o: Owner): string {
    return isRiver(o) ? `r:${o.def.id}` : `l:${o.def.id}`;
  }

  /** advances the water time, hides far meshes and moves the particles */
  update(dt: number, camera: THREE.Vector3 | THREE.Object3D): void {
    const c = camera instanceof THREE.Vector3 ? camera : camera.getWorldPosition(new THREE.Vector3());
    this.clock += dt;
    this.shared.time.value = this.clock;
    for (const m of this.byOwner.values()) {
      for (const e of m.values()) {
        for (const o of e.objects) {
          const g = (o as THREE.Mesh).geometry;
          const bs = g?.boundingSphere;
          o.visible = !bs || bs.center.distanceTo(c) - bs.radius < this.opts.drawDistance;
        }
      }
    }
    if (this.particles) {
      if (this.particlesDirty) this.refreshParticles();
      this.particles.update(dt, c);
    }
  }

  /** the sun direction (towards the sun) and sky colour used by the water shader */
  setLight(sun: THREE.Vector3, sky?: THREE.Color): void {
    this.shared.sun.value.copy(sun).normalize();
    if (sky) this.shared.sky.value.copy(sky);
  }

  private retire(id: string, prev: Owner): void {
    const list = this.retired.get(id) ?? [];
    list.push(prev);
    this.retired.set(id, list);
    this.particlesDirty = true;
  }

  private dropRetired(id: string): void {
    for (const prev of this.retired.get(id) ?? []) this.disposeOwner(prev);
    this.retired.delete(id);
  }

  private disposeOwner(o: Owner): void {
    const entries = this.byOwner.get(o);
    if (!entries) return;
    for (const e of entries.values()) this.disposeEntry(e);
    this.byOwner.delete(o);
    this.particlesDirty = true;
  }

  private disposeEntry(e: Entry): void {
    for (const o of e.objects) {
      this.group.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material;
      // water materials are per mesh; bank / rock materials are shared and live on
      if (mat && !Array.isArray(mat) && (mat as THREE.ShaderMaterial).isShaderMaterial) mat.dispose();
    }
  }

  private removeOwner(id: string): void {
    this.dropRetired(id);
    for (const o of [...this.byOwner.keys()]) if (this.ownerId(o) === id) this.disposeOwner(o);
  }

  private put(owner: Owner, index: number, entry: Entry): void {
    let entries = this.byOwner.get(owner);
    if (!entries) { entries = new Map(); this.byOwner.set(owner, entries); }
    const old = entries.get(index);
    if (old) this.disposeEntry(old);
    entries.set(index, entry);
    for (const o of entry.objects) this.group.add(o);
    this.particlesDirty = true;
  }

  // ---- rocks ----------------------------------------------------------------------------------------------------

  private rockMaterial(style: WaterStyle, shade: number): THREE.Material {
    const key = `${style.colors.shallow}:${style.rocks.color}:${shade}`;
    let m = this.rockMaterials.get(key);
    if (!m) {
      const c = new THREE.Color(style.rocks.color);
      c.multiplyScalar(0.8 + 0.2 * shade);
      m = new THREE.MeshLambertMaterial({ color: c, flatShading: true });
      this.rockMaterials.set(key, m);
    }
    return m;
  }

  private rockMesh(rocks: RockPlacement[], style: WaterStyle, name: string): THREE.Mesh | null {
    if (!rocks.length) return null;
    const batch = new GeometryBatch();
    const m = new THREE.Matrix4();
    for (const r of rocks) batch.addGeometry(`rock${Math.min(2, Math.max(0, Math.round(r.shade)))}`, rockGeometry(r.variant), rockMatrix(r, m));
    const built = batch.build();
    if (!built) return null;
    const mesh = new THREE.Mesh(built.geometry, built.materials.map((n) => this.rockMaterial(style, Number(n.slice(4)))));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    built.geometry.computeBoundingSphere();
    return mesh;
  }

  private bankMesh(geometry: THREE.BufferGeometry | null, style: WaterStyle, name: string): THREE.Mesh | null {
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, this.materials.get(style.banks.material));
    mesh.receiveShadow = true;
    mesh.name = name;
    return mesh;
  }

  private waterMesh(geometry: THREE.BufferGeometry, kind: 'river' | 'lake' | 'fall', style: WaterStyle, obstacles: ReadonlyArray<{ lat: number; v: number; r: number; strength: number }>, name: string): THREE.Mesh {
    const mat = createWaterMaterial({ kind, style, shared: this.shared });
    setObstacles(mat, obstacles);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.renderOrder = kind === 'fall' ? 4 : 3;
    mesh.name = name;
    mesh.frustumCulled = true;
    return mesh;
  }

  // ---- building -------------------------------------------------------------------------------------------------

  private buildChunk(rt: RiverRuntime, chunk: WaterChunk): void {
    const id = this.ownerId(rt);
    const name = `${id}#${chunk.index}`;
    const objects: THREE.Object3D[] = [];
    let rocks: RockPlacement[] = [];
    if (chunk.kind === 'fall') {
      const sheet = buildFallSheet(rt, chunk);
      objects.push(this.waterMesh(sheet, 'fall', rt.style, [], `${name}:sheet`));
      const f = rt.hydro.falls.find((x) => x.i0 === chunk.i0);
      if (f) {
        const pool = buildPoolDisc(rt, f, this.terrain);
        pool.computeBoundingSphere();
        objects.push(this.waterMesh(pool, 'river', rt.style, [], `${name}:pool`));
      }
    } else {
      const ext = this.opts.externalObstacles?.(rt.def.id) ?? [];
      const g = buildRiverChunk(rt, chunk, this.terrain, ext);
      objects.push(this.waterMesh(g.water, 'river', rt.style, g.obstacles, `${name}:water`));
      const bank = this.bankMesh(g.bank, rt.style, `${name}:bank`);
      if (bank) objects.push(bank);
      const rm = this.rockMesh(g.rocks, rt.style, `${name}:rocks`);
      if (rm) objects.push(rm);
      rocks = g.rocks;
    }
    this.put(rt, chunk.index, { objects, rocks });
    if (rt.pendingCount === 0) this.dropRetired(id);
  }

  private buildLakeMesh(lk: LakeRuntime): void {
    const id = this.ownerId(lk);
    const g = buildLake(lk, this.terrain);
    const objects: THREE.Object3D[] = [this.waterMesh(g.water, 'lake', lk.style, g.obstacles, `${id}:water`)];
    const bank = this.bankMesh(g.bank, lk.style, `${id}:bank`);
    if (bank) objects.push(bank);
    const rm = this.rockMesh(g.rocks, lk.style, `${id}:rocks`);
    if (rm) objects.push(rm);
    this.put(lk, 0, { objects, rocks: g.rocks });
    this.dropRetired(id);
  }

  // ---- particles ------------------------------------------------------------------------------------------------

  private refreshParticles(): void {
    this.particlesDirty = false;
    if (!this.particles) return;
    const rivers: RiverRuntime[] = [];
    const emitters: FallEmitter[] = [];
    for (const rt of this.system.rivers) {
      // a river is part of the particle world once at least one chunk is built
      if (rt.pendingCount === rt.chunks.length) continue;
      const ri = rivers.length;
      rivers.push(rt);
      const st = rt.style;
      for (const f of rt.hydro.falls) {
        const dx = f.foot.x - f.lip.x, dz = f.foot.z - f.lip.z, l = Math.hypot(dx, dz) || 1;
        const big = Math.min(1, f.height / 60);
        emitters.push({ river: ri, x: f.foot.x, y: f.foot.y, z: f.foot.z, dx: dx / l, dz: dz / l, radius: poolRadius(rt, f) * 0.55, strength: 0.4 + 0.6 * big, mist: st.particles.mist * (0.4 + 0.6 * big), spray: st.particles.spray });
      }
      // rapids: low spray every ~25 m of churned water
      let last = -1e9;
      for (const s of rt.hydro.samples) {
        if (s.kind === 'rapids' && s.s - last > 25) {
          last = s.s;
          emitters.push({ river: ri, x: s.pos.x, y: s.pos.y + 0.1, z: s.pos.z, dx: s.tangent.x, dz: s.tangent.z, radius: Math.max(1.2, s.width * 0.35), strength: 0.12, mist: st.particles.mist * 0.15, spray: st.particles.spray * 0.5 });
        }
      }
    }
    this.particles.setRivers(rivers, emitters);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const o of [...this.byOwner.keys()]) this.disposeOwner(o);
    this.retired.clear();
    this.particles?.dispose();
    for (const m of this.rockMaterials.values()) m.dispose();
    this.rockMaterials.clear();
    this.group.clear();
  }
}
