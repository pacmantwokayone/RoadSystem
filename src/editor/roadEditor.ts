// RoadEditor: viewport interaction + document state. Host-agnostic — the game (or the
// demo) supplies an EditorHost; the editor never touches game code.
//
//   select tool : click a road to select · drag a handle to move a point ·
//                 Shift+click / double-click on the selected road inserts a point ·
//                 Delete removes the selected point
//   draw tool   : click appends points · Enter finishes · Backspace removes the last · Esc cancels
//   Ctrl+Z / Ctrl+Y undo/redo · Ctrl+S save

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { ProfileLibrary } from '../profile/library';
import type { MaterialRegistry } from '../surface/materials';
import { DEFAULT_MATERIAL_SOURCES, type MaterialLibrary } from '../surface/materialLibrary';
import type { RoadStore } from '../store/types';
import { cloneRoad } from '../network/doc';
import { isFixedPoint, type NodeDef, type RoadDef, type RoadPoint } from '../network/types';
import { armsByNode, type End } from '../network/graph';
import { RoadModel, type ModelEvent } from './model';
import { nearestRoad, pointAtS, projectOnRoad } from './pathTools';
import { connectEnd, defaultIds, dissolveNode, findConnectTarget, moveNode, setNodeRadius, type ConnectTarget } from './ops';
import { PRESET_SOURCES } from '../profile/presets';

export interface EditorHost {
  scene: THREE.Scene;
  camera: THREE.Camera;
  domElement: HTMLElement;
  /** ground hit under a pointer event, THREE space; null = nothing hit */
  pickGround(ev: { clientX: number; clientY: number }): THREE.Vector3 | null;
  /** disable/enable the game's camera controls (while a handle is dragged) */
  setCameraEnabled(on: boolean): void;
  /** where the editor mounts its panels */
  uiRoot: HTMLElement;
}

export interface EditorDeps {
  host: EditorHost;
  system: RoadSystem;
  library: ProfileLibrary;
  materials: MaterialRegistry;
  /** code-based materials (editable in the editor); when given, `materials` is bound to it */
  materialLibrary?: MaterialLibrary;
  store: RoadStore;
  location: string;
  /** road meshes (RoadMeshLayer.group): lets clicks hit the road surface, not just the terrain behind it */
  roadGroup?: THREE.Object3D;
  /** ask the user; default window.confirm */
  confirm?: (message: string) => boolean;
}

export type Tool = 'select' | 'draw';
export type StatusKind = 'info' | 'ok' | 'error';

export interface EditorState {
  tool: Tool;
  roadId?: string;
  pointIndex?: number;
  /** selected junction */
  nodeId?: string;
  activeProfile: string;
  status: { text: string; kind: StatusKind };
  libraryDirty: boolean;
}

const HANDLE_PX = 0.014; // handle radius as a fraction of camera distance
const PICK_ROAD_M = 9;
const EDIT_BUDGET = { checks: 512, builds: 24 };

export class RoadEditor {
  readonly model = new RoadModel();
  readonly state: EditorState;
  readonly handles = new THREE.Group();
  private readonly host: EditorHost;
  private readonly system: RoadSystem;
  private readonly library: ProfileLibrary;
  private readonly store: RoadStore;
  private readonly location: string;
  private readonly confirmFn: (m: string) => boolean;
  private readonly roadGroup: THREE.Object3D | undefined;
  readonly materialLibrary: MaterialLibrary | undefined;
  readonly materials: MaterialRegistry;
  private listeners = new Set<() => void>();
  private draft: RoadDef | null = null;
  private libraryRevision: number | undefined;
  private handleMeshes: THREE.Mesh[] = [];
  private handlesDirty = true;
  private drag: { pointer: number; kind: 'point' | 'node'; index: number; nodeId?: string } | null = null;
  private nodeMeshes: THREE.Mesh[] = [];
  private down: { x: number; y: number; t: number; shift: boolean } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly cleanups: Array<() => void> = [];
  private readonly sphere = new THREE.SphereGeometry(1, 14, 10);
  private lastClickTime = 0;
  private lastProgress = '';
  private lastProgressEmit = 0;

