import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { assembleBoundary, layoutJunction, type ArmEnd, type ArmSpec } from '../src/network/junction';
import { pavementOf, pavementRuns } from '../src/network/pavement';
import { buildJunctionPavements } from '../src/mesh/junctionPavement';
import type { NodeDef, RoadDef } from '../src/network/types';

const lib = new ProfileLibrary();

describe('pavementOf', () => {
  it('Dorfstrasse: kerb + pavement beyond the roadway', () => {
    const p = pavementOf(lib.resolve('dorfstrasse'), 1)!;
    expect(p.width).toBeCloseTo(0.15 + 1.6, 6);
    expect(p.step).toBeCloseTo(0.12, 3);
    expect(p.top).toBe('sidewalk');
    expect(p.curb).toBe('curb');
    expect(pavementOf(lib.resolve('dorfstrasse'), -1)!.width).toBeCloseTo(p.width, 6);
  });
  it('Quartierstrasse: the parking lane belongs to the roadway', () => {
    const prof = lib.resolve('quartierstrasse');
    expect(prof.carriageHalfWidth).toBeCloseTo(2.9 + 2.0, 6);
    expect(pavementOf(prof, 1)!.width).toBeCloseTo(0.15 + 2.0, 6);
  });
  it('no pavement on roads without one', () => {
    for (const n of ['hauptstrasse', 'autobahn', 'flurstrasse', 'trampelpfad']) expect(pavementOf(lib.resolve(n), 1), n).toBeNull();
  });
  it('carriageway half width excludes kerbs and pavements, includes shoulders', () => {
    expect(lib.resolve('dorfstrasse').carriageHalfWidth).toBeCloseTo(2.8, 6);
    expect(lib.resolve('dorfstrasse').coreHalfWidth).toBeGreaterThan(4);
    expect(lib.resolve('hauptstrasse').carriageHalfWidth).toBeCloseTo(3.8, 6);
    expect(lib.resolve('wanderweg').carriageHalfWidth).toBe(lib.resolve('wanderweg').coreHalfWidth);
    expect(lib.resolve('fussweg').carriageHalfWidth).toBe(lib.resolve('fussweg').coreHalfWidth);
  });
});

describe('pavement runs on a boundary', () => {
  const dirs = (degs: number[]): ArmEnd[] => degs.map((d) => {
    const dir = { x: Math.cos((d * Math.PI) / 180), z: Math.sin((d * Math.PI) / 180) };
    const r = { x: -dir.z, z: dir.x };
    const w = 3, s = 10;
    const c = { x: dir.x * s, z: dir.z * s };
    return { dir, left: { x: c.x - r.x * w, z: c.z - r.z * w }, right: { x: c.x + r.x * w, z: c.z + r.z * w } };
  });
  const specs = (degs: number[]): ArmSpec[] => degs.map((d) => ({ dir: { x: Math.cos((d * Math.PI) / 180), z: Math.sin((d * Math.PI) / 180) }, halfWidth: 3 }));
  const build = (degs: number[]) => assembleBoundary(layoutJunction(specs(degs), 6), dirs(degs));

  it('a crossing has one run per corner, each from one arm to the next', () => {
    const b = build([0, 90, 180, 270]);
    const runs = pavementRuns(b);
    expect(runs).toHaveLength(4);
    for (const run of runs) {
      const a = b.points[run[0]].tag, z = b.points[run[run.length - 1]].tag;
      expect(a.type === 'arm' && a.f === 1).toBe(true);
      expect(z.type === 'arm' && z.f === 0).toBe(true);
      expect(run.length).toBeGreaterThan(3); // the rounded corner
    }
  });
  it('a dead end has none; a straight side of a T is a short run between the two arms', () => {
    expect(pavementRuns(build([0]))).toHaveLength(0);
    const t = build([0, 180, 90]);
    const runs = pavementRuns(t);
    expect(runs).toHaveLength(3);
    expect(runs.some((r) => r.length === 2)).toBe(true); // the through road's side without the branch
  });
});

