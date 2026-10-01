import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { simToThree, threeToSim } from '../src/core/world';
import { PathCurve } from '../src/core/spline';
import { makeFrame, horizontalCurvature } from '../src/core/frames';
import { sampleRoad } from '../src/core/sampling';
import { designHeightAt } from '../src/core/alignment';
import type { RoadDef } from '../src/network/types';

const road = (pts: Array<[number, number, number, Partial<RoadDef['points'][number]>?]>): RoadDef => ({
  id: 'r',
  name: 'r',
  profile: 'x',
  points: pts.map(([x, y, z, extra]) => ({ x, y, z, ...extra })),
});

describe('world adapter', () => {
  it('mirrors z exactly like riverField (x, y, -z) and round-trips', () => {
    const v = simToThree(10, 20, 30);
    expect([v.x, v.y, v.z]).toEqual([10, 20, -30]);
    expect(threeToSim(v)).toEqual({ x: 10, y: 20, z: 30 });
  });
});

describe('PathCurve', () => {
  it('has the exact length of a straight line and passes through control points', () => {
    const c = new PathCurve([new Vector3(0, 0, 0), new Vector3(50, 0, 0), new Vector3(100, 0, 0)]);
    expect(c.length).toBeCloseTo(100, 3);
    expect(c.pointAt(50).distanceTo(new Vector3(50, 0, 0))).toBeLessThan(1e-3);
    expect(c.pointS[1]).toBeCloseTo(50, 3);
  });

  it('arc-length parameterisation is uniform (equal ds → equal chord on a straight run)', () => {
    const c = new PathCurve([new Vector3(0, 0, 0), new Vector3(30, 0, 0), new Vector3(100, 0, 0)]);
    const a = c.pointAt(10);
    const b = c.pointAt(20);
    const d = c.pointAt(80);
    const e = c.pointAt(90);
    expect(a.distanceTo(b)).toBeCloseTo(10, 1);
    expect(d.distanceTo(e)).toBeCloseTo(10, 1);
  });

  it('tangents are unit length and follow the direction of travel', () => {
    const c = new PathCurve([new Vector3(0, 0, 0), new Vector3(0, 0, -40), new Vector3(30, 0, -80)]);
    const t = c.tangentAt(10);
    expect(t.length()).toBeCloseTo(1, 6);
    expect(t.z).toBeLessThan(-0.9);
  });

  it('passes through every authored point on a curvy path', () => {
    const pts = [new Vector3(0, 0, 0), new Vector3(40, 5, -10), new Vector3(60, 8, -60), new Vector3(120, 2, -70)];
    const c = new PathCurve(pts);
    pts.forEach((p, i) => expect(c.pointAt(c.pointS[i]).distanceTo(p)).toBeLessThan(1e-3));
  });
});

describe('frames', () => {
  it('right is +x when travelling toward -z (three space), up is +y', () => {
    const f = makeFrame(new Vector3(0, 0, -1));
    expect(f.right.x).toBeCloseTo(1);
    expect(f.up.y).toBeCloseTo(1);
  });

  it('keeps right horizontal on a slope and up perpendicular to the surface', () => {
    const f = makeFrame(new Vector3(0, 0.3, -1));
    expect(f.right.y).toBeCloseTo(0);
    expect(f.up.dot(f.tangent)).toBeCloseTo(0);
  });

  it('positive banking lowers the right edge', () => {
    const f = makeFrame(new Vector3(0, 0, -1), 0.1);
    expect(f.right.y).toBeLessThan(0);
    expect(f.up.x).toBeGreaterThan(0);
  });

  it('curvature is positive for a left turn and negative for a right turn', () => {
    const t1 = new Vector3(0, 0, -1);
    const left = new Vector3(-0.1, 0, -1).normalize();
    const right = new Vector3(0.1, 0, -1).normalize();
    expect(horizontalCurvature(t1, left, 1)).toBeGreaterThan(0);
    expect(horizontalCurvature(t1, right, 1)).toBeLessThan(0);
  });
});

