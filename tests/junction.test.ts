import { describe, it, expect } from 'vitest';
import {
  layoutJunction, assembleBoundary, polygonArea, polygonSelfIntersects, pointInPolygon, rightOf,
  type ArmSpec, type ArmEnd, type Vec2,
} from '../src/network/junction';

const dirAt = (deg: number): Vec2 => ({ x: Math.cos((deg * Math.PI) / 180), z: Math.sin((deg * Math.PI) / 180) });
const arm = (deg: number, w: number): ArmSpec => ({ dir: dirAt(deg), halfWidth: w });

/** ideal end cross-sections on straight axes at the layout's setbacks */
function idealEnds(arms: ArmSpec[], setbacks: number[]): ArmEnd[] {
  return arms.map((a, i) => {
    const E = { x: a.dir.x * setbacks[i], z: a.dir.z * setbacks[i] };
    const r = rightOf(a.dir);
    return { dir: a.dir, left: { x: E.x - r.x * a.halfWidth, z: E.z - r.z * a.halfWidth }, right: { x: E.x + r.x * a.halfWidth, z: E.z + r.z * a.halfWidth } };
  });
}

describe('layoutJunction setbacks', () => {
  it('X crossing, equal widths w, radius ρ: every arm stops at w + ρ (γ = 90°)', () => {
    const arms = [arm(0, 3), arm(90, 3), arm(180, 3), arm(270, 3)];
    const L = layoutJunction(arms, 6);
    L.setbacks.forEach((s) => expect(s).toBeCloseTo(3 + 6, 6));
    expect(L.wedges.every((w) => w.kind === 'fillet')).toBe(true);
  });

  it('T junction: the through road is straight on its far side, fillets on the side road side', () => {
    const arms = [arm(0, 3.8), arm(180, 3.8), arm(90, 3)]; // east, west, side road to +z
    const L = layoutJunction(arms, 6);
    const kinds = L.wedges.map((w) => w.kind).sort();
    expect(kinds).toEqual(['fillet', 'fillet', 'straight']);
    // side road must stop at least a through-road half width + radius away
    expect(L.setbacks[2]).toBeGreaterThanOrEqual(3.8 + 6 - 1e-6);
  });

  it('straight pair with different widths gets a taper zone proportional to the difference', () => {
    const L = layoutJunction([arm(0, 1), arm(180, 4)], 6);
    expect(L.wedges.every((w) => w.kind === 'straight')).toBe(true);
    L.setbacks.forEach((s) => expect(s).toBeGreaterThanOrEqual(9 - 1e-9));
  });

  it('a 90° bend: inside wedge is a fillet, the outside wedge a mitre', () => {
    const L = layoutJunction([arm(0, 3), arm(90, 3)], 6);
    expect(L.wedges.map((w) => w.kind).sort()).toEqual(['fillet', 'mitre']);
  });

  it('acute angles demand longer setbacks but stay capped', () => {
    const sharp = layoutJunction([arm(0, 3), arm(20, 3), arm(200, 3)], 6);
    expect(Math.max(...sharp.setbacks)).toBeLessThanOrEqual(60);
    const wide = layoutJunction([arm(0, 3), arm(120, 3), arm(240, 3)], 6);
    expect(Math.max(...sharp.setbacks)).toBeGreaterThan(Math.max(...wide.setbacks));
  });

  it('single arm: dead end cap with the road half width as radius', () => {
    const L = layoutJunction([arm(30, 3.5)], 6);
    expect(L.wedges[0].kind).toBe('cap');
    expect(L.setbacks[0]).toBeCloseTo(3.5);
  });
});

