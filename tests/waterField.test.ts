import { describe, it, expect } from 'vitest';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { WaterField } from '../src/water/field';
import { computeRiverHydro } from '../src/water/hydro';
import { WaterLibrary } from '../src/water/styleLibrary';
import type { LakeDef, RiverDef } from '../src/water/types';

const lib = new WaterLibrary();
const riverAt = (pts: Array<[number, number, number, object?]>, o: Partial<RiverDef> = {}): RiverDef => ({
  id: 'r', name: 'r', style: 'bach', ...o, points: pts.map(([x, y, z, e]) => ({ x, y, z, ...(e ?? {}) })),
});
const hydro = (d: RiverDef, opts = {}) => computeRiverHydro(d, lib.forRiver(d), opts);

describe('river bed and banks', () => {
  // a river running along x at z = 3000, water level 800 → 790; width 4, depth 1; bank ramp 3 m at slope 0.7
  const def = riverAt([[3000, 800, 3000, { width: 4, depth: 1 }], [3200, 790, 3000, { width: 4, depth: 1 }]]);
  const f = new WaterField([hydro(def)]);
  const levelAt = (x: number): number => 800 - (x - 3000) * 0.05;

  it('the bed lies `depth` below the water level in the middle, whatever the terrain was (cut AND fill)', () => {
    for (const base of [850, 800, 780, 700]) {
      const h = f.modify(3100, 3000, base);
      expect(h).toBeCloseTo(levelAt(3100) - 1, 1);
    }
  });

  it('the bank ramps up from the bed and only cuts: terrain below the ramp is left alone', () => {
    const hw = 2.3; // half width + margin
    const rim = f.modify(3100, 3000 + hw - 0.05, 900);
    expect(rim).toBeLessThan(levelAt(3100));
    const mid = f.modify(3100, 3000 + hw + 1.5, 900); // 1.5 m up the bank
    const far = f.modify(3100, 3000 + hw + 2.5, 900);
    expect(mid).toBeGreaterThan(rim);
    expect(far).toBeGreaterThan(mid);
    expect(f.modify(3100, 3000 + hw + 9, levelAt(3100) - 5)).toBe(levelAt(3100) - 5); // lower ground further out stays
  });

  it('a levee keeps the water in where the ground lies lower than the water', () => {
    const edge = f.modify(3100, 3000 + 2.3 + 0.6, levelAt(3100) - 3);
    expect(edge).toBeGreaterThan(levelAt(3100)); // rim above the water level
    expect(f.modify(3100, 3000 + 2.3 + 1.5, levelAt(3100) - 3)).toBeGreaterThan(levelAt(3100) - 3); // the dike falls away to the ground
    expect(f.modify(3100, 3000 + 2.3 + 7, levelAt(3100) - 3)).toBe(levelAt(3100) - 3); // beyond the dike: untouched
  });

  it('far from the river nothing changes; the bounds cover the influence', () => {
    expect(f.modify(3100, 3100, 812.5)).toBe(812.5);
    expect(f.modify(9000, 9000, 77)).toBe(77);
    const b = f.bounds!;
    expect(b.minX).toBeLessThan(3000);
    expect(b.maxX).toBeGreaterThan(3200);
    expect(b.minZ).toBeLessThan(3000 - 2);
    expect(b.maxZ).toBeGreaterThan(3000 + 2);
  });

  it('is continuous across the channel edge and symmetric around the centre line', () => {
    const ground = levelAt(3100) + 0.6; // a river drawn on ordinary ground: the terrain is about at the water level
    let prev = f.modify(3100, 2990, ground);
    for (let z = 2990.1; z <= 3010; z += 0.1) {
      const v = f.modify(3100, z, ground);
      expect(Math.abs(v - prev)).toBeLessThan(0.45); // no cliff steps (the ramp is 0.7 m per m)
      prev = v;
    }
    expect(f.modify(3100, 3000 + 1.2, ground)).toBeCloseTo(f.modify(3100, 3000 - 1.2, ground), 6);
  });

  it('waterAt tells where there is water and how deep', () => {
    const w = f.waterAt(3100, 3000)!;
    expect(w.kind).toBe('river');
    expect(w.depth).toBeCloseTo(1, 2);
    expect(w.level).toBeCloseTo(levelAt(3100), 1);
    expect(f.waterAt(3100, 3003)).toBeNull();
    expect(f.waterAt(3100, 3000 + 1.9)!.depth).toBeLessThan(0.5);
  });
});

