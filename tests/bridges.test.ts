import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadRuntime, DEFAULT_RUNTIME_OPTIONS } from '../src/runtime/roadRuntime';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { buildChunkGeometry } from '../src/mesh/extrude';
import { BridgeLibrary } from '../src/structures/library';
import { bridgeApi, BridgeBuilder } from '../src/structures/builder';
import { compileBridgeSource, evaluateBridge } from '../src/structures/compile';
import { bridgeSections, pierPositions, pierPositionsFor } from '../src/structures/sections';
import { buildChunkBridge } from '../src/structures/bridgeGeometry';
import { BridgeLayer } from '../src/structures/bridgeLayer';
import { defaultBridgeName } from '../src/structures/types';
import { MaterialRegistry } from '../src/surface/materials';
import { PropMaterials } from '../src/props/materials';
import { sanitizeRoad } from '../src/network/doc';
import { RoadModel } from '../src/editor/model';
import { splitRoad } from '../src/editor/ops';
import { sampleRoad } from '../src/core/sampling';
import type { RoadDef } from '../src/network/types';

const profiles = new ProfileLibrary();
const bridges = new BridgeLibrary();

describe('bridge code', () => {
  it('all presets compile, evaluate and have parameters with defaults', () => {
    expect(bridges.names().sort()).toEqual(['balkenbruecke', 'bogenbruecke', 'eisenbahnbruecke', 'fachwerkbruecke', 'grossbogen', 'holzsteg', 'plattenbruecke', 'viadukt']);
    for (const n of bridges.names()) {
      const b = bridges.resolve(n);
      expect(b.deck.thickness, n).toBeGreaterThan(0);
      expect(b.abutments.depth, n).toBeGreaterThan(0);
    }
    expect(bridges.resolve('bogenbruecke').arch).not.toBeNull();
    expect(bridges.resolve('fachwerkbruecke').truss).not.toBeNull();
    expect(bridges.resolve('balkenbruecke').girders!.count).toBe(3);
    expect(bridges.resolve('balkenbruecke', { girders: 5 }).girders!.count).toBe(5);
    expect(bridges.resolve('viadukt').piers!.shape).toBe('twin');
  });

  it('options are clamped, unknown shapes fall back — a typo can never produce broken geometry', () => {
    const b = bridgeApi.bridge('x').deck({ thickness: -5 }).piers({ shape: 'nonsense' as never, maxSpan: 1e9, width: NaN }).railing('weird' as never).arch({ rise: 99 }).finish();
    expect(b.deck.thickness).toBeGreaterThanOrEqual(0.1);
    expect(b.piers!.shape).toBe('column');
    expect(b.piers!.maxSpan).toBeLessThanOrEqual(150);
    expect(Number.isFinite(b.piers!.width)).toBe(true);
    expect(b.railing.type).toBe('steel');
    expect(b.arch!.rise).toBeLessThanOrEqual(0.5);
  });

  it('a failing edit keeps the last good version; a broken source reports an error', () => {
    const lib = new BridgeLibrary();
    const before = lib.resolve('viadukt');
    const bad = lib.setSource('viadukt', 'export default (p, B) => { throw new Error("boom"); }');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/boom/);
    expect(lib.resolve('viadukt')).toBe(before);
    expect(lib.setSource('viadukt', 'export default (p, B) => 42').ok).toBe(false);
    expect(lib.setSource('viadukt', 'export default (p, B =>').ok).toBe(false);
    const good = lib.setSource('viadukt', "export default (p, B) => B.bridge('v').deck({ thickness: 3 })");
    expect(good.ok).toBe(true);
    expect(lib.resolve('viadukt').deck.thickness).toBe(3);
  });

  it('identity is stable per (name, params), changes on edit, and unknown names fall back', () => {
    const lib = new BridgeLibrary();
    expect(lib.resolve('balkenbruecke')).toBe(lib.resolve('balkenbruecke'));
    expect(lib.resolve('balkenbruecke', { girders: 4 })).toBe(lib.resolve('balkenbruecke', { girders: 4 }));
    expect(lib.resolve('balkenbruecke', { girders: 4 })).not.toBe(lib.resolve('balkenbruecke'));
    const a = lib.resolve('balkenbruecke');
    lib.setSource('balkenbruecke', lib.getSource('balkenbruecke')!.replace('thickness: 0.45', 'thickness: 0.5'));
    expect(lib.resolve('balkenbruecke')).not.toBe(a);
    expect(lib.resolve('gibt-es-nicht').name).toBe('Balkenbrücke');
  });

  it('a road without a named bridge gets one that fits its importance', () => {
    expect(defaultBridgeName(profiles.resolve('wanderweg'))).toBe('holzsteg');
    expect(defaultBridgeName(profiles.resolve('gemeindestrasse'))).toBe('plattenbruecke');
    expect(defaultBridgeName(profiles.resolve('kantonsstrasse'))).toBe('balkenbruecke');
    expect(defaultBridgeName(profiles.resolve('autobahn'))).toBe('viadukt');
    const def = { id: 'a', name: 'a', profile: 'autobahn', points: [] } as unknown as RoadDef;
    expect(bridges.forRoad(def, profiles.resolve('autobahn')).name).toBe('Viadukt');
    expect(bridges.forRoad({ ...def, bridge: 'holzsteg' }, profiles.resolve('autobahn')).name).toBe('Holzsteg');
  });

  it('roads keep their bridge fields through sanitizing', () => {
    const r = sanitizeRoad({ id: 'r', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], bridge: 'viadukt', bridgeParams: { maxSpan: 40, junk: {} } }, 'r')!;
    expect(r.bridge).toBe('viadukt');
    expect(r.bridgeParams).toEqual({ maxSpan: 40 });
    expect(sanitizeRoad({ id: 'r', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] }, 'r')!.bridge).toBeUndefined();
  });

  it('bridge fields survive edits (snapshot cloning), undo/redo and splitting a road', () => {
    const model = new RoadModel();
    const base: RoadDef = { id: 'r', name: 'r', profile: 'hauptstrasse', bridge: 'viadukt', bridgeParams: { maxSpan: 40 }, points: [3000, 3300, 3600].map((x) => ({ x, y: 800, z: 3000 })) };
    model.load({ version: 1, roads: [base] });
    model.transact('x', (d) => d.editRoad('r', (r) => { r.name = 'renamed'; }));
    expect(model.get('r')!.bridge).toBe('viadukt');
    expect(model.get('r')!.bridgeParams).toEqual({ maxSpan: 40 });
    model.undo(); model.redo();
    expect(model.get('r')!.bridge).toBe('viadukt');
    expect(model.toDocument().roads[0].bridge).toBe('viadukt');
    const sampled = sampleRoad(model.get('r')!);
    model.transact('split', (d) => { splitRoad(d, 'r', sampled, 300); });
    expect(model.list).toHaveLength(2);
    for (const r of model.list) expect(r.bridge).toBe('viadukt');
  });

  it('compileBridgeSource / evaluateBridge are usable directly', () => {
    const c = compileBridgeSource("export const params = { n: { type: 'int', min: 1, max: 4, default: 2 } };\nexport default (p, B) => B.bridge('t').girders({ count: p.n });");
    expect(evaluateBridge(c).girders!.count).toBe(2);
    expect(evaluateBridge(c, { n: 9 }).girders!.count).toBe(4);
    expect(new BridgeBuilder('q').finish().piers).toBeNull();
  });
});

