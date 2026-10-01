import { describe, it, expect } from 'vitest';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { laneSpan, roadwaySpan, hasWalkable, hasBarrier, isMarkedRoad } from '../src/junction/traits';
import { planJunction, signKinds, wantsCrosswalk } from '../src/junction/controls';
import { buildJunctionMarkings } from '../src/mesh/junctionMarkings';
import { placeJunctionSigns } from '../src/props/junctionSigns';
import { sanitizeNode } from '../src/network/doc';
import type { NodeDef, RoadDef } from '../src/network/types';

const lib = new ProfileLibrary();
const P = (name: string) => lib.resolve(name);

describe('profile traits', () => {
  it('lane span: the driving lanes only (no shoulder, no pavement)', () => {
    expect(laneSpan(P('hauptstrasse'), 1)).toEqual({ inner: 0, outer: 3 });
    expect(laneSpan(P('hauptstrasse'), -1)).toEqual({ inner: 0, outer: 3 });
    const dorf = laneSpan(P('dorfstrasse'), 1)!;
    expect(dorf.outer).toBeCloseTo(2.8, 6);
    expect(roadwaySpan(P('hauptstrasse'), 1)!.outer).toBeCloseTo(3.8, 6); // lane + shoulder
    expect(roadwaySpan(P('dorfstrasse'), 1)!.outer).toBeCloseTo(2.8, 6); // pavement not included
  });
  it('a centre strip counts for both sides', () => {
    const a = P('auffahrt'); // one centre lane, 4 m wide
    expect(laneSpan(a, 1)).toEqual({ inner: 0, outer: 2 });
    expect(laneSpan(a, -1)).toEqual({ inner: 0, outer: 2 });
  });
  it('walkable / barrier / marked road', () => {
    expect(hasWalkable(P('dorfstrasse'))).toBe(true);
    expect(hasWalkable(P('hauptstrasse'))).toBe(false);
    expect(hasBarrier(P('autobahn'))).toBe(true);
    expect(isMarkedRoad(P('hauptstrasse'))).toBe(true);
    expect(isMarkedRoad(P('autobahn'))).toBe(false);
    expect(isMarkedRoad(P('wanderweg'))).toBe(false);
    expect(isMarkedRoad(P('flurstrasse'))).toBe(false); // rank 2: dirt road, no stop lines
  });
});

describe('junction control plan', () => {
  it('sign kinds for every control mode', () => {
    expect(signKinds('auto', [5, 5, 3])).toEqual(['hauptstrasse', 'hauptstrasse', 'kein_vortritt']);
    expect(signKinds('none', [5, 5, 3])).toEqual([null, null, null]);
    expect(signKinds('signals', [5, 5, 3])).toEqual([null, null, null]);
    expect(signKinds('stop', [5, 5, 3])).toEqual(['hauptstrasse', 'hauptstrasse', 'stop']);
    expect(signKinds('yield', [5, 5, 3])).toEqual(['hauptstrasse', 'hauptstrasse', 'kein_vortritt']);
    // equal ranks: automatic = Rechtsvortritt, but a forced control applies to everybody
    expect(signKinds('auto', [3, 3, 3])).toEqual([null, null, null]);
    expect(signKinds('stop', [3, 3, 3])).toEqual(['stop', 'stop', 'stop']);
    // paths take no part
    expect(signKinds('stop', [5, 5, 1])).toEqual([null, null, null]);
  });

  it('stop lines at Stop and signals, a dashed wait line at Kein Vortritt, none for unmarked roads', () => {
    const profiles = [P('hauptstrasse'), P('hauptstrasse'), P('gemeindestrasse')];
    const auto = planJunction('auto', 'auto', profiles);
    expect(auto.map((a) => a.line)).toEqual([null, null, 'wait']); // Gemeindestrasse (rank 3) gives way
    expect(planJunction('stop', 'auto', profiles).map((a) => a.line)).toEqual([null, null, 'stop']);
    expect(planJunction('signals', 'none', profiles).map((a) => a.line)).toEqual(['stop', 'stop', 'stop']);
    expect(planJunction('signals', 'none', [P('hauptstrasse'), P('hauptstrasse'), P('flurstrasse')]).map((a) => a.line)).toEqual(['stop', 'stop', null]);
  });

  it('crosswalks: automatic on roads with pavements, everywhere on request, never with fewer than 3 arms or on motorways', () => {
    expect(wantsCrosswalk('auto', P('dorfstrasse'), 4)).toBe(true);
    expect(wantsCrosswalk('auto', P('hauptstrasse'), 4)).toBe(false);
    expect(wantsCrosswalk('all', P('hauptstrasse'), 4)).toBe(true);
    expect(wantsCrosswalk('none', P('dorfstrasse'), 4)).toBe(false);
    expect(wantsCrosswalk('all', P('dorfstrasse'), 2)).toBe(false);
    expect(wantsCrosswalk('all', P('autobahn'), 4)).toBe(false);
    expect(wantsCrosswalk('all', P('wanderweg'), 4)).toBe(false);
  });
});

