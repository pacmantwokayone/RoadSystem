import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { RoadMeshLayer } from '../src/mesh/roadMeshLayer';
import { MaterialRegistry } from '../src/surface/materials';
import { buildChunkGeometry } from '../src/mesh/extrude';
import { buildJunctionGeometry } from '../src/mesh/junctionMesh';
import { ProfileLibrary } from '../src/profile/library';
import { pointInPolygon } from '../src/network/junction';
import type { NodeDef, RoadDef } from '../src/network/types';

const lib = new ProfileLibrary();
const resolve = (d: RoadDef) => lib.resolve(d.profile, d.params);

function terrain(): MockStreamTerrain {
  const t = new MockStreamTerrain();
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2700, 2400, 3900, 3400, 0);
  return t;
}

const R = (id: string, profile: string, pts: Array<[number, number]>, extra: Partial<RoadDef> = {}): RoadDef => ({
  id, name: id, profile, points: pts.map(([x, z]) => ({ x, y: 800, z })), ...extra,
});

// a T: main road west↔east, side road coming from the south (sim z smaller), node at (3300, 3000)
const NODE: NodeDef = { id: 'n1', x: 3300, y: 800, z: 3000 };
const T_ROADS = (): RoadDef[] => [
  R('w', 'hauptstrasse', [[3000, 3000], [3150, 3030], [3300, 3000]], { endNode: 'n1' }),
  R('e', 'hauptstrasse', [[3300, 3000], [3450, 2970], [3600, 3000]], { startNode: 'n1' }),
  R('s', 'flurstrasse', [[3300, 2700], [3290, 2850], [3300, 3000]], { endNode: 'n1' }),
];

function settleAll(sys: RoadSystem): void {
  let guard = 0;
  while ((sys.stats().ready < sys.stats().chunks || sys.junctionStats().ready < sys.junctionStats().total) && guard++ < 200) {
    sys.resync({ checks: 999, builds: 99 });
  }
}

describe('junction runtime on a T intersection', () => {
  it('trims the arms, builds one patch, and its edges meet the road ends without a gap', () => {
    const t = terrain();
    const sys = new RoadSystem(t, resolve);
    sys.setNetwork(T_ROADS(), [NODE]);
    settleAll(sys);

    expect(sys.junctions).toHaveLength(1);
    const j = sys.junctions[0];
    expect(j.state).toBe('ready');
    expect(j.patch!.boundary.fallback).toBe('none');

    // each arm stops short of the node by roughly its layout setback
    j.arms.forEach((a, i) => {
      const e = a.road.endCross(a.end);
      const dist = Math.hypot(e.pos.x - NODE.x, e.pos.z - -NODE.z);
      expect(dist).toBeGreaterThan(j.layout.setbacks[i] * 0.8);
      expect(dist).toBeLessThan(j.layout.setbacks[i] * 1.5);
    });

    // the node centre lies inside the patch outline
    expect(pointInPolygon(j.center, j.patch!.boundary.points.map((b) => b.p))).toBe(true);

    // SEAM: every patch corner on an arm edge coincides (x, y, z) with a vertex of that arm's last extruded ring
    const patchGeo = buildJunctionGeometry(j.patch!).geometry.getAttribute('position');
    let seamChecks = 0;
    for (const a of j.arms) {
      const rt = a.road;
      const chunk = rt.endChunk(a.end);
      const roadPos = buildChunkGeometry(rt, chunk).geometry.getAttribute('position');
      const idx = rt.endIndex(a.end);
      const S = rt.profile.points.length - 1;
      const V = S * 2 + 6;
      const ring = idx - chunk.i0;
      const ringVerts: Vector3[] = [];
      for (let v = 0; v < V; v++) ringVerts.push(new Vector3().fromBufferAttribute(roadPos, ring * V + v));
      const e = rt.endCross(a.end);
      // patch vertices on this arm's seam = boundary points tagged with the arm index and f = 0 / 1
      j.patch!.boundary.points.forEach((bp, k) => {
        if (bp.tag.type !== 'arm' || j.arms[bp.tag.arm] !== a || (bp.tag.f !== 0 && bp.tag.f !== 1)) return;
        const pv = new Vector3().fromBufferAttribute(patchGeo, 1 + j.patch!.rings.length * j.patch!.boundary.points.length + k); // boundary ring follows the interior rings
        const best = Math.min(...ringVerts.map((rv) => rv.distanceTo(pv)));
        expect(best).toBeLessThan(0.05);
        seamChecks++;
      });
      void e;
    }
    expect(seamChecks).toBe(6); // 3 arms × 2 corners
  });

  it('patch mesh: top faces up, walls face outward, valid indices, two material groups', () => {
    const t = terrain();
    const sys = new RoadSystem(t, resolve);
    sys.setNetwork(T_ROADS(), [NODE]);
    settleAll(sys);
    const j = sys.junctions[0];
    const { geometry, materials } = buildJunctionGeometry(j.patch!);
    const pos = geometry.getAttribute('position'), nrm = geometry.getAttribute('normal'), idx = geometry.getIndex()!;
    expect(materials.length).toBe(geometry.groups.length);
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3(), s = new Vector3();
    const [top, wall] = geometry.groups;
    let up = 0, out = 0;
    for (let g = 0; g < geometry.groups.length; g++) {
      const grp = geometry.groups[g];
      for (let k = grp.start; k < grp.start + grp.count; k += 3) {
        const [ia, ib, ic] = [idx.getX(k), idx.getX(k + 1), idx.getX(k + 2)];
        expect(Math.max(ia, ib, ic)).toBeLessThan(pos.count);
        a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic);
        n.subVectors(b, a).cross(c.clone().sub(a));
        if (n.lengthSq() < 1e-10) continue;
        s.fromBufferAttribute(nrm, ia).add(new Vector3().fromBufferAttribute(nrm, ib)).add(new Vector3().fromBufferAttribute(nrm, ic));
        expect(n.dot(s)).toBeGreaterThan(0);          // geometric normal agrees with the stored normals
        if (g === 0) { expect(n.y).toBeGreaterThan(0); up++; } else out++;
      }
    }
    expect(top.count).toBeGreaterThan(0);
    expect(wall.count).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(30);
    expect(out).toBeGreaterThan(5);
  });

  it('the patch resolution adapts to its size (small triangles, so terrain cannot poke through)', () => {
    const t = terrain();
    const sys = new RoadSystem(t, resolve);
    sys.setNetwork(T_ROADS(), [NODE]);
    settleAll(sys);
    const small = sys.junctions[0].patch!;
    sys.setNetwork(T_ROADS(), [{ ...NODE, radius: 20 }]);
    settleAll(sys);
    const big = sys.junctions[0].patch!;
    expect(small.ringCount).toBeGreaterThanOrEqual(3);
    expect(big.ringCount).toBeGreaterThan(small.ringCount);
    expect(big.ringCount).toBeLessThanOrEqual(10);
  });

  it('the patch surface is never buried by the terrain', () => {
    const t = terrain();
    const sys = new RoadSystem(t, resolve);
    sys.setNetwork(T_ROADS(), [NODE]);
    settleAll(sys);
    const { geometry } = buildJunctionGeometry(sys.junctions[0].patch!);
    const pos = geometry.getAttribute('position');
    const nTop = 1 + (sys.junctions[0].patch!.rings.length + 1) * sys.junctions[0].patch!.boundary.points.length;
    for (let i = 0; i < nTop; i++) {
      const ground = t.heightAt(pos.getX(i), -pos.getZ(i))!;
      expect(pos.getY(i)).toBeGreaterThanOrEqual(ground - 0.2); // boundary heights come from the arms (≥ their own terrain)
    }
  });
});

