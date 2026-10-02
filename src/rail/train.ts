// Trains. A train is a locomotive and some coaches riding on the rails of the road network: it keeps the path its front has run over, and
// every car stands on two bogies that sit on that path. A simple driver keeps the train on the rails: it stops at red signals, creeps at
// yellow, stops at the platform of a station for a while, keeps clear of other trains, and turns round at the end of the line. The
// signals' aspects come from the same occupancy picture (block signalling: red = a train in the next 350 m, yellow = in the next 900 m).

import * as THREE from 'three';
import type { RoadSystem } from '../runtime/roadSystem';
import type { RailLayer } from './railLayer';
import { RailNetwork, type Cursor, type Seg } from './network';

export interface TrainSpec {
  id: string;
  /** where the front of the train is, and which way it runs; the train stands behind it */
  start: Cursor;
  /** coaches behind the locomotive (default 4) */
  coaches?: number;
  /** top speed, m/s (default 28 = 100 km/h) */
  maxSpeed?: number;
  /** stop at stations (default true) */
  stops?: boolean;
}

interface Car {
  len: number;
  group: THREE.Group;
}

const LOCO_LEN = 18.5, COACH_LEN = 26.4, CAR_GAP = 0.7;
const ACCEL = 0.8, DECEL = 0.9;
const STATION_DWELL_S = 14, END_DWELL_S = 8;
const SIGNAL_RED_M = 350, SIGNAL_YELLOW_M = 900;

const brakingSpeed = (distance: number): number => Math.sqrt(2 * DECEL * Math.max(0, distance));

export class Train {
  readonly cars: Car[] = [];
  readonly length: number;
  front: Cursor;
  history: Seg[];
  speed = 0;
  readonly maxSpeed: number;
  readonly stops: boolean;
  /** seconds left of the stop at a station or the end of the line */
  wait = 0;
  /** stations already served on this run: `${roadId}:${dir}` */
  readonly served = new Set<string>();
  /** the train is waiting at the end of the line and will turn round when the wait is over */
  turning = false;

  constructor(readonly spec: TrainSpec, cars: Car[], network: RailNetwork) {
    this.cars = cars;
    this.length = cars.reduce((n, c) => n + c.len, 0) + CAR_GAP * (cars.length - 1);
    this.front = { ...spec.start };
    this.maxSpeed = spec.maxSpeed ?? 28;
    this.stops = spec.stops ?? true;
    const back = network.length(spec.start.roadId) > 0 ? Math.min(this.length, spec.start.dir === 1 ? spec.start.s : network.length(spec.start.roadId) - spec.start.s) : this.length;
    this.history = [{ roadId: spec.start.roadId, from: spec.start.s - spec.start.dir * back, to: spec.start.s }];
  }

  get id(): string { return this.spec.id; }

  /** the position `back` metres behind the front along the path the front has taken */
  locate(back: number): { roadId: string; s: number; dir: 1 | -1 } {
    let d = back;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const g = this.history[i];
      const len = Math.abs(g.to - g.from);
      const dir: 1 | -1 = g.to >= g.from ? 1 : -1;
      if (d <= len || i === 0) return { roadId: g.roadId, s: g.to - dir * Math.min(d, len), dir };
      d -= len;
    }
    return { roadId: this.front.roadId, s: this.front.s, dir: this.front.dir };
  }

  /** the stretches of road the train covers (for occupancy), newest first */
  occupancy(): Array<{ roadId: string; lo: number; hi: number; dir: 1 | -1 }> {
    const out: Array<{ roadId: string; lo: number; hi: number; dir: 1 | -1 }> = [];
    let left = this.length;
    for (let i = this.history.length - 1; i >= 0 && left > 0; i--) {
      const g = this.history[i];
      const len = Math.abs(g.to - g.from);
      const dir: 1 | -1 = g.to >= g.from ? 1 : -1;
      const use = Math.min(len, left);
      const a = g.to, b = g.to - dir * use;
      out.push({ roadId: g.roadId, lo: Math.min(a, b), hi: Math.max(a, b), dir });
      left -= use;
    }
    return out;
  }

  /** append the stretches the front just ran over, forget what lies behind the tail */
  extend(segs: readonly Seg[]): void {
    for (const sg of segs) {
      const last = this.history[this.history.length - 1];
      if (last && last.roadId === sg.roadId && Math.abs(last.to - sg.from) < 1e-6 && (last.to - last.from) * (sg.to - sg.from) >= 0) last.to = sg.to;
      else this.history.push({ ...sg });
    }
    this.trim(this.length + 12);
  }

  private trim(keep: number): void {
    let total = 0;
    for (const g of this.history) total += Math.abs(g.to - g.from);
    while (this.history.length > 1 && total - Math.abs(this.history[0].to - this.history[0].from) >= keep) {
      total -= Math.abs(this.history[0].to - this.history[0].from);
      this.history.shift();
    }
    const first = this.history[0];
    const over = total - keep;
    if (over > 0 && first) first.from += (first.to >= first.from ? 1 : -1) * Math.min(over, Math.abs(first.to - first.from));
  }

  /** run the other way: the tail becomes the front */
  reverse(): void {
    this.trim(this.length);
    const first = this.history[0];
    const rev = this.history.slice().reverse().map((g) => ({ roadId: g.roadId, from: g.to, to: g.from }));
    this.history = rev;
    // the tail was where the oldest stretch began; it now faces the other way
    this.front = { roadId: first.roadId, s: first.from, dir: (first.to >= first.from ? -1 : 1) as 1 | -1 };
    this.served.clear();
  }
}

