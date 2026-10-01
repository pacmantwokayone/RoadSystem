import { describe, it, expect } from 'vitest';
import { sampleRoad } from '../src/core/sampling';
import { projectOnRoad, pointAtS, nearestRoad } from '../src/editor/pathTools';
import { computeProfileView } from '../src/editor/profilePreview';
import { ProfileLibrary } from '../src/profile/library';
import type { RoadDef } from '../src/network/types';

// sim space; three-space z is negated
const def: RoadDef = {
  id: 'r', name: 'r', profile: 'hauptstrasse',
  points: [{ x: 0, y: 100, z: 0 }, { x: 100, y: 110, z: 0 }, { x: 200, y: 120, z: 0, mode: 'bridge' }, { x: 300, y: 120, z: 0, mode: 'bridge' }],
};

describe('projectOnRoad', () => {
  const sampled = sampleRoad(def);
  it('finds the closest point on the centre line and the segment it belongs to', () => {
    const p = projectOnRoad(sampled, 140, -25); // three space: 25 m beside the road
    expect(p.distance).toBeCloseTo(25, 1);
    expect(p.point.x).toBeCloseTo(140, 0);
    expect(p.seg).toBe(1);
    // s is 3-D arc length (the road climbs), so check it maps back to the projected point
    expect(sampled.curve.pointAt(p.s).x).toBeCloseTo(140, 0);
  });
  it('clamps beyond the ends', () => {
    const p = projectOnRoad(sampled, -50, 0);
    expect(p.s).toBeCloseTo(0, 3);
    expect(p.distance).toBeCloseTo(50, 3);
  });
});

describe('pointAtS (insert a point)', () => {
  const sampled = sampleRoad(def);
  it('inserts between the right pair of points, in sim coordinates', () => {
    const { index, point } = pointAtS(def, sampled, 40);
    expect(index).toBe(1);
    expect(point.x).toBeCloseTo(40, 0);
    expect(point.z).toBeCloseTo(0, 1);
    expect(point.y).toBeGreaterThan(100);
  });
  it('inherits bridge mode only inside a bridge segment', () => {
    expect(pointAtS(def, sampled, 250).point.mode).toBe('bridge');
    expect(pointAtS(def, sampled, 150).point.mode).toBeUndefined(); // road → bridge boundary segment
  });
  it('accepts an explicit height (e.g. the terrain under the cursor)', () => {
    expect(pointAtS(def, sampled, 40, 777).point.y).toBe(777);
  });
});

describe('nearestRoad', () => {
  const other: RoadDef = { id: 'o', name: 'o', profile: 'hauptstrasse', points: [{ x: 0, y: 0, z: 100 }, { x: 100, y: 0, z: 100 }] };
  const list = [def, other].map((d) => ({ def: d, sampled: sampleRoad(d) }));
  it('picks the closest road within range, none beyond', () => {
    expect(nearestRoad(list, 50, -3, 8)!.id).toBe('r');
    expect(nearestRoad(list, 50, -98, 8)!.id).toBe('o');
    expect(nearestRoad(list, 50, -50, 8)).toBeUndefined();
  });
});

describe('profile preview view', () => {
  const p = new ProfileLibrary().resolve('hauptstrasse');
  it('fits the whole cross-section into the canvas', () => {
    const v = computeProfileView(p, 360, 150);
    const left = v.originX - p.outerHalfWidth * v.scale;
    const right = v.originX + p.outerHalfWidth * v.scale;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(360);
    const top = v.originY - Math.max(...p.points.map((q) => q.y)) * v.scale;
    const bottom = v.originY - v.bottomY * v.scale;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(150);
  });
});
