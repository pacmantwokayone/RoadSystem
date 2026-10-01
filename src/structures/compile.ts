// Bridge source code → bridge. Same contract as profile code (see profile/compile.ts): an ES-module-looking source,
// evaluated with `new Function`, with the `B` API injected. Executable code: only trusted editors may write it.

import { compileFactory } from '../core/codeEval';
import { bridgeApi, BridgeBuilder, type BridgeApi } from './builder';
import { resolveParams } from '../profile/compile';
import type { ParamSchema, ParamValues } from '../profile/types';
import type { BridgeData } from './types';

export class BridgeCompileError extends Error {}

export interface CompiledBridge {
  params: ParamSchema;
  build: (p: ParamValues, B: BridgeApi) => unknown;
}

export function compileBridgeSource(source: string): CompiledBridge {
  const code = source
    .replace(/export\s+const\s+params\b/, 'const params')
    .replace(/export\s+default\b/, '__bridge =');
  let factory: (B: BridgeApi) => CompiledBridge;
  try {
    factory = compileFactory<BridgeApi>('B', `"use strict"; let __bridge;\n${code}\n;return { params: typeof params !== 'undefined' ? params : {}, build: __bridge };`) as typeof factory;
  } catch (e) {
    throw new BridgeCompileError(`Syntax error: ${(e as Error).message}`);
  }
  let out: CompiledBridge;
  try {
    out = factory(bridgeApi);
  } catch (e) {
    throw new BridgeCompileError(`Error while evaluating bridge: ${(e as Error).message}`);
  }
  if (typeof out.build !== 'function') throw new BridgeCompileError('Bridge must `export default (p, B) => B.bridge(…)…`');
  return out;
}

export function evaluateBridge(compiled: CompiledBridge, overrides: ParamValues = {}): BridgeData {
  const p = resolveParams(compiled.params, overrides);
  let result: unknown;
  try {
    result = compiled.build(p, bridgeApi);
  } catch (e) {
    throw new BridgeCompileError(`Error in bridge: ${(e as Error).message}`);
  }
  if (!(result instanceof BridgeBuilder)) throw new BridgeCompileError('Bridge must return B.bridge(…)');
  return result.finish();
}
