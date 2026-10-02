// Turns ready road chunks of railway profiles into rail meshes (sleepers, rails, switches, overhead line, signal posts). Same idiom as
// TunnelLayer / BridgeLayer: one merged mesh per chunk, a replaced road keeps its old track visible until the new one is complete, far
// chunks are hidden.
//
// Two things change at run time and therefore live outside the merged meshes:
//  - the lamps of the light signals (`setSignalAspect`),
//  - the position of a track switch (`setSwitch`): the chunks around it are rebuilt with the blades and the lantern in the other position.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { PropMaterials } from '../props/materials';
import { buildChunkRail, type RailContext, type SignalDef, type SwitchState } from './geometry';
import type { SwitchInfo } from '../network/attach';

export interface RailLayerOptions {
  drawDistance: number;
}

export type Aspect = 'red' | 'yellow' | 'green';

interface Entry {
  mesh: THREE.Mesh | null;
  lamps: THREE.Group | null;
  signals: SignalInstance[];
}

interface SignalInstance {
  def: SignalDef;
  aspect: Aspect;
  lamps: Record<Aspect, THREE.Mesh>;
  group: THREE.Group;
}

const LAMP_Y: Record<Aspect, number> = { red: 4.25, yellow: 3.9, green: 3.55 };
const lampGeometry = new THREE.BoxGeometry(0.15, 0.15, 0.026);

export class RailLayer {
  readonly group = new THREE.Group();
  private readonly byRuntime = new Map<RoadRuntime, Map<number, Entry>>();
  private readonly retired = new Map<string, RoadRuntime[]>();
  private readonly unsub: Array<() => void> = [];
  private readonly opts: RailLayerOptions;
  private stats = { sleepers: 0, masts: 0, signals: 0, switches: 0 };
  private readonly signalMap = new Map<string, SignalInstance>();
  private readonly overrides = new Map<string, SwitchState>();
  private readonly ctx: RailContext;

  constructor(private readonly system: RoadSystem, private readonly materials: PropMaterials = new PropMaterials(), opts: Partial<RailLayerOptions> = {}) {
    this.opts = { drawDistance: 900, ...opts };
    this.group.name = 'road-rails';
    this.ctx = { switchState: (id) => this.switchState(id) };
    this.unsub.push(system.onChunkReady((rt, chunk) => this.buildChunk(rt, chunk)));
    this.unsub.push(system.onRoadRemoved((rt) => this.removeOwner(rt.def.id)));
    this.unsub.push(system.onRoadReplaced((prev, next) => {
      const l = this.retired.get(prev.def.id) ?? [];
      l.push(prev);
      this.retired.set(prev.def.id, l);
      // a switch that changed position (or moved) also changes the track it leaves
      for (const which of ['attach', 'attachEnd'] as const) {
        const a = next.def[which];
        if (a?.kind === 'switch' && (prev.def[which]?.state !== a.state)) this.rebuildParent(a.road, a.s, a.len);
      }
    }));
  }

  get meshCount(): number {
    let n = 0;
    for (const m of this.byRuntime.values()) for (const e of m.values()) if (e.mesh) n++;
    return n;
  }

  /** what has been built so far (diagnostics, tests) */
  get counts(): { sleepers: number; masts: number; signals: number; switches: number } {
    return { ...this.stats };
  }

  // ---- track switches ----------------------------------------------------------------------------------------------

  /** every switch of the network, with its current position */
  switches(): Array<SwitchInfo & { state: SwitchState; parentId: string }> {
    const out: Array<SwitchInfo & { state: SwitchState; parentId: string }> = [];
    for (const rt of this.system.runtimes) for (const which of ['attach', 'attachEnd'] as const) {
      const a = rt.def[which];
      if (a?.kind === 'switch') out.push({ id: `${rt.def.id}:${which}`, childId: rt.def.id, which, attach: a, parentId: a.road, state: this.switchState(`${rt.def.id}:${which}`) });
    }
    return out;
  }

  switchState(id: string): SwitchState {
    const o = this.overrides.get(id);
    if (o) return o;
    const [childId, which] = id.split(':') as [string, 'attach' | 'attachEnd'];
    const rt = this.system.runtimes.find((r) => r.def.id === childId);
    return rt?.def[which]?.state ?? 'straight';
  }

  /** Sets a switch (at run time, not saved with the document) and rebuilds the track around it. */
  setSwitch(id: string, state: SwitchState): void {
    if (this.switchState(id) === state) return;
    this.overrides.set(id, state);
    const [childId, which] = id.split(':') as [string, 'attach' | 'attachEnd'];
    const child = this.system.runtimes.find((r) => r.def.id === childId);
    const a = child?.def[which];
    if (!child || !a) return;
    this.rebuildParent(a.road, a.s, a.len);
    const L = child.sampled.curve.length;
    const len = a.len ?? 0;
    this.rebuildRange(child, which === 'attach' ? 0 : L - len, which === 'attach' ? len : L);
  }

  private rebuildParent(parentId: string, nose: number | undefined, len: number | undefined): void {
    const rt = this.system.runtimes.find((r) => r.def.id === parentId);
    if (!rt || nose === undefined) return;
    this.rebuildRange(rt, nose - (len ?? 0) - 5, nose + (len ?? 0) + 5);
  }

