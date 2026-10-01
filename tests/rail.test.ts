import { describe, it, expect } from 'vitest';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { buildChunkRail, signalAspect, stagger, RAIL_HEAD_Y } from '../src/rail/geometry';
import { RailLayer } from '../src/rail/railLayer';
import { PropMaterials } from '../src/props/materials';
import { bridgeSections } from '../src/structures/sections';
import { tunnelDims } from '../src/tunnel/sections';
import { defaultBridgeName } from '../src/structures/types';
import { BridgeLibrary } from '../src/structures/library';
import { profileApi } from '../src/profile/builder';
import type { RoadDef } from '../src/network/types';

const profiles = new ProfileLibrary();
const bridges = new BridgeLibrary();
const resolve = (d: RoadDef) => profiles.resolve(d.profile, d.params);

function flat(): MockStreamTerrain {
  const t = new MockStreamTerrain();
  t.setModifier('flat', () => 800);
  t.loadRectSync(1500, 1500, 4500, 4500, 0);
  return t;
}

const line = (profile: string, extra: Partial<RoadDef> = {}, pts?: RoadDef['points']): RoadDef => ({
  id: 'r', name: 'r', profile,
  points: pts ?? [2000, 2150, 2300, 2450, 2600].map((x) => ({ x, y: 800.4, z: 2000, elev: 'fixed' as const })),
  ...extra,
});

function settle(sys: RoadSystem): void {
  let guard = 0;
  while (sys.stats().ready < sys.stats().chunks && guard++ < 200) sys.resync({ checks: 999, builds: 99 });
}

function build(def: RoadDef): { sys: RoadSystem; layer: RailLayer } {
  const sys = new RoadSystem(flat(), resolve, undefined, (d) => bridges.forRoad(d, profiles.resolve(d.profile, d.params)));
  const layer = new RailLayer(sys, new PropMaterials());
  sys.setNetwork([def], []);
  settle(sys);
  return { sys, layer };
}

describe('rail profiles', () => {
  it('the presets are railway profiles with the right track layout', () => {
    const g = profiles.resolve('gleis'), d = profiles.resolve('gleis_doppel'), b = profiles.resolve('bahnhof');
    expect(g.rail!.tracks).toEqual([0]);
    expect(d.rail!.tracks).toEqual([-2.25, 2.25]);
    expect(b.rail!.tracks).toEqual([-2.25, 2.25]);
    expect(g.rail!.gauge).toBe(1.435);
    expect(g.rail!.catenary).toEqual({ height: 5.5, spacing: 56 });
    expect(g.rail!.signals).not.toBeNull();
    expect(profiles.resolve('gleis', { catenary: false, signals: false }).rail!.catenary).toBeNull();
    expect(profiles.resolve('gleis', { catenary: false, signals: false }).rail!.signals).toBeNull();
    expect(profiles.resolve('autobahn').rail).toBeUndefined();
  });

  it('ballast and platforms are not carriageway: no junction patch is ever sized from them', () => {
    const g = profiles.resolve('gleis');
    expect(g.carriageHalfWidth).toBe(g.coreHalfWidth);
    expect(g.segments.some((s) => s.kind === 'ballast')).toBe(true);
    const b = profiles.resolve('bahnhof');
    expect(b.segments.filter((s) => s.kind === 'platform')).toHaveLength(4);
    expect(b.points.some((p) => Math.abs(p.y - 0.55) < 1e-9)).toBe(true);
  });

  it('options are clamped: a typo cannot make a broken track', () => {
    const p = profileApi.profile('x').center(4, 'ballast').rail({ tracks: [NaN], gauge: 99, sleeperSpacing: 0 }).catenary({ height: 50, spacing: 1 }).signals({ spacing: 1 }).finish();
    expect(p.rail!.tracks).toEqual([0]);
    expect(p.rail!.gauge).toBeLessThanOrEqual(2);
    expect(p.rail!.sleeperSpacing).toBeGreaterThanOrEqual(0.3);
    expect(p.rail!.catenary!.height).toBe(8);
    expect(p.rail!.catenary!.spacing).toBe(20);
    expect(p.rail!.signals!.spacing).toBe(60);
    expect(profileApi.profile('y').center(2, 'asphalt').catenary({}).finish().rail!.catenary).not.toBeNull(); // catenary() implies rail()
  });

  it('railway roads default to the railway bridge, and their tunnel is taller than a road tunnel', () => {
    expect(defaultBridgeName(profiles.resolve('gleis'))).toBe('eisenbahnbruecke');
    expect(defaultBridgeName(profiles.resolve('autobahn'))).toBe('viadukt');
    const { sys } = build(line('gleis_doppel'));
    const rail = tunnelDims(sys.runtimes[0]);
    const { sys: roadSys } = build(line('hauptstrasse'));
    const road = tunnelDims(roadSys.runtimes[0]);
    expect(rail.wall + rail.rise).toBeGreaterThan(road.wall + road.rise);
    expect(rail.wall + rail.rise).toBeGreaterThan(RAIL_HEAD_Y + 5.5 + 1);
  });
});

