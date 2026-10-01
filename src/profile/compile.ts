// Profile source code → profile. A profile source looks like an ES module:
//
//   export const params = { laneWidth: { type: 'float', min: 2.5, max: 4, default: 3 } };
//   export default (p, R) => R.profile('X').both(h => h.surface(p.laneWidth, 'asphalt'));
//
// It is evaluated with `new Function` (R injected). That is arbitrary code
// execution by design: only authenticated editors may write profile sources
// (see docs/PLAN.md §2a Sicherheit); a release build should ship baked data.

import { profileApi, ProfileBuilder, type ProfileApi } from './builder';
import type { ParamDef, ParamSchema, ParamValues, ProfileData } from './types';

export class ProfileCompileError extends Error {}

export interface CompiledProfile {
  params: ParamSchema;
  build: (p: ParamValues, R: ProfileApi) => unknown;
}

export function compileProfileSource(source: string): CompiledProfile {
  const code = source
    .replace(/export\s+const\s+params\b/, 'const params')
    .replace(/export\s+default\b/, '__profile =');
  let factory: (R: ProfileApi) => CompiledProfile;
  try {
    factory = new Function(
      'R',
      `"use strict"; let __profile;\n${code}\n;return { params: typeof params !== 'undefined' ? params : {}, build: __profile };`,
    ) as (R: ProfileApi) => CompiledProfile;
  } catch (e) {
    throw new ProfileCompileError(`Syntax error: ${(e as Error).message}`);
  }
  let out: CompiledProfile;
  try {
    out = factory(profileApi);
  } catch (e) {
    throw new ProfileCompileError(`Error while evaluating profile: ${(e as Error).message}`);
  }
  if (typeof out.build !== 'function') throw new ProfileCompileError('Profile must `export default (p, R) => R.profile(...)…`');
  return out;
}

function coerce(def: ParamDef, raw: unknown): number | boolean | string {
  switch (def.type) {
    case 'bool':
      return typeof raw === 'boolean' ? raw : Boolean(def.default);
    case 'enum':
      return typeof raw === 'string' && def.options?.includes(raw) ? raw : (def.default as string);
    case 'int':
    case 'float': {
      let v = typeof raw === 'number' && Number.isFinite(raw) ? raw : (def.default as number);
      if (def.min !== undefined) v = Math.max(def.min, v);
      if (def.max !== undefined) v = Math.min(def.max, v);
      return def.type === 'int' ? Math.round(v) : v;
    }
  }
}

/** Fill defaults, clamp to min/max, round ints; unknown overrides are dropped. */
export function resolveParams(schema: ParamSchema, overrides: ParamValues = {}): ParamValues {
  const out: ParamValues = {};
  for (const [name, def] of Object.entries(schema)) out[name] = coerce(def, overrides[name]);
  return out;
}

export function evaluateProfile(compiled: CompiledProfile, overrides: ParamValues = {}): ProfileData {
  const p = resolveParams(compiled.params, overrides);
  let result: unknown;
  try {
    result = compiled.build(p, profileApi);
  } catch (e) {
    throw new ProfileCompileError(`Error in profile: ${(e as Error).message}`);
  }
  if (!(result instanceof ProfileBuilder)) throw new ProfileCompileError('Profile must return R.profile(...)');
  try {
    return result.finish();
  } catch (e) {
    throw new ProfileCompileError((e as Error).message);
  }
}
