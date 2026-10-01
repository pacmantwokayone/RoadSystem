// Geometry of a railway, per road chunk: sleepers, rails, overhead line (masts with cantilevers, messenger wire, contact wire, droppers)
// and light signals. The ballast bed itself is ordinary road surface (see the `gleis` profiles); this adds what stands on it. Everything
// is positioned from the same ring sections as the road body (ChunkSampler), so it follows slopes, banking, bridges and tunnels, and every
// chunk draws from absolute arc lengths so nothing doubles or drops at a chunk border.

import * as THREE from 'three';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { ChunkSampler, type SurfacePoint } from '../props/sampler';
import { GeometryBatch } from '../props/batch';
import { hash01 } from '../props/rules';
import { beam, box } from '../structures/primitives';
import { tunnelDims } from '../tunnel/sections';
import type { RailSpec } from '../profile/types';

export const SLEEPER = { len: 2.6, h: 0.2, w: 0.26, y: 0.07 } as const;
/** rail: foot half width, head half width, height; the foot rests on the sleepers' top */
export const RAIL = { foot: 0.075, head: 0.045, h: 0.17, base: 0.17 } as const;
export const RAIL_HEAD_Y = RAIL.base + RAIL.h;
const MAST_SIDE_INSET = 0.3;
const MAX_STATION_GAP = 3;

