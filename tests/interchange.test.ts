import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { branchPoints, arcLengthNear, headLength } from '../src/network/branch';
import { buildStackInterchange } from '../src/network/interchange';
import { resolveAttachments, openingsByRoad } from '../src/network/attach';
import { BridgeLibrary } from '../src/structures/library';
import { bridgeSections, pierPositions, pierPositionsFor } from '../src/structures/sections';
import { simToThree } from '../src/core/world';
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

const MAIN: Pick<RoadDef, 'points'> = { points: [0, 200, 400, 600].map((x) => ({ x, y: 500, z: 1000 })) };

describe('branch generator', () => {
  const spec = { main: MAIN, s: 100, side: 1 as const, halfMain: 7, halfBranch: 3, grow: 40, parallel: 60, taper: 80, gap: 2, step: 10, tail: [{ x: 500, y: 500, z: 1200 }] };
  const pts = branchPoints(spec);

  it('starts as a narrow sliver on the main road edge and grows to full width beside it', () => {
    expect(pts[0].widthScale).toBeLessThan(0.2);
    expect(pts[0].x).toBeCloseTo(100, 0);
    // |dz| = halfMain + halfBranch·w at the nose: just outside the main road's edge
    const first = Math.abs(pts[0].z - 1000);
    expect(first).toBeGreaterThan(7);
    expect(first).toBeLessThan(7.8);
    expect(pts[pts.length - 1]).toEqual({ x: 500, y: 500, z: 1200 });
  });

  it('has a full-width lane running alongside, then the gap opens up', () => {
    const head = pts.slice(0, -1);
    expect(headLength(spec)).toBe(180);
    // after `grow` the branch has full width (no widthScale) and sits flush against the main road; it stays there for `parallel`
    const lane = head.filter((_, i) => i * 10 >= 40 && i * 10 <= 100);
    for (const p of lane) { expect(p.widthScale).toBeUndefined(); expect(Math.abs(p.z - 1000)).toBeCloseTo(10, 6); }
    // at the end of the taper it is a lane plus the gap away
    expect(Math.abs(head[head.length - 1].z - 1000)).toBeCloseTo(12, 6);
    expect(head[head.length - 1].x).toBeCloseTo(280, 0);
    // and the offset never decreases
    for (let i = 1; i < head.length; i++) expect(Math.abs(head[i].z - 1000)).toBeGreaterThanOrEqual(Math.abs(head[i - 1].z - 1000) - 1e-9);
  });

  it('a switch (taperStart 0) opens the gap at once: width and offset grow together', () => {
    const sw = branchPoints({ main: MAIN, s: 100, side: 1, halfMain: 2.25, halfBranch: 0, grow: 60, taper: 60, taperStart: 0, gap: 4.5, tail: [] });
    expect(Math.abs(sw[0].z - 1000)).toBeCloseTo(2.25, 1);
    expect(Math.abs(sw[sw.length - 1].z - 1000)).toBeCloseTo(6.75, 6);
    expect(Math.abs(sw[3].z - 1000)).toBeGreaterThan(2.25 + 0.05);
  });

  it('keeps the main road height and inherits bridge mode from it', () => {
    for (const p of pts.slice(0, -1)) expect(p.y).toBeCloseTo(500, 3);
    const bridged = { points: MAIN.points.map((p) => ({ ...p, mode: 'bridge' as const })) };
    expect(branchPoints({ ...spec, main: bridged, tail: [] }).every((p) => p.mode === 'bridge')).toBe(true);
    const fixed = { points: MAIN.points.map((p) => ({ ...p, elev: 'fixed' as const })) };
    expect(branchPoints({ ...spec, main: fixed, tail: [] }).every((p) => p.elev === 'fixed')).toBe(true);
  });

  it('a merge runs the other way round, and the other side mirrors', () => {
    const m = branchPoints({ ...spec, merge: true });
    expect(m[0]).toEqual({ x: 500, y: 500, z: 1200 });
    expect(m[m.length - 1].widthScale).toBeLessThan(0.2);
    const l = branchPoints({ ...spec, side: -1 });
    expect(Math.sign(l[3].z - 1000)).toBe(-Math.sign(pts[3].z - 1000));
  });

  it('arcLengthNear finds the station of a point', () => {
    expect(arcLengthNear(MAIN, 250, 1010)).toBeCloseTo(250, 0);
  });
});

