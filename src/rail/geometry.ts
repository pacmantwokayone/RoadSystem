// Geometry of a railway, per road chunk: sleepers, rails, track switches (blades, frog, check rails, long sleepers, lantern), overhead
// line (masts with cantilevers, messenger wire, contact wire, droppers) and light signals. The ballast bed itself is ordinary road surface
// (see the `gleis` profiles); this adds what stands on it. Everything is positioned from the same ring sections as the road body
// (ChunkSampler), so it follows slopes, banking, bridges and tunnels, and every chunk draws from absolute arc lengths so nothing doubles
// or drops at a chunk border.

import * as THREE from 'three';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { ChunkSampler, type SurfacePoint } from '../props/sampler';
import { GeometryBatch } from '../props/batch';
import { hash01 } from '../props/rules';
import { beam, box } from '../structures/primitives';
import { tunnelDims } from '../tunnel/sections';
import { branchProfileAt } from '../network/branch';
import type { RailSpec } from '../profile/types';
import type { AttachDef } from '../network/types';

export const SLEEPER = { len: 2.6, h: 0.2, w: 0.26, y: 0.07 } as const;
/** rail: foot half width, head half width, height; the foot rests on the sleepers' top */
export const RAIL = { foot: 0.075, head: 0.045, h: 0.17, base: 0.17 } as const;
export const RAIL_HEAD_Y = RAIL.base + RAIL.h;
const MAST_SIDE_INSET = 0.3;
const MAX_STATION_GAP = 3;
/** length of the switch blades (Zungen), metres, and how far the open blade stands off its stock rail */
export const BLADE_LEN_M = 8;
export const BLADE_OPEN_M = 0.11;

export type SwitchState = 'straight' | 'diverging';

export interface RailContext {
  /** position of the track switch with this id (see SwitchInfo.id) */
  switchState(id: string): SwitchState;
}

const DEFAULT_CTX: RailContext = { switchState: () => 'straight' };

/** a light signal to be drawn by the layer (its lamps change colour at run time, so they are not part of the merged mesh) */
export interface SignalDef {
  id: string;
  roadId: string;
  /** arc length on the road, and the direction of travel it governs along the road's increasing arc length (+1) or against it (-1) */
  s: number;
  dir: 1 | -1;
  /** world position of the head's centre, and the head's frame: side = across the head, up, front = towards the approaching train */
  pos: THREE.Vector3;
  side: THREE.Vector3;
  up: THREE.Vector3;
  front: THREE.Vector3;
  /** the aspect shown when nothing else decides (deterministic) */
  aspect: 'red' | 'yellow' | 'green';
}

export interface RailBuild {
  batch: GeometryBatch;
  sleepers: number;
  masts: number;
  signals: number;
  signalDefs: SignalDef[];
  /** switches drawn in this chunk (parent or child side) */
  switches: number;
}

/** a sampler whose lateral positions are plain metres from the centre line: a track keeps its gauge where the road's width is scaled (a branch growing out of a road) */
class TrackSampler extends ChunkSampler {
  override point(s: number, xp: number, y?: number): SurfacePoint {
    return super.point(s, xp, y, false);
  }
}

const sleeperGeometry = new THREE.BoxGeometry(SLEEPER.len, SLEEPER.h, SLEEPER.w);

/** orthonormal right-handed frame (x = right, y = up, z = backwards) of a surface point */
function frameOf(p: SurfacePoint): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
  const y = p.up.clone().normalize();
  const x = new THREE.Vector3().copy(p.right).addScaledVector(y, -p.right.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return { x, y: new THREE.Vector3().crossVectors(z, x).normalize(), z };
}

/** the signal aspect of signal number k: mostly clear, sometimes caution or stop (static, deterministic) */
export function signalAspect(seed: number, k: number): 'red' | 'yellow' | 'green' {
  const r = hash01(seed, 977, k);
  return r < 0.3 ? 'red' : r < 0.48 ? 'yellow' : 'green';
}

/** Contact-wire stagger: zig-zag by ±0.2 m between consecutive masts so the pantograph wears evenly. */
export function stagger(s: number, spacing: number, sFirst: number): number {
  const q = (s - sFirst) / spacing;
  const k = Math.floor(q);
  const u = q - k;
  const a = (k % 2 === 0 ? 1 : -1) * 0.2;
  return a * (1 - u) + -a * u;
}