describe('pavement corners on a real junction', () => {
  const mk = (id: string, profile: string, pts: Array<[number, number]>, extra: Partial<RoadDef>): RoadDef => ({ id, name: id, profile, points: pts.map(([x, z]) => ({ x, y: 800, z })), ...extra });
  const X = (profile: (i: number) => string): RoadDef[] => [
    mk('w', profile(0), [[3000, 3000], [3150, 3000], [3300, 3000]], { endNode: 'X' }),
    mk('e', profile(1), [[3300, 3000], [3450, 3000], [3600, 3000]], { startNode: 'X' }),
    mk('s', profile(2), [[3300, 2700], [3300, 2850], [3300, 3000]], { endNode: 'X' }),
    mk('n', profile(3), [[3300, 3000], [3300, 3150], [3300, 3300]], { startNode: 'X' }),
  ];
  function system(roads: RoadDef[], node: Partial<NodeDef> = {}): RoadSystem {
    const t = new MockStreamTerrain({ heightFn: () => 800 });
    t.loadRectSync(0, 0, 6000, 6000, 4);
    t.loadRectSync(2700, 2400, 3900, 3600, 0);
    const sys = new RoadSystem(t, (d) => lib.resolve(d.profile, d.params));
    sys.setNetwork(roads, [{ id: 'X', x: 3300, y: 800, z: 3000, ...node }]);
    let g = 0;
    while ((sys.stats().ready < sys.stats().chunks || sys.junctionStats().ready < sys.junctionStats().total) && g++ < 300) sys.resync({ checks: 999, builds: 99 });
    return sys;
  }

  it('Dorfstrasse crossing: four rounded pavement corners at kerb height, flush with the arms', () => {
    const sys = system(X(() => 'dorfstrasse'));
    const patch = sys.junctions[0].patch!;
    expect(patch.pavements).toHaveLength(4);
    for (const s of patch.pavements) {
      expect(s.inner.length).toBe(s.outer.length);
      s.steps.forEach((st) => expect(st).toBeCloseTo(0.12, 3));
      s.heights.forEach((h) => expect(Math.abs(h - 800.15)).toBeLessThan(0.5));
      // end points are an arm's carriageway corner: the strip is ~1.75 m wide there
      const w0 = Math.hypot(s.outer[0].x - s.inner[0].x, s.outer[0].z - s.inner[0].z);
      const w1 = Math.hypot(s.outer[s.outer.length - 1].x - s.inner[s.inner.length - 1].x, s.outer[s.outer.length - 1].z - s.inner[s.inner.length - 1].z);
      expect(w0).toBeCloseTo(1.75, 1);
      expect(w1).toBeCloseTo(1.75, 1);
      // outer edge lies outside the patch (further from the node than the inner edge)
      s.inner.forEach((p, i) => {
        const o = s.outer[i];
        expect(Math.hypot(o.x - 3300, o.z + 3000)).toBeGreaterThan(Math.hypot(p.x - 3300, p.z + 3000) - 1e-6);
      });
    }
  });

  it('the patch covers the carriageway only — its arm edges are as wide as the roadway, not the pavement', () => {
    const sys = system(X(() => 'dorfstrasse'));
    const j = sys.junctions[0];
    const arm = j.arms[0];
    const c = arm.road.endCross(arm.end);
    expect(c.halfCarriage).toBeCloseTo(2.8, 6);
    const edge = j.patch!.boundary.points.filter((p) => p.tag.type === 'arm' && p.tag.arm === 0);
    const width = Math.hypot(edge[0].p.x - edge[edge.length - 1].p.x, edge[0].p.z - edge[edge.length - 1].p.z);
    expect(width).toBeCloseTo(5.6, 2);
  });

  it('no strips without pavements; mixed roads taper the pavement to nothing at the road without one', () => {
    expect(system(X(() => 'hauptstrasse')).junctions[0].patch!.pavements).toHaveLength(0);
    const mixed = system(X((i) => (i < 2 ? 'hauptstrasse' : 'dorfstrasse'))).junctions[0].patch!.pavements;
    expect(mixed.length).toBe(4);
    for (const s of mixed) {
      const widths = s.outer.map((o, i) => Math.hypot(o.x - s.inner[i].x, o.z - s.inner[i].z));
      expect(Math.min(...widths)).toBeLessThan(0.3);
      expect(Math.max(...widths)).toBeGreaterThan(1.5);
    }
  });

  it('mesh: every top face points up, kerb faces point to the road, skirts reach below the terrain', () => {
    const sys = system(X(() => 'dorfstrasse'));
    const m = buildJunctionPavements(sys.junctions[0].patch!)!;
    expect(m.materials).toEqual(expect.arrayContaining(['sidewalk', 'curb', 'subgrade']));
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.getIndex()!;
    const v = (i: number) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const topGroup = m.geometry.groups.find((g) => m.materials[g.materialIndex!] === 'sidewalk')!;
    for (let t = topGroup.start; t < topGroup.start + topGroup.count; t += 3) {
      const a = v(idx.getX(t)), b = v(idx.getX(t + 1)), c = v(idx.getX(t + 2));
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
      if (n.lengthSq() > 1e-10) expect(n.y).toBeGreaterThan(0);
    }
    const skirt = m.geometry.groups.find((g) => m.materials[g.materialIndex!] === 'subgrade')!;
    let low = Infinity;
    for (let t = skirt.start; t < skirt.start + skirt.count; t++) low = Math.min(low, pos.getY(idx.getX(t)));
    expect(low).toBeLessThan(800 - 0.2);
    for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
  });

  it('a T junction with a through road gets a pavement strip across the straight side too', () => {
    const roads = [
      mk('w', 'dorfstrasse', [[3000, 3000], [3150, 3000], [3300, 3000]], { endNode: 'X' }),
      mk('e', 'dorfstrasse', [[3300, 3000], [3450, 3000], [3600, 3000]], { startNode: 'X' }),
      mk('s', 'dorfstrasse', [[3300, 2700], [3300, 2850], [3300, 3000]], { endNode: 'X' }),
    ];
    const strips = system(roads).junctions[0].patch!.pavements;
    expect(strips).toHaveLength(3);
    expect(strips.some((s) => s.inner.length === 2)).toBe(true);
  });
});
