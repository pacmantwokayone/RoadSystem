// A stand-in for the game's StreamTerrain (world/streamTerrain.ts) so the road
// module can be developed and tested standalone. It reproduces the behaviours
// the road system actually depends on:
//   - quadtree tile pyramid (level 0 = finest, size doubles per level)
//   - tiles stream in asynchronously and nearest-first around the player
//   - heightAt() returns the FINEST READY tile's bilinear height — a coarse
//     fallback (different from the final height) while finer tiles load, and
//     null while nothing there is loaded
//   - isSettledAt() is true only once the finest tile that will ever exist is
//     ready, i.e. when the height can no longer change
//   - an optional carve hook that is subtracted in heightAt(), like carveAt()
// Heights come from a deterministic procedural function instead of .hgt files.
// SIM space (x, z) in all queries, THREE space (z mirrored) in the meshes.

import * as THREE from 'three';
import type { TerrainSource } from '../core/terrain';

export type HeightFn = (x: number, z: number) => number;
/** a terrain modifier: the final height from the base height (rivers, lakes, roads' cuttings …) */
export type ModifierFn = (x: number, z: number, base: number) => number;
/** vertex colour of a terrain mesh vertex (sim x/z, final height); write into `out` */
export type TintFn = (x: number, z: number, y: number, out: THREE.Color) => void;

function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, z: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Alpine-ish default terrain: ~400–1400 m with ridges and small-scale roughness. */
export const defaultHeightFn: HeightFn = (x, z) =>
  400 + 1000 * Math.pow(fbm(x * 0.0006, z * 0.0006, 5), 1.3) + 25 * fbm(x * 0.012, z * 0.012, 3);

export interface MockTerrainOptions {
  /** level-0 tiles per side (default 16 → 6144 m with 384 m tiles) */
  tilesPerSide?: number;
  numLevels?: number;
  baseTileSize?: number;
  heightFn?: HeightFn;
  /** frames a tile spends "loading" before it becomes ready */
  loadLatencyFrames?: number;
  maxConcurrentLoads?: number;
  lodFactor?: number;
  /** build THREE meshes for ready tiles (demo); off for headless tests */
  buildMeshes?: boolean;
  /** every Nth height sample becomes a mesh vertex (like StreamTerrain.meshStride) */
  meshStride?: 1 | 2 | 4;
}

type TileState = 'unloaded' | 'loading' | 'ready';

class Tile {
  state: TileState = 'unloaded';
  heights: Float32Array | null = null;
  grid = 0;
  countdown = 0;
  mesh: THREE.Mesh | null = null;
  constructor(readonly level: number, readonly tx: number, readonly tz: number, readonly size: number) {}
  get x0(): number { return this.tx * this.size; }
  get z0(): number { return this.tz * this.size; }
}

const key = (level: number, tx: number, tz: number): number => (level << 24) | (tz << 12) | tx;

export class MockStreamTerrain implements TerrainSource {
  readonly group = new THREE.Group();
  readonly meta: { sizeX: number; sizeZ: number; numLevels: number; levels: { size: number; nx: number; nz: number }[] };
  readonly heightFn: HeightFn;
  /** Subtracted from heightAt() like StreamTerrain.carveAt(); set by tests/tools. */
  carve: ((x: number, z: number) => number) | null = null;
  /** Changes the height the tiles are generated with (see `invalidate`): rivers carve their beds through this. */
  modifier: ModifierFn | null = null;
  /** Colours the terrain mesh (wet banks, …). */
  tint: TintFn | null = null;
  lodFactor: number;

  private readonly tiles = new Map<number, Tile>();
  private readonly latency: number;
  private readonly maxLoads: number;
  private loadsInFlight = 0;
  private readonly buildMeshes: boolean;
  private readonly stride: number;
  private material: THREE.MeshLambertMaterial | null = null;

  constructor(opts: MockTerrainOptions = {}) {
    const base = opts.baseTileSize ?? 384;
    const per = opts.tilesPerSide ?? 16;
    const numLevels = opts.numLevels ?? 5;
    this.heightFn = opts.heightFn ?? defaultHeightFn;
    this.latency = opts.loadLatencyFrames ?? 15;
    this.maxLoads = opts.maxConcurrentLoads ?? 8;
    this.lodFactor = opts.lodFactor ?? 2.5;
    this.buildMeshes = opts.buildMeshes ?? false;
    this.stride = opts.meshStride ?? 2;
    const levels: { size: number; nx: number; nz: number }[] = [];
    for (let l = 0; l < numLevels; l++) {
      const size = base * 2 ** l;
      const n = Math.max(1, Math.ceil((per * base) / size));
      levels.push({ size, nx: n, nz: n });
    }
    this.meta = { sizeX: per * base, sizeZ: per * base, numLevels, levels };
  }

  // ---- TerrainSource ----------------------------------------------------

