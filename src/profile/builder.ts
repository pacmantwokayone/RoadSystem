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

import { makeGuardrail, makeScatter, type GuardrailOpts, type PropRule, type PropSide, type ScatterOpts } from '../props/rules';
import { ROADWAY_KINDS, type MarkingDef, type ProfileData, ProfilePoint, ProfileSegment, type RailSpec, VaryContext, VaryResult } from './types';

export interface SurfaceOpts {
  /** rise over run going OUTWARD (negative = falls away from the centre) */
  slope?: number;
  kind?: string;
  id?: string;
  /** counts as carriageway footprint; default true except verge/ditch/slope helpers */
  core?: boolean;
  /** centre strip only: raise it above the carriageway (median, kerbed island) */
  y?: number;
}

export type MarkOpts = Partial<Omit<MarkingDef, 'x'>>;

export const MARKING_DEFAULTS: Omit<MarkingDef, 'x'> = {
  width: 0.12, style: 'solid', color: 'white', dash: 3, gap: 9, spacing: 0.25, dashedSide: 'right',
};

const markingOf = (x: number, o: MarkOpts): MarkingDef => ({ ...MARKING_DEFAULTS, ...o, x });

type Element =
  | { type: 'mark'; back: number; opts: MarkOpts }
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

  /** Painted edge line `back` metres inside the outer edge of the last strip (default 0.2). */
  edgeLine(opts: MarkOpts & { back?: number } = {}): this {
    const { back = 0.2, ...rest } = opts;
    this.elements.push({ type: 'mark', back, opts: rest });
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
  /** height of the centre strip relative to the carriageway (a raised median) */
  y: number;
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
  private _marks: MarkingDef[] = [];
  private _props: PropRule[] = [];
  private _rank: number | undefined;
  private _rail: RailSpec | undefined;

  constructor(readonly name: string) {}

  thickness(m: number): this { this._thickness = Math.max(0.05, m); return this; }
  bodyMaterial(name: string): this { this._body = name; return this; }
  smooth(radiusM: number): this { this._smooth = Math.max(0, radiusM); return this; }

  /** Strip centred on the axis (path, median, …). */
  center(width: number, material: string, opts: SurfaceOpts = {}): this {
    checkWidth(width, 'center');
    this._centre = { width, y: opts.y ?? 0, material, kind: opts.kind ?? 'lane', id: opts.id, core: opts.core ?? true };
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

  /** Painted line at an absolute lateral position (profile space, + = right). */
  mark(x: number, opts: MarkOpts = {}): this {
    this._marks.push(markingOf(x, opts));
    return this;
  }

  /** Centre line (default: white dashed). */
  markCenter(opts: MarkOpts = {}): this {
    this._marks.push(markingOf(0, { style: 'dashed', ...opts }));
    return this;
  }

  /** Props along the road: `asset` is a registry name or `sign:<id>[:<text>]`. */
  scatter(asset: string, opts: ScatterOpts = {}): this {
    this._props.push(makeScatter(asset, opts));
    return this;
  }

  /** Street lamps (arm over the road). */
  lamps(opts: ScatterOpts & { asset?: string } = {}): this {
    const { asset = 'lamp', ...rest } = opts;
    return this.scatter(asset, { spacing: 35, offset: 0.9, face: 'road', jitterAlong: 0.8, ...rest });
  }

  /** Guardrail; by default only where the terrain drops away or on the outside of tight bends. */
  guardrail(side: PropSide = 'both', opts: GuardrailOpts = {}): this {
    this._props.push(makeGuardrail(side, opts));
    return this;
  }

  /** How important this road is at junctions (see Junction priority). */
  rank(n: number): this {
    this._rank = n;
    return this;
  }

  /** Makes this a railway profile: one rail pair per entry of `tracks` (lateral centres, default one track on the axis). */
  rail(o: { tracks?: number[]; gauge?: number; sleeperSpacing?: number } = {}): this {
    const tracks = (o.tracks ?? [0]).filter((x) => Number.isFinite(x));
    this._rail = {
      gauge: Math.min(2, Math.max(0.6, o.gauge ?? 1.435)),
      tracks: tracks.length ? tracks : [0],
      sleeperSpacing: Math.min(2, Math.max(0.3, o.sleeperSpacing ?? 0.6)),
      catenary: this._rail?.catenary ?? null,
      signals: this._rail?.signals ?? null,
    };
    return this;
  }

  /** Overhead line (Fahrleitung): masts with cantilevers, messenger and contact wire. Needs `rail()`. */
  catenary(o: { height?: number; spacing?: number } | false = {}): this {
    if (!this._rail) this.rail();
    this._rail!.catenary = o === false ? null : { height: Math.min(8, Math.max(4, o.height ?? 5.5)), spacing: Math.min(80, Math.max(20, o.spacing ?? 56)) };
    return this;
  }

  /** Light signals beside the track. Needs `rail()`. */
  signals(o: { spacing?: number; start?: number } | false = {}): this {
    if (!this._rail) this.rail();
    this._rail!.signals = o === false ? null : { spacing: Math.min(5000, Math.max(60, o.spacing ?? 600)), start: Math.max(0, o.start ?? 40) };
    return this;
  }

  /** Per-sample variation along the road (path wobble, width noise, …). */
  vary(fn: (ctx: VaryContext) => VaryResult): this {
    this._vary = fn;
    return this;
  }

  finish(): ProfileData {
    const bh = this._centre ? this._centre.width / 2 : 0;
    const marks: MarkingDef[] = [...this._marks];
    const baseY = this._centre?.y ?? 0;
    const walk = (els: Element[], sign: 1 | -1): { pts: ProfilePoint[]; segs: ProfileSegment[] } => {
      const pts: ProfilePoint[] = [{ x: sign * bh + 0, y: baseY }]; // `+ 0` turns -0 into 0
      const segs: ProfileSegment[] = [];
      let x = bh;
      let y = baseY;
      for (const e of els) {
        if (e.type === 'mark') {
          const side = e.opts.dashedSide ?? MARKING_DEFAULTS.dashedSide;
          marks.push(markingOf(sign * (x - e.back) + 0, { ...e.opts, dashedSide: sign === 1 ? side : side === 'left' ? 'right' : 'left' }));
          continue;
        }
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
    let carriage = 0;
    segments.forEach((seg, k) => {
      const a = Math.abs(points[k].x);
      const b = Math.abs(points[k + 1].x);
      outer = Math.max(outer, a, b);
      if (seg.core) core = Math.max(core, a, b);
      if (ROADWAY_KINDS.has(seg.kind)) carriage = Math.max(carriage, a, b);
    });

    return {
      name: this.name,
      points,
      segments,
      thickness: this._thickness,
      bodyMaterial: this._body,
      markings: marks,
      props: this._props,
      rank: this._rank ?? Math.round(core * 2),
      smoothRadiusM: this._smooth,
      coreHalfWidth: core,
      carriageHalfWidth: carriage > 0 ? Math.min(carriage, core || carriage) : core,
      outerHalfWidth: outer,
      vary: this._vary,
      ...(this._rail ? { rail: this._rail } : {}),
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
