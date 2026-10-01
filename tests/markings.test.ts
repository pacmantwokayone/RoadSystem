import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadRuntime, DEFAULT_RUNTIME_OPTIONS } from '../src/runtime/roadRuntime';
import { buildChunkGeometry, ringSection } from '../src/mesh/extrude';
import { buildChunkMarkings, dashIntervals, expandMarking } from '../src/mesh/markings';
import { ProfileLibrary } from '../src/profile/library';
import { PRESET_SOURCES } from '../src/profile/presets';
import { profileApi } from '../src/profile/builder';
import { profileHeightAt } from '../src/profile/types';
import { resolveParams } from '../src/profile/compile';
import type { RoadDef } from '../src/network/types';
import type { MarkingDef } from '../src/profile/types';

const R = profileApi;
const lib = new ProfileLibrary();

function terrain(): MockStreamTerrain {
  const t = new MockStreamTerrain();
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2800, 2800, 3800, 3400, 0);
  return t;
}
const line: Array<[number, number]> = [[3000, 3000], [3150, 3040], [3300, 3010], [3450, 3100], [3600, 3140]];
function build(profile: string) {
  const def: RoadDef = { id: 'm', name: 'm', profile, points: line.map(([x, z]) => ({ x, y: 0, z })) };
  const rt = new RoadRuntime(def, terrain(), lib.resolve(profile), DEFAULT_RUNTIME_OPTIONS);
  rt.chunks.forEach((c) => rt.tryBuildChunk(c));
  return rt;
}

describe('marking DSL', () => {
  it('centre line, edge lines (mirrored to both sides) and absolute marks', () => {
    const p = R.profile('t')
      .both((h) => h.surface(3, 'a').edgeLine({ back: 0.2, style: 'solid' }).surface(1, 'b'))
      .markCenter({ dash: 3, gap: 9 })
      .mark(1.5, { color: 'yellow', style: 'double' })
      .finish();
    const xs = p.markings.map((m) => m.x).sort((a, b) => a - b);
    expect(xs).toEqual([-2.8, 0, 1.5, 2.8]);
    expect(p.markings.find((m) => m.x === 0)).toMatchObject({ style: 'dashed', dash: 3, gap: 9, color: 'white' });
    expect(p.markings.find((m) => m.x === 1.5)).toMatchObject({ style: 'double', color: 'yellow' });
  });

  it('a negative `back` places the line inside from the start of a half profile (e.g. next to a median)', () => {
    const p = R.profile('t').center(1, 'c').both((h) => h.edgeLine({ back: -0.25 }).surface(3, 'a')).finish();
    expect(p.markings.map((m) => m.x).sort((a, b) => a - b)).toEqual([-0.75, 0.75]);
  });

  it('dashed-solid mirrors its dashed side with the half profile', () => {
    const p = R.profile('t').both((h) => h.surface(3, 'a').edgeLine({ back: 0, style: 'dashed-solid', dashedSide: 'right' })).finish();
    expect(p.markings.find((m) => m.x > 0)!.dashedSide).toBe('right');
    expect(p.markings.find((m) => m.x < 0)!.dashedSide).toBe('left');
  });

  it('a raised centre strip lifts the starting height of both halves', () => {
    const p = R.profile('t').center(0.6, 'c', { y: 0.8 }).both((h) => h.step(-0.8, 'c').surface(3, 'a')).finish();
    expect(p.points.map((q) => q.y)).toEqual([0, 0, 0.8, 0.8, 0, 0]);
  });
});

describe('dash pattern', () => {
  it('starts with a dash at s = 0 and repeats with the period', () => {
    expect(dashIntervals(0, 30, 3, 9)).toEqual([[0, 3], [12, 15], [24, 27]]);
  });

  it('is continuous across chunk borders: pieces of consecutive ranges merge into the whole pattern', () => {
    const whole = dashIntervals(0, 100, 3, 9);
    const parts = [...dashIntervals(0, 13.5, 3, 9), ...dashIntervals(13.5, 61, 3, 9), ...dashIntervals(61, 100, 3, 9)];
    // merge touching pieces
    const merged: Array<[number, number]> = [];
    for (const [a, b] of parts) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last[1] - a) < 1e-9) last[1] = b; else merged.push([a, b]);
    }
    expect(merged.length).toBe(whole.length);
    merged.forEach((m, i) => { expect(m[0]).toBeCloseTo(whole[i][0], 9); expect(m[1]).toBeCloseTo(whole[i][1], 9); });
  });

  it('drops slivers and survives degenerate input', () => {
    expect(dashIntervals(2.99, 3.0, 3, 9)).toEqual([]);
    expect(dashIntervals(0, 10, 0, 9)).toEqual([]);
  });
});

