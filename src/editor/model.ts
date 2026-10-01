// The editable road document: a list of immutable road snapshots plus undo/redo.
// Every edit replaces a road with a new snapshot (never mutates one), so other
// parts (RoadSystem runtimes, mesh layer) can hold on to old snapshots safely.
// Edits that share a `coalesceKey` within a short window (slider drags, handle
// drags) merge into one undo step.

import { cloneRoad, sanitizeRoadsDocument } from '../network/doc';
import type { RoadDef, RoadsDocument } from '../network/types';
import { ROADS_DOC_VERSION } from '../network/types';

export type ModelEvent =
  | { type: 'road'; road: RoadDef }          // added or replaced
  | { type: 'remove'; id: string }
  | { type: 'reset' }                        // whole document replaced
  | { type: 'history' };                     // undo/redo availability or dirty state changed

interface Command {
  label: string;
  key?: string;
  time: number;
  id: string;
  /** state before/after; null = road does not exist */
  before: RoadDef | null;
  after: RoadDef | null;
  /** position in the list when removed, to restore order on undo */
  index: number;
}

const COALESCE_MS = 900;
const HISTORY_LIMIT = 200;

export class RoadModel {
  private roads: RoadDef[] = [];
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<(e: ModelEvent) => void>();
  private coalescing = true;
  private hold: string | null = null;
  private savedMark = 0; // undo depth at last save (-1 = unreachable)
  /** server revision this document is based on */
  revision: number | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  // ---- reading ----

  get list(): readonly RoadDef[] {
    return this.roads;
  }

  get(id: string): RoadDef | undefined {
    return this.roads.find((r) => r.id === id);
  }

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
    this.roads = clean.roads;
    this.revision = clean.revision;
    this.undoStack = [];
    this.redoStack = [];
    this.savedMark = 0;
    this.emit({ type: 'reset' });
    this.emit({ type: 'history' });
  }

  toDocument(): RoadsDocument {
    return { version: ROADS_DOC_VERSION, ...(this.revision !== undefined ? { revision: this.revision } : {}), roads: this.roads.map(cloneRoad) };
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

  addRoad(road: RoadDef, label = 'Straße hinzufügen'): void {
    const snap = cloneRoad(road);
    this.apply({ label, time: this.now(), id: snap.id, before: null, after: snap, index: this.roads.length });
  }

  removeRoad(id: string, label = 'Straße löschen'): void {
    const idx = this.roads.findIndex((r) => r.id === id);
    if (idx < 0) return;
    this.apply({ label, time: this.now(), id, before: this.roads[idx], after: null, index: idx });
  }

  /** Edit a road: `fn` receives a private copy to mutate. Returns the new snapshot. */
  edit(id: string, label: string, fn: (draft: RoadDef) => void, coalesceKey?: string): RoadDef | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const draft = cloneRoad(cur);
    fn(draft);
    draft.id = id; // ids are stable
    if (draft.points.length < 2) {
      this.removeRoad(id, label);
      return undefined;
    }
    this.apply({ label, key: coalesceKey, time: this.now(), id, before: cur, after: draft, index: this.roads.indexOf(cur) });
    return draft;
  }

  private apply(cmd: Command): void {
    const top = this.undoStack[this.undoStack.length - 1];
    const merge =
      this.coalescing && cmd.key !== undefined && top && top.key === cmd.key && top.id === cmd.id &&
      (this.hold === cmd.key || cmd.time - top.time < COALESCE_MS) && this.redoStack.length === 0 && this.savedMark !== this.undoStack.length;
    this.coalescing = true;
    if (merge) {
      top.after = cmd.after;
      top.time = cmd.time;
      this.set(cmd.id, cmd.after, cmd.index);
      this.emit({ type: 'history' });
      return;
    }
    this.set(cmd.id, cmd.after, cmd.index);
    this.undoStack.push(cmd);
    if (this.undoStack.length > HISTORY_LIMIT) {
      this.undoStack.shift();
      this.savedMark = this.savedMark > 0 ? this.savedMark - 1 : -1;
    }
    this.redoStack = [];
    this.emit({ type: 'history' });
  }

  private set(id: string, road: RoadDef | null, index: number): void {
    const idx = this.roads.findIndex((r) => r.id === id);
    if (road === null) {
      if (idx >= 0) this.roads.splice(idx, 1);
      this.emit({ type: 'remove', id });
    } else {
      if (idx >= 0) this.roads[idx] = road;
      else this.roads.splice(Math.min(index, this.roads.length), 0, road);
      this.emit({ type: 'road', road });
    }
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this.set(cmd.id, cmd.before, cmd.index);
    this.redoStack.push(cmd);
    this.coalescing = false;
    this.emit({ type: 'history' });
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this.set(cmd.id, cmd.after, cmd.index);
    this.undoStack.push(cmd);
    this.coalescing = false;
    this.emit({ type: 'history' });
    return true;
  }
}
