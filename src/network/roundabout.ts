// Roundabouts (Kreisel) are made of what the network already has: a ring of short roads between nodes, one node per arm. Every node is
// an ordinary junction (the ring has a higher rank than the arms, so the arms get "Kein Vortritt" automatically). This file builds
// those roads and nodes from a short description, and finds roundabouts again in a network (for the island in the middle).

import type { NodeDef, RoadDef, RoadPoint } from './types';

export interface RoundaboutArm {
  /** direction from the centre, radians, in SIM space (0 = +x, π/2 = +z) */
  angle: number;
  profile: string;
  name?: string;
  /** straight arm length outside the ring, metres (default 140) */
  length?: number;
  /** points of the arm from far away to the ring (the ring node is added); overrides `length` */
  points?: RoadPoint[];
  params?: RoadDef['params'];
  /** extra fields copied onto the arm road (bridge type, …) */
  road?: Partial<RoadDef>;
}

export interface RoundaboutSpec {
  id: string;
  x: number;
  z: number;
  /** ground height used until the terrain is known (drape points follow the terrain anyway) */
  y?: number;
  /** radius of the ring's centre line, metres */
  radius?: number;
  ringProfile?: string;
  ringParams?: RoadDef['params'];
  arms: RoundaboutArm[];
  /** corner radius of the ring's junctions, metres */
  nodeRadius?: number;
}

export interface Roundabout {
  roads: RoadDef[];
  nodes: NodeDef[];
  /** the grass island in the middle */
  island: { x: number; z: number; radius: number };
}

export const RING_PROFILE = 'kreisel';
const TWO_PI = Math.PI * 2;

export function buildRoundabout(spec: RoundaboutSpec): Roundabout {
  const R = spec.radius ?? 22;
  const y = spec.y ?? 0;
  const ringProfile = spec.ringProfile ?? RING_PROFILE;
  const arms = spec.arms.slice().sort((a, b) => a.angle - b.angle);
  const n = arms.length;
  const roads: RoadDef[] = [];
  const nodes: NodeDef[] = [];
  const at = (ang: number, r: number): { x: number; z: number } => ({ x: spec.x + Math.cos(ang) * r, z: spec.z + Math.sin(ang) * r });
  const nodeId = (k: number): string => `${spec.id}-n${k}`;

  arms.forEach((a, k) => {
    const p = at(a.angle, R);
    nodes.push({ id: nodeId(k), x: p.x, y, z: p.z, radius: spec.nodeRadius ?? 5 });
  });
  // ring arcs: from each arm to the next, counter-clockwise
  for (let k = 0; k < n; k++) {
    const a0 = arms[k].angle;
    let a1 = arms[(k + 1) % n].angle;
    if (a1 <= a0 + 1e-6) a1 += TWO_PI;
    const steps = Math.max(2, Math.ceil((a1 - a0) / (Math.PI / 7)));
    const points: RoadPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const q = at(a0 + ((a1 - a0) * i) / steps, R);
      points.push({ x: q.x, y, z: q.z });
    }
    roads.push({
      id: `${spec.id}-ring${k}`, name: 'Kreisel', profile: ringProfile, ...(spec.ringParams ? { params: spec.ringParams } : {}),
      points, startNode: nodeId(k), endNode: nodeId((k + 1) % n),
    });
  }
  // arms: from far away to the ring node
  arms.forEach((a, k) => {
    const len = a.length ?? 140;
    const far = at(a.angle, R + len);
    const mid = at(a.angle, R + len * 0.5);
    const pts: RoadPoint[] = a.points ?? [{ x: far.x, y, z: far.z }, { x: mid.x, y, z: mid.z }];
    const node = nodes[k];
    roads.push({
      id: `${spec.id}-arm${k}`, name: a.name ?? `Zufahrt ${k + 1}`, profile: a.profile, ...(a.params ? { params: a.params } : {}), ...(a.road ?? {}),
      points: [...pts, { x: node.x, y, z: node.z }], endNode: node.id,
    });
  });
  return { roads, nodes, island: { x: spec.x, z: spec.z, radius: Math.max(2, R - 4.6 - 0.3) } };
}

export interface FoundRoundabout {
  x: number;
  z: number;
  radius: number;
  roadIds: string[];
}

/** Rings in a network: connected roads with the ring profile whose points lie on a circle. */
export function findRoundabouts(roads: readonly RoadDef[], ringProfile = RING_PROFILE): FoundRoundabout[] {
  const ring = roads.filter((r) => r.profile === ringProfile && r.points.length >= 2);
  const parent = new Map<string, string>();
  const find = (a: string): string => { let r = a; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  for (const r of ring) parent.set(r.id, r.id);
  const byNode = new Map<string, string[]>();
  for (const r of ring) for (const nid of [r.startNode, r.endNode]) if (nid) { const l = byNode.get(nid) ?? []; l.push(r.id); byNode.set(nid, l); }
  for (const ids of byNode.values()) for (let i = 1; i < ids.length; i++) parent.set(find(ids[i]), find(ids[0]));
  const groups = new Map<string, RoadDef[]>();
  for (const r of ring) { const g = find(r.id); const l = groups.get(g) ?? []; l.push(r); groups.set(g, l); }
  const out: FoundRoundabout[] = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    let sx = 0, sz = 0, c = 0;
    for (const r of g) for (const p of r.points) { sx += p.x; sz += p.z; c++; }
    const x = sx / c, z = sz / c;
    let sr = 0;
    for (const r of g) for (const p of r.points) sr += Math.hypot(p.x - x, p.z - z);
    const radius = sr / c;
    let dev = 0;
    for (const r of g) for (const p of r.points) dev = Math.max(dev, Math.abs(Math.hypot(p.x - x, p.z - z) - radius));
    if (dev < Math.max(2, radius * 0.12)) out.push({ x, z, radius, roadIds: g.map((r) => r.id) });
  }
  return out;
}