describe('expandMarking', () => {
  const base: MarkingDef = { x: 1, width: 0.12, style: 'solid', color: 'white', dash: 3, gap: 9, spacing: 0.3, dashedSide: 'right' };
  it('double → two solid ribbons on either side; dashed-solid → exactly one dashed', () => {
    const d = expandMarking({ ...base, style: 'double' });
    expect(d.map((r) => r.x)).toEqual([0.85, 1.15]);
    expect(d.every((r) => !r.dashed)).toBe(true);
    const ds = expandMarking({ ...base, style: 'dashed-solid', dashedSide: 'left' });
    expect(ds.filter((r) => r.dashed)).toHaveLength(1);
    expect(ds.find((r) => r.dashed)!.x).toBeLessThan(1);
  });
});

describe('marking geometry', () => {
  it('ribbons lie just above the extruded road surface, face up and have the right width', () => {
    const rt = build('hauptstrasse');
    const marks = buildChunkMarkings(rt, rt.chunks[1])!;
    expect(marks).not.toBeNull();
    expect(marks.materials).toEqual(['marking_white']);
    const pos = marks.geometry.getAttribute('position');
    const nrm = marks.geometry.getAttribute('normal');
    const idx = marks.geometry.getIndex()!;
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3();
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t)); b.fromBufferAttribute(pos, idx.getX(t + 1)); c.fromBufferAttribute(pos, idx.getX(t + 2));
      n.subVectors(b, a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-12) continue;
      expect(n.y).toBeGreaterThan(0);
      const sn = new Vector3().fromBufferAttribute(nrm, idx.getX(t));
      expect(n.dot(sn)).toBeGreaterThan(0);
    }
    // vertices come in (left, right) pairs of one ribbon width
    for (let v = 0; v < pos.count; v += 2) {
      const l = new Vector3().fromBufferAttribute(pos, v), r = new Vector3().fromBufferAttribute(pos, v + 1);
      expect(l.distanceTo(r)).toBeCloseTo(0.12, 1);
    }
  });

  it('every marking vertex sits ~3 cm above the surface of the extruded cross-section (shared ringSection)', () => {
    const rt = build('hauptstrasse');
    const chunk = rt.chunks[0];
    const roadPos = buildChunkGeometry(rt, chunk).geometry.getAttribute('position');
    const S = rt.profile.points.length - 1;
    const V = S * 2 + 6;
    const marks = buildChunkMarkings(rt, chunk)!;
    const mp = marks.geometry.getAttribute('position');
    // first ring of the chunk: compare against top-surface vertices of that ring
    const ringVerts: Vector3[] = [];
    for (let v = 0; v < V; v++) ringVerts.push(new Vector3().fromBufferAttribute(roadPos, v));
    const sec = ringSection(rt, chunk.i0);
    // ringSection must reproduce the extruded vertices exactly
    rt.profile.points.forEach((pt, k) => {
      const w = sec.surface(pt.x);
      expect(Math.min(...ringVerts.map((rv) => rv.distanceTo(w)))).toBeLessThan(1e-3); // extruded vertices are float32
      void k;
    });
    // marking vertices exactly at the chunk start (uv.y = s) must be where the shared ring section puts the ribbon edges, lifted 3 cm
    const uv = marks.geometry.getAttribute('uv');
    const s0 = rt.samples[chunk.i0].s;
    const expected: Vector3[] = [];
    for (const rb of rt.profile.markings.flatMap(expandMarking)) {
      if (rb.dashed && !dashIntervals(s0, s0 + 1, rb.dash, rb.gap).some(([a]) => Math.abs(a - s0) < 1e-6)) continue;
      const y = profileHeightAt(rt.profile, rb.x);
      for (const side of [-1, 1]) {
        const p = sec.at(sec.mapX(rb.x) + (side * rb.width) / 2, y);
        expected.push(p.addScaledVector(sec.frame.up, 0.03));
      }
    }
    let checked = 0;
    for (let v = 0; v < mp.count; v++) {
      if (Math.abs(uv.getY(v) - s0) > 1e-6) continue;
      const m = new Vector3().fromBufferAttribute(mp, v);
      expect(Math.min(...expected.map((e) => e.distanceTo(m)))).toBeLessThan(2e-3);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(6); // centre + two edge lines, two vertices each
  });

  it('yellow no-overtaking line becomes a double yellow ribbon pair; roads without markings produce none', () => {
    const lib2 = new ProfileLibrary();
    const def: RoadDef = { id: 'k', name: 'k', profile: 'kantonsstrasse', params: { noOvertaking: true }, points: line.map(([x, z]) => ({ x, y: 0, z })) };
    const rt = new RoadRuntime(def, terrain(), lib2.resolve('kantonsstrasse', { noOvertaking: true }), DEFAULT_RUNTIME_OPTIONS);
    rt.chunks.forEach((c) => rt.tryBuildChunk(c));
    const m = buildChunkMarkings(rt, rt.chunks[1])!;
    expect(m.materials).toContain('marking_yellow');
    expect(m.materials).toContain('marking_white');
    const rt2 = build('wanderweg');
    expect(buildChunkMarkings(rt2, rt2.chunks[0])).toBeNull();
  });

  it('dashed ribbons produce gaps: far fewer vertices than a solid line over the same chunk', () => {
    const rt = build('hauptstrasse');
    const c = rt.chunks[1];
    const dashed = buildChunkMarkings(rt, c)!.geometry.getAttribute('position').count;
    const solidProfile = R.profile('s').both((h) => h.surface(3, 'asphalt')).mark(0, { style: 'solid' }).mark(2.8, { style: 'solid' }).mark(-2.8, { style: 'solid' }).finish();
    const rtSolid = new RoadRuntime({ ...rt.def }, terrain(), solidProfile, DEFAULT_RUNTIME_OPTIONS);
    rtSolid.chunks.forEach((ch) => rtSolid.tryBuildChunk(ch));
    const solid = buildChunkMarkings(rtSolid, rtSolid.chunks[1])!.geometry.getAttribute('position').count;
    expect(solid).toBeGreaterThan(dashed);
  });
});

