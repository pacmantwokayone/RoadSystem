import { describe, it, expect } from 'vitest';
import { RoadModel, type ModelEvent } from '../src/editor/model';
import type { RoadDef } from '../src/network/types';

const road = (id: string, n = 3): RoadDef => ({
  id, name: id, profile: 'hauptstrasse',
  points: Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, z: 0 })),
});

function model(): { m: RoadModel; events: ModelEvent[]; t: { now: number } } {
  const t = { now: 1000 };
  const m = new RoadModel(() => t.now);
  const events: ModelEvent[] = [];
  m.onChange((e) => events.push(e));
  return { m, events, t };
}

describe('RoadModel', () => {
  it('add / remove / undo / redo restore exact state and order', () => {
    const { m } = model();
    m.addRoad(road('a')); m.addRoad(road('b')); m.addRoad(road('c'));
    m.removeRoad('b');
    expect(m.list.map((r) => r.id)).toEqual(['a', 'c']);
    m.undo();
    expect(m.list.map((r) => r.id)).toEqual(['a', 'b', 'c']); // back at its old position
    m.redo();
    expect(m.list.map((r) => r.id)).toEqual(['a', 'c']);
    m.undo(); m.undo(); m.undo(); m.undo();
    expect(m.list.length).toBe(0);
    expect(m.canUndo).toBe(false);
    expect(m.canRedo).toBe(true);
  });

  it('edits replace snapshots instead of mutating them', () => {
    const { m } = model();
    m.addRoad(road('a'));
    const before = m.get('a')!;
    m.edit('a', 'Punkt bewegen', (d) => { d.points[1].x = 99; });
    expect(before.points[1].x).toBe(10);
    expect(m.get('a')!.points[1].x).toBe(99);
    expect(m.get('a')).not.toBe(before);
  });

  it('coalesces edits with the same key within the window into one undo step', () => {
    const { m, t } = model();
    m.addRoad(road('a'));
    for (let i = 1; i <= 20; i++) {
      t.now += 16;
      m.edit('a', 'Punkt bewegen', (d) => { d.points[1].x = i; }, 'drag:a:1');
    }
    expect(m.get('a')!.points[1].x).toBe(20);
    m.undo(); // single step back
    expect(m.get('a')!.points[1].x).toBe(10);
    m.undo(); // the add
    expect(m.list.length).toBe(0);
  });

  it('does not coalesce across different keys, long pauses, or after breakCoalesce()', () => {
    const { m, t } = model();
    m.addRoad(road('a'));
    m.edit('a', 'x', (d) => { d.points[1].x = 1; }, 'k1');
    m.edit('a', 'y', (d) => { d.points[1].x = 2; }, 'k2');
    t.now += 5000;
    m.edit('a', 'y', (d) => { d.points[1].x = 3; }, 'k2');
    m.breakCoalesce();
    m.edit('a', 'y', (d) => { d.points[1].x = 4; }, 'k2');
    let steps = 0;
    while (m.undo()) steps++;
    expect(steps).toBe(5); // add + 4 separate edits
  });

  it('a new edit after undo clears the redo stack', () => {
    const { m } = model();
    m.addRoad(road('a'));
    m.edit('a', 'x', (d) => { d.name = 'neu'; });
    m.undo();
    expect(m.canRedo).toBe(true);
    m.edit('a', 'z', (d) => { d.name = 'anders'; });
    expect(m.canRedo).toBe(false);
  });

  it('removing points below 2 removes the road', () => {
    const { m } = model();
    m.addRoad(road('a', 2));
    m.edit('a', 'Punkt löschen', (d) => { d.points.pop(); });
    expect(m.list.length).toBe(0);
    m.undo();
    expect(m.get('a')!.points.length).toBe(2);
  });

  it('tracks dirty state across save, edit and undo', () => {
    const { m } = model();
    m.load({ version: 1, revision: 4, roads: [road('a')] });
    expect(m.dirty).toBe(false);
    expect(m.revision).toBe(4);
    m.edit('a', 'x', (d) => { d.name = 'b'; });
    expect(m.dirty).toBe(true);
    m.markSaved(5);
    expect(m.dirty).toBe(false);
    expect(m.revision).toBe(5);
    m.undo();
    expect(m.dirty).toBe(true);
    m.redo();
    expect(m.dirty).toBe(false);
  });

  it('emits road/remove/reset events the editor uses to drive the RoadSystem', () => {
    const { m, events } = model();
    m.load({ version: 1, roads: [] });
    m.addRoad(road('a'));
    m.edit('a', 'x', (d) => { d.name = 'b'; });
    m.removeRoad('a');
    const types = events.filter((e) => e.type !== 'history').map((e) => e.type);
    expect(types).toEqual(['reset', 'road', 'road', 'remove']);
  });

  it('toDocument returns deep copies', () => {
    const { m } = model();
    m.addRoad(road('a'));
    const doc = m.toDocument();
    doc.roads[0].points[0].x = 777;
    expect(m.get('a')!.points[0].x).toBe(0);
  });

  it('a held gesture merges into ONE step regardless of timing (slow frames)', () => {
    const { m, t } = model();
    m.addRoad(road('a'));
    m.holdCoalesce('drag:a:1');
    for (let i = 1; i <= 6; i++) {
      t.now += 3000; // far beyond the coalescing window
      m.edit('a', 'Punkt bewegen', (d) => { d.points[1].x = i; }, 'drag:a:1');
    }
    m.holdCoalesce(null);
    expect(m.get('a')!.points[1].x).toBe(6);
    m.undo();
    expect(m.get('a')!.points[1].x).toBe(10);
    // after the gesture ends a new drag is a new step
    m.redo();
    t.now += 10;
    m.edit('a', 'Punkt bewegen', (d) => { d.points[1].x = 50; }, 'drag:a:1');
    m.undo();
    expect(m.get('a')!.points[1].x).toBe(6);
  });
});