describe('waterfalls', () => {
  const def = riverAt([[3000, 1000, 3000, { width: 8 }], [3100, 998, 3000, { width: 8, seg: 'fall' }], [3125, 600, 3000], [3300, 590, 3000]]);
  const h = hydro(def);
  const f = new WaterField([h]);

  it('digs a pool at the foot and a gorge along the sheet; the bed follows the sheet down', () => {
    // under the lip: bed just below the lip level; near the foot: bed near the foot level, far below the plateau
    const nearLip = f.modify(3101, 3000, 1000);
    const nearFoot = f.modify(3124, 3000, 1000);
    expect(nearLip).toBeGreaterThan(990);
    expect(nearFoot).toBeLessThan(620);
    // the pool: deeper than the river bed beyond it
    const pool = f.modify(3125, 3000, 700);
    const river = f.modify(3200, 3000, 700);
    expect(pool).toBeLessThan(600 - 2); // a pool of poolDepth below the level at the foot
    // gorge walls: beside the lower part the terrain is cut hundreds of metres below the plateau, and walls are steep
    const side = [3, 6, 12, 25].map((d) => f.modify(3115, 3000 + 4 + d, 1000));
    for (let i = 1; i < side.length; i++) expect(side[i]).toBeGreaterThan(side[i - 1]);
    expect(side[0]).toBeLessThan(800);
  });

  it('water at the sheet and in the pool is reported', () => {
    expect(f.waterAt(3110, 3000)?.kind).toBe('fall');
    expect(f.waterAt(3125, 3002)?.kind === 'pool' || f.waterAt(3125, 3002)?.kind === 'fall').toBe(true);
  });
});

describe('lakes', () => {
  const def: LakeDef = {
    id: 'l', name: 'See', style: 'bergsee', level: 1200, depth: 10,
    outline: [{ x: 3000, z: 3000 }, { x: 3100, z: 3000 }, { x: 3100, z: 3080 }, { x: 3000, z: 3080 }],
  };
  const style = lib.forLake(def);
  const f = new WaterField([], [{ def, style }]);

  it('is a bowl: shallow at the shore, deepest in the middle, never above the water inside', () => {
    const shore = f.modify(3001, 3040, 1300);
    const mid = f.modify(3050, 3040, 1300);
    expect(mid).toBeLessThan(shore);
    expect(mid).toBeCloseTo(1200 - 10, 0);
    expect(shore).toBeLessThanOrEqual(1200 + 1e-6);
    for (const [x, z] of [[3025, 3020], [3085, 3065], [3050, 3040]]) expect(f.modify(x, z, 1300)).toBeLessThan(1200);
    // ground lower than the bowl stays
    expect(f.modify(3050, 3040, 1100)).toBe(1100);
  });

  it('outside the shore ramps up like a bank, with a levee where the ground is below the water', () => {
    expect(f.modify(2995, 3040, 1500)).toBeGreaterThan(1200);
    expect(f.modify(2995, 3040, 1500)).toBeLessThan(1500);
    expect(f.modify(2999.7, 3040, 1100)).toBeGreaterThan(1200); // levee at the rim
    expect(f.modify(2900, 3040, 1500)).toBeGreaterThan(1200 - 1); // far outside (beyond the 8 × bank reach) it is the original terrain
    expect(f.modify(2900 - 200, 3040, 1500)).toBe(1500);
  });

  it('waterAt inside / outside, distanceToWater for tinting', () => {
    expect(f.waterAt(3050, 3040)!.kind).toBe('lake');
    expect(f.waterAt(3050, 3040)!.depth).toBeCloseTo(10, 0);
    expect(f.waterAt(2990, 3040)).toBeNull();
    expect(f.distanceToWater(3050, 3040, 50)).toBe(0);
    expect(f.distanceToWater(2990, 3040, 50)).toBeCloseTo(10, 6);
  });
});

describe('on the mock terrain', () => {
  it('a modifier + invalidate reshapes the loaded tiles; heightAt returns carved heights, baseHeightAt the original', () => {
    const t = new MockStreamTerrain({ heightFn: () => 800 });
    t.loadRectSync(0, 0, 6000, 6000, 4);
    t.loadRectSync(2900, 2900, 3300, 3100, 0);
    const def = riverAt([[3000, 800, 3000, { width: 6, depth: 2 }], [3200, 795, 3000, { width: 6, depth: 2 }]]);
    const f = new WaterField([hydro(def)]);
    expect(t.heightAt(3100, 3000)).toBe(800);
    t.modifier = (x, z, b) => f.modify(x, z, b);
    const n = t.invalidate(f.bounds!);
    expect(n).toBeGreaterThan(0);
    expect(t.heightAt(3100, 3000)).toBeCloseTo(797.5 - 2, 0);
    expect(t.baseHeightAt(3100, 3000)).toBe(800);
    expect(t.heightAt(3100, 3100)).toBe(800);
    // removing the modifier restores the ground
    t.modifier = null;
    t.invalidate();
    expect(t.heightAt(3100, 3000)).toBe(800);
  });
});