  constructor(deps: EditorDeps) {
    this.host = deps.host;
    this.system = deps.system;
    this.library = deps.library;
    this.store = deps.store;
    this.location = deps.location;
    this.roadGroup = deps.roadGroup;
    this.confirmFn = deps.confirm ?? ((m) => (typeof window !== 'undefined' ? window.confirm(m) : true));
    this.state = {
      tool: 'select',
      activeProfile: this.library.names().includes('hauptstrasse') ? 'hauptstrasse' : this.library.names()[0],
      status: { text: '', kind: 'info' },
      libraryDirty: false,
    };
    this.handles.name = 'road-editor-handles';
    this.host.scene.add(this.handles);
    this.materials = deps.materials;
    this.materialLibrary = deps.materialLibrary;
    if (this.materialLibrary) {
      this.cleanups.push(deps.materials.bind(this.materialLibrary));
      this.cleanups.push(this.materialLibrary.onChange(() => this.emit()));
    }

    this.cleanups.push(this.model.onChange((e) => this.onModel(e)));
    this.cleanups.push(this.library.onChange((name) => {
      this.system.rebuildProfile(name);
      this.emit();
    }));
    this.cleanups.push(this.system.onChunkReady(() => { this.handlesDirty = true; }));
    this.bindInput();
  }

  // ---- state / events ------------------------------------------------------