  heightAt(x: number, z: number): number | null {
    const m = this.meta;
    const cx = Math.min(Math.max(x, 0), m.sizeX - 0.01);
    const cz = Math.min(Math.max(z, 0), m.sizeZ - 0.01);
    for (let level = 0; level < m.numLevels; level++) {
      const size = m.levels[level].size;
      const t = this.tiles.get(key(level, Math.floor(cx / size), Math.floor(cz / size)));
      if (!t || t.state !== 'ready' || !t.heights) continue;
      const n = t.grid;
      const fx = ((cx - t.x0) / size) * (n - 1);
      const fz = ((cz - t.z0) / size) * (n - 1);
      const c0 = Math.min(Math.floor(fx), n - 2);
      const r0 = Math.min(Math.floor(fz), n - 2);
      const ax = fx - c0;
      const az = fz - r0;
      const h = t.heights;
      const b = r0 * n + c0;
      const v = (h[b] * (1 - ax) + h[b + 1] * ax) * (1 - az) + (h[b + n] * (1 - ax) + h[b + n + 1] * ax) * az;
      return v - (this.carve ? this.carve(x, z) : 0);
    }
    return null;
  }

  isSettledAt(x: number, z: number): boolean {
    return this.finestLevelReadyAt(x, z) === 0; // level 0 exists everywhere
  }

  // ---- streaming --------------------------------------------------------

  /** Advance loads and LOD selection around the player (sim x/z). Call once per frame. */
  update(px: number, pz: number): void {
    this.tickLoads();
    const coarsest = this.meta.numLevels - 1;
    const lv = this.meta.levels[coarsest];
    const nodes: Tile[] = [];
    for (let tz = 0; tz < lv.nz; tz++) for (let tx = 0; tx < lv.nx; tx++) nodes.push(this.tileAt(coarsest, tx, tz)!);
    nodes.sort((a, b) => this.distSq(a, px, pz) - this.distSq(b, px, pz));
    for (const t of nodes) this.processNode(t, px, pz);
  }

  /** Synchronously load every tile of every level (headless tests). */
  loadAllSync(): void {
    for (let level = 0; level < this.meta.numLevels; level++) {
      const lv = this.meta.levels[level];
      for (let tz = 0; tz < lv.nz; tz++) for (let tx = 0; tx < lv.nx; tx++) this.finishLoad(this.tileAt(level, tx, tz)!);
    }
  }

  /** Synchronously load only the tiles covering a rect at the given level. */
  loadRectSync(minX: number, minZ: number, maxX: number, maxZ: number, level: number): void {
    const size = this.meta.levels[level].size;
    for (let tz = Math.floor(minZ / size); tz <= Math.floor(maxZ / size); tz++) {
      for (let tx = Math.floor(minX / size); tx <= Math.floor(maxX / size); tx++) {
        const t = this.tileAt(level, tx, tz);
        if (t) this.finishLoad(t);
      }
    }
  }

  /** Debug: every tile covering (x, z), finest first, with its visibility. */
  tilesAt(x: number, z: number): Array<{ level: number; state: string; visible: boolean }> {
    const out: Array<{ level: number; state: string; visible: boolean }> = [];
    for (let level = 0; level < this.meta.numLevels; level++) {
      const size = this.meta.levels[level].size;
      const t = this.tiles.get(key(level, Math.floor(x / size), Math.floor(z / size)));
      if (t) out.push({ level, state: t.state, visible: t.mesh?.visible ?? false });
    }
    return out;
  }

  loadStats(): { ready: number; known: number } {
    let ready = 0;
    this.tiles.forEach((t) => { if (t.state === 'ready') ready++; });
    return { ready, known: this.tiles.size };
  }

  // ---- internals --------------------------------------------------------

  private tileAt(level: number, tx: number, tz: number): Tile | null {
    const lv = this.meta.levels[level];
    if (tx < 0 || tz < 0 || tx >= lv.nx || tz >= lv.nz) return null;
    const k = key(level, tx, tz);
    let t = this.tiles.get(k);
    if (!t) { t = new Tile(level, tx, tz, lv.size); this.tiles.set(k, t); }
    return t;
  }

  private finestLevelReadyAt(x: number, z: number): number | null {
    const m = this.meta;
    const cx = Math.min(Math.max(x, 0), m.sizeX - 0.01);
    const cz = Math.min(Math.max(z, 0), m.sizeZ - 0.01);
    for (let level = 0; level < m.numLevels; level++) {
      const size = m.levels[level].size;
      const t = this.tiles.get(key(level, Math.floor(cx / size), Math.floor(cz / size)));
      if (t && t.state === 'ready') return level;
    }
    return null;
  }

  private distSq(t: Tile, px: number, pz: number): number {
    return (px - (t.x0 + t.size / 2)) ** 2 + (pz - (t.z0 + t.size / 2)) ** 2;
  }

  private requestLoad(t: Tile): void {
    if (t.state !== 'unloaded' || this.loadsInFlight >= this.maxLoads) return;
    t.state = 'loading';
    t.countdown = this.latency;
    this.loadsInFlight++;
  }

