import { describe, it, expect } from 'vitest';
import { RoadModel } from '../src/editor/model';
import { detachRoad, isHeadIndex, setAttach, splitRoad } from '../src/editor/ops';
import { resolveAttachments } from '../src/network/attach';
import { sanitizeRoadsDocument, cloneRoad } from '../src/network/doc';
import { defaultAttach } from '../src/network/branchDefaults';
import { sampleRoad } from '../src/core/sampling';
import { ProfileLibrary } from '../src/profile/library';
import { TEMPLATES, defaultTemplateParams } from '../src/editor/templates';
import type { AttachDef, RoadDef } from '../src/network/types';

const lib = new ProfileLibrary();
const MAIN: RoadDef = { id: 'm', name: 'm', profile: 'autobahn', points: [0, 300, 600, 900, 1200].map((x) => ({ x, y: 500, z: 1000, elev: 'fixed' as const })) };
const attach = (over: Partial<AttachDef> = {}): AttachDef => ({ road: 'm', at: { x: 400, z: 1000 }, side: 1, dir: 1, halfMain: 11, halfBranch: 3, grow: 40, parallel: 60, taper: 80, gap: 2, head: 0, ...over });
const ramp = (a: AttachDef = attach()): RoadDef => ({ id: 'r', name: 'r', profile: 'auffahrt', attach: a, points: [{ x: 800, y: 500, z: 1060 }, { x: 900, y: 500, z: 1200 }] });

describe('attached roads in the model', () => {
  it('adding a road with an attachment computes its head, and the road keeps its authored tail', () => {
    const m = new RoadModel();
    m.load({ version: 1, roads: [MAIN] });
    m.addRoad(ramp());
    const r = m.get('r')!;
    expect(r.attach!.head).toBeGreaterThan(10);
    expect(r.points.length).toBe(r.attach!.head + 2);
    expect(r.points[r.attach!.head]).toEqual({ x: 800, y: 500, z: 1060, });
    expect(r.attach!.s).toBeCloseTo(400, 0);
    expect(r.attach!.len).toBe(180);
    expect(isHeadIndex(r, 0)).toBe(true);
    expect(isHeadIndex(r, r.attach!.head)).toBe(false);
  });

  it('moving the parent moves the branch; editing the tail leaves the head alone; undo restores both', () => {
    const m = new RoadModel();
    m.load({ version: 1, roads: [MAIN] });
    m.addRoad(ramp());
    const before = m.get('r')!;
    m.edit('m', 'move', (d) => { d.points = d.points.map((p) => ({ ...p, z: p.z + 30 })); });
    const after = m.get('r')!;
    expect(after.points[0].z - before.points[0].z).toBeCloseTo(30, 3);
    // the tail did not move
    expect(after.points[after.attach!.head]).toEqual(before.points[before.attach!.head]);
    m.undo();
    expect(m.get('r')!.points[0].z).toBeCloseTo(before.points[0].z, 6);
  });

  it('changing the lane length changes the head length (and the point count) but not the tail', () => {
    const m = new RoadModel();
    m.load({ version: 1, roads: [MAIN] });
    m.addRoad(ramp());
    const n0 = m.get('r')!.attach!.head;
    m.transact('lane', (d) => setAttach(d, 'r', 'attach', { parallel: 200 }));
    const r = m.get('r')!;
    expect(r.attach!.head).toBeGreaterThan(n0);
    expect(r.attach!.len).toBe(320);
    expect(r.points.slice(r.attach!.head)).toEqual([{ x: 800, y: 500, z: 1060 }, { x: 900, y: 500, z: 1200 }]);
  });

  it('detaching keeps the points as ordinary points', () => {
    const m = new RoadModel();
    m.load({ version: 1, roads: [MAIN] });
    m.addRoad(ramp());
    const pts = m.get('r')!.points;
    m.transact('detach', (d) => detachRoad(d, 'r', 'attach'));
    expect(m.get('r')!.attach).toBeUndefined();
    expect(m.get('r')!.points).toEqual(pts);
    m.edit('m', 'move', (d) => { d.points = d.points.map((p) => ({ ...p, z: p.z + 50 })); });
    expect(m.get('r')!.points).toEqual(pts); // no longer follows
  });

  it('survives a save/load round trip through the document sanitizer', () => {
    const m = new RoadModel();
    m.load({ version: 1, roads: [MAIN] });
    m.addRoad(ramp(attach({ kind: 'switch', state: 'diverging', dy: -0.02 })));
    const doc = JSON.parse(JSON.stringify(m.toDocument()));
    const clean = sanitizeRoadsDocument(doc);
    const r = clean.roads.find((x) => x.id === 'r')!;
    expect(r.attach).toMatchObject({ road: 'm', side: 1, dir: 1, kind: 'switch', state: 'diverging', dy: -0.02, grow: 40, parallel: 60, taper: 80 });
    expect(r.points.length).toBe(m.get('r')!.points.length);
    expect(cloneRoad(r).attach).toEqual(r.attach);
    // garbage is dropped, not thrown on
    const bad = sanitizeRoadsDocument({ roads: [{ ...cloneRoad(r), attach: { road: 5 } }] });
    expect(bad.roads[0].attach).toBeUndefined();
  });

  it('splitting a parent re-points a branch whose nose lies on the second half; splitting the branch keeps a whole head only', () => {
    const m = new RoadModel();
    m.load({ version: 1, roads: [MAIN] });
    m.addRoad(ramp(attach({ at: { x: 1000, z: 1000 } })));
    const sampled = sampleRoad(m.get('m')!);
    m.transact('split', (d) => { splitRoad(d, 'm', sampled, 600); });
    const r = m.get('r')!;
    expect(r.attach!.road).not.toBe('m');
    expect(m.get(r.attach!.road)).toBeDefined();
    expect(r.attach!.s).toBeCloseTo(400, 0);
    // splitting the branch itself in the middle of its head detaches it; after its head it stays attached
    const m2 = new RoadModel();
    m2.load({ version: 1, roads: [MAIN] });
    m2.addRoad(ramp());
    const s2 = sampleRoad(m2.get('r')!);
    m2.transact('split-tail', (d) => { splitRoad(d, 'r', s2, s2.curve.length - 20); });
    expect(m2.get('r')!.attach).toBeDefined();
    const m3 = new RoadModel();
    m3.load({ version: 1, roads: [MAIN] });
    m3.addRoad(ramp());
    m3.transact('split-head', (d) => { splitRoad(d, 'r', sampleRoad(m3.get('r')!), 50); });
    expect(m3.get('r')!.attach).toBeUndefined();
  });

  it('an orphan (parent deleted) keeps its points; a cycle does not hang', () => {
    const r = ramp();
    expect(resolveAttachments([r])[0]).toBe(r);
    const a: RoadDef = { ...ramp(attach({ road: 'b' })), id: 'a' };
    const b: RoadDef = { ...ramp(attach({ road: 'a' })), id: 'b' };
    expect(resolveAttachments([a, b])).toHaveLength(2);
  });

  it('a road that both leaves one road and joins another is resolved at both ends', () => {
    const second: RoadDef = { id: 'm2', name: 'm2', profile: 'autobahn', points: [0, 300, 600, 900, 1200].map((x) => ({ x, y: 500, z: 1400, elev: 'fixed' as const })) };
    const link: RoadDef = {
      id: 'link', name: 'link', profile: 'auffahrt', attach: attach(), attachEnd: attach({ road: 'm2', at: { x: 900, z: 1400 }, side: -1, dir: -1 }),
      points: [{ x: 700, y: 500, z: 1100 }, { x: 800, y: 500, z: 1300 }],
    };
    const [, , out] = resolveAttachments([MAIN, second, link]);
    expect(out.attach!.head).toBeGreaterThan(5);
    expect(out.attachEnd!.head).toBeGreaterThan(5);
    expect(out.points.length).toBe(out.attach!.head + 2 + out.attachEnd!.head);
    const last = out.points[out.points.length - 1];
    expect(Math.abs(last.z - 1400)).toBeLessThan(11 + 0.1 * 3 + 1);
  });
});