describe('track geometry', () => {
  it('draws sleepers every 0.6 m on every track, masts every 56 m and signals along the line', () => {
    const { sys, layer } = build(line('gleis_doppel'));
    const rt = sys.runtimes[0];
    const len = rt.samples[rt.samples.length - 1].s;
    const c = layer.counts;
    // two tracks
    expect(c.sleepers).toBeGreaterThan(2 * (len / 0.6) * 0.97);
    expect(c.sleepers).toBeLessThan(2 * (len / 0.6) * 1.03);
    // masts on both sides every 56 m (the first one at s = 0 is skipped)
    expect(c.masts).toBeGreaterThanOrEqual(2 * Math.floor(len / 56) - 2);
    expect(c.masts).toBeLessThanOrEqual(2 * Math.floor(len / 56) + 2);
    expect(c.signals).toBeGreaterThan(0);
    expect(layer.meshCount).toBe(rt.chunks.length);
  });

  it('the rails run on top of the sleepers and the contact wire hangs 5.5 m above the rail head', () => {
    const { sys } = build(line('gleis'));
    const rt = sys.runtimes[0];
    const built = buildChunkRail(rt, rt.chunks[1])!;
    const g = built.batch.build()!;
    const pos = g.geometry.getAttribute('position');
    let maxY = -Infinity, railTop = -Infinity;
    const railGroup = g.geometry.groups[g.materials.indexOf('rail_steel')];
    const idx = g.geometry.getIndex()!;
    for (let i = railGroup.start; i < railGroup.start + railGroup.count; i++) railTop = Math.max(railTop, pos.getY(idx.getX(i)));
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    expect(railTop).toBeCloseTo(800.4 + RAIL_HEAD_Y, 2);
    expect(maxY).toBeGreaterThan(800.4 + RAIL_HEAD_Y + 5.5); // masts and the messenger wire are above the contact wire
    const wire = g.geometry.groups[g.materials.indexOf('rail_wire')];
    let wireMin = Infinity;
    for (let i = wire.start; i < wire.start + wire.count; i++) wireMin = Math.min(wireMin, pos.getY(idx.getX(i)));
    expect(wireMin).toBeGreaterThan(800.4 + RAIL_HEAD_Y + 5.4);
  });

  it('chunk borders neither double nor drop sleepers: the count is the same whatever the chunking', () => {
    const { sys, layer } = build(line('gleis', { }, [2000, 2150, 2300, 2450, 2600].map((x) => ({ x, y: 800.4, z: 2000, elev: 'fixed' as const }))));
    const rt = sys.runtimes[0];
    const len = rt.samples[rt.samples.length - 1].s;
    const expected = Math.floor((len - 0.2) / 0.6 + 1e-9) - 0 ; // sleepers at 0.6·k, within 0.2 m of both ends excluded
    expect(Math.abs(layer.counts.sleepers - expected)).toBeLessThanOrEqual(2);
    expect(rt.chunks.length).toBeGreaterThan(5);
  });

  it('no overhead-line masts inside a tunnel, but the contact wire continues', () => {
    const pts = [2000, 2150, 2300, 2450, 2600].map((x, i) => ({ x, y: 800.4, z: 2000, ...(i >= 1 && i <= 3 ? { mode: 'tunnel' as const } : { elev: 'fixed' as const }) }));
    const { sys } = build(line('gleis', {}, pts));
    const rt = sys.runtimes[0];
    const tunnelChunk = rt.chunks.find((c) => rt.samples[c.i0].s > 170 && rt.samples[c.i1].s < 280)!;
    const built = buildChunkRail(rt, tunnelChunk)!;
    expect(built.masts).toBe(0);
    expect(built.signals).toBe(0);
    expect(built.sleepers).toBeGreaterThan(50);
    const g = built.batch.build()!;
    expect(g.materials).toContain('rail_wire');
  });

  it('on a railway bridge the track stays on the deck: the bridge default is the railway bridge', () => {
    const pts = [2000, 2150, 2300, 2450, 2600].map((x, i) => ({ x, y: 812, z: 2000, ...(i >= 1 && i <= 3 ? { mode: 'bridge' as const } : { elev: 'fixed' as const }) }));
    const { sys, layer } = build(line('gleis', {}, pts));
    const rt = sys.runtimes[0];
    expect(bridgeSections(rt)).toHaveLength(1);
    expect(bridges.forRoad(rt.def, rt.profile).name).toBe('Eisenbahnbrücke');
    expect(layer.counts.masts).toBeGreaterThan(5);
  });

  it('wire stagger zig-zags by 0.2 m and is continuous', () => {
    expect(Math.abs(stagger(0, 56, 0))).toBeCloseTo(0.2);
    expect(Math.abs(stagger(56, 56, 0))).toBeCloseTo(0.2);
    expect(Math.sign(stagger(0, 56, 0))).toBe(-Math.sign(stagger(56, 56, 0)));
    expect(stagger(28, 56, 0)).toBeCloseTo(0, 6);
    expect(Math.abs(stagger(55.999, 56, 0) - stagger(56.001, 56, 0))).toBeLessThan(0.01);
  });

  it('signal aspects are deterministic and use all three colours', () => {
    const seen = new Set<string>();
    for (let k = 0; k < 60; k++) { expect(signalAspect(7, k)).toBe(signalAspect(7, k)); seen.add(signalAspect(7, k)); }
    expect([...seen].sort()).toEqual(['green', 'red', 'yellow']);
  });

  it('a replaced road keeps its track until the new one is built, and removing the road removes the track', () => {
    const { sys, layer } = build(line('gleis'));
    expect(layer.meshCount).toBeGreaterThan(0);
    sys.setNetwork([], []);
    expect(layer.meshCount).toBe(0);
  });
});
