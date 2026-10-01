// Editing rivers, lakes and waterfalls: draw tools, point handles, selection, and the operations the inspector calls.
// A RoadEditor owns one of these when it is given a water system. The data lives in the RoadModel (undo/redo, save/load are the
// road editor's); this class only turns pointer input and inspector actions into model edits.
//
//   river tool : click sets points (levels follow the terrain) · Enter finishes · ⌫ removes the last · Esc cancels
//   lake tool  : click sets outline points · Enter closes the lake
//   select tool: click a river / lake to select · drag a handle · Shift+click or double-click inserts a point · Delete removes it
//
// Where a river's first / last point lies in a lake it leaves / enters that lake; a last point on another river joins it.

import * as THREE from 'three';
import type { WaterSystem, WaterTerrain } from '../water/system';
import type { WaterLibrary } from '../water/styleLibrary';
import { WATER_PRESET_SOURCES } from '../water/presets';
import { autoLevel, autoLevelRiver } from '../water/autolevel';
import { outlineArea, pointInOutline, smoothOutline, trimAtLake } from '../water/outline';
import type { LakeDef, LakePoint, RiverDef, RiverPoint, SegmentKind } from '../water/types';
import { cloneRiver } from '../water/types';
import type { RiverLike } from '../structures/suggest';
import type { RoadEditor } from './roadEditor';

export interface WaterEditorDeps {
  system: WaterSystem;
  library: WaterLibrary;
  /** the terrain the water is carved into; `baseHeightAt` (the ground without water) is used for levels when it exists */
  terrain: WaterTerrain & { baseHeightAt?(x: number, z: number): number };
}

export type WaterSelection = { kind: 'river' | 'lake'; id: string; index?: number };

const HANDLE_PX = 0.012;
const PICK_M = 9;
const END_SNAP_M = 14;

export interface RiverInfo {
  length: number;
  falls: Array<{ height: number; run: number }>;
  chunks: number;
  ready: number;
}

