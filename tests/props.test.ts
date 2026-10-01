import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadRuntime, DEFAULT_RUNTIME_OPTIONS } from '../src/runtime/roadRuntime';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { profileApi } from '../src/profile/builder';
import type { ProfileData } from '../src/profile/types';
import { placeChunk, type Placement } from '../src/props/place';
import { ChunkSampler } from '../src/props/sampler';
import { GeometryBatch } from '../src/props/batch';
import { buildRail } from '../src/props/guardrail';
import { PropLayer } from '../src/props/propLayer';
import { PropAssets, BUILTIN_ASSETS } from '../src/props/assets';
import { PropMaterials } from '../src/props/materials';
import { SIGN_CATALOG, parseSignAsset, drawSign, plateOutline, type Ctx2D } from '../src/props/signs';
import { junctionSignKinds, placeJunctionSigns } from '../src/props/junctionSigns';
import type { NodeDef, RoadDef } from '../src/network/types';

const R = profileApi;
const lib = new ProfileLibrary();

/** flat ground at 800 m, with a cliff on the road's right-hand side (sim z smaller = right when heading +x… see below) */
function flat(): MockStreamTerrain {
  const t = new MockStreamTerrain({ heightFn: () => 800 });
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2700, 2400, 3900, 3400, 0);
  return t;
}
/** ground falls 20 m away for sim z > 3010 over x in [3150, 3350] → a cliff beside a road running along x at z = 3000 */
function cliff(): MockStreamTerrain {
  const fn = (x: number, z: number): number => (x > 3150 && x < 3350 && z > 3004 ? 780 : 800);
  const t = new MockStreamTerrain({ heightFn: fn });
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2700, 2400, 3900, 3400, 0);
  return t;
}

function straight(profile: ProfileData, t: MockStreamTerrain, id = 'p', extra: Partial<RoadDef> = {}): RoadRuntime {
  const def: RoadDef = { id, name: id, profile: 'x', points: [[3000, 3000], [3200, 3000], [3400, 3000], [3600, 3000]].map(([x, z]) => ({ x, y: 800, z })), ...extra };
  const rt = new RoadRuntime(def, t, profile, DEFAULT_RUNTIME_OPTIONS);
  rt.chunks.forEach((c) => rt.tryBuildChunk(c));
  return rt;
}

const base = () => R.profile('t').thickness(0.6).both((h) => h.surface(3, 'asphalt', { kind: 'lane' }).surface(1, 'gravel', { kind: 'verge', core: false }));

describe('prop rules in the profile DSL', () => {
  it('collects scatter / lamps / guardrail rules and defaults the rank from the width', () => {
    const p = base().scatter('delineator', { spacing: 50 }).lamps({ spacing: 30, side: 'left' }).guardrail('both').finish();
    expect(p.props.map((r) => r.kind)).toEqual(['scatter', 'scatter', 'guardrail']);
    expect(p.props[1]).toMatchObject({ asset: 'lamp', spacing: 30, side: 'left' });
    expect(p.rank).toBe(6);
    expect(base().rank(3).finish().rank).toBe(3);
  });
  it('rejects a scatter rule without spacing or positions', () => {
    expect(() => base().scatter('lamp', { spacing: 0 })).toThrow(/spacing/);
  });
  it('presets compile with props', () => {
    for (const n of lib.names()) expect(Array.isArray(lib.resolve(n).props)).toBe(true);
  });
});