// ---- track switches ---------------------------------------------------------------------------------------------------------------

/**
 * A track switch as one road sees it. Seen from the PARENT (the track the branch leaves) the branch track lies `offset(d)` away from the
 * parent's axis at distance d from the nose (the toe of the switch); seen from the CHILD, the parent lies on its `inner` side. Both
 * roads know the same zone, so the long sleepers, the blades, the frog and the check rails fit together exactly.
 */
interface SwitchZone {
  id: string;
  role: 'parent' | 'child';
  attach: AttachDef;
  state: SwitchState;
  /** arc length on THIS road of the point at distance d from the nose */
  sOf(d: number): number;
  /** distance from the nose of arc length s on this road (may be outside [0, len]) */
  dOf(s: number): number;
  len: number;
  /** lateral position of this road's own track in the zone (parent: the track the branch leaves; child: its single track) */
  trackX: number;
  /** parent: the side the branch leaves on (+1 right); child: the side of the parent seen from the child (+1 right) */
  toward: 1 | -1;
}

const switchOffset = (a: AttachDef, d: number): number => branchProfileAt(a, d).offset - a.halfMain;

function switchZones(rt: RoadRuntime, spec: RailSpec, ctx: RailContext): SwitchZone[] {
  const out: SwitchZone[] = [];
  const len = (a: AttachDef): number => a.len ?? 0;
  // as a parent
  for (const w of rt.switches) {
    const a = w.attach;
    if (a.s === undefined) continue;
    const want = a.side * a.halfMain;
    const trackX = spec.tracks.reduce((best, x) => (Math.abs(x - want) < Math.abs(best - want) ? x : best), spec.tracks[0]);
    if (Math.abs(trackX - want) > 0.3) continue; // the branch does not leave one of this road's tracks
    const nose = a.s, dir = a.dir;
    out.push({ id: w.id, role: 'parent', attach: a, state: ctx.switchState(w.id), sOf: (d) => nose + dir * d, dOf: (s) => dir * (s - nose), len: len(a), trackX, toward: a.side });
  }
  // as a child
  const L = rt.sampled.curve.length;
  for (const which of ['attach', 'attachEnd'] as const) {
    const a = rt.def[which];
    if (!a || a.kind !== 'switch' || a.s === undefined) continue;
    const merge = which === 'attachEnd';
    const travelsPlus = (a.dir === 1) !== merge;
    const id = `${rt.def.id}:${which}`;
    out.push({
      id, role: 'child', attach: a, state: ctx.switchState(id),
      sOf: (d) => (merge ? L - d : d), dOf: (s) => (merge ? L - s : s), len: len(a), trackX: spec.tracks[0],
      toward: (travelsPlus ? -a.side : a.side) as 1 | -1,
    });
  }
  return out;
}

const inZone = (z: SwitchZone, s: number): boolean => { const d = z.dOf(s); return d >= -1e-6 && d <= z.len + 1e-6; };

