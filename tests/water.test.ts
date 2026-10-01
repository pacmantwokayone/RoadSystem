import { describe, it, expect } from 'vitest';
import { RoadModel } from '../src/editor/model';
import { sanitizeRoadsDocument } from '../src/network/doc';
import { cloneRiver, normalizeWaters, sanitizeLake, sanitizeRiver, sanitizeWaters, type LakeDef, type RiverDef } from '../src/water/types';
import { WaterLibrary } from '../src/water/styleLibrary';
import { waterApi, WaterBuilder } from '../src/water/style';
import { computeRiverHydro, monotoneLevels, pchip, MIN_SLOPE } from '../src/water/hydro';

const lib = new WaterLibrary();
const riverAt = (pts: Array<[number, number, number, Partial<RiverDef['points'][0]>?]>, extra: Partial<RiverDef> = {}): RiverDef => ({
  id: 'r', name: 'r', style: 'bach', ...extra,
  points: pts.map(([x, y, z, o]) => ({ x, y, z, ...(o ?? {}) })),
});

describe('water data', () => {
  it('sanitizes rivers: clamps, drops garbage, keeps non-default segment kinds only', () => {
    const r = sanitizeRiver({ id: 'a', points: [{ x: 0, y: 10, z: 0, width: 9999, depth: -1, seg: 'fall' }, { x: 5, y: 5, z: 0, seg: 'river' }, { x: 'x' }, null], style: 7 }, 'f')!;
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toEqual({ x: 0, y: 10, z: 0, width: 400, depth: 0.05, seg: 'fall' });
    expect(r.points[1].seg).toBeUndefined();
    expect(r.style).toBe('bach');
    expect(sanitizeRiver({ id: 'a', points: [{ x: 0, y: 0, z: 0 }] }, 'f')).toBeNull();
  });

  it('sanitizes lakes: needs a level and three outline points', () => {
    const l = sanitizeLake({ id: 'l', level: 1200, depth: 9999, outline: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 8 }, { x: 'bad' }] }, 'f')!;
    expect(l.outline).toHaveLength(3);
    expect(l.depth).toBe(300);
    expect(sanitizeLake({ id: 'l', outline: [{ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 0 }] }, 'f')).toBeNull();
    expect(sanitizeLake({ id: 'l', level: 1, outline: [{ x: 0, z: 0 }, { x: 1, z: 1 }] }, 'f')).toBeNull();
  });

  it('unique ids; links to missing lakes / rivers are dropped, valid ones kept', () => {
    const lake = { id: 'l1', level: 100, outline: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 8 }] };
    const pts = [{ x: 0, y: 5, z: 0 }, { x: 5, y: 4, z: 0 }];
    const { rivers, lakes } = sanitizeWaters(
      [{ id: 'a', points: pts, endLake: 'l1', startLake: 'gone', endRiver: 'a' }, { id: 'a', points: pts, endRiver: 'a_' }],
      [lake, lake],
    );
    expect(lakes.map((l) => l.id)).toEqual(['l1', 'l1_']);
    expect(rivers.map((r) => r.id)).toEqual(['a', 'a_']);
    expect(rivers[0].endLake).toBe('l1');
    expect(rivers[0].startLake).toBeUndefined();
    expect(rivers[0].endRiver).toBeUndefined(); // a river can't join itself
    expect(rivers[1].endRiver).toBe('a_'.length ? undefined : 'x'); // 'a_' is itself, so it is dropped too
  });

  it('normalizeWaters keeps object identity of untouched rivers', () => {
    const r = riverAt([[0, 10, 0], [10, 9, 0]]);
    const out = normalizeWaters([r], []);
    expect(out.rivers[0]).toBe(r);
    const c = cloneRiver(r);
    c.endLake = 'missing';
    expect(normalizeWaters([c], []).rivers[0].endLake).toBeUndefined();
  });

  it('the document round-trips rivers and lakes through the model, with one undo step per edit', () => {
    const model = new RoadModel();
    const river = riverAt([[3000, 900, 3000], [3100, 880, 3000]]);
    const lake: LakeDef = { id: 'l', name: 'See', style: 'bergsee', level: 1000, depth: 8, outline: [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 20, z: 30 }] };
    model.load({ version: 1, roads: [] });
    model.addRiver(river);
    model.addLake(lake);
    expect(model.riverList).toHaveLength(1);
    expect(model.lakeList).toHaveLength(1);
    const events: string[] = [];
    model.onChange((e) => events.push(e.type));
    model.editRiver('r', 'Breite', (d) => { d.points[0].width = 7; });
    expect(events).toContain('water');
    expect(model.getRiver('r')!.points[0].width).toBe(7);
    model.undo();
    expect(model.getRiver('r')!.points[0].width).toBeUndefined();
    model.redo();
    const doc = JSON.parse(JSON.stringify(model.toDocument()));
    expect(doc.rivers[0].points[0].width).toBe(7);
    expect(doc.lakes[0].level).toBe(1000);
    const again = new RoadModel();
    again.load(sanitizeRoadsDocument(doc));
    expect(again.riverList[0].points[0].width).toBe(7);
    expect(again.lakeList[0].outline).toHaveLength(3);
  });

  it('a river with fewer than two points or a lake with fewer than three vanishes from the model', () => {
    const model = new RoadModel();
    model.load({ version: 1, roads: [] });
    model.addRiver(riverAt([[0, 0, 0], [1, 0, 0]]));
    model.transact('cut', (d) => d.editRiver('r', (r) => { r.points = r.points.slice(0, 1); }));
    expect(model.riverList).toHaveLength(0);
  });
});