describe('scatter placement', () => {
  const profile = base().scatter('delineator', { spacing: 25, offset: 1.5, side: 'right' }).finish();
  const rt = straight(profile, flat());
  const all = (): Placement[] => rt.chunks.flatMap((c) => placeChunk(rt, c).placements);

  it('every prop appears exactly once across chunks, evenly spaced in absolute arc length', () => {
    const ss = all().map((p) => p.s).sort((a, b) => a - b);
    expect(ss.length).toBeGreaterThan(20);
    for (let i = 1; i < ss.length; i++) expect(ss[i] - ss[i - 1]).toBeCloseTo(25, 3);
  });

  it('stands on the right-hand side, outside the carriageway, with its front towards the road', () => {
    const p = all()[3];
    // the road runs along sim +x = three +x (z unchanged), travelling at three z = −3000… compute lateral offset instead of assuming axes
    const sampler = new ChunkSampler(rt, rt.chunks[0]);
    const c = sampler.point(p.s, 0);
    const rel = p.pos.clone().sub(c.pos);
    expect(rel.dot(c.right)).toBeCloseTo(3 + 1.5, 1);
    const front = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    expect(front.dot(c.right)).toBeCloseTo(-1, 3);
  });

  it('stands on the terrain/surface (y near the road, not at 0)', () => {
    for (const p of all()) expect(Math.abs(p.pos.y - 800)).toBeLessThan(2);
  });

  it('is deterministic', () => {
    const a = all().map((p) => `${p.s.toFixed(4)}:${p.pos.x.toFixed(4)}`);
    const b = all().map((p) => `${p.s.toFixed(4)}:${p.pos.x.toFixed(4)}`);
    expect(a).toEqual(b);
  });

  it('`at` positions count from the start, negative from the end', () => {
    const pr = base().scatter('sign:stop', { at: [10, -10] }).finish();
    const r2 = straight(pr, flat());
    const ps = r2.chunks.flatMap((c) => placeChunk(r2, c).placements).map((p) => p.s).sort((a, b) => a - b);
    const first = r2.samples[0].s, last = r2.samples[r2.samples.length - 1].s;
    expect(ps).toHaveLength(2);
    expect(ps[0]).toBeCloseTo(first + 10, 3);
    expect(ps[1]).toBeCloseTo(last - 10, 3);
  });

  it('`when` filters, and a throwing `when` just drops the prop', () => {
    const half = base().scatter('bollard', { spacing: 20, when: (c) => c.s < 100 }).finish();
    const r2 = straight(half, flat());
    const ps = r2.chunks.flatMap((c) => placeChunk(r2, c).placements);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) expect(p.s).toBeLessThan(100);
    const bad = base().scatter('bollard', { spacing: 20, when: () => { throw new Error('boom'); } }).finish();
    const r3 = straight(bad, flat());
    expect(r3.chunks.flatMap((c) => placeChunk(r3, c).placements)).toHaveLength(0);
  });

  it('stagger shifts the left row by half a spacing', () => {
    const pr = base().scatter('bollard', { spacing: 20, side: 'both', stagger: true }).finish();
    const r2 = straight(pr, flat());
    const ps = r2.chunks.flatMap((c) => placeChunk(r2, c).placements);
    const right = ps.filter((p) => p.side === 'right').map((p) => p.s).sort((a, b) => a - b);
    const left = ps.filter((p) => p.side === 'left').map((p) => p.s).sort((a, b) => a - b);
    expect(left[0] - right[0]).toBeCloseTo(10, 3);
  });

  it('props are not placed on a bridge unless the rule allows it', () => {
    const pts = [[3000, 3000], [3200, 3000], [3400, 3000], [3600, 3000]].map(([x, z], i) => ({ x, y: 800, z, ...(i >= 1 && i <= 2 ? { mode: 'bridge' as const } : {}) }));
    const def: RoadDef = { id: 'b', name: 'b', profile: 'x', points: pts };
    const r2 = new RoadRuntime(def, flat(), base().scatter('bollard', { spacing: 20 }).finish(), DEFAULT_RUNTIME_OPTIONS);
    r2.chunks.forEach((c) => r2.tryBuildChunk(c));
    const ss = r2.chunks.flatMap((c) => placeChunk(r2, c).placements).map((p) => p.s);
    expect(ss.some((s) => s > 250 && s < 350)).toBe(false);
    expect(ss.some((s) => s < 150)).toBe(true);
  });
});