describe('default attachment parameters', () => {
  it('a motorway exit gets a deceleration lane, a village street a short taper, a railway a switch', () => {
    const auto = lib.resolve('autobahn'), ramps = lib.resolve('auffahrt');
    const exit = defaultAttach({ parent: { id: 'm' }, parentProfile: auto, childProfile: ramps, at: { x: 1, z: 2 }, side: 1, kind: 'exit' });
    expect(exit.parallel).toBeGreaterThan(50);
    expect(exit.halfMain).toBeCloseTo(auto.carriageHalfWidth, 6);
    expect(exit.kind).toBe('ramp');
    const village = defaultAttach({ parent: { id: 'm' }, parentProfile: lib.resolve('dorfstrasse'), childProfile: lib.resolve('quartierstrasse'), at: { x: 1, z: 2 }, side: -1, kind: 'exit' });
    expect(village.parallel).toBe(0);
    const track = defaultAttach({ parent: { id: 'm' }, parentProfile: lib.resolve('gleis_doppel'), childProfile: lib.resolve('gleis'), at: { x: 1, z: 2 }, side: 1, kind: 'exit' });
    expect(track).toMatchObject({ kind: 'switch', halfMain: 2.25, halfBranch: 0, taperStart: 0, state: 'straight' });
    const left = defaultAttach({ parent: { id: 'm' }, parentProfile: lib.resolve('gleis_doppel'), childProfile: lib.resolve('gleis'), at: { x: 1, z: 2 }, side: -1, kind: 'exit' });
    expect(left.halfMain).toBe(2.25);
    expect(defaultAttach({ parent: { id: 'm' }, parentProfile: lib.resolve('gleis'), childProfile: lib.resolve('gleis'), at: { x: 1, z: 2 }, side: 1, kind: 'exit' }).halfMain).toBe(0);
  });
});

describe('templates', () => {
  const ctx = (kind: keyof typeof TEMPLATES) => ({ x: 3000, z: 3000, ground: () => 800, uid: 't1', params: defaultTemplateParams(kind), library: lib });
  it('every template builds roads with unique ids that sanitize cleanly and resolve', () => {
    for (const kind of Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>) {
      const t = TEMPLATES[kind].build(ctx(kind));
      expect(t.roads.length, kind).toBeGreaterThan(1);
      expect(new Set(t.roads.map((r) => r.id)).size, kind).toBe(t.roads.length);
      const doc = sanitizeRoadsDocument({ roads: t.roads, nodes: t.nodes });
      expect(doc.roads.length, kind).toBe(t.roads.length);
      for (const r of resolveAttachments(doc.roads)) for (const p of r.points) expect(Number.isFinite(p.x + p.y + p.z), kind).toBe(true);
    }
  });

  it('the station template ends in a switch that leaves the east line', () => {
    const t = TEMPLATES.station.build(ctx('station'));
    const siding = t.roads.find((r) => r.attach)!;
    expect(siding.attach!.kind).toBe('switch');
    expect(siding.attach!.road).toBe('t1-ost');
    expect(t.roads.some((r) => r.profile === 'bahnhof')).toBe(true);
  });

  it('the roundabout template follows the arm count', () => {
    const p = { ...defaultTemplateParams('roundabout'), arms: 5 };
    const t = TEMPLATES.roundabout.build({ ...ctx('roundabout'), params: p });
    expect(t.nodes).toHaveLength(5);
  });
});