describe('network diffing', () => {
  it('editing the node radius rebuilds only the roads of that junction, not unrelated ones', () => {
    const t = terrain();
    const sys = new RoadSystem(t, resolve);
    const far = R('far', 'wanderweg', [[2800, 3300], [2900, 3320], [3000, 3300]]);
    sys.setNetwork([...T_ROADS(), far], [NODE]);
    const before = new Map(sys.runtimes.map((r) => [r.def.id, r]));
    const jBefore = sys.junctions[0];

    sys.setNetwork([...T_ROADS().map((r, i) => (r.id === 'far' ? far : r)), far], [{ ...NODE, radius: 12 }]);
    const after = new Map(sys.runtimes.map((r) => [r.def.id, r]));
    expect(after.get('far')).toBe(before.get('far'));       // untouched
    expect(after.get('w')).not.toBe(before.get('w'));       // trims changed
    expect(after.get('s')).not.toBe(before.get('s'));
    expect(sys.junctions[0]).not.toBe(jBefore);
  });

  it('identical input is a no-op (nothing rebuilt)', () => {
    const t = terrain();
    const sys = new RoadSystem(t, resolve);
    const roads = T_ROADS();
    sys.setNetwork(roads, [NODE]);
    const rts = [...sys.runtimes];
    const j = sys.junctions[0];
    sys.setNetwork(roads, [NODE]);
    expect(sys.runtimes).toEqual(rts);
    expect(sys.runtimes.every((r, i) => r === rts[i])).toBe(true);
    expect(sys.junctions[0]).toBe(j);
  });

  it('removing a road from a T leaves a 2-arm transition; removing both leaves no junction', () => {
    const t = terrain();
    const sys = new RoadSystem(t, resolve);
    sys.setNetwork(T_ROADS().filter((r) => r.id !== 's'), [NODE]);
    expect(sys.junctions[0].arms).toHaveLength(2);
    sys.setNetwork(T_ROADS().filter((r) => r.id === 'w'), [NODE]);
    expect(sys.junctions).toHaveLength(0);
  });

  it('mesh layer: roads + patch are drawn; replaced versions stay until complete', () => {
    const t = terrain();
    const sys = new RoadSystem(t, resolve);
    const layer = new RoadMeshLayer(sys, new MaterialRegistry());
    sys.setNetwork(T_ROADS(), [NODE]);
    settleAll(sys);
    const chunks = sys.stats().chunks;
    expect(layer.meshCount).toBe(chunks + 1); // + one junction mesh
    sys.setNetwork(T_ROADS(), [{ ...NODE, radius: 10 }]);
    expect(layer.meshCount).toBeGreaterThan(chunks);   // old versions still shown
    settleAll(sys);
    expect(layer.meshCount).toBe(sys.stats().chunks + 1);
    sys.setNetwork([], []);
    expect(layer.meshCount).toBe(0);
  });
});