describe('node settings are validated', () => {
  const base = { id: 'n', x: 1, y: 2, z: 3 };
  it('keeps valid non-default values, drops defaults and garbage', () => {
    expect(sanitizeNode({ ...base, control: 'signals', crosswalks: 'all', signalMode: 'flashing', greenS: 30 })).toEqual({ ...base, control: 'signals', crosswalks: 'all', signalMode: 'flashing', greenS: 30 });
    expect(sanitizeNode({ ...base, control: 'auto', crosswalks: 'auto', signalMode: 'fixed', greenS: 20 })).toEqual(base);
    expect(sanitizeNode({ ...base, control: 'nope', crosswalks: 3, signalMode: {}, greenS: 'x' })).toEqual(base);
    expect(sanitizeNode({ ...base, greenS: 9999 })!.greenS).toBe(120);
    expect(sanitizeNode({ ...base, greenS: 1 })!.greenS).toBe(5);
  });
});

// ---- geometry ---------------------------------------------------------------

const terrain = (): MockStreamTerrain => {
  const t = new MockStreamTerrain({ heightFn: () => 800 });
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2700, 2400, 3900, 3600, 0);
  return t;
};
const roadsX = (profile: string): RoadDef[] => {
  const mk = (id: string, pts: Array<[number, number]>, extra: Partial<RoadDef>): RoadDef => ({ id, name: id, profile, points: pts.map(([x, z]) => ({ x, y: 800, z })), ...extra });
  return [
    mk('w', [[3000, 3000], [3150, 3000], [3300, 3000]], { endNode: 'X' }),
    mk('e', [[3300, 3000], [3450, 3000], [3600, 3000]], { startNode: 'X' }),
    mk('s', [[3300, 2700], [3300, 2850], [3300, 3000]], { endNode: 'X' }),
    mk('n', [[3300, 3000], [3300, 3150], [3300, 3300]], { startNode: 'X' }),
  ];
};
function system(profile: string, node: Partial<NodeDef> = {}): RoadSystem {
  const sys = new RoadSystem(terrain(), (d) => lib.resolve(d.profile, d.params));
  sys.setNetwork(roadsX(profile), [{ id: 'X', x: 3300, y: 800, z: 3000, ...node }]);
  let g = 0;
  while ((sys.stats().ready < sys.stats().chunks || sys.junctionStats().ready < sys.junctionStats().total) && g++ < 300) sys.resync({ checks: 999, builds: 99 });
  return sys;
}
const verts = (g: { geometry: import('three').BufferGeometry }): Array<[number, number, number]> => {
  const p = g.geometry.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)]);
};

