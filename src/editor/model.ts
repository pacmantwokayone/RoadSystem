// The editable road network (roads + junction nodes) with undo/redo.
//
// State is an immutable snapshot { roads, nodes } of immutable objects. Every edit builds a new
// snapshot that shares all unchanged objects with the old one; history is just a stack of
// (before, after) snapshot pairs. That makes compound edits — split a road, create a node, connect
// two roads — a single undo step, and lets the RoadSystem diff by object identity.
// Edits that share a `coalesceKey` within a short window (slider drags) — or inside an explicitly
// held gesture (handle drags) — merge into one undo step.

import { cloneNode, cloneRoad, sanitizeRoadsDocument } from '../network/doc';
import { normalizeNetwork } from '../network/graph';
import type { NodeDef, RoadDef, RoadsDocument } from '../network/types';
import { cloneLake, cloneRiver, normalizeWaters, sanitizeWaters, type LakeDef, type RiverDef } from '../water/types';
import { ROADS_DOC_VERSION } from '../network/types';

export type ModelEvent =
  | { type: 'road'; road: RoadDef }          // added or replaced
  | { type: 'remove'; id: string }
  | { type: 'nodes' }                        // the node list changed
  | { type: 'water' }                        // rivers or lakes changed
  | { type: 'reset' }                        // whole document replaced
  | { type: 'changed' }                      // exactly once after every change of the network
  | { type: 'history' };                     // undo/redo availability or dirty state changed

export interface Snapshot {
  readonly roads: readonly RoadDef[];
  readonly nodes: readonly NodeDef[];
  readonly rivers: readonly RiverDef[];
  readonly lakes: readonly LakeDef[];
}

/** Mutable working copy handed to `transact`; arrays are private copies, objects must be replaced not mutated. */
export class NetworkDraft {
  roads: RoadDef[];
  nodes: NodeDef[];
  rivers: RiverDef[];
  lakes: LakeDef[];

  constructor(snap: Pick<Snapshot, 'roads' | 'nodes'> & Partial<Snapshot>) {
    this.roads = snap.roads.slice();
    this.nodes = snap.nodes.slice();
    this.rivers = (snap.rivers ?? []).slice();
    this.lakes = (snap.lakes ?? []).slice();
  }

  river(id: string): RiverDef | undefined { return this.rivers.find((r) => r.id === id); }
  setRiver(r: RiverDef): void {
    const i = this.rivers.findIndex((x) => x.id === r.id);
    if (i >= 0) this.rivers[i] = r; else this.rivers.push(r);
  }
  removeRiver(id: string): void { this.rivers = this.rivers.filter((r) => r.id !== id); }
  editRiver(id: string, fn: (draft: RiverDef) => void): RiverDef | undefined {
    const cur = this.river(id);
    if (!cur) return undefined;
    const d = cloneRiver(cur);
    fn(d);
    d.id = id;
    this.setRiver(d);
    return d;
  }

  lake(id: string): LakeDef | undefined { return this.lakes.find((l) => l.id === id); }
  setLake(l: LakeDef): void {
    const i = this.lakes.findIndex((x) => x.id === l.id);
    if (i >= 0) this.lakes[i] = l; else this.lakes.push(l);
  }
  removeLake(id: string): void { this.lakes = this.lakes.filter((l) => l.id !== id); }
  editLake(id: string, fn: (draft: LakeDef) => void): LakeDef | undefined {
    const cur = this.lake(id);
    if (!cur) return undefined;
    const d = cloneLake(cur);
    fn(d);
    d.id = id;
    this.setLake(d);
    return d;
  }

  road(id: string): RoadDef | undefined { return this.roads.find((r) => r.id === id); }
  node(id: string): NodeDef | undefined { return this.nodes.find((n) => n.id === id); }

  setRoad(road: RoadDef): void {
    const i = this.roads.findIndex((r) => r.id === road.id);
    if (i >= 0) this.roads[i] = road; else this.roads.push(road);
  }
  removeRoad(id: string): void { this.roads = this.roads.filter((r) => r.id !== id); }

  /** Edit a copy of a road in place of the original. */
  editRoad(id: string, fn: (draft: RoadDef) => void): RoadDef | undefined {
    const cur = this.road(id);
    if (!cur) return undefined;
    const d = cloneRoad(cur);
    fn(d);
    d.id = id;
    this.setRoad(d);
    return d;
  }