describe('guardrail auto rule', () => {
  const profile = base().guardrail('both').finish();
  const sideOfCliff = (): 'left' | 'right' => {
    // find out which side of the road the cliff lies on by looking at where rails appear
    const rt = straight(profile, cliff());
    return rt.chunks.flatMap((c) => placeChunk(rt, c).rails)[0]?.side ?? 'right';
  };

  it('builds rails only along the cliff, on the cliff side, and none on flat ground', () => {
    const rtFlat = straight(profile, flat());
    expect(rtFlat.chunks.flatMap((c) => placeChunk(rtFlat, c).rails)).toHaveLength(0);

    const rt = straight(profile, cliff());
    const rails = rt.chunks.flatMap((c) => placeChunk(rt, c).rails);
    expect(rails.length).toBeGreaterThan(0);
    const side = sideOfCliff();
    for (const r of rails) expect(r.side).toBe(side);
    // the cliff covers x 3150…3350 → road s 150…350 (road starts at x = 3000); rails stay near it (pad 8 m)
    const sMin = Math.min(...rails.map((r) => r.sA)), sMax = Math.max(...rails.map((r) => r.sB));
    expect(sMin).toBeGreaterThan(150 - 12);
    expect(sMax).toBeLessThan(350 + 12);
    expect(sMax - sMin).toBeGreaterThan(180);
  });

  it('a rail crossing a chunk border is continuous: runs meet at the shared sample and only the outer ends are free', () => {
    const rt = straight(profile, cliff());
    const rails = rt.chunks.flatMap((c) => placeChunk(rt, c).rails).sort((a, b) => a.sA - b.sA);
    for (let i = 1; i < rails.length; i++) {
      expect(rails[i].sA).toBeCloseTo(rails[i - 1].sB, 6); // seamless
      expect(rails[i].startFree).toBe(false);
      expect(rails[i - 1].endFree).toBe(false);
    }
    expect(rails[0].startFree).toBe(true);
    expect(rails[rails.length - 1].endFree).toBe(true);
  });

  it('posts: every 4 m for steel, none in the middle of a chunk border twice', () => {
    const rt = straight(profile, cliff());
    const posts = rt.chunks.flatMap((c) => placeChunk(rt, c).placements).filter((p) => p.asset === 'post_steel').map((p) => p.s).sort((a, b) => a - b);
    expect(posts.length).toBeGreaterThan(30);
    for (let i = 1; i < posts.length; i++) expect(posts[i] - posts[i - 1]).toBeGreaterThan(0.25); // no duplicates
    const interior = posts.slice(2, -2);
    for (let i = 1; i < interior.length; i++) expect(interior[i] - interior[i - 1]).toBeCloseTo(4, 3);
  });

  it('`when` overrides the auto rule; concrete barriers have no posts', () => {
    const always = base().guardrail('right', { variant: 'concrete', when: () => true }).finish();
    const rt = straight(always, flat());
    const out = rt.chunks.map((c) => placeChunk(rt, c));
    expect(out.flatMap((o) => o.rails).length).toBeGreaterThan(0);
    expect(out.flatMap((o) => o.placements)).toHaveLength(0);
  });

  it('rail geometry: closed shapes have caps, normals are unit length, vertices stay near the rail line', () => {
    for (const variant of ['steel', 'concrete', 'wood', 'cable'] as const) {
      const pr = base().guardrail('right', { variant, when: () => true }).finish();
      const rt = straight(pr, flat());
      const props = placeChunk(rt, rt.chunks[1]);
      expect(props.sampler).not.toBeNull();
      const batch = new GeometryBatch();
      for (const run of props.rails) buildRail(props.sampler!, run, batch);
      const built = batch.build()!;
      expect(built.materials.length).toBeGreaterThan(0);
      const pos = built.geometry.getAttribute('position'), nrm = built.geometry.getAttribute('normal');
      expect(pos.count).toBeGreaterThan(20);
      for (let i = 0; i < nrm.count; i++) {
        expect(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))).toBeCloseTo(1, 3);
        expect(Math.abs(pos.getY(i) - 800)).toBeLessThan(2);
      }
    }
  });

  it('steel rail ends with a lowered terminal', () => {
    const pr = base().guardrail('right', { when: (c) => c.s > 100 && c.s < 200, pad: 0 }).finish();
    const rt = straight(pr, flat());
    const out = rt.chunks.map((c) => placeChunk(rt, c));
    const withRail = out.find((o) => o.rails.length)!;
    const batch = new GeometryBatch();
    buildRail(withRail.sampler!, withRail.rails[0], batch);
    const g = batch.build()!.geometry;
    const pos = g.getAttribute('position');
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) { minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i)); }
    expect(maxY - minY).toBeGreaterThan(0.7);
    expect(minY).toBeLessThan(800.2 + 0.1); // dips to ground level at the end (surface ≈ 800.15)
  });
});

