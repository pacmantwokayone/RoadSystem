import { describe, it, expect } from 'vitest';
import { autoLevel, autoLevelRiver } from '../src/water/autolevel';
import { segmentOutlineCrossing, trimAtLake, pointInOutline } from '../src/water/outline';
import { waterDemoHeight, waterDemoWaters } from '../src/water/demoScene';
import { computeRiverHydro } from '../src/water/hydro';
import { WaterLibrary } from '../src/water/styleLibrary';
import { normalizeWaters } from '../src/water/types';

const square = [{ x: 100, z: 100 }, { x: 200, z: 100 }, { x: 200, z: 200 }, { x: 100, z: 200 }];

describe('autoLevel', () => {
  const pts = (l: Array<[number, number, number?]>) => l.map(([x, z, y]) => ({ x, y: y ?? 0, z }));

  it('follows the ground below it and never rises', () => {
    const ground = (x: number) => 100 + 10 * Math.sin(x / 40);
    const out = autoLevel(pts([[0, 0], [30, 0], [60, 0], [90, 0], [120, 0], [150, 0]]), ground, { below: 0.5 });
    for (let i = 1; i < out.length; i++) expect(out[i].y).toBeLessThanOrEqual(out[i - 1].y);
    out.forEach((p, i) => expect(p.y).toBeLessThanOrEqual(ground(pts([[0, 0], [30, 0], [60, 0], [90, 0], [120, 0], [150, 0]])[i].x) - 0.5 + 1e-9));
  });

  it('a waterfall drops at least minFallDrop even on flat ground, and bigger when the ground does', () => {
    const flat = autoLevel([{ x: 0, y: 0, z: 0, seg: 'fall' }, { x: 20, y: 0, z: 0 }], () => 500, { minFallDrop: 4 });
    expect(flat[0].y - flat[1].y).toBeGreaterThanOrEqual(4 - 1e-9);
    const cliff = autoLevel([{ x: 0, y: 0, z: 0, seg: 'fall' }, { x: 20, y: 0, z: 0 }], (x) => (x < 10 ? 1000 : 600));
    expect(cliff[0].y - cliff[1].y).toBeGreaterThan(390);
  });

  it('takes the level of lakes at its ends', () => {
    const lakes = [{ id: 'a', name: 'a', style: 'bergsee', level: 900, depth: 5, outline: square }, { id: 'b', name: 'b', style: 'weiher', level: 700, depth: 5, outline: square }];
    const r = autoLevelRiver({ id: 'r', name: 'r', style: 'bach', startLake: 'a', endLake: 'b', points: pts([[0, 0], [50, 0], [100, 0]]) }, () => 800, lakes);
    expect(r.points[0].y).toBe(900);
    expect(r.points[2].y).toBe(700);
  });
});

describe('lake trimming', () => {
  it('finds where a segment crosses the outline', () => {
    const c = segmentOutlineCrossing(50, 150, 150, 150, square)!;
    expect(c.x).toBeCloseTo(100, 6);
    expect(c.z).toBeCloseTo(150, 6);
    expect(segmentOutlineCrossing(0, 0, 50, 0, square)).toBeNull();
  });

  it('a river that runs into the lake ends on the shore, one that leaves it starts there', () => {
    const mk = (x: number, z: number, from: { x: number; z: number }) => ({ ...from, x, z });
    const into = trimAtLake([{ x: 20, z: 150 }, { x: 80, z: 150 }, { x: 150, z: 150 }], square, 'end', mk);
    expect(into).toHaveLength(3);
    expect(into[2].x).toBeCloseTo(100, 6);
    expect(pointInOutline(into[1].x, into[1].z, square)).toBe(false);
    const out = trimAtLake([{ x: 150, z: 150 }, { x: 180, z: 150 }, { x: 250, z: 150 }, { x: 320, z: 150 }], square, 'start', mk);
    expect(out[0].x).toBeCloseTo(200, 6);
    expect(out).toHaveLength(3);
    // nothing inside: unchanged
    expect(trimAtLake([{ x: 0, z: 0 }, { x: 50, z: 0 }], square, 'end', mk)).toHaveLength(2);
  });
});

describe('demo scene', () => {
  const w = waterDemoWaters();
  const lib = new WaterLibrary();

  it('has the three rivers and two lakes, all valid', () => {
    expect(w.rivers.map((r) => r.id)).toEqual(['bergbach', 'talfluss', 'seitenbach']);
    expect(w.lakes).toHaveLength(2);
    const n = normalizeWaters(w.rivers, w.lakes);
    expect(n.rivers).toHaveLength(3);
    expect(n.lakes).toHaveLength(2);
  });

  it('the mountain stream drops a waterfall of several hundred metres into the valley', () => {
    const r = w.rivers[0];
    const h = computeRiverHydro(r, lib.forRiver(r), { startLevel: w.lakes[0].level });
    expect(h.falls).toHaveLength(1);
    expect(h.falls[0].height).toBeGreaterThan(300);
    // the pool sits on the valley floor
    expect(Math.abs(h.falls[0].foot.y - waterDemoHeight(h.falls[0].foot.x, -h.falls[0].foot.z))).toBeLessThan(3);
  });

  it('the valley river has a small fall and rapids, and ends in the lower lake', () => {
    const r = w.rivers[1];
    const h = computeRiverHydro(r, lib.forRiver(r), { endLevel: w.lakes[1].level });
    expect(h.falls.length).toBe(1);
    expect(h.falls[0].height).toBeLessThan(10);
    expect(h.samples.some((s) => s.kind === 'rapids')).toBe(true);
    expect(h.samples[h.samples.length - 1].level).toBeCloseTo(w.lakes[1].level, 0);
  });
});
