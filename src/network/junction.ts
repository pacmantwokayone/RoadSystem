// Junction geometry (pure 2-D math in the THREE-space xz plane — no terrain, no meshes).
//
// Arms leave the node centre in direction `dir`. Sorted by angle, the right-hand side of arm A
// faces the next arm B (right = (-dir.z, dir.x)). The wedge between A and B is one of:
//   fillet   γ < π : the "block corner" between the two roads — the edge lines of A (right) and B
//                    (left) meet at K; the corner is rounded with a curb radius, so both roads must
//                    stop `sK + t` from the node (t = radius / tan(γ/2))
//   mitre    γ > π : the outer corner of a bend — the edges meet at a sharp corner behind the node
//   straight γ ≈ π : the road continues straight on that side (incl. width changes = transitions)
//   cap            : a single arm (dead end), rounded off with a half circle
//
// Derivation (arm A along +x, B at angle γ): the edges A.right (y = wA) and B.left meet at
//   sA = (wA cosγ + wB) / sinγ   (along A)      sB = (wA + wB cosγ) / sinγ   (along B)

export interface Vec2 {
  x: number;
  z: number;
}

const v = (x: number, z: number): Vec2 => ({ x, z });
const add = (a: Vec2, b: Vec2): Vec2 => v(a.x + b.x, a.z + b.z);
const sub = (a: Vec2, b: Vec2): Vec2 => v(a.x - b.x, a.z - b.z);
const mul = (a: Vec2, k: number): Vec2 => v(a.x * k, a.z * k);
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
const cross = (a: Vec2, b: Vec2): number => a.x * b.z - a.z * b.x;
const len = (a: Vec2): number => Math.hypot(a.x, a.z);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => v(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
export const rightOf = (dir: Vec2): Vec2 => v(-dir.z, dir.x);

export const JUNCTION = {
  MIN_SETBACK: 2,
  MAX_SETBACK: 60,
  TANGENT_CAP: 30,
  /** |γ − π| below this (≈12°) counts as "straight on": a continuation, tapering between different widths */
  STRAIGHT_EPS: 0.21,
  /** wedges narrower than this (arms almost on top of each other) are treated as degenerate */
  MIN_GAMMA: 0.05,
} as const;

export interface ArmSpec {
  /** unit vector from the node centre along the road */
  dir: Vec2;
  /** carriageway half width */
  halfWidth: number;
}

export type WedgeKind = 'fillet' | 'mitre' | 'straight' | 'cap';

export interface Wedge {
  /** arm index (input order) on whose RIGHT side the wedge lies */
  a: number;
  /** next arm (increasing angle) */
  b: number;
  gamma: number;
  kind: WedgeKind;
  /** tangent length of the fillet along both edges (0 otherwise) */
  tangent: number;
  /** distance from arm a's / b's END back along its edge to the fillet's tangent point (≥ 0).
   * Positive when the arm stops before the tangent point would be reached or the tangent point
   * lies behind the node. */
  backA: number;
  backB: number;
}

export interface Layout {
  /** arm indices sorted by angle */
  order: number[];
  /** how far each arm (input order) stops from the node centre, metres */
  setbacks: number[];
  /** wedges[i] lies between order[i] and order[i+1] */
  wedges: Wedge[];
}

const TWO_PI = Math.PI * 2;

export function layoutJunction(arms: readonly ArmSpec[], radius: number): Layout {
  const n = arms.length;
  const J = JUNCTION;
  const ang = arms.map((a) => Math.atan2(a.dir.z, a.dir.x));
  const order = [...arms.keys()].sort((i, j) => ang[i] - ang[j]);
  const need = arms.map((): number => J.MIN_SETBACK);
  const wedges: Wedge[] = [];

  if (n === 0) return { order, setbacks: [], wedges };
  if (n === 1) {
    need[0] = Math.max(J.MIN_SETBACK, arms[0].halfWidth);
    return { order, setbacks: need, wedges: [{ a: 0, b: 0, gamma: TWO_PI, kind: 'cap', tangent: 0, backA: 0, backB: 0 }] };
  }

  for (let i = 0; i < n; i++) {
    const a = order[i];
    const b = order[(i + 1) % n];
    let gamma = ang[b] - ang[a];
    if (gamma <= 1e-9) gamma += TWO_PI;
    const wA = arms[a].halfWidth, wB = arms[b].halfWidth;
    let kind: WedgeKind;
    let tangent = 0;
    let sKA = 0, sKB = 0;
    if (Math.abs(gamma - Math.PI) < J.STRAIGHT_EPS) {
      kind = 'straight';
      // a width change on a straight run needs room to taper
      const taper = Math.max(J.MIN_SETBACK, 3 * Math.abs(wA - wB));
      need[a] = Math.max(need[a], taper);
      need[b] = Math.max(need[b], taper);
    } else if (gamma < Math.PI) {
      kind = 'fillet';
      const sinG = Math.sin(gamma);
      sKA = (wA * Math.cos(gamma) + wB) / sinG;
      sKB = (wA + wB * Math.cos(gamma)) / sinG;
      tangent = Math.min(J.TANGENT_CAP, radius / Math.tan(gamma / 2));
      need[a] = Math.max(need[a], sKA + tangent);
      need[b] = Math.max(need[b], sKB + tangent);
    } else {
      kind = 'mitre';
      // the corner K must lie within the arms (not beyond their ends), or the boundary would run
      // out past an arm's end and back — nearly straight pairs of different widths meet far out
      const sinG = Math.sin(gamma);
      need[a] = Math.max(need[a], (wA * Math.cos(gamma) + wB) / sinG);
      need[b] = Math.max(need[b], (wA + wB * Math.cos(gamma)) / sinG);
    }
    wedges.push({ a, b, gamma, kind, tangent, backA: sKA, backB: sKB }); // sK for now, turned into 'back' below
  }
  const setbacks = need.map((s) => Math.min(J.MAX_SETBACK, Math.max(J.MIN_SETBACK, s)));
  for (const w of wedges) {
    if (w.kind === 'fillet') {
      const sKA = w.backA, sKB = w.backB;
      w.backA = Math.max(0, setbacks[w.a] - (sKA + w.tangent));
      w.backB = Math.max(0, setbacks[w.b] - (sKB + w.tangent));
    } else {
      w.backA = 0; w.backB = 0;
    }
  }
  return { order, setbacks, wedges };
}

// ---- boundary of the junction patch -------------------------------------------------

/** The actual end cross-section of an arm (after trimming), core width only. */
export interface ArmEnd {
  left: Vec2;
  right: Vec2;
  /** unit direction pointing away from the node (the road's own direction at this end) */
  dir: Vec2;
}

export type BoundaryTag =
  | { type: 'arm'; arm: number; f: number }               // on an arm's end edge; f: 0 = left corner … 1 = right corner
  | { type: 'wedge'; a: number; b: number; t: number };   // on the path from arm a's right corner (t=0) to arm b's left corner (t=1)

export interface BoundaryPoint {
  p: Vec2;
  tag: BoundaryTag;
}

export interface Boundary {
  /** 'none' = the designed shape; 'straight' / 'hull' = a robust fallback was needed (extreme geometry) */
  fallback: 'none' | 'straight' | 'hull';
  /** closed loop, arm after arm in angular order */
  points: BoundaryPoint[];
  /** attached[k]: segment points[k] → points[k+1 mod n] is the seam to an arm (no wall there) */
  attached: boolean[];
}

export interface BoundaryOptions {
  arcSegments: number;
  edgeSegments: number;
}

export const DEFAULT_BOUNDARY_OPTIONS: BoundaryOptions = { arcSegments: 8, edgeSegments: 4 };

function bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return v(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.z + b * p1.z + c * p2.z + d * p3.z);
}

