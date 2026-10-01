// Materials as CODE, like profiles: a short source text evaluates to a MaterialDef, so a look can be tuned
// live in the editor and saved with the library. Defaults are generated from DEFAULT_MATERIAL_DEFS.
//
//   export default (M) => M.asphalt({ color: 0x4d4f54, noise: 0.5, tracks: 0.8, cracks: 0.5 });
//
// `M.<kind>(opts)` for every surface kind (asphalt, gravel, dirt, grass, cobble, concrete, wood, stone, paint, flat),
// plus helpers `M.mix(a, b, t)`, `M.shade(hex, factor)`, `M.rgb(r, g, b)` and `M.texture(url)` to swap in a real
// texture later. Like profiles, material sources are executable code: only trusted editors may write them.

import * as THREE from 'three';
import { DEFAULT_MATERIAL_DEFS, type MaterialDef } from './materials';
import { SURFACE_KINDS, type SurfaceKind } from './surfaceShader';

export class MaterialCompileError extends Error {}

export type MaterialOpts = Partial<Omit<MaterialDef, 'kind'>>;

export interface MaterialApi {
  asphalt(o?: MaterialOpts): MaterialDef;
  gravel(o?: MaterialOpts): MaterialDef;
  dirt(o?: MaterialOpts): MaterialDef;
  grass(o?: MaterialOpts): MaterialDef;
  cobble(o?: MaterialOpts): MaterialDef;
  concrete(o?: MaterialOpts): MaterialDef;
  wood(o?: MaterialOpts): MaterialDef;
  stone(o?: MaterialOpts): MaterialDef;
  paint(o?: MaterialOpts): MaterialDef;
  flat(o?: MaterialOpts): MaterialDef;
  mix(a: number, b: number, t: number): number;
  shade(hex: number, factor: number): number;
  rgb(r: number, g: number, b: number): number;
  texture(url: string): THREE.Texture;
}

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const color = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(0xffffff, Math.round(v))) : d);

/** Validate / clamp whatever the code returned, so a typo can never produce a broken shader. */
export function normalizeMaterialDef(kind: SurfaceKind, o: MaterialOpts): MaterialDef {
  const def: MaterialDef = {
    kind,
    color: color(o.color, 0x808080),
    tileM: clamp(o.tileM, 0.02, 50, 1),
    noise: clamp(o.noise, 0, 1, 0.5),
  };
  if (o.color2 !== undefined) def.color2 = color(o.color2, def.color);
  for (const k of ['tracks', 'cracks', 'patches', 'edgeDirt', 'wornPaint'] as const) {
    if (o[k] !== undefined) def[k] = clamp(o[k], 0, 1, 0);
  }
  if (o.trackOffset !== undefined) def.trackOffset = clamp(o.trackOffset, 0.1, 3, 0.85);
  if (o.map instanceof THREE.Texture) def.map = o.map;
  return def;
}

export const materialApi: MaterialApi = (() => {
  const api = {} as Record<string, unknown>;
  for (const kind of SURFACE_KINDS) api[kind] = (o: MaterialOpts = {}): MaterialDef => normalizeMaterialDef(kind, o);
  const split = (h: number): [number, number, number] => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
  const join = (r: number, g: number, b: number): number => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  return Object.assign(api, {
    rgb: (r: number, g: number, b: number): number => join(Math.min(255, Math.max(0, r)), Math.min(255, Math.max(0, g)), Math.min(255, Math.max(0, b))),
    mix: (a: number, b: number, t: number): number => {
      const [ar, ag, ab] = split(a), [br, bg, bb] = split(b);
      const k = Math.min(1, Math.max(0, t));
      return join(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k);
    },
    shade: (h: number, f: number): number => { const [r, g, b] = split(h); return join(Math.min(255, r * f), Math.min(255, g * f), Math.min(255, b * f)); },
    texture: (url: string): THREE.Texture => {
      const tex = typeof document !== 'undefined' ? new THREE.TextureLoader().load(url) : new THREE.Texture();
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    },
  }) as unknown as MaterialApi;
})();

