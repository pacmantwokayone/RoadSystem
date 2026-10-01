import { describe, it, expect } from 'vitest';
import { RoadModel, NetworkDraft } from '../src/editor/model';
import { connectEnd, splitRoad, findConnectTarget, moveNode, dissolveNode, setNodeRadius, type Ids } from '../src/editor/ops';
import { sampleRoad } from '../src/core/sampling';
import type { RoadDef } from '../src/network/types';
import { armsByNode } from '../src/network/graph';

let n = 0;
const ids: Ids = { node: () => `n${++n}`, road: (b) => `${b}~${++n}` };
const road = (id: string, pts: Array<[number, number]>, extra: Partial<RoadDef> = {}): RoadDef => ({
  id, name: id, profile: 'hauptstrasse', points: pts.map(([x, z]) => ({ x, y: 100, z })), ...extra,
});
const main = () => road('main', [[0, 0], [100, 0], [200, 0], [300, 0]]);
const side = () => road('side', [[150, 200], [150, 100], [150, 40]]); // ends 40 m south of main

function model(...roads: RoadDef[]): RoadModel {
  const m = new RoadModel();
  m.load({ version: 1, roads });
  return m;
}

describe('connectEnd', () => {
  it('to a road interior: splits it, creates a node and joins three arms — in ONE undo step', () => {
    const m = model(main(), side());
    // pull the side road's end onto the main road first (as the editor does when you drop a handle there)
    m.transact('Straße verbinden', (d) => {
      d.editRoad('side', (r) => { r.points[2] = { ...r.points[2], x: 150, z: 0 }; });
      const sampled = sampleRoad(d.road('main')!);
      connectEnd(d, 'side', 'end', { kind: 'road', roadId: 'main', s: 150, sampled }, ids);
    });
    expect(m.list).toHaveLength(3);
    expect(m.nodeList).toHaveLength(1);
    const node = m.nodeList[0];
    const arms = armsByNode(m.list).get(node.id)!;
    expect(arms).toHaveLength(3);
    const [first, second] = [m.get('main')!, m.list.find((r) => r.id.startsWith('main~'))!];
    expect(first.endNode).toBe(node.id);
    expect(second.startNode).toBe(node.id);
    // the split point sits exactly on the node for both halves; nothing is lost at the outer ends
    expect(first.points.at(-1)).toMatchObject({ x: node.x, z: node.z });
    expect(second.points[0]).toMatchObject({ x: node.x, z: node.z });
    expect(first.points[0]).toMatchObject({ x: 0, z: 0 });
    expect(second.points.at(-1)).toMatchObject({ x: 300, z: 0 });
    expect(m.get('side')!.endNode).toBe(node.id);
    expect(node.x).toBeCloseTo(150, 0);

    m.undo(); // one step restores everything
    expect(m.list.map((r) => r.id).sort()).toEqual(['main', 'side']);
    expect(m.nodeList).toHaveLength(0);
    expect(m.get('main')!.points).toHaveLength(4);
    m.redo();
    expect(m.list).toHaveLength(3);
  });

  it('to a free end: creates a node at that end and connects both', () => {
    const a = road('a', [[0, 0], [100, 0]]);
    const b = road('b', [[200, 50], [110, 5]]);
    const m = model(a, b);
    m.transact('verbinden', (d) => { connectEnd(d, 'b', 'end', { kind: 'end', roadId: 'a', end: 'end' }, ids); });
    const node = m.nodeList[0];
    expect(node).toMatchObject({ x: 100, z: 0 });
    expect(m.get('a')!.endNode).toBe(node.id);
    expect(m.get('b')!.endNode).toBe(node.id);
    expect(m.get('b')!.points.at(-1)).toMatchObject({ x: 100, z: 0 }); // snapped onto the node
  });

  it('to an existing node (e.g. making a T into an X): reuses the node', () => {
    const m = model(main(), side());
    m.transact('t', (d) => {
      d.editRoad('side', (r) => { r.points[2] = { ...r.points[2], x: 150, z: 0 }; });
      connectEnd(d, 'side', 'end', { kind: 'road', roadId: 'main', s: 150, sampled: sampleRoad(d.road('main')!) }, ids);
    });
    const nodeId = m.nodeList[0].id;
    const north = road('north', [[150, -200], [150, -100], [150, -30]]);
    m.transact('x', (d) => { d.setRoad(north); connectEnd(d, 'north', 'end', { kind: 'node', nodeId }, ids); });
    expect(m.nodeList).toHaveLength(1);
    expect(armsByNode(m.list).get(nodeId)).toHaveLength(4);
  });

  it('ignores connecting a road to itself', () => {
    const m = model(main());
    const changed = m.transact('x', (d) => { connectEnd(d, 'main', 'end', { kind: 'end', roadId: 'main', end: 'end' }, ids); });
    expect(changed).toBe(false);
  });
});

