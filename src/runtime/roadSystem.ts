// Owns the road network of a location (roads + junction nodes) and drives it with a cheap,
// budgeted per-frame resync() — the same shape as RiverField.resync()/PowerLines.resync(), but with an
// explicit budget because a road network is much larger than a handful of rivers.
//
// setNetwork() is diff-based: for every call it works out the junction layouts, the trims they impose
// on the road ends, and then only rebuilds the roads / junctions whose inputs actually changed
// (compared by object identity). Replacements are announced so views can keep showing the old version
// until the new one is complete.

import { PathCurve } from '../core/spline';
import { simToThree } from '../core/world';
import type { NodeDef, RoadDef } from '../network/types';
import { DEFAULT_CORNER_RADIUS_M } from '../network/types';
import { armsByNode, normalizeNetwork, type Arm } from '../network/graph';
import { openingsByRoad, switchGeometryKey, switchesByParent, type EdgeOpening } from '../network/attach';
import { layoutJunction, type ArmSpec, type Layout } from '../network/junction';
import type { TerrainSource } from '../core/terrain';
import type { ProfileData } from '../profile/types';
import { DEFAULT_BRIDGE, type BridgeData } from '../structures/types';
import { RoadRuntime, DEFAULT_RUNTIME_OPTIONS, type RoadChunk, type RoadRuntimeOptions } from './roadRuntime';
import { JunctionRuntime, type JunctionArm } from './junctionRuntime';

export interface ResyncBudget {
  /** how many pending chunks to inspect per call */
  checks: number;
  /** how many chunks / junction patches may actually be built per call */
  builds: number;
}

export const DEFAULT_BUDGET: ResyncBudget = { checks: 256, builds: 4 };

export type ChunkListener = (road: RoadRuntime, chunk: RoadChunk) => void;
export type RemovedListener = (road: RoadRuntime) => void;
export type ReplacedListener = (previous: RoadRuntime, next: RoadRuntime) => void;
export type JunctionListener = (junction: JunctionRuntime) => void;
export type JunctionReplacedListener = (previous: JunctionRuntime, next: JunctionRuntime) => void;
export type ProfileResolver = (def: RoadDef) => ProfileData;
export type BridgeResolver = (def: RoadDef, profile: ProfileData) => BridgeData;

/** centre-line curves per (immutable) road definition: unchanged roads keep their object identity across edits */
const curveCache = new WeakMap<RoadDef, PathCurve>();
function curveOf(def: RoadDef): PathCurve {
  let c = curveCache.get(def);
  if (!c) { c = new PathCurve(def.points.map((p) => simToThree(p.x, p.y, p.z))); curveCache.set(def, c); }
  return c;
}

/** bounding box of a road's points (cached per immutable definition) */
const boxCache = new WeakMap<RoadDef, { x0: number; x1: number; z0: number; z1: number }>();
function boxOf(def: RoadDef): { x0: number; x1: number; z0: number; z1: number } {
  let b = boxCache.get(def);
  if (!b) {
    b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const p of def.points) { b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x); b.z0 = Math.min(b.z0, p.z); b.z1 = Math.max(b.z1, p.z); }
    boxCache.set(def, b);
  }
  return b;
}