describe('water styles as code', () => {
  it('all presets compile; rivers and lakes are told apart', () => {
    expect(lib.names().sort()).toEqual(['bach', 'bergsee', 'fluss', 'gletschersee', 'strom', 'weiher', 'wildbach']);
    expect(lib.namesOf('river').sort()).toEqual(['bach', 'fluss', 'strom', 'wildbach']);
    expect(lib.namesOf('lake').sort()).toEqual(['bergsee', 'gletschersee', 'weiher']);
    expect(lib.resolve('wildbach').flow.speed).toBeGreaterThan(lib.resolve('fluss').flow.speed);
    expect(lib.resolve('strom').width).toBeGreaterThan(lib.resolve('bach').width * 5);
    expect(lib.resolve('bach', { width: 5 }).width).toBe(5);
  });

  it('values are clamped; a failing edit keeps the last good version', () => {
    const s = waterApi.river('x').size(1e9, -4).flow({ speed: -3, ripple: 7 }).rocks({ min: 5, max: 1 }).colors({ deep: NaN as never }).finish();
    expect(s.width).toBe(300);
    expect(s.depth).toBe(0.1);
    expect(s.flow.speed).toBe(0);
    expect(s.flow.ripple).toBe(1);
    expect(s.rocks.max).toBeGreaterThanOrEqual(s.rocks.min);
    expect(Number.isFinite(s.colors.deep)).toBe(true);
    const l = new WaterLibrary();
    const before = l.resolve('bach');
    expect(l.setSource('bach', 'export default (p, W) => { throw new Error("boom"); }').ok).toBe(false);
    expect(l.resolve('bach')).toBe(before);
    expect(l.setSource('bach', 'export default (p, W) => 3').ok).toBe(false);
    expect(l.setSource('bach', "export default (p, W) => W.river('b').size(9, 1)").ok).toBe(true);
    expect(l.resolve('bach').width).toBe(9);
    expect(new WaterBuilder('q', 'lake').finish().kind).toBe('lake');
  });

  it('styles are chosen per river / lake, unknown names fall back, identity is stable', () => {
    const r = riverAt([[0, 0, 0], [1, 0, 0]], { style: 'fluss' });
    expect(lib.forRiver(r)).toBe(lib.forRiver(r));
    expect(lib.forRiver({ ...r, style: 'gibt-es-nicht' }).name).toBe('Bach');
    expect(lib.forLake({ id: 'l', name: 'l', style: 'weiher', level: 0, depth: 3, outline: [] }).name).toBe('Weiher');
    expect(lib.forLake({ id: 'l', name: 'l', style: '???', level: 0, depth: 3, outline: [] }).name).toBe('Bergsee');
  });
});

