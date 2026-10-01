// Holds profile sources, compiles them, and hands out evaluated profiles.
// A failing edit never destroys the last working version of a profile.

import { compileProfileSource, evaluateProfile, resolveParams, ProfileCompileError, type CompiledProfile } from './compile';
import { PRESET_SOURCES } from './presets';
import type { ParamSchema, ParamValues, ProfileData } from './types';

export interface SetSourceResult {
  ok: boolean;
  error?: string;
}

export class ProfileLibrary {
  private sources = new Map<string, string>();
  private compiled = new Map<string, CompiledProfile>();
  private cache = new Map<string, ProfileData>();
  private listeners = new Set<(name: string) => void>();
  /** profile used when a road references an unknown/broken profile */
  fallback = 'hauptstrasse';

  constructor(sources: Record<string, string> = PRESET_SOURCES) {
    for (const [name, src] of Object.entries(sources)) {
      const r = this.setSource(name, src);
      if (!r.ok) throw new Error(`built-in profile '${name}' failed to compile: ${r.error}`);
    }
  }

  names(): string[] {
    return [...this.compiled.keys()];
  }

  has(name: string): boolean {
    return this.compiled.has(name);
  }

  /** All sources by name (what gets persisted). */
  allSources(): Record<string, string> {
    return Object.fromEntries(this.sources);
  }

  remove(name: string): void {
    if (name === this.fallback) return;
    this.sources.delete(name);
    this.compiled.delete(name);
    for (const k of [...this.cache.keys()]) if (k.startsWith(name + '|')) this.cache.delete(k);
    for (const cb of this.listeners) cb(name);
  }

  getSource(name: string): string | undefined {
    return this.sources.get(name);
  }

  getSchema(name: string): ParamSchema {
    return this.compiled.get(name)?.params ?? {};
  }

  defaultParams(name: string): ParamValues {
    return resolveParams(this.getSchema(name));
  }

  /** Compile & store. On error the previous version stays active. */
  setSource(name: string, source: string): SetSourceResult {
    try {
      const compiled = compileProfileSource(source);
      evaluateProfile(compiled); // smoke test with default params
      this.sources.set(name, source);
      this.compiled.set(name, compiled);
      for (const k of [...this.cache.keys()]) if (k.startsWith(name + '|')) this.cache.delete(k);
      for (const cb of this.listeners) cb(name);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof ProfileCompileError ? e.message : String(e) };
    }
  }

  onChange(cb: (name: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  resolve(name: string, overrides: ParamValues = {}): ProfileData {
    let n = name;
    if (!this.compiled.has(n)) {
      console.warn(`[roadsystem] unknown profile '${name}', using '${this.fallback}'`);
      n = this.fallback;
    }
    const compiled = this.compiled.get(n)!;
    const key = `${n}|${JSON.stringify(resolveParams(compiled.params, overrides))}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = evaluateProfile(compiled, overrides);
      this.cache.set(key, hit);
    }
    return hit;
  }
}
