import { describe, it, expect, vi } from 'vitest';

vi.setConfig({ testTimeout: 120000 });
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { RailLayer } from '../src/rail/railLayer';
import { RailNetwork } from '../src/rail/network';
import { TrainLayer } from '../src/rail/train';
import { CrossingLayer, findCrossings } from '../src/rail/crossing';
import { BLADE_OPEN_M, buildChunkRail, type RailContext, type SwitchState } from '../src/rail/geometry';
import { PropMaterials } from '../src/props/materials';
import type { AttachDef, RoadDef } from '../src/network/types';

const profiles = new ProfileLibrary();
const resolve = (d: RoadDef) => profiles.resolve(d.profile, d.params);

function flat(): MockStreamTerrain {
  const t = new MockStreamTerrain();
  t.setModifier('flat', () => 800);
  t.loadRectSync(1000, 1000, 5000, 5000, 0);
  return t;
}

const pt = (x: number, z: number, y = 800.45): { x: number; y: number; z: number; elev: 'fixed' } => ({ x, y, z, elev: 'fixed' });
const line = (id: string, profile: string, x0: number, x1: number, z = 2000, step = 100): RoadDef => ({
  id, name: id, profile, points: Array.from({ length: Math.round((x1 - x0) / step) + 1 }, (_, i) => pt(x0 + i * step, z)),
});

const SWITCH: AttachDef = { road: 'b', at: { x: 2800, z: 2000 }, side: 1, dir: 1, kind: 'switch', halfMain: 2.25, halfBranch: 0, grow: 60, parallel: 0, taper: 60, taperStart: 0, gap: 4.5, dy: -0.02, state: 'straight', head: 0 };

/** two double tracks joined end to end (a: 2000–2600, b: 2600–3400) and a siding that leaves b over a switch at x = 2800 */
function network(extra: RoadDef[] = [], stateDefault: SwitchState = 'straight'): RoadDef[] {
  const siding: RoadDef = { id: 'c', name: 'c', profile: 'gleis', attach: { ...SWITCH, state: stateDefault }, points: [pt(3000, 1993.25), pt(3100, 1993.25)] };
  return [line('a', 'gleis_doppel', 2000, 2600), line('b', 'gleis_doppel', 2600, 3400), siding, ...extra];
}

function settle(sys: RoadSystem): void {
  let guard = 0;
  while (sys.stats().ready < sys.stats().chunks && guard++ < 300) sys.resync({ checks: 999, builds: 99 });
}

function build(defs: RoadDef[]): { sys: RoadSystem; rail: RailLayer; net: RailNetwork } {
  const sys = new RoadSystem(flat(), resolve);
  const rail = new RailLayer(sys, new PropMaterials());
  sys.setNetwork(defs, []);
  settle(sys);
  return { sys, rail, net: new RailNetwork(sys, (id) => rail.switchState(id)) };
}

describe('railway graph', () => {
  it('moves along a road and over the join onto the next road; a dead end stops it', () => {
    const { net } = build(network());
    let r = net.advance({ roadId: 'a', s: 500, dir: 1 }, 150);
    expect(r.cursor.roadId).toBe('b');
    expect(r.cursor.dir).toBe(1);
    expect(r.cursor.s).toBeCloseTo(50, 0);
    expect(r.segs.map((s) => s.roadId)).toEqual(['a', 'b']);
    // against the arc length, from b back onto a
    r = net.advance({ roadId: 'b', s: 30, dir: -1 }, 60);
    expect(r.cursor.roadId).toBe('a');
    expect(r.cursor.dir).toBe(-1);
    expect(r.cursor.s).toBeCloseTo(net.length('a') - 30, 0);
    // the start of a is a dead end
    const end = net.advance({ roadId: 'a', s: 20, dir: -1 }, 100);
    expect(end.hitEnd).toBe(true);
    expect(end.cursor.s).toBeCloseTo(0, 6);
    expect(net.pose('a', 100, 1)!.pos.y).toBeCloseTo(800.45 + 0.34, 1); // rail head height
  });

  it('a switch set diverging takes a train that runs facing it onto the branch; set straight it stays on the line', () => {
    const straight = build(network());
    const noseS = straight.sys.runtimes.find((r) => r.def.id === 'c')!.def.attach!.s!;
    expect(noseS).toBeCloseTo(200, 0); // x = 2800 on b, which starts at 2600
    const a = straight.net.advance({ roadId: 'b', s: 150, dir: 1 }, 100);
    expect(a.cursor.roadId).toBe('b');
    const div = build(network([], 'diverging'));
    const b = div.net.advance({ roadId: 'b', s: 150, dir: 1 }, 100);
    expect(b.cursor.roadId).toBe('c');
    expect(b.cursor.s).toBeCloseTo(50, 0);
    expect(b.cursor.dir).toBe(1);
    // the other direction on the double track uses the other track and never takes the branch
    const c = div.net.advance({ roadId: 'b', s: 250, dir: -1 }, 100);
    expect(c.cursor.roadId).toBe('b');
  });

  it('a train coming back down the branch joins the line at the nose and runs on against the old direction', () => {
    const { net } = build(network([], 'diverging'));
    const r = net.advance({ roadId: 'c', s: 30, dir: -1 }, 80);
    expect(r.cursor.roadId).toBe('b');
    expect(r.cursor.dir).toBe(-1);
    expect(r.cursor.s).toBeCloseTo(200 - 50, 0);
  });

  it('the switch position can be changed at run time without touching the document', () => {
    const { sys, rail, net } = build(network());
    const id = rail.switches()[0].id;
    expect(id).toBe('c:attach');
    expect(rail.switchState(id)).toBe('straight');
    expect(net.advance({ roadId: 'b', s: 150, dir: 1 }, 100).cursor.roadId).toBe('b');
    rail.setSwitch(id, 'diverging');
    expect(net.advance({ roadId: 'b', s: 150, dir: 1 }, 100).cursor.roadId).toBe('c');
    expect(sys.runtimes.find((r) => r.def.id === 'c')!.def.attach!.state).toBe('straight'); // the saved position is not changed
  });
});

