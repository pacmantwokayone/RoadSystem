import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadRuntime, DEFAULT_RUNTIME_OPTIONS } from '../src/runtime/roadRuntime';
import { buildChunkGeometry } from '../src/mesh/extrude';
import { ProfileLibrary } from '../src/profile/library';
import type { RoadDef } from '../src/network/types';

const lib = new ProfileLibrary();
const def = (profile: string, pts: Array<[number, number, number]>): RoadDef => ({
  id: 'x', name: 'x', profile, points: pts.map(([x, y, z]) => ({ x, y, z })),
});
const line: Array<[number, number, number]> = [
  [3000, 0, 3000], [3150, 0, 3040], [3300, 0, 3010], [3450, 0, 3100], [3600, 0, 3140],
];

function settled(): MockStreamTerrain {
  const t = new MockStreamTerrain();
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2800, 2800, 3800, 3400, 0);
  return t;
}

function build(profileName: string, terrain = settled()) {
  const rt = new RoadRuntime(def(profileName, line), terrain, lib.resolve(profileName), DEFAULT_RUNTIME_OPTIONS);
  rt.chunks.forEach((c) => rt.tryBuildChunk(c));
  return { rt, terrain };
}

describe('extrusion', () => {
  it('normals follow the road pitch on a steep fixed-height road (lighting is correct on slopes)', () => {
    const terrain = new MockStreamTerrain();
    const d: RoadDef = {
      id: 'ramp', name: 'ramp', profile: 'hauptstrasse',
      points: [[3000, 1000, 3000], [3100, 1010, 3000], [3200, 1020, 3000]].map(([x, y, z]) => ({ x, y, z, elev: 'fixed' as const })),
    };
    const rt = new RoadRuntime(d, terrain, lib.resolve('hauptstrasse'), DEFAULT_RUNTIME_OPTIONS);
    rt.chunks.forEach((c) => rt.tryBuildChunk(c)); // fixed → no terrain needed
    expect(rt.chunks.every((c) => c.state === 'ready')).toBe(true);
    const { geometry } = buildChunkGeometry(rt, rt.chunks[0]);
    const nrm = geometry.getAttribute('normal');
    const centreSeg = rt.profile.points.findIndex((p) => p.x === 0);
    const n = new Vector3(nrm.getX(centreSeg * 2), nrm.getY(centreSeg * 2), nrm.getZ(centreSeg * 2));
    const t = rt.designFrame(0).tangent;
    expect(t.y).toBeGreaterThan(0.09);
    expect(Math.abs(n.dot(t))).toBeLessThan(0.01);
    expect(n.y).toBeLessThan(0.999); // tilted with the slope, not world-up
  });

  it('produces the expected vertex layout and a material group per used material', () => {
    const { rt } = build('hauptstrasse');
    const chunk = rt.chunks[0];
    const { geometry, materials } = buildChunkGeometry(rt, chunk);
    const S = rt.profile.points.length - 1;
    const rings = chunk.i1 - chunk.i0 + 1;
    expect(geometry.getAttribute('position').count).toBe(rings * (S * 2 + 6) + 2 * rt.profile.points.length); // + the start cap
    expect(materials).toContain('asphalt');
    expect(materials).toContain('subgrade');
    expect(new Set(materials).size).toBe(materials.length);
    const total = geometry.groups.reduce((a, g) => a + g.count, 0);
    expect(total).toBe(geometry.getIndex()!.count);
  });

  it('every triangle faces the same way as its stored normal (consistent winding)', () => {
    const { rt } = build('hauptstrasse');
    const { geometry } = buildChunkGeometry(rt, rt.chunks[1]);
    const pos = geometry.getAttribute('position');
    const nrm = geometry.getAttribute('normal');
    const idx = geometry.getIndex()!;
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3(), sn = new Vector3();
    let checked = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const ia = idx.getX(t), ib = idx.getX(t + 1), ic = idx.getX(t + 2);
      a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic);
      n.subVectors(b, a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-10) continue; // degenerate sliver
      sn.fromBufferAttribute(nrm, ia).add(sn.fromBufferAttribute(nrm, ib)).add(sn.fromBufferAttribute(nrm, ic));
      expect(n.dot(sn)).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('top surface normals point up on flat-ish ground, wall normals point sideways, bottom down', () => {
    const { rt } = build('hauptstrasse');
    const { geometry } = buildChunkGeometry(rt, rt.chunks[0]);
    const nrm = geometry.getAttribute('normal');
    const S = rt.profile.points.length - 1;
    const V = S * 2 + 6;
    // lane segment normal (ring 0): the segment right of the centre is perpendicular to the road
    const centreSeg = rt.profile.points.findIndex((p) => p.x === 0);
    const n = new Vector3(nrm.getX(centreSeg * 2), nrm.getY(centreSeg * 2), nrm.getZ(centreSeg * 2));
    expect(n.y).toBeGreaterThan(0.8);
    expect(Math.abs(n.dot(rt.designFrame(0).tangent))).toBeLessThan(0.05);
    // left wall: horizontal, sideways; bottom: straight down
    expect(Math.abs(nrm.getY(S * 2 + 1))).toBeLessThan(1e-6);
    expect(Math.hypot(nrm.getX(S * 2 + 1), nrm.getZ(S * 2 + 1))).toBeCloseTo(1, 5);
    expect(nrm.getY(S * 2 + 4)).toBeLessThan(-0.99);
    expect(V).toBe(S * 2 + 6);
  });

  it('neighbouring chunks agree exactly on their shared boundary ring', () => {
    const { rt } = build('hauptstrasse');
    expect(rt.chunks.length).toBeGreaterThan(2);
    const g0 = buildChunkGeometry(rt, rt.chunks[0]).geometry.getAttribute('position');
    const g1 = buildChunkGeometry(rt, rt.chunks[1]).geometry.getAttribute('position');
    const V = rt.profile.points.length * 2 - 2 + 6;
    const lastRing = (rt.chunks[0].i1 - rt.chunks[0].i0) * V; // ring vertices come first, caps are appended after
    for (let v = 0; v < V; v++) {
      expect(g1.getX(v)).toBeCloseTo(g0.getX(lastRing + v), 5);
      expect(g1.getY(v)).toBeCloseTo(g0.getY(lastRing + v), 5);
      expect(g1.getZ(v)).toBeCloseTo(g0.getZ(lastRing + v), 5);
    }
  });

  it('the road surface is never buried: centre-line top is at or above the terrain under the carriageway', () => {
    const { rt, terrain } = build('hauptstrasse');
    let worst = Infinity;
    for (const chunk of rt.chunks) {
      for (let i = chunk.i0; i <= chunk.i1; i++) {
        const p = rt.samples[i].pos;
        const ground = terrain.heightAt(p.x, -p.z)!;
        worst = Math.min(worst, rt.designY[i] - ground);
      }
    }
    // dilate-then-smooth guarantees design height >= terrain at every sample
    expect(worst).toBeGreaterThan(-1e-6);
  });

  it('side walls reach down to the terrain beside the road (no gap under the edge)', () => {
    const { rt, terrain } = build('hauptstrasse');
    let checked = 0;
    for (const chunk of rt.chunks) {
      const { geometry } = buildChunkGeometry(rt, chunk);
      const pos = geometry.getAttribute('position');
      const S = rt.profile.points.length - 1;
      const V = S * 2 + 6;
      const rings = chunk.i1 - chunk.i0 + 1;
      for (let r = 0; r < rings; r++) {
        const b = r * V + S * 2;
        for (const [vi, latIdx] of [[b, 0], [b + 3, 4]] as const) {
          const gx = pos.getX(vi), gz = -pos.getZ(vi);
          const ground = terrain.heightAt(gx, gz)!;
          const wallBottomY = pos.getY(vi);
          const topY = pos.getY(vi + (latIdx === 0 ? 1 : -1));
          // wall bottom is below the terrain OR it is the plain thickness (buried road edge in a cut)
          expect(wallBottomY <= ground + 1.0 || wallBottomY <= topY - rt.profile.thickness + 1e-6).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('wanderweg: width variation moves the cross-section along the road', () => {
    const { rt } = build('wanderweg');
    const { geometry } = buildChunkGeometry(rt, rt.chunks[0]);
    const pos = geometry.getAttribute('position');
    const S = rt.profile.points.length - 1;
    const V = S * 2 + 6;
    const rings = rt.chunks[0].i1 - rt.chunks[0].i0 + 1;
    const widths = new Set<number>();
    for (let r = 0; r < rings; r++) {
      const l = r * V + S * 2 + 1;
      const rr = r * V + S * 2 + 2;
      widths.add(Math.round(new Vector3(pos.getX(l), 0, pos.getZ(l)).distanceTo(new Vector3(pos.getX(rr), 0, pos.getZ(rr))) * 100));
    }
    expect(widths.size).toBeGreaterThan(3);
  });
});

describe('RoadMeshLayer replacement (no flicker while editing)', () => {
  it('keeps the old version visible until the replacement is fully built, then drops it', async () => {
    const { RoadSystem } = await import('../src/runtime/roadSystem');
    const { RoadMeshLayer } = await import('../src/mesh/roadMeshLayer');
    const { MaterialRegistry } = await import('../src/surface/materials');
    const terrain = settled();
    const sys = new RoadSystem(terrain, (d) => lib.resolve(d.profile, d.params));
    const layer = new RoadMeshLayer(sys, new MaterialRegistry());
    const a = def('hauptstrasse', line);
    sys.setRoads([a]);
    while (sys.stats().ready < sys.stats().chunks) sys.resync({ checks: 999, builds: 99 });
    const n = layer.meshCount;
    expect(n).toBeGreaterThan(3);

    sys.upsertRoad({ ...a, points: a.points.map((p, i) => (i === 2 ? { ...p, x: p.x + 20 } : p)) });
    expect(layer.meshCount).toBe(n); // old meshes still there, nothing built yet
    sys.resync({ checks: 999, builds: 2 });
    expect(layer.meshCount).toBeGreaterThan(n); // partially built: old + some new
    while (sys.stats().ready < sys.stats().chunks) sys.resync({ checks: 999, builds: 99 });
    expect(layer.meshCount).toBe(sys.stats().chunks); // old version disposed

    sys.removeRoad('x');
    expect(layer.meshCount).toBe(0);
    layer.dispose();
  });
});
