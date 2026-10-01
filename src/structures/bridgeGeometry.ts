// Geometry of a bridge, per road chunk. The deck itself is the road's own extrusion (see mesh/extrude.ts: on a bridge it is a
// slab of `deck.thickness`, clipped to the carriageway); this module adds everything else:
//   girders · piers · abutments + wing walls · railings · arch ribs + spandrels · truss · lamps.
//
// Seam rules (same idea as props/place.ts): continuous parts (girders, railings, arch ribs, wing walls) are extruded from the
// ring samples inside the chunk, so the shared border sample makes neighbouring chunks meet exactly; discrete parts (piers,
// abutments, posts, lamps) belong to the chunk whose half-open range contains them; the truss re-divides every chunk into whole
// panels so a node always lies on the chunk border. Piers stand where the whole section divides into equal spans, a function
// of the section alone — never of the chunk.

import * as THREE from 'three';
import type { RoadChunk, RoadRuntime } from '../runtime/roadRuntime';
import { profileHeightInside } from '../profile/types';
import { ChunkSampler } from '../props/sampler';
import { GeometryBatch } from '../props/batch';
import type { Placement } from '../props/place';
import { sidesOf } from '../props/rules';
import { beam, box, circleRing, loft, rectRing, type Raw } from './primitives';
import { bridgeSections, pierPositionsFor, type BridgeSection } from './sections';
import type { BridgeData } from './types';

export interface BridgeBuild {
  batch: GeometryBatch;
  placements: Placement[];
  /** false when terrain needed for a pier / arch wasn't known yet — the layer retries later */
  complete: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
/** extra station spacing along curved members (arch ribs), metres */
const CURVE_STEP_M = 2;
const EMBED_M = 0.35;

class Ctx {
  complete = true;
  readonly isLast: boolean;
  readonly sMin: number;
  readonly sMax: number;
  readonly halfW: number;
  readonly yEdge: number;
  readonly batch = new GeometryBatch();
  readonly placements: Placement[] = [];

  constructor(readonly rt: RoadRuntime, readonly chunk: RoadChunk, readonly sampler: ChunkSampler, readonly bridge: BridgeData) {
    this.isLast = chunk.index === rt.chunks.length - 1;
    this.sMin = sampler.sMin;
    this.sMax = sampler.sMax;
    this.halfW = rt.profile.coreHalfWidth;
    this.yEdge = profileHeightInside(rt.profile, this.halfW);
  }

  owns(s: number): boolean {
    return s >= this.sMin && (s < this.sMax || (this.isLast && s <= this.sMax + 1e-9));
  }

  raw(material: string): Raw {
    return this.batch.addRaw(material);
  }

  /** point at arc length s, lateral xp (profile space), height y above the design line */
  P(s: number, xp: number, y: number): THREE.Vector3 {
    return this.sampler.point(s, xp, y).pos;
  }

  /** stations from a to b: the ends and every ring in between; `step` adds a fine grid on an absolute raster */
  stations(a: number, b: number, step = 0): number[] {
    const set = new Set<number>([a, b]);
    for (let r = 0; r < this.sampler.sections.length; r++) {
      const s = this.rt.samples[this.sampler.sampleIndex(r)].s;
      if (s > a + 1e-6 && s < b - 1e-6) set.add(s);
    }
    if (step > 0) for (let s = Math.ceil((a + 1e-6) / step) * step; s < b - 1e-6; s += step) set.add(s);
    return [...set].sort((x, y) => x - y);
  }

  /** terrain height at a world position (THREE space); marks the build incomplete when unknown */
  ground(x: number, z: number): number | null {
    const g = this.rt.groundAtThree(x, z);
    if (g === null) this.complete = false;
    return g;
  }

  /** design-line height at s */
  deckY(s: number): number {
    return this.sampler.point(s, 0, 0).pos.y;
  }

  /** underside of the deck (including girders) at s, absolute */
  deckBottom(s: number): number {
    const g = this.bridge.girders;
    return this.deckY(s) - this.bridge.deck.thickness - (g ? g.depth : 0);
  }