/** Intersection of the line (p, d1) with (q, d2); null if (nearly) parallel. */
function intersect(p: Vec2, d1: Vec2, q: Vec2, d2: Vec2): Vec2 | null {
  const det = cross(d1, d2);
  if (Math.abs(det) < 1e-6) return null;
  const tau = cross(sub(q, p), d2) / det;
  return add(p, mul(d1, tau));
}

export function assembleBoundary(layout: Layout, ends: readonly ArmEnd[], opts: BoundaryOptions = DEFAULT_BOUNDARY_OPTIONS): Boundary {
  const designed = assemble(layout, ends, opts, false);
  if (!polygonSelfIntersects(designed.points.map((p) => p.p))) return designed;
  // extreme geometry (e.g. a very wide and a very narrow road meeting at a shallow angle):
  // first try plain straight connections, then the convex hull of the arm corners
  const straight = assemble(layout, ends, opts, true);
  if (!polygonSelfIntersects(straight.points.map((p) => p.p))) return { ...straight, fallback: 'straight' };
  return hullBoundary(layout, ends);
}

/** Convex hull of all arm corners — always a simple polygon. */
function hullBoundary(layout: Layout, ends: readonly ArmEnd[]): Boundary {
  type C = { p: Vec2; arm: number; f: 0 | 1 };
  const corners: C[] = [];
  for (const arm of layout.order) {
    corners.push({ p: ends[arm].left, arm, f: 0 }, { p: ends[arm].right, arm, f: 1 });
  }
  const sorted = [...corners].sort((a, b) => a.p.x - b.p.x || a.p.z - b.p.z);
  const turn = (o: C, a: C, b: C): number => cross(sub(a.p, o.p), sub(b.p, o.p));
  const lower: C[] = [];
  for (const c of sorted) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], c) <= 0) lower.pop();
    lower.push(c);
  }
  const upper: C[] = [];
  for (const c of [...sorted].reverse()) {
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], c) <= 0) upper.pop();
    upper.push(c);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const points: BoundaryPoint[] = hull.map((c) => ({ p: c.p, tag: { type: 'arm', arm: c.arm, f: c.f } }));
  const attached = points.map((pt, k) => {
    const nx = points[(k + 1) % points.length];
    return pt.tag.type === 'arm' && nx.tag.type === 'arm' && pt.tag.arm === nx.tag.arm && pt.tag.f !== nx.tag.f;
  });
  return { fallback: 'hull', points, attached };
}