export function buildChunkRail(rt: RoadRuntime, chunk: RoadChunk, ctx: RailContext = DEFAULT_CTX): RailBuild | null {
  const spec = rt.profile.rail;
  if (!spec || chunk.state !== 'ready') return null;
  const sampler = new TrackSampler(rt, chunk);
  const build: RailBuild = { batch: new GeometryBatch(), sleepers: 0, masts: 0, signals: 0, signalDefs: [], switches: 0 };
  const isLast = chunk.index === rt.chunks.length - 1;
  const { sMin, sMax } = sampler;
  const sFirst = rt.samples[0].s, sLast = rt.samples[rt.samples.length - 1].s;
  const owns = (s: number): boolean => s >= sMin && (s < sMax || (isLast && s <= sMax + 1e-9));
  const trimStart = rt.trim.start > 0, trimEnd = rt.trim.end > 0;
  const zones = switchZones(rt, spec, ctx);

  const stations = (a: number, b: number, maxGap: number): number[] => {
    const set = new Set<number>([a, b]);
    for (let r = 0; r < sampler.sections.length; r++) {
      const s = rt.samples[sampler.sampleIndex(r)].s;
      if (s > a + 1e-6 && s < b - 1e-6) set.add(s);
    }
    const base = [...set].sort((x, y) => x - y);
    const out: number[] = [base[0]];
    for (let i = 1; i < base.length; i++) {
      const gap = base[i] - base[i - 1];
      const n = Math.max(1, Math.ceil(gap / maxGap - 1e-9));
      for (let k = 1; k <= n; k++) out.push(base[i - 1] + (gap * k) / n);
    }
    return out;
  };

  sleepers(rt, sampler, spec, build, owns, sFirst, sLast, zones);
  rails(rt, sampler, spec, build, stations, zones);
  for (const z of zones) switchParts(rt, sampler, spec, build, z, stations, owns);
  if (spec.catenary) catenary(rt, sampler, spec, spec.catenary, build, owns, stations, sFirst, zones);
  if (spec.signals) signals(rt, sampler, spec, spec.signals, build, owns, sFirst, sLast, trimStart, trimEnd, zones);
  build.switches = zones.length;
  return build;
}

function sleepers(
  rt: RoadRuntime, sampler: ChunkSampler, spec: RailSpec, build: RailBuild,
  owns: (s: number) => boolean, sFirst: number, sLast: number, zones: SwitchZone[],
): void {
  const { sMin, sMax } = sampler;
  const m = new THREE.Matrix4(), sc = new THREE.Matrix4();
  for (const xt of spec.tracks) {
    const k0 = Math.ceil((sMin - sFirst) / spec.sleeperSpacing - 1e-9);
    for (let k = k0; ; k++) {
      const s = sFirst + k * spec.sleeperSpacing;
      if (s > sMax + 1e-9) break;
      if (!owns(s) || s < sFirst + 0.2 || s > sLast - 0.2) continue;
      // inside a switch zone the child's track shares the parent's sleepers: they are longer, reaching under both tracks
      let xc = xt, len: number = SLEEPER.len;
      let skip = false;
      for (const z of zones) {
        if (!inZone(z, s)) continue;
        if (z.role === 'child') { skip = true; break; }
        if (Math.abs(z.trackX - xt) > 0.05) continue;
        const delta = z.toward * switchOffset(z.attach, Math.max(0, z.dOf(s)));
        const lo = Math.min(xt, xt + delta) - SLEEPER.len / 2, hi = Math.max(xt, xt + delta) + SLEEPER.len / 2;
        xc = (lo + hi) / 2; len = hi - lo;
      }
      if (skip) continue;
      const p = sampler.point(s, xc, SLEEPER.y);
      const f = frameOf(p);
      m.makeBasis(f.x, f.y, f.z).setPosition(p.pos);
      if (len !== SLEEPER.len) m.multiply(sc.makeScale(len / SLEEPER.len, 1, 1));
      build.batch.addGeometry('sleeper', sleeperGeometry, m);
      build.sleepers++;
    }
  }
}

/** one rail as a lofted prism over [sa, sb]; `x` gives its lateral centre, `widthScale` thins the head (the tip of a blade) */
function railRun(
  sampler: ChunkSampler, build: RailBuild, stations: (a: number, b: number, g: number) => number[], sa: number, sb: number,
  x: (s: number) => number, widthScale: (s: number) => number = () => 1, material = 'rail_steel',
): void {
  const a = Math.max(sa, sampler.sMin), b = Math.min(sb, sampler.sMax);
  if (b - a < 1e-3) return;
  const st = stations(a, b, MAX_STATION_GAP);
  const rings = st.map((s) => {
    const p = sampler.point(s, x(s), RAIL.base);
    const f = frameOf(p);
    const w = widthScale(s);
    const at = (dx: number, dy: number): THREE.Vector3 => p.pos.clone().addScaledVector(f.x, dx).addScaledVector(f.y, dy);
    return [at(-RAIL.foot * w, 0), at(RAIL.foot * w, 0), at(RAIL.head * w, RAIL.h), at(-RAIL.head * w, RAIL.h)];
  });
  loftPrism(build.batch.addRaw(material), rings);
}