export class TrainLayer {
  readonly group = new THREE.Group();
  readonly trains: Train[] = [];
  readonly network: RailNetwork;
  private readonly materials: Record<string, THREE.Material>;
  private signalClock = 0;
  private readonly pose = { pos: new THREE.Vector3(), tangent: new THREE.Vector3() };

  constructor(system: RoadSystem, private readonly rail: RailLayer) {
    this.group.name = 'trains';
    this.network = new RailNetwork(system, (id) => rail.switchState(id));
    const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}): THREE.Material => new THREE.MeshLambertMaterial({ color, ...extra });
    this.materials = {
      loco: lam(0xc41e24), coach: lam(0xdcd9d0), stripe: lam(0xc41e24), window: lam(0x1d2832), roof: lam(0x80868c),
      dark: lam(0x2a2c30), light: new THREE.MeshBasicMaterial({ color: 0xfff6d0 }),
    };
  }

  // ---- building -------------------------------------------------------------------------------------------------

  private box(parent: THREE.Group, w: number, h: number, l: number, x: number, y: number, z: number, mat: string): void {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), this.materials[mat]);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
  }

  private makeCar(kind: 'loco' | 'coach'): Car {
    const g = new THREE.Group();
    const len = kind === 'loco' ? LOCO_LEN : COACH_LEN;
    const body = kind === 'loco' ? 'loco' : 'coach';
    // body from 1.0 m to 4.0 m above the rail head, +z is forward
    this.box(g, 2.9, 3.0, len, 0, 2.5, 0, body);
    this.box(g, 2.5, 0.28, len - 0.6, 0, 4.1, 0, 'roof');
    this.box(g, 2.3, 0.55, len - 5, 0, 0.78, 0, 'dark');
    for (const z of [-len / 2 + 3.3, len / 2 - 3.3]) this.box(g, 2.1, 0.75, 3.2, 0, 0.5, z, 'dark');
    if (kind === 'coach') {
      for (const sx of [-1, 1]) {
        this.box(g, 0.03, 0.95, len - 4.5, sx * 1.46, 3.0, 0, 'window');
        this.box(g, 0.03, 0.28, len - 0.5, sx * 1.46, 2.0, 0, 'stripe');
      }
    } else {
      for (const sx of [-1, 1]) this.box(g, 0.03, 0.8, 1.6, sx * 1.46, 3.2, len / 2 - 3, 'window');
      this.box(g, 2.2, 0.15, 0.1, 0, 4.2, 0, 'dark');
      // pantograph: base, two arms, head
      this.box(g, 1.2, 0.1, 1.4, 0, 4.28, -3.2, 'dark');
      this.box(g, 0.06, 0.06, 1.7, -0.3, 4.9, -3.2, 'dark'); this.box(g, 0.06, 0.06, 1.7, 0.3, 4.9, -3.2, 'dark');
      this.box(g, 1.9, 0.05, 0.12, 0, 5.62, -3.2, 'dark');
      for (const sx of [-1, 1]) this.box(g, 0.28, 0.2, 0.05, sx * 0.9, 1.5, len / 2 + 0.02, 'light');
    }
    this.group.add(g);
    return { len, group: g };
  }

  add(specIn: TrainSpec): Train {
    // a negative start is measured from the end of the road
    const L = this.network.length(specIn.start.roadId);
    const spec = specIn.start.s < 0 ? { ...specIn, start: { ...specIn.start, s: Math.max(0, L + specIn.start.s) } } : specIn;
    const cars: Car[] = [this.makeCar('loco')];
    for (let i = 0; i < (spec.coaches ?? 4); i++) cars.push(this.makeCar('coach'));
    const t = new Train(spec, cars, this.network);
    this.trains.push(t);
    this.place(t);
    return t;
  }

  remove(id: string): void {
    const i = this.trains.findIndex((t) => t.id === id);
    if (i < 0) return;
    for (const c of this.trains[i].cars) this.group.remove(c.group);
    this.trains.splice(i, 1);
  }

  // ---- driving --------------------------------------------------------------------------------------------------

  /** the distance a train would still have to run to the point (roadId, s), or null when it is not coming that way within maxDist */
  distanceTo(t: Train, roadId: string, s: number, maxDist: number): number | null {
    for (const o of t.occupancy()) if (o.roadId === roadId && s >= o.lo - 1 && s <= o.hi + 1) return 0; // on it
    let cur: Cursor = { ...t.front };
    let dist = 0;
    while (dist < maxDist) {
      const res = this.network.advance(cur, 10);
      let d = dist;
      for (const sg of res.segs) {
        const lo = Math.min(sg.from, sg.to), hi = Math.max(sg.from, sg.to);
        if (sg.roadId === roadId && s >= lo - 1e-6 && s <= hi + 1e-6) return d + Math.abs(s - sg.from);
        d += hi - lo;
      }
      dist += 10;
      cur = res.cursor;
      if (res.hitEnd) break;
    }
    return null;
  }

  private targetSpeed(t: Train): number {
    let v = t.maxSpeed;
    const signals = this.rail.signals();
    const stations = this.network.stations();
    const others = this.trains.filter((o) => o !== t).map((o) => o.occupancy());
    let cur: Cursor = { ...t.front };
    let dist = 0;
    for (let guard = 0; dist < 900 && guard < 100; guard++) {
      const res = this.network.advance(cur, 10);
      let d = dist;
      for (const sg of res.segs) {
        const dir: 1 | -1 = sg.to >= sg.from ? 1 : -1;
        const lo = Math.min(sg.from, sg.to), hi = Math.max(sg.from, sg.to);
        const rt = this.network.road(sg.roadId);
        const single = rt ? this.network.isSingleTrack(rt) : true;
        for (const sig of signals) {
          if (sig.def.roadId !== sg.roadId || sig.def.dir !== dir || sig.def.s < lo - 1e-6 || sig.def.s > hi + 1e-6 || sig.def.s === t.front.s && d === 0) continue;
          const ds = d + Math.abs(sig.def.s - sg.from);
          if (sig.aspect === 'red') v = Math.min(v, brakingSpeed(ds - 14));
          else if (sig.aspect === 'yellow' && ds < 400) v = Math.min(v, 15);
        }
        if (t.stops) {
          for (const st of stations) {
            if (st.roadId !== sg.roadId || t.served.has(`${st.roadId}:${dir}`)) continue;
            const stop = st.s + dir * t.length / 2; // the train's middle stands at the middle of the platform
            if (stop >= lo - 1e-6 && stop <= hi + 1e-6) v = Math.min(v, brakingSpeed(d + Math.abs(stop - sg.from)));
          }
        }
        for (const occ of others) for (const o of occ) {
          if (o.roadId !== sg.roadId || (!single && o.dir !== dir) || o.hi < lo || o.lo > hi) continue;
          const gap = d + Math.max(0, dir === 1 ? o.lo - sg.from : sg.from - o.hi);
          v = Math.min(v, brakingSpeed(gap - 40));
        }
        d += hi - lo;
      }
      dist += 10;
      cur = res.cursor;
      if (res.hitEnd) { v = Math.min(v, brakingSpeed(dist - 6)); break; }
    }
    return v;
  }

  private updateAspects(): void {
    const occ = this.trains.map((t) => ({ t, o: t.occupancy() }));
    for (const sig of this.rail.signals()) {
      let state: 'red' | 'yellow' | 'green' = 'green';
      let cur: Cursor = { roadId: sig.def.roadId, s: sig.def.s, dir: sig.def.dir };
      let dist = 0;
      scan: for (let guard = 0; dist < SIGNAL_YELLOW_M && guard < 100; guard++) {
        const res = this.network.advance(cur, 10);
        let d = dist;
        for (const sg of res.segs) {
          const dir: 1 | -1 = sg.to >= sg.from ? 1 : -1;
          const lo = Math.min(sg.from, sg.to), hi = Math.max(sg.from, sg.to);
          const rt = this.network.road(sg.roadId);
          const single = rt ? this.network.isSingleTrack(rt) : true;
          for (const { o } of occ) for (const x of o) {
            if (x.roadId !== sg.roadId || (!single && x.dir !== dir) || x.hi < lo || x.lo > hi) continue;
            const gap = d + Math.max(0, dir === 1 ? x.lo - sg.from : sg.from - x.hi);
            state = gap < SIGNAL_RED_M ? 'red' : 'yellow';
            if (state === 'red') break scan;
          }
          d += hi - lo;
        }
        dist += 10;
        cur = res.cursor;
        if (res.hitEnd) break;
      }
      this.rail.setSignalAspect(sig.def.id, state);
    }
  }

  update(dtIn: number): void {
    const dt = Math.min(0.1, Math.max(0, dtIn));
    for (const t of [...this.trains]) {
      if (!this.network.road(t.front.roadId)) { this.remove(t.id); continue; }
      if (t.wait > 0) {
        t.wait -= dt;
        t.speed = 0;
        if (t.wait <= 0 && t.turning) { t.reverse(); t.turning = false; }
      } else {
        const target = this.targetSpeed(t);
        t.speed += Math.max(-DECEL * dt * 1.5, Math.min(ACCEL * dt, target - t.speed));
        if (t.speed < 0.02) t.speed = 0;
        const res = this.network.advance(t.front, t.speed * dt);
        t.extend(res.segs);
        t.front = res.cursor;
        if (res.hitEnd) { t.speed = 0; t.wait = END_DWELL_S; t.turning = true; }
        // a station stop: the middle of the train is at the middle of the platform and it is (nearly) standing: stand still for a while
        if (!t.turning) {
          for (const st of this.network.stations()) {
            const key = `${st.roadId}:${t.front.dir}`;
            if (t.front.roadId !== st.roadId || t.served.has(key)) continue;
            const stop = st.s + t.front.dir * t.length / 2;
            if (Math.abs(t.front.s - stop) < 1.5 && t.speed < 1.5) { t.served.add(key); t.speed = 0; t.wait = STATION_DWELL_S; }
          }
        }
      }
      this.place(t);
    }
    this.signalClock += dt;
    if (this.signalClock > 0.4) { this.signalClock = 0; this.updateAspects(); }
  }

  // ---- drawing --------------------------------------------------------------------------------------------------

  private place(t: Train): void {
    let x0 = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
    for (const car of t.cars) {
      const fa = t.locate(x0 + 3.3), fb = t.locate(x0 + car.len - 3.3);
      const pa = this.network.pose(fa.roadId, fa.s, fa.dir, this.pose);
      if (!pa) { car.group.visible = false; x0 += car.len + CAR_GAP; continue; }
      a.copy(pa.pos);
      const pb = this.network.pose(fb.roadId, fb.s, fb.dir, this.pose);
      if (!pb) { car.group.visible = false; x0 += car.len + CAR_GAP; continue; }
      b.copy(pb.pos);
      car.group.visible = true;
      z.subVectors(a, b);
      if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
      z.normalize();
      x.crossVectors(new THREE.Vector3(0, 1, 0), z).normalize();
      y.crossVectors(z, x).normalize();
      car.group.matrix.makeBasis(x, y, z).setPosition(a.clone().add(b).multiplyScalar(0.5));
      car.group.matrixAutoUpdate = false;
      car.group.matrixWorldNeedsUpdate = true;
      x0 += car.len + CAR_GAP;
    }
  }

  dispose(): void {
    for (const t of this.trains) for (const c of t.cars) this.group.remove(c.group);
    this.trains.length = 0;
    this.group.clear();
  }
}
