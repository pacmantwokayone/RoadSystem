// Renders the traffic lights of all junctions with `control: 'signals'`: housings and poles as one merged
// mesh per junction, the lamps as a second mesh whose vertex colours are switched when the signal
// state changes (no per-frame cost while nothing changes). Time comes from the caller — `update(seconds)` —
// so the lights can follow game time, a server clock, or a test.

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { JunctionRuntime } from '../runtime/junctionRuntime';
import { DEFAULT_GREEN_S } from '../network/types';
import { carLamps, pedLamps, planPhases, SignalController, type SignalFrame } from '../junction/signals';
import { PropAssets, SIGNAL_LAMPS } from './assets';
import { GeometryBatch } from './batch';
import { PropMaterials } from './materials';
import { placementMatrix } from './propLayer';
import { planSignalSetup, type SignalHead, type SignalSetup } from './signalHeads';

const COLORS = {
  r: new THREE.Color(1, 0.12, 0.08), y: new THREE.Color(1, 0.78, 0.05), g: new THREE.Color(0.1, 0.95, 0.4),
  off: new THREE.Color(0.1, 0.1, 0.11),
};

interface Lamp { head: number; id: 'r' | 'y' | 'g'; start: number; count: number }

interface Entry {
  junction: JunctionRuntime;
  setup: SignalSetup;
  controller: SignalController;
  housings: THREE.Mesh | null;
  lamps: THREE.Mesh;
  lampMap: Lamp[];
  colors: THREE.BufferAttribute;
  lampOn: Map<string, boolean>;
  signature: string;
}

export interface SignalLayerOptions {
  drawDistance: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export class SignalLayer {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, Entry>();
  private readonly unsub: Array<() => void> = [];
  private readonly lampMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly opts: SignalLayerOptions;
  private time = 0;

  constructor(
    system: RoadSystem,
    opts: Partial<SignalLayerOptions> = {},
    readonly materials: PropMaterials = new PropMaterials(),
    readonly assets: PropAssets = new PropAssets(),
  ) {
    this.opts = { drawDistance: 500, ...opts };
    this.group.name = 'road-signals';
    this.unsub.push(system.onJunctionReady((j) => this.build(j)));
    this.unsub.push(system.onJunctionRemoved((j) => this.remove(j.id)));
  }

  get count(): number {
    return this.entries.size;
  }

  heads(nodeId: string): readonly SignalHead[] {
    return this.entries.get(nodeId)?.setup.heads ?? [];
  }

  controllerOf(nodeId: string): SignalController | undefined {
    return this.entries.get(nodeId)?.controller;
  }

  /** The lit state of every lamp right now, for tests and UIs: `${head index}:${r|y|g}` → on. */
  lampStates(nodeId: string): ReadonlyMap<string, boolean> {
    return this.entries.get(nodeId)?.lampOn ?? new Map();
  }

  private remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    for (const m of [e.housings, e.lamps]) if (m) { m.geometry.dispose(); this.group.remove(m); }
    this.entries.delete(id);
  }