describe('switch geometry', () => {
  const ctx = (state: SwitchState): RailContext => ({ switchState: () => state });
  const lateralOf = (batch: ReturnType<typeof buildChunkRail>): { has: (m: string) => boolean } => {
    const g = batch!.batch.build()!;
    return { has: (m: string) => g.materials.includes(m) };
  };

  it('the lantern shows the position, the long switch sleepers reach under both tracks, and the branch leaves out its own sleepers in the zone', () => {
    const { sys } = build(network());
    const b = sys.runtimes.find((r) => r.def.id === 'b')!, c = sys.runtimes.find((r) => r.def.id === 'c')!;
    const chunkB = b.chunks.find((ch) => b.samples[ch.i0].s <= 200 && b.samples[ch.i1].s > 200)!;
    expect(lateralOf(buildChunkRail(b, chunkB, ctx('straight'))).has('rail_lamp_green')).toBe(true);
    expect(lateralOf(buildChunkRail(b, chunkB, ctx('diverging'))).has('rail_lamp_yellow')).toBe(true);
    // widest sleeper of the parent in the zone: reaches from the main track's outer sleeper end to the branch track's
    const widest = (rt: typeof b, ch: typeof chunkB): number => {
      const g = buildChunkRail(rt, ch, ctx('straight'))!.batch.build()!;
      const pos = g.geometry.getAttribute('position');
      const grp = g.geometry.groups[g.materials.indexOf('sleeper')];
      const idx = g.geometry.getIndex()!;
      let lo = Infinity, hi = -Infinity;
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        const z = pos.getZ(idx.getX(i));
        // the sleepers lie across the road: along z (a is east–west at z = 2000 in sim → −2000 in three)
        lo = Math.min(lo, z); hi = Math.max(hi, z);
      }
      return hi - lo;
    };
    const chunks = b.chunks.filter((ch) => b.samples[ch.i1].s > 200 && b.samples[ch.i0].s < 262);
    expect(chunks.length).toBeGreaterThan(0);
    const w = Math.max(...chunks.map((ch) => widest(b, ch)));
    expect(w).toBeGreaterThan(4.5 + 2.6 - 0.5); // 2.6 m sleepers on two tracks that are 4.5 m apart
    // the child draws no sleepers inside the zone: its first sleepers start after the head
    const first = c.chunks[0];
    const built = buildChunkRail(c, first, ctx('straight'))!;
    const expectedMax = Math.ceil((first.i1 - first.i0 + 1 > 0 ? c.samples[first.i1].s : 0) / 0.6);
    expect(built.sleepers).toBeLessThan(expectedMax);
  });

  it('the open blade stands off its stock rail; the closed one touches', () => {
    const { sys } = build(network());
    const c = sys.runtimes.find((r) => r.def.id === 'c')!;
    const ch = c.chunks[0];
    const spread = (state: SwitchState): number => {
      const g = buildChunkRail(c, ch, ctx(state))!.batch.build()!;
      const grp = g.geometry.groups[g.materials.indexOf('rail_steel')];
      const pos = g.geometry.getAttribute('position');
      const idx = g.geometry.getIndex()!;
      // rail vertices within the first 3 m of the head: the lateral extent of the rails there
      const zs: number[] = [];
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        const k = idx.getX(i);
        if (Math.abs(pos.getX(k) - 2800) < 2.5) zs.push(pos.getZ(k));
      }
      return zs.length ? Math.max(...zs) - Math.min(...zs) : 0;
    };
    // set straight, the curved blade of the branch stands off its stock rail (towards the branch's own axis: the rails' extent shrinks); set
    // diverging it lies against it
    expect(spread('diverging') - spread('straight')).toBeGreaterThan(BLADE_OPEN_M * 0.5);
  });
});

