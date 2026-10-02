// Level crossings (Bahnübergänge): where a road crosses a railway on the level. They are found from the built roads (no data to author:
// move the road and the crossing moves with it). A crossing gets Andreas crosses, red flashing lights and barriers on both sides of the
// track; they react to the trains: lights start when a train is coming, the barriers close a few seconds later and open again when it
// has gone. The road has to be at the height of the rail head there — author its points `fixed` at the track's height (+0.3 m).

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RoadRuntime } from '../runtime/roadRuntime';
import type { TrainLayer } from './train';

export interface Crossing {
  id: string;
  railId: string;
  roadId: string;
  sRail: number;
  sRoad: number;
  /** centre of the crossing, THREE space (y = road surface) */
  pos: THREE.Vector3;
  /** horizontal unit tangents of the road and of the railway there */
  roadDir: THREE.Vector3;
  railDir: THREE.Vector3;
  roadHalf: number;
  railHalf: number;
}

const GRADE_TOLERANCE_M = 1.6;

function interp(rt: RoadRuntime, i: number, f: number): number {
  const a = rt.designY[i], b = rt.designY[Math.min(rt.samples.length - 1, i + 1)];
  return Number.isNaN(a) || Number.isNaN(b) ? NaN : a + (b - a) * f;
}

/** Roads that cross a railway at grade (neither is on a bridge or in a tunnel, heights within 1.6 m). Needs the roads' chunks to be built. */
const boxes = new WeakMap<RoadRuntime, { x0: number; x1: number; z0: number; z1: number }>();
function boxOf(rt: RoadRuntime): { x0: number; x1: number; z0: number; z1: number } {
  let b = boxes.get(rt);
  if (!b) {
    b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const s of rt.samples) { b.x0 = Math.min(b.x0, s.pos.x); b.x1 = Math.max(b.x1, s.pos.x); b.z0 = Math.min(b.z0, s.pos.z); b.z1 = Math.max(b.z1, s.pos.z); }
    boxes.set(rt, b);
  }
  return b;
}

export function findCrossings(system: RoadSystem): Crossing[] {
  const out: Crossing[] = [];
  const rails = system.runtimes.filter((r) => r.profile.rail);
  const roads = system.runtimes.filter((r) => !r.profile.rail);
  for (const R of rails) {
    const rb = boxOf(R);
    for (const Q of roads) {
      const qb = boxOf(Q);
      if (qb.x1 < rb.x0 - 5 || qb.x0 > rb.x1 + 5 || qb.z1 < rb.z0 - 5 || qb.z0 > rb.z1 + 5) continue; // not even close
      let last: Crossing | undefined;
      const RS = R.samples, QS = Q.samples;
      for (let i = 0; i + 1 < RS.length; i++) {
        if (RS[i].mode !== 'road' || RS[i + 1].mode !== 'road') continue;
        const a = RS[i].pos, b = RS[i + 1].pos;
        for (let j = 0; j + 1 < QS.length; j++) {
          if (QS[j].mode !== 'road' || QS[j + 1].mode !== 'road') continue;
          const c = QS[j].pos, d = QS[j + 1].pos;
          const rx = b.x - a.x, rz = b.z - a.z, qx = d.x - c.x, qz = d.z - c.z;
          const den = rx * qz - rz * qx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((c.x - a.x) * qz - (c.z - a.z) * qx) / den;
          const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const yR = interp(R, i, t), yQ = interp(Q, j, u);
          if (Number.isNaN(yR) || Number.isNaN(yQ) || Math.abs(yQ - yR) > GRADE_TOLERANCE_M) continue;
          const sRail = RS[i].s + (RS[i + 1].s - RS[i].s) * t, sRoad = QS[j].s + (QS[j + 1].s - QS[j].s) * u;
          if (last && Math.abs(last.sRail - sRail) < 25 && Math.abs(last.sRoad - sRoad) < 25) continue;
          const crossing: Crossing = {
            id: `${R.def.id}x${Q.def.id}@${Math.round(sRail)}`, railId: R.def.id, roadId: Q.def.id, sRail, sRoad,
            pos: new THREE.Vector3(a.x + rx * t, yQ, a.z + rz * t),
            roadDir: new THREE.Vector3(qx, 0, qz).normalize(), railDir: new THREE.Vector3(rx, 0, rz).normalize(),
            roadHalf: Q.profile.carriageHalfWidth, railHalf: R.profile.coreHalfWidth,
          };
          out.push(crossing);
          last = crossing;
        }
      }
    }
  }
  return out;
}

interface Barrier {
  pivot: THREE.Group;
  lamps: [THREE.Mesh, THREE.Mesh];
}

interface Live {
  crossing: Crossing;
  group: THREE.Group;
  barriers: Barrier[];
  angle: number;
  warn: number;
  clear: number;
}

const OPEN_ANGLE = 1.35; // rad (≈ 77°)
const WARN_S = 3.5;
const APPROACH_M = 320;

export class CrossingLayer {
  readonly group = new THREE.Group();
  private live: Live[] = [];
  private dirty = true;
  private clock = 0;
  private checkClock = 0;
  private readonly mats: Record<string, THREE.Material>;
  private readonly unsub: Array<() => void> = [];