  private tickLoads(): void {
    for (const t of this.tiles.values()) {
      if (t.state !== 'loading') continue;
      if (--t.countdown <= 0) this.finishLoad(t);
    }
  }

  private finishLoad(t: Tile): void {
    if (t.state === 'ready') return;
    if (t.state === 'loading') this.loadsInFlight--;
    const n = t.level <= 1 ? 257 : 129; // like the real pyramid: finer grids on levels 0/1
    const h = new Float32Array(n * n);
    const step = t.size / (n - 1);
    this.fillHeights(t, h, n, step);
    t.heights = h;
    t.grid = n;
    t.state = 'ready';
    if (this.buildMeshes) {
      t.mesh = this.buildMesh(t);
      t.mesh.visible = false;
      this.group.add(t.mesh);
    }
  }

  private fillHeights(t: Tile, h: Float32Array, n: number, step: number): void {
    const mod = this.modifier;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = t.x0 + c * step, z = t.z0 + r * step;
        const base = this.heightFn(x, z);
        h[r * n + c] = mod ? mod(x, z, base) : base;
      }
    }
  }

  /** Height without any modifier (what rivers and roads are designed against). */
  baseHeightAt(x: number, z: number): number {
    return this.heightFn(x, z);
  }

  /**
   * Regenerates the heights (and meshes) of every loaded tile touching the rect — after `modifier` changed there.
   * No rect = everything. Returns the number of tiles rebuilt.
   */
  invalidate(rect?: { minX: number; minZ: number; maxX: number; maxZ: number }): number {
    let count = 0;
    for (const t of this.tiles.values()) {
      if (t.state !== 'ready' || !t.heights) continue;
      if (rect && (t.x0 > rect.maxX || t.x0 + t.size < rect.minX || t.z0 > rect.maxZ || t.z0 + t.size < rect.minZ)) continue;
      const n = t.grid;
      this.fillHeights(t, t.heights, n, t.size / (n - 1));
      if (this.buildMeshes) {
        const old = t.mesh;
        const mesh = this.buildMesh(t);
        mesh.visible = old ? old.visible : false;
        if (old) { this.group.remove(old); old.geometry.dispose(); }
        t.mesh = mesh;
        this.group.add(mesh);
      }
      count++;
    }
    return count;
  }

  private processNode(t: Tile, px: number, pz: number): boolean {
    this.requestLoad(t);
    const dist = Math.hypot(px - (t.x0 + t.size / 2), pz - (t.z0 + t.size / 2));
    const wantSplit = t.level > 0 && dist < t.size * this.lodFactor;
    let childrenCover = false;
    if (wantSplit) {
      const kids: Tile[] = [];
      for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        const k = this.tileAt(t.level - 1, t.tx * 2 + dx, t.tz * 2 + dz);
        if (k) kids.push(k);
      }
      kids.sort((a, b) => this.distSq(a, px, pz) - this.distSq(b, px, pz));
      const results = kids.map((k) => this.processNode(k, px, pz));
      childrenCover = kids.length > 0 && results.every(Boolean);
      if (!childrenCover) for (const k of kids) this.hide(k, true);
    } else {
      this.hideDescendants(t);
    }
    this.hide(t, false, !(!childrenCover && t.state === 'ready'));
    return t.state === 'ready' || childrenCover;
  }

  private hide(t: Tile, recurse: boolean, hidden = true): void {
    if (t.mesh) t.mesh.visible = !hidden;
    if (recurse) this.hideDescendants(t);
  }

  private hideDescendants(t: Tile): void {
    if (t.level === 0) return;
    for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
      const k = this.tiles.get(key(t.level - 1, t.tx * 2 + dx, t.tz * 2 + dz));
      if (k) { if (k.mesh) k.mesh.visible = false; this.hideDescendants(k); }
    }
  }

  private buildMesh(t: Tile): THREE.Mesh {
    const h = t.heights!;
    const nFull = t.grid;
    const stride = (nFull - 1) % this.stride === 0 ? this.stride : 1;
    const n = (nFull - 1) / stride + 1;
    const step = t.size / (n - 1);
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const color = new THREE.Color();
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const y = h[r * stride * nFull + c * stride];
        const i = r * n + c;
        pos[i * 3] = t.x0 + c * step;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = -(t.z0 + r * step); // three space: z mirrored
        // simple altitude tint: green valleys → grey rock → white peaks
        const k = Math.min(1, Math.max(0, (y - 400) / 1000));
        color.setRGB(0.25 + 0.55 * k, 0.45 + 0.35 * k, 0.2 + 0.65 * k * k);
        if (this.tint) this.tint(t.x0 + c * step, t.z0 + r * step, y, color);
        col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let ii = 0;
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c, b = a + 1, cc = a + n, d = cc + 1;
        idx[ii++] = a; idx[ii++] = b; idx[ii++] = cc;
        idx[ii++] = b; idx[ii++] = d; idx[ii++] = cc;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.material ??= new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    return mesh;
  }
}
