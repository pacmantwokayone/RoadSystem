// Validation / normalisation of persisted road documents. Server data is
// untrusted input (hand-edited JSON, older versions, partial saves): everything
// is coerced into a valid RoadsDocument, never thrown on.

import {
  CROSSWALK_MODES, DEFAULT_GREEN_S, JUNCTION_CONTROLS, ROAD_POINTS_MAX, ROADS_DOC_VERSION, SIGNAL_MODES,
  type CrosswalkMode, type ElevationMode, type JunctionControl, type NodeDef, type SignalMode, type RoadDef, type RoadMode, type RoadPoint, type RoadsDocument,
} from './types';
import { normalizeNetwork } from './graph';
import { sanitizeWaters } from '../water/types';

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
  const cleanParams = (v: unknown): Record<string, number | boolean | string> | undefined => {
    if (!isObj(v)) return undefined;
    const out: Record<string, number | boolean | string> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'boolean' || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))) out[k] = x;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const params = cleanParams(raw.params);
  if (params) road.params = params;
  if (typeof raw.bridge === 'string' && raw.bridge) road.bridge = raw.bridge;
  const bp = cleanParams(raw.bridgeParams);
  if (bp) road.bridgeParams = bp;
  return road;
}

export function sanitizeNode(raw: unknown): NodeDef | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const x = num(raw.x), y = num(raw.y), z = num(raw.z);
  if (x === undefined || y === undefined || z === undefined) return null;
  const n: NodeDef = { id: raw.id, x, y, z };
  const r = num(raw.radius);
  if (r !== undefined) n.radius = Math.min(40, Math.max(0.5, r));
  // non-default settings only; unknown values are dropped
  if (typeof raw.control === 'string' && (JUNCTION_CONTROLS as readonly string[]).includes(raw.control) && raw.control !== 'auto') n.control = raw.control as JunctionControl;
  if (typeof raw.crosswalks === 'string' && (CROSSWALK_MODES as readonly string[]).includes(raw.crosswalks) && raw.crosswalks !== 'auto') n.crosswalks = raw.crosswalks as CrosswalkMode;
  if (typeof raw.signalMode === 'string' && (SIGNAL_MODES as readonly string[]).includes(raw.signalMode) && raw.signalMode !== 'fixed') n.signalMode = raw.signalMode as SignalMode;
  const g = num(raw.greenS);
  if (g !== undefined && Math.round(g) !== DEFAULT_GREEN_S) n.greenS = Math.min(120, Math.max(5, g));
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
  const waters = sanitizeWaters(obj.rivers, obj.lakes);
  if (waters.rivers.length) doc.rivers = waters.rivers;
  if (waters.lakes.length) doc.lakes = waters.lakes;
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
    ...(r.bridge ? { bridge: r.bridge } : {}),
    ...(r.bridgeParams ? { bridgeParams: { ...r.bridgeParams } } : {}),
    ...(r.startNode ? { startNode: r.startNode } : {}),
    ...(r.endNode ? { endNode: r.endNode } : {}),
    points: r.points.map((p) => ({ ...p })),
  };
}

export function cloneNode(n: NodeDef): NodeDef {
  return { ...n };
}