describe('node operations', () => {
  function tJunction(): RoadModel {
    const m = model(main(), side());
    m.transact('t', (d) => {
      d.editRoad('side', (r) => { r.points[2] = { ...r.points[2], x: 150, z: 0 }; });
      connectEnd(d, 'side', 'end', { kind: 'road', roadId: 'main', s: 150, sampled: sampleRoad(d.road('main')!) }, ids);
    });
    return m;
  }

  it('moving a node moves every connected road end with it', () => {
    const m = tJunction();
    const id = m.nodeList[0].id;
    m.transact('move', (d) => moveNode(d, id, 160, 100, 12));
    for (const arm of armsByNode(m.list).get(id)!) {
      const r = m.get(arm.roadId)!;
      const p = arm.end === 'start' ? r.points[0] : r.points.at(-1)!;
      expect(p).toMatchObject({ x: 160, z: 12 });
    }
  });

  it('radius edits are stored; the default radius is not written', () => {
    const m = tJunction();
    const id = m.nodeList[0].id;
    m.transact('r', (d) => setNodeRadius(d, id, 10));
    expect(m.getNode(id)!.radius).toBe(10);
    m.transact('r', (d) => setNodeRadius(d, id, 6));
    expect(m.getNode(id)!.radius).toBeUndefined();
  });

  it('dissolving a node unlinks the roads but keeps their geometry', () => {
    const m = tJunction();
    const id = m.nodeList[0].id;
    m.transact('d', (d) => dissolveNode(d, id));
    expect(m.nodeList).toHaveLength(0);
    expect(m.list).toHaveLength(3);
    expect(m.list.every((r) => !r.startNode && !r.endNode)).toBe(true);
  });

  it('deleting one road of a T leaves a 2-arm node; deleting a second removes the node', () => {
    const m = tJunction();
    m.removeRoad('side');
    expect(m.nodeList).toHaveLength(1);
    m.removeRoad(m.list[0].id);
    expect(m.nodeList).toHaveLength(0); // a node with a single arm is meaningless
  });

  it('splitRoad on its own', () => {
    const d = new NetworkDraft({ roads: [main()], nodes: [] });
    const node = splitRoad(d, 'main', sampleRoad(main()), 120, ids)!;
    expect(d.roads).toHaveLength(2);
    expect(node.x).toBeCloseTo(120, 0);
  });
});

describe('findConnectTarget', () => {
  const mk = (...rs: RoadDef[]) => rs.map((def) => ({ def, sampled: sampleRoad(def) }));
  const roads = mk(main(), road('free', [[400, 100], [500, 100]]));

  it('prefers a node over an end over a road centre line', () => {
    const withNode = findConnectTarget(roads, [{ id: 'n', x: 150, y: 100, z: 0 }], 150, 3);
    expect(withNode).toEqual({ kind: 'node', nodeId: 'n' });
    expect(findConnectTarget(roads, [], 402, -98)!.kind).toBe('end'); // sim z 100 ↔ three z −100
    expect(findConnectTarget(roads, [], 150, 3)!.kind).toBe('road');
  });

  it('no target when too far; near the ends of a road it is not offered as a split point', () => {
    expect(findConnectTarget(roads, [], 150, 40)).toBeUndefined();
    const nearEnd = findConnectTarget(roads, [], 295, 2); // 5 m before main's end: end margin → but main's end is free → end target
    expect(nearEnd!.kind).toBe('end');
  });

  it('excludes the road being edited', () => {
    expect(findConnectTarget(roads, [], 150, 3, { snapM: 9, roadSnapM: 7, endMarginM: 10, excludeRoad: 'main' })).toBeUndefined();
  });
});