function assemble(layout: Layout, ends: readonly ArmEnd[], opts: BoundaryOptions, forceStraight: boolean): Boundary {
  const points: BoundaryPoint[] = [];
  const { order, wedges } = layout;
  const n = order.length;

  for (let i = 0; i < n; i++) {
    const arm = order[i];
    const e = ends[arm];
    for (let q = 0; q <= opts.edgeSegments; q++) {
      const f = q / opts.edgeSegments;
      points.push({ p: lerp(e.left, e.right, f), tag: { type: 'arm', arm, f } });
    }
    const w = wedges[i];
    const next = ends[w.b];
    const from = e.right, to = next.left;

    if (forceStraight && w.kind !== 'cap') {
      // 'straight': this arm's right corner connects directly to the next arm's left corner
    } else if (w.kind === 'cap') {
      const c = lerp(e.left, e.right, 0.5);
      const v0 = sub(e.right, c);
      const r = len(v0);
      for (let q = 1; q < opts.arcSegments * 2; q++) {
        const th = (Math.PI * q) / (opts.arcSegments * 2);
        points.push({ p: add(c, add(mul(v0, Math.cos(th)), mul(e.dir, -r * Math.sin(th)))), tag: { type: 'wedge', a: arm, b: arm, t: q / (opts.arcSegments * 2) } });
      }
    } else if (w.kind === 'fillet') {
      // run back along each edge to the tangent point (it can lie behind the node), then round the corner
      const tA = sub(from, mul(e.dir, w.backA));
      const tB = sub(to, mul(next.dir, w.backB));
      const chord = len(sub(tB, tA));
      const cosPhi = Math.max(-1, Math.min(1, dot(mul(e.dir, -1), next.dir)));
      const phi = Math.acos(cosPhi); // turn from heading "toward the node" to heading "away on B"
      const k = chord / (3 * Math.cos(phi / 4) ** 2);
      const p1 = add(tA, mul(e.dir, -k));
      const p2 = sub(tB, mul(next.dir, k));
      const total = opts.arcSegments;
      if (w.backA > 1e-6) points.push({ p: tA, tag: { type: 'wedge', a: arm, b: w.b, t: 0 } });
      for (let q = 1; q < total; q++) {
        points.push({ p: bezier(tA, p1, p2, tB, q / total), tag: { type: 'wedge', a: arm, b: w.b, t: 0.1 + (0.8 * q) / total } });
      }
      if (w.backB > 1e-6) points.push({ p: tB, tag: { type: 'wedge', a: arm, b: w.b, t: 1 } });
    } else if (w.kind === 'mitre') {
      const K = intersect(from, e.dir, to, next.dir);
      // a mitre far from the ends means nearly parallel edges: fall back to a straight connection
      if (K && len(sub(K, lerp(from, to, 0.5))) < JUNCTION.MAX_SETBACK * 1.5) {
        points.push({ p: K, tag: { type: 'wedge', a: arm, b: w.b, t: 0.5 } });
      }
    }
    // 'straight': R of this arm connects directly to L of the next
  }

  const attached = points.map((pt, k) => {
    const nx = points[(k + 1) % points.length];
    return pt.tag.type === 'arm' && nx.tag.type === 'arm' && pt.tag.arm === nx.tag.arm;
  });
  return { fallback: 'none', points, attached };
}

// ---- helpers (also used by tests / the mesher) ----------------------------------------

/** Signed area (positive = counter-clockwise in the x→z sense). */
export function polygonArea(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

export function pointInPolygon(p: Vec2, pts: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** True if any two non-adjacent edges cross (a simple polygon must have none). */
export function polygonSelfIntersects(pts: readonly Vec2[]): boolean {
  const n = pts.length;
  const segX = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
    const d1 = cross(sub(b, a), sub(c, a)), d2 = cross(sub(b, a), sub(d, a));
    const d3 = cross(sub(d, c), sub(a, c)), d4 = cross(sub(d, c), sub(b, c));
    return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segX(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}