describe('assets, signs, materials', () => {
  it('every built-in asset builds non-empty geometry with known materials', () => {
    const assets = new PropAssets();
    const mats = new PropMaterials(() => null);
    for (const name of Object.keys(BUILTIN_ASSETS)) {
      const parts = assets.parts(name);
      expect(parts.length).toBeGreaterThan(0);
      for (const p of parts) {
        expect(p.geometry.getAttribute('position').count).toBeGreaterThan(3);
        expect(mats.get(p.material)).toBeTruthy();
      }
    }
  });

  it('every catalogue sign becomes pole + front + back; unknown assets give a visible marker, never an exception', () => {
    const assets = new PropAssets();
    for (const id of Object.keys(SIGN_CATALOG)) expect(assets.parts(`sign:${id}:Text`)).toHaveLength(3);
    const unknown = assets.parts('does_not_exist');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].material).toBe('marker');
  });

  it('assets can be replaced', () => {
    const assets = new PropAssets();
    const before = assets.parts('bollard');
    assets.register('bollard', { build: () => [{ geometry: new THREE.BoxGeometry(1, 1, 1), material: 'steel' }] });
    const after = assets.parts('bollard');
    expect(after).not.toBe(before);
    expect(after).toHaveLength(1);
  });

  it('sign ids parse, with and without a label text', () => {
    expect(parseSignAsset('sign:speed_50')).toMatchObject({ id: 'speed_50', text: undefined });
    expect(parseSignAsset('sign:wegweiser_blue:Thun|14 km')).toMatchObject({ id: 'wegweiser_blue', text: 'Thun|14 km' });
    expect(parseSignAsset('sign:nope')).toBeNull();
    expect(parseSignAsset('lamp')).toBeNull();
  });

  it('every sign design draws without errors on a recording canvas, and paints something', () => {
    for (const def of Object.values(SIGN_CATALOG)) {
      const calls: string[] = [];
      const ctx = new Proxy({} as Record<string, unknown>, {
        get: (_t, k) => (typeof k === 'string' && !['fillStyle', 'strokeStyle', 'lineWidth'].includes(k) ? (...a: unknown[]) => { calls.push(`${k}(${a.length})`); } : undefined),
        set: () => true,
      }) as unknown as Ctx2D;
      const canvas = { width: 0, height: 0, getContext: () => ctx };
      const out = drawSign(def, 'Bern|10 km', 128, () => canvas);
      expect(out).toBe(canvas);
      expect(calls.some((c) => c.startsWith('fill'))).toBe(true);
    }
  });

  it('without a canvas, signs fall back to a plain colour', () => {
    const mats = new PropMaterials(() => null);
    const m = mats.get('sign:stop') as THREE.MeshLambertMaterial;
    expect(m.map).toBeNull();
    expect(m.color.getHex()).toBe(SIGN_CATALOG.stop.baseColor);
  });

  it('plate outlines fit the unit box', () => {
    for (const shape of ['disc', 'triangle-up', 'triangle-down', 'octagon', 'diamond', 'rect'] as const)
      for (const [x, y] of plateOutline(shape)) { expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-9); expect(Math.abs(y)).toBeLessThanOrEqual(0.5 + 1e-9); }
  });
});