  setNode(node: NodeDef): void {
    const i = this.nodes.findIndex((n) => n.id === node.id);
    if (i >= 0) this.nodes[i] = node; else this.nodes.push(node);
  }
  removeNode(id: string): void { this.nodes = this.nodes.filter((n) => n.id !== id); }
  editNode(id: string, fn: (draft: NodeDef) => void): NodeDef | undefined {
    const cur = this.node(id);
    if (!cur) return undefined;
    const d = cloneNode(cur);
    fn(d);
    d.id = id;
    this.setNode(d);
    return d;
  }
}

interface Entry {
  label: string;
  key?: string;
  time: number;
  before: Snapshot;
  after: Snapshot;
}

const COALESCE_MS = 900;
const HISTORY_LIMIT = 200;

const sameList = <T,>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export class RoadModel {
  private snap: Snapshot = { roads: [], nodes: [], rivers: [], lakes: [] };
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<(e: ModelEvent) => void>();
  private coalescing = true;
  private hold: string | null = null;
  private savedMark = 0; // undo depth at last save (-1 = unreachable)
  /** server revision this document is based on */
  revision: number | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  // ---- reading ----

  get list(): readonly RoadDef[] { return this.snap.roads; }
  get nodeList(): readonly NodeDef[] { return this.snap.nodes; }
  get riverList(): readonly RiverDef[] { return this.snap.rivers; }
  get lakeList(): readonly LakeDef[] { return this.snap.lakes; }
  getRiver(id: string): RiverDef | undefined { return this.snap.rivers.find((r) => r.id === id); }
  getLake(id: string): LakeDef | undefined { return this.snap.lakes.find((l) => l.id === id); }
  get(id: string): RoadDef | undefined { return this.snap.roads.find((r) => r.id === id); }
  getNode(id: string): NodeDef | undefined { return this.snap.nodes.find((n) => n.id === id); }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | undefined { return this.undoStack[this.undoStack.length - 1]?.label; }
  get redoLabel(): string | undefined { return this.redoStack[this.redoStack.length - 1]?.label; }
  get dirty(): boolean { return this.savedMark !== this.undoStack.length; }

  onChange(cb: (e: ModelEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: ModelEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  // ---- loading / saving ----

  load(doc: RoadsDocument): void {
    const clean = sanitizeRoadsDocument(doc);
    this.snap = { roads: clean.roads, nodes: clean.nodes ?? [], rivers: clean.rivers ?? [], lakes: clean.lakes ?? [] };
    this.revision = clean.revision;
    this.undoStack = [];
    this.redoStack = [];
    this.savedMark = 0;
    this.emit({ type: 'reset' });
    this.emit({ type: 'changed' });
    this.emit({ type: 'history' });
  }

  toDocument(): RoadsDocument {
    return {
      version: ROADS_DOC_VERSION,
      ...(this.revision !== undefined ? { revision: this.revision } : {}),
      roads: this.snap.roads.map(cloneRoad),
      ...(this.snap.nodes.length ? { nodes: this.snap.nodes.map(cloneNode) } : {}),
      ...(this.snap.rivers.length ? { rivers: this.snap.rivers.map(cloneRiver) } : {}),
      ...(this.snap.lakes.length ? { lakes: this.snap.lakes.map(cloneLake) } : {}),
    };
  }

  markSaved(revision: number): void {
    this.revision = revision;
    this.savedMark = this.undoStack.length;
    this.emit({ type: 'history' });
  }

  // ---- editing ----

  /** Ends the current coalescing run (call on pointer-up, blur, …). */
  breakCoalesce(): void {
    this.coalescing = false;
  }

  /**
   * Hold a gesture open: edits with exactly this key merge into one undo step no matter how
   * much time passes between them (a drag on a slow frame is still one step).
   * Pass null to end the gesture.
   */
  holdCoalesce(key: string | null): void {
    this.hold = key;
    if (key === null) this.coalescing = false;
  }

  /** One undoable step that may touch any number of roads and nodes. Returns false if nothing changed. */
  transact(label: string, fn: (draft: NetworkDraft) => void, coalesceKey?: string): boolean {
    const draft = new NetworkDraft(this.snap);
    fn(draft);
    const net = normalizeNetwork(draft.roads.filter((r) => r.points.length >= 2), draft.nodes);
    const water = normalizeWaters(draft.rivers.filter((r) => r.points.length >= 2), draft.lakes.filter((l) => l.outline.length >= 3));
    const after: Snapshot = { roads: net.roads, nodes: net.nodes, rivers: water.rivers, lakes: water.lakes };
    if (sameList(after.roads, this.snap.roads) && sameList(after.nodes, this.snap.nodes) && sameList(after.rivers, this.snap.rivers) && sameList(after.lakes, this.snap.lakes)) return false;
    this.commit({ label, key: coalesceKey, time: this.now(), before: this.snap, after });
    return true;
  }

  addRiver(river: RiverDef, label = 'Fluss hinzufügen'): void {
    this.transact(label, (d) => d.setRiver(cloneRiver(river)));
  }

  addLake(lake: LakeDef, label = 'See hinzufügen'): void {
    this.transact(label, (d) => d.setLake(cloneLake(lake)));
  }

  editRiver(id: string, label: string, fn: (draft: RiverDef) => void, coalesceKey?: string): RiverDef | undefined {
    if (!this.getRiver(id)) return undefined;
    this.transact(label, (d) => { d.editRiver(id, fn); }, coalesceKey);
    return this.getRiver(id);
  }

  editLake(id: string, label: string, fn: (draft: LakeDef) => void, coalesceKey?: string): LakeDef | undefined {
    if (!this.getLake(id)) return undefined;
    this.transact(label, (d) => { d.editLake(id, fn); }, coalesceKey);
    return this.getLake(id);
  }

  addRoad(road: RoadDef, label = 'Straße hinzufügen'): void {
    this.transact(label, (d) => d.setRoad(cloneRoad(road)));
  }

  removeRoad(id: string, label = 'Straße löschen'): void {
    this.transact(label, (d) => d.removeRoad(id));
  }

  /** Edit a road: `fn` receives a private copy to mutate. Returns the new snapshot (undefined if the road is gone). */
  edit(id: string, label: string, fn: (draft: RoadDef) => void, coalesceKey?: string): RoadDef | undefined {
    if (!this.get(id)) return undefined;
    this.transact(label, (d) => { d.editRoad(id, fn); }, coalesceKey);
    return this.get(id);
  }

  private commit(entry: Entry): void {
    const top = this.undoStack[this.undoStack.length - 1];
    const merge =
      this.coalescing && entry.key !== undefined && top && top.key === entry.key &&
      (this.hold === entry.key || entry.time - top.time < COALESCE_MS) &&
      this.redoStack.length === 0 && this.savedMark !== this.undoStack.length;
    this.coalescing = true;
    const prev = this.snap;
    this.snap = entry.after;
    if (merge) {
      top.after = entry.after;
      top.time = entry.time;
    } else {
      this.undoStack.push(entry);
      if (this.undoStack.length > HISTORY_LIMIT) {
        this.undoStack.shift();
        this.savedMark = this.savedMark > 0 ? this.savedMark - 1 : -1;
      }
      this.redoStack = [];
    }
    this.emitDiff(prev, entry.after);
    this.emit({ type: 'history' });
  }

  private emitDiff(a: Snapshot, b: Snapshot): void {
    const before = new Map(a.roads.map((r) => [r.id, r]));
    const after = new Set<string>();
    for (const r of b.roads) {
      after.add(r.id);
      if (before.get(r.id) !== r) this.emit({ type: 'road', road: r });
    }
    for (const id of before.keys()) if (!after.has(id)) this.emit({ type: 'remove', id });
    if (!sameList(a.nodes, b.nodes)) this.emit({ type: 'nodes' });
    if (!sameList(a.rivers, b.rivers) || !sameList(a.lakes, b.lakes)) this.emit({ type: 'water' });
    this.emit({ type: 'changed' });
  }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    const prev = this.snap;
    this.snap = e.before;
    this.redoStack.push(e);
    this.coalescing = false;
    this.emitDiff(prev, this.snap);
    this.emit({ type: 'history' });
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    const prev = this.snap;
    this.snap = e.after;
    this.undoStack.push(e);
    this.coalescing = false;
    this.emitDiff(prev, this.snap);
    this.emit({ type: 'history' });
    return true;
  }
}
