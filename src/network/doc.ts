// Validation / normalisation of persisted road documents. Server data is
// untrusted input (hand-edited JSON, older versions, partial saves): everything
// is coerced into a valid RoadsDocument, never thrown on.

import { ROAD_POINTS_MAX, ROADS_DOC_VERSION, type ElevationMode, type NodeDef, type RoadDef, type RoadMode, type RoadPoint, type RoadsDocument } from './types';
import { normalizeNetwork } from './graph';

const MODES: RoadMode[] = ['road', 'bridge', 'tunnel', 'gallery'];
const ELEVS: ElevationMode[] = ['drape', 'fixed'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function sanitizePoint(raw: unknown): RoadPoint | null {
  if (!isObj(raw)) return null;
  const x = num(raw.x), y = num(raw.y), z = num(raw.z);
  if (x === undefined || y === undefined || z === undefined) return null;
  const p: RoadPoint = { x, y, z };
  const w = num(raw.widthScale);
  if (w !== undefined && w !== 1) p.widthScale = Math.min(10, Math.max(0.1, w));
  if (typeof raw.mode === 'string' && (MODES as string[]).includes(raw.mode) && raw.mode !== 'road') p.mode = raw.mode as RoadMode;
  if (typeof raw.elev === 'string' && (ELEVS as string[]).includes(raw.elev) && raw.elev !== 'drape') p.elev = raw.elev as ElevationMode;
  const b = num(raw.banking);
  if (b !== undefined && b !== 0) p.banking = Math.min(0.5, Math.max(-0.5, b));
  return p;
}

export function sanitizeRoad(raw: unknown, fallbackId: string): RoadDef | null {
  if (!isObj(raw) || !Array.isArray(raw.points)) return null;
  const points = raw.points.slice(0, ROAD_POINTS_MAX).map(sanitizePoint).filter((p): p is RoadPoint => p !== null);
  if (points.length < 2) return null;
  const road: RoadDef = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    name: typeof raw.name === 'string' ? raw.name : 'Strasse',
    profile: typeof raw.profile === 'string' && raw.profile ? raw.profile : 'hauptstrasse',
    points,
  };
  if (typeof raw.startNode === 'string' && raw.startNode) road.startNode = raw.startNode;
  if (typeof raw.endNode === 'string' && raw.endNode) road.endNode = raw.endNode;
  if (isObj(raw.params)) {
    const params: Record<string, number | boolean | string> = {};
    for (const [k, v] of Object.entries(raw.params)) {
      if (typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) params[k] = v;
    }
    if (Object.keys(params).length) road.params = params;
  }
  return road;
}

export function sanitizeNode(raw: unknown): NodeDef | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const x = num(raw.x), y = num(raw.y), z = num(raw.z);
  if (x === undefined || y === undefined || z === undefined) return null;
  const n: NodeDef = { id: raw.id, x, y, z };
  const r = num(raw.radius);
  if (r !== undefined) n.radius = Math.min(40, Math.max(0.5, r));
  return n;
}

export function sanitizeRoadsDocument(raw: unknown): RoadsDocument {
  const obj = isObj(raw) ? raw : {};
  const list = Array.isArray(obj.roads) ? obj.roads : [];
  const seen = new Set<string>();
  const roads: RoadDef[] = [];
  list.forEach((r, i) => {
    const road = sanitizeRoad(r, `road-${i}`);
    if (!road) return;
    while (seen.has(road.id)) road.id += '_';
    seen.add(road.id);
    roads.push(road);
  });
  const nodeList = Array.isArray(obj.nodes) ? obj.nodes : [];
  const seenNodes = new Set<string>();
  const nodes: NodeDef[] = [];
  for (const raw of nodeList) {
    const n = sanitizeNode(raw);
    if (n && !seenNodes.has(n.id)) { seenNodes.add(n.id); nodes.push(n); }
  }
  const net = normalizeNetwork(roads, nodes);
  const doc: RoadsDocument = { version: ROADS_DOC_VERSION, roads: net.roads, ...(net.nodes.length ? { nodes: net.nodes } : {}) };
  const rev = num(obj.revision);
  if (rev !== undefined) doc.revision = Math.max(0, Math.floor(rev));
  return doc;
}

export function cloneRoad(r: RoadDef): RoadDef {
  return {
    id: r.id,
    name: r.name,
    profile: r.profile,
    ...(r.params ? { params: { ...r.params } } : {}),
    ...(r.startNode ? { startNode: r.startNode } : {}),
    ...(r.endNode ? { endNode: r.endNode } : {}),
    points: r.points.map((p) => ({ ...p })),
  };
}

export function cloneNode(n: NodeDef): NodeDef {
  return { ...n };
}