describe('junction right-of-way signs', () => {
  it('topology: equal ranks → none; unequal → major gets Hauptstrasse, minor Kein Vortritt; paths ignored', () => {
    expect(junctionSignKinds([5, 5, 5])).toEqual([null, null, null]);
    expect(junctionSignKinds([5, 5, 3])).toEqual(['hauptstrasse', 'hauptstrasse', 'kein_vortritt']);
    expect(junctionSignKinds([5, 5, 1])).toEqual([null, null, null]); // a footpath doesn't count → only two eligible arms
    expect(junctionSignKinds([6, 4, 3, 1])).toEqual(['hauptstrasse', 'kein_vortritt', 'kein_vortritt', null]);
    expect(junctionSignKinds([8, 8, 2], { minRank: 2, stopRankGap: 5, setbackM: 3, edgeGapM: 1 })).toEqual(['hauptstrasse', 'hauptstrasse', 'stop']);
    expect(junctionSignKinds([5, 3])).toEqual([null, null]);
  });

  const NODE: NodeDef = { id: 'n1', x: 3300, y: 800, z: 3000 };
  const roads = (): RoadDef[] => [
    { id: 'w', name: 'w', profile: 'hauptstrasse', points: [[3000, 3000], [3150, 3000], [3300, 3000]].map(([x, z]) => ({ x, y: 800, z })), endNode: 'n1' },
    { id: 'e', name: 'e', profile: 'hauptstrasse', points: [[3300, 3000], [3450, 3000], [3600, 3000]].map(([x, z]) => ({ x, y: 800, z })), startNode: 'n1' },
    { id: 's', name: 's', profile: 'flurstrasse', points: [[3300, 2700], [3300, 2850], [3300, 3000]].map(([x, z]) => ({ x, y: 800, z })), endNode: 'n1' },
  ];

  function system(): RoadSystem {
    const sys = new RoadSystem(flat(), (d) => lib.resolve(d.profile, d.params));
    sys.setNetwork(roads(), [NODE]);
    let guard = 0;
    while ((sys.stats().ready < sys.stats().chunks || sys.junctionStats().ready < sys.junctionStats().total) && guard++ < 200) sys.resync({ checks: 999, builds: 99 });
    return sys;
  }

  it('signs stand beside the arm, facing approaching traffic, on its right-hand edge', () => {
    const sys = system();
    const j = sys.junctions[0];
    const placements = placeJunctionSigns(j);
    expect(placements.map((p) => p.asset).sort()).toEqual(['sign:hauptstrasse', 'sign:hauptstrasse', 'sign:kein_vortritt']);
    const centre = new THREE.Vector3(NODE.x, 0, -NODE.z);
    for (const p of placements) {
      const front = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
      const toSign = new THREE.Vector3(p.pos.x - centre.x, 0, p.pos.z - centre.z);
      // front points away from the node (towards the approaching traffic) and the sign is within ~25 m of it
      expect(front.dot(toSign.clone().normalize())).toBeGreaterThan(0.8);
      expect(toSign.length()).toBeLessThan(25);
      expect(toSign.length()).toBeGreaterThan(4);
    }
    // sign for the side road stands to the right of traffic coming from the south: i.e. at larger three-x? check handedness
    const side = placements.find((p) => p.asset === 'sign:kein_vortritt')!;
    // the side road comes from sim z 2700 (three z −2700) toward the node (three z −3000): travelling to −z, right is +x
    expect(side.pos.x).toBeGreaterThan(centre.x + 1.5);
  });
});