describe('sections and spans', () => {
  it('pier positions divide a section into equal spans no longer than maxSpan', () => {
    expect(pierPositions({ s0: 100, s1: 200 }, 30)).toEqual([125, 150, 175]);
    expect(pierPositions({ s0: 0, s1: 20 }, 30)).toEqual([]);
    for (const [len, span] of [[133, 30], [300, 48], [61, 20]] as const) {
      const p = pierPositions({ s0: 0, s1: len }, span);
      const bounds = [0, ...p, len];
      for (let i = 1; i < bounds.length; i++) expect(bounds[i] - bounds[i - 1]).toBeLessThanOrEqual(span + 1e-9);
      expect(bounds[1] - bounds[0]).toBeCloseTo(bounds[bounds.length - 1] - bounds[bounds.length - 2], 9);
    }
  });
});

// ---- geometry on a gorge --------------------------------------------------------------------------

const DECK_Y = 800;
/** a 30 m deep gorge across x = 3300 (±40 m) */
const gorge = (x: number): number => 800 - 30 * Math.exp(-(((x - 3300) / 45) ** 2));
function terrain(): MockStreamTerrain {
  const t = new MockStreamTerrain({ heightFn: (x) => gorge(x) });
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2700, 2700, 3900, 3300, 0);
  return t;
}

function road(profile: string, bridgeName: string | null, extra: Partial<RoadDef> = {}, bridgeSrc?: string): { rt: RoadRuntime; lib: BridgeLibrary; def: RoadDef } {
  const lib = new BridgeLibrary();
  if (bridgeSrc) lib.setSource('custom', bridgeSrc);
  const xs = [3000, 3150, 3200, 3300, 3400, 3450, 3600];
  const def: RoadDef = {
    id: 'br', name: 'br', profile, ...(bridgeName ? { bridge: bridgeName } : {}), ...extra,
    points: xs.map((x) => ({ x, y: DECK_Y, z: 3000, ...(x >= 3200 && x <= 3400 ? { mode: 'bridge' as const } : {}) })),
  };
  const prof = profiles.resolve(profile);
  const rt = new RoadRuntime(def, terrain(), prof, DEFAULT_RUNTIME_OPTIONS, undefined, lib.forRoad(def, prof));
  let guard = 0;
  while (rt.pendingCount > 0 && guard++ < 50) rt.chunks.forEach((c) => rt.tryBuildChunk(c));
  return { rt, lib, def };
}

