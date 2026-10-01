// Water styles as CODE (like profiles, materials and bridges): what a river or lake looks like and how it behaves.
//
//   export const params = { width: { type: 'float', min: 1, max: 12, default: 3 } };
//   export default (p, W) => W.river('Bergbach')
//     .size(p.width, 0.6)
//     .colors({ shallow: 0x8fd0c8, deep: 0x2f7c86 })
//     .flow({ speed: 1.8, turbulence: 0.4 })
//     .banks({ width: 3, slope: 0.6, material: 'gravel' })
//     .rocks({ density: 14, min: 0.3, max: 1.2 })
//     .foam({ edge: 0.6, obstacles: 0.9 });
//
// Every option is validated and clamped in `finish()`.

import { resolveParams } from '../profile/compile';
import type { ParamSchema, ParamValues } from '../profile/types';

export type WaterKind = 'river' | 'lake';

export interface WaterColors {
  /** colour of shallow water (over the bed) */
  shallow: number;
  /** colour of deep water */
  deep: number;
  foam: number;
  /** tint of the sky seen in the surface */
  sky: number;
}

export interface BanksSpec {
  /** width of the bank ramp beyond the water's edge, metres */
  width: number;
  /** rise per metre of run of the bank ramp (0.2 = gentle, 1.5 = steep) */
  slope: number;
  /** road/surface material name of the wet bank strip (see the material library) */
  material: string;
  /** width of the pebble strip along the water's edge, metres */
  strip: number;
}

export interface FlowSpec {
  /** surface speed at a gentle slope, m/s */
  speed: number;
  /** 0..1 strength of the small ripples */
  ripple: number;
  /** 0..1 how churned the water is in general (white flecks everywhere) */
  turbulence: number;
  /** 0..1 long streaks that show the direction of the flow */
  streaks: number;
}

export interface FoamSpec {
  /** foam along shores / banks */
  edge: number;
  /** foam around and behind rocks, piers and anything else that sticks out */
  obstacles: number;
  /** white water on rapids */
  rapids: number;
  /** foam where the water leaves and lands in a waterfall */
  fall: number;
}

export interface RocksSpec {
  /** rocks per 100 m of river (lake: of shoreline) */
  density: number;
  min: number;
  max: number;
  /** 0..1 share of the rocks standing in the water (the rest lie on the banks) */
  inWater: number;
  color: number;
}

export interface ParticlesSpec {
  /** floating flecks per 100 m² of water, drifting with the current */
  flecks: number;
  size: number;
  /** 0..1 spray where water crashes (rapids, falls, rocks) */
  spray: number;
  /** 0..1 mist at the foot of waterfalls */
  mist: number;
}

export interface FallSpec {
  /** how much the sheet widens while falling (1 = 2× at the bottom) */
  spread: number;
  /** depth of the plunge pool, metres */
  poolDepth: number;
  /** radius of the plunge pool as a multiple of the fall's width */
  poolRadius: number;
  /** 0..1 how strongly the sheet is streaked / white */
  streak: number;
  /** steepness of the gorge walls beside a fall (rise per metre) */
  wallSlope: number;
}

export interface WavesSpec {
  /** wave height, metres */
  height: number;
  /** wavelength scale, metres */
  scale: number;
  speed: number;
}

export interface WaterStyle {
  name: string;
  kind: WaterKind;
  /** default surface width of a river, metres */
  width: number;
  /** default depth in the middle, metres */
  depth: number;
  colors: WaterColors;
  /** 0..1 how clear the water is (clear water shows the bed further out) */
  clarity: number;
  banks: BanksSpec;
  flow: FlowSpec;
  foam: FoamSpec;
  rocks: RocksSpec;
  particles: ParticlesSpec;
  fall: FallSpec;
  waves: WavesSpec;
}

const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const col = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(0xffffff, Math.round(v))) : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' && v ? v : d);