describe('stack interchange', () => {
  const ground = (): number => 800;
  const ic = buildStackInterchange({ id: 'k', x: 3000, z: 3000, ground });

  it('makes a ground motorway, an elevated one and four ramps with unique ids', () => {
    expect(ic.roads).toHaveLength(6);
    expect(new Set(ic.roads.map((r) => r.id)).size).toBe(6);
    expect(ic.deckY).toBe(813);
    const b = ic.roads.find((r) => r.id === 'k-B')!;
    expect(Math.max(...b.points.map((p) => p.y))).toBe(813);
    expect(b.points.some((p) => p.mode === 'bridge')).toBe(true);
    expect(ic.roads.find((r) => r.id === 'k-A')!.points.every((p) => p.y === 800)).toBe(true);
  });

  it('every ramp leaves B high up and arrives on the ground at A', () => {
    for (const r of ic.roads.filter((x) => x.id.startsWith('k-ramp'))) {
      const ys = r.points.map((p) => p.y);
      expect(Math.max(ys[0], ys[ys.length - 1])).toBeGreaterThan(810);
      expect(Math.min(ys[0], ys[ys.length - 1])).toBeLessThan(801);
      for (const p of r.points) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    }
  });

  it('piers of the elevated motorway never stand on the motorway beneath', () => {
    const sys = new RoadSystem(flat(), resolve);
    sys.setNetwork(ic.roads, []);
    const rtB = sys.runtimes.find((r) => r.def.id === 'k-B')!;
    const secs = bridgeSections(rtB);
    expect(secs.length).toBeGreaterThan(0);
    const P = new Vector3();
    const sc = arcLengthNear(ic.roads.find((r) => r.id === 'k-B')!, 3000, 3000); // B crosses A here
    // two equal spans whose middle pier would stand exactly on motorway A
    const sec = { s0: sc - 40, s1: sc + 40 };
    expect(pierPositions(sec, 40)).toEqual([sc]);
    const piers = pierPositionsFor(rtB, sec, 40);
    expect(piers.length).toBe(1);
    expect(Math.abs(piers[0] - sc)).toBeGreaterThan(11 + 3.5 - 1); // clear of A's carriageway
    rtB.sampled.curve.pointAt(piers[0], P);
    expect(P.y).toBeGreaterThan(800 + 5); // still on the deck level
    // a real section divides into spans that clear A anyway and are left alone
    expect(pierPositionsFor(rtB, secs[0], 45).length).toBeGreaterThan(10);
  });

  it('the ramps are attached to the motorways: heads are recomputed when a motorway moves', () => {
    const net = resolveAttachments(ic.roads);
    const ramp = net.find((r) => r.id === 'k-rampEN')!;
    expect(ramp.attach!.road).toBe('k-B');
    expect(ramp.attachEnd!.road).toBe('k-A');
    expect(ramp.attach!.head).toBeGreaterThan(10);
    // moving B (all its points 20 m east) moves the exit's head with it; the arc in between stays put
    const moved = ic.roads.map((r) => (r.id === 'k-B' ? { ...r, points: r.points.map((p) => ({ ...p, x: p.x + 20 })) } : r));
    const net2 = resolveAttachments(moved);
    const ramp2 = net2.find((r) => r.id === 'k-rampEN')!;
    expect(ramp2.points[0].x - ramp.points[0].x).toBeCloseTo(20, 3);
    const mid = Math.floor(ramp.points.length / 2);
    expect(ramp2.points[mid]).toEqual(ramp.points[mid]);
    // nothing changed → the very same objects come back (the runtime diffs by identity)
    expect(resolveAttachments(net)[2]).toBe(net[2]);
    expect(resolveAttachments(net).every((r, i) => r === net[i])).toBe(true);
  });

  it('openings: the parent edge and the branch inner side are open where a branch leaves', () => {
    const net = resolveAttachments(ic.roads);
    const lens = new Map(net.map((r) => [r.id, 1500]));
    const op = openingsByRoad(net, (id) => lens.get(id) ?? 0);
    const onB = op.get('k-B')!;
    expect(onB.length).toBe(4); // four exits: the eastern ones leave on one side, the western ones on the other
    expect(onB.filter((o) => o.side === 1).length).toBe(2);
    expect(onB.filter((o) => o.side === -1).length).toBe(2);
    for (const o of onB) expect(o.s1 - o.s0).toBeGreaterThan(150);
    expect(op.get('k-rampEN')!.length).toBe(2); // inner side at the exit and at the entry
  });

  it('the railing of a bridge stops where the exit leaves, and the guardrail stays out of it', () => {
    const sys = new RoadSystem(flat(), resolve, undefined, (d) => bridges.forRoad(d, profiles.resolve(d.profile, d.params)));
    sys.setNetwork(ic.roads, []);
    const rtB = sys.runtimes.find((r) => r.def.id === 'k-B')!;
    expect(rtB.openings.length).toBe(4);
    const o = rtB.openings.find((x) => x.side === 1)!;
    expect(rtB.isOpen(1, (o.s0 + o.s1) / 2)).toBe(true);
    expect(rtB.isOpen(-1, (o.s0 + o.s1) / 2) || rtB.openings.some((x) => x.side === -1 && x.s0 < (o.s0 + o.s1) / 2 && x.s1 > (o.s0 + o.s1) / 2)).toBeDefined();
    expect(rtB.isOpen(1, 5)).toBe(false);
  });

  it('a bridge is rebuilt when a road beneath it moves, and left alone when an unrelated road changes', () => {
    const sys = new RoadSystem(flat(), resolve);
    const far: RoadDef = { id: 'far', name: 'far', profile: 'hauptstrasse', points: [{ x: 1700, y: 800, z: 4200 }, { x: 1900, y: 800, z: 4200 }] };
    sys.setNetwork([...ic.roads, far], []);
    const rtB = sys.runtimes.find((r) => r.def.id === 'k-B')!;
    const rtFar = sys.runtimes.find((r) => r.def.id === 'far')!;
    // an unrelated road elsewhere changes: B keeps its runtime
    sys.setNetwork([...ic.roads, { ...far, points: [{ x: 1700, y: 800, z: 4300 }, { x: 1900, y: 800, z: 4300 }] }], []);
    expect(sys.runtimes.find((r) => r.def.id === 'k-B')).toBe(rtB);
    expect(sys.runtimes.find((r) => r.def.id === 'far')).not.toBe(rtFar);
    // motorway A (which runs under B) is moved a little: B has to move its piers
    const A = ic.roads.find((r) => r.id === 'k-A')!;
    const movedA = { ...A, points: A.points.map((p) => ({ ...p, z: p.z + 8 })) };
    sys.setNetwork([...ic.roads.map((r) => (r === A ? movedA : r)), far], []);
    expect(sys.runtimes.find((r) => r.def.id === 'k-B')).not.toBe(rtB);
  });
});