const bbox = (g: THREE.BufferGeometry): THREE.Box3 => { g.computeBoundingBox(); return g.boundingBox!.clone(); };

describe('deck and sections on a real road', () => {
  it('finds the bridge section between the two bridge points', () => {
    const { rt } = road('hauptstrasse', 'balkenbruecke');
    const [sec] = bridgeSections(rt);
    expect(bridgeSections(rt)).toHaveLength(1);
    expect(sec.s1 - sec.s0).toBeCloseTo(200, 0);
    expect(sec.startsAtRoad && sec.endsAtRoad).toBe(true);
  });

  it('bridge samples read the terrain although their height never follows it', () => {
    const { rt } = road('hauptstrasse', 'balkenbruecke');
    const [sec] = bridgeSections(rt);
    const mid = Math.floor((sec.i0 + sec.i1) / 2);
    expect(Number.isFinite(rt.lat[1][mid])).toBe(true);
    expect(rt.designY[mid]).toBeCloseTo(DECK_Y, 3);
    expect(rt.lat[1][mid]).toBeLessThan(DECK_Y - 20);
  });

  it('the deck is a slab: its body is as thick as the deck, not as deep as the gorge', () => {
    const { rt } = road('hauptstrasse', 'balkenbruecke');
    const thickness = rt.bridge.deck.thickness;
    const [sec] = bridgeSections(rt);
    let checked = 0;
    for (const ch of rt.chunks) {
      if (rt.samples[ch.i0].s < sec.s0 + 1 || rt.samples[ch.i1].s > sec.s1 - 1) continue; // chunks fully inside the bridge
      const { geometry } = buildChunkGeometry(rt, ch);
      const box = bbox(geometry);
      expect(box.min.y).toBeGreaterThan(DECK_Y - thickness - 0.35); // crown + deck slab only
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('verges and ditches vanish on the bridge: the deck is only as wide as the carriageway', () => {
    const { rt } = road('hauptstrasse', 'balkenbruecke');
    const [sec] = bridgeSections(rt);
    const prof = rt.profile;
    let maxLateral = 0;
    for (const ch of rt.chunks) {
      if (rt.samples[ch.i0].s < sec.s0 + 1 || rt.samples[ch.i1].s > sec.s1 - 1) continue;
      const box = bbox(buildChunkGeometry(rt, ch).geometry);
      maxLateral = Math.max(maxLateral, Math.abs(box.max.z + 3000), Math.abs(box.min.z + 3000));
    }
    expect(maxLateral).toBeLessThan(prof.coreHalfWidth + 0.01);
    expect(maxLateral).toBeGreaterThan(prof.coreHalfWidth - 0.1);
    expect(prof.outerHalfWidth).toBeGreaterThan(prof.coreHalfWidth + 2); // the road itself is wider off the bridge
  });
});

const allBridge = (rt: RoadRuntime) => rt.chunks.map((c) => ({ c, b: buildChunkBridge(rt, c) }));

describe('approach ramps', () => {
  it('a bridge end that lies below the approach terrain never buries the road leading to it', () => {
    // flat ground at 800, a bridge whose end points are authored at 790 (10 m below the surrounding ground)
    const t = new MockStreamTerrain({ heightFn: () => 800 });
    t.loadRectSync(0, 0, 6000, 6000, 4);
    t.loadRectSync(2700, 2700, 3900, 3300, 0);
    const def: RoadDef = { id: 'a', name: 'a', profile: 'hauptstrasse', points: [3000, 3200, 3300, 3400, 3600].map((x, i) => ({ x, y: i === 0 || i === 4 ? 800 : 790, z: 3000, ...(i >= 1 && i <= 3 ? { mode: 'bridge' as const } : {}) })) };
    const rt = new RoadRuntime(def, t, profiles.resolve('hauptstrasse'), DEFAULT_RUNTIME_OPTIONS);
    let g = 0;
    while (rt.pendingCount > 0 && g++ < 20) rt.chunks.forEach((c) => rt.tryBuildChunk(c));
    rt.samples.forEach((s, i) => {
      if (s.fixedWeight < 1) expect(rt.designY[i], `s=${s.s.toFixed(0)}`).toBeGreaterThanOrEqual(800 - 1e-6);
      else expect(Math.abs(rt.designY[i] - 790)).toBeLessThan(0.5); // the bridge itself keeps its authored height (spline overshoot aside)
    });
  });
});

describe('structure geometry', () => {
  it('every preset builds finite geometry on the gorge, with piers reaching the ground', () => {
    for (const name of bridges.names()) {
      const { rt } = road('hauptstrasse', name);
      const builds = allBridge(rt).filter((x) => x.b);
      expect(builds.length, name).toBeGreaterThan(0);
      let low = Infinity, high = -Infinity;
      for (const { b } of builds) {
        expect(b!.complete, name).toBe(true);
        const built = b!.batch.build();
        if (!built) continue;
        const pos = built.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i)), name).toBe(true);
          low = Math.min(low, pos.getY(i)); high = Math.max(high, pos.getY(i));
        }
      }
      // something stands deep in the gorge (ground at the centre is 770)
      if (name !== 'grossbogen') expect(low, name).toBeLessThan(DECK_Y - 20); // the single arch springs from the rims
      expect(high, name).toBeGreaterThan(DECK_Y);
    }
  });

  it('piers stand where the section divides into equal spans — regardless of chunking', () => {
    const src = "export default (p, B) => B.bridge('p').deck({ thickness: 0.6 }).piers({ maxSpan: 40, shape: 'column', width: 1.5, depth: 1.5, minHeight: 1, footing: 0 }).abutments({ depth: 1, wing: 0 }).railing('none');";
    const { rt } = road('hauptstrasse', 'custom', {}, src);
    const [sec] = bridgeSections(rt);
    // x of every vertex well below the deck, away from the abutments, clustered by 3 m
    const xs = new Set<number>();
    for (const { b } of allBridge(rt)) {
      const built = b?.batch.build();
      if (!built) continue;
      const pos = built.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) if (pos.getY(i) < DECK_Y - 2.5 && pos.getX(i) > 3206 && pos.getX(i) < 3394) xs.add(Math.round(pos.getX(i) / 3));
    }
    // road runs along x from 3000: s = x − 3000; piers at s0 + k·len/spans
    const sPiers = pierPositions(sec, 40);
    expect(sPiers.length).toBe(4); // 200 m / 40 m = 5 spans
    for (const s of sPiers) expect(xs.has(Math.round((3000 + s) / 3)), `pier at s=${s}`).toBe(true);
    // and nothing in between (columns are 1.5 m wide: one cluster, two at a rounding edge)
    expect(xs.size).toBeLessThanOrEqual(sPiers.length * 2);
  });

  it('girders and railings continue across chunk borders: the border ring is identical in both chunks', () => {
    const src = "export default (p, B) => B.bridge('g').deck({ thickness: 0.5 }).girders({ count: 3, depth: 1, width: 0.5 }).abutments({ depth: 1, wing: 0 }).railing({ type: 'parapet' });";
    const { rt } = road('hauptstrasse', 'custom', {}, src);
    const [sec] = bridgeSections(rt);
    const inside = rt.chunks.filter((c) => rt.samples[c.i0].s >= sec.s0 && rt.samples[c.i1].s <= sec.s1);
    expect(inside.length).toBeGreaterThanOrEqual(2);
    for (let k = 0; k < inside.length - 1; k++) {
      const border = rt.samples[inside[k].i1].pos.x;
      const ring = (chunkIdx: number): string[] => {
        const built = buildChunkBridge(rt, inside[chunkIdx])!.batch.build()!;
        const pos = built.geometry.getAttribute('position');
        const out = new Set<string>();
        for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i) - border) < 1e-3) out.add(`${pos.getY(i).toFixed(3)}|${pos.getZ(i).toFixed(3)}`);
        return [...out].sort();
      };
      const a = ring(k), b = ring(k + 1);
      expect(a.length).toBeGreaterThan(8);
      expect(a).toEqual(b);
    }
  });

  it('truss: a node always lies on the chunk border, and bridges without a truss have none', () => {
    const { rt } = road('hauptstrasse', 'fachwerkbruecke');
    const [sec] = bridgeSections(rt);
    const inside = rt.chunks.filter((c) => rt.samples[c.i0].s >= sec.s0 && rt.samples[c.i1].s <= sec.s1);
    expect(inside.length).toBeGreaterThan(1);
    const border = rt.samples[inside[0].i1].pos.x;
    for (const idx of [0, 1]) {
      const pos = buildChunkBridge(rt, inside[idx])!.batch.build()!.geometry.getAttribute('position');
      let tall = 0;
      for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i) - border) < 0.3 && pos.getY(i) > DECK_Y + 4) tall++;
      expect(tall).toBeGreaterThan(8); // the top chord joint at the border
    }
    const balk = road('hauptstrasse', 'balkenbruecke').rt;
    for (const { b } of allBridge(balk)) {
      const built = b?.batch.build();
      if (!built) continue;
      expect(bbox(built.geometry).max.y).toBeLessThan(DECK_Y + 2); // railing height only
    }
  });

  it('arch ribs rise from the ground and stay below the deck', () => {
    const { rt } = road('hauptstrasse', 'bogenbruecke');
    const [sec] = bridgeSections(rt);
    let any = false;
    for (const { b } of allBridge(rt)) {
      const built = b?.batch.build();
      if (!built) continue;
      any = true;
      const pos = built.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        if (x > 3000 + sec.s0 + 3 && x < 3000 + sec.s1 - 3) expect(pos.getY(i)).toBeLessThan(DECK_Y + 1.2 + 0.01); // parapet is the highest thing
      }
    }
    expect(any).toBe(true);
  });

  it('wing walls and abutments exist at both ends', () => {
    const { rt } = road('hauptstrasse', 'balkenbruecke');
    const [sec] = bridgeSections(rt);
    const first = buildChunkBridge(rt, rt.chunks.find((c) => rt.samples[c.i1].s >= sec.s0 && rt.samples[c.i0].s <= sec.s0)!)!.batch.build()!;
    const box = bbox(first.geometry);
    expect(box.min.x).toBeLessThan(3000 + sec.s0 - 4); // wing walls reach back along the road
    expect(box.min.y).toBeLessThan(DECK_Y - 1);        // abutment block goes down below the deck
  });
});