describe('trains', () => {
  it('a train runs, its cars follow the path, it stops at the platform of a station and goes on; at the end of the line it turns round', () => {
    const defs = [line('w', 'gleis_doppel', 2000, 2500), line('bhf', 'bahnhof', 2500, 2800, 2000, 100), line('e', 'gleis_doppel', 2800, 3300)];
    const { sys, rail } = build(defs);
    const trains = new TrainLayer(sys, rail);
    const t = trains.add({ id: 'T', start: { roadId: 'w', s: 150, dir: 1 }, coaches: 2 });
    expect(t.length).toBeGreaterThan(70);
    // the cars stand along the path behind the front: first car's front bogie is near the front
    const loc0 = t.locate(3.3);
    expect(loc0.roadId).toBe('w');
    expect(loc0.s).toBeCloseTo(150 - 3.3, 1);
    let stoppedAt: number | null = null;
    let leftAfterStop = false;
    for (let i = 0; i < 2400 && !leftAfterStop; i++) {
      trains.update(0.1);
      if (t.front.roadId === 'bhf' && t.wait > 10 && stoppedAt === null) stoppedAt = t.front.s;
      if (stoppedAt !== null && t.wait <= 0 && t.speed > 3) leftAfterStop = true;
    }
    expect(stoppedAt).not.toBeNull();
    // the middle of the train stands at the middle of the platform
    expect(stoppedAt! - t.length / 2).toBeCloseTo(150, -1); // the platform road is 300 m long: its middle is at 150
    expect(leftAfterStop).toBe(true);
    // on to the dead end at the far side of e, turning round there
    let turned = false;
    for (let i = 0; i < 6000 && !turned; i++) { trains.update(0.1); if (t.front.dir === -1 && t.front.roadId === 'e') turned = true; }
    expect(turned).toBe(true);
  });

  it('a red signal stops a train in front of it; green lets it through', () => {
    const { sys, rail } = build([line('w', 'gleis', 2000, 3400)]);
    const sigs = rail.signals().filter((s) => s.def.dir === 1);
    expect(sigs.length).toBeGreaterThan(1);
    const trains = new TrainLayer(sys, rail);
    const t = trains.add({ id: 'T', start: { roadId: 'w', s: 40, dir: 1 }, coaches: 1, stops: false });
    // everything red: the train brakes and stands before the first signal ahead
    const first = sigs.filter((s) => s.def.s > 40).sort((a, b) => a.def.s - b.def.s)[0];
    const force = (aspect: 'red' | 'green'): void => { for (const s of rail.signals()) rail.setSignalAspect(s.def.id, aspect); };
    for (let i = 0; i < 3000; i++) { force('red'); (trains as unknown as { signalClock: number }).signalClock = -1e9; trains.update(0.1); }
    expect(t.speed).toBe(0);
    expect(t.front.s).toBeLessThan(first.def.s);
    expect(first.def.s - t.front.s).toBeGreaterThan(8);
    expect(first.def.s - t.front.s).toBeLessThan(40);
    // green: it goes through
    for (let i = 0; i < 1200; i++) { force('green'); (trains as unknown as { signalClock: number }).signalClock = -1e9; trains.update(0.1); }
    expect(t.front.s).toBeGreaterThan(first.def.s + 50);
  });

  it('block signalling: the signal behind a standing train shows red, further back yellow, and green once the line is clear', () => {
    const { sys, rail } = build([line('w', 'gleis', 2000, 3900, 2000, 100)]);
    const trains = new TrainLayer(sys, rail);
    const sigs = rail.signals().filter((s) => s.def.dir === 1).sort((a, b) => a.def.s - b.def.s);
    expect(sigs.length).toBeGreaterThan(3);
    const stand = sigs[2].def.s + 120; // a train stands 120 m beyond the third signal
    const t = trains.add({ id: 'S', start: { roadId: 'w', s: stand, dir: 1 }, coaches: 1, stops: false });
    t.wait = 1e9; // stays put
    for (let i = 0; i < 10; i++) trains.update(0.1);
    const aspect = (i: number): string => rail.signals().find((s) => s.def.id === sigs[i].def.id)!.aspect;
    expect(aspect(2)).toBe('red');
    expect(aspect(0)).not.toBe('red'); // far behind: caution at most, depending on the distance
    expect(['yellow', 'green']).toContain(aspect(0));
    trains.remove('S');
    for (let i = 0; i < 10; i++) trains.update(0.1);
    for (let i = 0; i < 3; i++) expect(aspect(i)).toBe('green');
  });

  it('trains keep their distance on a single track', () => {
    const { sys, rail } = build([line('w', 'gleis', 2000, 3900, 2000, 100)]);
    const trains = new TrainLayer(sys, rail);
    const a = trains.add({ id: 'A', start: { roadId: 'w', s: 600, dir: 1 }, coaches: 1, stops: false });
    a.wait = 1e9;
    const b = trains.add({ id: 'B', start: { roadId: 'w', s: 100, dir: 1 }, coaches: 1, stops: false });
    for (let i = 0; i < 4000; i++) { for (const s of rail.signals()) rail.setSignalAspect(s.def.id, 'green'); trains.update(0.1); }
    expect(b.speed).toBe(0);
    const gap = (a.front.s - a.length) - b.front.s;
    expect(gap).toBeGreaterThan(20);
    expect(gap).toBeLessThan(80);
  });
});

