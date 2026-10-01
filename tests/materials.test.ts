import { describe, it, expect } from 'vitest';
import { MaterialLibrary, compileMaterialSource, sourceFromDef, normalizeMaterialDef, materialApi, DEFAULT_MATERIAL_SOURCES, MaterialCompileError } from '../src/surface/materialLibrary';
import { MaterialRegistry, DEFAULT_MATERIAL_DEFS } from '../src/surface/materials';
import { SURFACE_KINDS } from '../src/surface/surfaceShader';
import { PRESET_SOURCES } from '../src/profile/presets';
import { ProfileLibrary } from '../src/profile/library';
import { sanitizeLibraryDocument } from '../src/store/types';

describe('material code', () => {
  it('compiles M.<kind>({…}) and clamps nonsense values so the shader can never get garbage', () => {
    const def = compileMaterialSource('export default (M) => M.asphalt({ color: 0x123456, noise: 9, tileM: -3, tracks: 2 })')();
    expect(def).toMatchObject({ kind: 'asphalt', color: 0x123456, noise: 1, tracks: 1 });
    expect(def.tileM).toBeGreaterThan(0);
    expect(normalizeMaterialDef('gravel', { color: NaN as unknown as number }).color).toBe(0x808080);
  });

  it('colour helpers', () => {
    expect(materialApi.mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(materialApi.shade(0x808080, 0.5)).toBe(0x404040);
    expect(materialApi.rgb(255, 0, 128)).toBe(0xff0080);
    expect(materialApi.mix(0x102030, 0x405060, 0)).toBe(0x102030);
  });

  it('reports syntax and runtime errors, and non-material return values', () => {
    expect(() => compileMaterialSource('export default (M) => {')).toThrow(MaterialCompileError);
    expect(() => compileMaterialSource('export default 42')).toThrow(MaterialCompileError);
    expect(() => compileMaterialSource('export default (M) => M.nope({})')()).toThrow(MaterialCompileError);
    expect(() => compileMaterialSource('export default (M) => ({ color: 1 })')()).toThrow(MaterialCompileError);
  });

  it('every built-in material round-trips through its generated source', () => {
    for (const [name, def] of Object.entries(DEFAULT_MATERIAL_DEFS)) {
      const back = compileMaterialSource(DEFAULT_MATERIAL_SOURCES[name])();
      expect(back, name).toMatchObject({ kind: def.kind, color: def.color, tileM: def.tileM, noise: def.noise });
      expect(sourceFromDef(def)).toBe(DEFAULT_MATERIAL_SOURCES[name]);
    }
  });

  it('every kind has a defined shader branch and at least one default material', () => {
    for (const k of SURFACE_KINDS) if (k !== 'flat') expect(Object.values(DEFAULT_MATERIAL_DEFS).some((d) => d.kind === k), k).toBe(true);
  });

  it('every material a preset profile references exists', () => {
    const lib = new ProfileLibrary();
    const known = new Set(Object.keys(DEFAULT_MATERIAL_DEFS));
    for (const name of Object.keys(PRESET_SOURCES)) {
      const schema = lib.getSchema(name);
      const variants: Array<Record<string, number | boolean | string>> = [{}, {}];
      for (const [k, d] of Object.entries(schema)) if (d.type === 'bool') variants[1][k] = !d.default;
      for (const v of variants) {
        const p = lib.resolve(name, v);
        for (const seg of p.segments) expect(known.has(seg.material), `${name}: ${seg.material}`).toBe(true);
        expect(known.has(p.bodyMaterial), `${name}: ${p.bodyMaterial}`).toBe(true);
        for (const m of p.markings) expect(known.has(m.color === 'yellow' ? 'marking_yellow' : 'marking_white')).toBe(true);
      }
    }
  });
});

describe('MaterialLibrary + registry', () => {
  it('a failing edit keeps the last working material; a good edit notifies and updates the registry live', () => {
    const lib = new MaterialLibrary();
    const reg = new MaterialRegistry();
    reg.bind(lib);
    const before = reg.getDef('asphalt').color;
    const bad = lib.setSource('asphalt', 'export default (M) => { throw new Error("boom") }');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/boom/);
    expect(reg.getDef('asphalt').color).toBe(before);

    const mat = reg.get('asphalt'); // an existing, already-created material instance
    const ok = lib.setSource('asphalt', 'export default (M) => M.asphalt({ color: 0x00ff00, tileM: 1, noise: 0 })');
    expect(ok.ok).toBe(true);
    expect(reg.getDef('asphalt').color).toBe(0x00ff00);
    expect(mat.color.getHex()).toBe(0x00ff00); // same material object, updated in place
    expect(reg.get('asphalt')).toBe(mat);
  });

  it('changing the surface kind marks the material for recompilation; custom materials can be added', () => {
    const lib = new MaterialLibrary();
    const reg = new MaterialRegistry();
    reg.bind(lib);
    const m = reg.get('gravel');
    const v0 = m.version;
    lib.setSource('gravel', 'export default (M) => M.dirt({ color: 0x664422, tileM: 2, noise: 0.5 })');
    expect(m.version).toBeGreaterThan(v0);
    lib.setSource('kantonsrot', 'export default (M) => M.paint({ color: M.mix(0xff0000, 0x990000, 0.4), tileM: 1, noise: 0 })');
    expect(reg.has('kantonsrot')).toBe(true);
    expect(reg.names()).toContain('kantonsrot');
  });

  it('weather is shared by every material and clamped', () => {
    const reg = new MaterialRegistry();
    reg.setWeather({ wet: 2, snow: -1, age: 0.5 });
    expect(reg.weather).toEqual({ wet: 1, snow: 0, age: 0.5 });
    expect(reg.surface.uWet.value).toBe(1);
  });

  it('the library document carries materials (and tolerates old documents without them)', () => {
    const doc = sanitizeLibraryDocument({ profiles: { a: 'x' }, materials: { asphalt: 'src', bad: 5 } });
    expect(doc.materials).toEqual({ asphalt: 'src' });
    expect(sanitizeLibraryDocument({ profiles: { a: 'x' } }).materials).toBeUndefined();
  });
});