describe('BridgeLayer', () => {
  function system(roads: RoadDef[]): { sys: RoadSystem; layer: BridgeLayer } {
    const lib = new BridgeLibrary();
    const sys = new RoadSystem(terrain(), (d) => profiles.resolve(d.profile, d.params), undefined, (d, p) => lib.forRoad(d, p));
    const layer = new BridgeLayer(sys, new MaterialRegistry(), {}, new PropMaterials(() => null));
    sys.setRoads(roads);
    let g = 0;
    while (sys.stats().ready < sys.stats().chunks && g++ < 300) sys.resync({ checks: 999, builds: 99 });
    return { sys, layer };
  }
  const br = (id = 'br'): RoadDef => ({
    id, name: id, profile: 'hauptstrasse',
    points: [3000, 3150, 3200, 3300, 3400, 3450, 3600].map((x) => ({ x, y: DECK_Y, z: 3000, ...(x >= 3200 && x <= 3400 ? { mode: 'bridge' as const } : {}) })),
  });

  it('builds structure meshes only for roads with bridge sections; removal and replacement clean up', () => {
    const plain: RoadDef = { id: 'p', name: 'p', profile: 'hauptstrasse', points: [3000, 3600].map((x) => ({ x, y: DECK_Y, z: 3200 })) };
    const { sys, layer } = system([br(), plain]);
    expect(layer.meshCount).toBeGreaterThan(2);
    for (const m of layer.group.children as THREE.Mesh[]) expect(m.name.startsWith('bridge:br#')).toBe(true);
    const before = layer.meshCount;
    sys.upsertRoad({ ...br(), bridge: 'viadukt' });
    expect(layer.meshCount).toBe(before); // old stays until the new one is complete
    let g = 0;
    while (sys.stats().ready < sys.stats().chunks && g++ < 300) sys.resync({ checks: 999, builds: 99 });
    expect(layer.meshCount).toBeGreaterThan(0);
    sys.removeRoad('br');
    expect(layer.meshCount).toBe(0);
    expect(layer.group.children).toHaveLength(0);
  });

  it('editing the bridge type changes what is built (identity diff in the road system)', () => {
    const lib = new BridgeLibrary();
    const sys = new RoadSystem(terrain(), (d) => profiles.resolve(d.profile, d.params), undefined, (d, p) => lib.forRoad(d, p));
    const layer = new BridgeLayer(sys, new MaterialRegistry(), {}, new PropMaterials(() => null));
    sys.setRoads([br()]);
    const settle = (): void => { let g = 0; while (sys.stats().ready < sys.stats().chunks && g++ < 300) sys.resync({ checks: 999, builds: 99 }); };
    settle();
    const heightBefore = bboxOfLayer(layer).max.y;
    lib.setSource('plattenbruecke', "export default (p, B) => B.bridge('x').deck({ thickness: 0.7 }).railing('parapet');");
    lib.setSource('balkenbruecke', "export default (p, B) => B.bridge('x').deck({ thickness: 0.7 }).truss({ height: 9 }).railing('none');");
    sys.refresh();
    settle();
    expect(bboxOfLayer(layer).max.y).toBeGreaterThan(heightBefore + 5);
  });

  function bboxOfLayer(layer: BridgeLayer): THREE.Box3 {
    const b = new THREE.Box3();
    for (const m of layer.group.children as THREE.Mesh[]) { m.geometry.computeBoundingBox(); b.union(m.geometry.boundingBox!); }
    return b;
  }

  it('lamps on a bridge are placements along both edges', () => {
    const lib = new BridgeLibrary();
    lib.setSource('balkenbruecke', "export default (p, B) => B.bridge('x').deck({ thickness: 0.5 }).lamps({ asset: 'lamp_small', spacing: 25, side: 'both' });");
    const sys = new RoadSystem(terrain(), (d) => profiles.resolve(d.profile, d.params), undefined, (d, p) => lib.forRoad(d, p));
    const layer = new BridgeLayer(sys, new MaterialRegistry(), {}, new PropMaterials(() => null));
    sys.setRoads([br()]);
    let g = 0;
    while (sys.stats().ready < sys.stats().chunks && g++ < 300) sys.resync({ checks: 999, builds: 99 });
    const ps = layer.placementsOf('br');
    expect(ps.length).toBe(16); // 200 m / 25 m = 8 per side
    expect(new Set(ps.map((p) => p.side))).toEqual(new Set(['left', 'right']));
    for (const p of ps) expect(Math.abs(p.pos.y - DECK_Y)).toBeLessThan(0.5);
  });
});