export interface RailBuild {
  batch: GeometryBatch;
  sleepers: number;
  masts: number;
  signals: number;
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

export function buildChunkRail(rt: RoadRuntime, chunk: RoadChunk): RailBuild | null {
  const spec = rt.profile.rail;
  if (!spec || chunk.state !== 'ready') return null;
  const sampler = new ChunkSampler(rt, chunk);
  const build: RailBuild = { batch: new GeometryBatch(), sleepers: 0, masts: 0, signals: 0 };
  const isLast = chunk.index === rt.chunks.length - 1;
  const { sMin, sMax } = sampler;
  const sFirst = rt.samples[0].s, sLast = rt.samples[rt.samples.length - 1].s;
  const owns = (s: number): boolean => s >= sMin && (s < sMax || (isLast && s <= sMax + 1e-9));
  const trimStart = rt.trim.start > 0, trimEnd = rt.trim.end > 0;

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

  sleepersAndRails(rt, sampler, spec, build, owns, stations, sFirst, sLast);
  if (spec.catenary) catenary(rt, sampler, spec, spec.catenary, build, owns, stations, sFirst);
  if (spec.signals) signals(rt, sampler, spec, spec.signals, build, owns, sFirst, sLast, trimStart, trimEnd);
  return build;
}

function sleepersAndRails(
  rt: RoadRuntime, sampler: ChunkSampler, spec: RailSpec, build: RailBuild,
  owns: (s: number) => boolean, stations: (a: number, b: number, g: number) => number[], sFirst: number, sLast: number,
): void {
  const { sMin, sMax } = sampler;
  const m = new THREE.Matrix4();
  for (const xt of spec.tracks) {
    const k0 = Math.ceil((sMin - sFirst) / spec.sleeperSpacing - 1e-9);
    for (let k = k0; ; k++) {
      const s = sFirst + k * spec.sleeperSpacing;
      if (s > sMax + 1e-9) break;
      if (!owns(s) || s < sFirst + 0.2 || s > sLast - 0.2) continue;
      const p = sampler.point(s, xt, SLEEPER.y);
      const f = frameOf(p);
      m.makeBasis(f.x, f.y, f.z).setPosition(p.pos);
      build.batch.addGeometry('sleeper', sleeperGeometry, m);
      build.sleepers++;
    }
    // rails: one lofted prism per side, continuous across chunk borders (both chunks have the border station)
    const st = stations(sMin, sMax, MAX_STATION_GAP);
    for (const side of [-1, 1]) {
      const rings = st.map((s) => {
        const p = sampler.point(s, xt + (side * spec.gauge) / 2, RAIL.base);
        const f = frameOf(p);
        const at = (dx: number, dy: number): THREE.Vector3 => p.pos.clone().addScaledVector(f.x, dx).addScaledVector(f.y, dy);
        return [at(-RAIL.foot, 0), at(RAIL.foot, 0), at(RAIL.head, RAIL.h), at(-RAIL.head, RAIL.h)];
      });
      loftPrism(build.batch.addRaw('rail_steel'), rings);
    }
  }
}

function loftPrism(raw: ReturnType<GeometryBatch['addRaw']>, rings: THREE.Vector3[][]): void {
  // same as primitives.loft without caps, kept local so the rail needs no normals pass: flat shaded quads
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

/** Contact-wire stagger: zig-zag by ±0.2 m between consecutive masts so the pantograph wears evenly. */
export function stagger(s: number, spacing: number, sFirst: number): number {
  const q = (s - sFirst) / spacing;
  const k = Math.floor(q);
  const u = q - k;
  const a = (k % 2 === 0 ? 1 : -1) * 0.2;
  return a * (1 - u) + -a * u;
}

function catenary(
  rt: RoadRuntime, sampler: ChunkSampler, spec: RailSpec, cat: { height: number; spacing: number }, build: RailBuild,
  owns: (s: number) => boolean, stations: (a: number, b: number, g: number) => number[], sFirst: number,
): void {
  const { sMin, sMax } = sampler;
  const wireY = RAIL_HEAD_Y + cat.height;
  const messY = (s: number): number => {
    const u = (((s - sFirst) / cat.spacing) % 1 + 1) % 1;
    return wireY + 0.25 + 1.0 * (1 - 4 * u * (1 - u)); // 1.25 m above the contact wire at a mast, 0.25 m at mid-span
  };
  const core = rt.profile.coreHalfWidth;
  const xs = spec.tracks.slice().sort((a, b) => a - b);
  const mastSides: Array<{ sg: -1 | 1; xt: number }> = xs.length === 1 ? [{ sg: 1, xt: xs[0] }] : [{ sg: -1, xt: xs[0] }, { sg: 1, xt: xs[xs.length - 1] }];
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

function signals(
  rt: RoadRuntime, sampler: ChunkSampler, spec: RailSpec, sig: { spacing: number; start: number }, build: RailBuild,
  owns: (s: number) => boolean, sFirst: number, sLast: number, trimStart: boolean, trimEnd: boolean,
): void {
  const { sMin, sMax } = sampler;
  const core = rt.profile.coreHalfWidth;
  const xs = spec.tracks.slice().sort((a, b) => a - b);
  const sides: Array<{ sg: -1 | 1; dir: 1 | -1 }> = xs.length === 1 ? [{ sg: 1, dir: 1 }] : [{ sg: 1, dir: 1 }, { sg: -1, dir: -1 }];
  const mastS = spec.catenary?.spacing ?? 0;
  const k0 = Math.max(0, Math.ceil((sMin - sFirst - sig.start) / sig.spacing - 1e-9));
  for (let k = k0; ; k++) {
    let s = sFirst + sig.start + k * sig.spacing;
    if (s > sMax + 1e-9) break;
    // keep clear of the overhead-line masts
    if (mastS > 0) { const d = (((s - sFirst) % mastS) + mastS) % mastS; if (Math.min(d, mastS - d) < 4) s += 7; }
    if (!owns(s)) continue;
    if ((trimStart && s < sFirst + 20) || (trimEnd && s > sLast - 20)) continue;
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
      const aspect = signalAspect(rt.seed, k * 2 + (sg > 0 ? 0 : 1));
      const lamps: Array<['red' | 'yellow' | 'green', number]> = [['red', 4.25], ['yellow', 3.9], ['green', 3.55]];
      for (const [name, y] of lamps) {
        const lit = name === aspect;
        const raw = build.batch.addRaw(lit ? `rail_lamp_${name}` : 'rail_lamp_off');
        box(raw, at(y, 0.2), side, f.y, front, 0.075, 0.075, 0.015);
      }
      build.signals++;
    }
  }
}
