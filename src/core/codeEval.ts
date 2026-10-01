// Style code (profiles, materials, bridges, water styles) is JavaScript the editor compiles at runtime with `new Function`.
// Hosts that forbid eval (a strict Content-Security-Policy) cannot do that, so factories can also be PRECOMPILED at build time:
// `registerPrecompiled` hands over a table keyed by `argName\nbody`, and `compileFactory` uses it when `new Function` is refused.
// Editing code needs eval; the built-in styles work either way.

export type Factory = (api: never) => unknown;

const precompiled = new Map<string, Factory>();
let recorder: ((arg: string, body: string) => void) | null = null;

export const precompiledKey = (arg: string, body: string): string => `${arg}\n${body}`;

export function registerPrecompiled(table: Record<string, Factory>): void {
  for (const [k, f] of Object.entries(table)) precompiled.set(k, f);
}

/** build tooling: called with every (argName, body) that gets compiled; pass null to stop */
export function recordFactories(cb: ((arg: string, body: string) => void) | null): void {
  recorder = cb;
}

export class EvalBlockedError extends Error {}

export function compileFactory<A>(arg: string, body: string): (api: A) => unknown {
  recorder?.(arg, body);
  try {
    return new Function(arg, body) as (api: A) => unknown;
  } catch (e) {
    const pre = precompiled.get(precompiledKey(arg, body));
    if (pre) return pre as unknown as (api: A) => unknown;
    if (e instanceof EvalError || /unsafe-eval|Content Security Policy/i.test(String((e as Error)?.message))) {
      throw new EvalBlockedError('Code kann hier nicht ausgeführt werden (die Umgebung sperrt eval) – nur die mitgelieferten Stile sind verfügbar.');
    }
    throw e;
  }
}