function rails(
  rt: RoadRuntime, sampler: ChunkSampler, spec: RailSpec, build: RailBuild,
  stations: (a: number, b: number, g: number) => number[], zones: SwitchZone[],
): void {
  const { sMin, sMax } = sampler;
  const g2 = spec.gauge / 2;
  for (const xt of spec.tracks) {
    for (const side of [-1, 1] as const) {
      const xr = xt + side * g2;
      // pieces of this rail that a switch replaces (the blade): the rail on the side the branch lies on (parent) / faces the parent (child)
      const cuts: Array<{ sa: number; sb: number }> = [];
      for (const z of zones) {
        const mine = z.role === 'parent' ? Math.abs(z.trackX - xt) < 0.05 : true;
        if (!mine || z.toward !== side) continue;
        const a = z.sOf(0), b = z.sOf(BLADE_LEN_M);
        cuts.push({ sa: Math.min(a, b), sb: Math.max(a, b) });
      }
      cuts.sort((p, q) => p.sa - q.sa);
      let from = sMin;
      for (const c of cuts) {
        if (c.sa > from) railRun(sampler, build, stations, from, Math.min(c.sa, sMax), () => xr);
        from = Math.max(from, c.sb);
      }
      if (from < sMax) railRun(sampler, build, stations, from, sMax, () => xr);
    }
  }
}

function loftPrism(raw: ReturnType<GeometryBatch['addRaw']>, rings: THREE.Vector3[][]): void {
  // flat shaded quads between consecutive rings (no caps: neighbouring chunks continue the rail)
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1];
    const cA = A.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / A.length);
    for (let j = 0; j < A.length; j++) {
      const j1 = (j + 1) % A.length;
      const n = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(A[j1], A[j]), new THREE.Vector3().subVectors(B[j], A[j]));
      if (n.lengthSq() < 1e-14) continue;
      n.normalize();
      const out = new THREE.Vector3().addVectors(A[j], A[j1]).multiplyScalar(0.5).sub(cA);
      const flip = n.dot(out) < 0;
      if (flip) n.negate();
      const i0 = raw.vertex(A[j], n, 0, 0), i1 = raw.vertex(A[j1], n, 0.1, 0), i2 = raw.vertex(B[j], n, 0, 1), i3 = raw.vertex(B[j1], n, 0.1, 1);
      if (!flip) { raw.tri(i0, i1, i2); raw.tri(i1, i3, i2); } else { raw.tri(i0, i2, i1); raw.tri(i1, i2, i3); }
    }
  }
}

