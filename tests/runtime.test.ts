import { describe, it, expect } from 'vitest';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { RoadRuntime, DEFAULT_RUNTIME_OPTIONS } from '../src/runtime/roadRuntime';
import type { RoadDef } from '../src/network/types';

const mkRoad = (pts: Array<[number, number, number]>, extra: Record<number, object> = {}): RoadDef => ({
  id: 'r1',
  name: 'Test',
  profile: 'x',
  points: pts.map(([x, y, z], i) => ({ x, y, z, ...(extra[i] ?? {}) })),
});

// a 600 m road through the middle of the mock terrain
const line: Array<[number, number, number]> = [
  [3000, 0, 3000], [3150, 0, 3040], [3300, 0, 3010], [3450, 0, 3100], [3600, 0, 3140],
];

/** Coarse everywhere + the finest tiles around the test road (full-pyramid loads are slow). */
function settleAround(t: MockStreamTerrain): void {
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2800, 2800, 3800, 3400, 0);
}

describe('MockStreamTerrain streaming semantics', () => {
  it('heightAt is null before anything is loaded and isSettledAt is false', () => {
    const t = new MockStreamTerrain();
    expect(t.heightAt(3000, 3000)).toBeNull();
    expect(t.isSettledAt(3000, 3000)).toBe(false);
  });

  it('returns a coarse fallback height that differs from the final one, and is not settled', () => {
    const t = new MockStreamTerrain();
    t.loadRectSync(3000, 3000, 3000, 3000, 4); // only the coarsest tile
    const coarse = t.heightAt(3000.7, 3000.3)!;
    expect(coarse).not.toBeNull();
    expect(t.isSettledAt(3000.7, 3000.3)).toBe(false);
    t.loadRectSync(3000, 3000, 3001, 3001, 0);
    expect(t.isSettledAt(3000.7, 3000.3)).toBe(true);
    const fine = t.heightAt(3000.7, 3000.3)!;
    expect(Math.abs(fine - coarse)).toBeGreaterThan(0.05); // this is the "floating" the settle check prevents
    expect(Math.abs(fine - t.heightFn(3000.7, 3000.3))).toBeLessThan(1.5);
  });

  it('streams nearest-first via update() and eventually settles around the player', () => {
    const t = new MockStreamTerrain({ loadLatencyFrames: 2 });
    for (let i = 0; i < 400; i++) t.update(3000, 3000);
    expect(t.isSettledAt(3000, 3000)).toBe(true);
    expect(t.isSettledAt(100, 100)).toBe(false); // far away: only coarse tiles requested
  });

  it('subtracts the carve hook like StreamTerrain.carveAt()', () => {
    const t = new MockStreamTerrain();
    settleAround(t);
    const before = t.heightAt(1000, 1000)!;
    t.carve = () => 2;
    expect(t.heightAt(1000, 1000)).toBeCloseTo(before - 2, 9);
  });
});

describe('RoadRuntime / RoadSystem settle-before-build', () => {
  it('builds nothing while the terrain has not settled, even with coarse fallback available', () => {
    const t = new MockStreamTerrain();
    t.loadRectSync(0, 0, 6000, 6000, 4); // coarse only
    const sys = new RoadSystem(t);
    sys.setRoads([mkRoad(line)]);
    expect(sys.resync({ checks: 1000, builds: 1000 })).toBe(0);
    expect(sys.stats().ready).toBe(0);
  });

  it('builds all chunks once settled and design height follows the terrain', () => {
    const t = new MockStreamTerrain();
    settleAround(t);
    const sys = new RoadSystem(t);
    sys.setRoads([mkRoad(line)]);
    const seen: number[] = [];
    sys.onChunkReady((_r, c) => seen.push(c.index));
    let guard = 0;
    while (sys.stats().ready < sys.stats().chunks && guard++ < 100) sys.resync({ checks: 1000, builds: 2 });
    const rt = sys.runtimes[0];
    expect(sys.stats().ready).toBe(sys.stats().chunks);
    expect(seen.length).toBe(rt.chunks.length);
    // smoothed height stays within a few metres of the raw terrain along the path
    rt.samples.forEach((s, i) => {
      const raw = t.heightAt(s.pos.x, -s.pos.z)!;
      expect(Math.abs(rt.designY[i] - raw)).toBeLessThan(6);
    });
  });

  it('respects the per-call build budget', () => {
    const t = new MockStreamTerrain();
    settleAround(t);
    const sys = new RoadSystem(t);
    sys.setRoads([mkRoad(line)]);
    expect(sys.resync({ checks: 1000, builds: 1 })).toBe(1);
  });

  it('is partial-settle safe: only chunks whose terrain is settled get built', () => {
    const t = new MockStreamTerrain();
    t.loadRectSync(0, 0, 6000, 6000, 4);
    t.loadRectSync(2990, 2990, 3310, 3050, 0); // fine tiles only near the road start
    const sys = new RoadSystem(t);
    sys.setRoads([mkRoad(line)]);
    sys.resync({ checks: 1000, builds: 1000 });
    const { ready, chunks } = sys.stats();
    expect(ready).toBeGreaterThan(0);
    expect(ready).toBeLessThan(chunks);
  });

  it('chunk heights are identical whichever order chunks are built in (no seams)', () => {
    const t = new MockStreamTerrain();
    settleAround(t);
    const a = new RoadRuntime(mkRoad(line), t, DEFAULT_RUNTIME_OPTIONS);
    const b = new RoadRuntime(mkRoad(line), t, DEFAULT_RUNTIME_OPTIONS);
    a.chunks.forEach((c) => a.tryBuildChunk(c));
    [...b.chunks].reverse().forEach((c) => b.tryBuildChunk(c));
    for (let i = 0; i < a.designY.length; i++) expect(b.designY[i]).toBeCloseTo(a.designY[i], 9);
  });

  it('bridge points keep their authored height', () => {
    const t = new MockStreamTerrain();
    settleAround(t);
    const def = mkRoad(line.map(([x, , z]) => [x, 1234, z] as [number, number, number]), {
      1: { mode: 'bridge' }, 2: { mode: 'bridge' },
    });
    const rt = new RoadRuntime(def, t, DEFAULT_RUNTIME_OPTIONS);
    rt.chunks.forEach((c) => rt.tryBuildChunk(c));
    const onBridge = rt.samples.findIndex((s) => s.mode === 'bridge' && s.fixedWeight === 1);
    expect(onBridge).toBeGreaterThanOrEqual(0);
    expect(rt.designY[onBridge]).toBeCloseTo(1234, 6);
  });
});
