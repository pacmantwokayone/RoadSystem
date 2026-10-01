import { describe, it, expect } from 'vitest';
import { normalizeNetwork, armsByNode, snapRoadToNodes } from '../src/network/graph';
import { sanitizeRoadsDocument } from '../src/network/doc';
import type { NodeDef, RoadDef } from '../src/network/types';

const road = (id: string, pts: Array<[number, number]>, extra: Partial<RoadDef> = {}): RoadDef => ({
  id, name: id, profile: 'hauptstrasse', points: pts.map(([x, z]) => ({ x, y: 100, z })), ...extra,
});
const node = (id: string, x: number, z: number): NodeDef => ({ id, x, y: 100, z });

describe('normalizeNetwork', () => {
  it('snaps connected road ends onto the node and keeps identity of untouched roads', () => {
    const a = road('a', [[0, 0], [100, 0]], { endNode: 'n' });
    const b = road('b', [[100.5, 0.2], [200, 0]], { startNode: 'n' });
    const free = road('free', [[0, 50], [100, 50]]);
    const out = normalizeNetwork([a, b, free], [node('n', 100, 0)]);
    expect(out.roads[0].points[1]).toMatchObject({ x: 100, z: 0 });
    expect(out.roads[1].points[0]).toMatchObject({ x: 100, z: 0 });
    expect(out.roads[2]).toBe(free);            // untouched → same object
    expect(out.roads[0]).toBe(a);               // already on the node → same object
    expect(out.roads[1]).not.toBe(b);           // moved → new object, original not mutated
    expect(b.points[0].x).toBe(100.5);
  });

  it('drops nodes with fewer than two road ends and clears the dangling references', () => {
    const a = road('a', [[0, 0], [100, 0]], { endNode: 'lonely' });
    const b = road('b', [[0, 10], [100, 10]], { endNode: 'ghost' }); // node does not exist
    const out = normalizeNetwork([a, b], [node('lonely', 100, 0)]);
    expect(out.nodes).toEqual([]);
    expect(out.roads[0].endNode).toBeUndefined();
    expect(out.roads[1].endNode).toBeUndefined();
  });

  it('a T junction: three arms on one node', () => {
    const roads = [
      road('w', [[0, 0], [100, 0]], { endNode: 't' }),
      road('e', [[100, 0], [200, 0]], { startNode: 't' }),
      road('s', [[100, 80], [100, 0]], { endNode: 't' }),
    ];
    const out = normalizeNetwork(roads, [node('t', 100, 0)]);
    expect(out.nodes.length).toBe(1);
    expect(armsByNode(out.roads).get('t')!.map((a) => `${a.roadId}:${a.end}`).sort()).toEqual(['e:start', 's:end', 'w:end']);
  });

  it('snapRoadToNodes returns the same object when already consistent', () => {
    const n = node('n', 100, 0);
    const a = road('a', [[0, 0], [100, 0]], { endNode: 'n' });
    expect(snapRoadToNodes(a, new Map([['n', n]]))).toBe(a);
  });

  it('documents with nodes round-trip through sanitize; invalid nodes are dropped', () => {
    const doc = sanitizeRoadsDocument({
      roads: [
        { id: 'a', points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], endNode: 'n' },
        { id: 'b', points: [{ x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }], startNode: 'n' },
      ],
      nodes: [{ id: 'n', x: 10, y: 0, z: 0, radius: 999 }, { id: 'bad', x: 'x' }, 7],
    });
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes![0].radius).toBe(40); // clamped
    expect(doc.roads[0].endNode).toBe('n');
  });
});