  constructor(private readonly system: RoadSystem, private readonly trains: TrainLayer) {
    this.group.name = 'level-crossings';
    this.mats = {
      post: new THREE.MeshLambertMaterial({ color: 0xcfd2d4 }),
      red: new THREE.MeshLambertMaterial({ color: 0xc41e24 }),
      white: new THREE.MeshLambertMaterial({ color: 0xf2f2ee }),
      dark: new THREE.MeshLambertMaterial({ color: 0x25272a }),
      lampOn: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
      lampOff: new THREE.MeshLambertMaterial({ color: 0x4a1210 }),
    };
    this.unsub.push(system.onChunkReady(() => { this.dirty = true; }));
    this.unsub.push(system.onRoadRemoved(() => { this.dirty = true; }));
    this.unsub.push(system.onRoadReplaced(() => { this.dirty = true; }));
  }

  get crossings(): readonly Crossing[] {
    return this.live.map((l) => l.crossing);
  }

  /** true while the barriers of crossing `id` are not fully open */
  isClosed(id: string): boolean {
    const l = this.live.find((x) => x.crossing.id === id);
    return !!l && l.angle < OPEN_ANGLE - 0.05;
  }

  private box(g: THREE.Object3D, w: number, h: number, l: number, x: number, y: number, z: number, mat: string): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), this.mats[mat]);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  }

  /** looks for crossings again; the barriers are only rebuilt when the set of crossings (or a position) changed */
  private rebuild(): void {
    const found = findCrossings(this.system);
    const same = found.length === this.live.length && found.every((c, i) => c.id === this.live[i].crossing.id && c.pos.distanceTo(this.live[i].crossing.pos) < 0.05);
    if (same) return;
    for (const l of this.live) this.group.remove(l.group);
    this.live = found.map((c) => this.make(c));
    for (const l of this.live) this.group.add(l.group);
  }

  private make(c: Crossing): Live {
    const group = new THREE.Group();
    group.position.copy(c.pos);
    // local frame: +z along the road, +x to the road's right
    group.rotation.y = Math.atan2(c.roadDir.x, c.roadDir.z);
    group.name = `crossing:${c.id}`;
    const barriers: Barrier[] = [];
    const along = c.railHalf / Math.max(0.3, Math.abs(Math.sin(Math.acos(Math.min(1, Math.abs(c.roadDir.dot(c.railDir))))))) + 2.8; // clear of the tracks even on a skew crossing
    for (const side of [-1, 1]) {
      // right-hand traffic: the post stands on the right of a vehicle approaching the tracks
      // (local +x is to the LEFT of a vehicle driving along +z): the post for traffic coming from -z stands at -x, -z, facing back
      const post = new THREE.Group();
      post.position.set(side * (c.roadHalf + 1.1), 0, side * along);
      post.rotation.y = side < 0 ? Math.PI : 0;
      group.add(post);
      this.box(post, 0.14, 3.6, 0.14, 0, 1.8, 0, 'post');
      // Andreas cross and two red lights
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        const arm = this.box(post, 1.3, 0.2, 0.05, 0, 3.4, 0.1, a > 0 ? 'red' : 'white');
        arm.rotation.z = a;
      }
      const lampL = this.box(post, 0.24, 0.24, 0.06, -0.38, 2.7, 0.1, 'lampOff');
      const lampR = this.box(post, 0.24, 0.24, 0.06, 0.38, 2.7, 0.1, 'lampOff');
      this.box(post, 1.15, 0.5, 0.04, 0, 2.7, 0.07, 'dark');
      // barrier: an arm that swings up from the post across the road
      const pivot = new THREE.Group();
      pivot.position.set(0, 1.0, 0);
      post.add(pivot);
      const reach = c.roadHalf + 1.4; // past the middle of the road
      const segs = 8;
      for (let k = 0; k < segs; k++) {
        const l = reach / segs;
        // the arm points to the road's middle: -x in the post's own frame (the half turn of the other post mirrors it)
        this.box(pivot, l, 0.11, 0.07, -(k + 0.5) * l, 0, 0, k % 2 === 0 ? 'red' : 'white');
      }
      barriers.push({ pivot, lamps: [lampL, lampR] });
    }
    return { crossing: c, group, barriers, angle: OPEN_ANGLE, warn: 0, clear: 0 };
  }

  /** is a train on or coming to the crossing? */
  private wanted(c: Crossing): boolean {
    for (const t of this.trains.trains) {
      if (this.trains.distanceTo(t, c.railId, c.sRail, APPROACH_M) !== null) return true;
    }
    return false;
  }

  update(dtIn: number): void {
    const dt = Math.min(0.1, Math.max(0, dtIn));
    this.clock += dt;
    this.checkClock += dt;
    // look again when chunks were built or roads changed (at most every 1.5 s)
    if (this.dirty && this.checkClock > 1.5) { this.checkClock = 0; this.dirty = false; this.rebuild(); }
    for (const l of this.live) {
      const want = this.wanted(l.crossing);
      if (want) { l.warn += dt; l.clear = 0; } else { l.clear += dt; if (l.clear > 2) l.warn = 0; }
      const closing = want && l.warn > WARN_S;
      const target = closing ? 0 : OPEN_ANGLE;
      const rate = closing ? 0.28 : 0.3; // rad/s
      l.angle += Math.max(-rate * dt, Math.min(rate * dt, target - l.angle));
      const flashing = want || l.angle < OPEN_ANGLE - 0.02;
      const phase = Math.floor(this.clock * 2.4) % 2 === 0;
      for (const b of l.barriers) {
        b.pivot.rotation.z = -l.angle; // the arm points along -x: a negative turn lifts it
        b.lamps[0].material = this.mats[flashing && phase ? 'lampOn' : 'lampOff'];
        b.lamps[1].material = this.mats[flashing && !phase ? 'lampOn' : 'lampOff'];
      }
    }
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.group.clear();
    this.live = [];
  }
}
