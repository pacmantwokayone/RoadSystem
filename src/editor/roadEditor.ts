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
import type { BridgeLibrary } from '../structures/library';
import { BRIDGE_PRESET_SOURCES } from '../structures/presets';
import { applyBridgeProposal, suggestBridges, type BridgeProposal, type RiverLike } from '../structures/suggest';
import type { TerrainSource } from '../core/terrain';
import { defaultBridgeName } from '../structures/types';
import { DEFAULT_MATERIAL_SOURCES, type MaterialLibrary } from '../surface/materialLibrary';
import type { RoadStore } from '../store/types';
import { cloneRoad } from '../network/doc';
import { isFixedPoint, type NodeDef, type RoadDef, type RoadPoint } from '../network/types';
import { armsByNode, type End } from '../network/graph';
import { RoadModel, type ModelEvent } from './model';
import { nearestRoad, pointAtS, projectOnRoad } from './pathTools';
import { connectEnd, defaultIds, detachRoad, dissolveNode, findConnectTarget, isHeadIndex, moveNode, setAttach, setNodeRadius, setNodeSettings, type AttachWhich, type ConnectTarget, type NodeSettings } from './ops';
import { defaultAttach, type BranchKind } from '../network/branchDefaults';
import type { AttachDef } from '../network/types';
import { PRESET_SOURCES } from '../profile/presets';
import { WaterEditor, type WaterEditorDeps } from './waterEditor';
import { railWarnings } from '../rail/validate';
import { defaultTemplateParams, newTemplateId, TEMPLATES, type TemplateKind } from './templates';

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
  /** code-based bridge types; when given, the editor edits and saves them and rebuilds roads when they change */
  bridgeLibrary?: BridgeLibrary;
  /** rivers to check roads against (SIM space polylines); enables the bridge proposals */
  rivers?: RiverLike[];
  /** terrain for deck heights of proposals (optional) */
  terrain?: TerrainSource;
  store: RoadStore;
  location: string;
  /** road meshes (RoadMeshLayer.group): lets clicks hit the road surface, not just the terrain behind it */
  roadGroup?: THREE.Object3D;
  /** ask the user; default window.confirm */
  confirm?: (message: string) => boolean;
  /** rivers, lakes and waterfalls: when given, the editor draws and edits them (tools River / Lake, inspector, style code) */
  water?: WaterEditorDeps;
}

export type Tool = 'select' | 'draw' | 'branch' | 'place' | 'river' | 'lake';
export type StatusKind = 'info' | 'ok' | 'error';