export const DEFAULT_WATER_STYLE: WaterStyle = {
  name: 'Standard', kind: 'river', width: 4, depth: 0.7,
  colors: { shallow: 0x8fd0c8, deep: 0x2f7c86, foam: 0xf4f8fa, sky: 0xbcd6ea },
  clarity: 0.7,
  banks: { width: 3, slope: 0.6, material: 'gravel', strip: 0.8 },
  flow: { speed: 1.6, ripple: 0.6, turbulence: 0.3, streaks: 0.5 },
  foam: { edge: 0.6, obstacles: 0.9, rapids: 0.8, fall: 1 },
  rocks: { density: 10, min: 0.25, max: 1.1, inWater: 0.45, color: 0x8b8a84 },
  particles: { flecks: 1, size: 0.12, spray: 0.6, mist: 0.6 },
  fall: { spread: 0.5, poolDepth: 3, poolRadius: 0.9, streak: 0.8, wallSlope: 1.6 },
  waves: { height: 0.05, scale: 8, speed: 0.6 },
};

export class WaterBuilder {
  private s: WaterStyle;

  constructor(readonly name: string, kind: WaterKind) {
    this.s = structuredClone(DEFAULT_WATER_STYLE);
    this.s.name = name;
    this.s.kind = kind;
    if (kind === 'lake') {
      this.s.depth = 6;
      this.s.flow = { speed: 0, ripple: 0.25, turbulence: 0, streaks: 0 };
      this.s.banks = { width: 6, slope: 0.35, material: 'gravel_fine', strip: 1.5 };
      this.s.rocks = { density: 6, min: 0.3, max: 1.4, inWater: 0.3, color: 0x8b8a84 };
      this.s.particles = { flecks: 0.2, size: 0.1, spray: 0.1, mist: 0.1 };
      this.s.colors = { shallow: 0x7fe0d8, deep: 0x0f4f6b, foam: 0xf4f8fa, sky: 0xbcd6ea };
    }
  }

  /** Default river width and depth (a lake: its depth). */
  size(width: number, depth: number): this {
    this.s.width = num(width, 0.3, 300, this.s.width);
    this.s.depth = num(depth, 0.1, 100, this.s.depth);
    return this;
  }

  colors(o: Partial<WaterColors> = {}): this {
    const c = this.s.colors;
    this.s.colors = { shallow: col(o.shallow, c.shallow), deep: col(o.deep, c.deep), foam: col(o.foam, c.foam), sky: col(o.sky, c.sky) };
    return this;
  }

  clarity(v: number): this {
    this.s.clarity = num(v, 0, 1, this.s.clarity);
    return this;
  }

  banks(o: Partial<BanksSpec> = {}): this {
    const b = this.s.banks;
    this.s.banks = { width: num(o.width, 0.5, 60, b.width), slope: num(o.slope, 0.05, 3, b.slope), material: str(o.material, b.material), strip: num(o.strip, 0, 20, b.strip) };
    return this;
  }

  flow(o: Partial<FlowSpec> = {}): this {
    const f = this.s.flow;
    this.s.flow = { speed: num(o.speed, 0, 15, f.speed), ripple: num(o.ripple, 0, 1, f.ripple), turbulence: num(o.turbulence, 0, 1, f.turbulence), streaks: num(o.streaks, 0, 1, f.streaks) };
    return this;
  }

  foam(o: Partial<FoamSpec> = {}): this {
    const f = this.s.foam;
    this.s.foam = { edge: num(o.edge, 0, 1, f.edge), obstacles: num(o.obstacles, 0, 1, f.obstacles), rapids: num(o.rapids, 0, 1, f.rapids), fall: num(o.fall, 0, 1, f.fall) };
    return this;
  }

  rocks(o: Partial<RocksSpec> = {}): this {
    const r = this.s.rocks;
    const min = num(o.min, 0.05, 6, r.min);
    this.s.rocks = { density: num(o.density, 0, 80, r.density), min, max: Math.max(min, num(o.max, 0.05, 10, r.max)), inWater: num(o.inWater, 0, 1, r.inWater), color: col(o.color, r.color) };
    return this;
  }