const sigCache = new WeakMap<RoadDef, string>();
function pointsSig(def: RoadDef): string {
  let s = sigCache.get(def);
  if (s === undefined) { s = def.id + ':' + def.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${p.mode ?? ''}`).join(';'); sigCache.set(def, s); }
  return s;
}

/** what a bridging road depends on besides its own definition: the other roads close to it (piers keep clear of roads below) */
function underSignature(def: RoadDef, all: readonly RoadDef[]): string {
  if (!def.points.some((p) => p.mode === 'bridge')) return '';
  const b = boxOf(def), m = 60;
  const near: string[] = [];
  for (const o of all) {
    if (o === def || o.id === def.id) continue;
    const q = boxOf(o);
    if (q.x0 - m <= b.x1 && q.x1 + m >= b.x0 && q.z0 - m <= b.z1 && q.z1 + m >= b.z0) near.push(pointsSig(o));
  }
  return near.join('|');
}

const openingsKey = (list: readonly EdgeOpening[]): string => list.map((o) => `${o.side}:${o.s0.toFixed(2)}:${o.s1.toFixed(2)}`).join(',');

/** a road end may never eat more than this fraction of the road */
const MAX_TRIM_FRACTION = 0.45;

export class RoadSystem {
  private roads: RoadRuntime[] = [];
  private junctionList: JunctionRuntime[] = [];
  private pending: Array<{ road: RoadRuntime; chunk: RoadChunk }> = [];
  private pendingJunctions: JunctionRuntime[] = [];
  private cursor = 0;

  /** the last inputs, so edits of single roads and profile changes can re-run the diff */
  private inputRoads: readonly RoadDef[] = [];
  private inputNodes: readonly NodeDef[] = [];

  /** roads whose terrain changed underneath them: rebuilt by the next diff even though their definition is the same */
  private stale = new Set<string>();
  private chunkListeners = new Set<ChunkListener>();
  private removedListeners = new Set<RemovedListener>();
  private replacedListeners = new Set<ReplacedListener>();
  private junctionReady = new Set<JunctionListener>();
  private junctionRemoved = new Set<JunctionListener>();
  private junctionReplaced = new Set<JunctionReplacedListener>();

  constructor(
    private readonly terrain: TerrainSource,
    private readonly resolveProfile: ProfileResolver,
    private readonly opts: RoadRuntimeOptions = DEFAULT_RUNTIME_OPTIONS,
    /** bridge type of a road (defaults to a plain concrete deck) */
    private readonly resolveBridge: BridgeResolver = () => DEFAULT_BRIDGE,
  ) {}

  get runtimes(): readonly RoadRuntime[] {
    return this.roads;
  }

  get junctions(): readonly JunctionRuntime[] {
    return this.junctionList;
  }

  // ---- setting the network ------------------------------------------------------

  /** Whole-list replace (diffed): only roads whose definition changed are rebuilt. */
  setRoads(defs: readonly RoadDef[]): void {
    this.setNetwork(defs, []);
  }

  setNetwork(roadsIn: readonly RoadDef[], nodesIn: readonly NodeDef[]): void {
    this.inputRoads = roadsIn;
    this.inputNodes = nodesIn;
    const net = normalizeNetwork(roadsIn.filter((r) => r.points.length >= 2), nodesIn);
    const nodeMap = new Map(net.nodes.map((n) => [n.id, n]));

    // profiles and centre-line curves (needed for the arm directions)
    const profiles = new Map<string, ProfileData>();
    const curves = new Map<string, PathCurve>();
    const defById = new Map<string, RoadDef>();
    for (const def of net.roads) {
      profiles.set(def.id, this.resolveProfile(def));
      curves.set(def.id, curveOf(def));
      defById.set(def.id, def);
    }

    // junction layouts → trims
    const trims = new Map<string, { start: number; end: number }>();
    const layouts = new Map<string, { layout: Layout; arms: Arm[] }>();
    for (const [nodeId, arms] of armsByNode(net.roads)) {
      const node = nodeMap.get(nodeId);
      if (!node) continue;
      const specs: ArmSpec[] = arms.map((a) => {
        const def = defById.get(a.roadId)!;
        const curve = curves.get(a.roadId)!;
        const prof = profiles.get(a.roadId)!;
        const t = curve.tangentAt(a.end === 'start' ? 0 : curve.length);
        const sign = a.end === 'start' ? 1 : -1;
        const l = Math.hypot(t.x, t.z) || 1;
        const pt = a.end === 'start' ? def.points[0] : def.points[def.points.length - 1];
        return { dir: { x: (sign * t.x) / l, z: (sign * t.z) / l }, halfWidth: prof.carriageHalfWidth * (pt.widthScale ?? 1) };
      });
      const layout = layoutJunction(specs, node.radius ?? DEFAULT_CORNER_RADIUS_M);
      layouts.set(nodeId, { layout, arms });
      arms.forEach((a, i) => {
        const tr = trims.get(a.roadId) ?? { start: 0, end: 0 };
        const len = curves.get(a.roadId)!.length;
        const v = Math.min(layout.setbacks[i], len * MAX_TRIM_FRACTION);
        if (a.end === 'start') tr.start = v; else tr.end = v;
        trims.set(a.roadId, tr);
      });
    }

    // where branches leave or join, the edge stays open (no railing, no guardrail)
    const openings = openingsByRoad(net.roads, (id) => curves.get(id)?.length ?? 0);
    const switches = switchesByParent(net.roads);

    // diff roads
    const oldById = new Map(this.roads.map((r) => [r.def.id, r]));
    const nextRoads: RoadRuntime[] = [];
    const replaced: Array<[RoadRuntime, RoadRuntime]> = [];
    for (const def of net.roads) {
      const trim = trims.get(def.id) ?? { start: 0, end: 0 };
      const prof = profiles.get(def.id)!;
      const bridge = this.resolveBridge(def, prof);
      const old = oldById.get(def.id);
      const open = openings.get(def.id) ?? [];
      const sw = switches.get(def.id) ?? [];
      const envKey = underSignature(def, net.roads) + '#' + openingsKey(open) + '#' + this.namedBridgeKey(def, prof) + '#' + switchGeometryKey(sw);
      if (old && old.def === def && old.profile === prof && old.bridge === bridge && old.trim.start === trim.start && old.trim.end === trim.end && old.envKey === envKey && !this.stale.has(def.id)) {
        nextRoads.push(old);
        continue;
      }
      const rt = new RoadRuntime(def, this.terrain, prof, this.opts, trim, bridge);
      rt.openings = open;
      rt.switches = sw;
      rt.envKey = envKey;
      rt.namedBridge = (name) => this.resolveBridge({ ...def, bridge: name, bridgeParams: undefined }, prof);
      nextRoads.push(rt);
      if (old) replaced.push([old, rt]);
    }
    const nextIds = new Set(net.roads.map((r) => r.id));
    const removedRoads = this.roads.filter((r) => !nextIds.has(r.def.id));

    // diff junctions
    const roadRt = new Map(nextRoads.map((r) => [r.def.id, r]));
    const oldJ = new Map(this.junctionList.map((j) => [j.id, j]));
    const nextJ: JunctionRuntime[] = [];
    const replacedJ: Array<[JunctionRuntime, JunctionRuntime]> = [];
    for (const [nodeId, { layout, arms }] of layouts) {
      const node = nodeMap.get(nodeId)!;
      const jarms: JunctionArm[] = arms.map((a) => ({ road: roadRt.get(a.roadId)!, end: a.end }));
      const old = oldJ.get(nodeId);
      const same =
        old && old.node === node && old.arms.length === jarms.length && old.arms.every((o, i) => o.road === jarms[i].road && o.end === jarms[i].end);
      if (same) { nextJ.push(old); continue; }
      const jr = new JunctionRuntime(node, jarms, layout, this.terrain);
      nextJ.push(jr);
      if (old) replacedJ.push([old, jr]);
    }
    const removedJ = this.junctionList.filter((j) => !layouts.has(j.id));

    // commit
    this.stale.clear();
    this.roads = nextRoads;
    for (const rt of nextRoads) rt.siblings = () => this.roads;
    this.junctionList = nextJ;
    this.pending = [];
    for (const rt of nextRoads) for (const chunk of rt.chunks) if (chunk.state === 'pending') this.pending.push({ road: rt, chunk });
    this.pendingJunctions = nextJ.filter((j) => j.state === 'pending');
    this.cursor = 0;

    for (const [a, b] of replaced) for (const cb of this.replacedListeners) cb(a, b);
    for (const r of removedRoads) for (const cb of this.removedListeners) cb(r);
    for (const [a, b] of replacedJ) for (const cb of this.junctionReplaced) cb(a, b);
    for (const j of removedJ) for (const cb of this.junctionRemoved) cb(j);
  }

  private bridgeIds = new WeakMap<BridgeData, number>();
  private bridgeIdCounter = 0;
  /** identity of the bridge types that points of a road name: the road is rebuilt when one of their codes changes */
  private namedBridgeKey(def: RoadDef, prof: ProfileData): string {
    const names = new Set<string>();
    for (const p of def.points) if (p.bridge) names.add(p.bridge);
    if (!names.size) return '';
    return [...names].sort().map((n) => {
      const b = this.resolveBridge({ ...def, bridge: n, bridgeParams: undefined }, prof);
      let id = this.bridgeIds.get(b);
      if (id === undefined) { id = ++this.bridgeIdCounter; this.bridgeIds.set(b, id); }
      return `${n}=${id}`;
    }).join(',');
  }

  /** Add a road or replace the one with the same id (used for drafts and tests). */
  upsertRoad(def: RoadDef): void {
    const i = this.inputRoads.findIndex((r) => r.id === def.id);
    const roads = this.inputRoads.slice();
    if (i >= 0) roads[i] = def; else roads.push(def);
    this.setNetwork(roads, this.inputNodes);
  }

  removeRoad(id: string): void {
    if (!this.inputRoads.some((r) => r.id === id)) return;
    this.setNetwork(this.inputRoads.filter((r) => r.id !== id), this.inputNodes);
  }

  /** Re-run the diff with the current inputs (after a profile's code changed, its resolved object differs). */
  refresh(): void {
    this.setNetwork(this.inputRoads, this.inputNodes);
  }

  /**
   * The terrain changed inside `rect` (a river was carved, a lake dug …): every road whose points come near it is rebuilt from the
   * new ground — the old meshes stay visible until the new ones are complete. Returns how many roads were affected.
   */
  invalidateRect(rect: { minX: number; minZ: number; maxX: number; maxZ: number }, marginM = 60): number {
    let n = 0;
    for (const def of this.inputRoads) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of def.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
      if (minX - marginM <= rect.maxX && maxX + marginM >= rect.minX && minZ - marginM <= rect.maxZ && maxZ + marginM >= rect.minZ) { this.stale.add(def.id); n++; }
    }
    if (n) this.refresh();
    return n;
  }

  /** @deprecated use refresh() */
  rebuildAll(): void { this.refresh(); }
  rebuildProfile(_name: string): void { this.refresh(); }

  // ---- listeners ------------------------------------------------------------------

  /** Called whenever a chunk's heights have been resolved (the mesh layer builds its mesh here). */
  onChunkReady(cb: ChunkListener): () => void {
    this.chunkListeners.add(cb);
    return () => this.chunkListeners.delete(cb);
  }
  onRoadRemoved(cb: RemovedListener): () => void {
    this.removedListeners.add(cb);
    return () => this.removedListeners.delete(cb);
  }
  onRoadReplaced(cb: ReplacedListener): () => void {
    this.replacedListeners.add(cb);
    return () => this.replacedListeners.delete(cb);
  }
  onJunctionReady(cb: JunctionListener): () => void {
    this.junctionReady.add(cb);
    return () => this.junctionReady.delete(cb);
  }
  onJunctionRemoved(cb: JunctionListener): () => void {
    this.junctionRemoved.add(cb);
    return () => this.junctionRemoved.delete(cb);
  }
  onJunctionReplaced(cb: JunctionReplacedListener): () => void {
    this.junctionReplaced.add(cb);
    return () => this.junctionReplaced.delete(cb);
  }

  // ---- progress -------------------------------------------------------------------

  stats(): { chunks: number; ready: number } {
    let chunks = 0;
    let ready = 0;
    for (const r of this.roads) {
      chunks += r.chunks.length;
      ready += r.chunks.length - r.pendingCount;
    }
    return { chunks, ready };
  }

  junctionStats(): { total: number; ready: number } {
    return { total: this.junctionList.length, ready: this.junctionList.filter((j) => j.state === 'ready').length };
  }

  /** Cheap per-frame poll. Returns the number of chunks / patches built this call. */
  resync(budget: ResyncBudget = DEFAULT_BUDGET): number {
    let built = 0;
    let checks = 0;
    const n = this.pending.length;
    let visited = 0;
    while (visited < n && checks < budget.checks && built < budget.builds) {
      if (this.cursor >= this.pending.length) this.cursor = 0;
      const entry = this.pending[this.cursor];
      if (!entry) break;
      visited++;
      checks++;
      if (entry.road.tryBuildChunk(entry.chunk)) {
        built++;
        this.pending.splice(this.cursor, 1);
        for (const cb of this.chunkListeners) cb(entry.road, entry.chunk);
      } else {
        this.cursor++;
      }
    }
    // junction patches (they wait for their arms' end chunks, so they naturally come after the roads)
    for (let i = 0; i < this.pendingJunctions.length && built < budget.builds + 8; ) {
      const j = this.pendingJunctions[i];
      if (j.tryBuild()) {
        built++;
        this.pendingJunctions.splice(i, 1);
        for (const cb of this.junctionReady) cb(j);
      } else {
        i++;
      }
    }
    return built;
  }
}
