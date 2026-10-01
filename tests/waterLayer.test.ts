import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { WaterSystem, DEFAULT_WATER_OPTIONS } from '../src/water/system';
import { WaterLibrary } from '../src/water/styleLibrary';
import { WaterLayer } from '../src/water/waterLayer';
import { buildRiverChunk } from '../src/water/riverMesh';
import { buildFallSheet, buildPoolDisc } from '../src/water/fallMesh';
import { buildLake } from '../src/water/lakeMesh';
import { MaterialRegistry } from '../src/surface/materials';
import type { LakeDef, RiverDef } from '../src/water/types';

const lib = new WaterLibrary();
const OPTS = { ...DEFAULT_WATER_OPTIONS, debounceMs: 0 };

function terrain(): MockStreamTerrain {
  const t = new MockStreamTerrain({ heightFn: () => 800, buildMeshes: false });
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2700, 2400, 3900, 3400, 0);
  return t;
}

const river = (id: string, pts: Array<[number, number, number, object?]>, o: Partial<RiverDef> = {}): RiverDef => ({
  id, name: id, style: 'bach', ...o, points: pts.map(([x, y, z, e]) => ({ x, y, z, ...(e ?? {}) })),
});

function boot(rivers: RiverDef[], lakes: LakeDef[] = []) {
  const t = terrain();
  const sys = new WaterSystem(t, lib, OPTS);
  const layer = new WaterLayer(sys, t, new MaterialRegistry(), { particles: false });
  sys.setWaters(rivers, lakes);
  for (let i = 0; i < 20 && !sys.settled; i++) sys.resync({ builds: 100 });
  return { t, sys, layer };
}

const allFinite = (g: THREE.BufferGeometry): boolean => {
  for (const a of Object.values(g.attributes)) for (const v of (a as THREE.BufferAttribute).array) if (!Number.isFinite(v)) return false;
  return true;
};

/** triangles whose normal points downwards (a water surface has none) */
function downFacing(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position'), idx = g.getIndex()!;
  let bad = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i)); b.fromBufferAttribute(p, idx.getX(i + 1)); c.fromBufferAttribute(p, idx.getX(i + 2));
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.y < -1e-6) bad++;
  }
  return bad;
}

describe('river meshes', () => {
  const def = river('b', [[3000, 800, 3000, { width: 5, depth: 1 }], [3150, 797, 3040], [3300, 790, 3000]]);

  it('builds finite, up-facing water that reaches the carved shore', () => {
    const { sys, t } = boot([def]);
    const rt = sys.rivers[0];
    expect(sys.settled).toBe(true);
    for (const ch of rt.chunks) {
      const g = buildRiverChunk(rt, ch, t);
      expect(allFinite(g.water)).toBe(true);
      expect(downFacing(g.water)).toBe(0);
      expect(g.water.getIndex()!.count).toBeGreaterThan(0);
      expect(g.bank).not.toBeNull();
      expect(g.bank!.getAttribute('aStrip')).toBeDefined();
    }
  });

  it('places boulders, some of them in the water as foam obstacles', () => {
    const { sys, t } = boot([river('b', [[3000, 800, 3000, { width: 6 }], [3400, 780, 3000]], { style: 'wildbach' })]);
    const rt = sys.rivers[0];
    let rocks = 0, obstacles = 0;
    for (const ch of rt.chunks) { const g = buildRiverChunk(rt, ch, t); rocks += g.rocks.length; obstacles += g.obstacles.length; }
    expect(rocks).toBeGreaterThan(5);
    expect(obstacles).toBeGreaterThan(0);
    expect(obstacles).toBeLessThanOrEqual(rocks);
  });

  it('external obstacles (bridge piers) become obstacles too', () => {
    const { sys, t } = boot([def]);
    const rt = sys.rivers[0];
    const ch = rt.chunks[0];
    const s = rt.hydro.samples[Math.floor((ch.i0 + ch.i1) / 2)];
    const without = buildRiverChunk(rt, ch, t).obstacles.length;
    const withPier = buildRiverChunk(rt, ch, t, [{ x: s.pos.x, z: s.pos.z, r: 1.2 }]).obstacles.length;
    expect(withPier).toBe(without + 1);
  });
});

