// Pure helpers on the road graph: arms per node, and normalising a network so that
// references are valid, every node joins at least two road ends, and connected road ends
// sit exactly on their node. Object identity is preserved for anything that doesn't change
// (the runtime diffs by identity).

import type { NodeDef, RoadDef, RoadPoint } from './types';
import { resolveAttachments } from './attach';

export type End = 'start' | 'end';
export interface Arm {
  roadId: string;
  end: End;
}

export function armsByNode(roads: readonly RoadDef[]): Map<string, Arm[]> {
  const m = new Map<string, Arm[]>();
  const add = (node: string | undefined, roadId: string, end: End): void => {
    if (!node) return;
    let l = m.get(node);
    if (!l) { l = []; m.set(node, l); }
    l.push({ roadId, end });
  };
  for (const r of roads) { add(r.startNode, r.id, 'start'); add(r.endNode, r.id, 'end'); }
  return m;
}

const EPS = 1e-6;

function snapPoint(p: RoadPoint, n: NodeDef): RoadPoint {
  return Math.abs(p.x - n.x) < EPS && Math.abs(p.z - n.z) < EPS ? p : { ...p, x: n.x, z: n.z };
}

/** Road with its connected end points moved onto their nodes (same object if already there). */
export function snapRoadToNodes(road: RoadDef, nodes: ReadonlyMap<string, NodeDef>): RoadDef {
  const s = road.startNode ? nodes.get(road.startNode) : undefined;
  const e = road.endNode ? nodes.get(road.endNode) : undefined;
  if (!s && !e) return road;
  const first = s ? snapPoint(road.points[0], s) : road.points[0];
  const lastIdx = road.points.length - 1;
  const last = e ? snapPoint(road.points[lastIdx], e) : road.points[lastIdx];
  if (first === road.points[0] && last === road.points[lastIdx]) return road;
  const points = road.points.slice();
  points[0] = first;
  points[lastIdx] = last;
  return { ...road, points };
}

export function normalizeNetwork(roads: readonly RoadDef[], nodes: readonly NodeDef[]): { roads: RoadDef[]; nodes: NodeDef[] } {
  let nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const clearRefs = (rs: readonly RoadDef[], keep: ReadonlySet<string>): RoadDef[] =>
    rs.map((r) => {
      const badS = r.startNode !== undefined && !keep.has(r.startNode);
      const badE = r.endNode !== undefined && !keep.has(r.endNode);
      if (!badS && !badE) return r;
      const c = { ...r };
      if (badS) delete c.startNode;
      if (badE) delete c.endNode;
      return c;
    });

  let out = clearRefs(resolveAttachments(roads), new Set(nodeMap.keys()));
  // a node needs at least two road ends
  const arms = armsByNode(out);
  const keep = new Set([...nodeMap.keys()].filter((id) => (arms.get(id)?.length ?? 0) >= 2));
  if (keep.size !== nodeMap.size) {
    out = clearRefs(out, keep);
    nodeMap = new Map([...nodeMap].filter(([id]) => keep.has(id)));
  }
  out = out.map((r) => snapRoadToNodes(r, nodeMap));
  const keptNodes = nodes.filter((n) => nodeMap.has(n.id));
  return { roads: out, nodes: keptNodes };
}