describe('presets', () => {
  const names = Object.keys(PRESET_SOURCES);

  it('ships the whole Swiss hierarchy from Trampelpfad to Autobahn', () => {
    for (const n of ['trampelpfad', 'wanderweg', 'waldweg', 'fussweg', 'radweg', 'holzsteg', 'flurstrasse', 'schotterpiste', 'waldstrasse', 'alpstrasse', 'gemeindestrasse', 'dorfstrasse', 'quartierstrasse', 'nebenstrasse', 'hauptstrasse', 'kantonsstrasse', 'autostrasse', 'autobahn', 'auffahrt']) {
      expect(names).toContain(n);
    }
  });

  it('every preset evaluates at its default, minimum and maximum parameters to a valid, ordered cross-section', () => {
    const lib3 = new ProfileLibrary();
    for (const name of names) {
      const schema = lib3.getSchema(name);
      const variants: Array<Record<string, number | boolean | string>> = [{}, {}, {}];
      for (const [k, d] of Object.entries(schema)) {
        if (d.type === 'float' || d.type === 'int') { variants[1][k] = d.min!; variants[2][k] = d.max!; }
        if (d.type === 'bool') { variants[1][k] = !d.default; variants[2][k] = d.default; }
      }
      for (const v of variants) {
        const p = lib3.resolve(name, v);
        expect(p.segments.length, name).toBe(p.points.length - 1);
        expect(p.coreHalfWidth, name).toBeGreaterThan(0.1);
        expect(p.outerHalfWidth, name).toBeGreaterThanOrEqual(p.coreHalfWidth);
        for (let i = 1; i < p.points.length; i++) expect(p.points[i].x, name).toBeGreaterThanOrEqual(p.points[i - 1].x - 1e-9);
        for (const m of p.markings) {
          expect(Math.abs(m.x), name).toBeLessThanOrEqual(p.outerHalfWidth + 1e-9);
          expect(m.width).toBeGreaterThan(0);
        }
        void resolveParams;
      }
    }
  });

  it('roads carry the markings Swiss road users expect', () => {
    const lib3 = new ProfileLibrary();
    const h = lib3.resolve('hauptstrasse');
    expect(h.markings.filter((m) => m.style === 'dashed' && m.x === 0)).toHaveLength(1);   // Leitlinie
    expect(h.markings.filter((m) => m.style === 'solid' && Math.abs(m.x) > 2)).toHaveLength(2); // Randlinien
    const a = lib3.resolve('autobahn');
    expect(a.markings.filter((m) => m.style === 'dashed').length).toBe(2); // Fahrstreifenwechsel je Richtung
    expect(a.markings.some((m) => m.width >= 0.2)).toBe(true);              // breite Randlinie
    expect(a.points.some((q) => q.y >= 0.79)).toBe(true);                   // Betonleitwand in der Mitte
    expect(a.coreHalfWidth).toBeGreaterThan(h.coreHalfWidth * 1.5);         // breiter als eine Landstrasse
    expect(lib3.resolve('wanderweg').markings).toHaveLength(0);
    expect(lib3.resolve('kantonsstrasse', { noOvertaking: true }).markings.some((m) => m.color === 'yellow')).toBe(true);
  });

  it('autobahn: lane count changes the width; the barrier is not part of the carriageway footprint', () => {
    const lib3 = new ProfileLibrary();
    const two = lib3.resolve('autobahn', { lanes: 2 });
    const three = lib3.resolve('autobahn', { lanes: 3 });
    expect(three.outerHalfWidth - two.outerHalfWidth).toBeCloseTo(3.75, 5);
    // core excludes the barrier strips, so the footprint is lanes + shoulder beyond the median
    expect(two.coreHalfWidth).toBeCloseTo(0.5 + 2 * 3.75 + 3.0, 5);
  });
});