export interface EditorState {
  tool: Tool;
  roadId?: string;
  pointIndex?: number;
  /** selected junction */
  nodeId?: string;
  activeProfile: string;
  /** what the branch tool creates: an exit (the new road starts at the main road) or an entry (it ends there) */
  branchKind: BranchKind;
  /** what the place tool drops on the next click */
  template: { kind: TemplateKind; params: Record<string, number> };
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
  readonly host: EditorHost;
  private readonly system: RoadSystem;
  private readonly library: ProfileLibrary;
  private readonly store: RoadStore;
  private readonly location: string;
  private readonly confirmFn: (m: string) => boolean;
  private readonly roadGroup: THREE.Object3D | undefined;
  readonly materialLibrary: MaterialLibrary | undefined;
  readonly bridgeLibrary: BridgeLibrary | undefined;
  /** rivers / lakes / waterfalls (only with `deps.water`) */
  readonly water: WaterEditor | undefined;
  private rivers: RiverLike[] = [];
  private readonly terrain: TerrainSource | null;
  readonly materials: MaterialRegistry;
  private listeners = new Set<() => void>();
  private draft: RoadDef | null = null;
  private libraryRevision: number | undefined;
  private handleMeshes: THREE.Mesh[] = [];
  private handlesDirty = true;
  private drag: { pointer: number; kind: 'point' | 'node' | 'nose'; index: number; nodeId?: string; which?: AttachWhich } | null = null;
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
      branchKind: 'exit',
      template: { kind: 'interchange', params: defaultTemplateParams('interchange') },
      status: { text: '', kind: 'info' },
      libraryDirty: false,
    };
    this.handles.name = 'road-editor-handles';
    this.host.scene.add(this.handles);
    this.materials = deps.materials;
    this.materialLibrary = deps.materialLibrary;
    this.bridgeLibrary = deps.bridgeLibrary;
    this.rivers = deps.rivers ?? [];
    this.terrain = deps.terrain ?? null;
    if (this.bridgeLibrary) {
      this.cleanups.push(this.bridgeLibrary.onChange(() => { this.system.refresh(); this.emit(); }));
    }
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
    if (deps.water) this.water = new WaterEditor(this, deps.water); // after bindInput: road handles get the first pick
    // the terrain under roads changes when water is carved into it: rebuild the roads that come near
    if (this.water) this.cleanups.push(this.water.system.onTerrainChanged((rect) => { this.system.invalidateRect(rect); this.handlesDirty = true; }));
  }

  // ---- state / events ------------------------------------------------------

  onState(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /** for the water editor and panels */
  emitState(): void { this.emit(); }

  markLibraryDirty(): void {
    this.state.libraryDirty = true;
    this.emit();
  }

  /** a water object is being selected: drop the road / junction selection */
  deselectRoadStuff(): void {
    this.state.roadId = undefined; this.state.pointIndex = undefined; this.state.nodeId = undefined;
    this.handlesDirty = true;
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
        this.water?.clearSelection();
        break;
      case 'changed':
        // one sync per change: the system diffs by identity and rebuilds only what differs
        this.system.setNetwork(this.model.list, this.model.nodeList);
        this.water?.sync();
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
      for (const [name, src] of Object.entries(lib.bridges ?? {})) this.bridgeLibrary?.setSource(name, src);
      for (const [name, src] of Object.entries(lib.waters ?? {})) this.water?.library.setSource(name, src);
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
        (base) => this.store.saveLibrary({ version: 1, profiles: this.library.allSources(), ...(this.materialLibrary ? { materials: this.materialLibrary.allSources() } : {}), ...(this.bridgeLibrary ? { bridges: this.bridgeLibrary.allSources() } : {}), ...(this.water ? { waters: this.water.library.allSources() } : {}) }, base),
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
    this.water?.toolChanged();
    this.host.domElement.style.cursor = tool === 'select' ? '' : 'crosshair';
    this.emit();
  }

  selectRoad(id: string | undefined): void {
    if (id !== undefined) this.water?.clearSelection();
    this.state.roadId = id;
    this.state.pointIndex = undefined;
    this.state.nodeId = undefined;
    this.handlesDirty = true;
    this.emit();
  }

  selectNode(id: string | undefined): void {
    if (id !== undefined) this.water?.clearSelection();
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
    if (this.headBlocked(id, index)) return;
    const key = `attr:${id}:${index}:${Object.keys(patch).join(',')}`;
    this.model.edit(id, 'Punkt ändern', (d) => {
      const p = d.points[index];
      if (!p) return;
      for (const [k, v] of Object.entries(patch)) {
        const neutral = (k === 'mode' && v === 'road') || (k === 'elev' && v === 'drape') || (k === 'widthScale' && v === 1) || (k === 'banking' && v === 0) || (k === 'bridge' && (v === '' || v === undefined));
        if (neutral) delete (p as unknown as Record<string, unknown>)[k];
        else (p as unknown as Record<string, unknown>)[k] = v;
      }
    }, key);
  }

  /** Points of a computed head follow the parent road; say so instead of silently ignoring the edit. */
  private headBlocked(id: string, index: number): boolean {
    const r = this.model.get(id);
    if (!r || !isHeadIndex(r, index)) return false;
    this.setStatus('Dieser Punkt folgt der Hauptstrasse. Den Abzweig verschiebst du am Startpunkt, Form und Längen stehen im Inspector.', 'info');
    return true;
  }

  /** Does the selected road hang on another road (exit / entry)? */
  attachOf(road: RoadDef | undefined): Array<{ which: AttachWhich; attach: AttachDef; parent: RoadDef | undefined }> {
    if (!road) return [];
    const out: Array<{ which: AttachWhich; attach: AttachDef; parent: RoadDef | undefined }> = [];
    if (road.attach) out.push({ which: 'attach', attach: road.attach, parent: this.model.get(road.attach.road) });
    if (road.attachEnd) out.push({ which: 'attachEnd', attach: road.attachEnd, parent: this.model.get(road.attachEnd.road) });
    return out;
  }

  setAttach(which: AttachWhich, patch: Partial<Omit<AttachDef, 'road' | 'head' | 's' | 'len'>>): void {
    const id = this.state.roadId;
    if (id) this.model.transact('Abzweig ändern', (d) => setAttach(d, id, which, patch), `attach:${id}:${which}:${Object.keys(patch).join(',')}`);
  }

  detachSelected(which: AttachWhich): void {
    const id = this.state.roadId;
    if (!id) return;
    this.model.transact('Abzweig lösen', (d) => detachRoad(d, id, which));
    this.setStatus('Abzweig gelöst: die Punkte bleiben, folgen der Hauptstrasse aber nicht mehr', 'ok');
  }

  /** Is point `index` of the selected road part of a computed head? */
  isHead(index: number): boolean {
    const r = this.selectedRoad;
    return !!r && isHeadIndex(r, index);
  }

  /** Is point `index` the nose of an attachment (the one end you may drag along the parent)? */
  noseOf(road: RoadDef, index: number): AttachWhich | undefined {
    if (road.attach && index === 0) return 'attach';
    if (road.attachEnd && index === road.points.length - 1) return 'attachEnd';
    return undefined;
  }

  /**
   * Branch tool: a click on a road starts a new road that leaves it (or, as `entry`, joins it). The head is computed from the parent;
   * the user then clicks the rest of the new road as usual (draw tool) and finishes with Enter.
   */
  private startBranch(hit: THREE.Vector3): void {
    const near = nearestRoad(this.system.runtimes.map((r) => ({ def: r.def, sampled: r.sampled })), hit.x, hit.z, PICK_ROAD_M * 1.5);
    const rt = near ? this.system.runtimes.find((r) => r.def.id === near.id) : undefined;
    if (!near || !rt) { this.setStatus('Auf eine Strasse klicken, von der der Abzweig wegführen soll.', 'error'); return; }
    const parent = this.model.get(near.id) ?? rt.def;
    const pr = projectOnRoad(rt.sampled, hit.x, hit.z);
    const q = rt.sampled.curve.pointAt(pr.s);
    const t = rt.sampled.curve.tangentAt(pr.s);
    // THREE space: right = (−t.z, 0, t.x). The side the click lies on decides where the branch goes.
    const side: 1 | -1 = (hit.x - q.x) * -t.z + (hit.z - q.z) * t.x >= 0 ? 1 : -1;
    const parentProfile = this.library.resolve(parent.profile, parent.params);
    let profile = this.state.activeProfile;
    if (parentProfile.rail && !this.library.resolve(profile).rail) profile = this.library.has('gleis') ? 'gleis' : profile;
    const childProfile = this.library.resolve(profile);
    const attach = defaultAttach({ parent, parentProfile, childProfile, at: { x: q.x, z: -q.z }, side, kind: this.state.branchKind });
    const id = `road-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    this.draft = { id, name: `${parentProfile.rail ? 'Weiche' : this.state.branchKind === 'exit' ? 'Ausfahrt' : 'Einfahrt'} ${this.model.list.length + 1}`, profile, points: [], ...(this.state.branchKind === 'exit' ? { attach } : { attachEnd: attach }) };
    this.state.tool = 'draw';
    this.host.domElement.style.cursor = 'crosshair';
    this.setStatus(this.state.branchKind === 'exit' ? 'Abzweig gesetzt – jetzt die Strasse weiter zeichnen (Klicks), Enter = fertig' : 'Einmündung gesetzt – jetzt die Strasse vom freien Ende her zeichnen, Enter = fertig', 'info');
    this.emit();
  }

  setTemplate(kind: TemplateKind): void {
    this.state.template = { kind, params: defaultTemplateParams(kind) };
    this.emit();
  }

  setTemplateParam(key: string, value: number): void {
    this.state.template.params[key] = value;
  }

  /** Drops the current template at a ground position (THREE space hit): one undo step. */
  placeTemplate(hit: THREE.Vector3): void {
    const { kind, params } = this.state.template;
    const def = TEMPLATES[kind];
    const ground = (x: number, z: number): number => this.terrain?.heightAt(x, z) ?? hit.y;
    const built = def.build({ x: hit.x, z: -hit.z, ground, uid: newTemplateId(), params, library: this.library });
    this.model.transact(`${def.label} einfügen`, (d) => {
      for (const r of built.roads) d.setRoad(cloneRoad(r));
      for (const n of built.nodes) d.setNode({ ...n });
    });
    this.selectRoad(built.roads[0]?.id);
    this.setTool('select');
    this.setStatus(`${def.label} eingefügt – alle Teile sind normale Strassen und lassen sich einzeln ändern`, 'ok');
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
    if (this.headBlocked(id, idx)) return;
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

  setNodeSettings(patch: Partial<NodeSettings>): void {
    const id = this.state.nodeId;
    if (id) this.model.transact('Kreuzung einstellen', (d) => setNodeSettings(d, id, patch), `nodeset:${id}:${Object.keys(patch).join(',')}`);
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
    // inside a computed head there is nothing to insert into: it follows the parent
    const a = rt.def.attach, b = rt.def.attachEnd;
    if ((a && index < a.head) || (b && index > rt.def.points.length - b.head)) { this.setStatus('Hier folgt die Strasse der Hauptstrasse – Punkte lassen sich nur ausserhalb des Abzweigs einfügen.', 'error'); return; }
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

  // ---- bridges ---------------------------------------------------------------

  /** Compile and activate bridge code. On error the previous version stays active. */
  applyBridgeSource(name: string, source: string): { ok: boolean; error?: string } {
    if (!this.bridgeLibrary) return { ok: false, error: 'no bridge library' };
    const r = this.bridgeLibrary.setSource(name, source);
    if (r.ok) { this.state.libraryDirty = true; this.emit(); }
    return r;
  }

  resetBridgeToPreset(name: string): boolean {
    const src = BRIDGE_PRESET_SOURCES[name];
    return !!src && this.applyBridgeSource(name, src).ok;
  }

  duplicateBridge(from: string, newName: string): { ok: boolean; error?: string } {
    const src = this.bridgeLibrary?.getSource(from);
    if (src === undefined) return { ok: false, error: `Brücke '${from}' nicht gefunden` };
    if (!/^[a-z][a-z0-9_-]*$/i.test(newName)) return { ok: false, error: 'Name: Buchstaben, Ziffern, _ oder -; muss mit Buchstaben beginnen' };
    if (this.bridgeLibrary!.has(newName)) return { ok: false, error: `Brücke '${newName}' existiert bereits` };
    return this.applyBridgeSource(newName, src);
  }

  setRivers(rivers: RiverLike[]): void {
    this.rivers = rivers;
    this.emit();
  }

  get hasRivers(): boolean {
    return this.rivers.length > 0 || this.model.riverList.length > 0;
  }

  /** Roads that cross a river without a bridge. */
  bridgeProposals(): BridgeProposal[] {
    return suggestBridges(this.model.list, [...this.rivers, ...(this.water?.riversForBridges() ?? [])], this.terrain);
  }

  /** Sets the bridge for a proposal — one undo step — and selects the road. */
  applyBridgeProposal(p: BridgeProposal): void {
    this.model.transact('Brücke setzen', (d) => { applyBridgeProposal(d, p); });
    this.selectRoad(p.roadId);
  }

  /** The bridge type a road uses for its bridge sections (named, or the default for its profile). */
  effectiveBridgeName(road: RoadDef): string {
    return road.bridge ?? defaultBridgeName(this.library.resolve(road.profile, road.params));
  }

  setRoadBridge(name: string | undefined): void {
    const id = this.state.roadId;
    if (!id) return;
    this.model.transact('Brückentyp ändern', (d) => d.editRoad(id, (r) => {
      if (name === undefined) { delete r.bridge; delete r.bridgeParams; } else { r.bridge = name; delete r.bridgeParams; }
    }));
  }

  setBridgeParam(key: string, value: number | boolean | string): void {
    const id = this.state.roadId;
    if (!id) return;
    this.model.transact('Brücken-Parameter ändern', (d) => d.editRoad(id, (r) => { r.bridgeParams = { ...(r.bridgeParams ?? {}), [key]: value }; }), `bparam:${id}:${key}`);
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
    const need = this.draft.attach || this.draft.attachEnd ? 1 : 2; // an attached road has its head already
    if (this.draft.points.length >= need) this.system.upsertRoad(cloneRoad(this.draft));
    else this.system.removeRoad(this.draft.id);
    this.state.roadId = this.draft.id;
    this.handlesDirty = true;
    this.emit();
  }

  finishDraft(): void {
    const d = this.draft;
    if (!d) return;
    this.draft = null;
    if (d.points.length < (d.attach || d.attachEnd ? 1 : 2)) { this.system.removeRoad(d.id); this.state.roadId = undefined; this.handlesDirty = true; this.emit(); return; }
    // connect both ends to whatever they were drawn onto — all in ONE undo step (road, node, split). An attached end is joined to its parent already.
    const first = d.points[0], last = d.points[d.points.length - 1];
    const tStart = d.attach ? undefined : this.targetAt(first.x, -first.z, d.id);
    const tEnd = d.attachEnd ? undefined : this.targetAt(last.x, -last.z, d.id);
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

  /** Plausibility findings for the road (railway curves and grades), for the inspector. */
  roadWarnings(id: string): string[] {
    const rt = this.system.runtimes.find((r) => r.def.id === id);
    return rt ? railWarnings(rt).map((w) => w.text) : [];
  }

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
      const color = k === this.state.pointIndex ? 0xff9a2e : this.noseOf(road, k) ? 0xff5ad0 : isHeadIndex(road, k) ? 0x3ad6c8 : this.isNodeEnd(road.id, k) ? 0xffc400 : mode === 'bridge' ? 0x5fb0ff : mode === 'tunnel' ? 0xc08cff : mode === 'gallery' ? 0xe0c060 : isFixedPoint(p) ? 0x8ff0b0 : 0xffffff;
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
    this.water?.update();
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
        const nose = r ? this.noseOf(r, idx) : undefined;
        if (nose && id) {
          // the nose of a branch slides along its parent road
          this.drag = { pointer: e.pointerId, kind: 'nose', index: idx, which: nose };
          this.model.holdCoalesce(`nose:${id}`);
        } else if (r && isHeadIndex(r, idx)) {
          this.selectPoint(idx); // a computed point: selectable, but it follows the parent
          e.stopImmediatePropagation();
          return;
        } else if (attached) {
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
      if (hit && this.drag.kind === 'nose' && this.drag.which && this.state.roadId) {
        const rid = this.state.roadId, which = this.drag.which;
        this.model.transact('Abzweig verschieben', (d) => { d.editRoad(rid, (r) => { const a = r[which]; if (a) a.at = { x: hit.x, z: -hit.z }; }); }, `nose:${rid}`);
        return;
      }
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
    if (this.state.tool === 'branch') { const h = this.pickSurface(e); if (h) this.startBranch(h); return; }
    if (this.state.tool === 'place') { const h = this.host.pickGround(e); if (h) this.placeTemplate(h); return; }
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
    if (this.state.tool === 'river' || this.state.tool === 'lake') return; // the water editor handles these
    if (this.water?.hasSelection && this.state.tool === 'select' && !this.state.roadId && !this.state.nodeId) {
      if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape') return;
    }
    if (e.key === 'd' || e.key === 'D') { this.setTool(this.state.tool === 'draw' ? 'select' : 'draw'); return; }
    if ((e.key === 'b' || e.key === 'B') && !this.draft) { this.setTool(this.state.tool === 'branch' ? 'select' : 'branch'); return; }
    if (this.state.tool === 'draw') {
      if (e.key === 'Enter') this.finishDraft();
      else if (e.key === 'Escape') { this.cancelDraft(); this.setTool('select'); }
      else if (e.key === 'Backspace' && this.draft) { this.draft.points.pop(); this.updateDraft(); }
      return;
    }
    if (this.state.tool === 'branch' || this.state.tool === 'place') { if (e.key === 'Escape') this.setTool('select'); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { this.state.nodeId ? this.dissolveSelectedNode() : this.deleteSelectedPoint(); }
    else if (e.key === 'Escape') { this.state.pointIndex !== undefined ? this.selectPoint(undefined) : this.state.nodeId ? this.selectNode(undefined) : this.selectRoad(undefined); }
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    for (const m of [...this.handleMeshes, ...this.nodeMeshes]) (m.material as THREE.Material).dispose();
    this.water?.dispose();
    this.host.scene.remove(this.handles);
    this.sphere.dispose();
    this.listeners.clear();
  }
}