/** Blades, frog, check rails, switch rods and the lantern of one switch zone (the parts that are not plain rails). */
function switchParts(
  rt: RoadRuntime, sampler: ChunkSampler, spec: RailSpec, build: RailBuild, z: SwitchZone,
  stations: (a: number, b: number, g: number) => number[], owns: (s: number) => boolean,
): void {
  const g2 = spec.gauge / 2;
  const a = z.attach;
  const open = (t: number): number => BLADE_OPEN_M * (1 - t);
  // The blade of the rail toward the other track. Which blade is open depends on the position: the straight blade (parent) when the
  // switch is set diverging, the curved blade (child) when it is set straight.
  const parentOpen = z.state === 'diverging', childOpen = z.state === 'straight';
  const isOpen = z.role === 'parent' ? parentOpen : childOpen;
  const bladeX = (s: number): number => {
    const d = Math.min(BLADE_LEN_M, Math.max(0, z.dOf(s)));
    const t = d / BLADE_LEN_M;
    // the straight blade (parent) opens towards the parent's axis, the curved blade (child) away from the parent
    const shift = isOpen ? open(t) * (z.role === 'parent' ? -z.toward : -z.toward) : 0;
    return z.trackX + z.toward * g2 + shift;
  };
  const bladeScale = (s: number): number => 0.3 + 0.7 * Math.min(1, Math.max(0, z.dOf(s) / BLADE_LEN_M));
  const sa = Math.min(z.sOf(0), z.sOf(BLADE_LEN_M)), sb = Math.max(z.sOf(0), z.sOf(BLADE_LEN_M));
  railRun(sampler, build, stations, sa, sb, bladeX, bladeScale);

  // frog: where the child's inner rail crosses the parent's rail towards the branch (the track centres are one gauge apart there)
  const gap = a.gap ?? 2;
  const gauge = spec.gauge;
  if (gap > gauge + 0.05) {
    const taper = a.taper ?? 70, start = a.taperStart ?? (a.grow ?? 50) + (a.parallel ?? 0);
    const df = start + Math.sqrt(gauge / gap) * taper;
    const sf = z.sOf(df);
    if (owns(sf) && z.role === 'parent') {
      const p = sampler.point(sf, z.trackX + z.toward * g2, RAIL.base + 0.06);
      const f = frameOf(p);
      const slope = (2 * gap * Math.sqrt(gauge / gap)) / taper; // dΔ/dd at the frog: the angle between the tracks
      const ang = Math.atan(slope) / 2 * z.toward;
      const axisR = f.x.clone().multiplyScalar(Math.cos(ang)).addScaledVector(f.z, -Math.sin(ang)).normalize();
      const axisZ = new THREE.Vector3().crossVectors(axisR, f.y).normalize();
      box(build.batch.addRaw('rail_steel'), p.pos, axisR, f.y, axisZ, 0.17, 0.1, 1.15);
      // wing rails: short rails beside the frog's nose on both routes
      for (const sg of [-1, 1]) {
        const wp = p.pos.clone().addScaledVector(f.x, sg * 0.3);
        box(build.batch.addRaw('rail_steel'), wp, f.x, f.y, f.z, 0.045, 0.085, 1.6);
      }
    }
    // check rails (Radlenker) opposite the frog, one on each route: a short rail just inside the opposite running rail
    const lateral = z.trackX - z.toward * (g2 - 0.14);
    railRun(sampler, build, stations, sf - 1.8, sf + 1.8, () => lateral);
  }

  // switch rods across the blades and the lantern at the toe (parent only: one per switch)
  if (z.role === 'parent') {
    for (const d of [1.6, 4.8]) {
      const s = z.sOf(d);
      if (!owns(s)) continue;
      const p = sampler.point(s, z.trackX, SLEEPER.y + SLEEPER.h / 2 + 0.01);
      const f = frameOf(p);
      box(build.batch.addRaw('steel_dark'), p.pos, f.x, f.y, f.z, g2 + 0.05, 0.02, 0.03);
    }
    const s0 = z.sOf(-2);
    if (owns(s0)) {
      const p = sampler.point(s0, z.trackX + z.toward * (g2 + 1.3));
      const f = frameOf(p);
      const lamp = z.state === 'straight' ? 'rail_lamp_green' : 'rail_lamp_yellow';
      box(build.batch.addRaw('steel_dark'), p.pos.clone().addScaledVector(f.y, 0.45), f.x, f.y, f.z, 0.03, 0.45, 0.03);
      box(build.batch.addRaw('plastic_black'), p.pos.clone().addScaledVector(f.y, 0.95), f.x, f.y, f.z, 0.15, 0.15, 0.04);
      box(build.batch.addRaw(lamp), p.pos.clone().addScaledVector(f.y, 0.95).addScaledVector(f.z, 0.05).addScaledVector(f.x, 0), f.x, f.y, f.z, 0.1, 0.1, 0.012);
    }
  }
}

// ---- overhead line --------------------------------------------------------------------------------------------------------------

