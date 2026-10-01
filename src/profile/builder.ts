// The `R` API handed to profile code. Profiles are built from the centre
// outwards: an optional centre strip, then a half-profile per side made of
// surfaces / steps / ditches. `both()` mirrors a half-profile to the other side.
//
//   R.profile('Landstrasse')
//     .thickness(0.8).bodyMaterial('subgrade').smooth(18)
//     .both(h => h
//       .surface(3.0, 'asphalt', { kind: 'lane', slope: -0.025 })
//       .surface(0.8, 'asphalt_worn', { kind: 'shoulder', slope: -0.04 })
//       .ditch(1.4, 0.35, 'grass'))

import type { ProfileData, ProfilePoint, ProfileSegment, VaryContext, VaryResult } from './types';

export interface SurfaceOpts {
  /** rise over run going OUTWARD (negative = falls away from the centre) */
  slope?: number;
  kind?: string;
  id?: string;
  /** counts as carriageway footprint; default true except verge/ditch/slope helpers */
  core?: boolean;
}

type Element =
  | { type: 'surface'; width: number; dy: number; material: string; kind: string; id?: string; core: boolean }
  | { type: 'step'; dy: number; material: string; kind: string; id?: string; core: boolean };

function checkWidth(w: number, what: string): void {
  if (!(w > 0) || !Number.isFinite(w)) throw new Error(`${what}: width must be > 0 (got ${w})`);
}

export class HalfBuilder {
  readonly elements: Element[] = [];

  /** Flat or sloped strip of the given width. */
  surface(width: number, material: string, opts: SurfaceOpts = {}): this {
    checkWidth(width, 'surface');
    this.elements.push({
      type: 'surface', width, dy: width * (opts.slope ?? 0), material,
      kind: opts.kind ?? 'surface', id: opts.id, core: opts.core ?? true,
    });
    return this;
  }

  /** Strip that rises/falls by `dy` metres over `width` (convenience for `surface` with slope). */
  slope(width: number, dy: number, material: string, opts: SurfaceOpts = {}): this {
    checkWidth(width, 'slope');
    this.elements.push({
      type: 'surface', width, dy, material,
      kind: opts.kind ?? 'verge', id: opts.id, core: opts.core ?? false,
    });
    return this;
  }

  /** Vertical face (kerb): dy > 0 steps up going outward. */
  step(dy: number, material = 'curb', opts: SurfaceOpts = {}): this {
    if (!Number.isFinite(dy) || dy === 0) return this;
    this.elements.push({ type: 'step', dy, material, kind: opts.kind ?? 'curb', id: opts.id, core: opts.core ?? true });
    return this;
  }

  /** V-shaped ditch: falls `depth` over the first half of `width`, rises again over the second. */
  ditch(width: number, depth: number, material: string, opts: SurfaceOpts = {}): this {
    checkWidth(width, 'ditch');
    const kind = opts.kind ?? 'ditch';
    this.slope(width / 2, -depth, material, { kind, core: false });
    this.slope(width / 2, +depth, material, { kind, core: false });
    return this;
  }
}

export interface CentreSpec {
  width: number;
  material: string;
  kind: string;
  id?: string;
  core: boolean;
}

export class ProfileBuilder {
  private _thickness = 0.6;
  private _body = 'subgrade';
  private _smooth: number | undefined;
  private _centre: CentreSpec | null = null;
  private _right: Element[] = [];
  private _left: Element[] = [];
  private _vary: ((ctx: VaryContext) => VaryResult) | undefined;

  constructor(readonly name: string) {}

  thickness(m: number): this { this._thickness = Math.max(0.05, m); return this; }
  bodyMaterial(name: string): this { this._body = name; return this; }
  smooth(radiusM: number): this { this._smooth = Math.max(0, radiusM); return this; }

  /** Strip centred on the axis (path, median, …). */
  center(width: number, material: string, opts: SurfaceOpts = {}): this {
    checkWidth(width, 'center');
    this._centre = { width, material, kind: opts.kind ?? 'lane', id: opts.id, core: opts.core ?? true };
    return this;
  }

  right(fn: (h: HalfBuilder) => void): this {
    const h = new HalfBuilder();
    fn(h);
    this._right = h.elements;
    return this;
  }

  left(fn: (h: HalfBuilder) => void): this {
    const h = new HalfBuilder();
    fn(h);
    this._left = h.elements;
    return this;
  }

  /** Same half-profile on both sides (mirrored). */
  both(fn: (h: HalfBuilder) => void): this {
    const h = new HalfBuilder();
    fn(h);
    this._right = h.elements;
    this._left = h.elements;
    return this;
  }

  /** Per-sample variation along the road (path wobble, width noise, …). */
  vary(fn: (ctx: VaryContext) => VaryResult): this {
    this._vary = fn;
    return this;
  }

  finish(): ProfileData {
    const bh = this._centre ? this._centre.width / 2 : 0;
    const walk = (els: Element[], sign: 1 | -1): { pts: ProfilePoint[]; segs: ProfileSegment[] } => {
      const pts: ProfilePoint[] = [{ x: sign * bh + 0, y: 0 }]; // `+ 0` turns -0 into 0
      const segs: ProfileSegment[] = [];
      let x = bh;
      let y = 0;
      for (const e of els) {
        if (e.type === 'surface') { x += e.width; y += e.dy; } else { y += e.dy; }
        pts.push({ x: sign * x + 0, y });
        segs.push({ material: e.material, kind: e.kind, id: e.id, core: e.core });
      }
      return { pts, segs };
    };
    const R = walk(this._right, 1);
    const L = walk(this._left, -1);

    const points: ProfilePoint[] = [...L.pts].reverse();
    const segments: ProfileSegment[] = [...L.segs].reverse();
    if (this._centre) {
      segments.push({ material: this._centre.material, kind: this._centre.kind, id: this._centre.id, core: this._centre.core });
      points.push(...R.pts);
    } else {
      points.push(...R.pts.slice(1));
    }
    segments.push(...R.segs);

    if (segments.length === 0) throw new Error(`profile '${this.name}' has no surfaces`);

    let core = 0;
    let outer = 0;
    segments.forEach((seg, k) => {
      const a = Math.abs(points[k].x);
      const b = Math.abs(points[k + 1].x);
      outer = Math.max(outer, a, b);
      if (seg.core) core = Math.max(core, a, b);
    });

    return {
      name: this.name,
      points,
      segments,
      thickness: this._thickness,
      bodyMaterial: this._body,
      smoothRadiusM: this._smooth,
      coreHalfWidth: core,
      outerHalfWidth: outer,
      vary: this._vary,
    };
  }
}

// ---- helpers exposed to profile code ----------------------------------------

function h1(i: number): number {
  let x = Math.imul(i, 374761393) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return (((x ^ (x >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth deterministic 1-D value noise in [-1, 1]. */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return h1(i) * (1 - u) + h1(i + 1) * u;
}

export interface ProfileApi {
  profile(name: string): ProfileBuilder;
  noise1(x: number): number;
  clamp(v: number, lo: number, hi: number): number;
  lerp(a: number, b: number, t: number): number;
}

export const profileApi: ProfileApi = {
  profile: (name) => new ProfileBuilder(name),
  noise1,
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  lerp: (a, b, t) => a + (b - a) * t,
};
