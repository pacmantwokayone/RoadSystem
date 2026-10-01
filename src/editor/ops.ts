// Network operations used by the editor, as pure functions on a NetworkDraft (so a whole
// compound edit — split a road, create a node, connect roads — is one undoable transaction).

import type { SampledRoad } from '../core/sampling';
import { DEFAULT_CORNER_RADIUS_M, DEFAULT_GREEN_S, type CrosswalkMode, type JunctionControl, type NodeDef, type RoadDef, type SignalMode } from '../network/types';
import type { End } from '../network/graph';
import { simToThree } from '../core/world';
import type { NetworkDraft } from './model';
import { pointAtS, projectOnRoad } from './pathTools';

export type ConnectTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'end'; roadId: string; end: End }
  | { kind: 'road'; roadId: string; s: number; sampled: SampledRoad };

export interface Ids {
  node(): string;
  road(base: string): string;
}

let counter = 0;
export const defaultIds: Ids = {
  node: () => `n-${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
  road: (base) => `${base.replace(/~.*$/, '')}~${(counter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
};

function setRef(r: RoadDef, end: End, nodeId: string): void {
  if (end === 'start') r.startNode = nodeId; else r.endNode = nodeId;
}

/** Splits a road at arc length `s`; returns the new node (the first half keeps the road's id). */
export function splitRoad(d: NetworkDraft, roadId: string, sampled: SampledRoad, s: number, ids: Ids = defaultIds): NodeDef | undefined {
  const road = d.road(roadId);
  if (!road) return undefined;
  const { index, point } = pointAtS(road, sampled, s);
  const node: NodeDef = { id: ids.node(), x: point.x, y: point.y, z: point.z };
  d.setNode(node);
  const secondId = ids.road(road.id);
  const second: RoadDef = {
    id: secondId,
    name: `${road.name} (2)`,
    profile: road.profile,
    ...(road.params ? { params: { ...road.params } } : {}),
    ...(road.bridge ? { bridge: road.bridge } : {}),
    ...(road.bridgeParams ? { bridgeParams: { ...road.bridgeParams } } : {}),
    points: [{ ...point }, ...road.points.slice(index).map((p) => ({ ...p }))],
    startNode: node.id,
    ...(road.endNode ? { endNode: road.endNode } : {}),
  };
  d.editRoad(roadId, (r) => {
    r.points = [...r.points.slice(0, index).map((p) => ({ ...p })), { ...point }];
    r.endNode = node.id;
  });
  d.setRoad(second);
  return node;
}

/** Connects the given end of a road to the target, creating a node (and splitting a road) as needed. Returns the node id. */
export function connectEnd(d: NetworkDraft, roadId: string, end: End, target: ConnectTarget, ids: Ids = defaultIds): string | undefined {
  const road = d.road(roadId);
  if (!road) return undefined;
  let nodeId: string;
  if (target.kind === 'node') {
    if (!d.node(target.nodeId)) return undefined;
    nodeId = target.nodeId;
  } else if (target.kind === 'end') {
    if (target.roadId === roadId && target.end === end) return undefined;
    const other = d.road(target.roadId);
    if (!other) return undefined;
    const existing = target.end === 'start' ? other.startNode : other.endNode;
    if (existing && d.node(existing)) {
      nodeId = existing;
    } else {
      const p = target.end === 'start' ? other.points[0] : other.points[other.points.length - 1];
      const node: NodeDef = { id: ids.node(), x: p.x, y: p.y, z: p.z };
      d.setNode(node);
      d.editRoad(target.roadId, (r) => setRef(r, target.end, node.id));
      nodeId = node.id;
    }
  } else {
    if (target.roadId === roadId) return undefined;
    const node = splitRoad(d, target.roadId, target.sampled, target.s, ids);
    if (!node) return undefined;
    nodeId = node.id;
  }
  d.editRoad(roadId, (r) => setRef(r, end, nodeId));
  return nodeId;
}

export function moveNode(d: NetworkDraft, nodeId: string, x: number, y: number, z: number): void {
  d.editNode(nodeId, (n) => { n.x = x; n.y = y; n.z = z; }); // connected road ends follow (network normalisation)
}

export function setNodeRadius(d: NetworkDraft, nodeId: string, radius: number): void {
  d.editNode(nodeId, (n) => {
    if (Math.abs(radius - DEFAULT_CORNER_RADIUS_M) < 1e-9) delete n.radius; else n.radius = radius;
  });
}

export interface NodeSettings {
  control: JunctionControl;
  crosswalks: CrosswalkMode;
  signalMode: SignalMode;
  greenS: number;
}

/** Sets junction behaviour; values equal to the default are removed so saved documents stay small. */
export function setNodeSettings(d: NetworkDraft, nodeId: string, patch: Partial<NodeSettings>): void {
  d.editNode(nodeId, (n) => {
    if (patch.control !== undefined) { if (patch.control === 'auto') delete n.control; else n.control = patch.control; }
    if (patch.crosswalks !== undefined) { if (patch.crosswalks === 'auto') delete n.crosswalks; else n.crosswalks = patch.crosswalks; }
    if (patch.signalMode !== undefined) { if (patch.signalMode === 'fixed') delete n.signalMode; else n.signalMode = patch.signalMode; }
    if (patch.greenS !== undefined) { if (Math.round(patch.greenS) === DEFAULT_GREEN_S) delete n.greenS; else n.greenS = Math.min(120, Math.max(5, patch.greenS)); }
  });
}

/** Dissolves a junction: the roads keep their points but are no longer connected. */
export function dissolveNode(d: NetworkDraft, nodeId: string): void {
  d.removeNode(nodeId);
}

// ---- finding what a point is close to -------------------------------------------------

export interface TargetOptions {
  /** snap distance for nodes and free road ends, metres */
  snapM: number;
  /** snap distance to a road's centre line, metres */
  roadSnapM: number;
  /** how far from a road's ends a split may happen (closer = connect to the end instead) */
  endMarginM: number;
  /** a road never connects to itself */
  excludeRoad?: string;
}

export const DEFAULT_TARGET_OPTIONS: TargetOptions = { snapM: 9, roadSnapM: 7, endMarginM: 10 };

/** What the position (x, z) — THREE space — would connect to: a node, a free road end, or a road's centre line. */
export function findConnectTarget(
  roads: ReadonlyArray<{ def: RoadDef; sampled: SampledRoad }>,
  nodes: readonly NodeDef[],
  x: number, z: number,
  opts: TargetOptions = DEFAULT_TARGET_OPTIONS,
): ConnectTarget | undefined {
  const best: { hit?: { d: number; t: ConnectTarget } } = {};
  const consider = (dist: number, t: ConnectTarget, limit: number): void => {
    if (dist <= limit && (!best.hit || dist < best.hit.d)) best.hit = { d: dist, t };
  };
  // read through a function: TypeScript can't see that `consider` mutates `best`
  const result = (): ConnectTarget | undefined => best.hit?.t;

  for (const n of nodes) {
    const p = simToThree(n.x, n.y, n.z);
    consider(Math.hypot(x - p.x, z - p.z), { kind: 'node', nodeId: n.id }, opts.snapM);
  }
  if (result()) return result();

  for (const r of roads) {
    if (r.def.id === opts.excludeRoad) continue;
    const pts = r.def.points;
    if (!r.def.startNode) { const p = simToThree(pts[0].x, pts[0].y, pts[0].z); consider(Math.hypot(x - p.x, z - p.z), { kind: 'end', roadId: r.def.id, end: 'start' }, opts.snapM); }
    if (!r.def.endNode) { const p = simToThree(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[pts.length - 1].z); consider(Math.hypot(x - p.x, z - p.z), { kind: 'end', roadId: r.def.id, end: 'end' }, opts.snapM); }
  }
  if (result()) return result();

  for (const r of roads) {
    if (r.def.id === opts.excludeRoad) continue;
    const pr = projectOnRoad(r.sampled, x, z);
    const len = r.sampled.curve.length;
    if (pr.s < opts.endMarginM || pr.s > len - opts.endMarginM) continue;
    consider(pr.distance, { kind: 'road', roadId: r.def.id, s: pr.s, sampled: r.sampled }, opts.roadSnapM);
  }
  return result();
}
