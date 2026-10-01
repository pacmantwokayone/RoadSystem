// Bridge sources, compiled and cached — same behaviour as the ProfileLibrary: a failing edit never destroys the
// last working version, evaluated bridges are cached per (name, params) so object identity is stable (the road
// system uses it to see what changed).

import { BridgeCompileError, compileBridgeSource, evaluateBridge, type CompiledBridge } from './compile';
import { BRIDGE_PRESET_SOURCES } from './presets';
import { defaultBridgeName, DEFAULT_BRIDGE, type BridgeData } from './types';
import { resolveParams } from '../profile/compile';
import type { ParamSchema, ParamValues, ProfileData } from '../profile/types';
import type { RoadDef } from '../network/types';

export interface SetBridgeResult {
  ok: boolean;
  error?: string;
}

export class BridgeLibrary {
  private sources = new Map<string, string>();
  private compiled = new Map<string, CompiledBridge>();
  private cache = new Map<string, BridgeData>();
  private listeners = new Set<(name: string) => void>();
  /** used when a road names an unknown / broken bridge */
  fallback = 'balkenbruecke';

  constructor(sources: Record<string, string> = BRIDGE_PRESET_SOURCES) {
    for (const [name, src] of Object.entries(sources)) {
      const r = this.setSource(name, src);
      if (!r.ok) throw new Error(`built-in bridge '${name}' failed to compile: ${r.error}`);
    }
  }

  names(): string[] { return [...this.compiled.keys()]; }
  has(name: string): boolean { return this.compiled.has(name); }
  getSource(name: string): string | undefined { return this.sources.get(name); }
  allSources(): Record<string, string> { return Object.fromEntries(this.sources); }
  getSchema(name: string): ParamSchema { return this.compiled.get(name)?.params ?? {}; }
  defaultParams(name: string): ParamValues { return resolveParams(this.getSchema(name)); }

  remove(name: string): void {
    if (name === this.fallback) return;
    this.sources.delete(name);
    this.compiled.delete(name);
    for (const k of [...this.cache.keys()]) if (k.startsWith(name + '|')) this.cache.delete(k);
    for (const cb of this.listeners) cb(name);
  }

  /** Compile & store. On error the previous version stays active. */
  setSource(name: string, source: string): SetBridgeResult {
    try {
      const compiled = compileBridgeSource(source);
      evaluateBridge(compiled); // smoke test with default params
      this.sources.set(name, source);
      this.compiled.set(name, compiled);
      for (const k of [...this.cache.keys()]) if (k.startsWith(name + '|')) this.cache.delete(k);
      for (const cb of this.listeners) cb(name);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof BridgeCompileError ? e.message : String(e) };
    }
  }

  onChange(cb: (name: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  resolve(name: string, overrides: ParamValues = {}): BridgeData {
    let n = name;
    if (!this.compiled.has(n)) n = this.compiled.has(this.fallback) ? this.fallback : '';
    const compiled = this.compiled.get(n);
    if (!compiled) return DEFAULT_BRIDGE;
    const key = `${n}|${JSON.stringify(resolveParams(compiled.params, overrides))}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = evaluateBridge(compiled, overrides);
      this.cache.set(key, hit);
    }
    return hit;
  }

  /** The bridge a road uses for its bridge sections: the one it names, else one that fits its profile. */
  forRoad(def: RoadDef, profile: ProfileData): BridgeData {
    return this.resolve(def.bridge ?? defaultBridgeName(profile), def.bridgeParams ?? {});
  }
}