// ---- river crossings -------------------------------------------------------------------------------

import { suggestBridges, applyBridgeProposal, type RiverLike } from '../src/structures/suggest';

describe('river crossing suggestions', () => {
  const flat = (h = 800): MockStreamTerrain => {
    const t = new MockStreamTerrain({ heightFn: () => h });
    t.loadRectSync(0, 0, 6000, 6000, 4);
    return t;
  };
  const straightRoad = (id = 'r', z = 3000): RoadDef => ({ id, name: id, profile: 'hauptstrasse', points: [3000, 3250, 3500].map((x) => ({ x, y: 800, z })) });
  /** a river running north–south at x = 3250 */
  const river = (width = 10): RiverLike => ({ id: 'aare', name: 'Aare', width, points: [{ x: 3250, z: 2800 }, { x: 3250, z: 3200 }] });

  it('proposes a bridge centred on the crossing: river width + margin on both sides', () => {
    const [p] = suggestBridges([straightRoad()], [river(10)], flat());
    expect(p.roadId).toBe('r');
    expect(p.riverName).toBe('Aare');
    expect(p.crossingS).toBeCloseTo(250, 0);
    expect(p.s1 - p.s0).toBeCloseTo(10 + 16, 0);
    expect((p.s0 + p.s1) / 2).toBeCloseTo(250, 0);
  });

  it('small streams still get a bridge of the minimum length', () => {
    const [p] = suggestBridges([straightRoad()], [river(1)], flat());
    expect(p.s1 - p.s0).toBeGreaterThanOrEqual(14 - 1e-6);
  });

  it('no proposal without a crossing, for parallel rivers, or where the road already bridges', () => {
    expect(suggestBridges([straightRoad('r', 3600)], [river()], flat())).toHaveLength(0);
    expect(suggestBridges([straightRoad()], [{ id: 'par', points: [{ x: 3000, z: 3010 }, { x: 3500, z: 3010 }] }], flat())).toHaveLength(0);
    const bridged: RoadDef = { ...straightRoad(), points: [{ x: 3000, y: 800, z: 3000 }, { x: 3200, y: 800, z: 3000, mode: 'bridge' }, { x: 3300, y: 800, z: 3000, mode: 'bridge' }, { x: 3500, y: 800, z: 3000 }] };
    expect(suggestBridges([bridged], [river()], flat())).toHaveLength(0);
  });

  it('a meandering river crossed twice close together gets one bridge; far apart crossings get two', () => {
    const meander: RiverLike = { id: 'm', width: 8, points: [{ x: 3240, z: 2900 }, { x: 3240, z: 3010 }, { x: 3262, z: 3010 }, { x: 3262, z: 2990 }, { x: 3262, z: 2900 }] };
    // the road at z = 3000 is crossed at x = 3240 (going north) … and 3262 (coming back) → 22 m apart → one
    expect(suggestBridges([straightRoad()], [meander], flat())).toHaveLength(1);
    const far: RiverLike = { id: 'f', points: [{ x: 3100, z: 2900 }, { x: 3100, z: 3100 }, { x: 3400, z: 3100 }, { x: 3400, z: 2900 }] };
    expect(suggestBridges([straightRoad()], [far], flat())).toHaveLength(2);
  });

  it('the deck is lifted above terrain that rises between the banks', () => {
    const t = new MockStreamTerrain({ heightFn: (x) => (Math.abs(x - 3250) < 6 ? 806 : 800) }); // a levee in the middle
    t.loadRectSync(0, 0, 6000, 6000, 4);
    t.loadRectSync(3100, 2900, 3400, 3100, 0);
    const [p] = suggestBridges([straightRoad()], [river(10)], t);
    expect(p.y0).toBeGreaterThanOrEqual(806 + 1.2 - 0.5);
    expect(p.y1).toBeGreaterThanOrEqual(806 + 1.2 - 0.5);
  });

  it('applying turns the span into bridge points — one undo step, deck heights fixed and straight', () => {
    const model = new RoadModel();
    model.load({ version: 1, roads: [straightRoad()] });
    const [p] = suggestBridges(model.list, [river(10)], flat());
    model.transact('Brücke', (d) => { applyBridgeProposal(d, p); });
    const r = model.get('r')!;
    const bridgePts = r.points.filter((q) => q.mode === 'bridge');
    expect(bridgePts.length).toBeGreaterThanOrEqual(3); // both ends + the existing point at 3250
    for (const q of bridgePts) { expect(q.elev).toBe('fixed'); expect(q.y).toBeGreaterThanOrEqual(800); }
    // points before and after are untouched and in order
    expect(r.points[0]).toEqual({ x: 3000, y: 800, z: 3000 });
    expect(r.points[r.points.length - 1]).toEqual({ x: 3500, y: 800, z: 3000 });
    const xs = r.points.map((q) => q.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    // and it is now a bridge section of the right length
    const sampledSec = (() => {
      const rt = new RoadRuntime(r, flat(), profiles.resolve('hauptstrasse'), DEFAULT_RUNTIME_OPTIONS);
      return bridgeSections(rt)[0];
    })();
    expect(sampledSec.s1 - sampledSec.s0).toBeCloseTo(p.s1 - p.s0, 0);
    model.undo();
    expect(model.get('r')!.points).toHaveLength(3);
    // after applying, the crossing is no longer proposed
    model.redo();
    expect(suggestBridges(model.list, [river(10)], flat())).toHaveLength(0);
  });

  it('existing points near the ends are reused instead of leaving a duplicate next to them', () => {
    const near: RoadDef = { ...straightRoad(), points: [3000, 3237, 3250, 3263, 3500].map((x) => ({ x, y: 800, z: 3000 })) };
    const model = new RoadModel();
    model.load({ version: 1, roads: [near] });
    const [p] = suggestBridges(model.list, [river(10)], flat());
    model.transact('Brücke', (d) => { applyBridgeProposal(d, p); });
    const xs = model.get('r')!.points.map((q) => Math.round(q.x));
    expect(new Set(xs).size).toBe(xs.length);
    expect(model.get('r')!.points.length).toBeLessThanOrEqual(7);
  });
});

describe('several bridge types on one road, and the single big arch', () => {
  function roadWithNamed(overrides: Record<number, string>, bridge = 'balkenbruecke'): { rt: RoadRuntime; def: RoadDef } {
    const lib = new BridgeLibrary();
    const xs = [3000, 3150, 3200, 3300, 3400, 3450, 3600];
    const def: RoadDef = {
      id: 'br', name: 'br', profile: 'hauptstrasse', bridge,
      points: xs.map((x, i) => ({ x, y: DECK_Y, z: 3000, ...(x >= 3200 && x <= 3400 ? { mode: 'bridge' as const } : {}), ...(overrides[i] ? { bridge: overrides[i] } : {}) })),
    };
    const prof = profiles.resolve('hauptstrasse');
    const rt = new RoadRuntime(def, terrain(), prof, DEFAULT_RUNTIME_OPTIONS, undefined, lib.forRoad(def, prof));
    rt.namedBridge = (name) => lib.forRoad({ ...def, bridge: name, bridgeParams: undefined }, prof);
    let guard = 0;
    while (rt.pendingCount > 0 && guard++ < 50) rt.chunks.forEach((c) => rt.tryBuildChunk(c));
    return { rt, def };
  }

  it('a point that names another type splits the run: two sections share the boundary sample', () => {
    const { rt } = roadWithNamed({ 3: 'viadukt' });
    const secs = bridgeSections(rt);
    expect(secs).toHaveLength(2);
    expect(secs[0].bridge.name).toBe('Balkenbrücke');
    expect(secs[1].bridge.name).toBe('Viadukt');
    expect(secs[0].s1).toBe(secs[1].s0);
    expect(secs[0].i1).toBe(secs[1].i0);
    expect([secs[0].startsAtRoad, secs[0].endsAtBridge, secs[1].startsAtBridge, secs[1].endsAtRoad]).toEqual([true, true, true, true]);
    expect([secs[0].endsAtRoad, secs[1].startsAtRoad]).toEqual([false, false]); // no abutment where they meet
    // and without a naming point there is one section
    expect(bridgeSections(roadWithNamed({}).rt)).toHaveLength(1);
  });

  it('a full-height pier stands where two types meet; abutments only where the bridge meets the road', () => {
    const { rt } = roadWithNamed({ 3: 'viadukt' });
    let lowest = Infinity;
    const xs: number[] = [];
    for (const { b } of allBridge(rt)) {
      const built = b?.batch.build();
      if (!built) continue;
      const pos = built.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i) - 3300) < 4) { lowest = Math.min(lowest, pos.getY(i)); xs.push(pos.getX(i)); }
    }
    expect(lowest).toBeLessThan(DECK_Y - 28); // the gorge floor is at 770
    expect(xs.length).toBeGreaterThan(20);
  });

  it('the deck follows each type: its slab is as thick as the type says on either side of the boundary', () => {
    const { rt } = roadWithNamed({ 3: 'viadukt' });
    const t0 = rt.bridgeOfSample(bridgeSections(rt)[0].i0 + 1).deck.thickness, t1 = rt.bridgeOfSample(bridgeSections(rt)[1].i0 + 1).deck.thickness;
    expect(t0).not.toBe(t1);
    let lowW = Infinity, lowE = Infinity;
    for (const ch of rt.chunks) {
      const { geometry } = buildChunkGeometry(rt, ch);
      const pos = geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        if (x > 3220 && x < 3280) lowW = Math.min(lowW, pos.getY(i));
        if (x > 3320 && x < 3380) lowE = Math.min(lowE, pos.getY(i));
      }
    }
    expect(DECK_Y - lowW).toBeLessThan(t0 + 0.4);
    expect(DECK_Y - lowE).toBeGreaterThan(t1 - 0.4);
    expect(DECK_Y - lowE).toBeLessThan(t1 + 0.4);
  });

  it('grossbogen is ONE span over the whole section and its crown touches the underside of the deck', () => {
    const { rt } = roadWithNamed({}, 'grossbogen');
    const [sec] = bridgeSections(rt);
    expect(sec.bridge.piers).toBeNull();
    const t = rt.bridge.deck.thickness;
    let crownTop = -Infinity;
    let ribs = 0;
    for (const { b } of allBridge(rt)) {
      const built = b?.batch.build();
      if (!built) continue;
      const pos = built.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getX(i) - 3300) < 1.5 && pos.getY(i) < DECK_Y - t + 0.01) { crownTop = Math.max(crownTop, pos.getY(i)); ribs++; }
      }
    }
    expect(ribs).toBeGreaterThan(8);
    expect(crownTop).toBeCloseTo(DECK_Y - t - 0.02, 1);
  });

  it('arch piers stand under every rib: the foot of a pier reaches out to each rib', () => {
    // a wide deck (the ribs sit far apart): there must be a pier column under each of them
    const { rt } = roadWithNamed({}, 'bogenbruecke');
    const piers = pierPositionsFor(rt, bridgeSections(rt)[0], rt.bridge.piers!.maxSpan);
    const xp = piers.reduce((best, s) => (Math.abs(s - 300) < Math.abs(best - 300) ? s : best), piers[0]); // the pier in the gorge
    const ground = gorge(3000 + xp);
    const ribX = rt.bridge.arch!.spread * rt.profile.coreHalfWidth;
    const lateral: number[] = [];
    for (const { b } of allBridge(rt)) {
      const built = b?.batch.build();
      if (!built) continue;
      const pos = built.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        // the lowest metre above the ground at that pier: the ribs are far above it, only the pier itself is here
        if (Math.abs(pos.getX(i) - 3000 - xp) < 2 && pos.getY(i) < ground + 1.2) lateral.push(pos.getZ(i) + 3000);
      }
    }
    expect(lateral.length).toBeGreaterThan(8);
    expect(Math.max(...lateral)).toBeGreaterThan(ribX - 0.3);
    expect(Math.min(...lateral)).toBeLessThan(-ribX + 0.3);
    // and nothing is wasted in the middle: one column per rib, not one slab across both
    expect(lateral.filter((z) => Math.abs(z) < ribX - 1.5).length).toBe(0);
  });

  it('spandrel columns are spread evenly over a span, symmetric about its middle', () => {
    const { rt } = roadWithNamed({}, 'bogenbruecke');
    const [sec] = bridgeSections(rt);
    const supports = [sec.s0 + rt.bridge.abutments.depth * 0.5, ...pierPositionsFor(rt, sec, rt.bridge.piers!.maxSpan), sec.s1 - rt.bridge.abutments.depth * 0.5];
    expect(supports.length).toBeGreaterThanOrEqual(3);
    // the arch spans from support to support; the same rule gives the column positions
    const A = rt.bridge.arch!;
    const span = supports[2] - supports[1];
    const n = Math.max(2, Math.round(span / A.spandrelSpacing));
    const cols = Array.from({ length: n - 1 }, (_, i) => supports[1] + (span * (i + 1)) / n);
    for (let i = 0; i < cols.length; i++) expect(cols[i] - supports[1]).toBeCloseTo(supports[2] - cols[cols.length - 1 - i], 6);
  });
});