  private rebuildRange(rt: RoadRuntime, s0: number, s1: number): void {
    for (const chunk of rt.chunks) {
      if (chunk.state !== 'ready') continue;
      if (rt.samples[chunk.i1].s < s0 || rt.samples[chunk.i0].s > s1) continue;
      this.buildChunk(rt, chunk);
    }
  }

  // ---- signals -----------------------------------------------------------------------------------------------------

  /** all light signals currently built */
  signals(): Array<{ def: SignalDef; aspect: Aspect }> {
    return [...this.signalMap.values()].map((s) => ({ def: s.def, aspect: s.aspect }));
  }

  setSignalAspect(id: string, aspect: Aspect): void {
    const s = this.signalMap.get(id);
    if (!s || s.aspect === aspect) return;
    s.aspect = aspect;
    for (const a of ['red', 'yellow', 'green'] as Aspect[]) s.lamps[a].visible = a === aspect;
  }

  private makeSignal(def: SignalDef): SignalInstance {
    const group = new THREE.Group();
    const lamps = {} as Record<Aspect, THREE.Mesh>;
    const basis = new THREE.Matrix4().makeBasis(def.side, def.up, def.front);
    for (const a of ['red', 'yellow', 'green'] as Aspect[]) {
      const m = new THREE.Mesh(lampGeometry, this.materials.get(`rail_lamp_${a}`));
      m.position.copy(def.pos).addScaledVector(def.up, LAMP_Y[a]).addScaledVector(def.front, 0.21);
      m.setRotationFromMatrix(basis);
      m.visible = a === def.aspect;
      group.add(m);
      lamps[a] = m;
    }
    return { def, aspect: def.aspect, lamps, group };
  }

  // ---- building ----------------------------------------------------------------------------------------------------

  private clearEntry(e: Entry): void {
    if (e.mesh) { e.mesh.geometry.dispose(); this.group.remove(e.mesh); }
    if (e.lamps) this.group.remove(e.lamps);
    for (const inst of e.signals) if (this.signalMap.get(inst.def.id) === inst) this.signalMap.delete(inst.def.id);
  }

  private buildChunk(rt: RoadRuntime, chunk: RoadChunk): void {
    const built = buildChunkRail(rt, chunk, this.ctx);
    if (!built) { if (rt.pendingCount === 0) this.dropRetired(rt.def.id); return; }
    let entries = this.byRuntime.get(rt);
    if (!entries) { entries = new Map(); this.byRuntime.set(rt, entries); }
    const old = entries.get(chunk.index);
    const aspects = new Map((old?.signals ?? []).map((i) => [i.def.id, i.aspect]));
    if (old) { this.clearEntry(old); entries.delete(chunk.index); }
    const g = built.batch.build();
    const entry: Entry = { mesh: null, lamps: null, signals: [] };
    if (g) {
      const mesh = new THREE.Mesh(g.geometry, g.materials.map((n) => this.materials.get(n)));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `rail:${rt.def.id}#${chunk.index}`;
      this.group.add(mesh);
      entry.mesh = mesh;
    }
    if (built.signalDefs.length) {
      const lamps = new THREE.Group();
      lamps.name = `rail-signals:${rt.def.id}#${chunk.index}`;
      for (const def of built.signalDefs) {
        const inst = this.makeSignal(def);
        const keep = aspects.get(def.id) ?? this.signalMap.get(def.id)?.aspect;
        if (keep) { inst.aspect = keep; for (const a of ['red', 'yellow', 'green'] as Aspect[]) inst.lamps[a].visible = a === keep; }
        this.signalMap.set(def.id, inst);
        entry.signals.push(inst);
        lamps.add(inst.group);
      }
      this.group.add(lamps);
      entry.lamps = lamps;
    }
    entries.set(chunk.index, entry);
    this.stats.sleepers += built.sleepers; this.stats.masts += built.masts; this.stats.signals += built.signals; this.stats.switches += built.switches;
    if (rt.pendingCount === 0) this.dropRetired(rt.def.id);
  }

  /** hides chunks further than `drawDistance` from the camera */
  update(camera: THREE.Vector3 | THREE.Object3D): void {
    const c = camera instanceof THREE.Vector3 ? camera : camera.getWorldPosition(new THREE.Vector3());
    for (const entries of this.byRuntime.values()) for (const e of entries.values()) {
      const bs = e.mesh?.geometry.boundingSphere;
      const vis = !bs || bs.center.distanceTo(c) - bs.radius < this.opts.drawDistance;
      if (e.mesh) e.mesh.visible = vis;
      if (e.lamps) e.lamps.visible = vis;
    }
  }

  private dropRetired(id: string): void {
    for (const prev of this.retired.get(id) ?? []) this.disposeOwner(prev);
    this.retired.delete(id);
  }

  private disposeOwner(rt: RoadRuntime): void {
    const entries = this.byRuntime.get(rt);
    if (!entries) return;
    for (const e of entries.values()) this.clearEntry(e);
    this.byRuntime.delete(rt);
  }

  private removeOwner(id: string): void {
    this.dropRetired(id);
    for (const rt of [...this.byRuntime.keys()]) if (rt.def.id === id) this.disposeOwner(rt);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const rt of [...this.byRuntime.keys()]) this.disposeOwner(rt);
    this.retired.clear();
    this.signalMap.clear();
    this.group.clear();
  }
}