describe('assembleBoundary', () => {
  function boundaryFor(arms: ArmSpec[], radius = 6) {
    const L = layoutJunction(arms, radius);
    const B = assembleBoundary(L, idealEnds(arms, L.setbacks));
    return { L, B, pts: B.points.map((p) => p.p) };
  }

  it('X crossing: simple polygon around the node, with the node inside', () => {
    const { pts } = boundaryFor([arm(0, 3), arm(90, 3), arm(180, 3), arm(270, 3)]);
    expect(polygonSelfIntersects(pts)).toBe(false);
    expect(Math.abs(polygonArea(pts))).toBeGreaterThan(50);
    expect(pointInPolygon({ x: 0, z: 0 }, pts)).toBe(true);
  });

  it('fillets really round the block corner: the arc passes inside the sharp corner', () => {
    const { B } = boundaryFor([arm(0, 3), arm(90, 3), arm(180, 3), arm(270, 3)]);
    // the corner point K of the east/north wedge is (3, 3); the curb arc must stay on the road side of it
    const arc = B.points.filter((p) => p.tag.type === 'wedge' && p.tag.a === 0 && p.tag.b === 1).map((p) => p.p);
    expect(arc.length).toBeGreaterThan(4);
    const mid = arc[Math.floor(arc.length / 2)];
    // a fillet cuts the TIP off the block: the arc lies beyond the corner, inside the block,
    // at (9 − 6/√2, 9 − 6/√2) ≈ (4.76, 4.76) for w = 3, ρ = 6
    expect(mid.x).toBeCloseTo(9 - 6 / Math.SQRT2, 1);
    expect(mid.z).toBeCloseTo(9 - 6 / Math.SQRT2, 1);
    expect(Math.hypot(mid.x - 3, mid.z - 3)).toBeGreaterThan(1.5); // pulled away from the sharp corner K = (3, 3)
  });

  it('seams to the arms are marked as attached (no wall), the rest are free boundary', () => {
    const { B } = boundaryFor([arm(0, 3), arm(90, 3), arm(180, 3)]);
    const attachedCount = B.attached.filter(Boolean).length;
    expect(attachedCount).toBe(3 * 4); // 3 arms × 4 edge segments
    expect(B.attached.filter((a) => !a).length).toBeGreaterThan(3);
  });

  it('is a simple polygon over many random well-separated junctions (property test)', () => {
    let seed = 999; // this seed contains extreme width mismatches that need the fallbacks
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    let checked = 0, fallbacks = 0;
    for (let iter = 0; iter < 6000; iter++) {
      const n = 2 + Math.floor(rnd() * 4); // 2..5 arms
      const degs: number[] = [];
      let tries = 0;
      while (degs.length < n && tries++ < 100) {
        const d = rnd() * 360;
        if (degs.every((o) => Math.abs(((d - o + 540) % 360) - 180) > 30)) degs.push(d); // angular distance > 30°
      }
      if (degs.length < n) continue;
      const arms = degs.map((d) => arm(d, 1 + rnd() * 4));
      const { pts, L, B } = boundaryFor(arms, 2 + rnd() * 8);
      if (B.fallback !== 'none') fallbacks++;
      expect(L.setbacks.every((s) => Number.isFinite(s) && s >= 2 && s <= 60)).toBe(true);
      expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z))).toBe(true);
      expect(polygonSelfIntersects(pts)).toBe(false);
      expect(Math.abs(polygonArea(pts))).toBeGreaterThan(1);
      checked++;
    }
    expect(checked).toBeGreaterThan(2000);
    expect(fallbacks / checked).toBeLessThan(0.01); // the designed shape is the norm, fallbacks the rare exception
  });

  it('dead end: half-circle cap beyond the arm end, closing the loop', () => {
    const { pts, B } = boundaryFor([arm(0, 3)]);
    expect(polygonSelfIntersects(pts)).toBe(false);
    const tip = pts.reduce((a, p) => (p.x < a.x ? p : a), pts[0]); // furthest toward the node (−x)
    expect(tip.x).toBeCloseTo(0, 0); // setback 3 → semicircle radius 3 reaches back to the node
    expect(B.attached.filter(Boolean).length).toBe(4);
  });
});