describe('waterfalls', () => {
  const def = river('f', [
    [3000, 800, 3000, { width: 6 }], [3100, 798, 3000, { seg: 'fall' }], [3140, 600, 3000], [3300, 596, 3000],
  ]);

  it('the layer builds sheet and pool for the fall and finite geometry', () => {
    const { sys, t } = boot([def]);
    const rt = sys.rivers[0];
    expect(rt.hydro.falls.length).toBe(1);
    const fall = rt.chunks.find((c) => c.kind === 'fall')!;
    const sheet = buildFallSheet(rt, fall);
    expect(allFinite(sheet)).toBe(true);
    const pool = buildPoolDisc(rt, rt.hydro.falls[0], t);
    expect(allFinite(pool)).toBe(true);
    expect(downFacing(pool)).toBe(0);
    const bb = new THREE.Box3().setFromBufferAttribute(sheet.getAttribute('position') as THREE.BufferAttribute);
    expect(bb.max.y - bb.min.y).toBeGreaterThan(150); // a long fall
  });
});

describe('lakes', () => {
  const lake: LakeDef = { id: 'l', name: 'l', style: 'bergsee', level: 797, depth: 6, outline: [[3000, 3000], [3120, 3010], [3140, 3120], [3010, 3140]].map(([x, z]) => ({ x, z })) };

  it('builds a finite lake surface with a bank and boulders', () => {
    const { sys, t } = boot([], [lake]);
    expect(sys.settled).toBe(true);
    const g = buildLake(sys.lakes[0], t);
    expect(allFinite(g.water)).toBe(true);
    expect(downFacing(g.water)).toBe(0);
    expect(g.water.getIndex()!.count).toBeGreaterThan(30);
  });
});

describe('layer lifecycle', () => {
  const def = river('b', [[3000, 800, 3000, { width: 5 }], [3300, 790, 3000]]);
  const lake: LakeDef = { id: 'l', name: 'l', style: 'weiher', level: 800, depth: 3, outline: [[3400, 3000], [3500, 3000], [3500, 3100], [3400, 3100]].map(([x, z]) => ({ x, z })) };

  it('creates meshes for ready chunks and lakes and disposes them with their owner', () => {
    const { sys, layer } = boot([def], [lake]);
    expect(layer.meshCount).toBeGreaterThan(sys.rivers[0].chunks.length);
    sys.setWaters([], []);
    sys.resync({ builds: 100 });
    expect(layer.meshCount).toBe(0);
  });

  it('keeps the old river visible until the replacement is complete', () => {
    const { sys, layer } = boot([def]);
    const before = layer.meshCount;
    const edited = { ...def, points: def.points.map((p) => ({ ...p })) };
    edited.points[1].y = 788;
    sys.setWaters([edited], []);
    expect(layer.meshCount).toBe(before); // nothing disposed yet — the terrain is re-carved first
    for (let i = 0; i < 20 && !sys.settled; i++) sys.resync({ builds: 100 });
    expect(sys.settled).toBe(true);
    expect(layer.meshCount).toBe(before); // old version dropped once the new one is complete
  });

  it('update() moves the water time and hides far meshes', () => {
    const { layer } = boot([def]);
    layer.update(0.5, new THREE.Vector3(3150, 800, -3000));
    expect(layer.shared.time.value).toBeCloseTo(0.5);
    layer.update(0.5, new THREE.Vector3(3150, 800, 99999));
    let visible = 0;
    layer.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) visible++; });
    expect(visible).toBe(0);
  });
});

describe('terrain sync', () => {
  it('a river carves the terrain once the debounce ran out, and removing it restores the ground', () => {
    const t = terrain();
    let now = 0;
    const sys = new WaterSystem(t, lib, { ...DEFAULT_WATER_OPTIONS, debounceMs: 100 }, () => now);
    const def = river('b', [[3000, 800, 3000, { width: 6, depth: 1.5 }], [3300, 790, 3000]]);
    sys.setWaters([def], []);
    expect(sys.terrainPending).toBe(true);
    sys.resync();
    expect(sys.terrainPending).toBe(true); // still waiting
    now = 150;
    sys.resync();
    expect(sys.terrainPending).toBe(false);
    const h = t.heightAt(3150, 3000)!;
    expect(h).toBeLessThan(795);
    sys.setWaters([], []);
    now = 400;
    sys.resync();
    expect(t.heightAt(3150, 3000)).toBeCloseTo(800, 0);
  });
});