function catenary(
  rt: RoadRuntime, sampler: ChunkSampler, spec: RailSpec, cat: { height: number; spacing: number }, build: RailBuild,
  owns: (s: number) => boolean, stations: (a: number, b: number, g: number) => number[], sFirst: number, zones: SwitchZone[],
): void {
  const { sMin, sMax } = sampler;
  const wireY = RAIL_HEAD_Y + cat.height;
  const messY = (s: number): number => {
    const u = (((s - sFirst) / cat.spacing) % 1 + 1) % 1;
    return wireY + 0.25 + 1.0 * (1 - 4 * u * (1 - u)); // 1.25 m above the contact wire at a mast, 0.25 m at mid-span
  };
  const core = rt.profile.coreHalfWidth;
  const xs = spec.tracks.slice().sort((a, b) => a - b);
  // masts stand beside the outermost tracks; a branch with its own track puts them on the side away from the track it leaves
  const childZone = zones.find((z) => z.role === 'child');
  const mastSides: Array<{ sg: -1 | 1; xt: number }> = childZone
    ? [{ sg: (-childZone.toward) as -1 | 1, xt: xs[0] }]
    : xs.length === 1 ? [{ sg: 1, xt: xs[0] }] : [{ sg: -1, xt: xs[0] }, { sg: 1, xt: xs[xs.length - 1] }];
  const dims = tunnelDims(rt);
  const isTunnel = (mode: string): boolean => mode === 'tunnel' || mode === 'gallery';
  const wireRaw = build.batch.addRaw('rail_wire');
  const steelRaw = build.batch.addRaw('rail_mast');
  const UP = new THREE.Vector3(0, 1, 0);

  // masts and cantilevers
  const k0 = Math.ceil((sMin - sFirst) / cat.spacing - 1e-9);
  for (let k = k0; ; k++) {
    const s = sFirst + k * cat.spacing;
    if (s > sMax + 1e-9) break;
    if (!owns(s) || k === 0) continue;
    if (childZone && inZone(childZone, s)) continue; // the parent's masts serve both tracks there
    for (const { sg, xt } of mastSides) {
      const base = sampler.point(s, sg * (core - MAST_SIDE_INSET));
      if (isTunnel(base.mode) || (base.mode !== 'road' && base.mode !== 'bridge')) continue;
      const f = frameOf(base);
      const top = wireY + 1.55;
      const baseY = (base.pos.clone().sub(sampler.point(s, 0, 0).pos).dot(f.y));
      const h = top - baseY + 0.15;
      box(steelRaw, base.pos.clone().addScaledVector(f.y, h / 2 - 0.15), f.x, f.y, f.z, 0.13, h / 2, 0.13);
      box(steelRaw, base.pos.clone().addScaledVector(f.y, 0.1), f.x, f.y, f.z, 0.28, 0.12, 0.28); // foot plate
      const arm = (y: number, x: number): THREE.Vector3 => sampler.point(s, x, y).pos;
      const xm = sg * (core - MAST_SIDE_INSET);
      beam(steelRaw, arm(wireY + 1.45, xm), arm(wireY + 1.45, xt), 0.09, 0.09, UP);
      beam(steelRaw, arm(wireY + 0.35, xm), arm(wireY + 1.4, xt + sg * 1.6), 0.07, 0.07, UP); // brace
      beam(wireRaw, arm(wireY + 1.4, xt), arm(wireY + 0.04, xt), 0.03, 0.03, UP); // support of the contact wire (hanger)
      build.masts++;
    }
    // a middle track of three or more has no mast beside it: it hangs from a cross-span (portal) beam between two masts
    if (xs.length > 2 && !childZone) {
      for (const xt of xs.slice(1, -1)) {
        const a = sampler.point(s, xs[0] - 0.8, wireY + 1.45).pos, b = sampler.point(s, xs[xs.length - 1] + 0.8, wireY + 1.45).pos;
        beam(steelRaw, a, b, 0.08, 0.14, UP);
        beam(wireRaw, sampler.point(s, xt, wireY + 1.4).pos, sampler.point(s, xt, wireY + 0.04).pos, 0.03, 0.03, UP);
      }
    }
  }

  // wires, per track
  const step = cat.spacing / 8;
  const st = new Set<number>(stations(sMin, sMax, step));
  const q0 = Math.ceil((sMin - sFirst) / step - 1e-9);
  for (let q = q0; sFirst + q * step < sMax - 1e-6; q++) st.add(sFirst + q * step);
  const list = [...st].sort((a, b) => a - b);
  for (const xt of spec.tracks) {
    let prevC: THREE.Vector3 | null = null, prevM: THREE.Vector3 | null = null, prevTunnel = false;
    for (const s of list) {
      const pc = sampler.point(s, xt + stagger(s, cat.spacing, sFirst), wireY);
      const tun = isTunnel(pc.mode);
      const c = pc.pos;
      const mm = tun ? null : sampler.point(s, xt, messY(s)).pos;
      if (prevC) {
        beam(wireRaw, prevC, c, 0.026, 0.026, UP);
        if (prevM && mm && !tun && !prevTunnel) beam(wireRaw, prevM, mm, 0.02, 0.02, UP);
      }
      // droppers every few metres in the open; hangers to the crown inside a tunnel
      if (prevC && (Math.round((s - sFirst) / step) % 2 === 0)) {
        if (mm && !tun && messY(s) - wireY > 0.18) beam(wireRaw, c, mm, 0.012, 0.012, UP);
        else if (tun) {
          const xr = Math.min(Math.abs(xt) / dims.halfW, 0.97);
          const crown = dims.wall + dims.rise * Math.sqrt(1 - xr * xr) - 0.05;
          if (crown - wireY > 0.15) beam(wireRaw, c, sampler.point(s, xt, crown).pos, 0.03, 0.03, UP);
        }
      }
      prevC = c; prevM = mm; prevTunnel = tun;
    }
  }
}