  particles(o: Partial<ParticlesSpec> = {}): this {
    const p = this.s.particles;
    this.s.particles = { flecks: num(o.flecks, 0, 6, p.flecks), size: num(o.size, 0.03, 1, p.size), spray: num(o.spray, 0, 1, p.spray), mist: num(o.mist, 0, 1, p.mist) };
    return this;
  }

  fall(o: Partial<FallSpec> = {}): this {
    const f = this.s.fall;
    this.s.fall = { spread: num(o.spread, 0, 3, f.spread), poolDepth: num(o.poolDepth, 0.3, 40, f.poolDepth), poolRadius: num(o.poolRadius, 0.3, 4, f.poolRadius), streak: num(o.streak, 0, 1, f.streak), wallSlope: num(o.wallSlope, 0.3, 5, f.wallSlope) };
    return this;
  }

  /** Lakes: wave height (m), wavelength scale (m) and speed. */
  waves(o: Partial<WavesSpec> = {}): this {
    const w = this.s.waves;
    this.s.waves = { height: num(o.height, 0, 2, w.height), scale: num(o.scale, 1, 80, w.scale), speed: num(o.speed, 0, 5, w.speed) };
    return this;
  }

  finish(): WaterStyle {
    return this.s;
  }
}

export interface WaterApi {
  river(name: string): WaterBuilder;
  lake(name: string): WaterBuilder;
  clamp(v: number, lo: number, hi: number): number;
  lerp(a: number, b: number, t: number): number;
  mix(a: number, b: number, t: number): number;
  rgb(r: number, g: number, b: number): number;
}

const split = (h: number): [number, number, number] => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const join = (r: number, g: number, b: number): number => (Math.round(Math.min(255, Math.max(0, r))) << 16) | (Math.round(Math.min(255, Math.max(0, g))) << 8) | Math.round(Math.min(255, Math.max(0, b)));

export const waterApi: WaterApi = {
  river: (name) => new WaterBuilder(name, 'river'),
  lake: (name) => new WaterBuilder(name, 'lake'),
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  lerp: (a, b, t) => a + (b - a) * t,
  mix: (a, b, t) => { const [ar, ag, ab] = split(a), [br, bg, bb] = split(b); const k = Math.min(1, Math.max(0, t)); return join(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k); },
  rgb: join,
};

// ---- compile -----------------------------------------------------------------------------------

export class WaterCompileError extends Error {}

export interface CompiledWater {
  params: ParamSchema;
  build: (p: ParamValues, W: WaterApi) => unknown;
}

export function compileWaterSource(source: string): CompiledWater {
  const code = source.replace(/export\s+const\s+params\b/, 'const params').replace(/export\s+default\b/, '__water =');
  let factory: (W: WaterApi) => CompiledWater;
  try {
    factory = new Function('W', `"use strict"; let __water;\n${code}\n;return { params: typeof params !== 'undefined' ? params : {}, build: __water };`) as typeof factory;
  } catch (e) {
    throw new WaterCompileError(`Syntax error: ${(e as Error).message}`);
  }
  let out: CompiledWater;
  try {
    out = factory(waterApi);
  } catch (e) {
    throw new WaterCompileError(`Error while evaluating water style: ${(e as Error).message}`);
  }
  if (typeof out.build !== 'function') throw new WaterCompileError('Water style must `export default (p, W) => W.river(…)…`');
  return out;
}

export function evaluateWater(compiled: CompiledWater, overrides: ParamValues = {}): WaterStyle {
  const p = resolveParams(compiled.params, overrides);
  let result: unknown;
  try {
    result = compiled.build(p, waterApi);
  } catch (e) {
    throw new WaterCompileError(`Error in water style: ${(e as Error).message}`);
  }
  if (!(result instanceof WaterBuilder)) throw new WaterCompileError('Water style must return W.river(…) or W.lake(…)');
  return result.finish();
}