describe('level crossings', () => {
  const road = (y: number, mode?: 'bridge'): RoadDef => ({
    id: 'q', name: 'q', profile: 'gemeindestrasse',
    points: [{ x: 2500, y: 800, z: 1800 }, { x: 2500, y: y, z: 1900, ...(mode ? { mode } : { elev: 'fixed' as const }) }, { x: 2500, y: y, z: 2100, ...(mode ? { mode } : { elev: 'fixed' as const }) }, { x: 2500, y: 800, z: 2200 }],
  });

  it('finds a road that crosses the line at grade, but not one that passes above or below', () => {
    const at = build([line('w', 'gleis_doppel', 2000, 3000), road(800.75)]);
    expect(findCrossings(at.sys)).toHaveLength(1);
    const over = build([line('w', 'gleis_doppel', 2000, 3000), road(815, 'bridge')]);
    expect(findCrossings(over.sys)).toHaveLength(0);
  });

  it('lights start when a train is coming, the barriers close and open again after it has gone', () => {
    const { sys, rail } = build([line('w', 'gleis_doppel', 2000, 3000), road(800.75)]);
    const trains = new TrainLayer(sys, rail);
    const cross = new CrossingLayer(sys, trains);
    for (let i = 0; i < 20; i++) cross.update(0.1); // finds the crossing
    expect(cross.crossings).toHaveLength(1);
    const id = cross.crossings[0].id;
    expect(cross.isClosed(id)).toBe(false);
    const t = trains.add({ id: 'T', start: { roadId: 'w', s: 150, dir: 1 }, coaches: 1, stops: false });
    let closed = false, reopened = false;
    for (let i = 0; i < 2400; i++) {
      for (const s of rail.signals()) rail.setSignalAspect(s.def.id, 'green');
      trains.update(0.1);
      cross.update(0.1);
      if (cross.isClosed(id)) closed = true;
      if (closed && !cross.isClosed(id) && t.front.s > 560) { reopened = true; break; }
    }
    expect(closed).toBe(true);
    expect(reopened).toBe(true);
  });
});

describe('plausibility checks', () => {
  it('warns about a tight curve and a steep grade, and stays quiet on a good line', async () => {
    const { railWarnings } = await import('../src/rail/validate');
    const good = build([line('w', 'gleis_doppel', 2000, 3000)]);
    expect(railWarnings(good.sys.runtimes[0])).toEqual([]);
    // a 90° bend with a radius of about 40 m
    const bend: RoadDef = { id: 'k', name: 'k', profile: 'gleis_doppel', points: [pt(2000, 2000), pt(2150, 2000), pt(2190, 2010), pt(2200, 2050), pt(2200, 2200)] };
    const tight = build([bend]);
    const w = railWarnings(tight.sys.runtimes[0]);
    expect(w.some((x) => x.kind === 'radius')).toBe(true);
    // 8 % grade over 500 m
    const steep: RoadDef = { id: 'g', name: 'g', profile: 'gleis_doppel', points: [0, 1, 2, 3, 4, 5].map((i) => pt(2000 + i * 100, 2000, 800.45 + i * 8)) };
    const hill = build([steep]);
    expect(railWarnings(hill.sys.runtimes[0]).some((x) => x.kind === 'grade')).toBe(true);
    expect(railWarnings(build([{ ...line('r', 'hauptstrasse', 2000, 2400) }]).sys.runtimes[0])).toEqual([]); // not a railway
  });
});
