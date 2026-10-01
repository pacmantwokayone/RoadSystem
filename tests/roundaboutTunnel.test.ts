import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { buildRoundabout, findRoundabouts } from '../src/network/roundabout';
import { portalsOf, TunnelField, CUT_LENGTH_M } from '../src/tunnel/field';
import { tunnelSections, tunnelDims } from '../src/tunnel/sections';
import { buildChunkTunnel } from '../src/tunnel/geometry';
import { TunnelLayer } from '../src/tunnel/tunnelLayer';
import { TunnelSystem } from '../src/tunnel/tunnelSystem';
import { PropMaterials } from '../src/props/materials';
import type { RoadDef } from '../src/network/types';

const profiles = new ProfileLibrary();

const hill = (x: number, z: number): number => 800 + 40 * Math.exp(-((x - 3300) ** 2) / (2 * 80 * 80)) + 0 * z;
function terrain(fn: (x: number, z: number) => number = () => 800): MockStreamTerrain {
  const t = new MockStreamTerrain({ heightFn: fn });
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2700, 2600, 3900, 3400, 0);
  return t;
}
const drain = (sys: RoadSystem): void => { let g = 0; while (sys.stats().ready < sys.stats().chunks && g++ < 400) sys.resync({ checks: 999, builds: 99 }); };

describe('roundabouts', () => {
  const rb = buildRoundabout({
    id: 'k', x: 3000, z: 3000, y: 800, radius: 24,
    arms: [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((angle, i) => ({ angle, profile: 'nebenstrasse', name: `Arm ${i}` })),
  });

  it('a ring of roads and one node per arm', () => {
    expect(rb.nodes).toHaveLength(4);
    expect(rb.roads.filter((r) => r.profile === 'kreisel')).toHaveLength(4);
    expect(rb.roads.filter((r) => r.profile === 'nebenstrasse')).toHaveLength(4);
    // every node joins two ring ends and one arm
    for (const n of rb.nodes) {
      const ends = rb.roads.filter((r) => r.startNode === n.id || r.endNode === n.id);
      expect(ends).toHaveLength(3);
    }
    // ring points lie on the circle
    for (const r of rb.roads.filter((x) => x.profile === 'kreisel')) for (const p of r.points) expect(Math.hypot(p.x - 3000, p.z - 3000)).toBeCloseTo(24, 6);
    expect(rb.island.radius).toBeLessThan(24);
  });

  it('is found again in a network, and builds with a junction at every arm', () => {
    const found = findRoundabouts(rb.roads);
    expect(found).toHaveLength(1);
    expect(found[0].x).toBeCloseTo(3000, 0);
    expect(found[0].radius).toBeCloseTo(24, 0);
    // a plain curve is not a roundabout
    expect(findRoundabouts([{ id: 'c', name: 'c', profile: 'kreisel', points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }] }])).toHaveLength(0);
    const sys = new RoadSystem(terrain(), (d) => profiles.resolve(d.profile, d.params));
    sys.setNetwork(rb.roads, rb.nodes);
    drain(sys);
    expect(sys.junctionStats().total).toBe(4);
    expect(sys.stats().ready).toBe(sys.stats().chunks);
  });

  it('the ring outranks the arms: the arms give way', () => {
    expect(profiles.resolve('kreisel').rank).toBeGreaterThan(profiles.resolve('nebenstrasse').rank);
  });
});