  private build(j: JunctionRuntime): void {
    this.remove(j.id); // a replaced junction: the new version takes over
    const setup = planSignalSetup(j);
    if (!setup) return;

    // phase plan over the motor-road arms only; indices mapped back to arm order
    const plan = planPhases(setup.arms.map((i) => setup.dirs[i]));
    plan.phases = plan.phases.map((ph) => ph.map((k) => setup.arms[k]));
    const probe = new SignalController(plan, j.arms.length, j.node.signalMode ?? 'fixed', { greenS: j.node.greenS ?? DEFAULT_GREEN_S });
    const controller = new SignalController(plan, j.arms.length, j.node.signalMode ?? 'fixed', { greenS: j.node.greenS ?? DEFAULT_GREEN_S }, hash(j.id) * probe.cycleS);

    // housings + poles
    const batch = new GeometryBatch();
    const m = new THREE.Matrix4();
    for (const h of setup.heads) {
      m.copy(placementMatrix({ asset: '', pos: h.pos, yaw: h.yaw, scale: 1, rule: -1, s: 0, side: 'right' }));
      for (const part of this.assets.parts(h.kind === 'car' ? 'signal_car' : 'signal_ped')) batch.addGeometry(part.material, part.geometry, m);
    }
    const built = batch.build();
    let housings: THREE.Mesh | null = null;
    if (built) {
      housings = new THREE.Mesh(built.geometry, built.materials.map((n) => this.materials.get(n)));
      housings.castShadow = true;
      housings.name = `signals:${j.id}`;
      this.group.add(housings);
    }

    // lamps: one small disc per lamp, vertex colours switched at run time
    const pos: number[] = [], idx: number[] = [], lampMap: Lamp[] = [];
    const disc = new THREE.CircleGeometry(1, 10);
    setup.heads.forEach((h, hi) => {
      const mat = placementMatrix({ asset: '', pos: h.pos, yaw: h.yaw, scale: 1, rule: -1, s: 0, side: 'right' });
      const list = SIGNAL_LAMPS[h.kind === 'car' ? 'signal_car' : 'signal_ped'];
      for (const l of list) {
        const start = pos.length / 3;
        const dpos = disc.getAttribute('position');
        const v = new THREE.Vector3();
        for (let i = 0; i < dpos.count; i++) {
          v.set(dpos.getX(i) * l.r + l.x, dpos.getY(i) * l.r + l.y, l.z).applyMatrix4(mat);
          pos.push(v.x, v.y, v.z);
        }
        for (const i of disc.getIndex()!.array) idx.push(start + i);
        lampMap.push({ head: hi, id: l.id as 'r' | 'y' | 'g', start, count: dpos.count });
      }
    });
    disc.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const colors = new THREE.BufferAttribute(new Float32Array(pos.length), 3);
    g.setAttribute('color', colors);
    g.setIndex(idx);
    g.computeBoundingSphere();
    const lamps = new THREE.Mesh(g, this.lampMaterial);
    lamps.name = `signal-lamps:${j.id}`;
    this.group.add(lamps);

    const entry: Entry = { junction: j, setup, controller, housings, lamps, lampMap, colors, lampOn: new Map(), signature: '' };
    this.entries.set(j.id, entry);
    this.apply(entry, this.time);
  }

  /** Switches the lamps to the state at time `t` (seconds); hides signals beyond the draw distance when a camera is given. */
  update(t: number, camera?: THREE.Vector3 | THREE.Object3D): void {
    this.time = t;
    const c = camera ? (camera instanceof THREE.Vector3 ? camera : camera.getWorldPosition(new THREE.Vector3())) : null;
    for (const e of this.entries.values()) {
      if (c) {
        const bs = e.lamps.geometry.boundingSphere;
        const visible = !bs || bs.center.distanceTo(c) - bs.radius < this.opts.drawDistance;
        e.lamps.visible = visible;
        if (e.housings) e.housings.visible = visible;
        if (!visible) continue;
      }
      this.apply(e, t);
    }
  }

  private apply(e: Entry, t: number): void {
    const frame: SignalFrame = e.controller.at(t);
    const flash = Math.floor(t) % 2;
    const sig = frame.cars.join(',') + '|' + frame.peds.join(',') + '|' + (frame.cars.includes('flashing') ? flash : '');
    if (sig === e.signature) return;
    e.signature = sig;
    for (const l of e.lampMap) {
      const head = e.setup.heads[l.head];
      let on: boolean;
      if (head.kind === 'car') on = carLamps(frame.cars[head.arm], t)[l.id];
      else on = pedLamps(frame.peds[head.arm])[l.id === 'y' ? 'r' : (l.id as 'r' | 'g')];
      e.lampOn.set(`${l.head}:${l.id}`, on);
      const col = on ? COLORS[l.id] : COLORS.off;
      for (let i = 0; i < l.count; i++) e.colors.setXYZ(l.start + i, col.r, col.g, col.b);
    }
    e.colors.needsUpdate = true;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const id of [...this.entries.keys()]) this.remove(id);
    this.lampMaterial.dispose();
    this.assets.dispose();
    this.materials.dispose();
  }
}
