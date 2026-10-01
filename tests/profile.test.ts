import { describe, it, expect } from 'vitest';
import { profileApi } from '../src/profile/builder';
import { compileProfileSource, evaluateProfile, resolveParams, ProfileCompileError } from '../src/profile/compile';
import { ProfileLibrary } from '../src/profile/library';
import { PRESET_SOURCES } from '../src/profile/presets';

const R = profileApi;

describe('profile builder', () => {
  it('mirrors a half profile and keeps points ordered left → right', () => {
    const p = R.profile('t').both((h) => h.surface(3, 'a').surface(1, 'b')).finish();
    expect(p.points.map((q) => q.x)).toEqual([-4, -3, 0, 3, 4]);
    expect(p.segments.map((s) => s.material)).toEqual(['b', 'a', 'a', 'b']);
    expect(p.segments.length).toBe(p.points.length - 1);
  });

  it('crown slope falls away from the centre on both sides', () => {
    const p = R.profile('t').both((h) => h.surface(3, 'a', { slope: -0.02 })).finish();
    expect(p.points[0].y).toBeCloseTo(-0.06);
    expect(p.points[1].y).toBe(0);
    expect(p.points[2].y).toBeCloseTo(-0.06);
  });

  it('centre strip sits between the halves', () => {
    const p = R.profile('t').center(1, 'c').both((h) => h.surface(2, 'a')).finish();
    expect(p.points.map((q) => q.x)).toEqual([-2.5, -0.5, 0.5, 2.5]);
    expect(p.segments.map((s) => s.material)).toEqual(['a', 'c', 'a']);
  });

  it('a step creates a vertical face (same x, different y)', () => {
    const p = R.profile('t').both((h) => h.surface(2, 'a').step(0.12, 'curb').surface(1.5, 'walk')).finish();
    const right = p.points.filter((q) => q.x >= 0);
    expect(right[1].x).toBe(right[2].x);
    expect(right[2].y - right[1].y).toBeCloseTo(0.12);
  });

  it('ditch dips and recovers; core vs outer widths separate carriageway from verge', () => {
    const p = R.profile('t').both((h) => h.surface(3, 'a', { kind: 'lane' }).ditch(2, 0.5, 'g')).finish();
    const right = p.points.filter((q) => q.x >= 0);
    expect(right[2].y).toBeCloseTo(-0.5);
    expect(right[3].y).toBeCloseTo(0);
    expect(p.coreHalfWidth).toBe(3);
    expect(p.outerHalfWidth).toBe(5);
  });

  it('rejects empty profiles and non-positive widths', () => {
    expect(() => R.profile('t').finish()).toThrow();
    expect(() => R.profile('t').both((h) => h.surface(0, 'a'))).toThrow();
  });
});

describe('profile compiler', () => {
  it('compiles ES-module style source and applies/clamps params', () => {
    const c = compileProfileSource(`
      export const params = { w: { type: 'float', min: 2, max: 4, default: 3 }, n: { type: 'int', min: 1, max: 4, default: 2 } };
      export default (p, R) => R.profile('X').both(h => h.surface(p.w, 'a'));
    `);
    expect(resolveParams(c.params, { w: 99, n: 2.6 })).toEqual({ w: 4, n: 3 });
    expect(evaluateProfile(c, { w: 3.5 }).coreHalfWidth).toBe(3.5);
  });

  it('reports syntax and runtime errors as ProfileCompileError', () => {
    expect(() => compileProfileSource('export default (p, R) => {')).toThrow(ProfileCompileError);
    expect(() => compileProfileSource('export default 42;')).toThrow(ProfileCompileError);
    const c = compileProfileSource(`export default (p, R) => R.profile('X').both(h => h.surface(-1, 'a'));`);
    expect(() => evaluateProfile(c)).toThrow(ProfileCompileError);
  });

  it('all built-in presets compile and evaluate to sensible cross-sections', () => {
    const lib = new ProfileLibrary();
    for (const name of Object.keys(PRESET_SOURCES)) {
      const p = lib.resolve(name);
      expect(p.segments.length).toBe(p.points.length - 1);
      expect(p.coreHalfWidth).toBeGreaterThan(0.3);
      expect(p.outerHalfWidth).toBeGreaterThanOrEqual(p.coreHalfWidth);
      for (let i = 1; i < p.points.length; i++) expect(p.points[i].x).toBeGreaterThanOrEqual(p.points[i - 1].x - 1e-9);
    }
    expect(lib.resolve('hauptstrasse').coreHalfWidth).toBeCloseTo(3.8); // 3.0 lane + 0.8 shoulder
  });
});

describe('ProfileLibrary', () => {
  it('keeps the last working profile when an edit fails', () => {
    const lib = new ProfileLibrary();
    const before = lib.resolve('flurstrasse').outerHalfWidth;
    const bad = lib.setSource('flurstrasse', 'export default (p, R) => { throw new Error("boom"); }');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/boom/);
    expect(lib.resolve('flurstrasse').outerHalfWidth).toBe(before);
  });

  it('a good edit takes effect, invalidates the cache and notifies listeners', () => {
    const lib = new ProfileLibrary();
    lib.resolve('wanderweg');
    const seen: string[] = [];
    lib.onChange((n) => seen.push(n));
    const ok = lib.setSource('wanderweg', `export default (p, R) => R.profile('W').center(2, 'path_dirt')`);
    expect(ok.ok).toBe(true);
    expect(lib.resolve('wanderweg').coreHalfWidth).toBe(1);
    expect(seen).toEqual(['wanderweg']);
  });

  it('falls back for unknown profiles', () => {
    const lib = new ProfileLibrary();
    expect(lib.resolve('gibtsnicht').name).toBe('Hauptstrasse');
  });

  it('wanderweg varies width and lateral offset along the road deterministically', () => {
    const p = new ProfileLibrary().resolve('wanderweg');
    const a = p.vary!({ s: 10, seed: 1 });
    const b = p.vary!({ s: 90, seed: 1 });
    expect(a.widthMul).not.toBeCloseTo(b.widthMul!, 3);
    expect(p.vary!({ s: 10, seed: 1 })).toEqual(a);
  });
});