describe('junction markings', () => {
  it('Dorfstrasse crossing: zebra bars on every arm, near the node, on the road surface', () => {
    const sys = system('dorfstrasse');
    const j = sys.junctions[0];
    const m = buildJunctionMarkings(j)!;
    expect(m).not.toBeNull();
    const vs = verts(m);
    // 4 arms × bars: the roadway is 5.6 m wide → 5 bars of 0.5 m per arm, 4 vertices… at least 4·5 strips
    expect(vs.length).toBeGreaterThanOrEqual(4 * 5 * 4);
    for (const [x, y, z] of vs) {
      const d = Math.hypot(x - 3300, z - -3000);
      expect(d).toBeGreaterThan(5);
      expect(d).toBeLessThan(30);
      expect(y).toBeGreaterThan(800.05);
      expect(y).toBeLessThan(801.2);
    }
  });

  it('no paint at an unmarked junction (equal Hauptstrassen, no pavements)', () => {
    const sys = system('hauptstrasse');
    expect(buildJunctionMarkings(sys.junctions[0])).toBeNull();
  });

  it('control "signals" paints stop lines on every arm; "none" + no crosswalks paints nothing', () => {
    const lines = buildJunctionMarkings(system('hauptstrasse', { control: 'signals' }).junctions[0])!;
    expect(lines).not.toBeNull();
    // one rect per arm (2 stations → 4 vertices, ≥ 3 stations over the ring samples) → at least 4 arms × 4 vertices
    expect(verts(lines).length).toBeGreaterThanOrEqual(16);
    expect(buildJunctionMarkings(system('dorfstrasse', { control: 'none', crosswalks: 'none' }).junctions[0])).toBeNull();
  });

  it('stop lines lie across the approaching lanes only (right-hand side as seen by the traffic)', () => {
    const j = system('hauptstrasse', { control: 'signals' }).junctions[0];
    const m = buildJunctionMarkings(j)!;
    // the arm from the west ('w', ends at the node, travelling +x): approaching lanes are on its right = three +z
    const vs = verts(m).filter(([x]) => x < 3300 - 5 && Math.abs(x - 3300) < 30);
    const zs = vs.map(([, , z]) => z - -3000);
    expect(Math.max(...zs)).toBeGreaterThan(2.5);
    expect(Math.min(...zs)).toBeGreaterThan(-0.2);
  });
});

describe('signs follow the node settings', () => {
  it('Stop control puts Stop signs on the minor arms; signals put none; crosswalk sign at zebra crossings', () => {
    const mixed = (node: Partial<NodeDef>): RoadSystem => {
      const sys = new RoadSystem(terrain(), (d) => lib.resolve(d.profile, d.params));
      const r = roadsX('hauptstrasse');
      r[2] = { ...r[2], profile: 'gemeindestrasse' };
      r[3] = { ...r[3], profile: 'gemeindestrasse' };
      sys.setNetwork(r, [{ id: 'X', x: 3300, y: 800, z: 3000, ...node }]);
      let g = 0;
      while ((sys.stats().ready < sys.stats().chunks || sys.junctionStats().ready < sys.junctionStats().total) && g++ < 300) sys.resync({ checks: 999, builds: 99 });
      return sys;
    };
    const assets = (n: Partial<NodeDef>): string[] => placeJunctionSigns(mixed(n).junctions[0]).map((p) => p.asset).sort();
    expect(assets({})).toEqual(['sign:hauptstrasse', 'sign:hauptstrasse', 'sign:kein_vortritt', 'sign:kein_vortritt']);
    expect(assets({ control: 'stop' })).toEqual(['sign:hauptstrasse', 'sign:hauptstrasse', 'sign:stop', 'sign:stop']);
    expect(assets({ control: 'none' })).toEqual([]);
    expect(assets({ control: 'signals' })).toEqual([]);
    const withCrossings = placeJunctionSigns(system('dorfstrasse').junctions[0]).map((p) => p.asset);
    expect(withCrossings.filter((a) => a === 'sign:fussgaengerstreifen')).toHaveLength(4);
  });
});