// ---- signals ----------------------------------------------------------------------------------------------------------------------

function signals(
  rt: RoadRuntime, sampler: ChunkSampler, spec: RailSpec, sig: { spacing: number; start: number }, build: RailBuild,
  owns: (s: number) => boolean, sFirst: number, sLast: number, trimStart: boolean, trimEnd: boolean, zones: SwitchZone[],
): void {
  const { sMin, sMax } = sampler;
  const core = rt.profile.coreHalfWidth;
  const xs = spec.tracks.slice().sort((a, b) => a - b);
  const childZone = zones.find((z) => z.role === 'child');
  const sides: Array<{ sg: -1 | 1; dir: 1 | -1 }> = childZone
    ? [{ sg: (-childZone.toward) as -1 | 1, dir: 1 }]
    : xs.length === 1 ? [{ sg: 1, dir: 1 }] : [{ sg: 1, dir: 1 }, { sg: -1, dir: -1 }];
  const mastS = spec.catenary?.spacing ?? 0;
  const k0 = Math.max(0, Math.ceil((sMin - sFirst - sig.start) / sig.spacing - 1e-9));
  for (let k = k0; ; k++) {
    let s = sFirst + sig.start + k * sig.spacing;
    if (s > sMax + 1e-9) break;
    // keep clear of the overhead-line masts
    if (mastS > 0) { const d = (((s - sFirst) % mastS) + mastS) % mastS; if (Math.min(d, mastS - d) < 4) s += 7; }
    if (!owns(s)) continue;
    if ((trimStart && s < sFirst + 20) || (trimEnd && s > sLast - 20)) continue;
    if (zones.some((z) => inZone(z, s) || inZone(z, s + 25) || inZone(z, s - 25))) continue;
    for (const { sg, dir } of sides) {
      const p = sampler.point(s, sg * (core - 0.55));
      if (p.mode !== 'road' && p.mode !== 'bridge') continue;
      const f = frameOf(p);
      const front = f.z.clone().multiplyScalar(dir); // z points backwards: dir 1 → the head faces back along the road, towards the approaching train
      const side = new THREE.Vector3().crossVectors(f.y, front).normalize();
      const at = (up: number, fwd = 0): THREE.Vector3 => p.pos.clone().addScaledVector(f.y, up).addScaledVector(front, fwd);
      const steel = build.batch.addRaw('steel_dark'), black = build.batch.addRaw('plastic_black');
      box(steel, at(1.9), side, f.y, front, 0.06, 2.0, 0.06);
      box(black, at(3.9, 0.05), side, f.y, front, 0.21, 0.58, 0.14);
      for (const y of [4.25, 3.9, 3.55]) box(build.batch.addRaw('rail_lamp_off'), at(y, 0.2), side, f.y, front, 0.075, 0.075, 0.012); // dark lamp housings
      const id = `${rt.def.id}:${k}:${sg > 0 ? 'r' : 'l'}`;
      build.signalDefs.push({
        id, roadId: rt.def.id, s, dir, pos: at(0), side, up: f.y.clone(), front, aspect: signalAspect(rt.seed, k * 2 + (sg > 0 ? 0 : 1)),
      });
      build.signals++;
    }
  }
}