describe('levels', () => {
  it('never rise downstream and fall at least a little per metre', () => {
    const lv = monotoneLevels([100, 99, 103, 98, 98, 90], [50, 50, 50, 50, 50]);
    for (let i = 1; i < lv.length; i++) expect(lv[i]).toBeLessThanOrEqual(lv[i - 1] - MIN_SLOPE * 50 + 1e-9);
    expect(lv[0]).toBe(100);
  });

  it('a lake clamps the ends: the river leaves at the lake level and never ends below the lake it enters', () => {
    const lv = monotoneLevels([100, 95, 90, 85], [10, 10, 10], { startLevel: 98, endLevel: 92 });
    expect(lv[0]).toBe(98);
    expect(Math.min(...lv)).toBeGreaterThanOrEqual(92);
    for (let i = 1; i < lv.length; i++) expect(lv[i]).toBeLessThanOrEqual(lv[i - 1]);
  });

  it('pchip never overshoots monotone data and passes through the points', () => {
    const xs = [0, 10, 11, 40, 100], ys = [100, 99, 60, 59, 20];
    const f = pchip(xs, ys);
    xs.forEach((x, i) => expect(f(x)).toBeCloseTo(ys[i], 9));
    let prev = Infinity;
    for (let x = 0; x <= 100; x += 0.25) { const v = f(x); expect(v).toBeLessThanOrEqual(prev + 1e-9); expect(v).toBeLessThanOrEqual(100 + 1e-9); expect(v).toBeGreaterThanOrEqual(20 - 1e-9); prev = v; }
  });
});

