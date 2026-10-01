// Procedural road surfaces, injected into the game-compatible MeshLambertMaterial via onBeforeCompile
// (so fog, lights, shadows and the log depth buffer keep working). Everything is computed from
//   uv            — metres: x = distance across the cross-section, y = arc length along the road
//   aStrip (vec3) — (lateral metres from the strip's centre, strip half width, reserved): lets a strip know where its
//                   centre / edges are, which is what wheel tracks and edge dirt need
// plus a few global uniforms (wet / snow / age) shared by every road material.

import * as THREE from 'three';
import type { MaterialDef } from './materials';

export const SURFACE_KINDS = ['asphalt', 'gravel', 'dirt', 'grass', 'cobble', 'concrete', 'wood', 'stone', 'paint', 'flat'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface SurfaceWeather {
  /** 0 dry … 1 soaked: darkens surfaces */
  wet: number;
  /** 0 … 1 snow cover (wheel tracks stay clearer) */
  snow: number;
  /** 0 new … 1 old: more cracks, patches, dirt, worn paint */
  age: number;
}

export interface SurfaceUniforms {
  uWet: { value: number };
  uSnow: { value: number };
  uAge: { value: number };
}

export function makeSurfaceUniforms(w: Partial<SurfaceWeather> = {}): SurfaceUniforms {
  return { uWet: { value: w.wet ?? 0 }, uSnow: { value: w.snow ?? 0 }, uAge: { value: w.age ?? 0.3 } };
}

export function surfaceKindIndex(kind: SurfaceKind): number {
  const i = SURFACE_KINDS.indexOf(kind);
  return i < 0 ? SURFACE_KINDS.indexOf('flat') : i;
}

const VERT_DECL = /* glsl */ `
  attribute vec3 aStrip;
  varying vec2 vSurfUv;
  varying vec3 vSurfStrip;
  varying vec3 vSurfWorld;
`;

const FRAG_DECL = /* glsl */ `
  varying vec2 vSurfUv;
  varying vec3 vSurfStrip;
  varying vec3 vSurfWorld;
  uniform float uWet;
  uniform float uSnow;
  uniform float uAge;
  uniform vec3 uColor2;
  uniform vec4 uP0;   // tileM, noise, tracks, trackOffset
  uniform vec4 uP1;   // cracks, patches, edgeDirt, wornPaint

  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }

  // 1 on the two wheel paths of a strip, 0 elsewhere (strips narrower than a lane have none)
  float trackMask(float xs, float hw, float offset) {
    if (hw < 1.1) return 0.0;
    float d = abs(abs(xs) - offset);
    return exp(-d * d / (2.0 * 0.17 * 0.17));
  }

  vec3 surfaceColor(vec3 base) {
    vec2 uv = vSurfUv;
    float tile = max(uP0.x, 0.05);
    float amt = uP0.y;
    float xs = vSurfStrip.x;
    float hw = vSurfStrip.y;
    float tm = trackMask(xs, hw, uP0.w) * uP0.z;
    float low = fbm(uv / tile);
    float fine = vnoise(uv * 40.0);
    vec3 c = base;

    #if SURF_KIND == 0 // asphalt
      c *= 1.0 + amt * ((low - 0.5) * 0.5 + (fine - 0.5) * 0.35);
      float chip = h21(floor(uv * 55.0));
      c *= 1.0 + amt * 0.22 * (step(0.94, chip) - step(chip, 0.05));
      c *= 1.0 - 0.16 * tm;                                                   // rubbered wheel tracks
      float crack = 1.0 - smoothstep(0.0, 0.014, abs(fbm(uv * 0.55) - 0.5));
      c *= 1.0 - uP1.x * (0.2 + 0.5 * uAge) * crack * 0.55;                    // cracks
      float repair = smoothstep(0.63, 0.69, vnoise(uv / vec2(3.5, 8.0) + 7.3)) * uP1.y;   // soft, irregular repaired patches
      c *= 1.0 - 0.07 * repair * (0.5 + 0.5 * uAge);
    #elif SURF_KIND == 1 // gravel
      float st = h21(floor(uv * 18.0));
      c = mix(c, uColor2, step(0.55, st) * 0.65 * amt + (fine - 0.5) * 0.1);
      c *= 0.9 + 0.2 * low;
      c = mix(c, c * 0.82, tm);
    #elif SURF_KIND == 2 // dirt
      c = mix(c, uColor2, smoothstep(0.35, 0.75, low) * amt);
      c *= 0.92 + 0.16 * fine;
      c = mix(c, c * 0.7, tm * 0.8);                                           // ruts
      float pebble = step(0.97, h21(floor(uv * 22.0)));
      c = mix(c, uColor2 * 1.15, pebble * 0.5);
    #elif SURF_KIND == 3 // grass
      float blade = vnoise(vec2(uv.x * 28.0, uv.y * 5.0));
      c = mix(c, uColor2, smoothstep(0.3, 0.8, low) * amt);
      c *= 0.85 + 0.3 * blade;
    #elif SURF_KIND == 4 // cobble (granite setts in running bond)
      float row = floor(uv.y / tile);
      float off = mod(row, 2.0) * 0.5;
      vec2 cell = vec2(uv.x / tile + off, uv.y / tile);
      vec2 f = fract(cell);
      float joint = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
      float tone = h21(floor(cell));
      c = mix(c, uColor2, tone * 0.8);
      c *= 0.92 + 0.16 * fine;
      c = mix(c, c * 0.32, 1.0 - smoothstep(0.0, 0.09, joint));
    #elif SURF_KIND == 5 // concrete slabs
      c *= 1.0 + amt * ((low - 0.5) * 0.4 + (fine - 0.5) * 0.15);
      float jx = min(fract(uv.x / 3.75), 1.0 - fract(uv.x / 3.75)) * 3.75;
      float jy = min(fract(uv.y / 5.0), 1.0 - fract(uv.y / 5.0)) * 5.0;
      c = mix(c, c * 0.5, 1.0 - smoothstep(0.0, 0.03, min(jx, jy)));
      c *= 1.0 - 0.1 * tm;
    #elif SURF_KIND == 6 // wooden planks across the path
      float b = uv.y / tile;
      float id = floor(b);
      float fb = fract(b);
      float gap = smoothstep(0.0, 0.07, fb) * smoothstep(0.0, 0.07, 1.0 - fb);
      float grain = vnoise(vec2(uv.x * 2.5, uv.y * 45.0));
      c = mix(c, uColor2, h21(vec2(id, 1.3)) * 0.8);
      c *= (0.85 + 0.3 * grain) * (0.35 + 0.65 * gap);
    #elif SURF_KIND == 7 // dressed stone (kerbs, walls)
      c *= 1.0 + amt * ((fine - 0.5) * 0.45 + (low - 0.5) * 0.3);
      c = mix(c, uColor2, step(0.9, h21(floor(uv * 30.0))) * 0.5);
    #elif SURF_KIND == 8 // road paint over asphalt (uColor2 = the asphalt underneath)
      float worn = smoothstep(0.52, 0.8, fbm(uv * vec2(1.6, 1.6) + 5.0));
      float chipP = step(0.82, vnoise(uv * 24.0));
      float lost = clamp((worn * 0.8 + chipP * 0.3) * uP1.w * (0.3 + 0.9 * uAge), 0.0, 0.92);
      c = mix(c, uColor2, lost);
    #else // flat
      c *= 1.0 + amt * (low - 0.5) * 0.3;
    #endif

    // dirt along the strip's edges (road verges, shoulders)
    float edge = smoothstep(hw - 0.45, hw, abs(xs)) * step(0.01, hw);
    c = mix(c, vec3(0.34, 0.29, 0.21), edge * uP1.z * 0.55 * (0.4 + low) * (0.5 + 0.5 * uAge));

    // weather
    c *= 1.0 - 0.38 * uWet;
    float snowCover = uSnow * smoothstep(0.25, 0.55, low * 0.8 + 0.25 * vnoise(uv * 6.0)) * (1.0 - 0.75 * trackMask(xs, hw, uP0.w));
    c = mix(c, vec3(0.93, 0.95, 0.98), clamp(snowCover + uSnow * 0.25, 0.0, 1.0) * step(0.001, uSnow));
    return c;
  }
`;

/** Wire a MeshLambertMaterial to the procedural surface shader. `getDef` is read at compile time and by `syncSurface`. */
export function injectSurface(mat: THREE.MeshLambertMaterial, getDef: () => MaterialDef, shared: SurfaceUniforms): void {
  mat.onBeforeCompile = (shader) => {
    const def = getDef();
    const kind = surfaceKindIndex(def.kind);
    const color2 = new THREE.Color(def.color2 ?? def.color);
    shader.uniforms.uWet = shared.uWet;
    shader.uniforms.uSnow = shared.uSnow;
    shader.uniforms.uAge = shared.uAge;
    shader.uniforms.uColor2 = { value: color2 };
    shader.uniforms.uP0 = { value: new THREE.Vector4(def.tileM, def.noise, def.tracks ?? 0, def.trackOffset ?? 0.85) };
    shader.uniforms.uP1 = { value: new THREE.Vector4(def.cracks ?? 0, def.patches ?? 0, def.edgeDirt ?? 0, def.wornPaint ?? 0) };
    mat.userData.surfUniforms = shader.uniforms;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n  vSurfUv = uv;\n  vSurfStrip = aStrip;\n  vSurfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = `#define SURF_KIND ${kind}\n` + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n  diffuseColor.rgb = surfaceColor(diffuseColor.rgb);`);
  };
  mat.customProgramCacheKey = () => `road-surface-${surfaceKindIndex(getDef().kind)}`;
}

/** Push changed numeric parameters into an already compiled material (no recompile unless the kind changed). */
export function syncSurface(mat: THREE.MeshLambertMaterial, def: MaterialDef): void {
  const u = mat.userData.surfUniforms as Record<string, THREE.IUniform> | undefined;
  if (!u) return;
  (u.uColor2.value as THREE.Color).setHex(def.color2 ?? def.color);
  (u.uP0.value as THREE.Vector4).set(def.tileM, def.noise, def.tracks ?? 0, def.trackOffset ?? 0.85);
  (u.uP1.value as THREE.Vector4).set(def.cracks ?? 0, def.patches ?? 0, def.edgeDirt ?? 0, def.wornPaint ?? 0);
}
