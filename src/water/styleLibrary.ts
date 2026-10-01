// Water style sources, compiled and cached — same behaviour as the Profile- and BridgeLibrary: a failing edit never
// destroys the last working version, evaluated styles are cached per (name, params) so object identity is stable.

import { compileWaterSource, evaluateWater, WaterCompileError, DEFAULT_WATER_STYLE, type CompiledWater, type WaterStyle } from './style';
import { WATER_PRESET_SOURCES } from './presets';
import { resolveParams } from '../profile/compile';
import type { ParamSchema, ParamValues } from '../profile/types';
import type { LakeDef, RiverDef } from './types';

export interface SetWaterResult {
  ok: boolean;
  error?: string;
}

export class WaterLibrary {
  private sources = new Map<string, string>();
  private compiled = new Map<string, CompiledWater>();
  private cache = new Map<string, WaterStyle>();
  private listeners = new Set<(name: string) => void>();
  fallbackRiver = 'bach';
  fallbackLake = 'bergsee';

  constructor(sources: Record<string, string> = WATER_PRESET_SOURCES) {
    for (const [name, src] of Object.entries(sources)) {
      const r = this.setSource(name, src);
      if (!r.ok) throw new Error(`built-in water style '${name}' failed to compile: ${r.error}`);
    }
  }

  names(): string[] { return [...this.compiled.keys()]; }
  has(name: string): boolean { return this.compiled.has(name); }
  getSource(name: string): string | undefined { return this.sources.get(name); }
  allSources(): Record<string, string> { return Object.fromEntries(this.sources); }
  getSchema(name: string): ParamSchema { return this.compiled.get(name)?.params ?? {}; }
  defaultParams(name: string): ParamValues { return resolveParams(this.getSchema(name)); }

  /** Names of the styles of one kind (river / lake), for pickers. */
  namesOf(kind: 'river' | 'lake'): string[] {
    return this.names().filter((n) => this.resolve(n).kind === kind);
  }

  remove(name: string): void {
    if (name === this.fallbackRiver || name === this.fallbackLake) return;
    this.sources.delete(name);
    this.compiled.delete(name);
    for (const k of [...this.cache.keys()]) if (k.startsWith(name + '|')) this.cache.delete(k);
    for (const cb of this.listeners) cb(name);
  }

  setSource(name: string, source: string): SetWaterResult {
    try {
      const compiled = compileWaterSource(source);
      evaluateWater(compiled);
      this.sources.set(name, source);
      this.compiled.set(name, compiled);
      for (const k of [...this.cache.keys()]) if (k.startsWith(name + '|')) this.cache.delete(k);
      for (const cb of this.listeners) cb(name);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof WaterCompileError ? e.message : String(e) };
    }
  }

  onChange(cb: (name: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  resolve(name: string, overrides: ParamValues = {}): WaterStyle {
    let n = name;
    if (!this.compiled.has(n)) n = this.compiled.has(this.fallbackRiver) ? this.fallbackRiver : '';
    const compiled = this.compiled.get(n);
    if (!compiled) return DEFAULT_WATER_STYLE;
    const key = `${n}|${JSON.stringify(resolveParams(compiled.params, overrides))}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = evaluateWater(compiled, overrides);
      this.cache.set(key, hit);
    }
    return hit;
  }

  forRiver(def: RiverDef): WaterStyle {
    const s = this.resolve(this.has(def.style) ? def.style : this.fallbackRiver, def.params ?? {});
    return s;
  }

  forLake(def: LakeDef): WaterStyle {
    return this.resolve(this.has(def.style) ? def.style : this.fallbackLake, def.params ?? {});
  }
}