const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export class WaterEditor {
  readonly system: WaterSystem;
  readonly library: WaterLibrary;
  selection: WaterSelection | null = null;
  /** keep the water levels of a river on the terrain while its shape is edited */
  autoLevel = true;
  private readonly terrain: WaterEditorDeps['terrain'];
  private readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private lines: THREE.Line[] = [];
  private readonly sphere = new THREE.SphereGeometry(1, 12, 9);
  private dirty = true;
  private draft: { kind: 'river' | 'lake'; points: Array<{ x: number; y: number; z: number }> } | null = null;
  private drag: { pointer: number; index: number } | null = null;
  private down: { x: number; y: number; t: number; shift: boolean } | null = null;
  private lastClickTime = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly editor: RoadEditor, deps: WaterEditorDeps) {
    this.system = deps.system;
    this.library = deps.library;
    this.terrain = deps.terrain;
    this.group.name = 'water-editor-handles';
    this.editor.host.scene.add(this.group);
    this.cleanups.push(this.library.onChange(() => { this.system.refresh(); this.editor.markLibraryDirty(); }));
    this.bindInput();
  }

  // ---- model / selection ---------------------------------------------------------

  get model() { return this.editor.model; }

  /** the road editor calls this after every change of the network */
  sync(): void {
    this.system.setWaters(this.model.riverList, this.model.lakeList);
    const s = this.selection;
    if (s && !(s.kind === 'river' ? this.model.getRiver(s.id) : this.model.getLake(s.id))) this.selection = null;
    if (s?.index !== undefined && this.selection) {
      const n = s.kind === 'river' ? this.model.getRiver(s.id)?.points.length : this.model.getLake(s.id)?.outline.length;
      if (n !== undefined && s.index >= n) this.selection = { ...s, index: undefined };
    }
    this.dirty = true;
  }

  get hasSelection(): boolean { return this.selection !== null; }
  get drafting(): boolean { return this.draft !== null; }
  get selectedRiver(): RiverDef | undefined { return this.selection?.kind === 'river' ? this.model.getRiver(this.selection.id) : undefined; }
  get selectedLake(): LakeDef | undefined { return this.selection?.kind === 'lake' ? this.model.getLake(this.selection.id) : undefined; }

  select(kind: 'river' | 'lake', id: string, index?: number): void {
    this.editor.deselectRoadStuff();
    this.selection = { kind, id, index };
    this.dirty = true;
    this.editor.emitState();
  }

  selectPoint(index: number | undefined): void {
    if (!this.selection) return;
    this.selection = { ...this.selection, index };
    this.dirty = true;
    this.editor.emitState();
  }

  clearSelection(): void {
    if (!this.selection) return;
    this.selection = null;
    this.dirty = true;
    this.editor.emitState();
  }

  // ---- terrain helpers ---------------------------------------------------------------

  /** the ground without any water carved into it */
  ground = (x: number, z: number): number => {
    const t = this.terrain;
    if (t.baseHeightAt) return t.baseHeightAt(x, z);
    return t.heightAt(x, z) ?? 0;
  };

  private lakeById(id: string | undefined): LakeDef | undefined { return id ? this.model.getLake(id) : undefined; }

  private levelRiver(d: RiverDef): void {
    const lv = autoLevelRiver(d, this.ground, this.model.lakeList);
    d.points = lv.points;
  }

  // ---- river operations --------------------------------------------------------------

  private edit(id: string, label: string, fn: (d: RiverDef) => void, key?: string): void {
    this.model.editRiver(id, label, fn, key);
  }

  renameSelected(name: string): void {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'river') this.edit(s.id, 'Fluss umbenennen', (d) => { d.name = name; }, `wname:${s.id}`);
    else this.model.editLake(s.id, 'See umbenennen', (d) => { d.name = name; }, `wname:${s.id}`);
  }

  setStyle(name: string): void {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'river') this.edit(s.id, 'Wasserstil wechseln', (d) => { d.style = name; delete d.params; });
    else this.model.editLake(s.id, 'Wasserstil wechseln', (d) => { d.style = name; delete d.params; });
  }

  setParam(key: string, value: number | boolean | string): void {
    const s = this.selection;
    if (!s) return;
    const k = `wparam:${s.id}:${key}`;
    if (s.kind === 'river') this.edit(s.id, 'Wasser-Parameter ändern', (d) => { d.params = { ...d.params, [key]: value }; }, k);
    else this.model.editLake(s.id, 'Wasser-Parameter ändern', (d) => { d.params = { ...d.params, [key]: value }; }, k);
  }

  setPointAttr(index: number, patch: { width?: number | null; depth?: number | null; seg?: SegmentKind; y?: number }): void {
    const id = this.selection?.kind === 'river' ? this.selection.id : undefined;
    if (!id) return;
    this.edit(id, 'Flusspunkt ändern', (d) => {
      const p = d.points[index];
      if (!p) return;
      if (patch.width !== undefined) { if (patch.width === null) delete p.width; else p.width = patch.width; }
      if (patch.depth !== undefined) { if (patch.depth === null) delete p.depth; else p.depth = patch.depth; }
      if (patch.y !== undefined) p.y = patch.y;
      if (patch.seg !== undefined) { if (patch.seg === 'river') delete p.seg; else p.seg = patch.seg; }
      // a fall needs height: re-level so the foot lies on the ground below (unless levels are managed by hand)
      if (patch.seg !== undefined && this.autoLevel) this.levelRiver(d);
    }, `wpt:${id}:${index}:${Object.keys(patch).join(',')}`);
  }

  setLinks(patch: { startLake?: string | null; endLake?: string | null; endRiver?: string | null }): void {
    const id = this.selection?.kind === 'river' ? this.selection.id : undefined;
    if (!id) return;
    this.edit(id, 'Verbindung ändern', (d) => {
      for (const k of ['startLake', 'endLake', 'endRiver'] as const) {
        const v = patch[k];
        if (v === undefined) continue;
        if (v === null || v === '') delete d[k]; else d[k] = v;
      }
      if (this.autoLevel) this.levelRiver(d);
    });
  }

  /** "Pegel aus Terrain": sets every point's water level from the ground (and the lakes it is linked to) */
  relevelSelected(): void {
    const id = this.selection?.kind === 'river' ? this.selection.id : undefined;
    if (!id) return;
    this.edit(id, 'Pegel aus Terrain', (d) => this.levelRiver(d));
  }

  deleteSelectedPoint(): void {
    const s = this.selection;
    if (!s || s.index === undefined) return;
    if (s.kind === 'river') {
      const r = this.model.getRiver(s.id);
      if (!r || r.points.length <= 2) { this.editor.setStatus('Ein Fluss braucht mindestens 2 Punkte – ganzen Fluss löschen.', 'error'); return; }
      this.edit(s.id, 'Flusspunkt löschen', (d) => { d.points.splice(s.index!, 1); if (this.autoLevel) this.levelRiver(d); });
    } else {
      const l = this.model.getLake(s.id);
      if (!l || l.outline.length <= 3) { this.editor.setStatus('Ein See braucht mindestens 3 Punkte – ganzen See löschen.', 'error'); return; }
      this.model.editLake(s.id, 'Seepunkt löschen', (d) => { d.outline.splice(s.index!, 1); });
    }
    this.selection = { ...s, index: undefined };
    this.dirty = true;
    this.editor.emitState();
  }

  deleteSelected(): void {
    const s = this.selection;
    if (!s) return;
    this.model.transact(s.kind === 'river' ? 'Fluss löschen' : 'See löschen', (d) => {
      if (s.kind === 'river') d.removeRiver(s.id);
      else {
        d.removeLake(s.id);
        // rivers that were linked to the lake simply lose the link
        for (const r of d.rivers) if (r.startLake === s.id || r.endLake === s.id) d.editRiver(r.id, (x) => { if (x.startLake === s.id) delete x.startLake; if (x.endLake === s.id) delete x.endLake; });
      }
      if (s.kind === 'river') for (const r of d.rivers) if (r.endRiver === s.id) d.editRiver(r.id, (x) => { delete x.endRiver; });
    });
    this.selection = null;
    this.dirty = true;
    this.editor.emitState();
  }

  // ---- lake operations ---------------------------------------------------------------

  setLake(patch: { level?: number; depth?: number }): void {
    const id = this.selection?.kind === 'lake' ? this.selection.id : undefined;
    if (!id) return;
    this.model.editLake(id, 'See ändern', (d) => {
      if (patch.level !== undefined) d.level = patch.level;
      if (patch.depth !== undefined) d.depth = Math.min(300, Math.max(0.3, patch.depth));
    }, `wlake:${id}:${Object.keys(patch).join(',')}`);
    // rivers that leave / enter this lake follow its level
    if (patch.level !== undefined && this.autoLevel) {
      for (const r of this.model.riverList) if (r.startLake === id || r.endLake === id) this.edit(r.id, 'Pegel angleichen', (d) => this.levelRiver(d), `wlevel:${r.id}`);
    }
  }

  /** the level a lake would get from the terrain along its outline: a little below the lowest shore */
  lakeLevelFor(outline: readonly LakePoint[]): number {
    let low = Infinity;
    for (const p of smoothOutline(outline)) low = Math.min(low, this.ground(p.x, p.z));
    return Number.isFinite(low) ? Math.round((low - 0.3) * 10) / 10 : 0;
  }

  lakeLevelFromTerrain(): void {
    const l = this.selectedLake;
    if (l) this.setLake({ level: this.lakeLevelFor(l.outline) });
  }

  // ---- info for the panels ---------------------------------------------------------------

  riverInfo(id: string): RiverInfo | undefined {
    const rt = this.system.rivers.find((r) => r.def.id === id);
    if (!rt) return undefined;
    return {
      length: rt.hydro.length,
      falls: rt.hydro.falls.map((f) => ({ height: f.height, run: f.run })),
      chunks: rt.chunks.length,
      ready: rt.chunks.length - rt.pendingCount,
    };
  }

  lakeInfo(id: string): { area: number; ready: boolean } | undefined {
    const lk = this.system.lakes.find((l) => l.def.id === id);
    return lk ? { area: outlineArea(smoothOutline(lk.def.outline)), ready: lk.state === 'ready' } : undefined;
  }

  /** rivers as the bridge proposals read them (SIM polylines) */
  riversForBridges(): RiverLike[] {
    return this.system.rivers.map((rt) => ({
      id: rt.def.id,
      name: rt.def.name,
      width: rt.style.width,
      points: rt.hydro.samples.filter((s) => s.kind !== 'fall').map((s) => ({ x: s.pos.x, z: -s.pos.z })),
    }));
  }

  // ---- drawing -----------------------------------------------------------------------------

  /** called by the road editor when the tool changes */
  toolChanged(): void {
    this.draft = null;
    this.dirty = true;
  }

  private addDraftPoint(hit: THREE.Vector3): void {
    const tool = this.editor.state.tool;
    if (tool !== 'river' && tool !== 'lake') return;
    if (!this.draft || this.draft.kind !== tool) this.draft = { kind: tool, points: [] };
    this.draft.points.push({ x: hit.x, y: hit.y, z: -hit.z });
    this.dirty = true;
    this.editor.emitState();
  }

  cancelDraft(): void {
    if (!this.draft) return;
    this.draft = null;
    this.dirty = true;
    this.editor.emitState();
  }

  finishDraft(): void {
    const d = this.draft;
    if (!d) return;
    this.draft = null;
    this.dirty = true;
    if (d.kind === 'lake') {
      if (d.points.length < 3) { this.editor.setStatus('Ein See braucht mindestens 3 Punkte.', 'error'); this.editor.emitState(); return; }
      const outline = d.points.map((p) => ({ x: p.x, z: p.z }));
      const names = this.library.namesOf('lake');
      const lake: LakeDef = {
        id: newId('see'), name: `See ${this.model.lakeList.length + 1}`, style: names.includes(this.activeLakeStyle) ? this.activeLakeStyle : names[0] ?? 'bergsee',
        level: this.lakeLevelFor(outline), depth: 6, outline,
      };
      lake.depth = this.library.forLake(lake).depth;
      this.model.addLake(lake, 'See zeichnen');
      this.select('lake', lake.id);
      this.editor.setStatus('See angelegt – Pegel und Tiefe im Inspektor', 'ok');
      return;
    }
    if (d.points.length < 2) { this.editor.emitState(); return; }
    const names = this.library.namesOf('river');
    const river: RiverDef = {
      id: newId('fluss'), name: `Fluss ${this.model.riverList.length + 1}`, style: names.includes(this.activeRiverStyle) ? this.activeRiverStyle : names[0] ?? 'bach',
      points: d.points.map((p): RiverPoint => ({ x: p.x, y: p.y, z: p.z })),
    };
    // link the ends: a first point in a lake leaves it, a last point in a lake enters it, a last point on a river joins it
    const first = river.points[0], last = river.points[river.points.length - 1];
    const startLake = this.lakeAt(first.x, first.z), endLake = this.lakeAt(last.x, last.z);
    if (startLake) { river.startLake = startLake.id; river.points = this.trim(river.points, startLake, 'start'); }
    if (endLake) { river.endLake = endLake.id; river.points = this.trim(river.points, endLake, 'end'); }
    if (!endLake) {
      const other = this.riverNear(last.x, last.z, END_SNAP_M, river.id);
      if (other) river.endRiver = other.id;
    }
    river.points = autoLevel(river.points, this.ground, {
      startLevel: startLake?.level, endLevel: endLake?.level ?? (river.endRiver ? this.model.getRiver(river.endRiver) ? this.levelOfRiverNear(river.endRiver, last.x, last.z) : undefined : undefined),
    });
    this.model.addRiver(river, 'Fluss zeichnen');
    this.select('river', river.id);
    this.editor.setStatus(`Fluss angelegt${startLake ? ' · fliesst aus ' + startLake.name : ''}${endLake ? ' · mündet in ' + endLake.name : river.endRiver ? ' · mündet in ' + this.model.getRiver(river.endRiver)?.name : ''}`, 'ok');
  }

  /** style used for new waters (the toolbar's pick) */
  activeRiverStyle = 'bach';
  activeLakeStyle = 'bergsee';

  private levelOfRiverNear(riverId: string, x: number, z: number): number | undefined {
    const rt = this.system.rivers.find((r) => r.def.id === riverId);
    if (!rt) return undefined;
    let best: number | undefined, bd = Infinity;
    for (const s of rt.hydro.samples) { const d = Math.hypot(s.pos.x - x, -s.pos.z - z); if (d < bd) { bd = d; best = s.level; } }
    return best;
  }

  /** cut a river where it enters / leaves a lake (the points inside the lake go, the end sits on the shore) */
  private trim(points: RiverPoint[], lake: LakeDef, end: 'start' | 'end'): RiverPoint[] {
    return trimAtLake(points, smoothOutline(lake.outline), end, (x, z, from) => { const p: RiverPoint = { ...from, x, z }; if (end === 'end') delete p.seg; return p; });
  }

  private lakeAt(x: number, z: number): LakeDef | undefined {
    for (const l of this.model.lakeList) {
      const o = smoothOutline(l.outline);
      if (pointInOutline(x, z, o)) return l;
      if (distToOutline(o, x, z) < END_SNAP_M * 0.6) return l;
    }
    return undefined;
  }

  private riverNear(x: number, z: number, within: number, exclude?: string): RiverDef | undefined {
    let best: RiverDef | undefined, bd = within;
    for (const rt of this.system.rivers) {
      if (rt.def.id === exclude) continue;
      for (const s of rt.hydro.samples) {
        const d = Math.hypot(s.pos.x - x, -s.pos.z - z);
        if (d < bd) { bd = d; best = rt.def; }
      }
    }
    return best;
  }

  // ---- picking -----------------------------------------------------------------------------------

  /** the river or lake under a ground point (SIM x, z), if any */
  pickWater(x: number, z: number): WaterSelection | undefined {
    let best: WaterSelection | undefined, bd = Infinity;
    for (const rt of this.system.rivers) {
      for (const s of rt.hydro.samples) {
        const d = Math.hypot(s.pos.x - x, -s.pos.z - z) - s.width / 2;
        if (d < bd && d < PICK_M) { bd = d; best = { kind: 'river', id: rt.def.id }; }
      }
    }
    if (best) return best;
    for (const l of this.system.lakes) {
      const o = smoothOutline(l.def.outline);
      if (pointInOutline(x, z, o) || distToOutline(o, x, z) < PICK_M * 0.5) return { kind: 'lake', id: l.def.id };
    }
    return undefined;
  }

  insertPoint(x: number, z: number): boolean {
    const s = this.selection;
    if (!s) return false;
    if (s.kind === 'river') {
      const rt = this.system.rivers.find((r) => r.def.id === s.id);
      if (!rt) return false;
      let best: (typeof rt.hydro.samples)[number] | undefined, bd = PICK_M;
      for (const smp of rt.hydro.samples) { const d = Math.hypot(smp.pos.x - x, -smp.pos.z - z); if (d < bd) { bd = d; best = smp; } }
      if (!best) return false;
      const seg = best.seg;
      const kind = rt.def.points[seg]?.seg ?? 'river';
      if (kind === 'fall') { this.editor.setStatus('Auf einem Wasserfall lässt sich kein Punkt einfügen.', 'error'); return false; }
      const at = seg + 1;
      this.edit(s.id, 'Flusspunkt einfügen', (d) => {
        const np: RiverPoint = { x: best!.pos.x, y: best!.level, z: -best!.pos.z };
        if (kind !== 'river') np.seg = kind;
        d.points.splice(at, 0, np);
        if (this.autoLevel) this.levelRiver(d);
      });
      this.selectPoint(at);
      return true;
    }
    const l = this.model.getLake(s.id);
    if (!l) return false;
    let at = -1, bd = PICK_M;
    for (let i = 0; i < l.outline.length; i++) {
      const a = l.outline[i], b = l.outline[(i + 1) % l.outline.length];
      const d = distToSegment(x, z, a.x, a.z, b.x, b.z);
      if (d < bd) { bd = d; at = i + 1; }
    }
    if (at < 0) return false;
    this.model.editLake(s.id, 'Seepunkt einfügen', (d) => { d.outline.splice(at, 0, { x, z }); });
    this.selectPoint(at);
    return true;
  }

  // ---- handles -------------------------------------------------------------------------------------

  private rebuildHandles(): void {
    for (const m of this.meshes) { this.group.remove(m); (m.material as THREE.Material).dispose(); }
    for (const l of this.lines) { this.group.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
    this.meshes = [];
    this.lines = [];
    const add = (x: number, y: number, z: number, color: number, index: number): void => {
      const m = new THREE.Mesh(this.sphere, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
      m.position.set(x, y, -z);
      m.renderOrder = 100;
      m.userData.index = index;
      this.group.add(m);
      this.meshes.push(m);
    };
    const line = (pts: THREE.Vector3[], color: number, loop = false): void => {
      if (pts.length < 2) return;
      const g = new THREE.BufferGeometry().setFromPoints(loop ? [...pts, pts[0]] : pts);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }));
      l.renderOrder = 98;
      this.group.add(l);
      this.lines.push(l);
    };
    const kindColor = (k: SegmentKind | undefined): number => (k === 'fall' ? 0xff6a6a : k === 'rapids' ? 0x7fd0ff : 0xffffff);

    const s = this.selection;
    if (s?.kind === 'river') {
      const r = this.model.getRiver(s.id);
      if (r) r.points.forEach((p, k) => add(p.x, p.y + 1, p.z, k === s.index ? 0xff9a2e : kindColor(p.seg), k));
    } else if (s?.kind === 'lake') {
      const l = this.model.getLake(s.id);
      if (l) {
        l.outline.forEach((p, k) => add(p.x, l.level + 0.8, p.z, k === s.index ? 0xff9a2e : 0x9fe6ff, k));
        line(smoothOutline(l.outline).map((p) => new THREE.Vector3(p.x, l.level + 0.6, -p.z)), 0x9fe6ff, true);
      }
    }
    const d = this.draft;
    if (d) {
      d.points.forEach((p, k) => add(p.x, p.y + 1, p.z, k === d.points.length - 1 ? 0xff9a2e : 0x9fe6ff, k));
      line(d.points.map((p) => new THREE.Vector3(p.x, p.y + 0.8, -p.z)), 0x9fe6ff, d.kind === 'lake' && d.points.length > 2);
    }
    this.dirty = false;
  }

  /** once per frame: keeps the handles a constant size on screen, rebuilds them when stale, builds pending water */
  update(): void {
    this.system.resync({ builds: 24 });
    if (this.dirty) this.rebuildHandles();
    const cam = this.editor.host.camera.position;
    for (const m of this.meshes) m.scale.setScalar(Math.max(0.4, m.position.distanceTo(cam) * HANDLE_PX));
  }

  // ---- input -----------------------------------------------------------------------------------------

  private ndc(ev: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.editor.host.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  private pickHandle(ev: { clientX: number; clientY: number }): number | undefined {
    if (!this.meshes.length || this.draft) return undefined;
    this.raycaster.setFromCamera(this.ndc(ev), this.editor.host.camera);
    const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
    return hit ? (hit.object.userData.index as number) : undefined;
  }

  private bindInput(): void {
    const el = this.editor.host.domElement;
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false): void => {
      t.addEventListener(type, fn as EventListener, capture);
      this.cleanups.push(() => t.removeEventListener(type, fn as EventListener, capture));
    };

    on(el, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      this.down = { x: e.clientX, y: e.clientY, t: e.timeStamp, shift: e.shiftKey };
      if (this.editor.state.tool !== 'select' || !this.selection) return;
      const idx = this.pickHandle(e);
      if (idx === undefined) return;
      this.drag = { pointer: e.pointerId, index: idx };
      this.model.holdCoalesce(`dragwater:${this.selection.id}:${idx}`);
      this.selectPoint(idx);
      this.editor.host.setCameraEnabled(false);
      el.setPointerCapture?.(e.pointerId);
      e.stopImmediatePropagation();
    }, true);

    on(el, 'pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.pointer || !this.selection) return;
      const hit = this.editor.host.pickGround(e);
      if (!hit) return;
      const s = this.selection, idx = this.drag.index;
      if (s.kind === 'river') {
        this.edit(s.id, 'Flusspunkt bewegen', (d) => {
          const p = d.points[idx];
          if (!p) return;
          p.x = hit.x; p.z = -hit.z;
          if (this.autoLevel) this.levelRiver(d); else p.y = hit.y;
        }, `dragwater:${s.id}:${idx}`);
      } else {
        this.model.editLake(s.id, 'Seepunkt bewegen', (d) => { const p = d.outline[idx]; if (p) { p.x = hit.x; p.z = -hit.z; } }, `dragwater:${s.id}:${idx}`);
      }
    });

    const endDrag = (e: PointerEvent): void => {
      if (!this.drag || e.pointerId !== this.drag.pointer) return;
      this.drag = null;
      this.model.holdCoalesce(null);
      this.editor.host.setCameraEnabled(true);
      this.down = null;
      this.dirty = true;
      // a lake that was reshaped gets its level re-read only on request; a river's ends may now lie in / on something else
      const s = this.selection;
      if (s?.kind === 'river') this.relinkEnds(s.id);
    };

    on(el, 'pointerup', (e) => {
      if (this.drag) { endDrag(e); return; }
      const d = this.down; this.down = null;
      if (!d || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.timeStamp - d.t > 500) return;
      this.click(e, d.shift);
    });
    on(el, 'pointercancel', endDrag);

    on(el, 'dblclick', (e) => {
      if (this.editor.state.tool !== 'select' || !this.selection) return;
      const hit = this.editor.host.pickGround(e);
      if (hit) this.insertPoint(hit.x, -hit.z);
    });

    on(window, 'keydown', (e) => this.key(e));
  }

  /** after a river end was dragged: re-detect which lake / river it leaves / enters */
  private relinkEnds(id: string): void {
    const r = this.model.getRiver(id);
    if (!r) return;
    const first = r.points[0], last = r.points[r.points.length - 1];
    const sl = this.lakeAt(first.x, first.z)?.id, el = this.lakeAt(last.x, last.z)?.id;
    const trimmed = (pts: RiverPoint[]): RiverPoint[] => {
      let out = pts;
      const a = sl ? this.model.getLake(sl) : undefined, b = el ? this.model.getLake(el) : undefined;
      if (a) out = this.trim(out, a, 'start');
      if (b) out = this.trim(out, b, 'end');
      return out;
    };
    const er = el ? undefined : this.riverNear(last.x, last.z, END_SNAP_M, id)?.id;
    if (sl === r.startLake && el === r.endLake && er === r.endRiver) return;
    this.edit(id, 'Verbindung ändern', (d) => {
      if (sl) d.startLake = sl; else delete d.startLake;
      if (el) d.endLake = el; else delete d.endLake;
      d.points = trimmed(d.points);
      if (er) d.endRiver = er; else delete d.endRiver;
      if (this.autoLevel) this.levelRiver(d);
    });
  }

  private click(e: PointerEvent, shift: boolean): void {
    const tool = this.editor.state.tool;
    if (tool === 'river' || tool === 'lake') {
      const hit = this.editor.host.pickGround(e);
      if (hit) this.addDraftPoint(hit);
      return;
    }
    if (tool !== 'select') return;
    const hit = this.editor.host.pickGround(e);
    if (!hit) return;
    if (shift && this.selection && this.insertPoint(hit.x, -hit.z)) return;
    const now = e.timeStamp;
    const dbl = now - this.lastClickTime < 350;
    this.lastClickTime = now;
    if (dbl) return;
    if (this.editor.state.roadId || this.editor.state.nodeId) return; // a road / junction was hit first
    const w = this.pickWater(hit.x, -hit.z);
    if (w) this.select(w.kind, w.id); else this.clearSelection();
  }

  private key(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, select, .cm-editor')) return;
    if (e.ctrlKey || e.metaKey) return;
    const tool = this.editor.state.tool;
    if (e.key === 'r' || e.key === 'R') { this.editor.setTool(tool === 'river' ? 'select' : 'river'); return; }
    if (e.key === 'l' || e.key === 'L') { this.editor.setTool(tool === 'lake' ? 'select' : 'lake'); return; }
    if (tool === 'river' || tool === 'lake') {
      if (e.key === 'Enter') this.finishDraft();
      else if (e.key === 'Escape') { if (this.draft) this.cancelDraft(); else this.editor.setTool('select'); }
      else if (e.key === 'Backspace' && this.draft) { this.draft.points.pop(); this.dirty = true; this.editor.emitState(); }
      return;
    }
    if (tool !== 'select' || !this.selection) return;
    if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelectedPoint();
    else if (e.key === 'Escape') { this.selection.index !== undefined ? this.selectPoint(undefined) : this.clearSelection(); }
  }

  /** compile and activate a water style; on error the previous version stays */
  applySource(name: string, source: string): { ok: boolean; error?: string } {
    const r = this.library.setSource(name, source);
    if (r.ok) this.editor.markLibraryDirty();
    return r;
  }

  resetToPreset(name: string): boolean {
    const src = WATER_PRESET_SOURCES[name];
    return !!src && this.applySource(name, src).ok;
  }

  duplicate(from: string, newName: string): { ok: boolean; error?: string } {
    const src = this.library.getSource(from);
    if (src === undefined) return { ok: false, error: `Wasserstil '${from}' nicht gefunden` };
    if (!/^[a-z][a-z0-9_-]*$/i.test(newName)) return { ok: false, error: 'Name: Buchstaben, Ziffern, _ oder -; muss mit Buchstaben beginnen' };
    if (this.library.has(newName)) return { ok: false, error: `Wasserstil '${newName}' existiert bereits` };
    return this.applySource(newName, src);
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    for (const m of this.meshes) (m.material as THREE.Material).dispose();
    for (const l of this.lines) { l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
    this.editor.host.scene.remove(this.group);
    this.sphere.dispose();
  }

  /** a deep copy of the selected river's points (tests, tools) */
  snapshotRiver(id: string): RiverDef | undefined {
    const r = this.model.getRiver(id);
    return r ? cloneRiver(r) : undefined;
  }
}

function distToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

function distToOutline(outline: ReadonlyArray<{ x: number; z: number }>, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) best = Math.min(best, distToSegment(x, z, outline[i].x, outline[i].z, outline[j].x, outline[j].z));
  return best;
}