  onState(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  setStatus(text: string, kind: StatusKind = 'info'): void {
    this.state.status = { text, kind };
    this.emit();
  }

  get selectedRoad(): RoadDef | undefined {
    return this.state.roadId ? this.model.get(this.state.roadId) ?? (this.draft?.id === this.state.roadId ? this.draft : undefined) : undefined;
  }

  get isDirty(): boolean {
    return this.model.dirty || this.state.libraryDirty;
  }

  // ---- model → system ------------------------------------------------------

  private onModel(e: ModelEvent): void {
    switch (e.type) {
      case 'remove':
        if (this.state.roadId === e.id) { this.state.roadId = undefined; this.state.pointIndex = undefined; }
        break;
      case 'reset':
        this.state.roadId = undefined; this.state.pointIndex = undefined; this.state.nodeId = undefined;
        break;
      case 'changed':
        // one sync per change: the system diffs by identity and rebuilds only what differs
        this.system.setNetwork(this.model.list, this.model.nodeList);
        if (this.state.nodeId && !this.model.getNode(this.state.nodeId)) this.state.nodeId = undefined;
        this.handlesDirty = true;
        break;
      default: break;
    }
    this.emit();
  }

  // ---- load / save ---------------------------------------------------------

  async load(): Promise<void> {
    const lib = await this.store.loadLibrary();
    if (lib) {
      for (const [name, src] of Object.entries(lib.profiles)) this.library.setSource(name, src);
      for (const [name, src] of Object.entries(lib.materials ?? {})) this.materialLibrary?.setSource(name, src);
      this.libraryRevision = lib.revision;
    }
    const doc = await this.store.loadRoads(this.location);
    this.model.load(doc ?? { version: 1, roads: [] });
    this.state.libraryDirty = false;
    this.setStatus(doc ? `Geladen (Revision ${doc.revision ?? 0}, ${doc.roads.length} Straßen)` : 'Keine gespeicherten Straßen – neu angelegt', 'info');
  }

  /** Saves profiles (if changed) and roads. Handles revision conflicts by asking the user. */
  async save(): Promise<boolean> {
    let ok = true;
    if (this.state.libraryDirty) {
      ok = await this.saveWithConflict(
        (base) => this.store.saveLibrary({ version: 1, profiles: this.library.allSources(), ...(this.materialLibrary ? { materials: this.materialLibrary.allSources() } : {}) }, base),
        this.libraryRevision, 'Profile',
        (rev) => { this.libraryRevision = rev; this.state.libraryDirty = false; },
      );
    }
    if (ok) {
      ok = await this.saveWithConflict(
        (base) => this.store.saveRoads(this.location, this.model.toDocument(), base),
        this.model.revision, 'Straßen',
        (rev) => this.model.markSaved(rev),
      );
    }
    if (ok) this.setStatus(`Gespeichert (Revision ${this.model.revision})`, 'ok');
    return ok;
  }

  private async saveWithConflict(
    run: (base: number | undefined) => Promise<import('../store/types').SaveResult>,
    base: number | undefined, what: string, onOk: (rev: number) => void,
  ): Promise<boolean> {
    let res = await run(base);
    if (!res.ok && res.conflict) {
      const rev = res.serverRevision !== undefined ? ` (Revision ${res.serverRevision})` : '';
      if (!this.confirmFn(`${what}: Auf dem Server gibt es eine neuere Version${rev}.\nTrotzdem überschreiben?`)) {
        this.setStatus(`${what}: Speichern abgebrochen – Server hat neuere Version. „Neu laden“ holt sie.`, 'error');
        return false;
      }
      res = await run(undefined);
    }
    if (res.ok) { onOk(res.revision); return true; }
    this.setStatus(`${what}: Speichern fehlgeschlagen – ${res.conflict ? 'Konflikt' : res.error}`, 'error');
    return false;
  }

  async reload(): Promise<void> {
    if (this.isDirty && !this.confirmFn('Ungespeicherte Änderungen verwerfen und neu laden?')) return;
    await this.load();
  }

  // ---- selection -----------------------------------------------------------

  setTool(tool: Tool): void {
    if (this.state.tool === tool) return;
    if (this.draft) this.cancelDraft();
    this.state.tool = tool;
    this.host.domElement.style.cursor = tool === 'draw' ? 'crosshair' : '';
    this.emit();
  }

  selectRoad(id: string | undefined): void {
    this.state.roadId = id;
    this.state.pointIndex = undefined;
    this.state.nodeId = undefined;
    this.handlesDirty = true;
    this.emit();
  }

  selectNode(id: string | undefined): void {
    this.state.nodeId = id;
    this.state.roadId = undefined;
    this.state.pointIndex = undefined;
    this.handlesDirty = true;
    this.emit();
  }

  selectPoint(index: number | undefined): void {
    this.state.pointIndex = index;
    this.handlesDirty = true;
    this.emit();
  }

  // ---- edits (called by input handling and the panels) ---------------------

  rename(name: string): void {
    const id = this.state.roadId;
    if (id) this.model.edit(id, 'Straße umbenennen', (d) => { d.name = name; }, `name:${id}`);
  }

  setProfile(name: string): void {
    const id = this.state.roadId;
    if (!id) return;
    this.model.edit(id, 'Profil wechseln', (d) => { d.profile = name; delete d.params; });
  }

  setParam(key: string, value: number | boolean | string): void {
    const id = this.state.roadId;
    if (id) this.model.edit(id, 'Parameter ändern', (d) => { d.params = { ...d.params, [key]: value }; }, `param:${id}:${key}`);
  }

  setPointAttr(index: number, patch: Partial<RoadPoint>): void {
    const id = this.state.roadId;
    if (!id) return;
    const key = `attr:${id}:${index}:${Object.keys(patch).join(',')}`;
    this.model.edit(id, 'Punkt ändern', (d) => {
      const p = d.points[index];
      if (!p) return;
      for (const [k, v] of Object.entries(patch)) {
        const neutral = (k === 'mode' && v === 'road') || (k === 'elev' && v === 'drape') || (k === 'widthScale' && v === 1) || (k === 'banking' && v === 0);
        if (neutral) delete (p as unknown as Record<string, unknown>)[k];
        else (p as unknown as Record<string, unknown>)[k] = v;
      }
    }, key);
  }

  /** Is point `index` of road `id` an end that hangs on a junction? */
  isNodeEnd(id: string, index: number): boolean {
    const r = this.model.get(id) ?? (this.draft?.id === id ? this.draft : undefined);
    if (!r) return false;
    return (index === 0 && !!r.startNode) || (index === r.points.length - 1 && !!r.endNode);
  }

  deleteSelectedPoint(): void {
    const id = this.state.roadId, idx = this.state.pointIndex;
    if (!id || idx === undefined) return;
    if (this.isNodeEnd(id, idx)) {
      this.setStatus('Dieser Endpunkt hängt an einer Kreuzung – Kreuzung zuerst auflösen.', 'error');
      return;
    }
    this.model.edit(id, 'Punkt löschen', (d) => { d.points.splice(idx, 1); });
    this.state.pointIndex = undefined;
    this.handlesDirty = true;
    this.emit();
  }

  deleteSelectedRoad(): void {
    if (this.state.roadId) this.model.removeRoad(this.state.roadId);
  }

  // ---- junctions -------------------------------------------------------------

  get selectedNode(): NodeDef | undefined {
    return this.state.nodeId ? this.model.getNode(this.state.nodeId) : undefined;
  }

  /** The road ends meeting at a node, with road names (for the inspector). */
  nodeArms(id: string): Array<{ roadId: string; name: string; end: End }> {
    return (armsByNode(this.model.list).get(id) ?? []).map((a) => ({ roadId: a.roadId, end: a.end, name: this.model.get(a.roadId)?.name ?? a.roadId }));
  }

  setNodeRadius(radius: number): void {
    const id = this.state.nodeId;
    if (id) this.model.transact('Kurvenradius ändern', (d) => setNodeRadius(d, id, radius), `radius:${id}`);
  }

  dissolveSelectedNode(): void {
    const id = this.state.nodeId;
    if (!id) return;
    this.model.transact('Kreuzung auflösen', (d) => dissolveNode(d, id));
    this.selectNode(undefined);
  }

  private connectTargets(): Array<{ def: RoadDef; sampled: import('../core/sampling').SampledRoad }> {
    return this.system.runtimes.map((r) => ({ def: r.def, sampled: r.sampled }));
  }

  /** What would an end of `roadId` at (x, zThree) connect to? */
  private targetAt(x: number, zThree: number, roadId: string): ConnectTarget | undefined {
    return findConnectTarget(this.connectTargets(), this.model.nodeList, x, zThree, { snapM: 9, roadSnapM: 7, endMarginM: 10, excludeRoad: roadId });
  }

  insertPoint(roadId: string, x: number, zThree: number, groundY?: number): void {
    const rt = this.system.runtimes.find((r) => r.def.id === roadId);
    if (!rt) return;
    const pr = projectOnRoad(rt.sampled, x, zThree);
    const { index, point } = pointAtS(rt.def, rt.sampled, pr.s, groundY);
    this.model.edit(roadId, 'Punkt einfügen', (d) => { d.points.splice(index, 0, point); });
    this.selectPoint(index);
  }

  undo(): void { this.cancelDraft(); this.model.undo(); }
  redo(): void { this.cancelDraft(); this.model.redo(); }

  // ---- profile code (live) ---------------------------------------------------

  /** Compile and activate profile code. On error the previous version stays active. */
  applyProfileSource(name: string, source: string): { ok: boolean; error?: string } {
    const r = this.library.setSource(name, source);
    if (r.ok) { this.state.libraryDirty = true; this.emit(); }
    return r;
  }

  // ---- material code (live) --------------------------------------------------

  /** Compile and activate material code. On error the previous version stays active. */
  applyMaterialSource(name: string, source: string): { ok: boolean; error?: string } {
    if (!this.materialLibrary) return { ok: false, error: 'no material library' };
    const r = this.materialLibrary.setSource(name, source);
    if (r.ok) { this.state.libraryDirty = true; this.emit(); }
    return r;
  }

  resetMaterialToDefault(name: string): boolean {
    const src = DEFAULT_MATERIAL_SOURCES[name];
    return !!src && this.applyMaterialSource(name, src).ok;
  }

  duplicateMaterial(from: string, newName: string): { ok: boolean; error?: string } {
    const src = this.materialLibrary?.getSource(from);
    if (src === undefined) return { ok: false, error: `Material '${from}' nicht gefunden` };
    if (!/^[a-z][a-z0-9_-]*$/i.test(newName)) return { ok: false, error: 'Name: Buchstaben, Ziffern, _ oder -; muss mit Buchstaben beginnen' };
    if (this.materialLibrary!.has(newName)) return { ok: false, error: `Material '${newName}' existiert bereits` };
    return this.applyMaterialSource(newName, src);
  }

  /** New profile as a copy of `from`. Returns its name. */
  duplicateProfile(from: string, newName: string): { ok: boolean; error?: string } {
    const src = this.library.getSource(from);
    if (src === undefined) return { ok: false, error: `Profil '${from}' nicht gefunden` };
    if (!/^[a-z][a-z0-9_-]*$/i.test(newName)) return { ok: false, error: 'Name: Buchstaben, Ziffern, _ oder -; muss mit Buchstaben beginnen' };
    if (this.library.has(newName)) return { ok: false, error: `Profil '${newName}' existiert bereits` };
    const r = this.applyProfileSource(newName, src);
    if (r.ok) this.state.activeProfile = newName;
    return r;
  }

  resetProfileToPreset(name: string): boolean {
    const src = PRESET_SOURCES[name];
    if (!src) return false;
    return this.applyProfileSource(name, src).ok;
  }

  deleteProfile(name: string): boolean {
    if (name === this.library.fallback) return false;
    if (this.model.list.some((r) => r.profile === name)) return false;
    this.library.remove(name);
    this.state.libraryDirty = true;
    if (this.state.activeProfile === name) this.state.activeProfile = this.library.fallback;
    this.emit();
    return true;
  }

  // ---- drawing ---------------------------------------------------------------

  private startDraft(): RoadDef {
    const id = `road-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    this.draft = { id, name: `Strasse ${this.model.list.length + 1}`, profile: this.state.activeProfile, points: [] };
    return this.draft;
  }

  private updateDraft(): void {
    if (!this.draft) return;
    if (this.draft.points.length >= 2) this.system.upsertRoad(cloneRoad(this.draft));
    else this.system.removeRoad(this.draft.id);
    this.state.roadId = this.draft.id;
    this.handlesDirty = true;
    this.emit();
  }

  finishDraft(): void {
    const d = this.draft;
    if (!d) return;
    this.draft = null;
    if (d.points.length < 2) { this.system.removeRoad(d.id); this.state.roadId = undefined; this.handlesDirty = true; this.emit(); return; }
    // connect both ends to whatever they were drawn onto — all in ONE undo step (road, node, split)
    const first = d.points[0], last = d.points[d.points.length - 1];
    const tStart = this.targetAt(first.x, -first.z, d.id);
    const tEnd = this.targetAt(last.x, -last.z, d.id);
    let connected = 0;
    this.model.transact('Straße zeichnen', (draft) => {
      draft.setRoad(cloneRoad(d));
      const splitDone = new Set<string>();
      for (const [end, t] of [['start', tStart], ['end', tEnd]] as Array<[End, ConnectTarget | undefined]>) {
        if (!t) continue;
        if (t.kind === 'road') {
          if (splitDone.has(t.roadId)) continue; // a second split on the same road would use stale arc lengths
          splitDone.add(t.roadId);
        }
        if (connectEnd(draft, d.id, end, t, defaultIds)) connected++;
      }
    });
    this.selectRoad(d.id);
    if (connected) this.setStatus(connected === 2 ? 'Straße an beiden Enden angeschlossen' : 'Straße angeschlossen', 'ok');
  }

  cancelDraft(): void {
    if (!this.draft) return;
    this.system.removeRoad(this.draft.id);
    this.draft = null;
    this.state.roadId = undefined;
    this.handlesDirty = true;
    this.emit();
  }

  get drafting(): boolean { return this.draft !== null; }

  /** Length (m) and build progress of a road, for the inspector. */
  roadInfo(id: string): { length: number; chunks: number; ready: number } | undefined {
    const rt = this.system.runtimes.find((r) => r.def.id === id);
    return rt ? { length: rt.sampled.curve.length, chunks: rt.chunks.length, ready: rt.chunks.length - rt.pendingCount } : undefined;
  }

  // ---- handles ---------------------------------------------------------------

  private rebuildHandles(): void {
    for (const m of [...this.handleMeshes, ...this.nodeMeshes]) { this.handles.remove(m); (m.material as THREE.Material).dispose(); }
    this.handleMeshes = [];
    this.nodeMeshes = [];

    // junction markers (always visible): the node centre, at the patch height once built
    for (const n of this.model.nodeList) {
      const jr = this.system.junctions.find((j) => j.id === n.id);
      const y = jr?.patch?.centerY ?? n.y;
      const mat = new THREE.MeshBasicMaterial({ color: n.id === this.state.nodeId ? 0xffffff : 0xffc400, depthTest: false, transparent: true, opacity: 0.9 });
      const m = new THREE.Mesh(this.sphere, mat);
      m.position.set(n.x, y + 1.2, -n.z);
      m.renderOrder = 99;
      m.userData.nodeId = n.id;
      m.userData.nodeMarker = true;
      this.handles.add(m);
      this.nodeMeshes.push(m);
    }

    const road = this.selectedRoad;
    if (!road) { this.handlesDirty = false; return; }
    const rt = this.system.runtimes.find((r) => r.def.id === road.id);
    road.points.forEach((p, k) => {
      const mode = p.mode ?? 'road';
      const color = k === this.state.pointIndex ? 0xff9a2e : this.isNodeEnd(road.id, k) ? 0xffc400 : mode === 'bridge' ? 0x5fb0ff : mode === 'tunnel' ? 0xc08cff : mode === 'gallery' ? 0xe0c060 : isFixedPoint(p) ? 0x8ff0b0 : 0xffffff;
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
      const m = new THREE.Mesh(this.sphere, mat);
      const y = rt ? rt.pointDesignY(k) : p.y;
      m.position.set(p.x, y + 0.8, -p.z);
      m.renderOrder = 100;
      m.userData.index = k;
      this.handles.add(m);
      this.handleMeshes.push(m);
    });
    this.handlesDirty = false;
  }

  /** Call once per frame (keeps handles a constant size on screen, rebuilds when stale). */
  update(): void {
    this.system.resync(EDIT_BUDGET);
    // let panels show build progress (cheap: at most 4× per second, only when it changed)
    const st = this.system.stats();
    const prog = `${st.ready}/${st.chunks}`;
    const now = performance.now();
    if (prog !== this.lastProgress && now - this.lastProgressEmit > 250) {
      this.lastProgress = prog;
      this.lastProgressEmit = now;
      this.emit();
    }
    if (this.handlesDirty) this.rebuildHandles();
    const cam = this.host.camera.position;
    for (const m of this.handleMeshes) m.scale.setScalar(Math.max(0.4, m.position.distanceTo(cam) * HANDLE_PX));
    for (const m of this.nodeMeshes) m.scale.setScalar(Math.max(0.6, m.position.distanceTo(cam) * HANDLE_PX * 1.5));
  }

  // ---- input -----------------------------------------------------------------

  private ndc(ev: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.host.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  private pickHandle(ev: { clientX: number; clientY: number }): number | undefined {
    if (!this.handleMeshes.length) return undefined;
    this.raycaster.setFromCamera(this.ndc(ev), this.host.camera);
    const hit = this.raycaster.intersectObjects(this.handleMeshes, false)[0];
    return hit ? (hit.object.userData.index as number) : undefined;
  }

  private pickNode(ev: { clientX: number; clientY: number }): string | undefined {
    if (!this.nodeMeshes.length) return undefined;
    this.raycaster.setFromCamera(this.ndc(ev), this.host.camera);
    const hit = this.raycaster.intersectObjects(this.nodeMeshes, false)[0];
    return hit ? (hit.object.userData.nodeId as string) : undefined;
  }

  private bindInput(): void {
    const el = this.host.domElement;
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false): void => {
      t.addEventListener(type, fn as EventListener, capture);
      this.cleanups.push(() => t.removeEventListener(type, fn as EventListener, capture));
    };

    on(el, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      this.down = { x: e.clientX, y: e.clientY, t: e.timeStamp, shift: e.shiftKey }; // event time, not handling time: robust against slow frames
      if (this.state.tool !== 'select') return;
      const idx = this.pickHandle(e);
      const nodeId = idx === undefined ? this.pickNode(e) : undefined;
      if (idx === undefined && nodeId === undefined) return;
      if (idx !== undefined) {
        const id = this.state.roadId;
        const r = id ? this.selectedRoad : undefined;
        // an end that hangs on a junction drags the junction (and with it every road that meets there)
        const attached = r && id && this.isNodeEnd(id, idx) ? (idx === 0 ? r.startNode : r.endNode) : undefined;
        if (attached) {
          this.drag = { pointer: e.pointerId, kind: 'node', index: idx, nodeId: attached };
          this.model.holdCoalesce(`dragnode:${attached}`);
        } else {
          this.drag = { pointer: e.pointerId, kind: 'point', index: idx };
          if (id) this.model.holdCoalesce(`drag:${id}:${idx}`);
        }
        this.selectPoint(idx);
      } else {
        this.selectNode(nodeId);
        this.drag = { pointer: e.pointerId, kind: 'node', index: -1, nodeId };
        this.model.holdCoalesce(`dragnode:${nodeId}`);
      }
      this.host.setCameraEnabled(false);
      el.setPointerCapture?.(e.pointerId);
      e.stopImmediatePropagation(); // keep the game's orbit/camera controls out of it
    }, true);

    on(el, 'pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.pointer) return;
      const hit = this.host.pickGround(e);
      if (hit && this.drag.kind === 'node' && this.drag.nodeId) {
        const nid = this.drag.nodeId;
        this.model.transact('Kreuzung verschieben', (d) => moveNode(d, nid, hit.x, hit.y, -hit.z), `dragnode:${nid}`);
        return;
      }
      const id = this.state.roadId;
      if (!hit || !id) return;
      const idx = this.drag.index;
      this.model.edit(id, 'Punkt bewegen', (d) => {
        const p = d.points[idx];
        if (!p) return;
        p.x = hit.x; p.z = -hit.z;
        if (!isFixedPoint(p)) p.y = hit.y; // bridge/tunnel/fixed points keep their authored height
      }, `drag:${id}:${idx}`);
    });

    const endDrag = (e: PointerEvent): void => {
      if (!this.drag || e.pointerId !== this.drag.pointer) return;
      const d = this.drag;
      this.drag = null;
      this.model.holdCoalesce(null);
      // a free road end dropped onto a node / another road's end / another road joins it there
      const id = this.state.roadId;
      const road = id ? this.model.get(id) : undefined;
      if (d.kind === 'point' && id && road && (d.index === 0 || d.index === road.points.length - 1) && !this.isNodeEnd(id, d.index)) {
        const end: End = d.index === 0 ? 'start' : 'end';
        const p = road.points[d.index];
        const target = this.targetAt(p.x, -p.z, id);
        if (target && this.model.transact('Straße verbinden', (draft) => { connectEnd(draft, id, end, target, defaultIds); })) {
          this.setStatus('Straße verbunden', 'ok');
        }
      }
      this.host.setCameraEnabled(true);
      this.down = null;
      this.handlesDirty = true;
    };
    on(el, 'pointerup', (e) => {
      if (this.drag) { endDrag(e); return; }
      const d = this.down; this.down = null;
      if (!d || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.timeStamp - d.t > 500) return; // camera drag, not a click
      this.click(e, d.shift);
    });
    on(el, 'pointercancel', endDrag);

    on(el, 'dblclick', (e) => {
      if (this.state.tool !== 'select' || !this.state.roadId) return;
      const hit = this.pickSurface(e);
      if (hit) this.tryInsert(hit);
    });

    on(window, 'keydown', (e) => this.key(e));
  }

  /** Nearest hit of road surface or terrain under the pointer (for selecting / inserting on a road). */
  private pickSurface(ev: { clientX: number; clientY: number }): THREE.Vector3 | null {
    const ground = this.host.pickGround(ev);
    if (!this.roadGroup) return ground;
    this.raycaster.setFromCamera(this.ndc(ev), this.host.camera);
    const road = this.raycaster.intersectObject(this.roadGroup, true)[0];
    if (!road) return ground;
    if (!ground) return road.point;
    const cam = this.host.camera.position;
    return road.point.distanceTo(cam) <= ground.distanceTo(cam) ? road.point : ground;
  }

  private tryInsert(hit: THREE.Vector3): boolean {
    const id = this.state.roadId;
    const rt = id ? this.system.runtimes.find((r) => r.def.id === id) : undefined;
    if (!id || !rt) return false;
    if (projectOnRoad(rt.sampled, hit.x, hit.z).distance > PICK_ROAD_M) return false;
    this.insertPoint(id, hit.x, hit.z, hit.y);
    return true;
  }

  private click(e: PointerEvent, shift: boolean): void {
    const hit = this.state.tool === 'draw' ? this.host.pickGround(e) : this.pickSurface(e);
    if (!hit) return;
    if (this.state.tool === 'draw') {
      const d = this.draft ?? this.startDraft();
      d.points.push({ x: hit.x, y: hit.y, z: -hit.z });
      this.updateDraft();
      return;
    }
    if (shift && this.tryInsert(hit)) return;
    const now = e.timeStamp;
    const dbl = now - this.lastClickTime < 350; // dblclick handler inserts; don't also reselect
    this.lastClickTime = now;
    if (dbl) return;
    const near = nearestRoad(this.system.runtimes.map((r) => ({ def: r.def, sampled: r.sampled })), hit.x, hit.z, PICK_ROAD_M);
    this.selectRoad(near?.id);
  }

  private key(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, select, .cm-editor')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void this.save(); return; }
    if (mod) return;
    if (e.key === 'd' || e.key === 'D') { this.setTool(this.state.tool === 'draw' ? 'select' : 'draw'); return; }
    if (this.state.tool === 'draw') {
      if (e.key === 'Enter') this.finishDraft();
      else if (e.key === 'Escape') { this.cancelDraft(); this.setTool('select'); }
      else if (e.key === 'Backspace' && this.draft) { this.draft.points.pop(); this.updateDraft(); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { this.state.nodeId ? this.dissolveSelectedNode() : this.deleteSelectedPoint(); }
    else if (e.key === 'Escape') { this.state.pointIndex !== undefined ? this.selectPoint(undefined) : this.state.nodeId ? this.selectNode(undefined) : this.selectRoad(undefined); }
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    for (const m of [...this.handleMeshes, ...this.nodeMeshes]) (m.material as THREE.Material).dispose();
    this.host.scene.remove(this.handles);
    this.sphere.dispose();
    this.listeners.clear();
  }
}