describe('sampling', () => {
  it('lands samples exactly on every authored point and on the end', () => {
    const def = road([[0, 0, 0], [37, 0, 11], [90, 0, 15], [140, 0, 60]]);
    const { curve, samples } = sampleRoad(def);
    for (const sPoint of curve.pointS) {
      expect(samples.some((s) => Math.abs(s.s - sPoint) < 1e-6)).toBe(true);
    }
    expect(samples[0].s).toBe(0);
    expect(samples[samples.length - 1].s).toBeCloseTo(curve.length, 6);
  });

  it('never exceeds the max step and is denser in tight curves', () => {
    const straight = sampleRoad(road([[0, 0, 0], [200, 0, 0]]));
    const maxGap = Math.max(...straight.samples.slice(1).map((s, i) => s.s - straight.samples[i].s));
    expect(maxGap).toBeLessThanOrEqual(4 + 1e-6);

    const curvy = sampleRoad(road([[0, 0, 0], [30, 0, 0], [40, 0, 10], [40, 0, 40], [10, 0, 50]]));
    const gaps = curvy.samples.slice(1).map((s, i) => s.s - curvy.samples[i].s);
    expect(Math.min(...gaps)).toBeLessThan(3);
  });

  it('flags bridge sections and forces their height to the authored value', () => {
    const def = road([
      [0, 100, 0],
      [50, 105, 0, { mode: 'bridge' }],
      [100, 110, 0, { mode: 'bridge' }],
      [150, 112, 0],
    ]);
    const { samples } = sampleRoad(def);
    const mid = samples.find((s) => Math.abs(s.s - 75) < 2)!;
    expect(mid.mode).toBe('bridge');
    expect(mid.fixedWeight).toBe(1);
    expect(samples[0].fixedWeight).toBe(0);
  });
});

describe('alignment', () => {
  const n = 101;
  const s = Float64Array.from({ length: n }, (_, i) => i * 2); // 2 m spacing, 200 m
  const zeros = new Float64Array(n);

  it('keeps a constant terrain constant and a linear slope linear (interior)', () => {
    const flat = Float64Array.from(s, () => 500);
    expect(designHeightAt({ s, ground: flat, authored: zeros, fixedWeight: zeros }, 50, 12)).toBeCloseTo(500, 6);
    const slope = Float64Array.from(s, (v) => 500 + 0.05 * v);
    expect(designHeightAt({ s, ground: slope, authored: zeros, fixedWeight: zeros }, 50, 12)).toBeCloseTo(500 + 0.05 * s[50], 3);
  });

  it('smooths a noisy terrain', () => {
    const noisy = Float64Array.from(s, (_, i) => 500 + (i % 2 === 0 ? 3 : -3));
    const out = designHeightAt({ s, ground: noisy, authored: zeros, fixedWeight: zeros }, 50, 12);
    expect(Math.abs(out - 500)).toBeLessThan(0.5);
  });

  it('fixed samples keep authored height and do not drag neighbours toward the valley below', () => {
    const ground = Float64Array.from(s, () => 100);
    const authored = Float64Array.from(s, () => 150);
    const fixed = Float64Array.from(s, (v) => (v >= 80 && v <= 120 ? 1 : 0));
    // a sample on the bridge keeps the authored height
    expect(designHeightAt({ s, ground, authored, fixedWeight: fixed }, 50, 12)).toBe(150);
    // an approach sample right next to the bridge ignores ground under the deck
    const approach = designHeightAt({ s, ground, authored, fixedWeight: fixed }, 38, 12);
    expect(approach).toBeCloseTo(100, 6);
  });

  it('is seam-consistent: a window computed from a local slice equals the full-road result', () => {
    const ground = Float64Array.from(s, (v) => 500 + 20 * Math.sin(v / 15));
    const full = { s, ground, authored: zeros, fixedWeight: zeros };
    // slice = exactly the data inside ±radius of sample 60
    const lo = 60 - 6, hi = 60 + 6; // radius 12 m / 2 m spacing
    const sliceIdx = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    const slice = {
      s: Float64Array.from(sliceIdx, (i) => s[i]),
      ground: Float64Array.from(sliceIdx, (i) => ground[i]),
      authored: new Float64Array(sliceIdx.length),
      fixedWeight: new Float64Array(sliceIdx.length),
    };
    expect(designHeightAt(slice, 6, 12)).toBeCloseTo(designHeightAt(full, 60, 12), 9);
  });
});