describe('PropLayer', () => {
  function layerSystem(profileName = 'hauptstrasse') {
    const sys = new RoadSystem(cliff(), (d) => lib.resolve(d.profile, d.params));
    const layer = new PropLayer(sys, {}, new PropMaterials(() => null));
    const road: RoadDef = { id: 'a', name: 'a', profile: profileName, points: [[3000, 3000], [3200, 3000], [3400, 3000], [3600, 3000]].map(([x, z]) => ({ x, y: 800, z })) };
    sys.setRoads([road]);
    let guard = 0;
    while (sys.stats().ready < sys.stats().chunks && guard++ < 200) sys.resync({ checks: 999, builds: 99 });
    return { sys, layer, road };
  }

  it('builds merged prop meshes for ready chunks (guardrail along the cliff, delineators elsewhere)', () => {
    const { layer } = layerSystem();
    expect(layer.meshCount).toBeGreaterThan(3);
    const assets = new Set(layer.allPlacements().map((p) => p.asset));
    expect(assets.has('post_steel')).toBe(true);
    expect(layer.railRuns().length).toBeGreaterThan(0);
    for (const m of layer.group.children as THREE.Mesh[]) expect(Array.isArray(m.material)).toBe(true);
  });

  it('removing the road disposes its props; replacing keeps the old ones until the new version is complete', () => {
    const { sys, layer, road } = layerSystem();
    const before = layer.meshCount;
    expect(before).toBeGreaterThan(0);
    sys.upsertRoad({ ...road, points: road.points.map((p, i) => (i === 1 ? { ...p, z: p.z + 5 } : p)) });
    expect(layer.meshCount).toBe(before); // old version still visible
    let guard = 0;
    while (sys.stats().ready < sys.stats().chunks && guard++ < 200) sys.resync({ checks: 999, builds: 99 });
    expect(layer.meshCount).toBeGreaterThan(0);
    expect(layer.meshCount).toBeLessThanOrEqual(before + 2);
    sys.removeRoad('a');
    expect(layer.meshCount).toBe(0);
    expect(layer.group.children).toHaveLength(0);
  });

  it('update() hides chunks beyond the draw distance', () => {
    const { layer } = layerSystem();
    layer.update(new THREE.Vector3(3300, 800, -3000));
    const near = (layer.group.children as THREE.Mesh[]).filter((m) => m.visible).length;
    layer.update(new THREE.Vector3(99999, 0, 99999));
    expect((layer.group.children as THREE.Mesh[]).filter((m) => m.visible).length).toBe(0);
    expect(near).toBeGreaterThan(0);
  });

  it('a profile without props produces no prop meshes', () => {
    const { layer } = layerSystem('trampelpfad');
    expect(layer.meshCount).toBe(0);
  });
});

describe('presets with props', () => {
  it('every preset builds its props on flat ground and at a cliff, with finite geometry and ranks in order', () => {
    for (const name of lib.names()) {
      for (const t of [flat(), cliff()]) {
        const sys = new RoadSystem(t, (d) => lib.resolve(d.profile, d.params));
        const layer = new PropLayer(sys, {}, new PropMaterials(() => null));
        sys.setRoads([{ id: 'a', name: 'a', profile: name, points: [[3000, 3000], [3200, 3000], [3400, 3000], [3600, 3000]].map(([x, z]) => ({ x, y: 800, z })) }]);
        let guard = 0;
        while (sys.stats().ready < sys.stats().chunks && guard++ < 200) sys.resync({ checks: 999, builds: 99 });
        for (const m of layer.group.children as THREE.Mesh[]) {
          const pos = m.geometry.getAttribute('position');
          for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
          expect(m.geometry.boundingSphere!.radius).toBeGreaterThan(0);
        }
        layer.dispose();
      }
    }
    const rank = (n: string): number => lib.resolve(n).rank;
    expect(rank('trampelpfad')).toBeLessThan(rank('flurstrasse'));
    expect(rank('flurstrasse')).toBeLessThan(rank('hauptstrasse'));
    expect(rank('hauptstrasse')).toBeLessThan(rank('autobahn'));
  });
});