describe('river hydrology', () => {
  const style = lib.resolve('bach');
  const straight = riverAt([[3000, 900, 3000], [3100, 897, 3000], [3250, 890, 3000], [3400, 889, 3000]]);

  it('samples run along the river with a monotone level, constant direction on a straight reach', () => {
    const h = computeRiverHydro(straight, style);
    expect(h.samples.length).toBeGreaterThan(100);
    for (let i = 1; i < h.samples.length; i++) {
      expect(h.samples[i].s).toBeGreaterThan(h.samples[i - 1].s);
      expect(h.samples[i].level).toBeLessThanOrEqual(h.samples[i - 1].level + 1e-9);
    }
    expect(h.length).toBeCloseTo(400, 0);
    for (const s of h.samples) { expect(s.tangent.x).toBeCloseTo(1, 6); expect(s.right.z).toBeCloseTo(1, 6); } // heading +x; right = tangent × up = +z (THREE)
    expect(h.samples[0].level).toBeCloseTo(900, 6);
    expect(h.samples[h.samples.length - 1].level).toBeCloseTo(889, 6);
  });

  it('width and depth interpolate between points; defaults come from the style', () => {
    const r = riverAt([[3000, 900, 3000, { width: 2, depth: 0.3 }], [3200, 890, 3000, { width: 10, depth: 1.5 }]]);
    const h = computeRiverHydro(r, style);
    expect(h.samples[0].width).toBeCloseTo(2, 6);
    expect(h.samples[h.samples.length - 1].width).toBeCloseTo(10, 6);
    const mid = h.samples[Math.floor(h.samples.length / 2)];
    expect(mid.width).toBeGreaterThan(5);
    expect(mid.width).toBeLessThan(7);
    expect(computeRiverHydro(straight, style).samples[3].width).toBe(style.width);
  });

  it('steeper reaches flow faster and are more turbulent; rapids more so', () => {
    const gentle = computeRiverHydro(riverAt([[3000, 900, 3000], [3400, 898, 3000]]), style).samples[40];
    const steep = computeRiverHydro(riverAt([[3000, 900, 3000], [3400, 850, 3000]]), style).samples[40];
    const rapids = computeRiverHydro(riverAt([[3000, 900, 3000, { seg: 'rapids' }], [3400, 850, 3000]]), style).samples[40];
    expect(steep.speed).toBeGreaterThan(gentle.speed * 1.5);
    expect(steep.turbulence).toBeGreaterThan(gentle.turbulence);
    expect(rapids.turbulence).toBeGreaterThan(steep.turbulence);
  });

  it('a waterfall leaves the lip horizontally, lands on the foot, falls the whole height and widens', () => {
    const r = riverAt([[3000, 1000, 3000], [3100, 998, 3000, { seg: 'fall', width: 6 }], [3120, 600, 3000], [3300, 590, 3000]]);
    const h = computeRiverHydro(r, style);
    expect(h.falls).toHaveLength(1);
    const f = h.falls[0];
    expect(f.height).toBeCloseTo(398, 3);
    expect(f.run).toBeCloseTo(20, 3);
    const nappe = h.samples.slice(f.i0, f.i1 + 1);
    expect(nappe[0].pos.y).toBeCloseTo(998, 3);
    expect(nappe[nappe.length - 1].pos.y).toBeCloseTo(600, 3);
    expect(nappe[nappe.length - 1].pos.x).toBeCloseTo(3120, 3);
    expect(Math.abs(nappe[0].tangent.y)).toBeLessThan(1e-9);     // leaves the lip horizontally
    expect(nappe[nappe.length - 1].tangent.y).toBeLessThan(-0.97); // lands (nearly) vertically
    for (let i = 1; i < nappe.length; i++) expect(nappe[i].pos.y).toBeLessThan(nappe[i - 1].pos.y);
    expect(nappe[nappe.length - 1].width).toBeGreaterThan(nappe[0].width * 1.3);
    expect(nappe.every((s) => s.kind === 'fall')).toBe(true);
    expect(h.length).toBeGreaterThan(400); // the 3-D length of the fall counts
    // water leaves the foot at the foot's level and keeps flowing down
    const after = h.samples[f.i1 + 5];
    expect(after.kind).toBe('river');
    expect(after.level).toBeLessThanOrEqual(600 + 1e-6);
  });

  it('a "fall" of less than a metre is only rapids; a vertical fall (foot right below the lip) still works', () => {
    const small = computeRiverHydro(riverAt([[3000, 100, 3000, { seg: 'fall' }], [3010, 99.5, 3000], [3100, 90, 3000]]), style);
    expect(small.falls).toHaveLength(0);
    expect(small.kinds[0]).toBe('rapids');
    const vertical = computeRiverHydro(riverAt([[3000, 200, 3000], [3050, 200, 3000, { seg: 'fall' }], [3050, 120, 3000], [3150, 110, 3000]]), style);
    expect(vertical.falls).toHaveLength(1);
    for (const s of vertical.samples) { expect(Number.isFinite(s.pos.x + s.pos.y + s.pos.z)).toBe(true); expect(s.tangent.length()).toBeCloseTo(1, 6); }
  });

  it('lakes pin the levels at the ends', () => {
    const h = computeRiverHydro(straight, style, { startLevel: 905, endLevel: 893 });
    expect(h.samples[0].level).toBeCloseTo(905, 6);
    expect(h.samples[h.samples.length - 1].level).toBeGreaterThanOrEqual(893 - 1e-6);
  });

  it('a river that is authored uphill still flows downhill', () => {
    const h = computeRiverHydro(riverAt([[3000, 800, 3000], [3100, 850, 3000], [3200, 780, 3000]]), style);
    for (let i = 1; i < h.samples.length; i++) expect(h.samples[i].level).toBeLessThanOrEqual(h.samples[i - 1].level + 1e-9);
    expect(h.levels[1]).toBeLessThan(800);
  });
});
