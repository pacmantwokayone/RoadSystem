import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { branchPoints, arcLengthNear } from '../src/network/branch';
import { buildStackInterchange } from '../src/network/interchange';
import { bridgeSections, pierPositions, pierPositionsFor } from '../src/structures/sections';
import { simToThree } from '../src/core/world';
import type { RoadDef } from '../src/network/types';

const profiles = new ProfileLibrary();
const resolve = (d: RoadDef) => profiles.resolve(d.profile, d.params);
function flat(): MockStreamTerrain {
  const t = new MockStreamTerrain();
  t.setModifier('flat', () => 800);
  t.loadRectSync(1500, 1500, 4500, 4500, 0);
  return t;
}

const MAIN: Pick<RoadDef, 'points'> = { points: [0, 200, 400, 600].map((x) => ({ x, y: 500, z: 1000 })) };

describe('branch generator', () => {
  const pts = branchPoints({ main: MAIN, s: 100, side: 1, halfMain: 7, halfBranch: 3, taper: 100, gap: 2, tail: [{ x: 400, y: 500, z: 1200 }] });

  it('starts as a narrow sliver on the main road edge and grows to full width beside it', () => {
    expect(pts[0].widthScale).toBeLessThan(0.2);
    expect(pts[0].x).toBeCloseTo(100, 0);
    // heading +x, seen along the road: side 1 = right, which in sim space (z flipped) is +z... either way |dz| = halfMain + halfBranch·w
    const first = Math.abs(pts[0].z - 1000);
    expect(first).toBeGreaterThan(7);
    expect(first).toBeLessThan(7.8);
    const last = pts[pts.length - 2];
    expect(last.widthScale).toBeUndefined();
    expect(Math.abs(last.z - 1000)).toBeCloseTo(7 + 3 + 2, 1);
    expect(last.x).toBeCloseTo(200, 0);
    expect(pts[pts.length - 1]).toEqual({ x: 400, y: 500, z: 1200 });
  });

  it('keeps the main road height through the taper and widens monotonically', () => {
    const taper = pts.slice(0, -1);
    for (const p of taper) expect(p.y).toBeCloseTo(500, 3);
    for (let i = 1; i < taper.length; i++) expect(Math.abs(taper[i].z - 1000)).toBeGreaterThan(Math.abs(taper[i - 1].z - 1000));
  });

  it('a merge runs the other way round, and the other side mirrors', () => {
    const m = branchPoints({ main: MAIN, s: 100, side: 1, halfMain: 7, halfBranch: 3, taper: 100, tail: [{ x: 400, y: 500, z: 1200 }], merge: true });
    expect(m[0]).toEqual({ x: 400, y: 500, z: 1200 });
    expect(m[m.length - 1].widthScale).toBeLessThan(0.2);
    const l = branchPoints({ main: MAIN, s: 100, side: -1, halfMain: 7, halfBranch: 3, taper: 100, tail: [] });
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
    const t = flat();
    const sys = new RoadSystem(t, resolve);
    sys.setNetwork(ic.roads, []);
    const rtB = sys.runtimes.find((r) => r.def.id === 'k-B')!;
    const rtA = sys.runtimes.find((r) => r.def.id === 'k-A')!;
    const secs = bridgeSections(rtB);
    expect(secs.length).toBeGreaterThan(0);
    const P = new Vector3();
    const halfA = 11 + 3.5;
    let moved = 0;
    for (const sec of secs) {
      // two equal spans: the middle pier would stand exactly on motorway A
      const plain = pierPositions(sec, 520);
      const piers = pierPositionsFor(rtB, sec, 520);
      for (const s of piers) {
        rtB.sampled.curve.pointAt(s, P);
        const sim = { x: P.x, z: -P.z };
        // distance of the pier to A's centre line (A runs along x at z = 3000)
        const onA = Math.abs(sim.z - 3000) < halfA && sim.x > 2100 && sim.x < 3900;
        const underDeck = (rtB.groundAtThree(P.x, P.z) ?? 0) < P.y - 5;
        if (underDeck) expect(onA, `pier at s=${s}`).toBe(false);
      }
      if (piers.length !== plain.length || piers.some((s, i) => s !== plain[i])) moved++;
    }
    void rtA; void simToThree;
    expect(moved).toBeGreaterThan(0);
    // and a span short enough to clear A anyway is left alone
    const sec = secs[0];
    expect(pierPositionsFor(rtB, sec, 45).length).toBeGreaterThan(10);
  });
});