export function compileMaterialSource(source: string): () => MaterialDef {
  const code = source.replace(/export\s+default\b/, '__material =');
  let factory: (M: MaterialApi) => (M: MaterialApi) => unknown;
  try {
    factory = new Function('M', `"use strict"; let __material;\n${code}\n;return __material;`) as typeof factory;
  } catch (e) {
    throw new MaterialCompileError(`Syntax error: ${(e as Error).message}`);
  }
  let build: unknown;
  try {
    build = factory(materialApi);
  } catch (e) {
    throw new MaterialCompileError(`Error while evaluating material: ${(e as Error).message}`);
  }
  if (typeof build !== 'function') throw new MaterialCompileError('Material must `export default (M) => M.asphalt({ … })`');
  return () => {
    let r: unknown;
    try { r = (build as (M: MaterialApi) => unknown)(materialApi); } catch (e) { throw new MaterialCompileError(`Error in material: ${(e as Error).message}`); }
    if (typeof r !== 'object' || r === null || !('kind' in r) || !SURFACE_KINDS.includes((r as MaterialDef).kind)) {
      throw new MaterialCompileError('Material must return M.<kind>({ … }), e.g. M.asphalt({ color: 0x555555 })');
    }
    return r as MaterialDef;
  };
}

const hex = (n: number): string => '0x' + n.toString(16).padStart(6, '0');

/** Default source text for a material definition. */
export function sourceFromDef(def: MaterialDef): string {
  const parts: string[] = [`color: ${hex(def.color)}`];
  if (def.color2 !== undefined) parts.push(`color2: ${hex(def.color2)}`);
  parts.push(`tileM: ${def.tileM}`, `noise: ${def.noise}`);
  for (const k of ['tracks', 'trackOffset', 'cracks', 'patches', 'edgeDirt', 'wornPaint'] as const) {
    if (def[k] !== undefined) parts.push(`${k}: ${def[k]}`);
  }
  return `// ${def.kind}: see M.${def.kind}(…) options — color, color2, tileM, noise, tracks, cracks, patches, edgeDirt, wornPaint\nexport default (M) => M.${def.kind}({\n  ${parts.join(',\n  ')},\n});\n`;
}

export const DEFAULT_MATERIAL_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(DEFAULT_MATERIAL_DEFS).map(([n, d]) => [n, sourceFromDef(d)]),
);

export interface SetMaterialResult {
  ok: boolean;
  error?: string;
}

export class MaterialLibrary {
  private sources = new Map<string, string>();
  private defs = new Map<string, MaterialDef>();
  private listeners = new Set<(name: string, def: MaterialDef | null) => void>();

  constructor(sources: Record<string, string> = DEFAULT_MATERIAL_SOURCES) {
    for (const [name, src] of Object.entries(sources)) {
      const r = this.setSource(name, src);
      if (!r.ok) throw new Error(`built-in material '${name}' failed to compile: ${r.error}`);
    }
  }

  names(): string[] { return [...this.defs.keys()]; }
  has(name: string): boolean { return this.defs.has(name); }
  getSource(name: string): string | undefined { return this.sources.get(name); }
  getDef(name: string): MaterialDef | undefined { return this.defs.get(name); }
  allSources(): Record<string, string> { return Object.fromEntries(this.sources); }
  allDefs(): Record<string, MaterialDef> { return Object.fromEntries(this.defs); }

  /** Compile & store. On error the previous version stays active. */
  setSource(name: string, source: string): SetMaterialResult {
    try {
      const def = compileMaterialSource(source)();
      this.sources.set(name, source);
      this.defs.set(name, def);
      for (const cb of this.listeners) cb(name, def);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof MaterialCompileError ? e.message : String(e) };
    }
  }

  remove(name: string): void {
    this.sources.delete(name);
    this.defs.delete(name);
    for (const cb of this.listeners) cb(name, null);
  }

  onChange(cb: (name: string, def: MaterialDef | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