  /** horizontal unit vectors across and along the road at s */
  axes(s: number): { right: THREE.Vector3; tan: THREE.Vector3; pos: THREE.Vector3 } {
    const p = this.sampler.point(s, 0, 0);
    return { right: p.right.clone(), tan: p.tangent.clone(), pos: p.pos };
  }
}

// ---- girders, railing, truss, lamps ---------------------------------------------------------

function girders(c: Ctx, a: number, b: number, sec: BridgeSection): void {
  const g = c.bridge.girders;
  if (!g) return;
  const raw = c.raw(g.material);
  const st = c.stations(a, b);
  const top = -c.bridge.deck.thickness + 0.02;
  for (let k = 0; k < g.count; k++) {
    const x = g.count === 1 ? 0 : (-1 + (2 * k) / (g.count - 1)) * g.spread * c.halfW;
    const rings = st.map((s) => [
      c.P(s, x - g.width / 2, top - g.depth), c.P(s, x + g.width / 2, top - g.depth), c.P(s, x + g.width / 2, top), c.P(s, x - g.width / 2, top),
    ]);
    loft(raw, rings, { capStart: a <= sec.s0 + 1e-6, capEnd: b >= sec.s1 - 1e-6 });
  }
}

function railing(c: Ctx, a: number, b: number, sec: BridgeSection): void {
  const r = c.bridge.railing;
  if (r.type === 'none' || c.bridge.truss) return;
  const raw = c.raw(r.material);
  const st = c.stations(a, b);
  const capStart = a <= sec.s0 + 1e-6, capEnd = b >= sec.s1 - 1e-6;
  const yb = c.yEdge;
  for (const side of [-1, 1]) {
    const x = side * (c.halfW - 0.18);
    const strip = (xc: number, hw: number, y0: number, y1: number): void => {
      loft(raw, st.map((s) => [c.P(s, xc - hw, y0), c.P(s, xc + hw, y0), c.P(s, xc + hw, y1), c.P(s, xc - hw, y1)]), { capStart, capEnd });
    };
    if (r.type === 'parapet') {
      strip(x, 0.15, yb, yb + r.height);
    } else if (r.type === 'steel') {
      for (const f of [0.38, 0.7, 1.0]) strip(x, 0.03, yb + r.height * f - 0.03, yb + r.height * f + 0.03);
      strip(x, 0.12, yb, yb + 0.14); // kerb
    } else {
      for (const f of [0.55, 0.95]) strip(x, 0.045, yb + r.height * f - 0.05, yb + r.height * f + 0.05);
    }
    // posts
    if (r.type !== 'parapet') {
      const spacing = r.type === 'steel' ? 2 : 1.6;
      const w = r.type === 'steel' ? 0.04 : 0.07;
      for (let s = Math.ceil((a + 1e-6) / spacing) * spacing; s <= b + 1e-6; s += spacing) {
        if (s > b - 1e-6 && !c.owns(s)) continue;
        if (!(s >= a - 1e-6 && s <= b + 1e-6) || !(c.owns(s) || s < c.sMax - 1e-6)) continue;
        const ax = c.axes(s);
        box(raw, c.P(s, x, yb + r.height / 2), ax.right, UP, ax.tan, w, r.height / 2, w);
      }
    }
  }
}

function truss(c: Ctx, a: number, b: number, sec: BridgeSection): void {
  const t = c.bridge.truss;
  if (!t) return;
  const raw = c.raw(t.material);
  const n = Math.max(1, Math.round((b - a) / t.panel));
  const nodes = Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  const parity = Math.round((a - sec.s0) / t.panel);
  const xt = c.halfW + t.chord * 0.6;
  const yBot = c.yEdge + 0.35, yTop = c.yEdge + t.height;
  for (const side of [-1, 1]) {
    const bot = nodes.map((s) => c.P(s, side * xt, yBot)), top = nodes.map((s) => c.P(s, side * xt, yTop));
    for (let i = 0; i <= n; i++) beam(raw, bot[i], top[i], t.chord * 0.8, t.chord * 0.8, UP); // verticals
    for (let i = 0; i < n; i++) {
      beam(raw, bot[i], bot[i + 1], t.chord, t.chord, UP);
      beam(raw, top[i], top[i + 1], t.chord, t.chord, UP);
      const even = (i + parity) % 2 === 0;
      beam(raw, even ? bot[i] : top[i], even ? top[i + 1] : bot[i + 1], t.chord * 0.7, t.chord * 0.7, UP);
    }
  }
  // portal bracing across the top at every second node, and a low kerb along the deck edges
  for (let i = 0; i <= n; i += 2) beam(raw, c.P(nodes[i], -xt, yTop), c.P(nodes[i], xt, yTop), t.chord * 0.7, t.chord * 0.7, UP);
  const kerb = c.raw(c.bridge.deck.material);
  const st = c.stations(a, b);
  for (const side of [-1, 1]) {
    const x = side * (c.halfW - 0.15);
    loft(kerb, st.map((s) => [c.P(s, x - 0.15, c.yEdge), c.P(s, x + 0.15, c.yEdge), c.P(s, x + 0.15, c.yEdge + 0.25), c.P(s, x - 0.15, c.yEdge + 0.25)]), { capStart: a <= sec.s0 + 1e-6, capEnd: b >= sec.s1 - 1e-6 });
  }
}

function lamps(c: Ctx, sec: BridgeSection): void {
  const l = c.bridge.lamps;
  if (!l) return;
  for (const side of sidesOf(l.side)) {
    const sg = side === 'right' ? 1 : -1;
    for (let s = sec.s0 + l.spacing / 2; s < sec.s1; s += l.spacing) {
      if (!c.owns(s)) continue;
      const p = c.sampler.point(s, sg * (c.halfW - 0.35), c.yEdge);
      const toRoad = { x: -p.right.x * sg, z: -p.right.z * sg };
      c.placements.push({ asset: l.asset, pos: p.pos, yaw: Math.atan2(toRoad.x, toRoad.z), scale: 1, rule: -1, s, side });
    }
  }
}

// ---- supports -----------------------------------------------------------------------------------

/** One support (pier) at arc length s whose top is at absolute height topY. */
function support(c: Ctx, s: number, topY: number, withCap: boolean): void {
  const p = c.bridge.piers;
  if (!p) return;
  const raw = c.raw(p.material);
  const ax = c.axes(s);
  const offsets = p.shape === 'twin' ? [-0.55 * c.halfW, 0.55 * c.halfW] : [0];
  const across = p.shape === 'wall' ? p.width : p.width, along = p.depth;
  const capH = withCap && (p.cap || p.shape === 'hammer') ? p.capHeight : 0;
  const colTop = topY - capH;
  let placed = false;
  for (const lx of offsets) {
    const centre = ax.pos.clone().addScaledVector(ax.right, lx);
    const gy = c.ground(centre.x, centre.z);
    if (gy === null) continue;
    if (colTop - gy < p.minHeight) continue;
    placed = true;
    const bottom = gy - EMBED_M;
    const f = 1 - p.taper;
    const top = new THREE.Vector3(centre.x, colTop, centre.z), bot = new THREE.Vector3(centre.x, bottom, centre.z);
    if (p.round) loft(raw, [circleRing(top, ax.right, ax.tan, across / 2, along / 2), circleRing(bot, ax.right, ax.tan, (across / 2) * f, (along / 2) * f)], { smooth: true, capStart: true, capEnd: true });
    else loft(raw, [rectRing(top, ax.right, ax.tan, across / 2, along / 2), rectRing(bot, ax.right, ax.tan, (across / 2) * f, (along / 2) * f)], { capStart: true, capEnd: true });
    if (p.footing > 0) {
      const fc = new THREE.Vector3(centre.x, gy - 0.3, centre.z);
      box(raw, fc, ax.right, UP, ax.tan, (across / 2) * f + p.footing, 0.4, (along / 2) * f + p.footing);
    }
  }
  if (placed && capH > 0) {
    const reach = offsets.length > 1 ? Math.max(...offsets.map(Math.abs)) + across / 2 + 0.3 : Math.max(across / 2 + 0.3, p.shape === 'hammer' ? c.halfW * 0.85 : 0);
    box(raw, ax.pos.clone().setY(topY - capH / 2), ax.right, UP, ax.tan, reach, capH / 2, along / 2 + 0.25);
  }
}

function piers(c: Ctx, sec: BridgeSection): void {
  const p = c.bridge.piers;
  if (!p || c.bridge.arch) return;
  for (const s of pierPositionsFor(c.rt, sec, p.maxSpan)) {
    if (!c.owns(s)) continue;
    support(c, s, c.deckBottom(s), true);
  }
}

function abutment(c: Ctx, s: number, atStart: boolean): void {
  if (!c.owns(s)) return;
  const A = c.bridge.abutments;
  const raw = c.raw(A.material);
  const ax = c.axes(s);
  const top = c.deckY(s) - c.bridge.deck.thickness;
  const dir = atStart ? 1 : -1; // from the section's end into the bridge
  // lowest ground across the abutment
  let low = Infinity;
  for (const lx of [-c.halfW, 0, c.halfW]) {
    const q = ax.pos.clone().addScaledVector(ax.right, lx).addScaledVector(ax.tan, -dir * 0.5);
    const g = c.ground(q.x, q.z);
    if (g !== null) low = Math.min(low, g);
  }
  if (!Number.isFinite(low)) return;
  const bottom = Math.min(low - 0.6, top - 0.8);
  const len = A.depth + 0.4;
  const centre = ax.pos.clone().addScaledVector(ax.tan, dir * (A.depth / 2 - 0.2)).setY((top + bottom) / 2);
  box(raw, centre, ax.right, UP, ax.tan, c.halfW + 0.4, (top - bottom) / 2, len / 2);
}

/** Retaining wall beside the road next to an abutment: top follows the carriageway edge, bottom the terrain. */
function wing(c: Ctx, sec: BridgeSection, atStart: boolean): void {
  const A = c.bridge.abutments;
  if (A.wing <= 0) return;
  const a = atStart ? sec.s0 - A.wing : sec.s1;
  const b = atStart ? sec.s0 : sec.s1 + A.wing;
  const lo = Math.max(a, c.sMin), hi = Math.min(b, c.sMax);
  if (hi - lo < 0.05) return;
  const raw = c.raw(A.material);
  const st = c.stations(lo, hi);
  for (const side of [-1, 1]) {
    const x = side * (c.halfW + 0.15);
    const rings: THREE.Vector3[][] = [];
    for (const s of st) {
      const top = c.P(s, x, c.yEdge - 0.02);
      const g = c.ground(top.x, top.z);
      const bottomY = Math.min(g === null ? top.y - 0.5 : g - 0.4, top.y - 0.4);
      const q = c.sampler.point(s, x, 0);
      const bottom = new THREE.Vector3(top.x, bottomY, top.z);
      const half = 0.2;
      rings.push([
        top.clone().addScaledVector(q.right, -half), top.clone().addScaledVector(q.right, half),
        bottom.clone().addScaledVector(q.right, half), bottom.clone().addScaledVector(q.right, -half),
      ]);
    }
    loft(raw, rings, { capStart: true, capEnd: true });
  }
}

// ---- arch ---------------------------------------------------------------------------------------

function arch(c: Ctx, sec: BridgeSection): void {
  const A = c.bridge.arch;
  const P = c.bridge.piers;
  if (!A) return;
  const supports = [sec.s0 + c.bridge.abutments.depth * 0.5, ...(P ? pierPositionsFor(c.rt, sec, P.maxSpan) : []), sec.s1 - c.bridge.abutments.depth * 0.5];
  const raw = c.raw(A.material);
  const groundAt = (s: number): number | null => {
    const q = c.sampler.point(s, 0, 0);
    // the section's end supports lie inside the chunk range only when owned; elsewhere use the road's own probe
    return c.ground(q.pos.x, q.pos.z);
  };

  for (let k = 0; k < supports.length - 1; k++) {
    const sa = supports[k], sb = supports[k + 1];
    const lo = Math.max(sa, c.sMin), hi = Math.min(sb, c.sMax);
    if (hi - lo < 0.05 && !(c.owns(sa))) continue;
    const ga = groundAt(sa), gb = groundAt(sb);
    if (ga === null || gb === null) continue;
    const span = sb - sa;
    const ya = ga + 0.3, yb = gb + 0.3;
    const mid = (sa + sb) / 2;
    const crownRoom = c.deckBottom(mid) - 0.5 - A.ribDepth / 2 - (ya + yb) / 2;
    const h = Math.min(A.rise * span, crownRoom);
    if (h < 0.4) continue; // no room for an arch: the deck simply spans (piers carry it)
    const centreY = (s: number): number => {
      const u = (s - sa) / span;
      return ya + (yb - ya) * u + 4 * h * u * (1 - u);
    };
    if (hi - lo >= 0.05) {
      const st = c.stations(lo, hi, CURVE_STEP_M);
      for (let r = 0; r < A.ribs; r++) {
        const x = A.ribs === 1 ? 0 : (-1 + (2 * r) / (A.ribs - 1)) * A.spread * c.halfW;
        const rings = st.map((s) => {
          const dy = centreY(s) - c.deckY(s);
          return [
            c.P(s, x - A.ribWidth / 2, dy - A.ribDepth / 2), c.P(s, x + A.ribWidth / 2, dy - A.ribDepth / 2),
            c.P(s, x + A.ribWidth / 2, dy + A.ribDepth / 2), c.P(s, x - A.ribWidth / 2, dy + A.ribDepth / 2),
          ];
        });
        loft(raw, rings, { capStart: lo <= sa + 1e-6, capEnd: hi >= sb - 1e-6 });
      }
      // spandrel
      if (A.spandrel === 'solid') {
        for (const side of [-1, 1]) {
          const x = side * (c.halfW - 0.4);
          const rings = st.map((s) => {
            const top = c.deckY(s) - c.bridge.deck.thickness;
            const bottom = Math.min(top - 0.1, centreY(s) + A.ribDepth / 2);
            const q = c.sampler.point(s, x, 0);
            const t = c.P(s, x, top - c.deckY(s)), b = new THREE.Vector3(t.x, bottom, t.z);
            return [t.clone().addScaledVector(q.right, -0.4), t.clone().addScaledVector(q.right, 0.4), b.clone().addScaledVector(q.right, 0.4), b.clone().addScaledVector(q.right, -0.4)];
          });
          loft(raw, rings, { capStart: lo <= sa + 1e-6, capEnd: hi >= sb - 1e-6 });
        }
      } else if (A.spandrel === 'columns') {
        const first = Math.ceil((sa + A.spandrelSpacing * 0.5) / A.spandrelSpacing) * A.spandrelSpacing;
        for (let s = first; s < sb - A.spandrelSpacing * 0.4; s += A.spandrelSpacing) {
          if (s < lo || s >= hi || !c.owns(s)) continue;
          const ax = c.axes(s);
          const top = c.deckBottom(s) + (c.bridge.girders?.depth ?? 0);
          const base = centreY(s) + A.ribDepth * 0.3;
          if (top - base < 0.4) continue;
          for (let r = 0; r < A.ribs; r++) {
            const x = A.ribs === 1 ? 0 : (-1 + (2 * r) / (A.ribs - 1)) * A.spread * c.halfW;
            const centre = ax.pos.clone().addScaledVector(ax.right, x).setY((top + base) / 2);
            box(raw, centre, ax.right, UP, ax.tan, A.ribWidth * 0.35, (top - base) / 2, 0.35);
          }
        }
      }
    }
    // springing at the interior supports: a pier from the ground up to the arch's springing
    if (P && k > 0 && c.owns(sa)) support(c, sa, Math.max(ya, centreY(sa)) + A.ribDepth / 2, false);
  }
}

// ---- entry point -----------------------------------------------------------------------------

export function buildChunkBridge(rt: RoadRuntime, chunk: RoadChunk): BridgeBuild | null {
  if (chunk.state !== 'ready') return null;
  const bridge = rt.bridge;
  const reach = bridge.abutments.wing;
  const sections = bridgeSections(rt).filter((s) => s.s1 >= rt.samples[chunk.i0].s - reach - 1e-6 && s.s0 <= rt.samples[chunk.i1].s + reach + 1e-6);
  if (!sections.length) return null;
  const sampler = new ChunkSampler(rt, chunk);
  const c = new Ctx(rt, chunk, sampler, bridge);
  for (const sec of sections) {
    const a = Math.max(sec.s0, c.sMin), b = Math.min(sec.s1, c.sMax);
    if (b - a > 0.05) {
      girders(c, a, b, sec);
      railing(c, a, b, sec);
      truss(c, a, b, sec);
    }
    lamps(c, sec);
    piers(c, sec);
    arch(c, sec);
    if (sec.startsAtRoad || sec.i0 === 0) { abutment(c, sec.s0, true); wing(c, sec, true); }
    if (sec.endsAtRoad || sec.i1 === rt.samples.length - 1) { abutment(c, sec.s1, false); wing(c, sec, false); }
  }
  return { batch: c.batch, placements: c.placements, complete: c.complete };
}