describe('tunnels', () => {
  const road = (): RoadDef => ({
    id: 't', name: 't', profile: 'hauptstrasse',
    points: [
      { x: 3000, y: 800, z: 3000 }, { x: 3150, y: 800.3, z: 3000 },
      { x: 3200, y: 800.3, z: 3000, mode: 'tunnel' }, { x: 3300, y: 800.3, z: 3000, mode: 'tunnel' }, { x: 3400, y: 800.3, z: 3000, mode: 'tunnel' },
      { x: 3450, y: 800.3, z: 3000 }, { x: 3600, y: 800, z: 3000 },
    ],
  });

  it('finds the section between the tunnel points and a portal at each end, facing outwards', () => {
    const t = terrain();
    const sys = new RoadSystem(t, (d) => profiles.resolve(d.profile, d.params));
    sys.setRoads([road()]);
    const rt = sys.runtimes[0];
    const sec = tunnelSections(rt);
    expect(sec).toHaveLength(1);
    expect(sec[0].s1 - sec[0].s0).toBeCloseTo(200, 0);
    const [a, b] = portalsOf(rt);
    expect(a.end).toBe('start');
    expect(a.x).toBeCloseTo(3200, 0);
    expect(a.dx).toBeCloseTo(-1, 3); // out of the tunnel = towards the road's start
    expect(b.x).toBeCloseTo(3400, 0);
    expect(b.dx).toBeCloseTo(1, 3);
    expect(a.z).toBeCloseTo(3000, 0); // SIM z, not THREE z
  });

  it('digs a cutting in front of the portal, cuts the hill back behind it, and leaves the rest alone', () => {
    const f = new TunnelField([{ road: 't', end: 'start', x: 3200, z: 3000, dx: -1, dz: 0, y: 800.3, hw: 4.5, roof: 6.9 }]);
    const base = 840;
    expect(f.modify(3190, 3000, base)).toBeCloseTo(800.3 - 0.3, 1); // on the floor, in front of the portal
    expect(f.modify(3190, 3000 + 30, base)).toBeGreaterThan(f.modify(3190, 3000, base)); // the sides rise
    expect(f.modify(3190, 3000 + 200, base)).toBe(base); // far away: untouched
    expect(f.modify(3200 - CUT_LENGTH_M - 5, 3000, base)).toBe(base); // beyond the cutting
    const behind = f.modify(3210, 3000, base); // inside the hill: cut back at 45° from the portal's top edge
    expect(behind).toBeGreaterThan(800.3 + 6.9 - 0.5);
    expect(behind).toBeLessThan(base);
    expect(f.modify(3290, 3000, 810)).toBe(810); // lower ground is never raised
    expect(f.bounds()!.minX).toBeLessThan(3200 - CUT_LENGTH_M);
  });

  it('builds a finite lining and two portals, and the layer follows the road', () => {
    const t = terrain(hill);
    const sys = new RoadSystem(t, (d) => profiles.resolve(d.profile, d.params));
    const layer = new TunnelLayer(sys, new PropMaterials(() => null));
    const tunnels = new TunnelSystem(sys, t, 0);
    sys.setRoads([road()]);
    tunnels.update();
    drain(sys);
    tunnels.update(); // the cutting changed the terrain: roads were rebuilt on it
    drain(sys);
    expect(tunnels.portals).toHaveLength(2);
    expect(t.heightAt(3190, 3000)!).toBeLessThan(801); // the cutting is dug
    expect(layer.meshCount).toBeGreaterThan(0);
    const rt = sys.runtimes[0];
    let tris = 0;
    for (const ch of rt.chunks) {
      const b = buildChunkTunnel(rt, ch);
      if (!b) continue;
      const g = b.batch.build();
      if (!g) continue;
      for (const a of Object.values(g.geometry.attributes)) for (const v of (a as THREE.BufferAttribute).array) expect(Number.isFinite(v)).toBe(true);
      tris += g.geometry.getIndex()!.count / 3;
      expect(g.materials).toEqual(expect.arrayContaining(['tunnel_lining']));
    }
    expect(tris).toBeGreaterThan(100);
    expect(tunnelDims(rt).halfW).toBeGreaterThan(rt.profile.carriageHalfWidth);
    sys.removeRoad('t');
    expect(layer.meshCount).toBe(0);
  });

  it('no tunnel, no portals', () => {
    const t = terrain();
    const sys = new RoadSystem(t, (d) => profiles.resolve(d.profile, d.params));
    sys.setRoads([{ id: 'p', name: 'p', profile: 'hauptstrasse', points: [{ x: 3000, y: 800, z: 3000 }, { x: 3300, y: 800, z: 3000 }] }]);
    expect(tunnelSections(sys.runtimes[0])).toHaveLength(0);
    expect(portalsOf(sys.runtimes[0])).toHaveLength(0);
  });
});
